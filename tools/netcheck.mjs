import puppeteer from 'puppeteer';
const b = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true,
  args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'] });
const p = await b.newPage();
p.on('console', m => console.log('CONSOLE', m.type(), m.text()));
p.on('pageerror', e => console.log('PAGEERROR', e.message));
p.on('requestfailed', r => console.log('FAIL', r.method(), r.url(), r.failure()?.errorText));
await p.goto('http://127.0.0.1:8765/?wad=%2Fdata%2Ffreedoom1.wad&build=doom_async', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 6; i++) {
  await new Promise(r => setTimeout(r, 2500));
  const s = await p.evaluate(() => window.doomStats ? {...window.doomStats} : {missing:'no doomStats'});
  console.log(i, JSON.stringify(s));
}
await p.screenshot({ path: 'shots/netcheck.png' });
await b.close();
