#!/usr/bin/env bash
# Build the engine for the browser.
#
#   doom        - pthreads + PROXY_TO_PTHREAD. The engine runs on its own
#                 thread, where blocking is simply allowed; the page thread
#                 stays free to present frames, read input and talk to storage.
#                 This is the shape of every serious 2026 browser port, and it
#                 is why they all require COOP/COEP + SharedArrayBuffer.
#   doom_async  - single threaded + ASYNCIFY: the pre-JSPI trick of unwinding a
#                 blocking C loop into the JS event loop. Fallback for pages
#                 that cannot be cross-origin isolated.
#   doom64      - pthreads + memory64: the 64-bit address space that let GTA V
#                 carry a 3 GB heap that could grow to 16 GB.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1

SRC="$HERE/engine/doomgeneric/src"
OUT="${OUTDIR:-$HERE/web/build}"
mkdir -p "$OUT"

RESX=${RESX:-640}
RESY=${RESY:-400}

BASE=(
  -O2 -std=gnu11 -w
  -DNORMALUNIX -D_DEFAULT_SOURCE
  -DDOOMGENERIC_RESX=$RESX -DDOOMGENERIC_RESY=$RESY
  -I"$SRC"
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB
  -sENVIRONMENT=web
  -sEXIT_RUNTIME=0
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,HEAPU8,HEAPU32,UTF8ToString
  -sEXPORTED_FUNCTIONS=_main,_dg_push_key,_dg_stats_addr,_dg_framebuffer,_dg_resx,_dg_resy,_dg_frames,_dg_frame_seq,_dg_set_wad,_dg_inbox_push,_dg_assets_ready,_malloc,_free
  -sASSERTIONS=1
  ${EXTRA_CFLAGS:-}
)

THREADS=( -sUSE_PTHREADS=1 -sPROXY_TO_PTHREAD=1 -sPTHREAD_POOL_SIZE=2 )
# no second EXPORTED_RUNTIME_METHODS here: a later -s flag of the same name
# replaces the earlier list, which silently took ccall away from this build.
ASYNC=( -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=262144 )

SOURCES=( "$SRC/doomgeneric_browser.c" )
while IFS= read -r f; do
  case "$(basename "$f")" in
    doomgeneric_nova.c|doomgeneric_browser.c) ;;
    *) SOURCES+=( "$f" ) ;;
  esac
done < <(ls "$SRC"/*.c)

echo "[1/3] doom (pthreads + proxy-to-pthread)"
emcc "${BASE[@]}" "${THREADS[@]}" "${SOURCES[@]}" -o "$OUT/doom.js"

echo "[2/3] doom_async (single thread + ASYNCIFY)"
emcc "${BASE[@]}" "${ASYNC[@]}" "${SOURCES[@]}" -o "$OUT/doom_async.js"

echo "[3/3] doom64 (pthreads + memory64)"
emcc "${BASE[@]}" "${THREADS[@]}" -sMEMORY64=1 -sMAXIMUM_MEMORY=16GB \
  "${SOURCES[@]}" -o "$OUT/doom64.js" || echo "  (wasm64 skipped)"

ls -la "$OUT" | sed -n '2,$p'
echo "built."
