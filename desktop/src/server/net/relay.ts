// botlingd's room on the relay (M2 step 13, protocol v1 §6.3, §9A.4, D22, D36): the 2.x blind relay (relay/), unchanged,
// carries device sessions when the tailnet is not there. botlingd is the room's "desktop" side of the relay protocol:
//
//   botlingd → relay  {t:'desk', v:1, key}  {t:'allow', tokens:[{h, exp?}]}  {t:'to', peer, d}  {t:'kick', peer}
//   relay → botlingd  {t:'ready', room}  {t:'open', peer, h}  {t:'from', peer, d}  {t:'close', peer}
//
// - The room key lives in the data folder (`relay-room.key`, 0600; made on first use): the same room across restarts,
//   so a device's `{url, room}` from its pairing offer keeps working. The key never leaves botlingd and the relay.
// - Allow list: the join tokens of the valid devices, valid peer servers (!== self) and pending pairing offers
//   (src/session/relay-wire.ts says how they are derived; none is stored). It is sent again on every roster or offer
//   change; a member that leaves the roster leaves the list and the relay closes its connection at once.
// - Each relay peer is routed by its first frame (SessionRouter, transport kind `relay`: device, peer server, or join;
//   device content uses 128 KiB chunks and the 1 MiB content window); its frames are base64url text in `d`. Nothing is
//   parsed here: a `d` that is not base64url ends that peer.
// - Everything botlingd sends to the relay goes through the pacer (pacing.ts): ≤ 45 messages/s, burst 150, control and
//   live first, content ≤ 30/s. The sessions' links hold their frames while the pacer's channel is full.
// - The connection is re-opened after a loss with a backoff (1 s doubling to 30 s, with jitter); the sessions on it
//   end (their transports closed) and the devices dial again and resume from their cursors.
// - Never the online relay in tests: the URL comes only from settings (BOTLING_SERVER_RELAY_URL).
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { WebSocket } from "ws";
import { frameFromText, frameToText, newRelayRoomKey, relayRoomOf, RELAY_CLOSE, RELAY_WIRE_VERSION, type Lane, type SessionTransport } from "../../session";
import { RelayPacer, type PaceStats, type RelayPacerOptions } from "./pacing";

/** The setting that turns the relay path on (a `ws:` or `wss:` URL of the relay's `/ws`). */
export const RELAY_URL_ENV = "BOTLING_SERVER_RELAY_URL";
/** The room key's file in the data folder. */
export const RELAY_KEY_FILE = "relay-room.key";
/** The relay's allow list takes at most this many tokens (relay.ts MAX_ALLOW). */
export const RELAY_MAX_ALLOW = 1_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** How long the relay may take to answer the room hello. */
const READY_TIMEOUT_MS = 10_000;
/** The largest text the relay forwards (its default MAX_FRAME_BYTES), with room for the JSON around `d`. */
const MAX_TEXT = 4 * 1024 * 1024 - 256;

/** Test knob (`BOTLING_SERVER_RELAY_BACKOFF_MS=<min>,<max>`): a shorter reconnect backoff. Never needed in use. */
export function relayTestOptions(env: Record<string, string | undefined>): { backoff?: { minMs: number; maxMs: number } } {
  const match = /^([0-9]{2,6}),([0-9]{2,6})$/.exec((env.BOTLING_SERVER_RELAY_BACKOFF_MS ?? "").trim());
  if (!match) return {};
  const minMs = Number(match[1]), maxMs = Number(match[2]);
  return minMs <= maxMs ? { backoff: { minMs, maxMs } } : {};
}

/** The configured relay URL, or null when the relay path is off. Throws on a malformed value. */
export function relayUrl(env: Record<string, string | undefined>): string | null {
  const text = (env[RELAY_URL_ENV] ?? "").trim();
  if (!text || text === "off") return null;
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`${RELAY_URL_ENV} takes a ws: or wss: URL, not "${text}"`); }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error(`${RELAY_URL_ENV} takes a ws: or wss: URL, not "${text}"`);
  if (url.hash || url.username || url.password) throw new Error(`${RELAY_URL_ENV} takes a plain ws: or wss: URL`);
  return url.href;
}

/** The origin a page must be allowed to connect to (CSP `connect-src`) for a relay URL. */
export function relayConnectOrigin(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

/** The room key from the data folder, made (0600) on first use. */
export function loadRelayRoomKey(file: string): string {
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8").trim();
    if (/^[A-Za-z0-9_-]{43}$/.test(text)) return text;
  }
  const key = newRelayRoomKey();
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}

/** An accepted relay session (SessionRouter.accept(transport, "relay")). */
export interface RelaySessionAcceptor {
  accept(transport: SessionTransport, kind: "relay"): {
    readonly link: { readonly established: Promise<unknown>; resume?(): void };
    receive(frame: Uint8Array): void;
    transportClosed(): void;
  };
}

