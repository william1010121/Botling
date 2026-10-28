import { expect, it } from 'vitest';
import { ALL_BOTS } from './scope';
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
  const body = f.auth.bootstrap(req); expect(body.botIds).toEqual([ALL_BOTS]);
  expect(f.auth.authorize(request({ ...req.headers as Record<string, string>, 'x-botling-csrf': body.csrf })).botIds).toEqual([ALL_BOTS]);
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
it.each(['before callback', 'during exchange'])('rejects sibling-browser login started before principal logout: %s', async timing => {
  const f = fixture(), a = await f.login(), b = await f.login(), flow = f.start();
  const browserB = request({ cookie: flow.req.headers.cookie + '; ' + b.cookie.split(';')[0] });
  let release!: () => void; f.gate(new Promise<void>(resolve => { release = resolve; }));
  const pending = timing === 'during exchange' ? f.auth.callback(browserB, flow.params) : undefined;
  f.auth.logout(a.req);
  expect(() => f.auth.bootstrap(b.req)).toThrow('auth_required');
  release();
  await expect(pending ?? f.auth.callback(browserB, flow.params)).rejects.toMatchObject({ status: 401 });
  const fresh = await f.login(); expect(f.auth.authorize(fresh.req).botIds).toEqual([ALL_BOTS]);
});
it('allows a fresh browser to start and finish despite sustained no-cookie login-start flooding', async () => {
  const f = fixture();
  for (let i = 0; i < 1024; i++) f.auth.begin(request());
  const flow = f.start();
  for (let i = 0; i < 1024; i++) f.auth.begin(request({ 'x-forwarded-for': `untrusted-${i}`, cookie: '__Host-botling-oauth=' + 'x'.repeat(43) }));
  const cookie = await f.auth.callback(flow.req, flow.params);
  expect(f.auth.bootstrap(request({ cookie: cookie.split(';')[0] })).botIds).toEqual([ALL_BOTS]);
  await expect(f.auth.callback(flow.req, flow.params)).rejects.toMatchObject({ status: 401 });
});
it('rejects tampered, duplicate, swapped and pre-restart transaction cookies without token exchange', async () => {
  const f = fixture(), a = f.start(), b = f.start();
  const cookie = a.req.headers.cookie!, parts = cookie.split('='), encrypted = Buffer.from(parts[1], 'base64url');
  encrypted[20] ^= 1;
  await expect(f.auth.callback(request({ cookie: parts[0] + '=' + encrypted.toString('base64url') }), a.params)).rejects.toMatchObject({ status: 401 });
  await expect(f.auth.callback(request({ cookie: cookie + '; ' + cookie }), a.params)).rejects.toMatchObject({ status: 401 });
  await expect(f.auth.callback(b.req, a.params)).rejects.toMatchObject({ status: 401 });
  const restarted = new GoogleAuth(credentials.javascript_origin, () => credentials, f.fetcher as typeof fetch);
  await expect(restarted.callback(a.req, a.params)).rejects.toMatchObject({ status: 401 });
  expect(f.fetcher).not.toHaveBeenCalled();
  const result = await f.auth.callback(a.req, a.params);
  expect(f.auth.bootstrap(request({ cookie: result.split(';')[0] })).botIds).toEqual([ALL_BOTS]);
});
it('never makes an evicted consumed flow replayable and admits fresh login under callback-ledger pressure', async () => {
  const f = fixture(), first = f.start(), pending = f.start();
  first.params.set('error', 'access_denied');
  await expect(f.auth.callback(first.req, first.params)).rejects.toMatchObject({ status: 401 });
  first.params.delete('error');
  for (let i = 0; i < 300; i++) {
    const flow = f.start(); flow.params.set('error', 'access_denied');
    await expect(f.auth.callback(flow.req, flow.params)).rejects.toMatchObject({ status: 401 });
  }
  await expect(f.auth.callback(first.req, first.params)).rejects.toMatchObject({ status: 401 });
  // Pressure sacrifices oldest pending logins instead of accepting old/replayed cookies.
  await expect(f.auth.callback(pending.req, pending.params)).rejects.toMatchObject({ status: 401 });
  expect(f.fetcher).not.toHaveBeenCalled();
  const fresh = await f.login(); expect(f.auth.authorize(fresh.req).botIds).toEqual([ALL_BOTS]);
});
it('bounds concurrent exchanges without blocking login starts or existing sessions, and releases admission on completion', async () => {
  const f = fixture(), session = await f.login();
  let release!: () => void; f.gate(new Promise<void>(resolve => { release = resolve; }));
  const pending = Array.from({ length: 8 }, () => { const flow = f.start(); return f.auth.callback(flow.req, flow.params); });
  const overflow = f.start();
  await expect(f.auth.callback(overflow.req, overflow.params)).rejects.toMatchObject({ status: 503 });
  expect(f.auth.authorize(session.req).botIds).toEqual([ALL_BOTS]);
  const next = f.start(); // Starting another browser's login is still available.
  release(); expect(await Promise.all(pending)).toHaveLength(8);
  const cookie = await f.auth.callback(next.req, next.params);
  expect(f.auth.bootstrap(request({ cookie: cookie.split(';')[0] })).botIds).toEqual([ALL_BOTS]);
  for (let i = 0; i < 9; i++) {
    f.fetcher.mockRejectedValueOnce(new Error('synthetic exchange outage'));
    const failed = f.start();
    await expect(f.auth.callback(failed.req, failed.params)).rejects.toMatchObject({ status: 503 });
  }
  const recovered = await f.login(); expect(f.auth.authorize(recovered.req).botIds).toEqual([ALL_BOTS]);
});
it('starting a replacement login cancels that browser’s prior in-flight exchange', async () => {
  const f = fixture(), flow = f.start();
  let release!: () => void; f.gate(new Promise<void>(resolve => { release = resolve; }));
  const pending = f.auth.callback(flow.req, flow.params);
  const replacement = f.auth.begin(flow.req);
  release(); await expect(pending).rejects.toMatchObject({ status: 401 });
  const next = f.prepare(replacement.location, replacement.cookie);
  const cookie = await f.auth.callback(next.req, next.params);
  expect(f.auth.bootstrap(request({ cookie: cookie.split(';')[0] })).botIds).toEqual([ALL_BOTS]);
});
