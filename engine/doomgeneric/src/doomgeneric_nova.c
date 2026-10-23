// doomgeneric for Nova on BoredOS
// Copyright (c) 2026 Christiaan (chris@boreddev.nl)
// Released under the GNU General Public License v3.0.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <stdint.h>
#include <stdbool.h>
#include <time.h>
#include <ctype.h>
#include <syscall.h>
#include <poll.h>
#include <pthread.h>
#include <unistd.h>

#include <novaproto.h>

enum {
    NOVA_KEY_A = 1,
    NOVA_KEY_Z = 26,
    NOVA_KEY_0 = 27,
    NOVA_KEY_9 = 36,
    NOVA_KEY_ENTER = 37,
    NOVA_KEY_ESCAPE = 38,
    NOVA_KEY_BACKSPACE = 39,
    NOVA_KEY_TAB = 40,
    NOVA_KEY_SPACE = 41,
    NOVA_KEY_LEFT = 42,
    NOVA_KEY_RIGHT = 43,
    NOVA_KEY_UP = 44,
    NOVA_KEY_DOWN = 45,
    NOVA_KEY_LSHIFT = 46,
    NOVA_KEY_RSHIFT = 47,
    NOVA_KEY_LCTRL = 48,
    NOVA_KEY_RCTRL = 49,
    NOVA_KEY_LALT = 50,
    NOVA_KEY_RALT = 51
};

#include "doomkeys.h"
#include "doomgeneric.h"
#include "font8x8.h"

#define WINDOW_WIDTH  1280
#define WINDOW_HEIGHT 800
#define NORMAL_LAYER  2

#define KEYQUEUE_SIZE 32

static int nova_fd = -1;
static uint32_t surface_id = 0;
static uint32_t *shm_pixels = NULL;
static size_t shm_size = 0;
static char shm_path[128];

static unsigned short s_KeyQueue[KEYQUEUE_SIZE];
static unsigned int s_KeyQueueWriteIndex = 0;
static unsigned int s_KeyQueueReadIndex = 0;

static bool render_threads_enabled = false;
static int render_worker_count = 1;
static bool render_threading_initialized = false;
static pthread_t render_threads[8];
static bool render_job_pending[8];
static bool render_job_done[8];
static bool render_thread_exit[8];
static pthread_mutex_t render_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t render_cond = PTHREAD_COND_INITIALIZER;
static uint32_t overlay_cache[WINDOW_WIDTH * WINDOW_HEIGHT];
static bool overlay_cache_valid = false;
static uint32_t last_fps_value = 0;
static int last_overlay_w = 0;
static int last_overlay_h = 0;
static uint32_t render_current_fps = 0;

typedef struct {
    uint32_t *src_pixels;
    uint32_t *dst_pixels;
    int x_start;
    int x_end;
    int y_start;
    int y_end;
    int padding;
    int x_pos;
    int y_pos;
    int scale;
    int box_w;
    int box_h;
    const char *fps_str;
    uint32_t bg_color;
    uint32_t fg_color;
} overlay_job_t;

static overlay_job_t render_jobs[8];

static void draw_rect_range(uint32_t *pixels, int x, int y, int w, int h, uint32_t color, int x_start, int x_end, int y_start, int y_end);
static void draw_string_range(uint32_t *pixels, int x, int y, const char *s, uint32_t color, int scale, int x_start, int x_end, int y_start, int y_end);

static void prepare_fps_overlay(int x_pos, int y_pos, int padding, int box_w, int box_h, const char *fps_str, uint32_t bg_color, uint32_t fg_color, int scale) {
    if (!overlay_cache_valid || last_fps_value != render_current_fps) {
        memset(overlay_cache, 0, sizeof(overlay_cache));
        draw_rect_range(overlay_cache, x_pos - padding, y_pos - padding,
                        box_w, box_h, bg_color,
                        0, WINDOW_WIDTH, 0, WINDOW_HEIGHT);
        draw_string_range(overlay_cache, x_pos, y_pos, fps_str, fg_color,
                          scale, 0, WINDOW_WIDTH, 0, WINDOW_HEIGHT);
        overlay_cache_valid = true;
        last_fps_value = render_current_fps;
        last_overlay_w = box_w;
        last_overlay_h = box_h;
    }
}

