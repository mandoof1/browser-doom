/* app.js - the page shell.
 *
 * Responsibilities, in the order the 2026 ports do them:
 *   1. boot the module (engine on its own thread, page thread stays free)
 *   2. restore persisted files into the engine's inbox
 *   3. stream the game data (HTTP Range -> OPFS -> shared heap) and hand the
 *      engine a pointer - this is what unblocks the engine's main()
 *   4. poll for frames, feed input, mirror engine-written files back to IDB
 *   5. report frame stats + log tail to /telemetry
 */
(function () {
  const logEl = document.getElementById('log');
  const stageEl = document.getElementById('stage');
  const progEl = document.getElementById('prog');
  const statsEl = document.getElementById('stats');
  const titleEl = document.getElementById('title');
  const canvas = document.getElementById('screen');

  const params = new URLSearchParams(location.search);
  const WAD_URL = params.get('wad') || '/data/freedoom1.wad';
  const BUILD = params.get('build') || 'doom';
  const engineLog = [];
  let booted = false;

  function log(msg, cls) {
    const line = document.createElement('span');
    line.className = cls || 'k';
    line.textContent = msg + '\n';
    logEl.appendChild(line);
    while (logEl.childNodes.length > 400) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
    engineLog.push(String(msg));
    if (engineLog.length > 200) engineLog.shift();
  }
  function stage(t) { stageEl.textContent = t; }
  function progress(done, total) {
    progEl.hidden = false;
    progEl.value = total ? Math.round((done / total) * 100) : 0;
  }

  /* ---- callbacks the engine reaches through the bridge ------------------ */
  window.dg_set_title_ptr = function (ptr) {
    try { titleEl.textContent = 'browser-port · ' + Module.UTF8ToString(ptr); } catch (e) {}
  };
  window.dg_on_engine_init = function () {
    window.doomReady = true;
    log('engine up on its own thread', 'ok');
  };

  /* ---- module ------------------------------------------------------------ */
  window.Module = {
    arguments: (function () {
      const a = ['-iwad', '/doom1.wad', '-savedir', '/save', '-config', '/default.cfg',
                 '-nomusic', '-window', '-nopause'];
      if (params.get('skill')) a.push('-skill', params.get('skill'));
      if (params.get('warp')) a.push('-warp', ...params.get('warp').split(/[, ]+/).filter(Boolean));
      if (params.get('extra')) a.push(...params.get('extra').split(' ').filter(Boolean));
      return a;
    })(),
    print: (t) => log(t),
    printErr: (t) => log(t, 'err'),
    onAbort: (what) => { log('abort: ' + what, 'err'); stage('aborted'); },
    onExit: (code) => { log('engine exited ' + code, 'dim'); stage('exited'); window.doomExited = code; },
    onRuntimeInitialized: () => { window.__runtimeReady = true; },
  };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  const wait = (fn, ms = 60000) => new Promise((res, rej) => {
    const t0 = performance.now();
    (function spin() {
      if (fn()) return res(true);
      if (performance.now() - t0 > ms) return rej(new Error('timeout waiting for module'));
      setTimeout(spin, 50);
    })();
  });

  async function main() {
    log('browser-port · build=' + BUILD + ' · crossOriginIsolated=' + self.crossOriginIsolated, 'dim');
    if (!self.crossOriginIsolated)
      log('not cross-origin isolated: SharedArrayBuffer/threads unavailable (need COOP+COEP headers)', 'err');

    await loadScript('/build/' + BUILD + '.js');
    log('module loaded (' + BUILD + '.js)', 'ok');
    await wait(() => window.__runtimeReady);

    const info = window.dgPresent.init(canvas);
    log('presenter: ' + info.w + 'x' + info.h + (info.gl ? ' webgl2' : ' canvas2d'), 'ok');

    stage('restoring saves');
    try {
      const r = await window.dgSaves.restore();
      if (r.restored) log('restored ' + r.restored + ' file(s) from IndexedDB: ' + r.files.join(', '), 'ok');
    } catch (e) { log('save restore skipped: ' + e, 'err'); }

    stage('streaming game data');
    const wad = await window.dgStreamToHeap({
      url: WAD_URL,
      onProgress: (how, done, total) => {
        stage(how + ' ' + Math.round(done / 1024) + ' KiB' + (total ? '/' + Math.round(total / 1024) + ' KiB' : ''));
        if (total) progress(done, total);
      }
    });
    log('game data: ' + wad.bytes + ' bytes via ' + wad.source + ' -> heap@0x' + wad.ptr.toString(16), 'ok');
    Module.ccall('dg_set_wad', null, ['number', 'number'], [wad.ptr, wad.bytes]);
    progEl.hidden = true;
    stage('running');

    /* frame loop: poll for new frames from the engine thread, poll the pad */
    let lastHud = 0;
    (function raf() {
      window.dgInput.pollPad();
      window.dgPresent.poll();
      const now = performance.now();
      if (now - lastHud > 500) {
        lastHud = now;
        const s = window.doomStats || {};
        const el = (s.last || 0) - (s.started || 0);
        statsEl.textContent = (s.frames || 0) + ' frames · ' +
          (el > 0 ? ((s.frames || 0) / (el / 1000)).toFixed(1) : '0') + ' fps · ' +
          (s.keyevents || 0) + ' key events · ' +
          Math.round((Module.HEAPU8 ? Module.HEAPU8.length : 0) / 1048576) + ' MB heap';
      }
      requestAnimationFrame(raf);
    })();

    setInterval(async function () {
      const s = window.doomStats || {};
      try {
        await fetch('/telemetry', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            build: BUILD, wad: WAD_URL, ua: navigator.userAgent,
            frames: s.frames, keyevents: s.keyevents, sleeps: s.sleeps,
            crossOriginIsolated: self.crossOriginIsolated,
            heapMB: Math.round((Module.HEAPU8 || []).length / 1048576),
            saves: window.dgSaves.counters(),
            logTail: engineLog.slice(-40)
          })
        });
      } catch (e) { /* telemetry is optional */ }
    }, 10000);

    window.doomBooted = true;
  }

  window.dgInput.bindKeys(window);
  window.dgInput.bindMouse(canvas);   // click = fire, like any other DOOM port
  main().catch((e) => { log('startup failed: ' + ((e && e.message) || e), 'err'); stage('failed'); });
})();
