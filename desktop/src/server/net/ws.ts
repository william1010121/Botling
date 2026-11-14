// `/v3/ws` (M2 step 6, protocol v1 §6.1, Q3 = `ws`): the WebSocket that carries one device session's frames over the
// tailnet. `tailscale serve` (run by the user) terminates TLS and forwards to botlingd's loopback listener (http.ts).
//
// - One WebSocket = one SessionTransport of kind `tailnet`: each binary WebSocket message is exactly one session frame
//   (HS1–HS3, then sealed frames), in order. The session (remote-session.ts) answers HS1 and checks both static keys
//   against the roster before any frame is opened, so this file never parses anything: it moves bytes.
// - A text message, a message larger than the largest session frame, or a compressed one (permessage-deflate is off)
//   ends the connection; ws itself refuses a payload above `maxPayload` before buffering it.
// - Limits: at most MAX_HANDSHAKING connections whose handshake has not finished and MAX_CONNECTIONS in all; above them
//   the upgrade is answered 503 and nothing is created.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { SESSION_FRAME_LIMIT, type SessionTransport } from "../../session";

/** Header (kind, epoch, counter) + the largest plaintext + the GCM tag: the largest frame a session ever sends. */
export const WS_MAX_PAYLOAD = 13 + SESSION_FRAME_LIMIT + 16;
/** Connections whose session handshake is still under way. */
export const MAX_HANDSHAKING = 32;
/** Every device WebSocket at once. */
export const MAX_CONNECTIONS = 256;
/** How long a closing socket may take to say goodbye before it is cut. */
const CLOSE_GRACE_MS = 1_500;

/**
 * What the WebSocket side needs from botlingd's sessions: device sessions (RemoteSessions) and, since M3, peer servers
 * through server/peer's SessionRouter, which picks one by the first frame.
 */
export interface SessionAcceptor {
  accept(transport: SessionTransport, kind: "tailnet"): {
    readonly link: { readonly established: Promise<unknown> };
    receive(frame: Uint8Array): void;
    transportClosed(): void;
  };
}

export interface DeviceSocketsOptions {
  remote: SessionAcceptor;
  log: (line: string) => void;
  maxHandshaking?: number;
  maxConnections?: number;
}

export class DeviceSockets {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false, clientTracking: true });
  private handshaking = 0;
  private closed = false;

  constructor(private readonly options: DeviceSocketsOptions) {}

  /** Open device WebSockets. */
  get count(): number { return this.wss.clients.size; }

  /** Takes an HTTP upgrade already checked by http.ts (path, Origin), or answers it 503. */
  upgrade(request: IncomingMessage, raw: Duplex, head: Buffer): void {
    const maxHandshaking = this.options.maxHandshaking ?? MAX_HANDSHAKING;
    const maxConnections = this.options.maxConnections ?? MAX_CONNECTIONS;
    if (this.closed || this.handshaking >= maxHandshaking || this.wss.clients.size >= maxConnections) {
      refuseUpgrade(raw, 503, "Service Unavailable");
      return;
    }
    this.wss.handleUpgrade(request, raw, head, (ws) => this.connected(ws));
  }

  private connected(ws: WebSocket): void {
    if (this.closed) { ws.terminate(); return; }
    let ended = false;
    const transport: SessionTransport = {
      send: (frame) => { if (!ended && ws.readyState === 1) ws.send(frame, { binary: true }); },
      close: () => {
        if (ended) return;
        ended = true;
        try { ws.close(1000); } catch { /* already gone */ }
        const cut = setTimeout(() => ws.terminate(), CLOSE_GRACE_MS);
        cut.unref?.();
      },
    };
    this.handshaking++;
    let counted = true;
    const settle = () => { if (counted) { counted = false; this.handshaking--; } };
    const session = this.options.remote.accept(transport, "tailnet");
    session.link.established.then(settle, settle);
    ws.on("message", (data, isBinary) => {
      if (ended) return;
      if (!isBinary) { this.options.log("device socket: a text message; closing"); ended = true; ws.close(1003, "binary frames only"); session.transportClosed(); return; }
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      // A copy: the session keeps frames while it opens them, the socket reuses nothing it hands out, but be sure.
      session.receive(new Uint8Array(bytes));
    });
    ws.on("close", () => { ended = true; settle(); session.transportClosed(); });
    ws.on("error", (error) => {
      this.options.log(`device socket: ${error.message}`);
      ended = true;
      ws.terminate();
    });
  }

  /** Stops taking upgrades; open sockets are closed (their sessions said bye first) and cut after a grace period. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const open = [...this.wss.clients];
    for (const ws of open) { try { ws.close(1001, "botlingd is stopping"); } catch { /* gone */ } }
    const deadline = Date.now() + CLOSE_GRACE_MS;
    while (open.some((ws) => ws.readyState !== 3) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    for (const ws of open) if (ws.readyState !== 3) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

/** Answers an upgrade request with a plain HTTP status and closes the connection (nothing else is read from it). */
export function refuseUpgrade(raw: Duplex, status: number, text: string): void {
  const body = `${text}\n`;
  const response = `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-Content-Type-Options: nosniff\r\n\r\n${body}`;
  if (raw.writable) raw.end(response);
  setTimeout(() => raw.destroy(), 1_000).unref?.();
}
