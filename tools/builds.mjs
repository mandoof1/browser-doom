/* builds.mjs - every engine variant has to boot, stream, and present.
 *
 * doom       pthreads + PROXY_TO_PTHREAD (the one you want: the engine owns a
 *            real thread and the page never blocks)
 * doom_async single thread + ASYNCIFY (fallback for hosts that refuse
 *            cross-origin isolation; emscripten_sleep fakes the blocking calls)
 * doom64     pthreads + wasm64 (the memory64 experiment, same reason GTA V's
 *            browser build wanted a 4 GiB+ address space)
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8768;

const server = spawn('python3', [path.join(ROOT, 'tools', 'serve.py'), String(PORT)],
                     { cwd: ROOT, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/brave',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
});

const results = [];

for (const build of ['doom', 'doom_async', 'doom64']) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const t0 = Date.now();
  try {
    await page.goto(`http://127.0.0.1:${PORT}/?wad=%2Fdata%2Ffreedoom1.wad&build=${build}&warp=1,1`,
                    { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('(window.doomStats || {}).frames > 60', { timeout: 90000 });
    const s = await page.evaluate(() => ({ ...window.doomStats, iso: self.crossOriginIsolated,
                                           heap: Module.HEAPU8.length >> 20 }));
    const wall = (Date.now() - t0) / 1000;
    results.push({ build, ok: true, boot_s: wall, frames: s.frames, fps: +(s.frames / wall).toFixed(1),
                   heapMB: s.heap, isolated: s.iso });
    await page.screenshot({ path: path.join(ROOT, 'shots', `build-${build}.png`) });
  } catch (e) {
    results.push({ build, ok: false, error: String(e.message || e).slice(0, 160), errors: errors.slice(0, 3) });
  }
  if (errors.length) (results.at(-1).errors ||= []).push(...errors.slice(0, 3));
  await page.close();
}

await browser.close();
server.kill();
console.log(JSON.stringify(results, null, 1));
process.exit(results.every(r => r.ok) ? 0 : 1);
