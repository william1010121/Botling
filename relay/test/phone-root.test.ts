// The Botling 3 page is THE phone page when STATIC_V3_DIR is set: the address a phone opens (the relay's root) and the
// 2.x page's address (/mobile/, the start_url of an old Home Screen app) both land on /v3/, whose own scope, manifest
// and service worker stay as they are. Without STATIC_V3_DIR the 2.x behaviour (/ → /mobile/) is unchanged.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type RelayConfig } from '../src/config.ts';
import { startRelay } from '../src/server.ts';

const tempDirs: string[] = [];
const makeTempDir = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); tempDirs.push(dir); return dir; };
afterEach(() => { while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true }); });

function fakeV3Dist(): string {
  const dir = makeTempDir('relay-root-v3-');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Botling 3</title>');
  writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"id":"/v3/","start_url":"/v3/","scope":"/v3/"}');
  return dir;
}
function fakeMobileDist(): string {
  const dir = makeTempDir('relay-root-mobile-');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Mobile 2.x</title>');
  writeFileSync(join(dir, 'chat.html'), '<!doctype html><title>Mobile Chat</title>');
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"start_url":"./","scope":"./"}');
  return dir;
}

const config = (over: Partial<RelayConfig> = {}): RelayConfig => ({ ...loadConfig({}), host: '127.0.0.1', port: 0, ...over });

/** One raw request (fetch would normalize the path before sending it). */
function raw(port: number, path: string, method = 'GET'): Promise<{ status: number; location: string | undefined; cache: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, cache: res.headers['cache-control'] }));
    });
    req.on('error', reject);
    req.end();
  });
}

for (const withMobile of [false, true]) {
  test(`with STATIC_V3_DIR${withMobile ? ' and STATIC_DIR' : ''}: the root and every /mobile address go to /v3/`, async () => {
    const relay = await startRelay(config({ staticV3Dir: fakeV3Dist(), ...(withMobile ? { staticDir: fakeMobileDist() } : {}) }));
    try {
      for (const path of ['/', '/mobile', '/mobile/', '/mobile/index.html', '/mobile/chat.html', '/mobile/manifest.webmanifest', '/v3']) {
        for (const method of ['GET', 'HEAD']) {
          const answer = await raw(relay.port, path, method);
          assert.equal(answer.status, 302, `${method} ${path}`);
          assert.equal(answer.location, '/v3/', `${method} ${path}`);
          // A temporary redirect that is never cached: the relay can be rolled back without phones keeping the old hop.
          assert.equal(answer.cache, 'no-store', `${method} ${path}`);
        }
      }
      // The page itself, its worker and its manifest still answer at /v3/ (the scope a Home Screen app keeps).
      const base = `http://127.0.0.1:${relay.port}`;
      const page = await fetch(`${base}/v3/`);
      assert.equal(page.status, 200);
      assert.equal(await page.text(), '<!doctype html><title>Botling 3</title>');
      assert.equal((await fetch(`${base}/v3/sw.js`)).status, 200);
      const manifest = await fetch(`${base}/v3/manifest.webmanifest`);
      assert.equal(manifest.status, 200);
      assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
      assert.deepEqual(await manifest.json(), { id: '/v3/', start_url: '/v3/', scope: '/v3/' });
    } finally {
      await relay.close();
    }
  });
}

test('the redirect keeps the query (?via=relay) and nothing else; the fragment never reaches the relay', async () => {
  const relay = await startRelay(config({ staticV3Dir: fakeV3Dist() }));
  try {
    assert.equal((await raw(relay.port, '/?via=relay')).location, '/v3/?via=relay');
    assert.equal((await raw(relay.port, '/mobile/?via=tailnet')).location, '/v3/?via=tailnet');
    // Only the query is carried: a crafted path never becomes part of the target.
    assert.equal((await raw(relay.port, '/mobile//evil.example/x')).location, '/v3/');
    assert.equal((await raw(relay.port, '/?a=%0d%0aSet-Cookie:x')).location, '/v3/?a=%0d%0aSet-Cookie:x');
  } finally {
    await relay.close();
  }
});

test('/mobiles and other paths that only start like /mobile are not redirected', async () => {
  const relay = await startRelay(config({ staticV3Dir: fakeV3Dist() }));
  try {
    assert.equal((await raw(relay.port, '/mobiles')).status, 404);
    assert.equal((await raw(relay.port, '/mobile.html')).status, 404);
    assert.equal((await raw(relay.port, '/nothing')).status, 404);
    assert.equal((await raw(relay.port, '/healthz')).status, 200);
  } finally {
    await relay.close();
  }
});

test('without STATIC_V3_DIR the 2.x phone page keeps the root (unchanged 2.x relay)', async () => {
  const relay = await startRelay(config({ staticDir: fakeMobileDist() }));
  try {
    const root = await raw(relay.port, '/');
    assert.equal(root.status, 302);
    assert.equal(root.location, '/mobile/');
    assert.equal((await raw(relay.port, '/mobile/')).status, 200);
    assert.equal((await raw(relay.port, '/v3/')).status, 404);
  } finally {
    await relay.close();
  }
});
