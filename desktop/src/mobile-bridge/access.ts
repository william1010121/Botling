/** Cloudflare Access is the only IdP boundary. Never trust an unsigned email header. */
import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { MAIN_BOT_ID } from '../core/store/records';

export const AccessConfig = z.strictObject({
  issuer: z.string().regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/),
  audience: z.string().regex(/^[a-f0-9]{64}$/),
  accountsFile: z.string().min(1),
});
export const AccessAccounts = z.array(z.strictObject({
  id: z.string().min(1).max(80), email: z.email().refine(s => s === s.toLowerCase()),
  // This release authorizes Main only; adding projects requires an explicit later change.
  botIds: z.tuple([z.literal(MAIN_BOT_ID)]), expiresAt: z.number().int().positive(),
})).max(1);
export type AccessAccount = z.infer<typeof AccessAccounts>[number];
export class AccessError extends Error {
  constructor(public status: 401 | 403 | 503, public code: 'auth_required' | 'access_denied' | 'auth_unavailable') { super(code); }
}
const deny = () => new AccessError(401, 'auth_required');
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const nonce = () => randomBytes(32).toString('base64url');
const COOKIE = '__Host-botling-mobile';
const Claims = z.object({ iss: z.string(), aud: z.array(z.string()), sub: z.string().min(1),
  email: z.email(), type: z.literal('app'), exp: z.number().int(), iat: z.number().int(), nbf: z.number().int().optional() });
type Identity = { principal: string; assertion: string; expires: number; account: AccessAccount };
type Session = { principal: string; csrf: string; expires: number };
function cookie(req: IncomingMessage) {
  const matches = (req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${COOKIE}=`));
  return matches.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(matches[0].slice(COOKIE.length + 1)) ? matches[0].slice(COOKIE.length + 1) : '';
}
export class AccessAuth {
  private keys = new Map<string, KeyObject>();
  private keysUntil = 0;
  private fetchedAt = -Infinity;
  private fetching?: Promise<void>;
  private sessions = new Map<string, Session>();
  private revoked = new Map<string, number>();
  constructor(readonly config: z.infer<typeof AccessConfig>, private accounts: () => AccessAccount[],
    private fetcher: typeof fetch = fetch, private now = Date.now) { AccessConfig.parse(config); }
  private async refresh() {
    if (this.fetching) return this.fetching;
    if (this.now() - this.fetchedAt < 30_000) return;
    this.fetchedAt = this.now();
    this.fetching = (async () => {
      try {
        const response = await this.fetcher(`${this.config.issuer}/cdn-cgi/access/certs`, {
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
      } catch { throw new AccessError(503, 'auth_unavailable'); }
    })().finally(() => { this.fetching = undefined; });
    return this.fetching;
  }
  private prune() {
    for (const [key, session] of this.sessions) if (session.expires <= this.now()) this.sessions.delete(key);
    for (const [key, expires] of this.revoked) if (expires <= this.now()) this.revoked.delete(key);
  }
  async identity(req: IncomingMessage): Promise<Identity> {
    this.prune();
    const token = req.headers['cf-access-jwt-assertion'];
    if (typeof token !== 'string' || token.length > 16384) throw deny();
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw deny();
    let header: { alg: 'RS256'; kid: string };
    try { header = z.strictObject({ alg: z.literal('RS256'), kid: z.string().min(1).max(128), typ: z.literal('JWT').optional() }).parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))); }
    catch { throw deny(); }
    if (this.now() >= this.keysUntil || !this.keys.has(header.kid)) await this.refresh();
    const key = this.keys.get(header.kid);
    if (this.now() >= this.keysUntil) throw new AccessError(503, 'auth_unavailable');
    if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw deny();
    let claims: z.infer<typeof Claims>;
    try { claims = Claims.parse(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))); } catch { throw deny(); }
    const now = this.now() / 1000;
    if (claims.iss !== this.config.issuer || !claims.aud.includes(this.config.audience) || claims.exp <= now
      || claims.iat > now + 30 || claims.iat >= claims.exp || (claims.nbf !== undefined && claims.nbf > now)) throw deny();
    const assertion = digest(token);
    if (this.revoked.has(assertion)) throw deny();
    let accounts: AccessAccount[];
    try { accounts = AccessAccounts.parse(this.accounts()); } catch { throw new AccessError(503, 'auth_unavailable'); }
    const account = accounts.find(a => a.email === claims.email && a.expiresAt > this.now());
    if (!account) throw new AccessError(403, 'access_denied');
    return { principal: digest(`${claims.iss}\n${claims.sub}\n${claims.email}`), assertion,
      expires: Math.min(claims.exp * 1000, account.expiresAt), account };
  }
  bootstrap(req: IncomingMessage, identity: Identity) {
    const existing = cookie(req); let session = this.sessions.get(digest(existing)); let value = existing;
    if (!session || session.principal !== identity.principal || session.expires <= this.now()) {
      if (this.sessions.size >= 256) throw new AccessError(503, 'auth_unavailable');
      value = nonce(); session = { principal: identity.principal, csrf: nonce(), expires: Math.min(identity.expires, this.now() + 3600_000) };
      this.sessions.set(digest(value), session);
    }
    return { cookie: `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((session.expires - this.now()) / 1000))}`,
      body: { principal: session.principal, csrf: session.csrf, expiresAt: Math.min(session.expires, identity.expires), botIds: identity.account.botIds } };
  }
  authorize(req: IncomingMessage, identity: Identity) {
    const session = this.sessions.get(digest(cookie(req)));
    if (!session || session.expires <= this.now() || session.principal !== identity.principal) throw deny();
    if (req.headers['x-botling-csrf'] !== session.csrf) throw new AccessError(403, 'access_denied');
    return { id: `access:${identity.account.id}`, botIds: identity.account.botIds, expiresAt: Math.min(session.expires, identity.expires) };
  }
  logout(req: IncomingMessage, identity: Identity) {
    this.authorize(req, identity);
    if (this.revoked.size >= 256) throw new AccessError(503, 'auth_unavailable');
    this.revoked.set(identity.assertion, identity.expires);
    // Log out every app session for this verified principal; do not leave sibling tabs authorized.
    for (const [key, session] of this.sessions) if (session.principal === identity.principal) this.sessions.delete(key);
    return `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
  }
}