export interface RelayConnectorOptions {
  url: string;
  roomKey: string;
  sessions: RelaySessionAcceptor;
  /** The allow list now: `{h, exp?}` per token (valid devices, pending offers). */
  allowList(): Promise<Array<{ h: string; exp?: number }>>;
  log: (line: string) => void;
  pace?: Omit<RelayPacerOptions, "write" | "buffered">;
  backoff?: { minMs: number; maxMs: number };
}

export type RelayState = "connecting" | "ready" | "down" | "closed";

interface Peer {
  id: string;
  session: ReturnType<RelaySessionAcceptor["accept"]>;
  closed: boolean;
}

export class RelayConnector {
  private ws: WebSocket | null = null;
  private pacer: RelayPacer | null = null;
  private readonly peers = new Map<string, Peer>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private closed = false;
  private allowSerial = 0;
  state: RelayState = "connecting";
  /** The room id (known before the first connection: the key's hash). */
  room: string | null = null;
  /** Totals over all connections (status, tests). */
  readonly counts = { connects: 0, readies: 0, peersOpened: 0, closes: [] as Array<{ code: number; reason: string; at: number }> };
  /** The last connection's pacer numbers (also kept after it closed). */
  lastPace: PaceStats | null = null;

  constructor(private readonly options: RelayConnectorOptions) {}

  async start(): Promise<void> {
    this.room = await relayRoomOf(this.options.roomKey);
    this.connect();
  }

  /** The pacer of the open connection (null while down). */
  get pace(): PaceStats | null { return this.pacer?.stats ?? this.lastPace; }
  get peerCount(): number { return this.peers.size; }

