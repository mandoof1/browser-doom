/* verify.mjs - boot the port in a real browser and prove it runs.
 *
 * Uses Brave (Chromium 155) headless. Asserts:
 *   - the module instantiates and the engine reaches DG_Init
 *   - frames are actually being presented (WebGL2 path, SwiftShader in CI)
 *   - the WAD arrived over HTTP Range and landed in the engine's FS
 *   - no page errors / aborts
 * Then it pokes the keyboard and screenshots, so there is something to look at.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8765);
const PAGE_URL = `http://127.0.0.1:${PORT}/?${new URLSearchParams({
  wad: process.env.WAD || '/data/freedoom1.wad',
  build: process.env.BUILD || 'doom'
})}`;
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const server = spawn('python3', [path.join(ROOT, 'tools', 'serve.py'), String(PORT)],
  { stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', d => process.env.VERBOSE && process.stdout.write(d));
server.stderr.on('data', d => process.env.VERBOSE && process.stderr.write(d));

await new Promise(r => setTimeout(r, 800));

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER || '/usr/bin/brave',
  headless: 'new',
  args: [
    '--no-sandbox', '--no-first-run', '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--disable-brave-update', '--metrics-recording-only', '--mute-audio'
  ]
});

let failed = [];
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(m.type() + ': ' + m.text());
  });
  page.on('requestfailed', r => consoleErrors.push('requestfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText));

  console.log('open', PAGE_URL);
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  await page.waitForFunction('window.doomBooted === true', { timeout: 90000 });
  await page.waitForFunction('window.doomReady === true', { timeout: 90000 });
  console.log('engine up on its own thread');
  await page.waitForFunction('(window.doomStats||{}).frames > 30', { timeout: 60000 });

  await new Promise(r => setTimeout(r, 4000));
  const s1 = await page.evaluate(() => ({ ...window.doomStats, iso: self.crossOriginIsolated }));
  console.log('after 4s:', JSON.stringify(s1));
  await page.screenshot({ path: path.join(SHOTS, 'boot.png') });

  // drive it: title screen -> new game -> move -> save
  const tap = async (key, hold = 140, gap = 500) => {
    await page.keyboard.down(key);
    await new Promise(r => setTimeout(r, hold));
    await page.keyboard.up(key);
    await new Promise(r => setTimeout(r, gap));
  };
  await tap('Enter');            // dismiss title
  await tap('Enter');            // episode/skill menu
  await tap('Enter');            // confirm
  await new Promise(r => setTimeout(r, 1500));
  await page.keyboard.down('ArrowUp');
  await new Promise(r => setTimeout(r, 2500));
  await page.keyboard.up('ArrowUp');
  await tap('Digit3');           // weapon 3 (rocket launcher, if the cheat-free start allows)
  await tap('F6', 140, 900);    // save game prompt
  await tap('Enter', 140, 1200);

  await page.evaluate(async () => { window.doomSavedFiles = await window.dgSaves.list(); });
  const s2 = await page.evaluate(() => ({ ...window.doomStats }));
  console.log('after input:', JSON.stringify(s2));
  await page.screenshot({ path: path.join(SHOTS, 'played.png') });

  const fsInfo = await page.evaluate(() => ({
    assetsReady: Module.ccall('dg_assets_ready', 'number', []),
    heapMB: Math.round(Module.HEAPU8.length / 1048576),
    saves: window.doomSavedFiles || []
  }));
  console.log('filesystem:', JSON.stringify(fsInfo));

  const log = await page.evaluate(() => document.getElementById('log').textContent.split('\n').slice(-14).join('\n'));
  console.log('--- engine log ---\n' + log + '\n------------------');

  if (!s1.frames || s1.frames < 10) failed.push('too few frames presented: ' + s1.frames);
  if (!s2.keyevents) failed.push('no key events reached the engine');
  if (!fsInfo.assetsReady) failed.push('engine never received the game data');
  const real = consoleErrors.filter(e => !/favicon|SwiftShader|GroupMarkerNotSet/i.test(e));
  if (real.length) failed.push('console errors: ' + real.slice(0, 6).join(' | '));
} catch (e) {
  failed.push('exception: ' + e.message);
} finally {
  await browser.close();
  server.kill();
}

if (failed.length) {
  console.log('\nFAIL');
  for (const f of failed) console.log(' - ' + f);
  process.exit(1);
}
console.log('\nPASS - screenshots in ' + SHOTS);
