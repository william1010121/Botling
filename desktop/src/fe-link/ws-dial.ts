// The front-end link's dial over a browser WebSocket and an end-to-end encrypted session (protocol v1 §5, §6.1; M2
// brief §3): one WebSocket = one session, one binary message = one session frame (botlingd's `server/net/ws.ts` side).
// The IK handshake runs first; the link hears `open` only once both static keys are proven and the server's roster
// check passed, so nothing the link sends leaves before that, and nothing is handed to it unopened.
//
// Isomorphic: the WebSocket constructor is the global one (browsers, Node 22+) or injected; WebCrypto only.
import type { Dial, FeSocket, SocketHandlers } from "./link";
import { SessionLink, type DhKeyPair, type SessionEnd, type SessionTransport } from "../session";

/** What a paired device holds to dial its server (from the pairing, kept in the page's IndexedDB). */
export interface DeviceIdentity {
  cluster: string;
  /** The device's member id (from its signing key) and its X25519 pair (the private key non-extractable). */
  memberId: string;
  dh: DhKeyPair;
  /** The server's member id and X25519 public key (from the roster the pairing gave). */
  server: { memberId: string; dhPub: Uint8Array };
}

export interface WsDialOptions {
  /** The `/v3/ws` URL (ws: or wss:), read at each dial. */
  url: () => string;
  identity: DeviceIdentity;
  /** Default: the global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
  /** Told how each session ended (a `roster` end after a revoke means "pair this device again"). */
  onEnd?: (end: SessionEnd) => void;
  /** Told of every session frame received (diagnostics: frame rates). */
  onFrame?: (bytes: number) => void;
  /** The browser's network state (a page passes `navigator.onLine` and `window`): while it says offline no socket is
   * opened, and its `offline` event ends the open one at once instead of waiting for the socket to notice. Some
   * engines (WebKit) keep an open WebSocket through an offline switch, so the page would otherwise look live. */
  network?: { online(): boolean; events: EventTarget };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** How long a closed socket waits for the frames it already received to be opened (see `onclose`). */
const CLOSE_DRAIN_MS = 2_000;

/** A dial that opens one encrypted session per connection. */
export function wsDial(options: WsDialOptions): Dial {
  const Impl = options.WebSocketImpl ?? globalThis.WebSocket;
  return (handlers: SocketHandlers): FeSocket => {
    let closed = false;
    const queue: Uint8Array[] = [];
    let ws: WebSocket;
    const network = options.network;
    if (network && !network.online()) {
      queueMicrotask(() => handlers.close("the browser is offline"));
      return { send() { /* closed */ }, close() { /* closed */ } };
    }
    try {
      ws = new Impl(options.url());
    } catch (error) {
      // A bad URL (or a page offline before the socket exists): the link sees a closed connection and backs off.
      queueMicrotask(() => handlers.close(String((error as Error)?.message ?? error)));
      return { send() { /* closed */ }, close() { /* closed */ } };
    }
    ws.binaryType = "arraybuffer";
    const transport: SessionTransport = {
      send(frame) {
        if (ws.readyState === 1) ws.send(frame);
        else if (ws.readyState === 0) queue.push(frame.slice());
      },
      close() { try { ws.close(); } catch { /* already closed */ } },
    };
    const onOffline = () => { finish("the browser went offline"); link.close(); };
    const finish = (detail: string) => {
      if (closed) return;
      closed = true;
      network?.events.removeEventListener("offline", onOffline);
      try { ws.close(); } catch { /* already closed */ }
      handlers.close(detail);
    };
    const identity = options.identity;
    const link = SessionLink.initiate(transport, {
      mode: "ik", transport: "tailnet", cluster: identity.cluster,
      self: { memberId: identity.memberId, dhPub: identity.dh.publicKey, dhKey: identity.dh.privateKey },
      responder: { memberId: identity.server.memberId, dhPub: identity.server.dhPub },
    }, {
      onFrame: (plaintext) => { if (!closed) handlers.frame(decoder.decode(plaintext)); },
      onEnd: (end) => { options.onEnd?.(end); finish(`${end.reason}: ${end.detail}`); },
    });
    network?.events.addEventListener("offline", onOffline);
    link.established.then(() => { if (!closed) handlers.open(); }, () => undefined);
    ws.onopen = () => { for (const frame of queue.splice(0)) ws.send(frame); };
    ws.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) { link.close(); return; }
      options.onFrame?.(event.data.byteLength);
      link.receive(new Uint8Array(event.data));
    };
    // Frames that arrived before the close are still being opened (WebCrypto is asynchronous): the last one is often
    // the server's `bye` (why it closes). Let them through first, for at most CLOSE_DRAIN_MS.
    ws.onclose = () => {
      const settled = () => { link.transportClosed(); finish("closed"); };
      void Promise.race([link.received(), new Promise<void>((resolve) => setTimeout(resolve, CLOSE_DRAIN_MS))]).then(settled);
    };
    ws.onerror = () => undefined;
    return {
      send(frame: string) {
        if (closed || link.state === "ended") return;
        link.send("control", encoder.encode(frame));
      },
      close() {
        if (closed) return;
        link.close();
        finish("closed by the front end");
      },
    };
  };
}

/** The `/v3/ws` URL beside a page at `pageUrl` (http → ws, https → wss). */
export function wsUrlFor(pageUrl: string): string {
  const url = new URL("/v3/ws", pageUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.hash = "";
  url.search = "";
  return url.href;
}