static void render_frame_slice(const overlay_job_t *job) {
    for (int y = job->y_start; y < job->y_end; y++) {
        uint32_t *src_row = &job->src_pixels[y * WINDOW_WIDTH];
        uint32_t *dst_row = &job->dst_pixels[y * WINDOW_WIDTH];
        memcpy(&dst_row[job->x_start], &src_row[job->x_start], (size_t)(job->x_end - job->x_start) * sizeof(uint32_t));
    }

    for (int y = job->y_start; y < job->y_end; y++) {
        uint32_t *dst_row = &job->dst_pixels[y * WINDOW_WIDTH];
        uint32_t *overlay_row = &overlay_cache[y * WINDOW_WIDTH];
        for (int x = job->x_start; x < job->x_end; x++) {
            if (overlay_row[x] != 0) {
                dst_row[x] = overlay_row[x];
            }
        }
    }
}

static void *render_overlay_slice(void *arg);

static void init_render_threading(void) {
    if (render_threading_initialized) {
        return;
    }

    long online_cpus = sysconf(_SC_NPROCESSORS_ONLN);
    render_worker_count = 1;
    render_threads_enabled = false;

    if (online_cpus > 1) {
        render_worker_count = (int)online_cpus;
        if (render_worker_count > 8) {
            render_worker_count = 8;
        }
        render_threads_enabled = true;
    }

    printf("DOOMgeneric: Online CPUs: %ld via VFS /proc/cpuinfo. Rendering mode: %s (%d thread%s)\n",
           online_cpus, render_threads_enabled ? "Multithreaded Horizontal Banding" : "Single-Core Inline Fallback",
           render_worker_count, render_worker_count > 1 ? "s" : "");

    for (int i = 0; i < render_worker_count; i++) {
        render_job_pending[i] = false;
        render_job_done[i] = true;
        render_thread_exit[i] = false;
    }

    if (render_threads_enabled) {
        for (int i = 0; i < render_worker_count; i++) {
            if (pthread_create(&render_threads[i], NULL, render_overlay_slice, (void *)(intptr_t)i) != 0) {
                render_threads_enabled = false;
                render_worker_count = 1;
                break;
            }
        }
    }

    render_threading_initialized = true;
}

static void draw_rect_range(uint32_t *pixels, int x, int y, int w, int h, uint32_t color, int x_start, int x_end, int y_start, int y_end) {
    for (int py = y; py < y + h; py++) {
        if (py < y_start || py >= y_end) continue;
        for (int px = x; px < x + w; px++) {
            if (px < x_start || px >= x_end) continue;
            if (px < 0 || px >= WINDOW_WIDTH || py < 0 || py >= WINDOW_HEIGHT) continue;
            pixels[py * WINDOW_WIDTH + px] = color;
        }
    }
}

static void draw_char_range(uint32_t *pixels, int x, int y, char c, uint32_t color, int scale, int x_start, int x_end, int y_start, int y_end) {
    unsigned char uc = (unsigned char)c;
    if (uc > 127) return;
    const uint8_t *glyph = font8x8_basic[uc];
    for (int row = 0; row < 8; row++) {
        for (int col = 0; col < 8; col++) {
            if ((glyph[row] >> (7 - col)) & 1) {
                for (int sy = 0; sy < scale; sy++) {
                    for (int sx = 0; sx < scale; sx++) {
                        int px = x + col * scale + sx;
                        int py = y + row * scale + sy;
                        if (px < x_start || px >= x_end) continue;
                        if (py < y_start || py >= y_end) continue;
                        if (px >= 0 && px < WINDOW_WIDTH && py >= 0 && py < WINDOW_HEIGHT) {
                            pixels[py * WINDOW_WIDTH + px] = color;
                        }
                    }
                }
            }
        }
    }
}

static void draw_string_range(uint32_t *pixels, int x, int y, const char *s, uint32_t color, int scale, int x_start, int x_end, int y_start, int y_end) {
    if (!s) return;
    int cur_x = x;
    while (*s) {
        char c = *s++;
        if (c == ' ') {
            cur_x += 8 * scale;
            continue;
        }
        draw_char_range(pixels, cur_x, y, c, color, scale, x_start, x_end, y_start, y_end);
        cur_x += 8 * scale;
    }
}

