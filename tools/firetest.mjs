/* firetest.mjs - the fire button, proven from pixels.
 *
 * Counters cannot prove firing: the engine does not expose ammo. So this looks
 * at the framebuffer. Standing still, holding Ctrl must light up the muzzle
 * flash (view region changes), and after releasing, the pistol's ammo counter
 * in the status bar must read differently (HUD strip changes). Then the same
 * assertions run for a mouse click, because a browser port that ignores the
 * mouse is not a browser port.
 */
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8769;
const PAGE = `http://127.0.0.1:${PORT}/?wad=%2Fdata%2Ffreedoom1.wad&build=doom&warp=1,1&extra=-nomonsters`;

const server = spawn('python3', [path.join(ROOT, 'tools', 'serve.py'), String(PORT)],
                     { cwd: ROOT, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/brave', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.setViewport({ width: 800, height: 600 });
await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('(window.doomStats || {}).frames > 40', { timeout: 60000 });
await new Promise(r => setTimeout(r, 2500));

const box = (x, y, w, h) => ({ x, y, width: w, height: h, captureBeyondViewport: false });
const shot = async (name, clip) => {
  const file = path.join(ROOT, 'shots', `fire-${name}.png`);
  await page.screenshot({ path: file, clip });
  return file;
};

const VIEW = box(90, 110, 620, 330);     // the 3D view, above the status bar
const HUD  = box(90, 455, 620, 100);     // the status bar: ammo / health / arms

const baseView = await shot('base-view', VIEW);
const baseHud  = await shot('base-hud', HUD);

// --- Ctrl ---
await page.keyboard.down('ControlLeft');
await new Promise(r => setTimeout(r, 900));
const ctrlView = await shot('ctrl-view', VIEW);
await page.keyboard.up('ControlLeft');
await new Promise(r => setTimeout(r, 1500));
const ctrlHud = await shot('ctrl-hud', HUD);

// --- mouse ---
const mid = { x: 400, y: 270 };
await page.mouse.move(mid.x, mid.y);
await page.mouse.down({ button: 'left' });
await new Promise(r => setTimeout(r, 900));
const mouseView = await shot('mouse-view', VIEW);
await page.mouse.up({ button: 'left' });
await new Promise(r => setTimeout(r, 1500));
const mouseHud = await shot('mouse-hud', HUD);

const stats = await page.evaluate(() => ({ ...window.doomStats }));
await browser.close();
server.kill();

const pct = (a, b) => {
  const out = execFileSync('python3', [path.join(ROOT, 'tools', 'imgdiff.py'), a, b],
                           { encoding: 'utf8' });
  return parseFloat(out.match(/([0-9.]+)%/)[1]);
};

const r = {
  ctrl_view_muzzleflash: pct(baseView, ctrlView),
  ctrl_hud_ammo_changed: pct(baseHud, ctrlHud),
  mouse_view_muzzleflash: pct(baseView, mouseView),
  mouse_hud_ammo_changed: pct(baseHud, mouseHud),
  keyevents: stats.keyevents, errors
};
console.log(JSON.stringify(r, null, 1));

const problems = [];
if (r.ctrl_view_muzzleflash < 3) problems.push('Ctrl produced no muzzle flash');
if (r.ctrl_hud_ammo_changed < 0.3) problems.push('Ctrl did not change the ammo counter');
if (r.mouse_view_muzzleflash < 3) problems.push('mouse click produced no muzzle flash');
if (r.mouse_hud_ammo_changed < 0.3) problems.push('mouse click did not change the ammo counter');
if (errors.length) problems.push('console errors: ' + errors.join(' | '));
console.log(problems.length ? 'FAIL\n - ' + problems.join('\n - ') : 'PASS');
process.exit(problems.length ? 1 : 0);
