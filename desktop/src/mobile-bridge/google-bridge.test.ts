import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { fixture, origin } from './google-fixture';
import { CALLBACK } from './google';
import { handler, tokenHash } from './bridge';
import { MutationLedger } from './ledger';
import { MAIN_BOT_ID } from '../core/store/records';
import { okResponse } from '../contract';

it('enforces OAuth login, origin, session, CSRF and Main grants; preserves independent bearer ACL and mutation replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-access-'));
  writeFileSync(join(dir, 'index.html'), '{}');
  const f = fixture(), token = 'b'.repeat(43), now = Date.now();
  let dispatched = 0;
  const handle = handler({ origin, host: '127.0.0.1', port: 1, tls: {}, assets: dir, google: f.auth,
    clients: () => [{ id: 'automation', tokenHash: tokenHash(token), botIds: [MAIN_BOT_ID], expiresAt: now + 7200000 }],
    ledger: new MutationLedger(join(dir, 'ledger')), core: { mobileCommand: async raw => {
      dispatched++; return okResponse((raw as { id: string }).id, { messageId: 'm', turnId: null });
    } } });
  const server = createServer((req, res) => { void handle(req, res); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const call = (path: string, headers: Record<string, string> = {}, body?: unknown, method = 'POST') => new Promise<{ status: number; body: any; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers: { Host: 'mobile.example.invalid', Origin: origin,
      'x-botling-session': '1', 'Content-Type': 'application/json', ...headers } }, res => {
      let data = ''; res.on('data', value => { data += value; }); res.on('end', () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : null, headers: res.headers }));
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const command = (id = 'mutation', botId = MAIN_BOT_ID) => ({ v: 10, id, cmd: { type: 'chat.send', botId, text: 'fixture only' } });
  try {
    expect((await call('/api/mobile/session', { 'cf-access-jwt-assertion': '' })).body).toEqual({ error: { code: 'auth_required' } });
    expect((await call('/api/mobile/session', { Origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await call('/api/mobile/session', { 'x-botling-session': '' })).status).toBe(403);
    const login = await call('/api/mobile/login', { 'sec-fetch-site': 'cross-site' }, undefined, 'GET');
    expect(login.status).toBe(303);
    const flow = f.prepare(login.headers.location!, login.headers['set-cookie']![0]);
    const callback = await call(CALLBACK + '?' + flow.params, { cookie: flow.req.headers.cookie!, Origin: '', 'sec-fetch-site': 'cross-site' }, undefined, 'GET');
    expect(callback.status).toBe(303); expect(callback.headers.location).toBe('/mobile/');
    const cookie = callback.headers['set-cookie']![0].split(';')[0];
    const session = await call('/api/mobile/session', { cookie }); expect(session.status).toBe(200);
    const browser = { cookie, 'x-botling-csrf': session.body.csrf };
    expect((await call('/api/mobile/browser/command', {}, command())).status).toBe(401);
    expect((await call('/api/mobile/browser/command', { ...browser, 'x-botling-csrf': 'wrong' }, command())).status).toBe(403);
    expect((await call('/api/mobile/browser/command', { ...browser, Origin: '' }, command())).status).toBe(403);
    expect((await call('/api/mobile/browser/command', browser, command('forbidden', 'ungranted'))).status).toBe(403);
    expect(dispatched).toBe(0);
    expect((await call('/api/mobile/browser/command', browser, command())).status).toBe(200);
    expect((await call('/api/mobile/browser/command', browser, command())).status).toBe(200); expect(dispatched).toBe(1);
    expect((await call('/api/mobile/command', { Authorization: 'Bearer ' + 'x'.repeat(43) }, command('bearer'))).status).toBe(401);
    expect((await call('/api/mobile/command', {}, command('bearer'))).status).toBe(401);
    expect((await call('/api/mobile/command', { Authorization: `Bearer ${token}` }, command('bearer', 'ungranted'))).status).toBe(403);
    expect((await call('/api/mobile/command', { Authorization: `Bearer ${token}` }, command('bearer'))).status).toBe(200); expect(dispatched).toBe(2);
    expect((await call('/api/mobile/logout', { ...browser, 'x-botling-csrf': '' })).status).toBe(403);
    expect((await call('/api/mobile/logout', browser)).status).toBe(200);
    expect((await call('/api/mobile/browser/command', browser, command('after-logout'))).status).toBe(401);
    expect((await call('/api/mobile/session', { cookie })).status).toBe(401);
    const replay = await call(CALLBACK + '?' + flow.params, { cookie: flow.req.headers.cookie! }, undefined, 'GET');
    expect(replay.status).toBe(303); expect(replay.headers.location).toBe('/mobile/?auth_error=auth_required');
    expect(replay.headers['cache-control']).toBe('no-store');
    const returnedPage = await call(replay.headers.location!, { Origin: '', 'sec-fetch-site': 'cross-site' }, undefined, 'GET');
    expect(returnedPage.status).toBe(200); expect(returnedPage.headers['content-type']).toContain('text/html');
    expect((await call('/mobile/', { Origin: '', 'sec-fetch-site': 'cross-site' }, undefined, 'GET')).status).toBe(200);
    expect((await call('/api/mobile/session', { cookie, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    const canceled = await call('/api/mobile/login', {}, undefined, 'GET');
    const cancellation = f.prepare(canceled.headers.location!, canceled.headers['set-cookie']![0]);
    const error = await call(CALLBACK + '?error=access_denied&state=' + cancellation.params.get('state'), { cookie: cancellation.req.headers.cookie! }, undefined, 'GET');
    expect(error.headers.location).toBe('/mobile/?auth_error=auth_required');
    f.advance(3600000); expect((await call('/api/mobile/session')).status).toBe(401); expect(dispatched).toBe(2);
  } finally { server.close(); await once(server, 'close'); rmSync(dir, { recursive: true, force: true }); }
});
