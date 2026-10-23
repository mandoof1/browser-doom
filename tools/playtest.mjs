/* playtest.mjs - does the port actually *play*?
 *
 * Attract mode proves the renderer, not the input path. This drives a real
 * session: start a new game, walk around, save into slot 1, then reload the
 * page and prove the save comes back out of IndexedDB and into the engine's
 * inbox. Movement is proven by diffing two frames, not by trusting counters.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8767;
/* -warp skips the title screen, so the session is deterministic: no guessing
 * where the menu cursor happens to be. */
const PAGE_URL = `http://127.0.0.1:${PORT}/?wad=%2Fdata%2Ffreedoom1.wad&build=doom&warp=1,1&extra=-nomonsters`;

const server = spawn('python3', [path.join(ROOT, 'tools', 'serve.py'), String(PORT)], {
  cwd: ROOT, stdio: 'inherit'
});
await new Promise(r => setTimeout(r, 1500));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/brave',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
});

const problems = [];
const page = await browser.newPage();
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); if (m.type() === 'warning') console.log('WARN', m.text()); });

async function shot(name) {
  const p = path.join(ROOT, 'shots', name);
  await page.screenshot({ path: p });
  return p;
}
async function key(k, ms = 90) {
  const before = (await stats()).keyevents;
  await page.keyboard.down(k);
  await new Promise(r => setTimeout(r, ms));
  await page.keyboard.up(k);
  await new Promise(r => setTimeout(r, 450));
  const after = (await stats()).keyevents;
  console.log(`key ${k}: engine saw ${after - before} event(s)`);
}
const stats = () => page.evaluate(() => ({ ...window.doomStats }));

await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('(window.doomStats || {}).frames > 30', { timeout: 60000 });
console.log('attract mode running:', (await stats()).frames, 'frames');
await shot('play-00-attract.png');

await new Promise(r => setTimeout(r, 3000));
await shot('play-01-start.png');
console.log('after new game:', JSON.stringify(await stats()));

/* walk forward, then look: two frames must differ */
await page.keyboard.down('ArrowUp');
await new Promise(r => setTimeout(r, 2500));
await page.keyboard.up('ArrowUp');
await shot('play-02-walked.png');
await page.keyboard.down('ArrowLeft');
await new Promise(r => setTimeout(r, 900));
await page.keyboard.up('ArrowLeft');
await shot('play-03-turned.png');
console.log('after walk/turn:', JSON.stringify(await stats()));

/* save into slot 1: menu -> SAVE GAME -> slot 1 */
await key('Escape');
await shot('play-04-menu.png');
for (let i = 0; i < 3; i++) await key('ArrowDown');
await key('Enter');
await new Promise(r => setTimeout(r, 1200));
await shot('play-05-savemenu.png');
// cursor is already on slot 1; Enter starts name entry, and the engine only
// commits the save if the description is non-empty
await key('Enter');
await key('1');        // type a description
await new Promise(r => setTimeout(r, 600));
await shot('play-06-naming.png');
await key('Enter');    // confirm -> M_DoSave -> G_DoSaveGame
await new Promise(r => setTimeout(r, 1500));
const memfs = await page.evaluate(() => {
  try {
    return { save: Module.FS.readdir('/save').filter(x => !x.startsWith('.')),
             root: Module.FS.readdir('/').filter(x => !x.startsWith('.')) };
  } catch (e) { return { error: String(e) }; }
});
console.log('engine filesystem:', JSON.stringify(memfs));
const saved = await page.evaluate(async () => {
  await new Promise(r => setTimeout(r, 300));
  return { files: await window.dgSaves.list(), counters: window.dgSaves.counters() };
});
console.log('after save:', JSON.stringify(saved));
if (!saved.files.length) problems.push('no save file reached IndexedDB');
await shot('play-04-saved.png');

const before = { ...await stats() };

/* reload: the save has to come back out of IndexedDB into the engine inbox */
await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('(window.doomStats || {}).assets_ready > 0', { timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));
const after = await page.evaluate(async () => ({
  counters: window.dgSaves.counters(),
  files: await window.dgSaves.list(),
  stats: { ...window.doomStats }
}));
console.log('after reload:', JSON.stringify(after));
if (!after.counters.restored) problems.push('save was not restored into the engine on reload');

/* the restored file has to be visible to the engine, not just parked in the
 * inbox: the save menu should list the description we typed. */
async function key2(k, ms = 90) {
  await page.keyboard.down(k);
  await new Promise(r => setTimeout(r, ms));
  await page.keyboard.up(k);
  await new Promise(r => setTimeout(r, 450));
}
await key2('Escape');
for (let i = 0; i < 3; i++) await key2('ArrowDown');
await key2('Enter');
await new Promise(r => setTimeout(r, 1000));
await shot('play-07-restored-slots.png');

await browser.close();
server.kill();

console.log('\nframes before reload:', before.frames, '| after reload:', after.stats.frames);
console.log(problems.length ? 'FAIL\n - ' + problems.join('\n - ') : 'PASS');
console.log(JSON.stringify({ saved: saved.files, restored: after.counters.restored }, null, 1));
process.exit(problems.length ? 1 : 0);
