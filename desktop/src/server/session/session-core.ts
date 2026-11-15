// The session core (M2 step 4, protocol v1 §5.2, §8.3, §9, §11, §13.1): what one front end's session does whatever
// carries it. The local socket (session.ts, M1's behaviour) and a remote device's encrypted session (remote-session.ts)
// are thin shells around it: they decode frames, authenticate the hello and write frames their own way.
//
//   hello (first frame; checked by the shell)                → welcome {serverId, protocol, next for this origin…};
//                                                              the hello's outbox is taken as commands
//   sub / unsub / ack / history                              → LogHub (bot streams and this server's `srv:` stream);
//                                                              a bot stream's live frames come from the live channel,
//                                                              through the connection's LiveGate (≤ 10 frames/s)
//   live.resync                                              → a whole-segment frame (through the gate)
//   cmd                                                      → IntentRuntime, under the scope the shell states;
//                                                              cmd.result / cmd.retry come back through the reply sink.
//                                                              One queue's commands run one after another, in the
//                                                              order the session carried them (D58); a copy the owner
//                                                              could not keep (a gap it would wait on forever), or
//                                                              could not settle (the store failed, a handler threw),
//                                                              ends the session with bye{unsettled}, so the front end
//                                                              re-sends from its outbox
//   cancel                                                   → SlotEngine.cancel, always answered (D59): the stored
//                                                              cmd.result when too late (also once the slot's handler
//                                                              began: it waits for that outcome), else cancel.noted;
//                                                              a cancel that cannot be committed ends the session the
//                                                              same way
//   req                                                      → the reads the shell allows, answered by the engine (`res`)
//   content.find / content.open, shell.done                  → local socket only (the role table refuses them elsewhere)
//   content.put / content.chunk                              → uploads (M2 step 12, server/content/put.ts), in order;
//                                                              a `chat.send` naming uploaded files is `held` until
//                                                              their bytes are in and checked, then applied once
//   admin                                                    → local socket only: pairing, the cluster's recovery code,
//                                                              devices (M2 step 5, server/pairing); the session then
//                                                              hears `admin.event`s. Requests and answers are never
//                                                              logged (they carry the recovery code and pairing links).
//   ping                                                     → nothing (any frame counts as heard)
//
// botlingd pings after 15 s of its own silence and drops a session it has not heard from for 45 s (§5.2; fe-link does
// the same the other way).
import { ContractError, type Command, type CommandType } from "../../contract";
import { encodeFrame, encodeResFrames, encodeWireFrame, PROTOCOL_VERSION, toBase64Url, type Cursor, type ServerAddresses, type ServerState, type VapidKeyId, type WelcomeServer, type WireMessage, queueKey, type AdminEvent, type AdminOp, type CmdBody, type Message, type MessageOf, type Scope, type SessionKind, type Slot, type StreamId } from "../../protocol";
import { DEAD_AFTER_MS, PING_AFTER_MS } from "../../session";
import type { TurnEngine } from "../effects";
import { routeOf, type IntentRuntime } from "../intents";
import { cancelAnswer } from "../slots";
import { readStream, type LogHub, type LogReader } from "../log";
import type { LocalPeerReads, LocalPeerReadSink } from "../content/local-peer-read";
import type { LocatedRef } from "../content/peer-content";
import type { LiveChannel, LiveSubscription } from "../live";
import { peerAddresses } from "../peer/config";
import type { RosterView } from "../roster";
import type { ShellBridge } from "../shell-bridge";
import { LiveGate, type LiveGateClock } from "./live-gate";

/**
 * Commands a front end may send as `req` (answered at once, no slot): every read command, and the ones the 2.x renderer
 * sends as reads although the core changes a little for them: unread marks (chat.read, chat.shown), a Doctor run, a
 * worker's folder, a link a line asked to open, a plugin web part's reports (loaded, failed, notice, link target;
 * kept in memory), and plugin secret edits (so plaintext never touches a front-end durable outbox). Nothing they change
 * is chat history; their events still go into the log. commands.ts classes them `legacy` for when they come as a `cmd`.
 */
export const REQ_ALSO: ReadonlySet<CommandType> = new Set<CommandType>([
  "chat.read", "chat.shown", "doctor.run", "worker.cwd", "link.authorize", "plugins.linkTarget", "plugins.loaded", "plugins.failed", "plugins.notice",
  "plugins.secret",
]);
export function servedAsReq(type: CommandType): boolean {
  return routeOf(type).kind === "read" || REQ_ALSO.has(type);
}

/** The content path's local part (step 13, src/server/content `ContentService.handle`). */
export interface ContentHandler {
  handle(message: MessageOf<"content.find"> | MessageOf<"content.open">): Promise<MessageOf<"content.found"> | MessageOf<"content.file"> | MessageOf<"content.gone">>;
}

/** Pairing and devices for the local socket's `admin` requests (server/pairing). */
export interface AdminHost {
  /** The `res` result of one request; throws (with an optional `code`) to refuse it. */
  handle(op: AdminOp, session?: object): Promise<unknown>;
  onEvent(listener: (event: AdminEvent) => void): () => void;
  /** M4-46 (J8): called when a local admin session closes so its open offers/attempts are cancelled. */
  sessionClosed?(session: object): void;
}

