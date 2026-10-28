import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { AccessAuth } from './access';
import { handler, tokenHash } from './bridge';
import { MutationLedger } from './ledger';
import { MAIN_BOT_ID } from '../core/store/records';
import { okResponse } from '../contract';

it('enforces origin, Access, session, CSRF and Main grants; keeps bearer double authentication and mutation replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-access-'));
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = 'https://fixture.cloudflareaccess.com', audience = 'a'.repeat(64), origin = 'https://mobile.example.invalid';
  const now = Date.now(); let clock = now; const token = 'b'.repeat(43);
  const payload = [JSON.stringify({ alg: 'RS256', kid: 'key' }), JSON.stringify({ iss: issuer, aud: [audience],
    type: 'app', sub: 'owner', email: 'owner@example.invalid', iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600 })].map(v => Buffer.from(v).toString('base64url')).join('.');
  const assertion = `${payload}.${sign('RSA-SHA256', Buffer.from(payload), pair.privateKey).toString('base64url')}`;
  const access = new AccessAuth({ issuer, audience, accountsFile: '/unused' }, () => [{ id: 'owner', email: 'owner@example.invalid', botIds: [MAIN_BOT_ID], expiresAt: now + 7200000 }],
    (async () => new Response(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'key' }] }))) as typeof fetch, () => clock);
  let dispatched = 0;
  const handle = handler({ origin, host: '127.0.0.1', port: 1, tls: {}, assets: dir, access,
    clients: () => [{ id: 'automation', tokenHash: tokenHash(token), botIds: [MAIN_BOT_ID, 'ungranted'], expiresAt: now + 7200000 }],
    ledger: new MutationLedger(join(dir, 'ledger')), core: { mobileCommand: async raw => {
      dispatched++; return okResponse((raw as { id: string }).id, { messageId: 'm', turnId: null });
    } } });
  const server = createServer((req, res) => { void handle(req, res); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const call = (path: string, headers: Record<string, string> = {}, body?: unknown, method = 'POST') => new Promise<{ status: number; body: any; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { Host: 'mobile.example.invalid', Origin: origin,
      'cf-access-jwt-assertion': assertion, 'x-botling-session': '1', 'Content-Type': 'application/json', ...headers } }, res => {
      let data = ''; res.on('data', value => { data += value; }); res.on('end', () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : null, headers: res.headers }));
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const command = (id = 'mutation', botId = MAIN_BOT_ID) => ({ v: 10, id, cmd: { type: 'chat.send', botId, text: 'fixture only' } });
  try {
    expect((await call('/api/mobile/session', { 'cf-access-jwt-assertion': '' })).body).toEqual({ error: { code: 'auth_required' } });
    expect((await call('/api/mobile/session', { Origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await call('/api/mobile/session', { 'x-botling-session': '' })).status).toBe(403);
    const login = await call('/api/mobile/login', { 'sec-fetch-site': 'cross-site' }, undefined, 'GET');
    expect(login.status).toBe(303); expect(login.headers.location).toBe('/mobile/');
    const session = await call('/api/mobile/session'); expect(session.status).toBe(200);
    const browser = { cookie: session.headers['set-cookie']![0].split(';')[0], 'x-botling-csrf': session.body.csrf };
    expect((await call('/api/mobile/browser/command', {}, command())).status).toBe(401);
    expect((await call('/api/mobile/browser/command', { ...browser, 'x-botling-csrf': 'wrong' }, command())).status).toBe(403);
    expect((await call('/api/mobile/browser/command', { ...browser, Origin: '' }, command())).status).toBe(403);
    expect((await call('/api/mobile/browser/command', browser, command('forbidden', 'ungranted'))).status).toBe(403);
    expect(dispatched).toBe(0);
    expect((await call('/api/mobile/browser/command', browser, command())).status).toBe(200);
    expect((await call('/api/mobile/browser/command', browser, command())).status).toBe(200); expect(dispatched).toBe(1);
    expect((await call('/api/mobile/command', { Authorization: `Bearer ${token}`, 'cf-access-jwt-assertion': '' }, command('bearer'))).status).toBe(401);
    expect((await call('/api/mobile/command', {}, command('bearer'))).status).toBe(401);
    expect((await call('/api/mobile/command', { Authorization: `Bearer ${token}` }, command('bearer', 'ungranted'))).status).toBe(403);
    expect((await call('/api/mobile/command', { Authorization: `Bearer ${token}` }, command('bearer'))).status).toBe(200); expect(dispatched).toBe(2);
    expect((await call('/api/mobile/logout', { ...browser, 'x-botling-csrf': '' })).status).toBe(403);
    expect((await call('/api/mobile/logout', browser)).status).toBe(200);
    expect((await call('/api/mobile/browser/command', browser, command('after-logout'))).status).toBe(401);
    expect((await call('/api/mobile/session')).status).toBe(401);
    clock += 3600000; expect((await call('/api/mobile/session')).status).toBe(401); expect(dispatched).toBe(2);
  } finally { server.close(); await once(server, 'close'); rmSync(dir, { recursive: true, force: true }); }
});
