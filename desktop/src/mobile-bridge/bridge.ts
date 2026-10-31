/** Private HTTPS transport. No Electron IPC, local file or approval bypass routes. */
import { generationBytes, type MobileGeneration } from './generation';
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
import { ALL_BOTS, botAllowed } from './scope';
import type { PairingStore, Route } from './pairing';
import { TicketStore } from './tickets';
export { ALL_BOTS, botAllowed };

export const Client = z.strictObject({ id: z.string().min(1).max(100), tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  botIds: z.array(z.string().min(1).refine(id => id !== ALL_BOTS, 'Bearer clients need explicit bot ids.')).min(1), expiresAt: z.number().int().positive(),
  /** Set for paired phones (pairing.ts): when, and the phone's own short name. Display only. */
  pairedAt: z.number().int().positive().optional(), label: z.string().max(40).optional() });
export type Client = z.infer<typeof Client>;
export const Clients = z.array(Client);
export const mobileTypes = new Set(['chat.snapshot', 'chat.history', 'chat.send', 'chat.choose', 'chat.answer']);
export interface MobileCore {
  mobileCommand(raw: unknown, allowedBots: readonly string[]): Promise<ResponseEnvelope>;
  /** Something changed in the core (a bot's chat, or nothing bot-specific). Only that it changed: never what. */
  onChange?(listener: (change: { botId?: string }) => void): () => void;
}
/** The calls a page of one listed route may make to another listed route, with its bearer token in a header. */
const CROSS_ROUTE = new Set(['/api/mobile/command', '/api/mobile/ticket', '/api/mobile/events']);
const NOTICE_MS = 250;
export interface BridgeOptions {
  origin: string; host: string; port: number; tls: ServerOptions; assets: string;
  generation?: MobileGeneration; ready?: () => void; updating?: () => boolean;
  clients: () => Client[]; ledger: MutationLedger; core: MobileCore; pairing?: PairingStore;
  /** More HTTPS origins that reach this same listener (LAN name, Tailscale name): each is accepted as Host/Origin. */
  routes?: Route[]; tickets?: TicketStore;
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
/** OS account is the setup authority. Never accept group/world-readable credential policy. */
export function privateJSON(file: string): unknown {
  const stat = statSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Mobile configuration must be owner-only.');
  return JSON.parse(readFileSync(file, 'utf8'));
}
export function authenticate(req: Pick<IncomingMessage, 'headers'>, clients: Client[], now = Date.now()): Client | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(req.headers.authorization ?? '');
  if (!match) return;
  const digest = Buffer.from(tokenHash(match[1]), 'hex');
  return clients.find(c => c.expiresAt > now && timingSafeEqual(digest, Buffer.from(c.tokenHash, 'hex')));
}
const assets: Record<string, string> = { 'index.html': 'text/html; charset=utf-8', 'web.js': 'text/javascript; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8', 'web.css': 'text/css; charset=utf-8', 'chat.html': 'text/html; charset=utf-8',
  'chat.js': 'text/javascript; charset=utf-8', 'chat.css': 'text/css; charset=utf-8', 'frame.css': 'text/css; charset=utf-8',
  'plugins/ccb-latex/katex.min.css': 'text/css; charset=utf-8', 'frame-host.html': 'text/html; charset=utf-8', 'frame-host.js': 'text/javascript; charset=utf-8', 'manifest.webmanifest': 'application/manifest+json', 'icon.svg': 'image/svg+xml' };
const FONT = /^plugins\/ccb-latex\/fonts\/[A-Za-z0-9_-]{1,80}\.woff2$/;
/** The desktop's chat-page CSP (src/main/main.ts CHAT_CSP). The page runs in a sandboxed, opaque-origin
 * frame of the shell (no cookies, no storage, no bridge); only the shell may frame it. Its only frames
 * are component and card pages, drawn by the frame host (renderer/web-pages.ts). */
export const webChatCSP = (origin: string) => [
  "default-src 'none'", "script-src 'self' blob:", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
  "media-src 'self' data: blob:", `frame-src ${origin}/mobile/frame-host.html`, "connect-src 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'", "frame-ancestors 'self'",
].join('; ');
/** The frame host: always an opaque origin (`sandbox`, even opened or framed elsewhere), inline script for
 * the component it is handed (which adds the desktop's COMPONENT_CSP/CARD_CSP), and no network, frames or forms. */
