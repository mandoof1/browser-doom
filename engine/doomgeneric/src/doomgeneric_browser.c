/*
 * doomgeneric_browser.c - browser platform layer for doomgeneric
 *
 * The engine (D_DoomMain -> D_DoomLoop) is a blocking C main loop that assumes
 * it owns the process, a window, a keyboard and a wall clock. A browser gives
 * you none of those in the same shape. There are two ways to square that, and
 * this file implements both:
 *
 *   1. single-threaded (-sASYNCIFY): the engine blocks, we unwind its stack
 *      into JS and rewind it later. This is the pre-JSPI technique; it works
 *      everywhere but is fragile and slow.
 *   2. threaded (-sUSE_PTHREADS -sPROXY_TO_PTHREAD): the engine runs on its
 *      own thread, where blocking is simply allowed. Presentation, input and
 *      storage are proxied to the page thread. This is the shape every 2026
 *      browser port uses (engine threads + page-thread presentation), and it
 *      is why those pages all insist on COOP/COEP + SharedArrayBuffer.
 *
 * The bridge in the middle is the interesting part: the page thread downloads
 * the WAD over HTTP Range into the shared heap and hands the engine a pointer;
 * the engine thread writes files and we mirror them back to IndexedDB.
 */

#include <emscripten.h>
#include <emscripten/version.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>
#include <sched.h>
#include <sys/stat.h>
#include <sys/types.h>

#include "doomgeneric.h"
#include "doomkeys.h"

/* MAIN_THREAD_EM_ASM* runs on the page thread: directly in a single-threaded
 * build, proxied (and blocking) from a pthread in the threaded build. Same
 * source either way, which is what makes the two builds share a platform layer. */
#define BRIDGE(code, ...) MAIN_THREAD_EM_ASM(code, __VA_ARGS__)
#define BRIDGE0(code) MAIN_THREAD_EM_ASM(code)

/* ------------------------------------------------------------------ input */

/* Ring of key events: the page thread fills it (keyboard + Gamepad API), the
 * engine drains it through DG_GetKey. Analog movement becomes held-key
 * transitions because Doom's input layer only understands keys going up and
 * down. */

#define KEYRING_BITS 12
#define KEYRING_SIZE (1u << KEYRING_BITS)
#define KEYRING_MASK (KEYRING_SIZE - 1u)

typedef struct
{
    unsigned char key;
    unsigned char pressed;
} keyevent_t;

static keyevent_t key_ring[KEYRING_SIZE];
static volatile unsigned int key_head; /* page thread writes */
static volatile unsigned int key_tail; /* engine thread reads */

/* ------------------------------------------------------- shared state block */

typedef struct
{
    unsigned int frames;        /* frames rendered by the engine   */
    unsigned int frame_seq;     /* bumped each frame; page polls   */
    unsigned int keyevents;     /* key events consumed             */
    unsigned int started_ms;    /* engine start timestamp          */
    unsigned int last_ms;       /* last frame timestamp            */
    unsigned int quit;          /* engine finished                 */
    unsigned int resx, resy;    /* framebuffer geometry            */
    void *framebuffer;          /* DG_ScreenBuffer                 */
    unsigned int sleeps;        /* DG_SleepMs calls                */
    unsigned int tickcalls;     /* DG_GetTicksMs calls             */
    unsigned int keypolls;      /* DG_GetKey calls                 */
    unsigned int assets_ready;  /* page thread says "wad is here"  */
} browser_stats_t;

static browser_stats_t stats;

/* emscripten_get_now() is epoch-based (performance.timeOrigin + performance.now()),
 * which is far too large for Doom's uint32 millisecond clock: the truncation made
 * the engine's "has time passed?" test always answer no, and it sat in I_Sleep
 * forever. Give the engine a clock relative to its own start, like every other
 * doomgeneric platform layer does. */
static double clock_origin;

static uint32_t now_ms(void)
{
    double t = emscripten_get_now();

    if (clock_origin == 0.0)
        clock_origin = t;

    return (uint32_t)(t - clock_origin);
}

/* ------------------------------------------------------ file bridge (inbox) */

/* Files the page thread has already fetched (the WAD, restored saves). The
 * engine thread materialises them into its own filesystem before booting.
 * In a pthread build each thread has its own MEMFS, so the page thread cannot
 * just drop files where the engine will look - the bytes have to travel. */

#define DG_PATH_MAX 128
#define DG_INBOX_SLOTS 8

typedef struct
{
    char path[DG_PATH_MAX];
    unsigned int ptr;   /* bytes in the shared heap          */
    unsigned int size;
    unsigned int used;
} dg_file_slot_t;

