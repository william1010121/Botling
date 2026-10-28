/** Private HTTPS transport. No Electron IPC, local file or approval bypass routes. */
import { createServer, type ServerOptions } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { RequestEnvelope, errorResponse, type ResponseEnvelope } from '../contract';
import { MAIN_BOT_ID } from '../core/store/records';
import { MutationLedger } from './ledger';
import { listenWithHandover } from './lifecycle';
import { AccessAuth, AccessError } from './access';

export const Client = z.strictObject({ id: z.string().min(1).max(100), tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  botIds: z.array(z.string().min(1)).min(1), expiresAt: z.number().int().positive() });
export type Client = z.infer<typeof Client>;
export const Clients = z.array(Client);
export const mobileTypes = new Set(['chat.snapshot', 'chat.send', 'chat.choose', 'chat.answer']);
export interface MobileCore { mobileCommand(raw: unknown, allowedBots: readonly string[]): Promise<ResponseEnvelope> }
export interface BridgeOptions {
  origin: string; host: string; port: number; tls: ServerOptions; assets: string;
  access?: AccessAuth; clients: () => Client[]; ledger: MutationLedger; core: MobileCore;
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
/** OS account is the setup authority. Never accept group/world-readable credential policy. */
export function privateJSON(file: string): unknown {
  const stat = statSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Mobile configuration must be owner-only.');
  return JSON.parse(readFileSync(file, 'utf8'));
}
function authenticate(req: IncomingMessage, clients: Client[]): Client | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(req.headers.authorization ?? '');
  if (!match) return;
  const digest = Buffer.from(tokenHash(match[1]), 'hex');
  return clients.find(c => c.expiresAt > Date.now() && timingSafeEqual(digest, Buffer.from(c.tokenHash, 'hex')));
}
const assets: Record<string, string> = { 'index.html': 'text/html; charset=utf-8', 'mobile.js': 'text/javascript; charset=utf-8',
  'mobile.css': 'text/css; charset=utf-8', 'manifest.webmanifest': 'application/manifest+json', 'icon.svg': 'image/svg+xml' };
