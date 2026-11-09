// What a QR-paired phone may read. The phone's first request is `chat.snapshot` with no bot; a phone paired with bots
// that did not include Main was refused (403) and its page fell back to "Enter the access token". A pairing code now
// gives every bot by default (the all-bots scope, `*`, which hand-issued tokens still may not hold), and a phone with
// an explicit list opens its first bot instead of Main.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest, createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { PairingStore } from './pairing';
import { ALL_BOTS, Clients, PairedClients, handler, type BridgeOptions } from './bridge';
import { MutationLedger } from './ledger';
import { okResponse } from '../contract';
import { MAIN_BOT_ID } from '../core/store/records';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'mobile-scope-')); dirs.push(dir); return dir; };
const DEVICE = 'd'.repeat(22);

async function bridge() {
  const dir = temp(); const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const pairing = new PairingStore(join(dir, 'p'));
  const seen: { cmd: any; allowed: readonly string[] }[] = [];
  const options: BridgeOptions = { origin: 'https://bridge.example.invalid', host: '127.0.0.1', port: 0, tls: {}, assets: dir, pairing,
    clients: () => PairedClients.parse(pairing.clients()), ledger: new MutationLedger(join(dir, 'ledger')),
    core: { mobileCommand: async (req: any, allowed) => { seen.push({ cmd: req.cmd, allowed }); return okResponse(req.id, { chat: { botId: req.cmd.botId ?? MAIN_BOT_ID } }); } } };
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => { void handler(options)(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as any).port;
  const call = (path: string, body: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = httpsRequest(`https://127.0.0.1:${port}${path}`, { rejectUnauthorized: false, method: 'POST',
      headers: { Host: 'bridge.example.invalid', Origin: options.origin, 'Content-Type': 'application/json', ...headers } },
      res => { let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null })); });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  const pairPhone = async (botIds?: string[]) => {
    const offer = botIds ? pairing.createOffer(botIds) : pairing.createOffer();
    const redeemed = await call('/api/mobile/pair', { secret: offer.secret, deviceId: DEVICE, name: 'iPhone' });
    expect(redeemed.status).toBe(200);
    const token = redeemed.body.token as string;
    return (cmd: unknown, id = 'r1') => call('/api/mobile/command', { v: 10, id, cmd }, { Authorization: `Bearer ${token}` });
  };
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  return { pairing, seen, pairPhone, close };
}

describe('what a paired phone may read', () => {
  it('a phone paired with bots other than Main opens its first bot instead of being refused (the token prompt after scanning)', async () => {
    const b = await bridge();
    try {
      const ask = await b.pairPhone(['3A4963CC-D03A-441B-81AF-CE1DEC4B6C5A', 'E4CC2DB4-8EBF-4C1B-A5E2-4F319416E8E8']);
      // The phone page's first read: a snapshot without a bot.
      const first = await ask({ type: 'chat.snapshot' });
      expect(first.status).toBe(200);
      expect(first.body.result.chat.botId).toBe('3A4963CC-D03A-441B-81AF-CE1DEC4B6C5A');
      // Main itself stays out of reach.
      expect((await ask({ type: 'chat.snapshot', botId: MAIN_BOT_ID }, 'r2')).status).toBe(403);
      expect((await ask({ type: 'chat.send', botId: MAIN_BOT_ID, text: 'no' }, 'r3')).status).toBe(403);
    } finally { await b.close(); }
  });

  it('a pairing code with no bot list gives every bot, including bots added later', async () => {
    const b = await bridge();
    try {
      const ask = await b.pairPhone();
      expect(b.pairing.devices()[0].botIds).toEqual([ALL_BOTS]);
      expect((await ask({ type: 'chat.snapshot' })).status).toBe(200);
      expect(b.seen[0].cmd.botId).toBeUndefined(); // Main, the core's default
      expect(b.seen[0].allowed).toEqual([ALL_BOTS]);
      expect((await ask({ type: 'chat.send', botId: 'a-bot-made-tomorrow', text: 'hi' }, 'r2')).status).toBe(200);
      // Still only the phone's commands.
      expect((await ask({ type: 'chat.read', botId: MAIN_BOT_ID }, 'r3')).status).toBe(403);
    } finally { await b.close(); }
  });

  it('only a QR-paired phone may hold the all-bots scope; a hand-issued token never does', () => {
    const later = Date.now() + 60_000;
    expect(() => Clients.parse([{ id: 'pair-x', tokenHash: 'a'.repeat(64), botIds: [ALL_BOTS], expiresAt: later }])).toThrow();
    expect(() => PairedClients.parse([{ id: 'phone', tokenHash: 'a'.repeat(64), botIds: [ALL_BOTS], expiresAt: later }])).toThrow();
    expect(PairedClients.parse([{ id: 'pair-x', tokenHash: 'a'.repeat(64), botIds: [ALL_BOTS], expiresAt: later }])).toHaveLength(1);
    // A paired-clients file edited by hand to put `*` on a hand-issued id is still refused.
    const dir = temp(); const store = new PairingStore(dir);
    writeFileSync(join(dir, 'paired-clients.json'), JSON.stringify([{ id: 'phone', tokenHash: 'a'.repeat(64), botIds: [ALL_BOTS], expiresAt: later }]), { mode: 0o600 });
    expect(() => PairedClients.parse(store.clients())).toThrow();
  });
});
