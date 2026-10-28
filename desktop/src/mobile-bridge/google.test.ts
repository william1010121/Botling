import { expect, it } from 'vitest';
import { MAIN_BOT_ID } from '../core/store/records';
import { credentials, fixture, instant, request } from './google-fixture';
import { GoogleAuth } from './google';
it('uses code + S256 PKCE + nonce, exact callback and only openid/email; issues an opaque secure session', async () => {
  const f = fixture(), flow = f.start();
  expect(flow.url.origin).toBe('https://accounts.google.com');
  expect(Object.fromEntries(flow.url.searchParams)).toMatchObject({ response_type: 'code', code_challenge_method: 'S256', scope: 'openid email', redirect_uri: credentials.redirect_uri });
  expect(flow.url.searchParams.has('client_secret')).toBe(false);
  expect(flow.begin.cookie).toContain('__Host-botling-oauth='); expect(flow.begin.cookie).toContain('Secure; HttpOnly; SameSite=Lax');
  const cookie = await f.auth.callback(flow.req, flow.params), req = request({ cookie: cookie.split(';')[0] });
  expect(cookie).toContain('__Host-botling-mobile='); expect(cookie).toContain('Secure; HttpOnly; SameSite=Lax');
  const body = f.auth.bootstrap(req); expect(body.botIds).toEqual([MAIN_BOT_ID]);
  expect(f.auth.authorize(request({ ...req.headers as Record<string, string>, 'x-botling-csrf': body.csrf })).botIds).toEqual([MAIN_BOT_ID]);
  await expect(f.auth.callback(flow.req, flow.params)).rejects.toMatchObject({ status: 401 });
  expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual(['https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v3/certs']);
});
it.each([{ iss: 'https://evil.invalid' }, { aud: 'wrong' }, { azp: 'wrong' }, { aud: [credentials.client_id, 'other'] },
  { exp: instant / 1000 }, { nbf: instant / 1000 + 1 }, { iat: instant / 1000 + 31 }, { iat: instant / 1000 + 3600 },
  { nonce: 'wrong' }, { sub: '' }, { email: undefined }, { email_verified: false }, { email_verified: 'true' }])('rejects invalid signed claims %j', async claims => {
  const f = fixture(); f.claims(claims); const flow = f.start();
  await expect(f.auth.callback(flow.req, flow.params)).rejects.toMatchObject({ status: 401 });
});
it.each([{ alg: 'none' }, { alg: 'HS256' }, { kid: 'unknown' }, { jku: 'https://evil.invalid/keys' }])('rejects unsupported/unpinned headers %j', async header => {
  const f = fixture(); f.header(header); const flow = f.start();
  await expect(f.auth.callback(flow.req, flow.params)).rejects.toMatchObject({ status: 401 });
});
it('rejects forged signatures and a verified Google user outside the server allowlist', async () => {
  const f = fixture(); f.corrupt(); let flow = f.start();
  await expect(f.auth.callback(flow.req, flow.params)).rejects.toMatchObject({ status: 401 });
  const other = fixture(); other.claims({ email: 'stranger@example.invalid' }); flow = other.start();
  await expect(other.auth.callback(flow.req, flow.params)).rejects.toMatchObject({ status: 403 });
});
it('binds callback to browser cookie, consumes state on errors and rejects expiry, duplicate state and cancellation', async () => {
  for (const kind of ['cookie', 'state', 'duplicate', 'expired', 'cancel', 'code']) {
    const f = fixture(), flow = f.start();
    if (kind === 'cookie') flow.req = request();
    if (kind === 'state') flow.params.set('state', 'wrong');
    if (kind === 'duplicate') flow.params.append('state', flow.params.get('state')!);
    if (kind === 'expired') f.advance(600000);
    if (kind === 'cancel') flow.params.set('error', 'access_denied');
    if (kind === 'code') flow.params.delete('code');
    await expect(f.auth.callback(flow.req, flow.params)).rejects.toMatchObject({ status: 401 });
    expect(f.fetcher).not.toHaveBeenCalled();
  }
});
it('rejects concurrent callback replay and fails closed on exchange/JWKS failures including stale keys', async () => {
  const f = fixture(), flow = f.start();
  const result = await Promise.allSettled([f.auth.callback(flow.req, flow.params), f.auth.callback(flow.req, flow.params)]);
  expect(result.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
  f.advance(301000); f.keyFailure(); const next = f.start();
  await expect(f.auth.callback(next.req, next.params)).rejects.toMatchObject({ status: 503 });
  const t = fixture(); t.tokenFailure(); const failed = t.start();
  await expect(t.auth.callback(failed.req, failed.params)).rejects.toMatchObject({ status: 401 });
});
it('requires session and CSRF, revokes sibling sessions on logout, rejects fixation/duplicates and expires sessions', async () => {
  const f = fixture(), first = await f.login(), second = await f.login();
  expect(first.cookie).not.toBe(second.cookie);
  expect(() => f.auth.bootstrap(request({ 'cf-access-authenticated-user-email': credentials.allowed_emails[0] }))).toThrow();
  expect(() => f.auth.bootstrap(request({ cookie: '__Host-botling-mobile=' + 'x'.repeat(43) }))).toThrow();
  expect(() => f.auth.bootstrap(request({ cookie: first.cookie.split(';')[0] + '; ' + first.cookie.split(';')[0] }))).toThrow();
  expect(() => f.auth.authorize(request({ cookie: first.cookie.split(';')[0] }))).toThrow();
  expect(() => f.auth.logout(request({ cookie: first.cookie.split(';')[0], 'x-botling-csrf': 'wrong' }))).toThrow();
  expect(f.auth.logout(first.req)).toContain('Max-Age=0');
  expect(() => f.auth.authorize(first.req)).toThrow(); expect(() => f.auth.authorize(second.req)).toThrow();
  const fresh = await f.login(); f.advance(3600000); expect(() => f.auth.authorize(fresh.req)).toThrow();
});
it('checks private allowlist on every session access and fails closed after core restart', async () => {
  const f = fixture(), session = await f.login(); f.revoke();
  expect(() => f.auth.authorize(session.req)).toThrow('access_denied');
  const restarted = new GoogleAuth(credentials.javascript_origin, () => credentials);
  expect(() => restarted.bootstrap(session.req)).toThrow('auth_required');
});
it('rejects off-origin callback configuration and multi-user allowlists', () => {
  expect(() => new GoogleAuth(credentials.javascript_origin, () => ({ ...credentials, redirect_uri: 'https://evil.invalid/callback' }))).toThrow();
  expect(() => new GoogleAuth(credentials.javascript_origin, () => ({ ...credentials, allowed_emails: ['one@example.invalid', 'two@example.invalid'] as any }))).toThrow();
});
it.each(['logout', 'expiry'])('does not resurrect a browser session when %s occurs during code exchange', async kind => {
  const f = fixture(), session = await f.login(), flow = f.start();
  let release!: () => void; f.gate(new Promise<void>(resolve => { release = resolve; }));
  const callbackRequest = request({ cookie: flow.req.headers.cookie + '; ' + session.cookie.split(';')[0] });
  const pending = f.auth.callback(callbackRequest, flow.params);
  if (kind === 'logout') f.auth.logout(request({ ...callbackRequest.headers as Record<string, string>, 'x-botling-csrf': session.body.csrf }));
  else f.advance(600000);
  release(); await expect(pending).rejects.toMatchObject({ status: 401 });
  if (kind === 'logout') expect(() => f.auth.bootstrap(session.req)).toThrow('auth_required');
});
