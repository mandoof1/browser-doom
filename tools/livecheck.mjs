/* livecheck.mjs - prove the hosted deployment actually plays.
 *
 * Same assertions as verify.mjs, but against a URL instead of a local server,
 * so it also exercises Render's edge: HTTP/2, the CDN in front of a Python
 * origin, and whether Range requests survive it (the asset streamer needs them).
 */
const URL_BASE = process.argv[2] || 'https://browser-doom.onrender.com';
const builds = (process.argv[3] || 'doom').split(',');

const { default: puppeteer } = await import('puppeteer');

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/brave',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
});

const out = [];
for (const build of builds) {
  const page = await browser.newPage();
  const errors = [];
  const ranges = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('response', r => {
    const u = r.url();
    if (u.includes('/data/')) ranges.push({ status: r.status(), range: r.request().headers().range || null });
  });

  const t0 = Date.now();
  try {
    await page.goto(`${URL_BASE}/?wad=%2Fdata%2Ffreedoom1.wad&build=${build}&warp=1,1`,
                    { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('(window.doomStats || {}).frames > 60', { timeout: 120000 });
    const boot = (Date.now() - t0) / 1000;

    const iso = await page.evaluate(() => self.crossOriginIsolated);
    const before = await page.evaluate(() => ({ ...window.doomStats }));

    await page.keyboard.down('ArrowUp');
    await new Promise(r => setTimeout(r, 1500));
    await page.keyboard.up('ArrowUp');
    await new Promise(r => setTimeout(r, 1000));
    const after = await page.evaluate(() => ({ ...window.doomStats }));

    await page.screenshot({ path: `shots/live-${build}.png` });

    const got206 = ranges.filter(r => r.status === 206).length;
    out.push({
      build, ok: true, boot_s: +boot.toFixed(1), isolated: iso,
      frames: after.frames, fps: +((after.frames - before.frames) /
        ((after.last - before.last) / 1000)).toFixed(1),
      key_events_sent: after.keyevents - before.keyevents,
      range_requests_206: got206, range_requests_total: ranges.length,
      heapMB: await page.evaluate(() => Module.HEAPU8.length >> 20),
      errors: errors.slice(0, 4)
    });
  } catch (e) {
    out.push({ build, ok: false, error: String(e.message || e).slice(0, 160), errors: errors.slice(0, 4) });
  }
  await page.close();
}

await browser.close();
console.log(JSON.stringify(out, null, 1));
process.exit(out.every(o => o.ok && o.errors.length === 0) ? 0 : 1);
