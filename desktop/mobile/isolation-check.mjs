// Botling Web card isolation, in a real headless Chromium (no visible window) against the synthetic
// fixture (`npm run test:web-isolation`): from INSIDE rendered component/card frames (after the frame host's document.write), every
// way out must fail — network (bridge API, external), nested frames, forms, workers, popups,
// same-origin access to the chat page / app shell, cookies and storage.
//
//   node mobile/build.mjs && node mobile/isolation-check.mjs [out-dir]
// Env: BOTLING_CHROMIUM (a Chromium/headless_shell executable; default: Playwright's own),
//      FIXTURE_COMPONENTS_DIR (optional real templates). Exit 1 when any check fails.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.argv[2] ?? join(here, 'dist-isolation');
mkdirSync(out, { recursive: true });
const fixture = spawn(process.execPath, [join(here, 'fixture-server.mjs')], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
const base = await new Promise((resolve, reject) => {
  fixture.stdout.on('data', chunk => { const match = /http:\/\/[^\s]+\/mobile\//.exec(String(chunk)); if (match) resolve(match[0]); });
  fixture.on('exit', () => reject(new Error('fixture exited')));
});
const shellOrigin = new URL(base).origin;
const browser = await chromium.launch({ headless: true, ...(process.env.BOTLING_CHROMIUM ? { executablePath: process.env.BOTLING_CHROMIUM } : {}) });
const result = { base, frames: [], playwrightRequestEvents: [], serverHits: [], hostHeaders: null, failures: [] };
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
  let probing = false;
  page.on('request', request => {
    const frame = request.frame?.();
    if (probing && !request.url().startsWith('data:')) result.playwrightRequestEvents.push({ url: request.url(), method: request.method(), from: frame?.url() ?? null });
  });
  page.on('response', async response => { if (response.url().endsWith('/frame-host.html')) result.hostHeaders ??= { csp: (await response.allHeaders())['content-security-policy'] }; });
  await page.goto(base);
  await page.fill('input.web-token', 'f'.repeat(43));
  await page.click('button.web-primary');
  await page.waitForSelector('.shell[data-ready="1"]');
  // Things a card must not see: a readable shell cookie and shell storage (the access token lives only in the shell's memory).
  await page.evaluate(() => { document.cookie = 'probe=shell-visible; path=/'; localStorage.setItem('probe', 'shell-visible'); });
  await page.click('.bot-row[data-bot="proj-botling"]');
  await page.waitForTimeout(2500);
  const hosts = page.frames().filter(frame => frame.url().endsWith('/mobile/frame-host.html'));
  if (hosts.length < 2) result.failures.push(`expected a component and a Phase 0 card frame, found ${hosts.length}`);
  const hitsBefore = (await (await fetch(`${shellOrigin}/fixture/hits`)).json()).length;
  probing = true;
  for (const frame of hosts) {
    const report = await frame.evaluate(async ({ shellOrigin }) => {
      const violations = [];
      document.addEventListener('securitypolicyviolation', event => violations.push(event.effectiveDirective || event.violatedDirective));
      const attempt = async (fn) => { try { const value = await fn(); return { ok: true, value: value === undefined ? null : String(value).slice(0, 120) }; } catch (error) { return { ok: false, error: `${error?.name}: ${String(error?.message).slice(0, 120)}` }; } };
      const settle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));
      const written = document.body.innerText.replace(/\s+/g, ' ').slice(0, 80);
      const checks = {
        origin: self.origin,
        cookie: await attempt(() => document.cookie),
        localStorage: await attempt(() => localStorage.getItem('probe')),
        sessionStorage: await attempt(() => sessionStorage.length),
        indexedDB: await attempt(() => new Promise((resolve, reject) => { const r = indexedDB.open('probe'); r.onsuccess = () => resolve('opened'); r.onerror = () => reject(r.error); })),
        fetchBridgeAPI: await attempt(() => fetch(`${shellOrigin}/api/mobile/command`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{"v":10,"id":"probe","cmd":{"type":"chat.snapshot"}}' }).then(r => r.status)),
        fetchRelative: await attempt(() => fetch('/api/mobile/command', { method: 'POST' }).then(r => r.status)),
        fetchExternal: await attempt(() => fetch('https://example.com/').then(r => r.status)),
        xhr: await attempt(() => new Promise((resolve, reject) => { const x = new XMLHttpRequest(); x.open('GET', `${shellOrigin}/mobile/index.html`); x.onload = () => resolve(x.status); x.onerror = () => reject(new Error('xhr error')); x.send(); })),
        webSocket: await attempt(() => new Promise((resolve, reject) => { const w = new WebSocket(shellOrigin.replace('http', 'ws')); w.onopen = () => resolve('open'); w.onerror = () => reject(new Error('ws error')); })),
        // sendBeacon only says whether it queued; whether anything arrived is checked at the server (serverHits).
        beacon: { ok: false, queued: (() => { try { return navigator.sendBeacon(`${shellOrigin}/api/mobile/command`, 'x'); } catch (e) { return e.name; } })() },
        image: await attempt(() => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve('loaded'); i.onerror = () => reject(new Error('image blocked')); i.src = 'https://example.com/favicon.ico'; })),
        nestedFrame: await attempt(async () => { const f = document.createElement('iframe'); f.src = `${shellOrigin}/mobile/`; document.body.append(f); await settle(); f.remove(); return violations.includes('frame-src') ? Promise.reject(new Error('blocked by frame-src')) : 'not blocked'; }),
        // about:srcdoc is not a fetch, so frame-src cannot stop it; it inherits this sandbox and CSP. Prove that from inside it.
        nestedSrcdoc: await new Promise(resolve => {
          const f = document.createElement('iframe');
          f.srcdoc = `<script>(async () => { const r = { origin: self.origin }; try { r.cookie = document.cookie; } catch (e) { r.cookie = e.name; }
            try { await fetch(${JSON.stringify(shellOrigin)} + '/api/mobile/command', { method: 'POST' }); r.fetch = 'reached'; } catch (e) { r.fetch = e.name; }
            try { r.top = top.document.title; } catch (e) { r.top = e.name; } try { r.storage = localStorage.length; } catch (e) { r.storage = e.name; }
            parent.postMessage({ srcdocProbe: r }, '*'); })()<\/script>`;
          const done = (value) => { removeEventListener('message', on); f.remove(); resolve(value); };
          const on = (e) => { if (e.data?.srcdocProbe) done({ ok: false, inherited: e.data.srcdocProbe }); };
          addEventListener('message', on); document.body.append(f); setTimeout(() => done({ ok: false, error: 'no script ran' }), 1500);
        }),
        form: await attempt(async () => { const form = document.createElement('form'); form.method = 'POST'; form.action = `${shellOrigin}/api/mobile/command`; document.body.append(form); const before = location.href; form.submit(); await settle(); return location.href !== before ? 'navigated' : Promise.reject(new Error('not submitted')); }),
        worker: await attempt(() => new Promise((resolve, reject) => { const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }))); w.onmessage = () => resolve('ran'); w.onerror = () => reject(new Error('worker error')); setTimeout(() => reject(new Error('worker silent')), 400); })),
        sharedWorker: await attempt(() => new SharedWorker(URL.createObjectURL(new Blob([''], { type: 'text/javascript' }))) && 'created'),
        popup: await attempt(() => { const w = window.open(`${shellOrigin}/mobile/`); return w ? 'opened' : Promise.reject(new Error('blocked')); }),
        parentDocument: await attempt(() => parent.document.body.innerHTML.length),
        chatPageMessages: await attempt(() => parent.document.getElementById('messages').textContent.length),
        topDocument: await attempt(() => top.document.querySelector('.shell').outerHTML.length),
        topStore: await attempt(() => typeof top.__botlingStore.getView),
        topLocationRead: await attempt(() => top.location.href),
        topNavigate: await attempt(() => { top.location.href = 'https://example.com/'; return 'navigated'; }),
      };
      await settle(200);
      return { url: location.href, written, checks, violations: [...new Set(violations)] };
    }, { shellOrigin });
    result.frames.push(report);
  }
  probing = false;
  await page.waitForTimeout(800);
  // What reached the server while the cards probed, apart from the shell's own polling (its exact Origin).
  result.serverHits = (await (await fetch(`${shellOrigin}/fixture/hits`)).json()).slice(hitsBefore)
    .filter(hit => !(hit.url === '/api/mobile/command' && hit.origin === shellOrigin) && hit.url !== '/fixture/hits');
  const shell = await page.evaluate(() => ({ url: location.href, shellAlive: !!document.querySelector('.shell'), cookie: document.cookie }));
  result.shellAfter = shell;
  // The CPU card in view, for the record.
  const chat = page.frames().find(frame => frame.url().endsWith('/mobile/chat.html'));
  await chat?.evaluate(() => document.querySelector('.row[data-id="cpu"]')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, 'card-isolation-1440x900.png') });

  // Every escape must have failed.
  const mustFail = ['cookie', 'localStorage', 'sessionStorage', 'indexedDB', 'fetchBridgeAPI', 'fetchRelative', 'fetchExternal', 'xhr', 'webSocket', 'image',
    'nestedFrame', 'form', 'worker', 'sharedWorker', 'popup', 'parentDocument', 'chatPageMessages', 'topDocument', 'topStore', 'topLocationRead', 'topNavigate'];
  for (const frame of result.frames) {
    if (frame.checks.origin !== 'null') result.failures.push(`${frame.written}: origin ${frame.checks.origin}`);
    if (!frame.written) result.failures.push('a frame host page was never written');
    for (const name of mustFail) {
      const check = frame.checks[name];
      // A cookie read in an opaque origin throws; an empty string is also no access.
      if (name === 'cookie' && check.ok && check.value === '') continue;
      if (check.ok) result.failures.push(`${frame.written.slice(0, 30)}: ${name} succeeded (${check.value})`);
    }
  }
  if (result.serverHits.length) result.failures.push(`requests from card frames reached the server: ${JSON.stringify(result.serverHits)}`);
  for (const frame of result.frames) {
    const inner = frame.checks.nestedSrcdoc.inherited;
    if (!inner || inner.origin !== 'null' || inner.fetch === 'reached' || inner.top !== 'SecurityError' || inner.storage !== 'SecurityError' || inner.cookie !== 'SecurityError')
      result.failures.push(`nested srcdoc frame not isolated: ${JSON.stringify(frame.checks.nestedSrcdoc)}`);
  }
  if (!shell.shellAlive || !shell.url.startsWith(base)) result.failures.push('the shell was navigated or torn down by a card');
  if (!/^sandbox allow-scripts;/.test(result.hostHeaders?.csp ?? '')) result.failures.push(`frame host CSP: ${result.hostHeaders?.csp}`);
} finally {
  await browser.close();
  fixture.kill();
}
result.passed = result.failures.length === 0;
writeFileSync(join(out, 'card-isolation.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ passed: result.passed, failures: result.failures, frames: result.frames.map(f => f.written.slice(0, 40)), out }, null, 1));
process.exit(result.passed ? 0 : 1);
