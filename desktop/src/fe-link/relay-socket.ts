// A device's connection to its server through the relay (M2 step 13, protocol v1 §6.3): it joins the server's room on the
// unchanged relay (`{t:'join', v:1, room, token}` → `{t:'joined'}`), then carries session frames as base64url text in
// `d` frames. It looks like the part of a browser WebSocket that `wsDial` and the page's pairing use (binary frames as
// ArrayBuffer messages, `readyState`, `onopen` once joined, `onclose`), so the same session code runs on either path.
//
// The join token is derived (src/session/relay-wire.ts): from the offer's secret while pairing, from the static DH with
// the server's roster key once paired. The relay refuses an unknown token (`{t:'error'}` then close 4403); a refused or
// lost connection is a closed socket to the session above, which backs off and dials again.
//
// Isomorphic: the WebSocket constructor is the global one (browsers, Node 22+) or injected; WebCrypto only.
import { frameFromText, frameToText, RELAY_WIRE_VERSION } from "../session";

export interface RelayTarget {
  /** The relay's WebSocket URL (`ws:`/`wss:`, its `/ws`). */
  url: string;
  /** The server's room id (from the pairing offer). */
  room: string;
  /** The join token (derived; may still be computing). */
  token: string | Promise<string>;
}

/** How long the relay may take to answer the join. */
const JOIN_TIMEOUT_MS = 15_000;

type Listener = ((event: { data?: unknown; code?: number; reason?: string }) => void) | null;

/** The WebSocket-shaped relay connection (only what the session code uses). */
export class RelaySocket {
  readyState: 0 | 1 | 2 | 3 = 0;
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  onopen: Listener = null;
  onmessage: Listener = null;
  onclose: Listener = null;
  onerror: Listener = null;
  /** The relay's refusal (`denied`, `desk_offline`, …) when it gave one. */
  refusal: string | null = null;
  private readonly ws: WebSocket;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closedOnce = false;

  constructor(target: RelayTarget, Impl: typeof WebSocket = globalThis.WebSocket) {
    this.ws = new Impl(target.url);
    this.timer = setTimeout(() => { if (this.readyState === 0) this.close(); }, JOIN_TIMEOUT_MS);
    this.ws.onopen = () => {
      void Promise.resolve(target.token).then((token) => {
        if (this.ws.readyState !== 1) return;
        this.ws.send(JSON.stringify({ t: "join", v: RELAY_WIRE_VERSION, room: target.room, token }));
      }, () => this.close());
    };
    this.ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") { this.close(); return; }
      let msg: { t?: unknown; d?: unknown; code?: unknown };
      try { msg = JSON.parse(event.data) as typeof msg; } catch { this.close(); return; }
      if (msg.t === "joined" && this.readyState === 0) {
        if (this.timer) clearTimeout(this.timer);
        this.readyState = 1;
        this.onopen?.({});
        return;
      }
      if (msg.t === "error") { this.refusal = typeof msg.code === "string" ? msg.code.slice(0, 40) : "error"; return; }
      if (msg.t === "d" && typeof msg.d === "string" && this.readyState === 1) {
        const frame = frameFromText(msg.d);
        if (!frame) { this.close(); return; }
        const data = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
        this.onmessage?.({ data });
        return;
      }
      if (msg.t === "pong") return;
    };
    this.ws.onclose = (event: CloseEvent) => this.finish(event.code, event.reason);
    this.ws.onerror = () => { this.onerror?.({}); };
  }

  /** The relay's WebSocket bytes not yet sent. */
  get bufferedAmount(): number { return this.ws.bufferedAmount; }

  send(frame: Uint8Array | ArrayBuffer): void {
    if (this.readyState !== 1) return;
    const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    this.ws.send(JSON.stringify({ t: "d", d: frameToText(bytes) }));
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 2;
    try { this.ws.close(1000); } catch { /* gone */ }
    // A socket that never opened may not fire its close: say it here.
    setTimeout(() => this.finish(1000, "closed"), 1_000);
  }

  private finish(code: number, reason: string): void {
    if (this.closedOnce) return;
    this.closedOnce = true;
    if (this.timer) clearTimeout(this.timer);
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

/** A constructor-shaped factory for `wsDial` / the pairing: `new (relaySocketImpl(target))(ignoredUrl)`. */
export function relaySocketImpl(target: () => RelayTarget, Impl?: typeof WebSocket): typeof WebSocket {
  return class extends RelaySocket {
    constructor(_url: string) { super(target(), Impl); }
  } as unknown as typeof WebSocket;
}
