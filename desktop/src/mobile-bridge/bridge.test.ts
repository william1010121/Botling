import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { handler, tokenHash, type BridgeOptions } from './bridge';
import { MutationLedger } from './ledger';
import { mobileCommand } from './adapter';
import { Core } from '../core/server';
import { MAIN_BOT_ID as botId } from '../core/store/records';
import { okResponse, type RequestEnvelope } from '../contract';
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'mobile-bridge-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const envelope = (id = 'send-1', text = 'hello'): RequestEnvelope => ({ v: 10, id, cmd: { type: 'chat.send', botId, text } });
describe('durable mutation dispatch', () => {
  it('replays saved outcomes after reopening and refuses a different command under the same ID', async () => {
    const dir = temp(); let count = 0;
    const dispatch = async () => { count++; return okResponse('send-1', { messageId: 'm', turnId: null }); };
    const first = await new MutationLedger(dir).run('phone', envelope(), dispatch);
    expect(await new MutationLedger(dir).run('phone', envelope(), dispatch)).toEqual(first);
    expect((await new MutationLedger(dir).run('phone', envelope('send-1', 'changed'), dispatch)).ok).toBe(false);
    expect(count).toBe(1);
    await new MutationLedger(dir).run('second-phone', envelope(), dispatch); expect(count).toBe(2);
  });
  it('never dispatches a pending/restarted uncertain mutation again', async () => {
    const dir = temp(); let count = 0;
    await expect(new MutationLedger(dir).run('phone', envelope(), async () => { count++; throw Error('crash'); })).rejects.toThrow();
    expect((await new MutationLedger(dir).run('phone', envelope(), async () => { count++; return okResponse('send-1', {}); })).ok).toBe(false);
    expect(count).toBe(1);
  });
  it('claims before dispatch when duplicate requests overlap and retains declined answers', async () => {
    const ledger = new MutationLedger(temp()); let release!: () => void; let count = 0;
    const gate = new Promise<void>(r => { release = r; });
    const dispatch = async () => { count++; await gate; return okResponse('send-1', { accepted: false }); };
    const first = ledger.run('phone', envelope(), dispatch);
    expect((await ledger.run('phone', envelope(), dispatch)).ok).toBe(false);
    release(); await first;
    expect(await ledger.run('phone', envelope(), dispatch)).toEqual(okResponse('send-1', { accepted: false }));
    expect(count).toBe(1);
  });
});
describe('core adapter', () => {
  it('uses the actual Core hook/handle/send path and never consumes desktop queued files', async () => {
    const core: any = Object.create(Core.prototype);
    let queue: any[] = [{ id: 'desktop', path: '/private/desktop.pdf' }];
    let dispatched = 0;
    core.activated = true;
    core.bots = new Map([[botId, { id: botId }]]);
    core.pending = { views: () => queue, take: () => { const files = queue; queue = []; return files; }, done: () => {}, restore: (_id: string, files: any[]) => { queue.push(...files); } };
    core.sendWith = async (_bot: unknown, _text: string, options: any) => {
      dispatched++; expect(options.files).toEqual([]); await Promise.resolve(); return { messageId: 'm', turnId: null };
    };
    expect((await core.mobileCommand(envelope(), [botId])).ok).toBe(false);
    expect(queue).toHaveLength(1); expect(dispatched).toBe(0);
    queue = [];
    const result = core.mobileCommand(envelope(), [botId]);
    queue.push({ id: 'later', path: '/private/later.pdf' });
    expect(await result).toEqual(okResponse('send-1', { messageId: 'm', turnId: null }));
    expect(queue[0].id).toBe('later'); expect(dispatched).toBe(1);
    core.activated = false;
    queue = [];
    expect((await core.mobileCommand(envelope('blocked'), [botId])).ok).toBe(false);
    expect(dispatched).toBe(1);
  });

  it('checks the live queue and invokes send without yielding, leaving later staged files untouched', async () => {
    let queue: string[] = ['desktop.pdf']; let calls = 0;
    const access = { pending: () => queue, snapshot: () => { throw Error('unused'); }, handle: async () => {
      calls++; const files = queue; queue = []; expect(files).toEqual([]); await Promise.resolve(); return { messageId: 'm', turnId: null };
    } };
    expect((await mobileCommand(access, envelope(), [botId])).ok).toBe(false); expect(queue).toEqual(['desktop.pdf']); expect(calls).toBe(0);
    queue = [];
    const send = mobileCommand(access, envelope(), [botId]); queue.push('staged-after-dispatch.pdf');
    expect((await send).ok).toBe(true); expect(queue).toEqual(['staged-after-dispatch.pdf']); expect(calls).toBe(1);
  });
  it('filters snapshot bot data, keeps unread, omits global fields, and refuses unauthorized bots', async () => {
    let handled = 0;
    const snapshot: any = { epoch: 'e', seq: 1, bots: [{ id: botId, unread: 3 }, { id: 'other', unread: 9 }],
      chat: { botId, messages: [], tasks: [], pendingFiles: [{ id: 'file', name: 'x', path: '/private/x' }] }, settings: { secret: 'private' } };
    const access = { pending: () => [], snapshot: () => snapshot, handle: async () => { handled++; } };
    const response: any = await mobileCommand(access, { v: 10, id: 's', cmd: { type: 'chat.snapshot' } }, [botId]);
    expect(response.result.bots).toHaveLength(1); expect(response.result.bots[0].unread).toBe(3);
    expect(response.result.settings).toBeUndefined(); expect(response.result.chat.pendingFiles[0].path).toBeUndefined(); expect(handled).toBe(0);
    expect((await mobileCommand(access, envelope(), ['other'])).ok).toBe(false);
    expect((await mobileCommand(access, { v: 10, id: 'x', cmd: { type: 'chat.read', botId } }, [botId])).ok).toBe(false);
  });
});
describe('HTTPS contract', () => {
  it('authenticates, scopes, revokes, serves only mobile assets, and replays after a lost socket response', async () => {
    const dir = temp(); const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const { readFileSync } = await import('node:fs');
    const token = 'a'.repeat(43); let clients = [{ id: 'phone', tokenHash: tokenHash(token), botIds: [botId], expiresAt: Date.now() + 60_000 }];
    let calls = 0, drop = false;
    writeFileSync(join(dir, 'index.html'), '<!doctype html><p>mobile</p>');
    const options: BridgeOptions = { origin: '', host: '127.0.0.1', port: 0, tls: {}, assets: dir, clients: () => clients,
      ledger: new MutationLedger(join(dir, 'ledger')), core: { mobileCommand: async req => { calls++; return okResponse((req as any).id, { messageId: 'm', turnId: null }); } } };
    const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      if (drop) { drop = false; const end = res.end.bind(res); res.end = ((..._args: any[]) => { res.destroy(); return res; }) as typeof end; }
      void handler(options)(req, res);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as any).port; options.origin = `https://127.0.0.1:${port}`;
    const call = (body: unknown = envelope(), headers: Record<string, string> = {}, path = '/api/mobile/command', method = 'POST') => new Promise<{ status: number; body: string; headers: any }>((resolve, reject) => {
      const req = httpsRequest(options.origin + path, { rejectUnauthorized: false, method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers } }, res => {
        let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      }); req.on('error', reject); req.end(method === 'POST' ? JSON.stringify(body) : undefined);
    });
    try {
      expect((await call(envelope(), { Authorization: '' })).status).toBe(401);
      expect((await call(envelope(), { Origin: 'https://evil.invalid' })).status).toBe(403);
      expect((await call(envelope(), { Host: 'evil.invalid' })).status).toBe(403);
      expect((await call({ v: 10, id: 'x', cmd: { type: 'chat.read', botId } })).status).toBe(403);
      expect((await call({ v: 10, id: 'x', cmd: { type: 'chat.send', botId: 'other', text: 'no' } })).status).toBe(403);
      expect((await call({ ...envelope(), v: 9 })).status).toBe(400);
      expect((await call(null, {}, '/mobile/../key.pem', 'GET')).status).toBe(404);
      const page = await call(null, {}, '/mobile/', 'GET'); expect(page.status).toBe(200); expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      drop = true; await expect(call()).rejects.toThrow();
      options.ledger = new MutationLedger(join(dir, 'ledger'));
      const replay = await call(); expect(replay.status).toBe(200); expect(JSON.parse(replay.body)).toEqual(okResponse('send-1', { messageId: 'm', turnId: null }));
      expect(replay.headers['cache-control']).toBe('no-store'); expect(calls).toBe(1);
      clients = []; expect((await call()).status).toBe(401); expect(calls).toBe(1);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