  private connect(): void {
    if (this.closed) return;
    this.state = "connecting";
    this.counts.connects++;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.options.url);
    } catch (error) {
      this.options.log(`relay: cannot open ${redact(this.options.url)}: ${String((error as Error)?.message ?? error)}`);
      this.retry();
      return;
    }
    this.ws = ws;
    const pacer = new RelayPacer({ ...this.options.pace, write: (text) => { if (ws.readyState === WebSocket.OPEN) ws.send(text, {}, () => pacer.kick()); }, buffered: () => ws.bufferedAmount });
    this.pacer = pacer;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      pacer.push(null, "control", JSON.stringify({ t: "desk", v: RELAY_WIRE_VERSION, key: this.options.roomKey }));
      this.readyTimer = setTimeout(() => { if (this.ws === ws && this.state !== "ready") { this.options.log("relay: no answer to the room hello"); ws.terminate(); } }, READY_TIMEOUT_MS);
      this.readyTimer.unref?.();
    });
    ws.on("message", (data, isBinary) => {
      if (this.ws !== ws) return;
      if (isBinary) { this.options.log("relay: a binary message; reconnecting"); ws.terminate(); return; }
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data).toString("utf8");
      this.message(text);
    });
    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      const why = reason.toString("utf8").slice(0, 100);
      this.counts.closes.push({ code, reason: why, at: Date.now() });
      if (this.counts.closes.length > 50) this.counts.closes.shift();
      this.down(`closed (${code}${why ? ` ${why}` : ""})`);
      if (code === RELAY_CLOSE.limited) this.options.log("relay: the relay closed this server's connection for its rate (this should not happen: the pacer keeps under it)");
      this.retry(code === RELAY_CLOSE.replaced ? BACKOFF_MAX_MS : undefined);
    });
    ws.on("error", (error) => { this.options.log(`relay: ${error.message}`); });
  }

  private message(text: string): void {
    let msg: { t?: unknown; peer?: unknown; d?: unknown; room?: unknown };
    try { msg = JSON.parse(text) as typeof msg; } catch { this.options.log("relay: a message that is not JSON; reconnecting"); this.ws?.terminate(); return; }
    switch (msg.t) {
      case "ready": {
        if (this.readyTimer) clearTimeout(this.readyTimer);
        if (msg.room !== this.room) { this.options.log("relay: the room it opened is not this key's; reconnecting"); this.ws?.terminate(); return; }
        this.state = "ready";
        this.failures = 0;
        this.counts.readies++;
        this.options.log(`relay: room open on ${redact(this.options.url)}`);
        void this.refreshAllow();
        return;
      }
      case "open": {
        if (typeof msg.peer !== "string" || this.state !== "ready") return;
        this.openPeer(msg.peer);
        return;
      }
      case "from": {
        if (typeof msg.peer !== "string" || typeof msg.d !== "string") return;
        const peer = this.peers.get(msg.peer);
        if (!peer) return;
        const frame = frameFromText(msg.d);
        if (!frame) { this.kick(peer); return; }
        peer.session.receive(frame);
        return;
      }
      case "close": {
        if (typeof msg.peer !== "string") return;
        const peer = this.peers.get(msg.peer);
        if (peer) this.peerGone(peer);
        return;
      }
      case "pong": return;
      default: this.options.log(`relay: an unknown message ${String(msg.t).slice(0, 20)}`);
    }
  }

  private openPeer(id: string): void {
    const old = this.peers.get(id);
    if (old) this.peerGone(old);
    const pacer = this.pacer!;
    let peer!: Peer;
    const transport: SessionTransport = {
      send: (frame: Uint8Array, lane?: Lane) => {
        if (peer.closed) return;
        const d = frameToText(frame);
        if (d.length > MAX_TEXT) { this.options.log("relay: a frame too large for the relay; ending that session"); this.kick(peer); return; }
        pacer.push(id, lane === "bulk" ? "bulk" : "control", JSON.stringify({ t: "to", peer: id, d }));
      },
      close: () => { if (!peer.closed) this.kick(peer); },
      writable: () => {
        if (peer.closed) return true;
        const ok = pacer.writable(id);
        if (!ok) pacer.onWritable(id, () => { if (!peer.closed) peer.session.link.resume?.(); });
        return ok;
      },
    };
    peer = { id, session: null as unknown as Peer["session"], closed: false };
    this.peers.set(id, peer);
    this.counts.peersOpened++;
    peer.session = this.options.sessions.accept(transport, "relay");
  }

  /** Ends a peer: its frames still queued go first, then `kick` (the relay closes the device's connection). */
  private kick(peer: Peer): void {
    if (peer.closed) return;
    peer.closed = true;
    this.peers.delete(peer.id);
    const pacer = this.pacer;
    if (pacer && this.state === "ready") pacer.push(peer.id, "control", JSON.stringify({ t: "kick", peer: peer.id }), () => pacer.drop(peer.id));
    peer.session.transportClosed();
  }

  /** The relay says the peer left. */
  private peerGone(peer: Peer): void {
    if (peer.closed) { this.pacer?.drop(peer.id); return; }
    peer.closed = true;
    this.peers.delete(peer.id);
    this.pacer?.drop(peer.id);
    peer.session.transportClosed();
  }

  private down(why: string): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    if (this.pacer) { this.lastPace = { ...this.pacer.stats }; this.pacer.stop(); }
    this.pacer = null;
    this.ws = null;
    if (this.state !== "closed") this.state = "down";
    for (const peer of [...this.peers.values()]) { peer.closed = true; peer.session.transportClosed(); }
    this.peers.clear();
    if (!this.closed) this.options.log(`relay: ${why}`);
  }

  private retry(floorMs?: number): void {
    if (this.closed || this.timer) return;
    const backoff = this.options.backoff ?? { minMs: BACKOFF_MIN_MS, maxMs: BACKOFF_MAX_MS };
    const base = Math.min(backoff.maxMs, backoff.minMs * 2 ** Math.min(this.failures, 10));
    this.failures++;
    const ms = Math.max(floorMs ?? 0, Math.round(base * (0.75 + Math.random() * 0.5)));
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, Math.min(ms, backoff.maxMs));
    this.timer.unref?.();
  }

  /** Sends the allow list again (roster or offers changed). The newest call wins. */
  async refreshAllow(): Promise<void> {
    if (this.state !== "ready" || !this.pacer) return;
    const serial = ++this.allowSerial;
    let tokens: Array<{ h: string; exp?: number }>;
    try { tokens = await this.options.allowList(); } catch (error) { this.options.log(`relay: allow list: ${String((error as Error)?.message ?? error)}`); return; }
    if (serial !== this.allowSerial || this.state !== "ready" || !this.pacer) return;
    if (tokens.length > RELAY_MAX_ALLOW) { this.options.log(`relay: ${tokens.length} tokens; only the first ${RELAY_MAX_ALLOW} are listed`); tokens = tokens.slice(0, RELAY_MAX_ALLOW); }
    this.pacer.push(null, "control", JSON.stringify({ t: "allow", tokens }));
  }

  /** Waits (at most `ms`) for what is queued (the sessions' `bye`s) to leave, then closes. */
  async closeAfterDrain(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (this.pacer && this.pacer.stats.waiting > 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
    this.close();
  }

  /** Leaves the room: the sessions on it end, no reconnect. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.down("closed by botlingd");
    this.state = "closed";
    if (ws) { try { ws.close(1000, "botlingd is stopping"); } catch { /* gone */ } setTimeout(() => ws.terminate(), 1_000).unref?.(); }
  }
}

/** A relay URL for the log: scheme, host and path only. */
export function redact(url: string): string {
  try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}${parsed.pathname}`; } catch { return "the relay"; }
}
