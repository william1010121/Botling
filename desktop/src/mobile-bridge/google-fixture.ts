// Synthetic OAuth provider for focused tests; no production credentials or network.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { vi } from 'vitest';
import { GoogleAuth, CALLBACK } from './google';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const instant = 1_800_000_000_000;
export const origin = 'https://mobile.example.invalid';
export const credentials = { client_id: 'fixture-client', client_secret: 'fixture-secret', project_id: 'fixture',
  redirect_uri: origin + CALLBACK, javascript_origin: origin, allowed_emails: ['owner@example.invalid'] as [string] };
export const request = (headers: Record<string, string> = {}) => ({ headers }) as IncomingMessage;
export function fixture() {
  let now = instant, allowed = credentials.allowed_emails;
  let claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, corrupt = false;
  let keyFailure = false, tokenFailure = false;
  let tokenGate: Promise<void> | undefined;
  const flows = new Map<string, { nonce: string; challenge: string }>();
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
      if (keyFailure) throw Error('fixture outage');
      return new Response(JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' }] }));
    }
    if (url !== 'https://oauth2.googleapis.com/token') throw Error('unexpected endpoint');
    if (tokenFailure) return new Response('{}', { status: 400 });
    if (tokenGate) await tokenGate;
    const body = new URLSearchParams(init!.body as URLSearchParams), flow = flows.get(body.get('code')!);
    if (!flow || body.get('client_id') !== credentials.client_id || body.get('client_secret') !== credentials.client_secret
      || body.get('redirect_uri') !== credentials.redirect_uri || body.get('grant_type') !== 'authorization_code'
      || createHash('sha256').update(body.get('code_verifier')!).digest('base64url') !== flow.challenge) return new Response('{}', { status: 400 });
    flows.delete(body.get('code')!);
    const parts = [JSON.stringify({ alg: 'RS256', kid: 'fixture', ...header }), JSON.stringify({ iss: 'https://accounts.google.com', aud: credentials.client_id,
      sub: 'owner-sub', email: credentials.allowed_emails[0], email_verified: true, nonce: flow.nonce,
      iat: Math.floor(now / 1000) - 1, exp: Math.floor(now / 1000) + 3600, ...claims })].map(s => Buffer.from(s).toString('base64url'));
    const signature = sign('RSA-SHA256', Buffer.from(parts.join('.')), pair.privateKey); if (corrupt) signature[0] ^= 1;
    return new Response(JSON.stringify({ id_token: `${parts.join('.')}.${signature.toString('base64url')}` }));
  });
  const auth = new GoogleAuth(origin, () => ({ ...credentials, allowed_emails: allowed }), fetcher as typeof fetch, () => now);
  const prepare = (location: string, cookie: string) => {
    const url = new URL(location), code = url.searchParams.get('state')!;
    flows.set(code, { nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')! });
    return { req: request({ cookie: cookie.split(';')[0] }), params: new URLSearchParams({ state: code, code }), url };
  };
  const start = () => { const begin = auth.begin(request()); return { ...prepare(begin.location, begin.cookie), begin }; };
  const login = async () => {
    const flow = start(), cookie = await auth.callback(flow.req, flow.params), req = request({ cookie: cookie.split(';')[0] });
    const body = auth.bootstrap(req); return { cookie, body, req: request({ ...req.headers as Record<string, string>, 'x-botling-csrf': body.csrf }) };
  };
  return { auth, fetcher, start, prepare, login, advance: (ms: number) => { now += ms; }, revoke: () => { allowed = ['other@example.invalid']; },
    claims: (value: Record<string, unknown>) => { claims = value; }, header: (value: Record<string, unknown>) => { header = value; },
    gate: (wait: Promise<void>) => { tokenGate = wait; },
    corrupt: () => { corrupt = true; }, keyFailure: () => { keyFailure = true; }, tokenFailure: () => { tokenFailure = true; } };
}
