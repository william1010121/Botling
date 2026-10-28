// Focused hidden Electron rendering check using the production protocol resolver, response and CSPs.
// Routes: the result page served directly (botling-card://preview, PREVIEW_CSP sandbox), inside a
// PagePreview card frame (COMPONENT_CSP page + iframe), and inside the in-app report viewer's
// sandboxed iframe (ReportViewer: <iframe sandbox="allow-scripts">). The window is never shown and the
// Dock icon is hidden, so nothing takes focus. Does not launch Botling, touch user data, or run e2e.
//   node desktop/reports/preview-check.mjs /path/artifacts/report.html /path/screenshots [/path/artifacts/report-slides.html]
// Works for v1 reports (the seven-finding audit example) and v2 doc / slide output.
// Electron binary: node_modules/electron, or BOTLING_ELECTRON=/path/to/Electron.
import { build } from 'esbuild';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [file, output, slidesFile] = process.argv.slice(2);
if (!file || !output) throw Error('Usage: node desktop/reports/preview-check.mjs /path/artifacts/report.html /path/screenshots [/path/artifacts/slides.html]');
const executablePath = process.env.BOTLING_ELECTRON ?? join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
if (!existsSync(executablePath)) throw Error(`Electron not found at ${executablePath}; set BOTLING_ELECTRON`);
const isV2 = path => readFile(path, 'utf8').then(h => h.includes('class="rpt"') || h.includes('class="deck"'));
const temp = await mkdtemp(join(tmpdir(), 'report-preview-'));
await mkdir(output, { recursive: true });
let app;
try {
  const files = [resolve(file), ...(slidesFile ? [resolve(slidesFile)] : [])];
  await build({ stdin: { resolveDir: root, contents: `
    import { app, BrowserWindow, protocol } from 'electron';
    import { previewFile, previewURL } from './src/core/preview-url';
    import { previewResponse } from './src/main/preview-response';
    import { COMPONENT_CSP } from './src/main/card-page';
    const files = ${JSON.stringify(files)};
    app.setPath('userData', ${JSON.stringify(join(temp, 'profile'))});
    protocol.registerSchemesAsPrivileged([{scheme:'botling-card',privileges:{standard:true,secure:true}}]);
    app.whenReady().then(async () => {
      app.dock?.hide();
      protocol.handle('botling-card', async request => {
        const url = new URL(request.url);
        // PagePreview card frame and ReportViewer both embed the preview URL in a sandboxed iframe.
        if (url.host === 'report-test') {
          const target = files[Number(url.searchParams.get('i') ?? 0)];
          const viewer = url.searchParams.get('viewer') === '1';
          const frame = viewer
            ? '<section class="report-viewer"><header>← Back to conversation</header><iframe title="Full page report" sandbox="allow-scripts" src="'+previewURL(target)+'"></iframe></section>'
            : '<iframe sandbox="allow-scripts" src="'+previewURL(target)+'"></iframe>';
          return new Response('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}.report-viewer{display:flex;flex-direction:column;height:100%}.report-viewer header{padding:12px 16px}.report-viewer iframe{flex:1}</style>'+frame, {headers:{'Content-Type':'text/html','Content-Security-Policy':COMPONENT_CSP}});
        }
        const path = previewFile(request.url);
        return path ? previewResponse(path, request) : new Response('Not found', {status:404});
      });
      const window = new BrowserWindow({show:false,width:1280,height:900,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
      await window.loadURL(previewURL(files[0]));
    });
  ` }, outfile: join(temp, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  app = await electron.launch({ args: [join(temp, 'main.cjs')], executablePath });
  const page = await app.firstWindow();
  const remote = [], consoleErrors = [];
  page.on('request', request => { if (/^https?:/.test(request.url())) remote.push(request.url()); });
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  const v2 = await isV2(files[0]);
  const measure = () => ({
    title: document.querySelector('h1')?.textContent,
    findings: document.querySelectorAll('.finding').length,
    sections: document.querySelectorAll('section.sec').length,
    blocks: document.querySelectorAll('.blk').length,
    broken: document.querySelectorAll('.blk-error').length,
    svgs: [...document.querySelectorAll('svg')].filter(s => s.getBoundingClientRect().width > 0).length,
    emptySvgs: [...document.querySelectorAll('svg.fl')].filter(s => s.getBoundingClientRect().width > 0 && !s.querySelector('path,rect')).length,
    images: [...document.images].every(img => img.complete && img.naturalWidth > 0),
    overflow: document.documentElement.scrollWidth > innerWidth,
    background: getComputedStyle(document.body).backgroundColor,
    scriptCount: document.scripts.length,
  });
  const results = [];
  const routes = [['window-light', 1280, 'light', null], ['window-dark', 1280, 'dark', null], ['narrow', 390, 'light', null], ['card', 1280, 'light', 'card'], ['card-chat-width', 560, 'dark', 'card'], ['report-viewer', 1200, 'dark', 'viewer']];
  for (const [name, width, scheme, host] of routes) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(host ? `botling-card://report-test/?i=0${host === 'viewer' ? '&viewer=1' : ''}` : 'botling-card://preview' + files[0].split('/').map(encodeURIComponent).join('/'));
    const frame = host ? await (await page.locator('iframe').elementHandle()).contentFrame() : page.mainFrame();
    await frame.locator('h1').waitFor();
    const result = await frame.evaluate(async m => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode())); return (0, eval)(`(${m})`)(); }, measure.toString());
    if (v2) { assert.ok(result.sections > 0 && result.blocks > 0, name); assert.equal(result.broken, 0, name); assert.equal(result.emptySvgs, 0, name); }
    else assert.equal(result.findings, 7);
    assert.equal(result.images, true); assert.equal(result.overflow, false, `${name} overflows`); assert.equal(result.scriptCount, 0, `${name} doc output must be script-free`);
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: !host });
    results.push({ route: name, ...result });
  }
  if (files[1]) {
    // Slide mode in the report viewer: the paging script must run under the sandbox and PREVIEW_CSP.
    await page.setViewportSize({ width: 1200, height: 760 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('botling-card://report-test/?i=1&viewer=1');
    const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
    await frame.locator('.sv').first().waitFor();
    await page.locator('iframe').click({ position: { x: 20, y: 20 } });
    const before = await frame.evaluate(() => scrollY);
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400);
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400);
    const after = await frame.evaluate(() => ({ y: scrollY, slides: document.querySelectorAll('.sv').length, scripts: document.scripts.length, scale: getComputedStyle(document.querySelector('.sl')).transform }));
    assert.ok(after.y > before, 'arrow keys page through slides');
    assert.equal(after.scripts, 1); assert.notEqual(after.scale, 'none');
    await page.screenshot({ path: join(output, 'report-viewer-slides.png') });
    results.push({ route: 'report-viewer-slides', scrolledFrom: before, scrolledTo: after.y, slides: after.slides, transform: after.scale });
  }
  await page.goto('botling-card://preview' + files[0].split('/').map(encodeURIComponent).join('/'));
  await page.emulateMedia({ media: 'print' });
  await page.locator('h1').waitFor();
  const pdf = await app.evaluate(async ({ BrowserWindow }) => [...await BrowserWindow.getAllWindows()[0].webContents.printToPDF({ preferCSSPageSize: true, printBackground: true })]);
  await writeFile(join(output, 'print.pdf'), Buffer.from(pdf));
  assert.deepEqual(remote, []);
  await writeFile(join(output, 'results.json'), JSON.stringify({ results, remoteRequests: remote, consoleErrors, print: 'Generated using Chromium print CSS; app print UI not tested', scope: 'Hidden Electron harness importing unmodified production resolver/response/CSP; card and report-viewer frames reproduced with the same sandbox attributes; not installed-app UI acceptance' }, null, 2));
  console.log(JSON.stringify({ results, consoleErrors }));
} finally { if (app) await app.close(); await rm(temp, { recursive: true, force: true }); }