/** What every session shares: botlingd's parts. */
export interface SessionHost {
  serverId: string;
  /** Shown in `welcome.servers` (this Mac). */
  serverName: string;
  startedAt: number;
  minFeVersion: string;
  /** The local token as it is now (§6.1). */
  token(): string;
  hub: LogHub;
  live: LiveChannel;
  runtime: IntentRuntime;
  engine: TurnEngine;
  content: ContentHandler | null;
  shell: ShellBridge;
  /** `slots.next` per target for one origin incarnation (welcome.next, §11.4). */
  nextFor(origin: string, originEpoch: string): Record<string, number>;
  /** A bot the engine has whose stream is not made yet: make it (true: the stream exists now). */
  ensureBotStream(botId: string): Promise<boolean>;
  log(text: string): void;
  /** Local `admin` requests (M2 step 5); without it they are answered with an error. */
  admin?: AdminHost;
  /** M3 step 7: peer servers' states and their `srv:` tables from this server's copies (none on a lone server). */
  tables?: SessionTables;
  /** M3 step 9: commands and cancels for targets a peer owns go to the forward queue (none on a lone server). */
  forward?: SessionForward;
  /** M3 step 8: subscriptions to bots a peer owns pass through to that peer (none on a lone server). */
  passThrough?: SessionPassThrough;
  /** M2 step 12: uploads (`content.put` + chunks); a `chat.send` naming files waits for their bytes (held). */
  uploads?: SessionUploads;
  /** M4-01a: local socket reads of a peer's content (`content.get` / `.credit` / `.cancel`). */
  peerReads?: () => LocalPeerReads | null;
  /** M4-01a: local socket `content.find` fallback for a peer bot's line (`LOCAL_WINDOW`). */
  peerLocate?: (message: MessageOf<"content.locate">) => Promise<LocatedRef | null>;
  /** D70: roster + own DH key for filling `dh` and K12 Profile `addresses` on `welcome.servers` and `peer`. */
  roster?: SessionRoster;
  self?: { readonly dhPub: Uint8Array };
  /** M4-26 (§18.4, Q-P3/F3): current cluster VAPID public key + `(gen, id)` read atomically for remote `welcome`. */
  vapidKey?: () => { publicKey: string; id: VapidKeyId } | null;
  /** M4-26 / M4-25 fallback when only `vapidPublicKey` is wired on a host. */
  vapidPublicKey?: () => string | null;
}

/** Shared subset of `RosterView` used by session hosts and remote rosters. */
export type SessionRosterView = Pick<RosterView, "valid" | "revoked" | "members">;

/** Optional roster view and K12 profile reader used to populate `welcome.servers` and `peer` (D70). */
export interface SessionRoster {
  readonly clusterId?: string | null;
  readonly view?: SessionRosterView;
  profile?(member: string, field: "addresses"): string | null;
}

/** server/content/put.ts `Uploads` as a session uses it. */
export interface SessionUploads {
  complete(id: string): { path: string; size: number } | null;
  whenComplete(ids: string[], closed: Promise<void>, idleMs?: number): Promise<"ready" | "closed" | "idle" | "refused">;
  put(owner: string, message: MessageOf<"content.put">): Promise<Message[]>;
  chunk(owner: string, message: MessageOf<"content.chunk">): Promise<Message[]>;
  ended(owner: string): Promise<void>;
}

/**
 * Pass-through as a front end's session uses it (server/replica/pass-through.ts, v1 §10.3): a `sub` of a bot a peer owns
 * becomes a leg forwarded to that owner; its frames come back unchanged (no `via`) through `sink`; `ack` and `unsub` go to
 * the leg; `history` is asked of the owner. Never the log hub: this server builds no state of a peer's bot.
 */
export interface SessionPassThrough {
  isPeerStream(stream: string): boolean;
  /** `live` gets the running turn's live frames from the owner (no `via`); the leg's `liveResync` asks the owner again. */
  open(stream: string, cursor: Cursor | null, sink: (message: Message) => boolean, live?: (frame: MessageOf<"live">) => void): { ack(cursor: Cursor): void; liveResync?(): void; close(): void };
  history(request: MessageOf<"history">, sink: (message: Message) => boolean): void;
}

/**
 * Forwarding as a front end's session uses it (server/forward). A target a peer owns is committed into `forwardq` and
 * answered `held{slot, at: this server}`; this server never answers it with an outcome of its own (D58, F3). The
 * owner's `cmd.result` / `cmd.retry` / `cancel.noted` come back through `attach` to every open session of the origin.
 */
export interface SessionForward {
  /** The peer that owns `target`, or null when this server decides it (also every target on a lone server). */
  ownerOf(target: string): string | null;
  /** Commits the command (scope stated) for `owner`; resolves after the commit. */
  commit(envelope: CmdBody, owner: string): Promise<void>;
  /** Commits the cancel for `owner`; resolves after the commit. */
  cancel(slot: MessageOf<"cancel">["slot"], owner: string): Promise<void>;
  attach(origin: string, sink: (message: Message) => boolean): () => void;
}

/** What a front end's session reads of peer servers and their tables (server/replica/peer-tables.ts, server/peer). */
export interface SessionTables {
  /** Every peer server as `welcome.servers` lists it. */
  peers(): Array<{ id: string; name: string; state: ServerState; since: number | null; dh?: string; addresses?: ServerAddresses }>;
  /** A peer's state changed (`peer{serverId, state, since}` to front ends, §10.5). */
  onPeer(listener: (peer: { id: string; state: ServerState; since: number | null; dh?: string; addresses?: ServerAddresses }) => void): () => void;
  /** A peer's `srv:` table, served from this server's copy (not the log hub). */
  isPeerTable(stream: string): boolean;
  /**
   * This server's own `srv:` table stream (M5-14e). A front end that subs it gets the log as always and, besides, the
   * table's `plugin:` rows as `rows` frames (`ownTableFrame`), so a page attached to one server reads its plugins as it
   * reads a peer's. Absent: no rows (a host without table feeds).
   */
  isOwnTable?(stream: string): boolean;
  subscribe(stream: string, cursor: Cursor | null, sink: (message: WireMessage) => boolean): { close(): void };
}

/** The kinds of own-table rows a front end gets (M5-14e); the table's other rows (`machine`, `settings`, `audit:`, `bot:`) stay on the log path. */
const OWN_ROW_PREFIXES = ["plugin:"] as const;

