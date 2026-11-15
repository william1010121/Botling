// Static serving of the built Botling 3 page under /v3/: CSP parity with botlingd, path traversal checks, and the 2.x
// /mobile/ headers when only STATIC_DIR is set.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type RelayConfig } from '../src/config.ts';
import { startRelay } from '../src/server.ts';

const EXPECTED_V3_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const EXPECTED_V3_CHAT_CSP = [
  "default-src 'none'",
  "script-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "frame-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join('; ');

const EXPECTED_V3_FRAME_HOST_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const EXPECTED_MOBILE_SHELL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function fakeV3Dist(): string {
  const dir = makeTempDir('relay-v3-dist-');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Botling 3</title>');
  writeFileSync(join(dir, 'chat.html'), '<!doctype html><title>Chat</title>');
  writeFileSync(join(dir, 'frame-host.html'), '<!doctype html><script src="frame-host.js"></script>');
  writeFileSync(join(dir, 'web.js'), 'console.log("v3");');
  writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  writeFileSync(join(dir, 'pdf.worker.mjs'), 'export default 1;');
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"start_url":"/v3/"}');
  writeFileSync(join(dir, '.hidden'), 'secret');
  writeFileSync(join(dir, 'bad.wasm'), 'wasm');
  mkdirSync(join(dir, 'pdfjs', 'cmaps'), { recursive: true });
  writeFileSync(join(dir, 'pdfjs', 'cmaps', 'test.bcmap'), 'cmap');
  mkdirSync(join(dir, 'plugins', 'ccb-latex', 'fonts'), { recursive: true });
  writeFileSync(join(dir, 'plugins', 'ccb-latex', 'fonts', 'math.woff2'), 'woff2');
  return dir;
}

function fakeMobileDist(): string {
  const dir = makeTempDir('relay-mobile-dist-');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Mobile 2.x</title>');
  writeFileSync(join(dir, 'chat.html'), '<!doctype html><title>Mobile Chat</title>');
  writeFileSync(join(dir, 'frame-host.html'), '<!doctype html><title>Mobile Host</title>');
  return dir;
}

const config = (over: Partial<RelayConfig> = {}): RelayConfig => ({ ...loadConfig({}), host: '127.0.0.1', port: 0, ...over });

