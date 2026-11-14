// botlingd's one network listener (M2 step 6, protocol v1 §6.1, §18.3, D21): plain HTTP on 127.0.0.1 only, never another
// interface. `tailscale serve` (run by the user, never by botlingd; `botlingd status` prints the command) publishes it
// at the machine's tailnet HTTPS name.
//
//   /v3/          the Botling 3 page (web-v3/dist beside out/, step 8; a placeholder until it is built)
//   /v3/ws        the device WebSocket (ws.ts): one encrypted session per connection
//   /v3/c/…       content byte ranges with a URL ticket (step 9, server/content/remote.ts; 501 when no content service)
//
// Every answer carries the security headers below (CSP `script-src 'self'`, no sniffing, no referrer, framing only by
// the page itself). The page is static: nothing here reads a cookie, a query or a body; `/v3/c/` reads only its query
// (the entry and the ticket), never a cookie. The WebSocket upgrade is taken
// only on `/v3/ws`, only with no Origin (a non-browser client) or an Origin this server is reached at; everything after
// it is the session layer's business (no frame is parsed before its roster check).
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { DeviceSockets, refuseUpgrade, type SessionAcceptor } from "./ws";

/** The only address botlingd ever listens on. */
export const LISTEN_HOST = "127.0.0.1";
/** The variable that sets the port ("off" turns the listener off, "0" picks a free port). */
export const LISTEN_PORT_ENV = "BOTLING_SERVER_PORT";
/** The port when the variable is unset (2.x's phone bridge uses 8443; this one is Botling 3's). */
export const DEFAULT_LISTEN_PORT = 8744;
/** Where botlingd writes the listener's address while it runs (status reads it). */
export const LISTEN_FILE = "botlingd.listen.json";

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** The 2.x chat page's own policy (src/mobile-bridge/bridge.ts webChatCSP, desktop CHAT_CSP) for `/v3/chat.html`: it runs
 * in a sandboxed, opaque-origin frame and loads its built-in web parts as blob: scripts; no network, forms or plugins. */
export const CHAT_CSP = [
  "default-src 'none'", "script-src 'self' blob:", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
  "media-src 'self' data: blob:", "frame-src 'self'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'", "frame-ancestors 'self'",
].join("; ");
/** The component frame host's policy (bridge.ts frameHostCSP) for `/v3/frame-host.html`: a sandbox, scripts only from
 * itself and the blob: it is handed, no network, frames or forms. Its parent is the opaque chat frame, so it carries no
 * frame-ancestors / X-Frame-Options (as on 2.x). */
export const FRAME_HOST_CSP = [
  "sandbox allow-scripts", "default-src 'none'", "script-src 'self' 'unsafe-inline' blob:", "style-src 'unsafe-inline'", "img-src data: blob:",
  "font-src data:", "media-src data: blob:", "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "form-action 'none'", "base-uri 'none'",
].join("; ");

/** Headers on every answer of the listener. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "SAMEORIGIN",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
/** The largest page file served (the page's bundles are a few MB). */
const PAGE_FILE_LIMIT = 32 * 1024 * 1024;

export const PLACEHOLDER_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Botling 3</title></head>
<body><h1>Botling 3</h1><p>This server is running, but its phone page is not built yet.</p></body></html>
`;

/** The configured port: a number (0 = any free port), or null when the listener is off. Throws on a bad value. */
export function listenPort(env: Record<string, string | undefined>): number | null {
  const text = (env[LISTEN_PORT_ENV] ?? "").trim();
  if (!text) return DEFAULT_LISTEN_PORT;
  if (text === "off") return null;
  if (!/^[0-9]{1,5}$/.test(text) || Number(text) > 65_535) throw new Error(`${LISTEN_PORT_ENV} takes a port (0–65535) or "off", not "${text}"`);
  return Number(text);
}

/** The command that publishes the listener on the tailnet (printed by `botlingd status`, never run by botlingd). */
export function tailscaleServeCommand(port: number): string {
  return `tailscale serve --bg http://${LISTEN_HOST}:${port}`;
}

