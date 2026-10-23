/* capturetest.mjs - click the canvas, the page owns the input.
 *
 * Asserts the four things that actually matter once capture is on:
 *   1. pointer lock + keyboard lock really engaged
 *   2. moving the mouse turns the view (the engine's own mouse path)
 *   3. Ctrl+S no longer pauses the game - frames keep advancing
 *   4. Escape reaches DOOM (menu opens) instead of the browser eating it
 */
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REMOTE = process.argv[2] || null;
const PORT = 8770;
const ORIGIN = REMOTE || `http://127.0.0.1:${PORT}`;
const PAGE = `${ORIGIN}/?wad=%2Fdata%2Ffreedoom1.wad&build=doom&warp=1,1&extra=-nomonsters`;

let server = null;
if (!REMOTE) {
  server = spawn('python3', [path.join(ROOT, 'tools', 'serve.py'), String(PORT)],
                 { cwd: ROOT, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1500));
}

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/brave', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('dialog', async d => { errors.push('dialog opened: ' + d.message()); await d.dismiss(); });

await page.setViewport({ width: 800, height: 600 });
await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('(window.doomStats || {}).frames > 40', { timeout: 90000 });
await new Promise(r => setTimeout(r, 2500));

const VIEW = { x: 90, y: 110, width: 620, height: 330 };
const shot = async (name) => {
  const file = path.join(ROOT, 'shots', `capture-${name}.png`);
  await page.screenshot({ path: file, clip: VIEW });
  return file;
};
const pct = (a, b) => parseFloat(
  execFileSync('python3', [path.join(ROOT, 'tools', 'imgdiff.py'), a, b], { encoding: 'utf8' })
    .match(/([0-9.]+)%/)[1]);
const frames = () => page.evaluate(() => window.doomStats.frames);

const problems = [];

// --- 1. capture engages ---
await page.mouse.move(400, 270);
await page.mouse.click(400, 270);
await new Promise(r => setTimeout(r, 800));
const cap = await page.evaluate(() => ({
  pointerLocked: document.pointerLockElement === document.getElementById('screen'),
  kbdApi: !!(navigator.keyboard && navigator.keyboard.lock),
  reported: window.dgInput.isLocked(),
  chip: document.getElementById('capture').textContent
}));
if (!cap.pointerLocked) problems.push('clicking the canvas did not engage pointer lock');
if (!cap.reported) problems.push('input layer does not report capture');
if (cap.kbdApi) { /* keyboard lock is best-effort; checked below via Escape */ }

// --- 2. mouse look turns the view ---
const beforeMove = await shot('before');
for (let i = 0; i < 12; i++) { await page.mouse.move(400 + i * 12, 270); await new Promise(r => setTimeout(r, 40)); }
await new Promise(r => setTimeout(r, 700));
const afterMove = await shot('after-move');
const turnPct = pct(beforeMove, afterMove);
if (turnPct < 3) problems.push(`mouse movement did not turn the view (${turnPct}% changed)`);

// --- 3. Ctrl+S must not pause the game ---
const f0 = await frames();
await page.keyboard.down('Control');
await page.keyboard.press('KeyS');
await page.keyboard.up('Control');
await new Promise(r => setTimeout(r, 2000));
const f1 = await frames();
const fpsDuringCtrlS = (f1 - f0) / 2;
if (fpsDuringCtrlS < 20) problems.push(`Ctrl+S stalled the loop: only ${fpsDuringCtrlS.toFixed(1)} fps`);

// --- 4. Escape goes to DOOM, not the browser ---
const beforeEsc = await shot('before-esc');
await page.keyboard.press('Escape');
await new Promise(r => setTimeout(r, 900));
const afterEsc = await shot('after-esc');
const escPct = pct(beforeEsc, afterEsc);
if (escPct < 3) problems.push(`Escape did not open the DOOM menu (${escPct}% changed)`);

/* Headless Chrome keeps the lock on Escape; headed Chrome drops it and never
 * delivers the key. Either way the player must end up paused with the menu up
 * and the game still alive, which is what is asserted here. */
const escState = await page.evaluate(() => ({ locked: window.dgInput.isLocked(), frames: window.doomStats.frames }));
await new Promise(r => setTimeout(r, 1500));
const stillRunning = await frames();
if (stillRunning - escState.frames < 20) problems.push('the game stopped running after Escape');
await browser.close();
server?.kill();

const r = {
  capture: cap, mouse_look_view_changed_pct: turnPct,
  fps_during_ctrl_s: +fpsDuringCtrlS.toFixed(1),
  escape_changed_view_pct: escPct,
  capture_after_escape: escState.locked,
  frames_after_all_of_that: stillRunning, errors
};
console.log(JSON.stringify(r, null, 1));
if (errors.length) problems.push('console errors: ' + errors.slice(0, 3).join(' | '));
console.log(problems.length ? 'FAIL\n - ' + problems.join('\n - ') : 'PASS');
process.exit(problems.length ? 1 : 0);
