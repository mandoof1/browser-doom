/* wadstream.js - asset delivery.
 *
 * The piece the 2026 wave actually invented as a *distribution model*: HTTP
 * Range requests in fixed-size blocks -> cached in OPFS -> handed to the engine
 * without ever holding the game twice in memory.
 * Halo CE does this with your XISO ("copies only the required maps to
 * origin-private storage in small chunks"); GTA V's build fetched 4 KB blocks
 * the same way and cached them in OPFS (582 MB boot set out of 20.9 GB).
 *
 * Two sinks:
 *   dgStreamToFS   - single-threaded build: write into the engine's MEMFS.
 *   dgStreamToHeap - threaded build: write straight into the shared heap and
 *                    hand the engine a pointer. Each pthread has its own MEMFS,
 *                    so on the threaded build the bytes have to travel.
 */

const CHUNK = 512 * 1024;

async function headInfo(url) {
  let size = null, ranges = false;
  try {
    /* a 1-byte ranged GET rather than HEAD: some stacks answer HEAD without
     * Accept-Ranges, and Chrome reports an aborted HEAD as a failed request */
    const h = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    if (h.status === 206) {
      ranges = true;
      const cr = h.headers.get('content-range') || '';
      const total = cr.split('/')[1];
      size = Number(total || 0) || null;
    } else {
      size = Number(h.headers.get('content-length') || 0) || null;
      ranges = /bytes/i.test(h.headers.get('accept-ranges') || '');
    }
    await h.arrayBuffer();   /* read the byte rather than abort the request */
  } catch (e) { /* fall back to a plain GET */ }
  return { size, ranges };
}

async function cacheDir(url, size) {
  if (!navigator.storage || !navigator.storage.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('asset-cache', { create: true });
    const key = url.replace(/[^a-z0-9]/gi, '_') + (size ? '.' + size : '');
    return { dir, key };
  } catch (e) {
    console.warn('opfs unavailable:', e);
    return null;
  }
}

/* Fetch into a sink, using the OPFS copy when it already matches. */
async function transfer(url, onProgress, sink) {
  const { size, ranges } = await headInfo(url);
  const cache = await cacheDir(url, size);

  if (cache && size) {
    try {
      const fh = await cache.dir.getFileHandle(cache.key, { create: true });
      const f = await fh.getFile();
      if (f.size === size) {
        await sink.open(size);
        for (let off = 0; off < size; off += CHUNK) {
          const n = Math.min(CHUNK, size - off);
          await sink.write(new Uint8Array(await f.slice(off, off + n).arrayBuffer()), off);
          onProgress && onProgress('opfs', off + n, size);
        }
        await sink.close();
        return { bytes: size, source: 'opfs-cache' };
      }
    } catch (e) { /* not cached, fall through */ }
  }

  const writer = cache
    ? await (await cache.dir.getFileHandle(cache.key, { create: true })).createWritable()
    : null;

  if (ranges && size) {
    await sink.open(size);
    let got = 0;
    while (got < size) {
      const end = Math.min(got + CHUNK, size) - 1;
      const r = await fetch(url, { headers: { Range: `bytes=${got}-${end}` } });
      if (!(r.status === 206 || (r.status === 200 && got === 0)))
        throw new Error('range request failed: HTTP ' + r.status);
      const part = new Uint8Array(await r.arrayBuffer());
      await sink.write(part, got);
      if (writer) await writer.write(part);
      got += part.length;
      onProgress && onProgress('range', got, size);
      if (part.length === 0) break;
    }
    await sink.close();
    if (writer) await writer.close();
    return { bytes: got, source: 'http-range' };
  }

  /* no Range support: stream it */
  const resp = await fetch(url);
  const total = Number(resp.headers.get('content-length') || 0) || null;
  await sink.open(total || 0);
  const reader = resp.body.getReader();
  let off = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await sink.write(value, off);
    if (writer) await writer.write(value);
    off += value.length;
    onProgress && onProgress('stream', off, total);
  }
  await sink.close();
  if (writer) await writer.close();
  return { bytes: off, source: 'http-stream' };
}

/* ---- sink 1: the engine's own filesystem (single-threaded builds) -------- */
function fsSink(fsPath) {
  let fd = 0;
  return {
    open() { Module.FS.writeFile(fsPath, new Uint8Array(0)); fd = Module.FS.open(fsPath, 'w'); },
    async write(part, off) { Module.FS.write(fd, part, 0, part.length, off); },
    async close() { Module.FS.close(fd); }
  };
}

/* ---- sink 2: the shared heap (threaded builds) --------------------------- */
function heapSink() {
  let ptr = 0, size = 0;
  return {
    open(s) {
      size = s;
      ptr = Module._malloc(s);
      if (!ptr) throw new Error('out of wasm memory for ' + s + ' bytes');
    },
    async write(part, off) {
      /* re-read the view: the heap can grow underneath us */
      Module.HEAPU8.set(part, ptr + off);
    },
    async close() {},
    result() { return { ptr, size }; }
  };
}

window.dgStreamToFS = async function ({ url, fsPath, onProgress }) {
  const sink = fsSink(fsPath);
  const r = await transfer(url, onProgress, sink);
  return { ...r, fsPath };
};

window.dgStreamToHeap = async function ({ url, onProgress }) {
  const sink = heapSink();
  const r = await transfer(url, onProgress, sink);
  return { ...r, ...sink.result() };
};