/**
 * What of the own table's feed a front end gets: `rows` frames cut to the `plugin:` rows (`after`/`to` stay, so the
 * reader's rev still moves); anything else of the feed (its `reset`, which the log path sends itself) is dropped.
 */
export function ownTableFrame(frame: WireMessage): WireMessage | null {
  if (frame.t !== "rows") return null;
  return { ...frame, rows: frame.rows.filter((row) => OWN_ROW_PREFIXES.some((prefix) => row.key.startsWith(prefix))) };
}

export interface SessionOptions {
  helloTimeoutMs?: number;
  pingAfterMs?: number;
  deadAfterMs?: number;
  /** Bytes waiting to be written (socket buffer, or a remote session's send queue) above which the session is dropped. */
  maxBuffered?: number;
  liveIntervalMs?: number;
  liveClock?: LiveGateClock;
  /** A held `chat.send` waits this long without a new byte of its files before its handler decides (UPLOAD_IDLE_MS). */
  uploadIdleMs?: number;
}

/** §5.2: `ping` after 15 s of silence, dead after 45 s heard nothing (the session layer's constants, step 3). */
export { DEAD_AFTER_MS, PING_AFTER_MS };
export const HELLO_TIMEOUT_MS = 10_000;
export const MAX_BUFFERED = 32 * 1024 * 1024;

/** A refusal the shell gives for a frame: a `bye` reason and its detail. */
export interface ShellRefusal { reason: MessageOf<"bye">["reason"]; detail: string }

