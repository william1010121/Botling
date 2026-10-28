import { generateKeyPairSync, sign } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { AccessAuth, type AccessAccount } from './access';
import { MAIN_BOT_ID } from '../core/store/records';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { issuer: 'https://fixture.cloudflareaccess.com', audience: 'a'.repeat(64), accountsFile: '/unused' };
const instant = 1_800_000_000_000;
const account: AccessAccount = { id: 'owner', email: 'owner@example.invalid', botIds: [MAIN_BOT_ID], expiresAt: instant + 7200_000 };
function token(changes: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const parts = [JSON.stringify({ alg: 'RS256', kid: 'fixture', ...header }), JSON.stringify({ iss: config.issuer, aud: [config.audience],
    sub: 'owner-sub', email: account.email, type: 'app', iat: instant / 1000 - 1, exp: instant / 1000 + 3600, ...changes })].map(s => Buffer.from(s).toString('base64url'));
  return `${parts.join('.')}.${sign('RSA-SHA256', Buffer.from(parts.join('.')), pair.privateKey).toString('base64url')}`;
}
const request = (jwt = token(), headers = {}) => ({ headers: { 'cf-access-jwt-assertion': jwt, ...headers } }) as IncomingMessage;
function fixture() {
  let now = instant; let accounts = [account];
  const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' }] })));
  const auth = new AccessAuth(config, () => accounts, fetcher as typeof fetch, () => now);
  return { auth, fetcher, advance: (ms: number) => { now += ms; }, revoke: () => { accounts = []; } };
}
describe('Access identity and browser session', () => {
  it('checks the signature and configured issuer/audience, grants only Main, and caches only pinned JWKS', async () => {
    const { auth, fetcher } = fixture(); const req = request(); const identity = await auth.identity(req);
    expect(identity.account.botIds).toEqual([MAIN_BOT_ID]);
    await auth.identity(req); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`${config.issuer}/cdn-cgi/access/certs`);
    const session = auth.bootstrap(req, identity);
    expect(session.cookie).toContain('Secure; HttpOnly; SameSite=Strict');
    expect(() => auth.authorize(request(token(), { cookie: session.cookie.split(';')[0], 'x-botling-csrf': session.body.csrf }), identity)).not.toThrow();
  });
  it.each([{ iss: 'https://other.cloudflareaccess.com' }, { aud: ['wrong'] }, { exp: instant / 1000 }, { nbf: instant / 1000 + 1 },
    { iat: instant / 1000 + 31 }, { type: 'service' }, { sub: '' }, { email: undefined }])('rejects invalid identity claims %j', async claims => {
    await expect(fixture().auth.identity(request(token(claims)))).rejects.toMatchObject({ status: 401 });
  });
  it('rejects unknown accounts, forged signatures, unsupported algorithms and unsigned email headers', async () => {
    const { auth } = fixture();
    await expect(auth.identity(request(token({ email: 'stranger@example.invalid' })))).rejects.toMatchObject({ status: 403 });
    const signed = token(); const parts = signed.split('.'); parts[1] = Buffer.from(JSON.stringify({ email: account.email })).toString('base64url');
    await expect(auth.identity(request(parts.join('.')))).rejects.toMatchObject({ status: 401 });
    await expect(auth.identity(request(token({}, { alg: 'HS256' })))).rejects.toMatchObject({ status: 401 });
    await expect(auth.identity(request('', { 'cf-access-authenticated-user-email': account.email }))).rejects.toMatchObject({ status: 401 });
  });
  it('fails closed on JWKS outage, stale keys and account revocation', async () => {
    const { auth, fetcher, advance, revoke } = fixture(); await auth.identity(request());
    advance(301000); fetcher.mockRejectedValue(new Error('unavailable'));
    await expect(auth.identity(request())).rejects.toMatchObject({ status: 503 });
    const second = fixture(); await second.auth.identity(request()); second.revoke();
    await expect(second.auth.identity(request())).rejects.toMatchObject({ status: 403 });
    revoke();
  });
  it('requires session plus CSRF, expires sessions, and rejects logout/session/assertion replay', async () => {
    const { auth, advance } = fixture(); const req = request(); const identity = await auth.identity(req);
    const session = auth.bootstrap(req, identity); const headers = { cookie: session.cookie.split(';')[0], 'x-botling-csrf': session.body.csrf };
    expect(() => auth.authorize(request(), identity)).toThrow();
    expect(() => auth.authorize(request(token(), { ...headers, 'x-botling-csrf': 'wrong' }), identity)).toThrow();
    expect(auth.logout(request(token(), headers), identity)).toContain('Max-Age=0');
    expect(() => auth.authorize(request(token(), headers), identity)).toThrow();
    await expect(auth.identity(req)).rejects.toMatchObject({ status: 401 });
    const second = fixture(); const otherIdentity = await second.auth.identity(req); const otherSession = second.auth.bootstrap(req, otherIdentity);
    second.advance(3600_000);
    expect(() => second.auth.authorize(request(token(), { cookie: otherSession.cookie.split(';')[0], 'x-botling-csrf': otherSession.body.csrf }), otherIdentity)).toThrow();
    advance(3600_000); await expect(auth.identity(req)).rejects.toMatchObject({ status: 401 });
  });
});
