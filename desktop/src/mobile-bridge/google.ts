/** App-owned Google OIDC. No Cloudflare Access headers participate in authorization. */
import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { MAIN_BOT_ID } from '../core/store/records';
export const CALLBACK = '/api/mobile/auth/google/callback';
export const GoogleConfig = z.strictObject({ credentialsFile: z.string().min(1) });
// The private server allowlist is independent of Google's consent-screen Testing users.
export const GoogleCredentials = z.object({
  client_id: z.string().min(1), client_secret: z.string().min(1), project_id: z.string().min(1),
  redirect_uri: z.string().url(), javascript_origin: z.string().url(),
  allowed_emails: z.tuple([z.email().refine(s => s === s.toLowerCase())]),
});
export type Credentials = z.infer<typeof GoogleCredentials>;
export class GoogleAuthError extends Error {
  constructor(public status: 401 | 403 | 503, public code: 'auth_required' | 'access_denied' | 'auth_unavailable') { super(code); }
}
const deny = () => new GoogleAuthError(401, 'auth_required');
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const nonce = () => randomBytes(32).toString('base64url');
const COOKIE = '__Host-botling-mobile', FLOW = '__Host-botling-oauth';
const attributes = '; Path=/; Secure; HttpOnly; SameSite=Lax';
const Claims = z.object({ iss: z.enum(['https://accounts.google.com', 'accounts.google.com']),
  aud: z.union([z.string(), z.array(z.string()).min(1)]), azp: z.string().optional(), sub: z.string().min(1).max(255),
  email: z.email(), email_verified: z.literal(true), nonce: z.string(), exp: z.number().int(), iat: z.number().int(),
  nbf: z.number().int().optional() });