static dg_file_slot_t inbox[DG_INBOX_SLOTS];
static volatile unsigned int inbox_head;
static volatile unsigned int inbox_tail;

static unsigned int wad_ptr;
static unsigned int wad_size;

EMSCRIPTEN_KEEPALIVE void dg_push_key(unsigned int pressed, unsigned int key)
{
    unsigned int next = (key_head + 1u) & KEYRING_MASK;

    if (next == key_tail)
        return; /* ring full: drop the event rather than grow anything */

    key_ring[key_head].key = (unsigned char)key;
    key_ring[key_head].pressed = (unsigned char)pressed;
    key_head = next;
}

/* Mouse look. The engine has globals for this (mousex/mousey and a button mask
 * feeding ev_mouse in G_Responder) but this fork commented out the SDL motion
 * handler, so the browser layer feeds it instead. Deltas accumulate because the
 * engine samples once per tic while the browser delivers many movements per
 * frame; buttons are state, not events. */
static volatile int mouse_dx;
static volatile int mouse_dy;
static volatile unsigned int mouse_buttons;

EMSCRIPTEN_KEEPALIVE void dg_push_mouse(int dx, int dy)
{
    mouse_dx += dx;
    mouse_dy += dy;
}

EMSCRIPTEN_KEEPALIVE void dg_set_mouse_button(int button, int pressed)
{
    if (button < 0 || button >= 32)
        return;

    if (pressed)
        mouse_buttons |= (1u << button);
    else
        mouse_buttons &= ~(1u << button);
}

/* Drained by the engine's input layer: deltas are consumed, the mask is not. */
int dg_mouse_consume(int *dx, int *dy, unsigned int *buttons)
{
    *dx = mouse_dx;
    *dy = mouse_dy;
    *buttons = mouse_buttons;
    mouse_dx = 0;
    mouse_dy = 0;

    return (*dx != 0) || (*dy != 0) || (*buttons != 0);
}

EMSCRIPTEN_KEEPALIVE unsigned int dg_stats_addr(void)
{
    return (unsigned int)&stats;
}

EMSCRIPTEN_KEEPALIVE void *dg_framebuffer(void) { return DG_ScreenBuffer; }
EMSCRIPTEN_KEEPALIVE unsigned int dg_resx(void) { return DOOMGENERIC_RESX; }
EMSCRIPTEN_KEEPALIVE unsigned int dg_resy(void) { return DOOMGENERIC_RESY; }
EMSCRIPTEN_KEEPALIVE unsigned int dg_frames(void) { return stats.frames; }
EMSCRIPTEN_KEEPALIVE unsigned int dg_frame_seq(void) { return stats.frame_seq; }

/* Called by the page thread once the WAD is sitting in the heap. */
EMSCRIPTEN_KEEPALIVE void dg_set_wad(unsigned int ptr, unsigned int size)
{
    wad_ptr = ptr;
    wad_size = size;
}

/* Called by the page thread for each file to restore (save games, config). */
EMSCRIPTEN_KEEPALIVE void dg_inbox_push(const char *path, unsigned int ptr, unsigned int size)
{
    unsigned int next = (inbox_head + 1u) % DG_INBOX_SLOTS;

    if (next == inbox_tail)
        return;

    memset(&inbox[inbox_head], 0, sizeof(dg_file_slot_t));
    strncpy(inbox[inbox_head].path, path, DG_PATH_MAX - 1);
    inbox[inbox_head].ptr = ptr;
    inbox[inbox_head].size = size;
    inbox[inbox_head].used = 1;
    inbox_head = next;
}

EMSCRIPTEN_KEEPALIVE unsigned int dg_assets_ready(void)
{
    return stats.assets_ready;
}

/* The engine writes saves into a directory it creates itself, so a restored
 * file has to bring its parent directories with it. */