export const frameHostCSP = (origin: string) => [
  'sandbox allow-scripts', "default-src 'none'", `script-src ${origin}/mobile/frame-host.js 'unsafe-inline' blob:`, "style-src 'unsafe-inline'",
  'img-src data: blob:', 'font-src data:', 'media-src data: blob:', "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'",
  "form-action 'none'", "base-uri 'none'",
].join('; ');
function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
export function handler(options: BridgeOptions) {
  const origin = new URL(options.origin);
  const origins = new Map([origin, ...(options.routes ?? []).map(r => new URL(r.origin))].map(o => [o.host, o] as const));
  const tickets = options.tickets ?? new TicketStore();
  const streams = new Set<ServerResponse>();
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    const refuse = (status: number) => { res.writeHead(status); res.end(); };
    let url: URL;
    try { url = new URL(req.url ?? '/', origin); } catch { return refuse(400); }
    const api = url.pathname.startsWith('/api/mobile/');
    const publicAsset = req.method === 'GET' && url.pathname.startsWith('/mobile/');
    const coreInfo = req.method === 'GET' && url.pathname === '/api/mobile/core'; // public, secret-free; still Host-checked
    const crossData = CROSS_ROUTE.has(url.pathname) && ['GET', 'POST', 'OPTIONS'].includes(req.method ?? '');
    const forbidden = () => api ? json(res, 403, { error: { code: 'access_denied' } }) : refuse(403);
    // The public shell may cross sites; data operations still require same-origin requests; never trust forwarded headers.
    // The sandboxed chat frame's CORS loads (KaTeX fonts) say `Origin: null`; only public assets accept it.
    const self = origins.get(req.headers.host ?? '') ?? origin;
    const routeOrigin = req.headers.origin !== undefined && [...origins.values()].some(o => o.origin === req.headers.origin);
    if (!origins.has(req.headers.host ?? '') || (req.headers.origin && req.headers.origin !== self.origin && !(publicAsset && req.headers.origin === 'null') && !((coreInfo || crossData) && routeOrigin))
      || (req.headers['sec-fetch-site'] === 'cross-site' && !publicAsset && !coreInfo && !(crossData && routeOrigin))) return forbidden();
    // A phone on one route probes the others (the secret-free descriptor), and once a route has proved it is this core,
    // sends commands and ticket requests there: only for this core's own origins, with the bearer token in a header, no cookies.
    if ((coreInfo || crossData) && routeOrigin) { res.setHeader('Access-Control-Allow-Origin', req.headers.origin!); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') {
      if (!crossData || !routeOrigin) return refuse(405);
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Botling-Generation', 'Access-Control-Max-Age': '600' });
      res.end(); return;
    }
    if (options.updating?.()) return json(res, 503, { error: { code: 'generation_updating' } });
    const generation = options.generation;
    if (publicAsset) {
      let name = url.pathname.slice('/mobile/'.length) || 'index.html';
      if (generation) {
        const prefix = `g/${generation.id}/`;
        if (name === 'index.html') { res.writeHead(302, { Location: `/mobile/${prefix}` }); res.end(); return; }
        if (!name.startsWith(prefix)) {
          if (/^g\/[a-f0-9]{64}\/(?:index.html)?$/.test(name)) { res.writeHead(302, { Location: '/mobile/' }); res.end(); return; }
          return refuse(410);
        }
        name = name.slice(prefix.length) || 'index.html';
      }
      const font = FONT.test(name);
      if (!Object.hasOwn(assets, name) && !font) return refuse(404);
      try {
        const body = generation ? generationBytes(generation, name) : readFileSync(join(options.assets, name));
        if (!body) return refuse(404);
        if (name === 'chat.html') res.setHeader('Content-Security-Policy', webChatCSP(self.origin).replaceAll("/mobile/", generation ? `/mobile/g/${generation.id}/` : "/mobile/"));
        if (name === 'frame-host.html') res.setHeader('Content-Security-Policy', frameHostCSP(self.origin).replaceAll("/mobile/", generation ? `/mobile/g/${generation.id}/` : "/mobile/"));
        if (font) res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(200, { 'Content-Type': font ? 'font/woff2' : assets[name] }); res.end(body);
      }
      catch { refuse(404); }
      return;
    }
    if (coreInfo) {
      if (!options.pairing) return refuse(404);
      try { return json(res, 200, options.pairing.descriptor()); } catch { return json(res, 503, { error: { code: 'core_unavailable' } }); }
    }
    // Browser clients must match the page generation. Bearer automation without a browser
    // Origin keeps its existing versioned protocol contract; browser bearer clients are fenced too.
    const stale = () => generation && !!req.headers.origin && req.headers['x-botling-generation'] !== generation.id;
    if (stale()) return json(res, 409, { error: { code: 'generation_changed' } });
    if (url.pathname === '/api/mobile/pair' && url.search === '') {
      if (!options.pairing) return refuse(404);
      if (req.method !== 'POST') return refuse(405);
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return refuse(415);
      let body: any;
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 2_048) { refuse(413); return; } chunks.push(Buffer.from(chunk)); }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return refuse(400); }
      try {
        const result = options.pairing.redeem(body?.secret, body?.deviceId, body?.name);
        if (result.ok) return json(res, 200, { token: result.token, expiresAt: result.expiresAt, coreId: result.coreId });
        return json(res, result.reason === 'limited' ? 429 : 401, { error: { code: result.reason === 'limited' ? 'pair_limited' : 'pair_invalid' } });
      } catch { return json(res, 503, { error: { code: 'pair_unavailable' } }); }
    }
    if (url.pathname === '/api/mobile/ticket' && url.search === '') {
      if (req.method !== 'POST') return refuse(405);
      let asked: Client | undefined;
      try { asked = authenticate(req, Clients.parse(options.clients())); } catch { return json(res, 503, { error: { code: 'auth_unavailable' } }); }
      if (!asked) return json(res, 401, { error: { code: 'auth_required' } });
      const issued = tickets.issue(asked.id);
      return issued ? json(res, 200, issued) : json(res, 429, { error: { code: 'ticket_limited' } });
    }
    if (url.pathname === '/api/mobile/events') {
      if (req.method !== 'GET') return refuse(405);
      // The ticket is the only secret in this URL, and it is already spent when the stream opens.
      const ticket = [...url.searchParams.keys()].join() === 'ticket' ? url.searchParams.get('ticket') : null;
      const clientId = tickets.redeem(ticket);
      const live = () => { try { return Clients.parse(options.clients()).find(c => c.id === clientId && c.expiresAt > Date.now()); } catch { return undefined; } };
      const client = clientId ? live() : undefined;
      if (!client) return json(res, 401, { error: { code: 'ticket_invalid' } });
      if (streams.size >= 16) return json(res, 429, { error: { code: 'stream_limited' } });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write('retry: 3000\nevent: ready\ndata: {}\n\n');
      streams.add(res);
      // The core says that something changed; the phone then reads what it is allowed to read (a normal, checked request).
      // Nothing of the change itself goes down this stream, and a change in a bot the phone may not read is not announced.
      // A burst becomes one notice. The stream ends when the session is revoked or expires.
      let notice: ReturnType<typeof setTimeout> | undefined, count = 0;
      const stopListening = options.core.onChange?.(change => {
        if (change.botId !== undefined && !botAllowed(client.botIds, change.botId)) return;
        if (notice) return;
        notice = setTimeout(() => { notice = undefined; if (!live()) { res.end(); return; } res.write(`event: changed\ndata: {"n":${++count}}\n\n`); }, NOTICE_MS);
      });
      const beat = setInterval(() => { if (live()) res.write(': ping\n\n'); else res.end(); }, 15_000);
      res.on('close', () => { clearInterval(beat); clearTimeout(notice); stopListening?.(); streams.delete(res); });
      return;
    }
    if (req.url !== '/api/mobile/command') return refuse(404);
    if (req.method !== 'POST') return refuse(405);
    let client: Pick<Client, 'id' | 'botIds' | 'expiresAt'> | undefined;
    // Bearer-authenticated with its own bot ACL, re-resolved after the body upload to honor revocation.
    const resolveClient = () => authenticate(req, Clients.parse(options.clients()));
    try { client = resolveClient(); } catch { return json(res, 503, { error: { code: 'auth_unavailable' } }); }
    if (!client) return json(res, 401, { error: { code: 'auth_required' } });
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
    try { client = resolveClient(); } catch { return json(res, 503, { error: { code: 'auth_unavailable' } }); }
    if (!client) return json(res, 401, { error: { code: 'auth_required' } });
    if (!mobileTypes.has(cmd.type) || !('botId' in cmd) && cmd.type !== 'chat.snapshot'
      || !botAllowed(client.botIds, ('botId' in cmd ? cmd.botId : undefined) ?? MAIN_BOT_ID)
      || (cmd.type === 'chat.answer' && cmd.images?.length)) {
      return json(res, 403, errorResponse(request.id, { code: 'forbidden', message: 'Command or bot not authorized.' }));
    }
    if (options.updating?.()) return json(res, 503, { error: { code: 'generation_updating' } });
    if (stale()) return json(res, 409, { error: { code: 'generation_changed' } });
    try {
      const dispatch = () => {
        if (options.updating?.()) throw new Error('Generation activation in progress');
        return options.core.mobileCommand(request, client!.botIds);
      };
      const response = cmd.type === 'chat.snapshot' || cmd.type === 'chat.history' ? await dispatch() : await options.ledger.run(client.id, request, dispatch);
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
  for (const route of options.routes ?? []) {
    const parsed = new URL(route.origin);
    if (parsed.protocol !== 'https:' || parsed.origin !== route.origin) throw new Error('Every route must be an HTTPS origin without a path.');
  }
  Clients.parse(options.clients());
  const handle = handler(options);
  const server = createServer({ ...options.tls, minVersion: 'TLSv1.2' }, (req, res) => { void handle(req, res).catch(() => { res.destroy(); }); });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32; server.maxConnections = 32;
  return listenWithHandover(server, options.port, options.host, failed, options.ready);
}