static void *render_overlay_slice(void *arg) {
    int thread_index = (int)(intptr_t)arg;
    while (1) {
        pthread_mutex_lock(&render_mutex);
        while (!render_thread_exit[thread_index] && !render_job_pending[thread_index]) {
            pthread_cond_wait(&render_cond, &render_mutex);
        }

        if (render_thread_exit[thread_index]) {
            pthread_mutex_unlock(&render_mutex);
            break;
        }

        overlay_job_t job = render_jobs[thread_index];
        render_job_pending[thread_index] = false;
        pthread_mutex_unlock(&render_mutex);

        render_frame_slice(&job);

        pthread_mutex_lock(&render_mutex);
        render_job_done[thread_index] = true;
        pthread_cond_broadcast(&render_cond);
        pthread_mutex_unlock(&render_mutex);
    }
    return NULL;
}

static unsigned char convertToDoomKey(uint32_t nova_key) {
    if (nova_key >= NOVA_KEY_A && nova_key <= NOVA_KEY_Z) {
        return 'a' + (nova_key - NOVA_KEY_A);
    }
    if (nova_key >= NOVA_KEY_0 && nova_key <= NOVA_KEY_9) {
        return '0' + (nova_key - NOVA_KEY_0);
    }
    
    if (nova_key == NOVA_KEY_ENTER)     return KEY_ENTER;
    if (nova_key == NOVA_KEY_ESCAPE)    return KEY_ESCAPE;
    if (nova_key == NOVA_KEY_BACKSPACE) return KEY_BACKSPACE;
    if (nova_key == NOVA_KEY_TAB)       return KEY_TAB;
    if (nova_key == NOVA_KEY_SPACE)     return KEY_USE; 
    if (nova_key == NOVA_KEY_LEFT)      return KEY_LEFTARROW;
    if (nova_key == NOVA_KEY_RIGHT)     return KEY_RIGHTARROW;
    if (nova_key == NOVA_KEY_UP)        return KEY_UPARROW;
    if (nova_key == NOVA_KEY_DOWN)      return KEY_DOWNARROW;
    if (nova_key == NOVA_KEY_LSHIFT || nova_key == NOVA_KEY_RSHIFT) return KEY_RSHIFT;
    if (nova_key == NOVA_KEY_LCTRL || nova_key == NOVA_KEY_RCTRL)   return KEY_FIRE; 
    if (nova_key == NOVA_KEY_LALT || nova_key == NOVA_KEY_RALT)     return KEY_LALT; 
    
    return 0;
}
static void addKeyToQueue(int pressed, uint32_t keyCode) {
    unsigned char key = convertToDoomKey(keyCode);
    if (key == 0) return;

    unsigned short keyData = (pressed << 8) | key;
    s_KeyQueue[s_KeyQueueWriteIndex] = keyData;
    s_KeyQueueWriteIndex = (s_KeyQueueWriteIndex + 1) % KEYQUEUE_SIZE;
}
static void cleanup_nova() {
    if (nova_fd >= 0) {
        if (surface_id > 0) {
            nova_destroy_surface(nova_fd, surface_id);
            surface_id = 0;
        }
        if (shm_pixels && shm_pixels != MAP_FAILED) {
            munmap(shm_pixels, shm_size);
            shm_pixels = NULL;
        }
        close(nova_fd);
        nova_fd = -1;
    }
}
static void poll_nova_events() {
    struct pollfd pfd;
    pfd.fd = nova_fd;
    pfd.events = POLLIN;
    pfd.revents = 0;

    while (nova_pending_events() || poll(&pfd, 1, 0) > 0) {
        NovaEvent ev;
        if (nova_poll_event(nova_fd, &ev) != 0) {
            break;
        }

        if (ev.type == EVT_CLOSE_REQUEST) {
            exit(0);
        } else if (ev.type == EVT_KEY) {
            addKeyToQueue(ev.data.key.pressed, ev.data.key.keycode);
        }
        
        pfd.revents = 0;
    }
}
void DG_Init() {
    atexit(cleanup_nova);
    init_render_threading();

    nova_fd = nova_connect(NULL);
    if (nova_fd < 0) {
        fprintf(stderr, "DoomGeneric Error: Failed to connect to Nova WM\n");
        exit(1);
    }
    if (nova_create_surface(nova_fd, WINDOW_WIDTH, WINDOW_HEIGHT, NORMAL_LAYER, SURFACE_FLAG_NO_RESIZE, &surface_id, shm_path) < 0) {
        fprintf(stderr, "DoomGeneric Error: Surface allocation failed\n");
        close(nova_fd);
        exit(1);
    }
    int shm_fd = open(shm_path, O_RDWR);
    if (shm_fd < 0) {
        fprintf(stderr, "DoomGeneric Error: Cannot open SHM segment %s\n", shm_path);
        close(nova_fd);
        exit(1);
    }
    shm_size = WINDOW_WIDTH * WINDOW_HEIGHT * 4;
    shm_pixels = mmap(NULL, shm_size, PROT_READ | PROT_WRITE, MAP_SHARED, shm_fd, 0);
    close(shm_fd);

    if (shm_pixels == MAP_FAILED) {
        fprintf(stderr, "DoomGeneric Error: mmap failed\n");
        close(nova_fd);
        exit(1);
    }
    nova_set_title(nova_fd, surface_id, "DOOMgeneric");
}
static void draw_rect(uint32_t *pixels, int x, int y, int w, int h, uint32_t color) {
    for (int py = y; py < y + h; py++) {
        if (py < 0 || py >= WINDOW_HEIGHT) continue;
        for (int px = x; px < x + w; px++) {
            if (px < 0 || px >= WINDOW_WIDTH) continue;
            pixels[py * WINDOW_WIDTH + px] = color;
        }
    }
}

