// A small WebSocket client (RFC 6455) for botling-agent on Node 18, which has no global WebSocket: text frames,
// fragmentation, ping/pong and close. It has the shape of the browser WebSocket that mobile-relay's SocketLike uses.
// Where a global WebSocket exists (Node 22+, Electron) `openSocket` uses that one.
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { SocketLike } from "../../mobile-relay/connector";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 16 * 1024 * 1024;

export class MiniWebSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private socket: Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private closed = false;

  constructor(url: string) {
    const u = new URL(url);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") throw new Error(`Not a WebSocket address: ${url}`);
    const key = randomBytes(16).toString("base64");
    const req = (u.protocol === "wss:" ? httpsRequest : httpRequest)({
      host: u.hostname, port: u.port || (u.protocol === "wss:" ? 443 : 80), path: `${u.pathname}${u.search}`, method: "GET",
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key, "User-Agent": "botling-agent" },
      ...(u.protocol === "wss:" ? { servername: u.hostname } : {}),
    });
    req.setTimeout(20_000, () => req.destroy(new Error("WebSocket connect timed out")));
    req.on("upgrade", (res, socket, head) => {
      const accept = createHash("sha1").update(key + GUID).digest("base64");
      if (res.headers["sec-websocket-accept"] !== accept) { socket.destroy(); this.fail(new Error("Bad WebSocket accept")); return; }
      req.setTimeout(0);
      this.socket = socket;
      socket.setNoDelay(true);
      socket.on("data", (chunk: Buffer) => this.data(chunk));
      socket.on("error", (error) => this.fail(error));
      socket.on("close", () => this.end(1006, ""));
      this.readyState = 1;
      this.onopen?.({});
      if (head.length) this.data(head);
    });
    req.on("response", (res) => { res.resume(); this.fail(new Error(`WebSocket refused: HTTP ${res.statusCode}`)); });
    req.on("error", (error) => this.fail(error));
    req.end();
  }

  send(data: string) {
    if (this.readyState !== 1 || !this.socket) throw new Error("WebSocket is not open");
    this.frame(0x1, Buffer.from(data, "utf8"));
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    try { this.frame(0x8, body); } catch { /* gone */ }
    const socket = this.socket;
    setTimeout(() => socket?.destroy(), 1_000).unref?.();
  }

  private frame(opcode: number, payload: Buffer) {
    const mask = randomBytes(4);
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len])
      : len < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255])
        : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
    const body = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) body[i] = payload[i]! ^ mask[i & 3]!;
    this.socket!.write(Buffer.concat([head, mask, body]));
  }

  private data(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0]!, b1 = this.buffer[1]!;
      let len = b1 & 0x7f, at = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; len = Number(this.buffer.readBigUInt64BE(2)); at = 10; }
      const masked = (b1 & 0x80) !== 0;
      if (masked) at += 4;
      if (len > MAX_MESSAGE) { this.fail(new Error("WebSocket frame too large")); return; }
      if (this.buffer.length < at + len) return;
      let payload = this.buffer.subarray(at, at + len);
      if (masked) { const m = this.buffer.subarray(at - 4, at); payload = Buffer.from(payload.map((b, i) => b ^ m[i & 3]!)); }
      this.buffer = this.buffer.subarray(at + len);
      const opcode = b0 & 0x0f, fin = (b0 & 0x80) !== 0;
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (this.readyState === 1) { this.readyState = 2; try { this.frame(0x8, payload.subarray(0, 2)); } catch { /* gone */ } }
        this.end(code, payload.subarray(2).toString("utf8"));
        this.socket?.end();
        return;
      }
      if (opcode === 0x9) { try { this.frame(0xa, payload); } catch { /* gone */ } continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        this.parts.push(Buffer.from(payload));
        if (this.parts.reduce((n, p) => n + p.length, 0) > MAX_MESSAGE) { this.fail(new Error("WebSocket message too large")); return; }
        if (fin) { const data = Buffer.concat(this.parts).toString("utf8"); this.parts = []; this.onmessage?.({ data }); }
      }
    }
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.onerror?.({ error });
    this.socket?.destroy();
    this.end(1006, error.message);
  }

  private end(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

/** A WebSocket to `url`: the global one when there is one, else MiniWebSocket. */
export function openSocket(url: string): SocketLike {
  const Global = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  return Global ? new Global(url) : new MiniWebSocket(url);
}
