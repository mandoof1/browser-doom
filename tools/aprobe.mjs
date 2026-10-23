import puppeteer from 'puppeteer';
const b = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true,
  args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'] });
const p = await b.newPage();
p.on('console', m => console.log('CONSOLE', m.type(), m.text()));
p.on('pageerror', e => console.log('PAGEERROR', e.message));
p.on('stderr', s => console.log('STDERR', s));
await p.goto('http://127.0.0.1:8765/?wad=%2Fdata%2Ffreedoom1.wad&build=doom_async', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 5; i++) {
  await new Promise(r => setTimeout(r, 3000));
  console.log(i, JSON.stringify(await p.evaluate(() => ({
    rt: window.__runtimeReady, mod: typeof window.Module, stage: document.getElementById('stage')?.textContent,
    stats: window.doomStats ? {...window.doomStats} : null,
    log: (document.getElementById('log')?.textContent || '').split('\n').slice(-6).join(' | ')
  }))));
}
await b.close();
