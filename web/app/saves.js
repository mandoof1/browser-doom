/* saves.js - persistence.
 *
 * "Saves in your browser, kept in IndexedDB so progress survives a reload"
 * (the wasm-revc pattern). On the threaded build the engine lives on its own
 * thread and has its own private filesystem, so files travel in both
 * directions through the bridge in doomgeneric_browser.c:
 *   engine -> page : dg_store_file(path, ptr, len)  (proxied EM_ASM call)
 *   page -> engine : dg_inbox_push(path, ptr, len)  (bytes already in the heap)
 */

window.dgSaves = (function () {
  const DB = 'browser-port', STORE = 'files';
  let db = null, stored = 0, restored = 0;

  function open() {
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'path' });
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  const store = (mode) => db.transaction(STORE, mode).objectStore(STORE);

  return {
    async init() { await open(); },

    /* engine -> IndexedDB */
    async store(path, bytes) {
      await open();
      await new Promise((res, rej) => {
        const t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).put({ path, data: bytes, mtime: Date.now() });
        t.oncomplete = res;
        t.onerror = () => rej(t.error);
      });
      stored++;
    },

    /* IndexedDB -> engine (before the engine reads them) */
    async restore() {
      await open();
      const all = await new Promise((res, rej) => {
        const r = store('readonly').getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      for (const rec of all) {
        const bytes = new Uint8Array(rec.data);
        const ptr = Module._malloc(bytes.length);
        if (!ptr) continue;
        Module.HEAPU8.set(bytes, ptr);
        Module.ccall('dg_inbox_push', null, ['string', 'number', 'number'], [rec.path, ptr, bytes.length]);
        restored++;
      }
      return { restored, files: all.map(a => a.path) };
    },

    async list() {
      await open();
      return new Promise((res) => {
        const r = store('readonly').getAll();
        r.onsuccess = () => res(r.result.map(x => ({ path: x.path, bytes: x.data.length, mtime: x.mtime })));
        r.onerror = () => res([]);
      });
    },

    counters() { return { stored, restored }; }
  };
})();

/* Called from the engine thread, proxied onto the page thread. */
window.dg_store_file = function (namePtr, ptr, len) {
  const path = Module.UTF8ToString(namePtr);
  const bytes = new Uint8Array(Module.HEAPU8.slice(ptr, ptr + len));
  window.dgSaves.store(path, bytes).catch(e => console.warn('store failed', path, e));
};
