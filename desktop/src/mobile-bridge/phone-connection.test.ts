import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest, createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { PairingStore, type Route } from './pairing';
import { handler, type BridgeOptions } from './bridge';
import { MutationLedger } from './ledger';
import { MobileDesk } from './desk';
import { TicketStore } from './tickets';
import { okResponse } from '../contract';
import { MAIN_BOT_ID } from '../core/store/records';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'mobile-m2-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const DEVICE = 'd'.repeat(22), OTHER = 'e'.repeat(22);
const ORIGIN = 'https://botling-bridge.driseam.com';
const LAN: Route = { kind: 'lan', origin: 'https://botling.home.arpa' };
const ROUTES: Route[] = [{ kind: 'tunnel', origin: ORIGIN }, LAN];

describe('desk', () => {
  it('makes a link for the chosen route, lists phones without secrets, and revokes one', () => {
    const pairing = new PairingStore(temp(), Date.now, ROUTES), desk = new MobileDesk(pairing, ROUTES);
    expect(desk.view()).toEqual({ enabled: true, routes: ROUTES, devices: [] });
    const first = desk.pair([MAIN_BOT_ID]);
    expect(first.url.startsWith(`${ORIGIN}/mobile/#pair=`)).toBe(true);
    expect(desk.pair([MAIN_BOT_ID], 1).url.startsWith(`${LAN.origin}/mobile/#pair=`)).toBe(true);
    expect(() => desk.pair([MAIN_BOT_ID], 5)).toThrow();
    expect(() => desk.pair([])).toThrow();
    const secret = new URL(first.url).hash.match(/pair=([^&]+)/)![1];
    const paired = pairing.redeem(secret, DEVICE, 'iPhone <script>') as any;
    const view = desk.view();
    expect(view.devices).toHaveLength(1);
    expect(view.devices[0]).toMatchObject({ id: DEVICE, label: 'iPhone script', botIds: [MAIN_BOT_ID] });
    expect(JSON.stringify(view)).not.toContain(paired.token);
    expect(JSON.stringify(view)).not.toMatch(/tokenHash/);
    expect(desk.revoke(OTHER).devices).toHaveLength(1); // unknown id: nothing happens
    expect(desk.revoke(DEVICE).devices).toEqual([]);
    expect(pairing.clients()).toEqual([]);
  });
});