type Session = { principal: string; email: string; csrf: string; expires: number };
type Flow = { state: string; nonce: string; verifier: string; expires: number; consumed?: boolean };
function cookie(req: IncomingMessage, name: string) {
  const matches = (req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${name}=`));
  return matches.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(matches[0].slice(name.length + 1)) ? matches[0].slice(name.length + 1) : '';
}
async function boundedJSON(response: Response) {
  if (!response.ok || !response.body) throw new GoogleAuthError(503, 'auth_unavailable');
  const reader = response.body.getReader(); let size = 0; const chunks: Buffer[] = [];
  try { for (;;) { const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > 65536) throw new GoogleAuthError(503, 'auth_unavailable'); chunks.push(Buffer.from(value));
  } return JSON.parse(Buffer.concat(chunks).toString('utf8')); } finally { await reader.cancel(); }
}
export class GoogleAuth {
  private keys = new Map<string, KeyObject>();
  private keysUntil = 0;
  private fetchedAt = -Infinity;
  private fetching?: Promise<void>;
  private sessions = new Map<string, Session>();
  private flows = new Map<string, Flow>();
  constructor(readonly origin: string, private credentials: () => Credentials,
    private fetcher: typeof fetch = fetch, private now = Date.now) { this.config(); }
  private config() {
    try {
      const c = GoogleCredentials.parse(this.credentials()); const url = new URL(this.origin);
      if (url.protocol !== 'https:' || url.origin !== this.origin || c.javascript_origin !== this.origin
        || c.redirect_uri !== this.origin + CALLBACK) throw Error();
      return c;
    } catch { throw new GoogleAuthError(503, 'auth_unavailable'); }
  }
  private async refresh() {
    if (this.fetching) return this.fetching;
    if (this.now() - this.fetchedAt < 30_000) return;
    this.fetchedAt = this.now();
    this.fetching = (async () => {
      try {
        const response = await this.fetcher('https://www.googleapis.com/oauth2/v3/certs', {
          redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(5000),
        });
        if (!response.ok || !response.body) throw Error();
        const reader = response.body.getReader(); let bytes = 0; const chunks: Buffer[] = [];
        try { for (;;) { const { done, value } = await reader.read(); if (done) break;
          bytes += value.length; if (bytes > 65536) throw Error(); chunks.push(Buffer.from(value));
        } } finally { await reader.cancel(); }
        const jwks = z.object({ keys: z.array(z.object({ kid: z.string().min(1), kty: z.literal('RSA'), n: z.string(), e: z.string(),
          alg: z.literal('RS256').optional(), use: z.literal('sig').optional() })).min(1).max(16) }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const keys = new Map<string, KeyObject>();
        for (const jwk of jwks.keys) {
          const key = createPublicKey({ key: jwk, format: 'jwk' });
          if (keys.has(jwk.kid) || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw Error();
          keys.set(jwk.kid, key);
        }
        this.keys = keys; this.keysUntil = this.now() + 300_000;
      } catch { throw new GoogleAuthError(503, 'auth_unavailable'); }
    })().finally(() => { this.fetching = undefined; });
    return this.fetching;
  }
  private prune() {
    for (const [key, value] of this.sessions) if (value.expires <= this.now()) this.sessions.delete(key);
    for (const [key, value] of this.flows) if (value.expires <= this.now()) this.flows.delete(key);
  }
  begin(req: IncomingMessage) {
    this.prune(); const c = this.config();
    this.flows.delete(digest(cookie(req, FLOW)));
    if (this.flows.size >= 256) throw new GoogleAuthError(503, 'auth_unavailable');
    const value = nonce(), flow = { state: nonce(), nonce: nonce(), verifier: nonce(), expires: this.now() + 600_000 };
    this.flows.set(digest(value), flow);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: c.client_id, redirect_uri: c.redirect_uri, response_type: 'code',
      scope: 'openid email', state: flow.state, nonce: flow.nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'), prompt: 'select_account' }).toString();
    return { location: url.href, cookie: `${FLOW}=${value}${attributes}; Max-Age=600` };
  }
  clearFlowCookie() { return `${FLOW}=${attributes}; Max-Age=0`; }
  async callback(req: IncomingMessage, params: URLSearchParams) {
    this.prune(); const key = digest(cookie(req, FLOW)), flow = this.flows.get(key);
    // Consume before any network awaits, including rejection: concurrent/replayed callbacks fail closed.
    if (!flow || flow.consumed) throw deny();
    flow.consumed = true;
    if (params.getAll('state').length !== 1 || params.get('state') !== flow.state) throw deny();
    if (params.has('error')) throw deny();
    if (params.getAll('code').length !== 1 || !params.get('code') || params.get('code')!.length > 4096) throw deny();
    const c = this.config();
    let token: string;
    try {
      const response = await this.fetcher('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error',
        credentials: 'omit', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: params.get('code')!, client_id: c.client_id, client_secret: c.client_secret,
          redirect_uri: c.redirect_uri, grant_type: 'authorization_code', code_verifier: flow.verifier }) });
      if (response.status === 400 || response.status === 401) throw deny();
      token = z.object({ id_token: z.string().max(16384) }).parse(await boundedJSON(response)).id_token;
    } catch (error) { if (error instanceof GoogleAuthError) throw error; throw new GoogleAuthError(503, 'auth_unavailable'); }
    const claims = await this.verifyToken(token, flow.nonce, c.client_id);
    // Re-read private policy after exchange; the consent screen is never the authorization policy.
    if (!this.config().allowed_emails.includes(claims.email)) throw new GoogleAuthError(403, 'access_denied');
    // A logout/new login during exchange, or an expired flow, must not resurrect authorization.
    if (this.flows.get(key) !== flow || flow.expires <= this.now()) throw deny();
    this.flows.delete(key);
    const principal = digest(`google\n${claims.sub}\n${claims.email}`);
    this.prune();
    // Rotate any prior browser session, never adopt a supplied session identifier.
    this.sessions.delete(digest(cookie(req, COOKIE)));
    if (this.sessions.size >= 256) throw new GoogleAuthError(503, 'auth_unavailable');
    const value = nonce(); const session = { principal, email: claims.email, csrf: nonce(),
      expires: Math.min(claims.exp * 1000, this.now() + 3600_000) };
    this.sessions.set(digest(value), session);
    return `${COOKIE}=${value}${attributes}; Max-Age=${Math.floor((session.expires - this.now()) / 1000)}`;
  }
  private async verifyToken(token: string, expectedNonce: string, clientId: string) {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw deny();
    let header: { alg: 'RS256'; kid: string };
    try { header = z.strictObject({ alg: z.literal('RS256'), kid: z.string().min(1).max(128), typ: z.literal('JWT').optional() })
      .parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))); } catch { throw deny(); }
    if (this.now() >= this.keysUntil || !this.keys.has(header.kid)) await this.refresh();
    const key = this.keys.get(header.kid);
    if (this.now() >= this.keysUntil) throw new GoogleAuthError(503, 'auth_unavailable');
    if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw deny();
    let claims: z.infer<typeof Claims>;
    try { claims = Claims.parse(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))); } catch { throw deny(); }
    const aud = typeof claims.aud === 'string' ? [claims.aud] : claims.aud, now = this.now() / 1000;
    if (!aud.includes(clientId) || (claims.azp !== undefined && claims.azp !== clientId)
      || (aud.length > 1 && claims.azp !== clientId) || claims.nonce !== expectedNonce || claims.exp <= now
      || claims.iat > now + 30 || claims.iat >= claims.exp || (claims.nbf !== undefined && claims.nbf > now)) throw deny();
    return claims;
  }
  private session(req: IncomingMessage) {
    this.prune(); const session = this.sessions.get(digest(cookie(req, COOKIE)));
    if (!session) throw deny();
    if (!this.config().allowed_emails.includes(session.email)) throw new GoogleAuthError(403, 'access_denied');
    return session;
  }
  bootstrap(req: IncomingMessage) {
    const session = this.session(req);
    return { principal: session.principal, csrf: session.csrf, expiresAt: session.expires, botIds: [MAIN_BOT_ID] };
  }
  authorize(req: IncomingMessage) {
    const session = this.session(req);
    if (req.headers['x-botling-csrf'] !== session.csrf) throw new GoogleAuthError(403, 'access_denied');
    return { id: `google:${session.principal}`, botIds: [MAIN_BOT_ID], expiresAt: session.expires };
  }
  logout(req: IncomingMessage) {
    this.authorize(req); const session = this.session(req);
    for (const [key, value] of this.sessions) if (value.principal === session.principal) this.sessions.delete(key);
    this.flows.delete(digest(cookie(req, FLOW)));
    return `${COOKIE}=${attributes}; Max-Age=0`;
  }
}
