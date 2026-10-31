import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { PairingStore, PAIR_TTL_MS, pairingURL } from './pairing';
import { handler, authenticate, type BridgeOptions } from './bridge';
import { MutationLedger } from './ledger';
import { okResponse } from '../contract';
import { MAIN_BOT_ID } from '../core/store/records';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'mobile-pair-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const DEVICE = 'd'.repeat(22);

describe('core descriptor', () => {
  it('is stable across restarts, random per core, and carries no secret', () => {
    const dir = temp();
    const id = new PairingStore(dir).coreId();
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(new PairingStore(dir).coreId()).toBe(id);
    expect(new PairingStore(temp()).coreId()).not.toBe(id);
    const d = new PairingStore(dir).descriptor();
    expect(d).toEqual({ app: 'botling', coreId: id, protocol: 10, pairing: { ttlSeconds: 300 } });
  });
});

describe('pairing offers', () => {
  it('redeems once, with a token that authenticates like an issued token (same bot scope, 30 days)', () => {
    const dir = temp(); let now = 1_000_000;
    const store = new PairingStore(dir, () => now);
    const offer = store.createOffer(['bot-a']);
    expect(offer.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(offer.expiresAt).toBe(now + PAIR_TTL_MS);
    const first = store.redeem(offer.secret, DEVICE);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(first.coreId).toBe(store.coreId());
    const clients = store.clients();
    expect(clients).toHaveLength(1);
    expect(clients[0].botIds).toEqual(['bot-a']);
    expect(clients[0].expiresAt).toBe(now + 30 * 86_400_000);
    expect(authenticate({ headers: { authorization: `Bearer ${first.token}` } } as any, clients, now)?.id).toBe(clients[0].id);
    // Single use.
    expect(store.redeem(offer.secret, 'e'.repeat(22))).toEqual({ ok: false, reason: 'invalid' });
  });
  it('expires after five minutes and the same failure is reported for unknown, used and expired', () => {
    let now = 5_000;
    const store = new PairingStore(temp(), () => now);
    const offer = store.createOffer(['bot-a']);
    now += PAIR_TTL_MS;
    expect(store.redeem(offer.secret, DEVICE)).toEqual({ ok: false, reason: 'invalid' });
    expect(store.redeem('z'.repeat(43), DEVICE)).toEqual({ ok: false, reason: 'invalid' });
    expect(store.clients()).toEqual([]);
  });
  it('keeps one session per device: a second pairing revokes the first token', () => {
    const store = new PairingStore(temp());
    const a = store.redeem(store.createOffer(['bot-a']).secret, DEVICE) as any;
    const b = store.redeem(store.createOffer(['bot-a']).secret, DEVICE) as any;
    const clients = store.clients();
    expect(clients).toHaveLength(1);
    expect(authenticate({ headers: { authorization: `Bearer ${a.token}` } } as any, clients)).toBeUndefined();
    expect(authenticate({ headers: { authorization: `Bearer ${b.token}` } } as any, clients)).toBeDefined();
    const other = store.redeem(store.createOffer(['bot-a']).secret, 'f'.repeat(22)) as any;
    expect(store.clients()).toHaveLength(2);
    expect(authenticate({ headers: { authorization: `Bearer ${other.token}` } } as any, store.clients())).toBeDefined();
  });
  it('refuses wildcard or empty bot scope and malformed requests', () => {
    const store = new PairingStore(temp());
    expect(() => store.createOffer([])).toThrow();
    expect(() => store.createOffer(['*'])).toThrow();
    expect(store.redeem('short', DEVICE)).toEqual({ ok: false, reason: 'invalid' });
    expect(store.redeem(store.createOffer(['bot-a']).secret, 'bad id!')).toEqual({ ok: false, reason: 'invalid' });
  });
  it('rate-limits failed attempts, even for a valid secret, until the window passes', () => {
    let now = 0;
    const store = new PairingStore(temp(), () => now);
    const offer = store.createOffer(['bot-a']);
    for (let i = 0; i < 5; i++) expect(store.redeem('z'.repeat(43), DEVICE)).toEqual({ ok: false, reason: 'invalid' });
    expect(store.redeem(offer.secret, DEVICE)).toEqual({ ok: false, reason: 'limited' });
    now += 61_000;
    expect(store.redeem(offer.secret, DEVICE).ok).toBe(true);
  });
  it('stores only hashes, owner-only, and never the secret or token', () => {
    const dir = temp(); const store = new PairingStore(dir);
    const offer = store.createOffer(['bot-a']);
    const paired = store.redeem(store.createOffer(['bot-a']).secret, DEVICE) as any;
    for (const name of readdirSync(dir).filter(n => !n.endsWith('.lock'))) {
      expect(statSync(join(dir, name)).mode & 0o077).toBe(0);
      const text = readFileSync(join(dir, name), 'utf8');
      expect(text).not.toContain(offer.secret); expect(text).not.toContain(paired.token);
    }
  });
  it('limits pending offers', () => {
    const store = new PairingStore(temp());
    for (let i = 0; i < 5; i++) store.createOffer(['bot-a']);
    expect(() => store.createOffer(['bot-a'])).toThrow(/pending/);
  });
  it('puts the secret in the URL fragment only', () => {
    const url = new URL(pairingURL('https://botling.example', 'abc', 'S'.repeat(43)));
    expect(url.search).toBe(''); expect(url.pathname).toBe('/mobile/');
    expect(url.hash).toBe(`#pair=${'S'.repeat(43)}&core=abc`);
  });
});

describe('HTTPS pairing routes', () => {
  it('serves the public descriptor, redeems once, then the token works like any token; failures leak nothing and are limited', async () => {
    const dir = temp(); const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const pairing = new PairingStore(join(dir, 'p'));
    const options: BridgeOptions = { origin: 'https://botling-bridge.driseam.com', host: '127.0.0.1', port: 0, tls: {}, assets: dir, pairing,
      clients: () => pairing.clients(), ledger: new MutationLedger(join(dir, 'ledger')),
      core: { mobileCommand: async req => okResponse((req as any).id, { epoch: 'e' }) } };
    const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => { void handler(options)(req, res); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as any).port;
    const call = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpsRequest(`https://127.0.0.1:${port}${path}`, { rejectUnauthorized: false, method,
        headers: { Host: 'botling-bridge.driseam.com', Origin: options.origin, 'Content-Type': 'application/json', ...headers } },
        res => { let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode!, body: text })); });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    try {
      const core = await call('/api/mobile/core', 'GET', undefined, { Origin: '' });
      expect(core.status).toBe(200);
      expect(JSON.parse(core.body).coreId).toBe(pairing.coreId());
      expect((await call('/api/mobile/core', 'GET', undefined, { Host: 'evil.invalid' })).status).toBe(403);
      const offer = pairing.createOffer([MAIN_BOT_ID]);
      expect((await call('/api/mobile/pair', 'GET')).status).toBe(405);
      const ok = await call('/api/mobile/pair', 'POST', { secret: offer.secret, deviceId: DEVICE });
      expect(ok.status).toBe(200);
      const { token, coreId } = JSON.parse(ok.body);
      expect(coreId).toBe(pairing.coreId());
      const env = { v: 10, id: 'snap-1', cmd: { type: 'chat.snapshot' } };
      expect((await call('/api/mobile/command', 'POST', env, { Authorization: `Bearer ${token}` })).status).toBe(200);
      // Same power as a token session: bots outside its list and commands outside the mobile set stay refused.
      expect((await call('/api/mobile/command', 'POST', { v: 10, id: 'x', cmd: { type: 'chat.send', botId: 'other', text: 'no' } }, { Authorization: `Bearer ${token}` })).status).toBe(403);
      expect((await call('/api/mobile/command', 'POST', { v: 10, id: 'y', cmd: { type: 'chat.read', botId: MAIN_BOT_ID } }, { Authorization: `Bearer ${token}` })).status).toBe(403);
      const reuse = await call('/api/mobile/pair', 'POST', { secret: offer.secret, deviceId: DEVICE });
      expect(reuse.status).toBe(401); expect(reuse.body).not.toContain(token);
      expect((await call('/api/mobile/pair', 'POST', { secret: 'q'.repeat(43), deviceId: DEVICE }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
      expect((await call('/api/mobile/pair', 'POST', { secret: 'q'.repeat(43), deviceId: DEVICE }, { Origin: 'https://evil.invalid' })).status).toBe(403);
      expect((await call('/api/mobile/pair', 'POST', { secret: 'q'.repeat(43), deviceId: DEVICE }, { 'Content-Type': 'text/plain' })).status).toBe(415);
      for (let i = 0; i < 4; i++) await call('/api/mobile/pair', 'POST', { secret: 'q'.repeat(43), deviceId: DEVICE });
      expect((await call('/api/mobile/pair', 'POST', { secret: 'q'.repeat(43), deviceId: DEVICE })).status).toBe(429);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('answers 404 for both routes when pairing is not configured', async () => {
    const dir = temp();
    const options: BridgeOptions = { origin: 'https://b.example', host: '127.0.0.1', port: 0, tls: {}, assets: dir, clients: () => [],
      ledger: new MutationLedger(join(dir, 'l')), core: { mobileCommand: async () => okResponse('x', {}) } };
    const res: any = { setHeader() {}, writeHead(s: number) { this.status = s; }, end() {} };
    const run = async (url: string, method: string) => { await handler(options)({ url, method, headers: { host: 'b.example' } } as any, res); return res.status; };
    expect(await run('/api/mobile/core', 'GET')).toBe(404);
    expect(await run('/api/mobile/pair', 'POST')).toBe(404);
  });
});
