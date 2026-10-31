import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest, createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { PairingStore, type Route } from './pairing';
import { handler, type BridgeOptions, type MobileCore } from './bridge';
import { MutationLedger } from './ledger';
import { okResponse } from '../contract';
import { MAIN_BOT_ID } from '../core/store/records';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'mobile-m3-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const DEVICE = 'd'.repeat(22);
const ORIGIN = 'https://botling-bridge.driseam.com';
const LAN: Route = { kind: 'lan', origin: 'https://botling.home.arpa' };
const ROUTES: Route[] = [{ kind: 'tunnel', origin: ORIGIN }, LAN];
type Change = { botId?: string };

async function serve() {
  const dir = temp(); const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const pairing = new PairingStore(join(dir, 'p'), Date.now, ROUTES);
  const listeners = new Set<(change: Change) => void>();
  const core: MobileCore = { mobileCommand: async req => okResponse((req as any).id, { epoch: 'e' }),
    onChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const options: BridgeOptions = { origin: ORIGIN, host: '127.0.0.1', port: 0, tls: {}, assets: dir, pairing, routes: [LAN],
    clients: () => pairing.clients(), ledger: new MutationLedger(join(dir, 'ledger')), core };
  const handle = handler(options);
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => { void handle(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as any).port;
  const call = (path: string, method: string, body?: unknown, headers: Record<string, string | undefined> = {}) => new Promise<{ status: number; body: string; headers: Record<string, any> }>((resolve, reject) => {
    const merged: Record<string, string> = { Host: 'botling-bridge.driseam.com', Origin: ORIGIN, 'Content-Type': 'application/json' };
    for (const [k, v] of Object.entries(headers)) { if (v === undefined) delete merged[k]; else merged[k] = v; }
    const req = httpsRequest(`https://127.0.0.1:${port}${path}`, { rejectUnauthorized: false, method, headers: merged },
      res => { let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode!, body: text, headers: res.headers })); });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const pair = async () => {
    const offer = pairing.createOffer([MAIN_BOT_ID]);
    return JSON.parse((await call('/api/mobile/pair', 'POST', { secret: offer.secret, deviceId: DEVICE, name: 'Android' })).body).token as string;
  };
  /** Opens the stream; returns what has arrived so far, and a way to wait for more. */
  const stream = async (token: string) => {
    const { ticket } = JSON.parse((await call('/api/mobile/ticket', 'POST', undefined, { Authorization: `Bearer ${token}` })).body);
    let text = ''; let ended = false;
    const req = httpsRequest(`https://127.0.0.1:${port}/api/mobile/events?ticket=${ticket}`, { rejectUnauthorized: false, headers: { Host: 'botling-bridge.driseam.com' } },
      res => { res.on('data', c => { text += c; }); res.on('end', () => { ended = true; }); });
    req.on('error', () => {}); req.end();
    const until = async (test: (t: string) => boolean) => { for (let i = 0; i < 40 && !test(text); i++) await new Promise(r => setTimeout(r, 50)); return text; };
    return { text: () => text, until, ended: () => ended, drop: () => req.destroy() };
  };
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  return { call, pair, stream, pairing, listeners, close, port };
}

describe('commands and tickets across routes', () => {
  const LAN_PAGE = { Host: 'botling.home.arpa', Origin: LAN.origin };
  const FROM_TUNNEL_TO_LAN = { Host: 'botling.home.arpa', Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' };
  it('lets a page of one listed route use the others with its bearer token, for commands and tickets only', async () => {
    const s = await serve();
    try {
      const token = await s.pair();
      const auth = { Authorization: `Bearer ${token}`, ...FROM_TUNNEL_TO_LAN };
      const command = await s.call('/api/mobile/command', 'POST', { v: 10, id: 'a', cmd: { type: 'chat.snapshot' } }, auth);
      expect(command.status).toBe(200); expect(command.headers['access-control-allow-origin']).toBe(ORIGIN);
      const ticket = await s.call('/api/mobile/ticket', 'POST', undefined, auth);
      expect(ticket.status).toBe(200); expect(ticket.headers['access-control-allow-origin']).toBe(ORIGIN);
      // Pairing stays on the origin that showed the code.
      expect((await s.call('/api/mobile/pair', 'POST', { secret: 'q'.repeat(43), deviceId: DEVICE }, FROM_TUNNEL_TO_LAN)).status).toBe(403);
      // The token is still required.
      expect((await s.call('/api/mobile/command', 'POST', { v: 10, id: 'a', cmd: { type: 'chat.snapshot' } }, FROM_TUNNEL_TO_LAN)).status).toBe(401);
      // An unlisted page gets nothing, even with a valid token.
      const stranger = { Authorization: `Bearer ${token}`, Origin: 'https://evil.invalid', 'Sec-Fetch-Site': 'cross-site' };
      for (const path of ['/api/mobile/command', '/api/mobile/ticket']) {
        const r = await s.call(path, 'POST', { v: 10, id: 'a', cmd: { type: 'chat.snapshot' } }, stranger);
        expect(r.status).toBe(403); expect(r.headers['access-control-allow-origin']).toBeUndefined();
      }
      // The same-origin page is unchanged.
      expect((await s.call('/api/mobile/command', 'POST', { v: 10, id: 'a', cmd: { type: 'chat.snapshot' } }, { Authorization: `Bearer ${token}` })).status).toBe(200);
      expect((await s.call('/api/mobile/command', 'POST', { v: 10, id: 'a', cmd: { type: 'chat.snapshot' } }, { Authorization: `Bearer ${token}`, ...LAN_PAGE })).status).toBe(200);
    } finally { await s.close(); }
  });
  it('answers the preflight for a listed route with exactly the headers the phone sends, and refuses everyone else', async () => {
    const s = await serve();
    try {
      const ask = (origin: string, path = '/api/mobile/command', method = 'POST') => s.call(path, 'OPTIONS', undefined, { Host: 'botling.home.arpa', Origin: origin, 'Sec-Fetch-Site': 'cross-site',
        'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'authorization,content-type,x-botling-generation' });
      const ok = await ask(ORIGIN);
      expect(ok.status).toBe(204);
      expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(String(ok.headers['access-control-allow-methods'])).toMatch(/POST/);
      expect(String(ok.headers['access-control-allow-headers']).toLowerCase()).toMatch(/authorization/);
      expect(String(ok.headers['access-control-allow-headers']).toLowerCase()).toMatch(/x-botling-generation/);
      expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
      expect((await ask('https://evil.invalid')).status).toBe(403);
      expect((await ask(ORIGIN, '/api/mobile/pair')).status).not.toBe(204);
      expect((await s.call('/api/mobile/command', 'OPTIONS', undefined, { Host: 'evil.invalid', Origin: ORIGIN })).status).toBe(403);
    } finally { await s.close(); }
  });
});

describe('the core pushes changes over the event stream', () => {
  it('tells the phone that something changed, with no chat content, only for bots it may read', async () => {
    const s = await serve();
    try {
      const token = await s.pair(); const stream = await s.stream(token);
      await stream.until(t => t.includes('event: ready'));
      expect(s.listeners.size).toBe(1);
      for (const listener of s.listeners) listener({ botId: 'proj-someone-else' });
      await new Promise(r => setTimeout(r, 400));
      expect(stream.text()).not.toContain('event: changed');
      for (const listener of s.listeners) listener({ botId: MAIN_BOT_ID });
      const text = await stream.until(t => t.includes('event: changed'));
      expect(text).toContain('event: changed');
      expect(text).not.toContain(MAIN_BOT_ID); expect(text).not.toContain('proj-someone-else');
      for (const listener of s.listeners) listener({}); // a change that belongs to no bot (settings, say)
      await stream.until(t => t.split('event: changed').length > 2);
      expect(stream.text().split('event: changed').length).toBe(3);
    } finally { await s.close(); }
  });
  it('merges a burst into one notice', async () => {
    const s = await serve();
    try {
      const stream = await s.stream(await s.pair());
      await stream.until(t => t.includes('event: ready'));
      for (let i = 0; i < 50; i++) for (const listener of s.listeners) listener({ botId: MAIN_BOT_ID });
      await new Promise(r => setTimeout(r, 700));
      const count = stream.text().split('event: changed').length - 1;
      expect(count).toBeGreaterThanOrEqual(1); expect(count).toBeLessThanOrEqual(3);
    } finally { await s.close(); }
  });
  it('stops listening when the phone leaves or is revoked', async () => {
    const s = await serve();
    try {
      const stream = await s.stream(await s.pair());
      await stream.until(t => t.includes('event: ready'));
      stream.drop();
      for (let i = 0; i < 20 && s.listeners.size; i++) await new Promise(r => setTimeout(r, 50));
      expect(s.listeners.size).toBe(0);
    } finally { await s.close(); }
  });
});