export abstract class SessionCore {
  protected readonly lives = new Map<string, LiveSubscription>();
  protected readonly gate: LiveGate;
  protected reader: LogReader | null = null;
  protected state: "hello" | "open" | "closed" = "hello";
  protected deviceId: string | null = null;
  protected lastHeard = Date.now();
  protected lastSent = Date.now();
  private readonly timers: Array<ReturnType<typeof setTimeout>> = [];
  private readonly closedHandlers: Array<() => void> = [];
  /** Serializes `sub`s, so a slow one (a rewind, a new bot stream) never lets a later frame on the same stream pass it. */
  private subChain: Promise<void> = Promise.resolve();
  /** One promise chain per command queue (D58, `queueCmd`). */
  private readonly cmdChains = new Map<string, Promise<void>>();
  private adminEvents: (() => void) | null = null;
  /** M3 step 7: feeds of peers' tables this front end subscribed to, and its listener of peer states. */
  private readonly tableFeeds = new Map<string, { close(): void }>();
  /** M5-14e: the `plugin:` rows of this server's own table, by stream (`srv:<self>`), served beside the log `sub`. */
  private readonly ownFeeds = new Map<string, { close(): void }>();
  /** M3 step 8: this front end's pass-through legs, by stream. */
  private readonly legs = new Map<string, { ack(cursor: Cursor): void; liveResync?(): void; close(): void }>();
  private peerEvents: (() => void) | null = null;
  /** M3 step 9: this session hears the owners' answers to its forwarded slots. */
  private relayOff: (() => void) | null = null;
  /** Settles when the session closes (a cancel waiting on a running handler stops waiting for this session). */
  private readonly closedSignal: Promise<void>;
  /** M2 step 12: this session's upload frames, handled one after another in the order they came (D58). */
  private uploadChain: Promise<void> = Promise.resolve();
  /** Who this session's uploads belong to (a session-unique key). */
  private readonly uploadOwner = `s-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

  /** The session kind frames are encoded and decoded for (local socket or not). */
  protected abstract readonly kind: SessionKind;

  protected constructor(protected readonly host: SessionHost, protected readonly options: SessionOptions = {}) {
    this.gate = new LiveGate((frame) => this.send(frame, streamOf(frame)), { intervalMs: options.liveIntervalMs ?? 100, ...(options.liveClock ? { clock: options.liveClock } : {}) });
    this.closedSignal = new Promise<void>((resolve) => this.closedHandlers.push(resolve));
  }

  get device(): string | null { return this.deviceId; }
  get isOpen(): boolean { return this.state === "open"; }

  onClosed(handler: () => void): void { this.closedHandlers.push(handler); }

  // ---------------------------------------------------------------------------------------------
  // What a shell provides

  /** False when nothing can be written any more (the transport is gone). */
  protected abstract get writable(): boolean;
  /** Writes encoded text frames in order, whole or not at all; false when they were not written. */
  protected abstract writeTexts(texts: string[], t: string, what?: string): boolean;
  /** Writes one binary `content.chunk` frame (local socket only); false when it was not written. */
  protected writeChunk?(_message: MessageOf<"content.chunk">): boolean;
  /** After a `bye`: lets what was written leave, then ends the transport. */
  protected abstract endTransport(): void;
  /** On close: drops the transport (unless endTransport is already letting it go). */
  protected abstract destroyTransport(): void;
  /** Checks the hello (who may open this session); a refusal ends it with that `bye`. */
  protected abstract checkHello(hello: MessageOf<"hello">): ShellRefusal | null;
  /** The scope this server states for a front end's command (§11.1), or a refusal that ends the session. */
  protected abstract cmdScope(body: CmdBody): { scope: Scope } | ShellRefusal;
  /** Why this `req` is not answered here (an error `res`), or null. */
  protected abstract reqRefusal(cmd: Command): { code: "bad_request" | "forbidden"; message: string } | null;
  /** Checked before every frame once the hello came (remote: the device is still valid); a refusal ends the session. */
  protected frameRefusal(): ShellRefusal | null { return null; }
  /** Why this stream may not be read here, or null. */
  protected subRefusal(_stream: StreamId): string | null { return null; }
  /** After the welcome went. */
  protected opened(_hello: MessageOf<"hello">): void {}
  /** On close, before the handlers run. */
  protected closing(): void {}

  // ---------------------------------------------------------------------------------------------
  // Sending

  /** Starts the hello timeout and the keepalive (ping after 15 s of silence, dead after 45 s heard nothing). */
  protected startTimers(): void {
    const helloTimer = setTimeout(() => { if (this.state === "hello") this.bye("malformed", "hello first, within 10 s"); }, this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    helloTimer.unref?.();
    this.timers.push(helloTimer);
    const keepalive = setInterval(() => this.keepalive(), Math.min(5_000, Math.max(50, Math.floor((this.options.pingAfterMs ?? PING_AFTER_MS) / 3))));
    keepalive.unref?.();
    this.timers.push(keepalive);
  }

  /**
   * Sends one frame; false when it was not sent (the session is closed, or the frame cannot be encoded). A frame that
   * cannot be encoded (over the frame limit, malformed) is never written: the refusal is logged with its reason and
   * `what` (the request it answers, when there is one).
   */
  send(message: Message, what?: string): boolean {
    if (this.state === "closed" || !this.writable) return false;
    const encoded = encodeFrame(message, "server", this.kind);
    if (!encoded.ok) {
      this.host.log(`session: cannot send ${message.t}${what ? ` (${what})` : ""}: ${encoded.detail}`);
      return false;
    }
    return this.writeTexts([encoded.text], message.t, what);
  }

  /** Sends a frame of the M3 wire set (a `rows` batch of a peer's table, §8.2); false when it was not sent. */
  protected sendWire(message: WireMessage): boolean {
    if (this.state === "closed" || !this.writable) return false;
    const encoded = encodeWireFrame(message, "server", this.kind);
    if (!encoded.ok) { this.host.log(`session: cannot send ${message.t}: ${encoded.detail}`); return false; }
    return this.writeTexts([encoded.text], message.t);
  }

  /**
   * Answers a `req`. A result over the frame limit goes as `res.part`s (the front end joins them); one too large even
   * for those is answered with an error naming the command, so the front end's request ends instead of waiting.
   */
  protected sendRes(message: MessageOf<"res">, command: string): boolean {
    if (this.state === "closed" || !this.writable) return false;
    const encoded = encodeResFrames(message, "server", this.kind);
    if (encoded.ok) return this.writeTexts(encoded.texts, encoded.texts.length > 1 ? "res.part" : "res", command);
    this.host.log(`session: cannot send res (${command}): ${encoded.detail}`);
    if (!message.ok) return false;
    return this.send({ t: "res", req: message.req, ok: false, error: { code: "internal", message: `The answer to ${command} is too large to send: ${encoded.detail}`.slice(0, 2_000) } }, command);
  }

  /** Ends the session with a `bye` (§5.2). */
  bye(reason: MessageOf<"bye">["reason"], detail?: string, slot?: Slot): void {
    if (this.state === "closed") return;
    this.send({ t: "bye", reason, ...(detail ? { detail: detail.slice(0, 500) } : {}), ...(slot ? { slot } : {}) });
    this.endTransport();
    this.close();
  }

  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.adminEvents?.();
    this.adminEvents = null;
    this.peerEvents?.();
    this.peerEvents = null;
    this.relayOff?.();
    this.relayOff = null;
    for (const feed of this.tableFeeds.values()) feed.close();
    this.tableFeeds.clear();
    for (const feed of this.ownFeeds.values()) feed.close();
    this.ownFeeds.clear();
    for (const leg of this.legs.values()) leg.close();
    this.legs.clear();
    for (const timer of this.timers) { clearTimeout(timer); clearInterval(timer); }
    for (const sub of this.lives.values()) sub.close();
    this.lives.clear();
    this.gate.close();
    this.reader?.close();
    this.reader = null;
    if (this.kind.local) {
      this.host.peerReads?.()?.closeSession(this);
      this.host.admin?.sessionClosed?.(this);
    }
    this.closing();
    const uploads = this.host.uploads;
    if (uploads) void this.uploadChain.then(() => uploads.ended(this.uploadOwner)).catch(() => undefined);
    this.destroyTransport();
    for (const handler of this.closedHandlers.splice(0)) handler();
  }

  private keepalive(): void {
    if (this.state !== "open") return;
    const now = Date.now();
    if (now - this.lastHeard > (this.options.deadAfterMs ?? DEAD_AFTER_MS)) { this.bye("dead", "nothing heard for 45 s"); return; }
    if (now - this.lastSent >= (this.options.pingAfterMs ?? PING_AFTER_MS)) this.send({ t: "ping", at: now });
  }

  // ---------------------------------------------------------------------------------------------
  // Receiving

  /** One decoded frame from the front end. */
  protected onMessage(message: Message): void {
    if (this.state === "hello") {
      if (message.t !== "hello") { this.bye("role", "hello first"); return; }
      this.onHello(message);
      return;
    }
    const refused = this.frameRefusal();
    if (refused) { this.bye(refused.reason, refused.detail); return; }
    switch (message.t) {
      case "hello": this.bye("role", "one hello per session"); return;
      case "sub": this.queueSub(message.stream, message.cursor); return;
      case "unsub": this.unsub(message.stream); return;
      case "ack": { const leg = this.legs.get(message.stream); if (leg) leg.ack(message.cursor); else this.reader?.ack(message.stream, message.cursor); return; }
      case "history": this.history(message); return;
      case "live.resync": this.gate.resync(message.stream); return;
      case "cmd": { const { t: _t, ...body } = message; this.queueCmd(body as CmdBody); return; }
      case "cancel": this.queueCancel(message); return;
      case "req": void this.req(message); return;
      case "content.find": case "content.open": void this.content(message); return;
      case "content.get": case "content.credit": case "content.cancel":
        if (!this.kind.local) { this.host.log(`session: ${message.t} is not served here`); return; }
        this.peerRead(message);
        return;
      case "content.put": case "content.chunk": this.queueUpload(message); return;
      case "admin": void this.admin(message); return;
      case "push.subscribe": if (this.kind.local) this.bye("role", "push.subscribe is only for a remote device session"); return;
      case "shell.done": this.host.shell.answer(this.shellWindow(), message); return;
      case "ping": return;
      case "bye": this.close(); return;
      default: this.host.log(`session: ${message.t} is not served here`);
    }
  }

  /**
   * A shell's handling of one decoded frame threw. A `cmd` or `cancel` that was not settled ends the session (D58): the
   * front end re-sends from its outbox; anything else is logged and the session goes on.
   */
  protected frameFailed(message: Message, error: unknown): void {
    this.host.log(`session: ${message.t} failed: ${errorText(error)}`);
    if (message.t === "cmd" || message.t === "cancel") this.unsettled(`${message.t} for slot ${message.slot.n} failed: ${errorText(error)}`, message.slot);
  }

  /** D58 / D67: a `cmd` or `cancel` this session carried could not be settled: end the session with `bye{unsettled, slot}`, the outbox re-sends. */
  private unsettled(detail: string, slot?: Slot): void {
    if (this.state === "open") this.bye("unsettled", detail, slot);
  }

  /** The window the shell bridge knows this session as (the local session itself). */
  protected shellWindow(): { send(message: Message): boolean } { return this; }

  private onHello(hello: MessageOf<"hello">): void {
    const refused = this.checkHello(hello);
    if (refused) { this.bye(refused.reason, refused.detail); return; }
    this.state = "open";
    this.deviceId = hello.deviceId;
    this.reader = this.host.hub.attach((message) => { this.send(message, streamOf(message)); this.onLogFrame(message); });
    let next: Record<string, number> = {};
    try { next = this.host.nextFor(hello.deviceId, hello.originEpoch); } catch (error) { this.host.log(`session: next for ${hello.deviceId}: ${errorText(error)}`); }
    let vapidPublicKey: string | null = null;
    let vapidId: VapidKeyId | undefined;
    if (!this.kind.local) {
      try {
        const key = this.host.vapidKey?.();
        if (key) {
          vapidPublicKey = key.publicKey;
          vapidId = key.id;
        } else {
          vapidPublicKey = this.host.vapidPublicKey?.() ?? null;
        }
      } catch (error) {
        this.host.log(`session: vapidKey: ${errorText(error)}`);
      }
    }
    this.send({
      t: "welcome", serverId: this.host.serverId, protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION }, minFeVersion: this.host.minFeVersion,
      rosterDigest: null, servers: [this.selfServerEntry(), ...this.peerList()], next, views: {},
      ...(vapidPublicKey ? { vapidPublicKey } : {}),
      ...(vapidPublicKey && vapidId ? { vapidId } : {}),
    } as MessageOf<"welcome">);
    const tables = this.host.tables;
    if (tables) this.peerEvents = tables.onPeer((peer) => { this.send(this.peerMessage(peer)); });
    if (this.host.forward) this.relayOff = this.host.forward.attach(hello.deviceId, (message) => this.send(message));
    this.opened(hello);
    // `cursors` / `want`: fe-link sends a `sub` for each after the welcome (§13.1); taking both would send two snaps.
    for (const body of hello.outbox) this.queueCmd(body);
  }

  // ---------------------------------------------------------------------------------------------
  // Streams

  /** D70: this server's own `welcome.servers` entry, with `dh` and K12 Profile `addresses` when available. */
  private selfServerEntry(): WelcomeServer {
    const id = this.host.serverId;
    const view = this.host.roster?.view;
    const dh = this.host.self?.dhPub ? toBase64Url(this.host.self.dhPub) : view?.members.get(id)?.keys.dh;
    const valid = !view || (view.valid.has(id) && !view.revoked?.has(id));
    const addresses = valid ? this.profileAddresses(id) : undefined;
    return {
      id, name: this.host.serverName, state: "live", since: this.host.startedAt,
      ...(dh ? { dh } : {}), ...(addresses ? { addresses } : {}),
    };
  }

  private peerEntry(peer: { id: string; name: string; state: ServerState; since: number | null; dh?: string; addresses?: ServerAddresses }): WelcomeServer {
    const view = this.host.roster?.view;
    const gone = peer.state === "gone" || !!view?.revoked?.has(peer.id);
    const dh = peer.dh ?? view?.members.get(peer.id)?.keys.dh;
    const valid = !gone && (!view || view.valid.has(peer.id));
    const addresses = valid ? (cleanServerAddresses(peer.addresses) ?? this.profileAddresses(peer.id)) : undefined;
    return {
      id: peer.id, name: peer.name, state: gone ? "gone" : peer.state, since: peer.since,
      ...(dh ? { dh } : {}), ...(addresses ? { addresses } : {}),
    };
  }

  private peerMessage(peer: { id: string; state: ServerState; since: number | null; dh?: string; addresses?: ServerAddresses }): MessageOf<"peer"> {
    const view = this.host.roster?.view;
    const gone = peer.state === "gone" || !!view?.revoked?.has(peer.id);
    const dh = peer.dh ?? view?.members.get(peer.id)?.keys.dh;
    const valid = !gone && (!view || view.valid.has(peer.id));
    const addresses = valid ? (cleanServerAddresses(peer.addresses) ?? this.profileAddresses(peer.id)) : undefined;
    return {
      t: "peer", serverId: peer.id, state: gone ? "gone" : peer.state, since: peer.since,
      ...(dh ? { dh } : {}), ...(addresses ? { addresses } : {}),
    } as MessageOf<"peer">;
  }

  private profileAddresses(member: string): ServerAddresses | undefined {
    try {
      const parsed = peerAddresses(this.host.roster?.profile?.(member, "addresses") ?? null);
      return cleanServerAddresses({
        ...(parsed.tailnet ? { tailnet: parsed.tailnet } : {}),
        ...(parsed.relay ? { relay: parsed.relay } : {}),
      });
    } catch {
      return undefined;
    }
  }

  private peerList(): WelcomeServer[] {
    try { return (this.host.tables?.peers() ?? []).slice(0, 63).map((peer) => this.peerEntry(peer)); } catch (error) { this.host.log(`session: peers: ${errorText(error)}`); return []; }
  }

  private queueSub(stream: StreamId, cursor: MessageOf<"sub">["cursor"]): void {
    this.subChain = this.subChain.then(() => this.sub(stream, cursor)).catch((error) => this.host.log(`session: sub ${stream}: ${errorText(error)}`));
  }

  private async sub(stream: StreamId, cursor: MessageOf<"sub">["cursor"]): Promise<void> {
    const reader = this.reader;
    if (!reader || this.state !== "open") return;
    const refused = this.subRefusal(stream);
    if (refused) { this.host.log(`session: sub ${stream} refused (${refused})`); return; }
    const tables = this.host.tables;
    if (tables?.isPeerTable(stream)) {
      // M3 step 7: a peer's `srv:` table comes from this server's copy as `rows` batches, never from the log hub.
      this.tableFeeds.get(stream)?.close();
      this.tableFeeds.set(stream, tables.subscribe(stream, cursor, (frame) => this.sendWire(frame)));
      return;
    }
    const pass = this.host.passThrough;
    if (pass?.isPeerStream(stream)) {
      // M3 step 8: a bot a peer owns: the sub passes through to its owner; frames come back unchanged.
      // Live text across servers: the owner's live frames for this leg go through this connection's LiveGate (≤ 10
      // frames/s on the connection, as for this server's own bots); a resync (the front end's, or the gate's) goes to
      // the owner.
      this.legs.get(stream)?.close();
      this.gate.remove(stream);
      let leg: { liveResync?(): void } | null = null;
      const live = this.state === "open" ? this.gate.add(stream, () => leg?.liveResync?.()) : undefined;
      const opened = pass.open(stream, cursor, (frame) => this.send(frame, stream), live);
      leg = opened;
      this.legs.set(stream, opened);
      return;
    }
    let result = await reader.sub(stream, cursor);
    if (!result.ok && result.reason === "unknown stream" && stream.startsWith("bot:")) {
      // A bot the core has but whose stream was not made yet (made at start, or by its first event).
      if (await this.host.ensureBotStream(stream.slice(4))) result = await reader.sub(stream, cursor);
    }
    if (!result.ok) { this.host.log(`session: sub ${stream} refused (${result.reason})`); return; }
    if (tables?.isOwnTable?.(stream)) {
      // M5-14e: the own table's plugin rows, whole at each (re)sub (no cursor: the log's is not the table's), then deltas.
      this.ownFeeds.get(stream)?.close();
      this.ownFeeds.set(stream, tables.subscribe(stream, null, (frame) => {
        const own = ownTableFrame(frame);
        return own ? this.sendWire(own) : this.state !== "closed";
      }));
    }
    if (stream.startsWith("bot:") && !this.lives.has(stream) && this.state === "open") {
      // M1: the live subscription starts with the log one, not after the catch-up batches (§9.4); the receiver takes a
      // whole-segment frame at any time, so text is only shown early, never lost.
      let subscription: LiveSubscription | null = null;
      const send = this.gate.add(stream, () => subscription?.resync());
      subscription = this.host.live.subscribe(stream, send);
      this.lives.set(stream, subscription);
    }
  }

  private unsub(stream: StreamId): void {
    const leg = this.legs.get(stream);
    if (leg) { leg.close(); this.legs.delete(stream); this.gate.remove(stream); return; }
    const feed = this.tableFeeds.get(stream);
    if (feed) { feed.close(); this.tableFeeds.delete(stream); return; }
    this.ownFeeds.get(stream)?.close();
    this.ownFeeds.delete(stream);
    this.reader?.unsub(stream);
    this.lives.get(stream)?.close();
    this.lives.delete(stream);
    this.gate.remove(stream);
  }

  /** A reset makes the live receiver start over: ask for the whole segment. */
  private onLogFrame(message: Message): void {
    if (message.t === "reset" && this.lives.has(message.stream)) this.gate.resync(message.stream);
  }

  private history(request: MessageOf<"history">): void {
    if (this.subRefusal(request.stream)) return;
    const pass = this.host.passThrough;
    if (pass?.isPeerStream(request.stream)) { pass.history(request, (page) => this.send(page, `history of ${request.stream}`)); return; }
    const page = this.reader?.history(request);
    if (page) { this.send(page, `history of ${request.stream}`); return; }
    // An unknown line (2.x answers not_found): an empty page of the current incarnation ends the paging.
    const row = readStream(this.host.hub.reader(), request.stream);
    if (row) this.send({ t: "history.page", req: request.req, stream: request.stream, logId: row.logId as MessageOf<"history.page">["logId"], messages: [], hasMore: false, older: 0 });
  }

  // ---------------------------------------------------------------------------------------------
  // Commands and requests

  /**
   * D58: one session is a FIFO stream, and its commands for one queue (origin, originEpoch, target) reach the slot
   * engine in that order, each after the one before it settled. Without this a later copy could be checked before its
   * predecessor committed: a legacy copy is then dropped and an intent copy held, and nothing in the session re-sends
   * it. Different queues do not wait for each other (a slow legacy handler holds up only its own queue).
   */
  private queueCmd(body: CmdBody): void {
    this.chain(body.slot, () => this.cmd(body), `cmd ${body.cmd.type} (slot ${body.slot.n})`);
  }

  /** Runs `work` after everything queued before it for the same (origin, originEpoch, target); unsettled ends the session. */
  private chain(slot: CmdBody["slot"], work: () => Promise<void>, what: string): void {
    const key = queueKey(slot);
    const run = (this.cmdChains.get(key) ?? Promise.resolve())
      .then(work)
      .catch((error) => {
        this.host.log(`session: ${what} not settled: ${errorText(error)}`);
        this.unsettled(`${what} was not settled: ${errorText(error)}`, slot);
      });
    this.cmdChains.set(key, run);
    void run.then(() => { if (this.cmdChains.get(key) === run) this.cmdChains.delete(key); });
  }

  /** The peer that owns a target (M3 step 9), or null: this server decides it (always on a lone server). */
  private peerOwner(target: string): string | null {
    return this.host.forward?.ownerOf(target) ?? null;
  }

  /**
   * A cancel. For a target a peer owns it is committed into `fwdcancels` after the queue's earlier commands, so the
   * forwarder sends it after its row (D59); the owner's answer comes back through the relay. Otherwise as M2.
   */
  private queueCancel(message: MessageOf<"cancel">): void {
    if (this.cancelRefusal(message)) return;
    const forward = this.host.forward;
    let owner: string | null;
    try { owner = this.peerOwner(message.slot.target); } catch (error) { this.unsettled(`cancel of slot ${message.slot.n}: no owner (${errorText(error)})`, message.slot); return; }
    if (!forward || owner === null) { void this.cancel(message, true); return; }
    this.chain(message.slot, async () => { if (this.state !== "closed") await forward.cancel(message.slot, owner); }, `cancel of slot ${message.slot.n}`);
  }

  protected async cmd(body: CmdBody): Promise<void> {
    if (this.state === "closed") return;
    const stated = this.cmdScope(body);
    if (!("scope" in stated)) { this.bye(stated.reason, stated.detail); return; }
    const { scope } = stated;
    const reply = (message: Message) => { this.send(message, body.cmd.type); };
    const route = routeOf(body.cmd.type).kind;
    // M2 step 12 (v1 §9A.9): a message with uploaded files is `held` until their bytes are in, then applied once. The
    // wait keeps this queue's later slots behind it (they cannot apply before it anyway); other queues and the upload
    // frames themselves go on. A session that ends meanwhile settles nothing: the front end re-sends the command and
    // resumes the upload on its next session.
    if (!(await this.awaitUploads(body))) return;
    try {
      // M3 step 9: a target a peer owns is committed into the forward queue, then `held` (never before the commit).
      const owner = this.peerOwner(body.slot.target);
      if (owner !== null) {
        await this.host.forward!.commit({ ...body, scope }, owner);
        if (this.state === "open") this.send({ t: "held", slot: body.slot, at: this.host.serverId } as MessageOf<"held">, body.cmd.type);
        return;
      }
      const status = route === "intent" || route === "legacy"
        ? await this.host.runtime.receive(body, { scope, reply })
        // A read or app command sent as a command: the core's own handler, under a slot like any legacy command.
        : await this.host.runtime.legacy.receive(body, { scope, reply });
      // D58: the copy waits on a slot this session did not send before it, and the owner kept no copy: the session
      // broke FIFO. End it; the front end re-attaches and re-sends its outbox in slot order.
      if (status.status === "dropped") this.unsettled(`cmd ${body.cmd.type} (slot ${body.slot.n}) came before an earlier slot of its queue (D58)`, body.slot);
    } catch (error) {
      // Nothing was stored (the store failed, or the handler threw before its result was kept). Going on would let the
      // next slot of this queue be checked without its predecessor (D58): end the session; the outbox re-sends both.
      this.host.log(`session: cmd ${body.cmd.type} (slot ${body.slot.n}) not settled: ${errorText(error)}`);
      this.unsettled(`cmd ${body.cmd.type} (slot ${body.slot.n}) was not settled: ${errorText(error)}`, body.slot);
    }
  }

  /** False when the session ended while the command waited for its files (nothing settled; the outbox re-sends). */
  private async awaitUploads(body: CmdBody): Promise<boolean> {
    const files = body.cmd.type === "chat.send" ? body.cmd.files ?? [] : [];
    const uploads = this.host.uploads;
    if (!files.length || !uploads) return true;
    const ids = files.map((file) => file.id);
    if (ids.every((id) => uploads.complete(id))) return true;
    // A copy of a slot already decided gets its stored outcome without waiting (its files may never come again).
    let next = 1;
    try { next = this.host.nextFor(body.slot.origin, body.slot.originEpoch)[body.slot.target] ?? 1; } catch { next = 1; }
    if (body.slot.n < next) return true;
    if (this.peerOwner(body.slot.target) !== null) return true;
    this.send({ t: "held", slot: body.slot, at: this.host.serverId } as MessageOf<"held">, body.cmd.type);
    const outcome = await uploads.whenComplete(ids, this.closedSignal, this.options.uploadIdleMs);
    return outcome !== "closed" && this.state === "open";
  }

  /** Upload frames in arrival order; a frame the store cannot take is answered `content.gone{offline}`. */
  private queueUpload(message: MessageOf<"content.put"> | MessageOf<"content.chunk">): void {
    this.uploadChain = this.uploadChain.then(() => this.upload(message)).catch((error) => this.host.log(`session: ${message.t} failed: ${errorText(error)}`));
  }

  private async upload(message: MessageOf<"content.put"> | MessageOf<"content.chunk">): Promise<void> {
    if (this.state !== "open") return;
    const uploads = this.host.uploads;
    const refused = this.uploadRefusal();
    if (!uploads || refused) {
      if (message.t === "content.put") this.send({ t: "content.gone", req: message.req, id: message.id, reason: "denied" }, "content.put");
      if (refused) this.host.log(`session: upload refused (${refused})`);
      return;
    }
    let replies: Message[];
    try {
      replies = message.t === "content.put" ? await uploads.put(this.uploadOwner, message) : await uploads.chunk(this.uploadOwner, message);
    } catch (error) {
      this.host.log(`session: ${message.t} not kept: ${errorText(error)}`);
      if (message.t === "content.put") replies = [{ t: "content.gone", req: message.req, id: message.id, reason: "offline" }];
      else { replies = []; this.bye("unsettled", `an upload chunk could not be written: ${errorText(error)}`); }
    }
    for (const reply of replies) this.send(reply, message.t);
  }

  /** Why this session may not upload (remote: a device without the `reply` scope), or null. */
  protected uploadRefusal(): string | null { return null; }

  private async cancel(message: MessageOf<"cancel">, checked = false): Promise<void> {
    if (!checked && this.cancelRefusal(message)) return;
    try {
      // A cancel for a slot whose handler already began waits for that outcome (SlotEngine.cancel); a session that
      // closes meanwhile stops waiting (its front end sends the cancel again on its next session).
      const status = await Promise.race([this.host.runtime.slots.cancel(message.slot), this.closedSignal.then(() => null)]);
      // D59: every cancel is answered, the stored outcome or `cancel.noted` (after the cancel committed).
      if (status && this.state !== "closed") this.send(cancelAnswer(message.slot, status));
    } catch (error) {
      this.host.log(`session: cancel of slot ${message.slot.n} not settled: ${errorText(error)}`);
      this.unsettled(`cancel of slot ${message.slot.n} was not settled: ${errorText(error)}`, message.slot);
    }
  }

  /** True when this cancel is not this session's to send (it was answered with a `bye`). */
  protected cancelRefusal(_message: MessageOf<"cancel">): boolean { return false; }

  /** A local admin request (the role table keeps `admin` off every other session; checked here again). */
  private async admin(message: MessageOf<"admin">): Promise<void> {
    const admin = this.host.admin;
    if (!this.kind.local || !admin) {
      this.send({ t: "res", req: message.req, ok: false, error: { code: "forbidden", message: "admin requests are taken only on the local socket of a server that pairs" } }, "admin");
      return;
    }
    this.adminEvents ??= admin.onEvent((event) => { this.send({ t: "admin.event", event }, "admin.event"); });
    try {
      const result = await admin.handle(message.op, this);
      this.send({ t: "res", req: message.req, ok: true, result: result ?? null }, `admin ${message.op.op}`);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const text = `${typeof code === "string" ? `${code}: ` : ""}${errorText(error)}`;
      this.send({ t: "res", req: message.req, ok: false, error: { code: "conflict", message: text.slice(0, 2_000) } }, `admin ${message.op.op}`);
    }
  }

  private async req(message: MessageOf<"req">): Promise<void> {
    const cmd = message.cmd as Command;
    const refused = this.reqRefusal(cmd);
    if (refused) {
      this.send({ t: "res", req: message.req, ok: false, error: refused }, cmd.type);
      return;
    }
    try {
      const result = await this.host.engine.run(cmd);
      this.sendRes({ t: "res", req: message.req, ok: true, result: result ?? null }, cmd.type);
    } catch (error) {
      const wire = error instanceof ContractError ? error.toWire() : { code: "internal" as const, message: errorText(error).slice(0, 2_000) };
      this.sendRes({ t: "res", req: message.req, ok: false, error: wire }, cmd.type);
    }
  }

  private peerRead(message: MessageOf<"content.get"> | MessageOf<"content.credit"> | MessageOf<"content.cancel">): void {
    const reads = this.host.peerReads?.();
    if (!reads) {
      if (message.t === "content.get") this.send({ t: "content.gone", req: message.req, id: message.id, reason: "offline" }, "content.get");
      return;
    }
    if (message.t === "content.get") {
      const sink: LocalPeerReadSink = {
        send: (msg) => this.send(msg, msg.t),
        chunk: (msg) => this.writeChunk?.(msg) ?? false,
      };
      void reads.get(this, message, sink);
    } else if (message.t === "content.credit") {
      reads.credit(this, message);
    } else {
      reads.cancel(this, message);
    }
  }

  private async content(message: MessageOf<"content.find"> | MessageOf<"content.open">): Promise<void> {
    const content = this.host.content;
    let answer: Message;
    try {
      if (!content) throw new Error("no content service");
      answer = await content.handle(message);
    } catch (error) {
      this.host.log(`session: ${message.t}: ${errorText(error)}`);
      answer = message.t === "content.find"
        ? { t: "content.found", req: message.req, ref: null }
        : { t: "content.gone", req: message.req, id: message.id, reason: "offline" };
    }
    if (this.kind.local && message.t === "content.find" && answer.t === "content.found" && !answer.ref && this.host.peerLocate) {
      try {
        const located = await this.host.peerLocate({ t: "content.locate", req: message.req, botId: message.botId, line: message.line, url: message.url });
        if (located) {
          answer = {
            t: "content.found",
            req: message.req,
            ref: { owner: located.owner, id: located.id, type: located.type, state: located.state, entry: located.entry },
          };
        }
      } catch (error) {
        this.host.log(`session: ${message.t} peer: ${errorText(error)}`);
      }
    }
    // The answer carries the request's own `req` (the service echoes it; kept here whatever it says).
    this.send({ ...answer, req: message.req } as Message, message.t);
  }
}

/** The stream a frame is about, for a log line. */
export function streamOf(message: Message): string | undefined {
  const stream = (message as { stream?: unknown }).stream;
  return typeof stream === "string" ? stream : undefined;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanServerAddresses(addresses?: ServerAddresses): ServerAddresses | undefined {
  if (!addresses) return undefined;
  const out: ServerAddresses = {};
  if (addresses.tailnet) out.tailnet = addresses.tailnet;
  if (addresses.relay) out.relay = addresses.relay;
  return out.tailnet || out.relay ? out : undefined;
}
