import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
const srv = spawn('python3', ['tools/serve.py','8767'], {stdio:'ignore'});
await new Promise(r=>setTimeout(r,700));
const b = await puppeteer.launch({executablePath:'/usr/bin/brave', headless:'new',
  args:['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--mute-audio']});
const p = await b.newPage();
p.on('pageerror', e=>console.log('PAGEERROR:', e.message));
p.on('console', m=>{ const t=m.text(); if(m.type()==='error'||m.type()==='warning') console.log('CONSOLE-'+m.type().toUpperCase()+':', t.slice(0,300)); });
p.on('requestfailed', r=>console.log('REQFAIL:', r.url(), (r.failure()||{}).errorText));
const build = process.env.BUILD || 'doom';
await p.goto('http://127.0.0.1:8767/?build='+build, {waitUntil:'domcontentloaded'});
for (let i=0;i<10;i++){
  await new Promise(r=>setTimeout(r,1500));
  const st = await p.evaluate(()=>({
    booted: !!window.doomBooted, ready: !!window.doomReady, rt: !!window.__runtimeReady,
    s: window.doomStats ? {...window.doomStats} : null,
    stage: document.getElementById('stage').textContent,
    heap: (typeof Module!=='undefined' && Module.HEAPU8) ? Math.round(Module.HEAPU8.length/1048576) : 0
  }));
  console.log(i, JSON.stringify(st));
}
console.log('LOG:\n' + await p.evaluate(()=>document.getElementById('log').textContent.split('\n').slice(-30).join('\n')));
await b.close(); srv.kill();