describe('HTTPS: routes, tickets, event stream', () => {
  async function serve() {
    const dir = temp(); const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    let now = Date.now();
    const pairing = new PairingStore(join(dir, 'p'), () => now, ROUTES);
    const tickets = new TicketStore(() => now);
    const options: BridgeOptions = { origin: ORIGIN, host: '127.0.0.1', port: 0, tls: {}, assets: dir, pairing, routes: [LAN], tickets,
      clients: () => pairing.clients(), ledger: new MutationLedger(join(dir, 'ledger')),
      core: { mobileCommand: async req => okResponse((req as any).id, { epoch: 'e' }) } };
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
    const pair = async (device = DEVICE) => {
      const offer = pairing.createOffer([MAIN_BOT_ID]);
      return JSON.parse((await call('/api/mobile/pair', 'POST', { secret: offer.secret, deviceId: device, name: 'Android' })).body).token as string;
    };
    const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
    return { call, pair, pairing, tickets, close, port, advance: (ms: number) => { now += ms; }, cert: readFileSync(cert) };
  }

  it('lists routes in the descriptor, accepts each route as host, and allows only those origins to probe it', async () => {
    const s = await serve();
    try {
      const core = JSON.parse((await s.call('/api/mobile/core', 'GET', undefined, { Origin: undefined })).body);
      expect(core.routes).toEqual(ROUTES);
      const lanHost = { Host: 'botling.home.arpa', Origin: LAN.origin };
      expect((await s.call('/api/mobile/core', 'GET', undefined, lanHost)).status).toBe(200);
      // A page on the tunnel route probes the LAN route's descriptor: allowed for this core's own origins only.
      const probe = await s.call('/api/mobile/core', 'GET', undefined, { Host: 'botling.home.arpa', Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' });
      expect(probe.status).toBe(200); expect(probe.headers['access-control-allow-origin']).toBe(ORIGIN);
      const stranger = await s.call('/api/mobile/core', 'GET', undefined, { Origin: 'https://evil.invalid', 'Sec-Fetch-Site': 'cross-site' });
      expect(stranger.status).toBe(403); expect(stranger.headers['access-control-allow-origin']).toBeUndefined();
      expect((await s.call('/api/mobile/core', 'GET', undefined, { Host: 'evil.invalid', Origin: undefined })).status).toBe(403);
      // Data stays same-origin: the tunnel page may not use the LAN host for pairing or commands.
      expect((await s.call('/api/mobile/pair', 'POST', { secret: 'q'.repeat(43), deviceId: DEVICE }, { Host: 'botling.home.arpa', 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
      expect((await s.call('/api/mobile/pair', 'POST', { secret: 'q'.repeat(43), deviceId: DEVICE }, { Host: 'botling.home.arpa' })).status).toBe(403);
      expect((await s.call('/api/mobile/pair', 'POST', { secret: 'q'.repeat(43), deviceId: DEVICE }, lanHost)).status).toBe(401);
    } finally { await s.close(); }
  });

  it('issues a ticket only to a signed-in phone, and the stream takes the ticket once', async () => {
    const s = await serve();
    try {
      expect((await s.call('/api/mobile/ticket', 'POST')).status).toBe(401);
      expect((await s.call('/api/mobile/ticket', 'POST', undefined, { Authorization: `Bearer ${'q'.repeat(43)}` })).status).toBe(401);
      expect((await s.call('/api/mobile/ticket', 'GET')).status).toBe(405);
      const token = await s.pair();
      const issued = await s.call('/api/mobile/ticket', 'POST', undefined, { Authorization: `Bearer ${token}` });
      expect(issued.status).toBe(200);
      const { ticket } = JSON.parse(issued.body);
      expect(ticket).not.toBe(token);
      // The stream refuses a bearer token in the URL or header; only a ticket opens it.
      expect((await s.call(`/api/mobile/events?ticket=${token}`, 'GET')).status).toBe(401);
      expect((await s.call('/api/mobile/events', 'GET', undefined, { Authorization: `Bearer ${token}` })).status).toBe(401);
      expect((await s.call(`/api/mobile/events?ticket=${ticket}&token=${token}`, 'GET')).status).toBe(401);
      // That last refusal spent the ticket? No: it never reached redemption.
      const stream = await new Promise<{ status: number; type: string; first: string }>((resolve, reject) => {
        const req = httpsRequest(`https://127.0.0.1:${s.port}/api/mobile/events?ticket=${ticket}`, { rejectUnauthorized: false, headers: { Host: 'botling-bridge.driseam.com' } }, res => {
          res.once('data', c => { resolve({ status: res.statusCode!, type: String(res.headers['content-type']), first: String(c) }); req.destroy(); });
        });
        req.on('error', e => { if ((e as any).code !== 'ECONNRESET') reject(e); }); req.end();
      });
      expect(stream.status).toBe(200); expect(stream.type).toBe('text/event-stream'); expect(stream.first).toContain('event: ready');
      expect((await s.call(`/api/mobile/events?ticket=${ticket}`, 'GET')).status).toBe(401); // single use
    } finally { await s.close(); }
  });

  it('refuses an expired ticket and a ticket of a phone that was revoked since', async () => {
    const s = await serve();
    try {
      const token = await s.pair();
      const ask = async () => JSON.parse((await s.call('/api/mobile/ticket', 'POST', undefined, { Authorization: `Bearer ${token}` })).body).ticket as string;
      const old = await ask();
      s.advance(31_000);
      expect((await s.call(`/api/mobile/events?ticket=${old}`, 'GET')).status).toBe(401);
      const fresh = await ask();
      s.pairing.revoke(DEVICE);
      expect((await s.call(`/api/mobile/events?ticket=${fresh}`, 'GET')).status).toBe(401);
      // And the revoked token itself stops working at once, for tickets and commands.
      expect((await s.call('/api/mobile/ticket', 'POST', undefined, { Authorization: `Bearer ${token}` })).status).toBe(401);
      expect((await s.call('/api/mobile/command', 'POST', { v: 10, id: 'a', cmd: { type: 'chat.snapshot' } }, { Authorization: `Bearer ${token}` })).status).toBe(401);
    } finally { await s.close(); }
  });
});
