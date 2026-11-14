// Frame boundaries on a TCP byte stream, for the fault proxy (fault-proxy.ts) and the far-side test endpoints that
// observe what it did. Two framings, both test-only and dependency-free:
//
// - "length": u32 big-endian length ‖ payload. The simple framed echo and the SessionLink-over-TCP checks use it.
// - "websocket": an HTTP/1.1 upgrade head passed through as one unit, then RFC 6455 frames. A data message (its first
//   frame up to FIN, continuations included) is one unit; control frames (ping/pong/close) are their own units and
//   are never faulted, so a WebSocket's own keepalive and close handshake are not broken by a fault aimed at data.
//   This is what M2 step 6's `/v3/ws` will carry between servers; the proxy never unmasks or rewrites a frame, it
//   forwards (or drops, or repeats) the original bytes.
//
// Also here: a loopback server that hands whole frames to a callback per connection (length framing, or a minimal
// WebSocket server answering the upgrade), and a length-framed client. Everything binds 127.0.0.1 only.
import { createHash } from "node:crypto";
import { createConnection, createServer, type AddressInfo, type Server, type Socket } from "node:net";

export type Framing = "length" | "websocket";

/** One unit cut from the stream: the exact bytes as they were on the wire. */
export interface WireUnit {
  raw: Buffer;
  /** The application payload (unmasked for WebSocket), for predicates and observers. */
  payload: Buffer;
  /** WebSocket control frames and the HTTP upgrade head: passed through, never faulted. */
  control: boolean;
  /** The WebSocket opcode of the message (1 text, 2 binary, 8 close, 9 ping, 10 pong); 2 for length framing. */
  opcode: number;
}

export const LOOPBACK = "127.0.0.1";
const HEADER_LIMIT = 16 * 1024;
const FRAME_LIMIT = 64 * 1024 * 1024;

export function lengthFrame(payload: Uint8Array): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length, 0);
  return Buffer.concat([head, Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)]);
}

/** Cuts a byte stream into units. `push` returns the units completed by `chunk`; it throws on a malformed stream. */
export interface Splitter { push(chunk: Buffer): WireUnit[] }

export function splitter(framing: Framing): Splitter {
  return framing === "length" ? new LengthSplitter() : new WebSocketSplitter();
}

class LengthSplitter implements Splitter {
  private buffer: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): WireUnit[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const out: WireUnit[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > FRAME_LIMIT) throw new Error(`frame of ${length} bytes`);
      if (this.buffer.length < 4 + length) break;
      const raw = this.buffer.subarray(0, 4 + length);
      out.push({ raw: Buffer.from(raw), payload: Buffer.from(raw.subarray(4)), control: false, opcode: 2 });
      this.buffer = this.buffer.subarray(4 + length);
    }
    return out;
  }
}

interface WsFrame { raw: Buffer; fin: boolean; opcode: number; payload: Buffer }

/** One RFC 6455 frame from the start of `buffer`, or null when it is not all there yet. */
export function readWsFrame(buffer: Buffer): WsFrame | null {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(FRAME_LIMIT)) throw new Error(`websocket frame of ${big} bytes`);
    length = Number(big);
    offset = 10;
  }
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { raw: Buffer.from(buffer.subarray(0, offset + length)), fin, opcode, payload };
}

/** An unmasked (server → client) or masked (client → server) WebSocket frame. */
export function wsFrame(opcode: number, payload: Uint8Array, masked = false): Buffer {
  const body = Buffer.from(payload);
  const length = body.length;
  const head: number[] = [0x80 | opcode];
  const maskBit = masked ? 0x80 : 0;
  if (length < 126) head.push(maskBit | length);
  else if (length < 65_536) head.push(maskBit | 126, length >> 8, length & 0xff);
  else {
    head.push(maskBit | 127);
    const big = Buffer.alloc(8);
    big.writeBigUInt64BE(BigInt(length));
    head.push(...big);
  }
  if (!masked) return Buffer.concat([Buffer.from(head), body]);
  const mask = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(4)));
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([Buffer.from(head), mask, body]);
}

class WebSocketSplitter implements Splitter {
  private buffer: Buffer = Buffer.alloc(0);
  private headDone = false;
  private message: WsFrame[] = [];
  push(chunk: Buffer): WireUnit[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const out: WireUnit[] = [];
    if (!this.headDone) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (this.buffer.length > HEADER_LIMIT) throw new Error("no end of the HTTP head");
        return out;
      }
      const raw = Buffer.from(this.buffer.subarray(0, end + 4));
      out.push({ raw, payload: raw, control: true, opcode: -1 });
      this.buffer = this.buffer.subarray(end + 4);
      this.headDone = true;
    }
    for (;;) {
      const frame = readWsFrame(this.buffer);
      if (!frame) break;
      this.buffer = this.buffer.subarray(frame.raw.length);
      if (frame.opcode >= 8) { out.push({ raw: frame.raw, payload: frame.payload, control: true, opcode: frame.opcode }); continue; }
      this.message.push(frame);
      if (!frame.fin) continue;
      const parts = this.message.splice(0);
      out.push({
        raw: Buffer.concat(parts.map((part) => part.raw)), payload: Buffer.concat(parts.map((part) => part.payload)), control: false, opcode: parts[0].opcode,
      });
    }
    return out;
  }
}