function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /v3/ gives index.html with the 3.x CSP and serves dist assets', async () => {
  const v3Dir = fakeV3Dist();
  const relay = await startRelay(config({ staticV3Dir: v3Dir }));
  try {
    const base = `http://127.0.0.1:${relay.port}`;
    const index = await fetch(`${base}/v3/`);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(index.headers.get('content-security-policy'), EXPECTED_V3_CSP);
    assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(index.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(await index.text(), '<!doctype html><title>Botling 3</title>');

    const chat = await fetch(`${base}/v3/chat.html`);
    assert.equal(chat.status, 200);
    assert.equal(chat.headers.get('content-security-policy'), EXPECTED_V3_CHAT_CSP);

    const frameHost = await fetch(`${base}/v3/frame-host.html`);
    assert.equal(frameHost.status, 200);
    assert.equal(frameHost.headers.get('content-security-policy'), EXPECTED_V3_FRAME_HOST_CSP);

    const sw = await fetch(`${base}/v3/sw.js`);
    assert.equal(sw.status, 200);
    assert.equal(sw.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(sw.headers.get('content-security-policy'), EXPECTED_V3_CSP);
    assert.equal(sw.headers.get('service-worker-allowed'), null);

    const worker = await fetch(`${base}/v3/pdf.worker.mjs`);
    assert.equal(worker.status, 200);
    assert.equal(worker.headers.get('content-type'), 'text/javascript; charset=utf-8');

    const cmap = await fetch(`${base}/v3/pdfjs/cmaps/test.bcmap`);
    assert.equal(cmap.status, 200);

    const font = await fetch(`${base}/v3/plugins/ccb-latex/fonts/math.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('access-control-allow-origin'), '*');

    const redirect = await fetch(`${base}/v3`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/v3/');
  } finally {
    await relay.close();
  }
});

test('GET /v3/../mobile/index.html, encoded traversal, symlink escape, dot files, and unknown extensions are 404', async () => {
  const mobileDir = fakeMobileDist();
  const v3Dir = fakeV3Dist();
  const outsideDir = makeTempDir('relay-outside-');
  const outsideFile = join(outsideDir, 'secret.html');
  writeFileSync(outsideFile, 'outside-secret');
  symlinkSync(outsideFile, join(v3Dir, 'escape.html'));

  const relay = await startRelay(config({ staticDir: mobileDir, staticV3Dir: v3Dir }));
  try {
    const base = `http://127.0.0.1:${relay.port}`;
    // Raw HTTP requests (fetch normalizes .. and %2e%2e client-side before sending on the wire).
    assert.equal((await rawGet(relay.port, '/v3/../mobile/index.html')).status, 404);
    assert.equal((await rawGet(relay.port, '/v3/%2e%2e/mobile/index.html')).status, 404);
    assert.equal((await rawGet(relay.port, '/v3/..%2fmobile/index.html')).status, 404);
    assert.equal((await fetch(`${base}/v3/a%5c..%5cmobile/index.html`)).status, 404);
    assert.equal((await fetch(`${base}/v3/.hidden`)).status, 404);
    assert.equal((await fetch(`${base}/v3/escape.html`)).status, 404);
    assert.equal((await fetch(`${base}/v3/bad.wasm`)).status, 404);
  } finally {
    await relay.close();
  }
});

// With STATIC_V3_DIR set, /mobile/ redirects to /v3/ (phone-root.test.ts); without it the 2.x page keeps its headers.
test('/mobile/ still answers with the exact same headers when STATIC_V3_DIR is unset', async () => {
  const mobileDir = fakeMobileDist();
  const relay = await startRelay(config({
    staticDir: mobileDir,
    publicOrigin: 'https://relay.example',
  }));
  try {
    const base = `http://127.0.0.1:${relay.port}`;
    const mobileIndex = await fetch(`${base}/mobile/`);
    assert.equal(mobileIndex.status, 200);
    assert.equal(mobileIndex.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(mobileIndex.headers.get('content-security-policy'), EXPECTED_MOBILE_SHELL_CSP);
    assert.equal(await mobileIndex.text(), '<!doctype html><title>Mobile 2.x</title>');

    const mobileChat = await fetch(`${base}/mobile/chat.html`);
    assert.equal(mobileChat.status, 200);
    assert.match(mobileChat.headers.get('content-security-policy')!, /frame-src https:\/\/relay\.example\/mobile\/frame-host\.html/);

    const mobileHost = await fetch(`${base}/mobile/frame-host.html`);
    assert.equal(mobileHost.status, 200);
    assert.match(mobileHost.headers.get('content-security-policy')!, /script-src https:\/\/relay\.example\/mobile\/frame-host\.js/);
  } finally {
    await relay.close();
  }
});

test('with STATIC_V3_DIR unset, /v3/ and /v3 are 404', async () => {
  const loaded = loadConfig({});
  assert.equal(loaded.staticV3Dir, null);

  const mobileDir = fakeMobileDist();
  const relay = await startRelay(config({ staticDir: mobileDir }));
  try {
    const base = `http://127.0.0.1:${relay.port}`;
    assert.equal((await fetch(`${base}/v3/`)).status, 404);
    assert.equal((await fetch(`${base}/v3`)).status, 404);
    assert.equal((await fetch(`${base}/v3/index.html`)).status, 404);
    assert.equal((await fetch(`${base}/mobile/`)).status, 200);
  } finally {
    await relay.close();
  }
});

test('HEAD /v3/ gives the same headers as GET and an empty body', async () => {
  const v3Dir = fakeV3Dist();
  const relay = await startRelay(config({ staticV3Dir: v3Dir }));
  try {
    const base = `http://127.0.0.1:${relay.port}`;
    const getRes = await fetch(`${base}/v3/`);
    const getBody = await getRes.text();
    const headRes = await fetch(`${base}/v3/`, { method: 'HEAD' });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('content-type'), getRes.headers.get('content-type'));
    assert.equal(headRes.headers.get('content-length'), String(Buffer.byteLength(getBody)));
    assert.equal(headRes.headers.get('content-security-policy'), EXPECTED_V3_CSP);
    assert.equal(await headRes.text(), '');
  } finally {
    await relay.close();
  }
});

test('loadConfig reads STATIC_V3_DIR', () => {
  const c = loadConfig({ STATIC_V3_DIR: ' /tmp/v3-dist ' });
  assert.equal(c.staticV3Dir, '/tmp/v3-dist');
});