static void draw_char(uint32_t *pixels, int x, int y, char c, uint32_t color, int scale) {
    unsigned char uc = (unsigned char)c;
    if (uc > 127) return;
    const uint8_t *glyph = font8x8_basic[uc];
    for (int row = 0; row < 8; row++) {
        for (int col = 0; col < 8; col++) {
            if ((glyph[row] >> (7 - col)) & 1) {
                for (int sy = 0; sy < scale; sy++) {
                    for (int sx = 0; sx < scale; sx++) {
                        int px = x + col * scale + sx;
                        int py = y + row * scale + sy;
                        if (px >= 0 && px < WINDOW_WIDTH && py >= 0 && py < WINDOW_HEIGHT) {
                            pixels[py * WINDOW_WIDTH + px] = color;
                        }
                    }
                }
            }
        }
    }
}

static void draw_string(uint32_t *pixels, int x, int y, const char *s, uint32_t color, int scale) {
    if (!s) return;
    int cur_x = x;
    while (*s) {
        char c = *s++;
        if (c == ' ') {
            cur_x += 8 * scale;
            continue;
        }
        draw_char(pixels, cur_x, y, c, color, scale);
        cur_x += 8 * scale;
    }
}

void DG_DrawFrame() {
    if (!shm_pixels || !DG_ScreenBuffer) return;

    static uint32_t frame_count = 0;
    static uint32_t last_fps_time = 0;
    static uint32_t current_fps = 60;
    static uint32_t event_poll_frame = 0;

    uint32_t now = DG_GetTicksMs();
    frame_count++;
    if (last_fps_time == 0) {
        last_fps_time = now;
    }
    uint32_t elapsed = now - last_fps_time;
    if (elapsed >= 250) {
        uint32_t measured_fps = (frame_count * 1000 + elapsed / 2) / (elapsed ? elapsed : 1);
        if (measured_fps > 0) {
            current_fps = (current_fps * 3 + measured_fps) / 4;
            render_current_fps = current_fps;
        }
        frame_count = 0;
        last_fps_time = now;
    }

    char fps_str[32];
    snprintf(fps_str, sizeof(fps_str), "FPS: %u", current_fps);

    int scale = 2;
    int char_w = 8 * scale;
    int char_h = 8 * scale;
    int text_len = strlen(fps_str);

    int padding = 6;
    int x_pos = 10;
    int y_pos = 10;

    int box_w = text_len * char_w + padding * 2;
    int box_h = char_h + padding * 2;

    uint32_t *screen_pixels = (uint32_t *)DG_ScreenBuffer;

    prepare_fps_overlay(x_pos, y_pos, padding, box_w, box_h, fps_str, 0xFF000000, 0xFF00FF00, scale);

    if (render_threads_enabled && render_worker_count > 1) {
        int band_height = WINDOW_HEIGHT / render_worker_count;
        pthread_mutex_lock(&render_mutex);
        for (int i = 0; i < render_worker_count; i++) {
            int y_start = i * band_height;
            int y_end = (i == render_worker_count - 1) ? WINDOW_HEIGHT : (i + 1) * band_height;
            render_jobs[i] = (overlay_job_t){
                .src_pixels = screen_pixels,
                .dst_pixels = shm_pixels,
                .x_start = 0,
                .x_end = WINDOW_WIDTH,
                .y_start = y_start,
                .y_end = y_end,
                .padding = padding,
                .x_pos = x_pos,
                .y_pos = y_pos,
                .scale = scale,
                .box_w = box_w,
                .box_h = box_h,
                .fps_str = fps_str,
                .bg_color = 0xFF000000,
                .fg_color = 0xFF00FF00,
            };
            render_job_pending[i] = true;
            render_job_done[i] = false;
        }
        pthread_cond_broadcast(&render_cond);

        for (int i = 0; i < render_worker_count; i++) {
            while (!render_job_done[i]) {
                pthread_cond_wait(&render_cond, &render_mutex);
            }
        }
        pthread_mutex_unlock(&render_mutex);
    } else {
        overlay_job_t job = {
            .src_pixels = screen_pixels,
            .dst_pixels = shm_pixels,
            .x_start = 0,
            .x_end = WINDOW_WIDTH,
            .y_start = 0,
            .y_end = WINDOW_HEIGHT,
            .padding = padding,
            .x_pos = x_pos,
            .y_pos = y_pos,
            .scale = scale,
            .box_w = box_w,
            .box_h = box_h,
            .fps_str = fps_str,
            .bg_color = 0xFF000000,
            .fg_color = 0xFF00FF00,
        };
        render_frame_slice(&job);
    }

    NovaRect damage = { 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT };
    nova_damage_surface(nova_fd, surface_id, 1, &damage);
    if ((event_poll_frame++ & 1u) == 0) {
        poll_nova_events();
    }
}
void DG_SleepMs(uint32_t ms) {
    if (ms == 0) return;


    if (ms < 10) {
        sched_yield();
    } else {
        usleep(ms * 1000);
    }
}
uint32_t DG_GetTicksMs() {
    return (uint32_t)get_ticks();
}
int DG_GetKey(int* pressed, unsigned char* doomKey) {
    if (s_KeyQueueReadIndex == s_KeyQueueWriteIndex) {
        return 0; 
    } else {
        unsigned short keyData = s_KeyQueue[s_KeyQueueReadIndex];
        s_KeyQueueReadIndex = (s_KeyQueueReadIndex + 1) % KEYQUEUE_SIZE;

        *pressed = keyData >> 8;
        *doomKey = keyData & 0xFF;

        return 1;
    }
}
void DG_SetWindowTitle(const char *title) {
    if (nova_fd >= 0 && surface_id > 0) {
        char full_title[256];
        snprintf(full_title, sizeof(full_title), "BoredOS Doom - %s", title);
        nova_set_title(nova_fd, surface_id, full_title);
    }
}
int main(int argc, char **argv) {
    int uncapped = 1;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-capped") == 0) {
            uncapped = 0;
            break;
        }
    }

    doomgeneric_Create(argc, argv);

    uint32_t last_tick = DG_GetTicksMs();

    while (1) {
        doomgeneric_Tick();
        
        if (!uncapped) {
            while (1) {
                uint32_t now = DG_GetTicksMs();
                if ((now - last_tick) >= 28) {
                    last_tick = now;
                    break;
                }
                
                uint32_t remain = 28 - (now - last_tick);
                if (remain >= 10) {
                    usleep(remain * 1000);
                } else {
                    sched_yield();
                }
            }
        } else {
            sched_yield();
        }
    }

    return 0;
}

