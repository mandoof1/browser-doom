import puppeteer from 'puppeteer';
const b = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, args: ['--no-sandbox'] });
const p = await b.newPage();
await p.goto('http://127.0.0.1:8770/', { waitUntil: 'domcontentloaded' });
console.log(JSON.stringify(await p.evaluate(() => ({
  secure: window.isSecureContext,
  keyboard: typeof navigator.keyboard,
  lock: navigator.keyboard ? typeof navigator.keyboard.lock : null,
  lockApi: 'keyboard' in navigator
}))));
await b.close();
