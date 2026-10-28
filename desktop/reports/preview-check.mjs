// Focused hidden Electron rendering check using production protocol resolver, response and CSP.
// Does not launch the Botling app, touch user data, or run the full app/e2e suite.
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [file, output] = process.argv.slice(2);
if (!file || !output) throw Error('Usage: node desktop/reports/preview-check.mjs /path/artifacts/report.html /path/screenshots');
const temp = await mkdtemp(join(tmpdir(), 'report-preview-'));
await mkdir(output, { recursive: true });
let app;
try {
  await build({ stdin: { resolveDir: root, contents: `
    import { app, BrowserWindow, protocol } from 'electron';
    import { previewFile, previewURL } from './src/core/preview-url';
    import { previewResponse } from './src/main/preview-response';
    import { COMPONENT_CSP } from './src/main/card-page';
    app.setPath('userData', ${JSON.stringify(join(temp, 'profile'))});
    protocol.registerSchemesAsPrivileged([{scheme:'botling-card',privileges:{standard:true,secure:true}}]);
    app.whenReady().then(async () => {
      app.dock?.hide();
      protocol.handle('botling-card', async request => {
        if(new URL(request.url).host==='report-test') return new Response('<!doctype html><style>html,body,iframe{margin:0;border:0;width:100%;height:100%}</style><iframe sandbox="allow-scripts" src="'+previewURL(${JSON.stringify(resolve(file))})+'"></iframe>', {headers:{'Content-Type':'text/html','Content-Security-Policy':COMPONENT_CSP}});
        const file = previewFile(request.url);
        return file ? previewResponse(file,request) : new Response('Not found',{status:404});
      });
      const window = new BrowserWindow({show:false,width:1280,height:900,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
      await window.loadURL(previewURL(${JSON.stringify(resolve(file))}));
    });
  ` }, outfile: join(temp, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  app = await electron.launch({ args: [join(temp, 'main.cjs')], executablePath: join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') });
  const page = await app.firstWindow();
  const remote = [];
  page.on('request', request => { if (/^https?:/.test(request.url())) remote.push(request.url()); });
  const results = [];
  for (const [name, width, scheme, card] of [['window-light',1280,'light',false],['window-dark',1280,'dark',false],['narrow',390,'light',false],['card',1280,'light',true]]) {
    await page.setViewportSize({width,height:900});
    await page.emulateMedia({colorScheme:scheme});
    if (card) await page.goto('botling-card://report-test/');
    const frame = card ? await (await page.locator('iframe').elementHandle()).contentFrame() : page.mainFrame();
    await frame.locator('h1').waitFor();
    const result = await frame.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(img => img.decode()));
      return { title: document.querySelector('h1')?.textContent, findings: document.querySelectorAll('.finding').length, images: [...document.images].every(img=>img.complete&&img.naturalWidth>0), overflow: document.documentElement.scrollWidth > innerWidth, background:getComputedStyle(document.documentElement).backgroundColor, scriptCount:document.scripts.length };
    });
    assert.equal(result.findings,7); assert.equal(result.images,true); assert.equal(result.overflow,false); assert.equal(result.scriptCount,0);
    await page.screenshot({path:join(output,`${name}.png`),fullPage:!card});
    results.push({route:name,...result});
  }
  await page.goto('botling-card://preview'+resolve(file).split('/').map(encodeURIComponent).join('/'));
  await page.emulateMedia({media:'print'});
  await page.locator('h1').waitFor();
  const pdf = await app.evaluate(async ({ BrowserWindow }) => [...await BrowserWindow.getAllWindows()[0].webContents.printToPDF({preferCSSPageSize:true,printBackground:true})]);
  await writeFile(join(output,'print.pdf'), Buffer.from(pdf));
  assert.deepEqual(remote,[]);
  await writeFile(join(output,'results.json'),JSON.stringify({results,remoteRequests:remote,print:'Generated using Chromium print CSS; app print UI not tested',scope:'Hidden Electron harness importing unmodified production resolver/response/CSP; not installed-app UI acceptance'},null,2));
  console.log(JSON.stringify(results));
} finally { if(app) await app.close(); await rm(temp,{recursive:true,force:true}); }
