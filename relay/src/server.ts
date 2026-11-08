// HTTP + WebSocket front of the relay: /healthz, the optional phone web app under /mobile/, and the WebSocket at /ws.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { RelayConfig } from './config.ts';
import { CLOSE, Relay } from './relay.ts';
import { serveStatic } from './static.ts';

const STATUS = { 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 503: 'Service Unavailable' } as const;

export interface RelayServer { server: Server; relay: Relay; port: number; close(): Promise<void> }

export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Browsers say where a page came from; a native client (the desktop app) says nothing and is allowed. */
export function originAllowed(req: IncomingMessage, allowed: string[]): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (allowed.length) return allowed.includes(origin);
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export function startRelay(config: RelayConfig): Promise<RelayServer> {
  const relay = new Relay(config);
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const url = new URL(req.url ?? '/', 'http://relay');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    if (url.pathname === '/healthz' || url.pathname === '/readyz') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return;
    }
    if (config.staticDir) {
      if (url.pathname === '/' || url.pathname === '/mobile') { res.writeHead(302, { Location: '/mobile/' }); res.end(); return; }
      const origin = config.publicOrigin ?? `https://${req.headers.host ?? 'localhost'}`;
      if (await serveStatic(config.staticDir, origin, req, res, url.pathname)) return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxFrameBytes, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://relay');
    const refuse = (status: 403 | 404 | 429 | 503) => { socket.end(`HTTP/1.1 ${status} ${STATUS[status]}\r\nConnection: close\r\n\r\n`); };
    if (url.pathname !== '/ws' || url.search) return refuse(404);
    if (!originAllowed(req, config.allowedOrigins)) return refuse(403);
    const ip = clientAddress(req, config.trustProxy);
    const admitted = relay.admit(ip);
    if (admitted !== 'ok') return refuse(admitted === 'full' ? 503 : 429);
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const handlers = relay.attach({ send: text => ws.send(text), close: (code, reason) => ws.close(code, reason) }, ip);
      let alive = true;
      ws.on('pong', () => { alive = true; });
      const beat = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; ws.ping(); }, 30_000);
      beat.unref?.();
      ws.on('message', (data: Buffer, binary: boolean) => {
        if (binary) { ws.close(CLOSE.bad, 'text frames only'); return; }
        handlers.message(data.toString('utf8'));
      });
      ws.on('close', () => { clearInterval(beat); handlers.closed(); });
      ws.on('error', () => { /* 'close' follows; a too-large frame closes with 1009 */ });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;
      resolve({ server, relay, port, close: () => new Promise<void>(done => {
        relay.shutdown();
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(() => done());
        server.closeAllConnections?.();
      }) });
    });
  });
}