static void dg_mkdir_p(const char *path)
{
    char buf[DG_PATH_MAX];
    size_t i;

    strncpy(buf, path, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';

    for (i = 0; buf[i]; ++i)
    {
        if (buf[i] != '/')
            continue;

        buf[i] = '\0';

        if (buf[0])
            mkdir(buf, 0777);

        buf[i] = '/';
    }
}

static void dg_write_file(const char *path, const void *bytes, unsigned int size)
{
    FILE *f;

    dg_mkdir_p(path);
    f = fopen(path, "wb");

    if (f == NULL)
    {
        fprintf(stderr, "bridge: cannot write %s\n", path);
        return;
    }
    fwrite(bytes, 1, size, f);
    fclose(f);
}

/* Pull everything the page thread queued. Runs on the engine thread. */
static void dg_drain_inbox(void)
{
    if (wad_ptr && wad_size)
        dg_write_file("/doom1.wad", (const void *)(uintptr_t)wad_ptr, wad_size);

    while (inbox_tail != inbox_head)
    {
        dg_file_slot_t *slot = &inbox[inbox_tail];

        if (slot->used && slot->ptr && slot->size)
            dg_write_file(slot->path, (const void *)(uintptr_t)slot->ptr, slot->size);

        inbox_tail = (inbox_tail + 1u) % DG_INBOX_SLOTS;
    }
}

/* ---------------------------------------------------------------- platform */

void DG_Init(void)
{
    stats.resx = DOOMGENERIC_RESX;
    stats.resy = DOOMGENERIC_RESY;
    stats.started_ms = now_ms();
    BRIDGE0(dg_on_engine_init && dg_on_engine_init());
}

void DG_DrawFrame(void)
{
    stats.framebuffer = DG_ScreenBuffer;
    stats.frames++;
    stats.last_ms = now_ms();
    /* Memory barrier-ish: publish the payload before the sequence counter the
     * page thread polls. */
    __atomic_thread_fence(__ATOMIC_RELEASE);
    stats.frame_seq++;

#ifndef __EMSCRIPTEN_PTHREADS__
    /* Single threaded: nothing to poll, hand the frame over directly. */
    BRIDGE0(dg_present_frame && dg_present_frame());
#endif
}

void DG_SleepMs(uint32_t ms)
{
    stats.sleeps++;

#ifdef __EMSCRIPTEN_PTHREADS__
    /* We are on our own thread: blocking is legal and cheap. */
    usleep((useconds_t)(ms ? ms : 1) * 1000u);
    sched_yield();
#else
    /* We are on the page thread: blocking would freeze the tab, so unwind. */
    emscripten_sleep(ms ? (int)ms : 0);
#endif
}

uint32_t DG_GetTicksMs(void)
{
    stats.tickcalls++;
    return now_ms();
}

int DG_GetKey(int *pressed, unsigned char *doomKey)
{
    stats.keypolls++;

    if (key_tail == key_head)
        return 0;

    *pressed = key_ring[key_tail].pressed;
    *doomKey = key_ring[key_tail].key;
    key_tail = (key_tail + 1u) & KEYRING_MASK;
    stats.keyevents++;

    return 1;
}

void DG_SetWindowTitle(const char *title)
{
    if (title != NULL)
        BRIDGE(dg_set_title_ptr && dg_set_title_ptr($0), title);
}

/* ------------------------------------------------------- save persistence */

/* Hooked from g_game.c (savegames) and m_config.c (config): read the file back
 * out of this thread's filesystem and hand the bytes to the page thread. */

void dg_note_saved_file(const char *path)
{
    FILE *f;
    long size;
    void *buf;

    if (path == NULL)
        return;

    f = fopen(path, "rb");
    if (f == NULL)
        return;

    fseek(f, 0, SEEK_END);
    size = ftell(f);
    fseek(f, 0, SEEK_SET);

    if (size <= 0)
    {
        fclose(f);
        return;
    }

    buf = malloc((size_t)size);
    if (buf == NULL)
    {
        fclose(f);
        return;
    }

    if (fread(buf, 1, (size_t)size, f) == (size_t)size)
        BRIDGE(dg_store_file && dg_store_file($0, $1, $2), path, buf, (int)size);

    fclose(f);
    free(buf);
}

/* Hooked from m_misc.c M_WriteFile. The engine wrote a file into its own FS;
 * mirror it to the page thread, which puts it in IndexedDB. */

void dg_note_written(const char *name, const void *bytes, int length)
{
    if (name == NULL || bytes == NULL || length <= 0)
        return;
    if (strstr(name, ".cfg") == NULL && strstr(name, ".dsg") == NULL)
        return;

    BRIDGE(dg_store_file && dg_store_file($0, $1, $2), name, bytes, length);
}

/* ---------------------------------------------------------------- entry */

int main(int argc, char **argv)
{
    /* Wait for the page thread to deliver the WAD and any restored saves, then
     * materialise them into *this* thread's filesystem. */
    while (!wad_ptr || !wad_size)
    {
#ifdef __EMSCRIPTEN_PTHREADS__
        usleep(2000);
#else
        emscripten_sleep(2);
#endif
    }

    dg_drain_inbox();

    /* MEMFS starts empty, and the engine expects its save/config directories to
     * exist the way a real filesystem would have them. */
    mkdir("/save", 0777);
    mkdir("/doom", 0777);

    stats.assets_ready = 1;

    doomgeneric_Create(argc, argv);

    /* doomgeneric's contract: Create() runs the engine's startup and one tick,
     * the host drives the loop from there. */
    while (1)
    {
        doomgeneric_Tick();

        if (stats.quit)
            break;
    }

    return 0;
}