/** One connection at a framed test server. */
export interface FramedConnection {
  readonly id: number;
  /** Payloads received, in order. */
  readonly frames: Buffer[];
  closed: boolean;
  send(payload: Uint8Array): void;
  close(): void;
}

export interface FramedServer {
  readonly port: number;
  readonly server: Server;
  readonly connections: FramedConnection[];
  close(): Promise<void>;
}

/**
 * A loopback server that cuts each connection into frames and calls `onFrame` (the far side of the proxy). With
 * websocket framing it answers the upgrade (any path) and handles ping and close itself.
 */
export async function framedServer(framing: Framing, handlers: {
  onConnection?: (connection: FramedConnection) => void;
  onFrame?: (connection: FramedConnection, payload: Buffer) => void;
  onClose?: (connection: FramedConnection) => void;
} = {}): Promise<FramedServer> {
  const connections: FramedConnection[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    let upgraded = framing === "length";
    let head = Buffer.alloc(0);
    const split = new WebSocketSplitterAfterHead();
    const length = new LengthSplitter();
    const connection: FramedConnection = {
      id: connections.length + 1, frames: [], closed: false,
      send: (payload) => { if (!socket.destroyed) socket.write(framing === "length" ? lengthFrame(payload) : wsFrame(2, payload)); },
      close: () => {
        if (framing === "websocket" && !socket.destroyed) socket.end(wsFrame(8, Buffer.from([0x03, 0xe8])));
        else socket.destroy();
      },
    };
    connections.push(connection);
    socket.on("close", () => { sockets.delete(socket); if (!connection.closed) { connection.closed = true; handlers.onClose?.(connection); } });
    socket.on("error", () => socket.destroy());
    if (upgraded) handlers.onConnection?.(connection);
    socket.on("data", (chunk: Buffer) => {
      try {
        let rest = chunk;
        if (!upgraded) {
          head = Buffer.concat([head, chunk]);
          const end = head.indexOf("\r\n\r\n");
          if (end < 0) { if (head.length > HEADER_LIMIT) socket.destroy(); return; }
          const key = /sec-websocket-key:\s*(\S+)/i.exec(head.subarray(0, end).toString("latin1"))?.[1];
          if (!key) { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
          const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
          socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
          upgraded = true;
          rest = head.subarray(end + 4);
          handlers.onConnection?.(connection);
          if (!rest.length) return;
        }
        const units = framing === "length" ? length.push(rest) : split.push(rest);
        for (const unit of units) {
          if (unit.opcode === 8) { socket.end(wsFrame(8, unit.payload.subarray(0, 2))); continue; }
          if (unit.opcode === 9) { socket.write(wsFrame(10, unit.payload)); continue; }
          if (unit.control) continue;
          connection.frames.push(unit.payload);
          handlers.onFrame?.(connection, unit.payload);
        }
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, LOOPBACK, () => { server.off("error", reject); resolve(); }); });
  return {
    port: (server.address() as AddressInfo).port, server, connections,
    close: () => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
}

/** The frame part of a WebSocket stream whose head was already handled. */
class WebSocketSplitterAfterHead implements Splitter {
  private readonly inner = new WebSocketSplitter();
  constructor() { this.inner.push(Buffer.from("\r\n\r\n")); }
  push(chunk: Buffer): WireUnit[] { return this.inner.push(chunk); }
}

/** A frame server that sends every frame straight back (the "simple framed echo"). */
export function framedEcho(framing: Framing): Promise<FramedServer> {
  return framedServer(framing, { onFrame: (connection, payload) => connection.send(payload) });
}

/** A length-framed client on loopback. */
export interface FramedClient {
  readonly socket: Socket;
  readonly frames: Buffer[];
  closed: boolean;
  send(payload: Uint8Array): void;
  close(): void;
  onFrame?: (payload: Buffer) => void;
  onClose?: () => void;
}

export async function dialFramed(port: number): Promise<FramedClient> {
  const socket = createConnection({ host: LOOPBACK, port });
  socket.setNoDelay(true);
  await new Promise<void>((resolve, reject) => { socket.once("connect", () => resolve()); socket.once("error", reject); });
  const split = new LengthSplitter();
  const client: FramedClient = {
    socket, frames: [], closed: false,
    send: (payload) => { if (!socket.destroyed) socket.write(lengthFrame(payload)); },
    close: () => socket.destroy(),
  };
  socket.on("data", (chunk: Buffer) => {
    for (const unit of split.push(chunk)) { client.frames.push(unit.payload); client.onFrame?.(unit.payload); }
  });
  socket.on("error", () => socket.destroy());
  socket.on("close", () => { client.closed = true; client.onClose?.(); });
  return client;
}