function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
export function handler(options: BridgeOptions) {
  const origin = new URL(options.origin);
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    const refuse = (status: number) => { res.writeHead(status); res.end(); };
    // Access login is the sole cross-site top-level return. No forwarded host or wildcard CORS.
    const login = req.method === 'GET' && req.url === '/api/mobile/login';
    if (req.headers.host !== origin.host || (req.headers.origin && req.headers.origin !== origin.origin)
      || (req.headers['sec-fetch-site'] === 'cross-site' && !login)) return refuse(403);
    if (req.method === 'GET' && req.url?.startsWith('/mobile/')) {
      const name = req.url.slice('/mobile/'.length) || 'index.html';
      if (!Object.hasOwn(assets, name)) return refuse(404);
      try { const body = readFileSync(join(options.assets, name)); res.writeHead(200, { 'Content-Type': assets[name] }); res.end(body); }
      catch { refuse(404); }
      return;
    }
    const authFailure = (error: unknown) => {
      const failure = error instanceof AccessError ? error : new AccessError(503, 'auth_unavailable');
      json(res, failure.status, { error: { code: failure.code } });
    };
    const browser = req.url === '/api/mobile/browser/command';
    const authRoute = ['/api/mobile/session', '/api/mobile/logout', '/api/mobile/login'].includes(req.url ?? '');
    if (browser || authRoute) {
      if (!options.access) return json(res, 503, { error: { code: 'auth_unavailable' } });
      if (authRoute) {
        if ((req.url === '/api/mobile/login' && req.method !== 'GET') || (req.url !== '/api/mobile/login' && req.method !== 'POST')) return refuse(405);
        if (!login && (req.headers.origin !== origin.origin || req.headers['x-botling-session'] !== '1')) return refuse(403);
        try {
          const identity = await options.access.identity(req);
          if (login) { res.writeHead(303, { Location: '/mobile/' }); res.end(); return; }
          if (req.url === '/api/mobile/logout') {
            res.setHeader('Set-Cookie', options.access.logout(req, identity));
            return json(res, 200, { loggedOut: true });
          }
          const session = options.access.bootstrap(req, identity);
          res.setHeader('Set-Cookie', session.cookie); return json(res, 200, session.body);
        } catch (error) { return authFailure(error); }
      }
    }
    if (!browser && req.url !== '/api/mobile/command') return refuse(404);
    if (req.method !== 'POST') return refuse(405);
    let client: Pick<Client, 'id' | 'botIds' | 'expiresAt'> | undefined;
    const resolveClient = async () => {
      if (browser) {
        if (req.headers.origin !== origin.origin) throw new AccessError(403, 'access_denied');
        return options.access!.authorize(req, await options.access!.identity(req));
      }
      // With Access enabled, automation needs BOTH an allowed signed Access assertion and
      // its existing bearer token. There is no public bypass or service-account auto-enrollment.
      const identity = options.access ? await options.access.identity(req) : undefined;
      const bearer = authenticate(req, Clients.parse(options.clients()));
      return bearer && identity ? { ...bearer, botIds: bearer.botIds.filter(id => identity.account.botIds.some(grant => grant === id)),
        expiresAt: Math.min(bearer.expiresAt, identity.expires) } : bearer;
    };
    try { client = await resolveClient(); } catch (error) { return authFailure(error); }
    if (!client) return refuse(401);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return refuse(415);
    let raw: unknown;
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 512_000) { refuse(413); return; } chunks.push(Buffer.from(chunk)); }
      raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return refuse(400); }
    const parsed = RequestEnvelope.safeParse(raw);
    if (!parsed.success) {
      const id = typeof (raw as any)?.id === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test((raw as any).id) ? (raw as any).id : 'invalid';
      return json(res, 400, errorResponse(id, { code: (raw as any)?.v !== 10 ? 'unsupported_version' : 'bad_request', message: 'Invalid mobile request.' }));
    }
    const request = parsed.data;
    const cmd = request.cmd;
    // Recheck revocation after a potentially slow body upload, before lookup/replay/dispatch.
    try { client = await resolveClient(); } catch (error) { return authFailure(error); }
    if (!client) return refuse(401);
    if (!mobileTypes.has(cmd.type) || !('botId' in cmd) && cmd.type !== 'chat.snapshot'
      || !client.botIds.includes(('botId' in cmd ? cmd.botId : undefined) ?? MAIN_BOT_ID)
      || (cmd.type === 'chat.answer' && cmd.images?.length)) {
      return json(res, 403, errorResponse(request.id, { code: 'forbidden', message: 'Command or bot not authorized.' }));
    }
    try {
      const dispatch = () => options.core.mobileCommand(request, client!.botIds);
      const response = cmd.type === 'chat.snapshot' ? await dispatch() : await options.ledger.run(client.id, request, dispatch);
      json(res, 200, response);
    } catch { json(res, 503, errorResponse(request.id, { code: 'core_unavailable', message: 'Mobile bridge unavailable. Check chat before sending again.' })); }
  };
}
export function startBridge(options: BridgeOptions, failed: (error: Error) => void) {
  const origin = new URL(options.origin);
  // origin is the public browser origin; port is the independent private HTTPS listener.
  // Bind only a specific private IPv4 address, never 0.0.0.0 or a public interface.
  const octets = options.host.split('.').map(Number);
  const privateHost = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (octets[0] === 127 || octets[0] === 10 || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127));
  if (!privateHost || origin.protocol !== 'https:' || origin.origin !== options.origin
    || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535
    || !options.tls.key || !options.tls.cert) throw new Error('Explicit private bind address, valid listener port and HTTPS origin/TLS certificate required.');
  Clients.parse(options.clients());
  const server = createServer({ ...options.tls, minVersion: 'TLSv1.2' }, (req, res) => { void handler(options)(req, res).catch(() => { res.destroy(); }); });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32; server.maxConnections = 32;
  return listenWithHandover(server, options.port, options.host, failed);
}