export interface LoopbackListenerOptions {
  /** 0 = any free port. */
  port: number;
  remote: SessionAcceptor;
  /** The built page (web-v3/dist), or null for the placeholder. */
  pageDir: string | null;
  /** https origins the page is reached at (the tailnet origin), besides the loopback ones. */
  origins: () => string[];
  log: (line: string) => void;
  maxHandshaking?: number;
  maxConnections?: number;
  /** `/v3/c/…` (step 9): GET/HEAD byte ranges of a chat line's file; without it those answer 501. */
  content?: ContentEndpoint;
}

/** What answers `/v3/c/…` (server/content/remote.ts `RemoteContent`). */
export interface ContentEndpoint {
  serve(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

export class LoopbackListener {
  private readonly connections = new Set<Socket>();
  private closing: Promise<void> | null = null;

  private constructor(private readonly server: Server, readonly sockets: DeviceSockets, private readonly options: LoopbackListenerOptions, private readonly pageRoot: string | null) {}

  /** Listens on 127.0.0.1 (and nothing else); rejects when the port is taken. */
  static async start(options: LoopbackListenerOptions): Promise<LoopbackListener> {
    const sockets = new DeviceSockets({ remote: options.remote, log: options.log, maxHandshaking: options.maxHandshaking, maxConnections: options.maxConnections });
    const pageRoot = options.pageDir && existsSync(options.pageDir) ? realpathSync(options.pageDir) : null;
    const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000, maxHeaderSize: 16_384 });
    const listener = new LoopbackListener(server, sockets, options, pageRoot);
    server.on("connection", (socket) => { listener.connections.add(socket); socket.once("close", () => listener.connections.delete(socket)); });
    server.on("request", (request, response) => listener.request(request, response));
    server.on("upgrade", (request, raw, head) => listener.upgrade(request, raw, head));
    server.on("clientError", (_error, raw) => { refuseUpgrade(raw, 400, "Bad Request"); });
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen({ host: LISTEN_HOST, port: options.port, ipv6Only: false, exclusive: true }, () => { server.off("error", reject); resolveListen(); });
    });
    const address = listener.address;
    // Belt and braces: the socket must be bound to 127.0.0.1 itself, never to a wildcard.
    if (address.address !== LISTEN_HOST || address.family !== "IPv4") {
      server.close();
      throw new Error(`the listener is bound to ${address.address}, not ${LISTEN_HOST}`);
    }
    options.log(`listener: http://${LISTEN_HOST}:${address.port} (loopback only; page ${pageRoot ? "built" : "placeholder"})`);
    return listener;
  }

  get address(): AddressInfo { return this.server.address() as AddressInfo; }
  get port(): number { return this.address.port; }

  /** Origins a browser may open `/v3/ws` from: the loopback ones and the configured tailnet origin. */
  allowedOrigins(): Set<string> {
    const port = this.port;
    return new Set([`http://${LISTEN_HOST}:${port}`, `http://localhost:${port}`, ...this.options.origins()]);
  }

  private upgrade(request: IncomingMessage, raw: Duplex, head: Buffer): void {
    const path = pathOf(request.url);
    if (path !== "/v3/ws") { refuseUpgrade(raw, 404, "Not Found"); return; }
    if (request.method !== "GET" || String(request.headers.upgrade ?? "").toLowerCase() !== "websocket") { refuseUpgrade(raw, 400, "Bad Request"); return; }
    const origin = request.headers.origin;
    if (origin !== undefined && !this.allowedOrigins().has(origin)) {
      this.options.log("listener: a WebSocket from a foreign origin refused");
      refuseUpgrade(raw, 403, "Forbidden");
      return;
    }
    this.sockets.upgrade(request, raw, head);
  }

  private request(request: IncomingMessage, response: ServerResponse): void {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    const path = pathOf(request.url);
    if (path === null) { plain(response, 400, "Bad Request"); return; }
    if (request.method !== "GET" && request.method !== "HEAD") { response.setHeader("Allow", "GET, HEAD"); plain(response, 405, "Method Not Allowed"); return; }
    if (path === "/" || path === "/v3") { response.statusCode = 301; response.setHeader("Location", "/v3/"); response.setHeader("Cache-Control", "no-store"); response.end(); return; }
    if (path === "/v3/ws") { response.setHeader("Upgrade", "websocket"); plain(response, 426, "Upgrade Required"); return; }
    if (path === "/v3/c" || path.startsWith("/v3/c/")) {
      const content = this.options.content;
      if (!content || path === "/v3/c") { plain(response, content ? 404 : 501, content ? "Not Found" : "Not Implemented"); return; }
      void content.serve(request, response).catch(() => { if (!response.headersSent) plain(response, 500, "Internal Error"); else response.destroy(); });
      return;
    }
    if (!path.startsWith("/v3/")) { plain(response, 404, "Not Found"); return; }
    this.page(request, response, path.slice("/v3/".length));
  }

  /** A file of the built page, or the placeholder for `/v3/`. */
  private page(request: IncomingMessage, response: ServerResponse, name: string): void {
    const file = this.pageFile(name === "" ? "index.html" : name);
    if (!file) {
      if (name === "" || name === "index.html") { send(request, response, 200, TYPES[".html"]!, Buffer.from(PLACEHOLDER_PAGE), "no-store"); return; }
      plain(response, 404, "Not Found");
      return;
    }
    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    // The 2.x renderer's chat page runs in a sandboxed frame with an opaque origin ("null", src/renderer/chat-frame/
    // protocol.ts CHAT_SANDBOX): its scripts, styles and fonts are cross-origin requests from there, which `same-origin`
    // would block. The page's own files are the public app shell (no conversation content, nothing private), so the
    // non-HTML ones may be read from any origin; documents, errors and everything outside the page keep `same-origin`.
    if (!type.startsWith("text/html")) response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    if (name === "chat.html") response.setHeader("Content-Security-Policy", CHAT_CSP);
    if (name === "frame-host.html") { response.setHeader("Content-Security-Policy", FRAME_HOST_CSP); response.removeHeader("X-Frame-Options"); }
    // The app shell is checked each time (the service worker caches it); nothing here is private.
    send(request, response, 200, type, readFileSync(file), type.startsWith("text/html") || name === "sw.js" ? "no-store" : "no-cache");
  }

  /** The real path of a page file inside the page folder, or null (missing, a folder, outside it, too big). */
  private pageFile(name: string): string | null {
    if (!this.pageRoot) return null;
    if (name.split("/").some((part) => part === "" || part === "." || part === ".." || part.startsWith("."))) return null;
    const candidate = resolve(this.pageRoot, name);
    try {
      const real = realpathSync(candidate);
      const rel = relative(this.pageRoot, real);
      if (rel === "" || rel.startsWith("..") || rel.split(sep)[0] === ".." || resolve(this.pageRoot, rel) !== real) return null;
      const stat = statSync(real);
      return stat.isFile() && stat.size <= PAGE_FILE_LIMIT ? real : null;
    } catch {
      return null;
    }
  }

  /** Stops listening; device sockets close (their sessions said bye first), other connections are cut. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      const stopped = new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
      await this.sockets.close();
      for (const socket of this.connections) socket.destroy();
      await stopped;
    })();
    return this.closing;
  }
}

/** The decoded path of a request URL, or null when it is malformed (bad escapes, NUL, backslash). */
function pathOf(url: string | undefined): string | null {
  if (!url || !url.startsWith("/")) return null;
  const raw = url.split(/[?#]/, 1)[0]!;
  let path: string;
  try { path = decodeURIComponent(raw); } catch { return null; }
  if (path.includes("\0") || path.includes("\\")) return null;
  return path;
}

function plain(response: ServerResponse, status: number, text: string): void {
  const body = `${text}\n`;
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.setHeader("Cache-Control", "no-store");
  response.end(response.req.method === "HEAD" ? undefined : body);
}

function send(request: IncomingMessage, response: ServerResponse, status: number, type: string, body: Buffer, cache: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", type);
  response.setHeader("Content-Length", body.length);
  response.setHeader("Cache-Control", cache);
  response.end(request.method === "HEAD" ? undefined : body);
}

/** Where `botlingd` finds the built page in development: web-v3/dist beside out/. */
export function defaultPageDir(outDir: string): string {
  return join(outDir, "..", "web-v3", "dist");
}
