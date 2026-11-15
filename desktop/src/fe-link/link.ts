// The front end's link to its server (protocol v1 §13): one session at a time over an abstract socket, the durable
// outbox re-sent on every attach, cursors per stream with reset/snap and retired logIds (§8.3, D50), cmd.retry (D49),
// the live buffer (§9.4, through the server's LiveReceiver rules) and the connection states of §13.3.
//
// Attach (§13.1): `hello` → `welcome` → `sub` for every followed stream and the owner's `srv:` stream (its logId is the
// `inc` every `cmd` carries) → the outbox in slot order, as soon as the owner's inc is known. Duplicates are harmless:
// the owner answers a copy it has with the stored outcome. With one server (M1) the attached server owns every target.
//
// Two servers and more (M3 step 11, v1 §10.1, §11.6, §13.1, §13.3): `welcome.servers` and `peer{…}` give every server's
// state; the link follows every peer's `srv:` table through the attached server (tables.ts: `rows` batches, the
// directory of which server owns which bot); a command's `inc` is its owner's logId as this front end knows it; the
// outbox goes out only after every `srv:` catch-up of the session; `stale{stream, since}` marks a peer's bot as served
// from the attached server's cache. Delivery states and owner words are in `pending()` (held at <S>, waiting for <P>).
//
// Pure TypeScript: no Electron, no core, no Node built-ins; time comes from an injected clock.
import type { Command } from "../contract";
import {
  decodeWireFrame, encodeChunkFrame, encodeFrame, outcomeOf, PROTOCOL_VERSION, REFUSE_REASON_TEXT, ResAssembler, slotKey,
  type ConnectionState, type Cursor, type DeliveryState, type Entry, type LogId, type Message, type MessageOf, type OriginEpoch, type Outcome, type ServerState, type Slot, type StreamId, type Target,
} from "../protocol";
import type { Rows } from "../protocol/table-rows";
import { LiveReceiver, type LiveSegmentView } from "../server/live/receiver";
import { connReduce, initialConn, versionBelow, writesSent, type ConnEvent, type ConnModel } from "./connection-state";
import { StreamCursors } from "./cursors";
import { Outbox, type ResolveResult } from "./outbox";
import { TableCopies } from "./tables";
import { SerialWriter, type FeStorage, type OutboxItem, type RetiredLog, type StoredCursor } from "./storage";

/** One transport connection. Frames are whole messages (a byte-stream transport packs them with `packFrame`). */
export interface FeSocket {
  send(frame: string): void;
  /** A binary frame (an upload's `content.chunk`, M2 step 12) on the bulk lane; absent: the transport carries none. */
  sendBytes?(frame: Uint8Array): void;
  close(): void;
}
/** What a content read hears from the server (M2 step 14). */
export type ContentReadMessage = MessageOf<"content.meta"> | MessageOf<"content.chunk"> | MessageOf<"content.gone">;

export interface SocketHandlers {
  open(): void;
  frame(frame: string | Uint8Array): void;
  close(detail?: string): void;
}
/** Opens a connection; reports through the handlers (open may come before or after it returns). */
export type Dial = (handlers: SocketHandlers) => FeSocket;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface FeLinkOptions {
  storage: FeStorage;
  dial: Dial;
  /** The origin of this front end's slots (§2). */
  deviceId: string;
  feVersion: string;
  /** The local token (local socket, §6.1). */
  token?: string;
  /** The session runs on the local socket (default true). */
  local?: boolean;
  clock?: Clock;
  newEpoch?: () => OriginEpoch;
  /** Reconnect backoff (default 250 ms doubling to 5 s). */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Without a session this long, "connecting" turns "offline" (default 10 s). */
  offlineAfterMs?: number;
  /** §5.2: ping after 15 s of sending nothing; no frame for 45 s ends the session. */
  pingAfterMs?: number;
  deadAfterMs?: number;
  /**
   * M3 step 11: a peer's `srv:` table the attached server has no copy of (no catch-up comes) stops holding the outbox
   * after this long (default 5 s); a table the front end had is always waited for.
   */
  absentTableMs?: number;
  /** §13.4: the "sending" marker shows only after this long without `held` or an outcome (default 150 ms). */
  sendingMarkerMs?: number;
}

export type FeLinkEvent =
  | { type: "state"; status: ConnModel }
  | { type: "pending" }
  /** An item got its outcome (also for items removed right away). */
  | { type: "outcome"; item: OutboxItem }
  | { type: "snap"; snap: MessageOf<"snap"> }
  | { type: "entries"; stream: StreamId; entries: Entry[] }
  | { type: "reset"; reset: MessageOf<"reset"> }
  /** The stream's cache must be dropped (hash mismatch); a snap follows. */
  | { type: "dropped"; stream: StreamId; why: string }
  | { type: "live"; stream: StreamId; view: LiveSegmentView | null; stale: boolean }
  /** Any other server message (stale, peer, shell.*, content.*). */
  | { type: "message"; message: Message }
  /** A session was welcomed (true) or ended (false): uploads (M2 step 12) put again from what the server has. */
  | { type: "attached"; attached: boolean }
  /**
   * M3 step 11: what the link knows of the servers changed: a server's state (`welcome.servers`, `peer`), a peer's
   * `srv:` table (`table`: its stream, the row keys changed and removed), or a stream served from the attached server's
   * cache (`stale`).
   */
  | { type: "servers"; table?: { stream: string; changed: string[]; removed: string[] } }
  /** The server ended the session with `bye` (M2 step 11: `revoked` tells the page to drop what it cached). */
  | { type: "bye"; reason: string; detail?: string }
  | { type: "error"; error: unknown };

/** An outbox item as the UI renders it in place (§11.6, §13.4). */
export interface PendingView {
  key: string;
  slot: Slot;
  cmd: Command;
  basis?: Cursor;
  state: DeliveryState;
  heldAt?: string;
  /** For "not sent": refused reason, "cancelled" or "skipped". */
  reason?: string;
  /** For "not sent": the reason's words when it has words of its own (`REFUSE_REASON_TEXT`, e.g. `grant`, N2). */
  reasonText?: string;
  /** "delivered, then lost when <machine> was restored" (D50). */
  lost: boolean;
  /** Show the "sending" marker (waiting longer than ~150 ms). */
  sending: boolean;
  /** The owner committed this item's cancel (D59 `cancel.noted`): its outcome will be "cancelled". */
  cancelNoted?: true;
  createdAt: number;
  /** M3 step 11: the server that owns the target (the directory), and its name and state as the attached server says. */
  owner?: string;
  ownerName?: string;
  /** The name of the server that holds it (`heldAt`): "held at <S>". */
  heldAtName?: string;
  /** "waiting for <machine>": unresolved while its owner is stale or gone (§11.6). */
  waitingFor?: string;
}

/** A server as the attached server sees it (`welcome.servers`, `peer`, v1 §10.5). */
export interface ServerView { id: string; name: string; state: ServerState; since: number | null; self: boolean }

/** How many settled delivered items the link remembers for a later reset (D50, M3 step 11). */
const SETTLED_KEPT = 200;

const TURN_END = new Set(["turn.finished", "turn.interrupted", "turn.cancelled"]);

interface Session {
  socket: FeSocket | null;
  openedEarly: boolean;
  helloSent: boolean;
  welcomed: boolean;
  closed: boolean;
  /** Slots sent on this session (each unresolved item goes once per session, again after cmd.retry). */
  sent: Set<string>;
}

interface PendingRequest { resolve(value: never): void; reject(error: Error): void; kind: "res" | "history.page" | "content"; stream?: string }
/** What a content request is answered with (§9A.4, local part). */
export type ContentAnswer = MessageOf<"content.found"> | MessageOf<"content.file"> | MessageOf<"content.gone">;
/** What a remote page's content request is answered with (§9A.4 tailnet part, M2 step 9). */
export type RemoteContentAnswer = MessageOf<"content.located"> | MessageOf<"content.granted"> | MessageOf<"content.gone">;

export class FeLink {
  private readonly clock: Clock;
  private conn: ConnModel;
  private readonly listeners = new Set<(event: FeLinkEvent) => void>();
  private session: Session | null = null;
  private serverId: string | null = null;
  private readonly subs = new Set<StreamId>();
  private readonly receiver = new LiveReceiver();
  private readonly liveStale = new Set<string>();
  private readonly requests = new Map<string, PendingRequest>();
  /** M2 step 12: the answers to uploads, by req. */
  private readonly uploadListeners = new Map<string, (message: MessageOf<"content.stored"> | MessageOf<"content.credit"> | MessageOf<"content.gone">) => void>();
  /** Content reads by `req` (M2 step 14): the server's `content.meta` / `content.chunk` / `content.gone`, and `null` when the session ends. */
  private readonly contentReaders = new Map<string, (message: ContentReadMessage | null) => void>();
  /** `res` answers too large for one frame, joined from their `res.part`s. */
  private readonly resParts = new ResAssembler();
  private readonly visibleAt = new Map<string, number>();
  /** Items whose cancel the owner answered with `cancel.noted` (D59); memory only, a re-sent cancel is noted again. */
  private readonly cancelNoted = new Set<string>();
  /** M3 step 11: the peers' `srv:` tables (tables.ts), every server's state, streams served from a cache. */
  private readonly tables: TableCopies;
  private readonly serverViews = new Map<string, ServerView>();
  private readonly staleStreams = new Map<string, number>();
  /** Delivered items that left the outbox lately (their line was shown): a reset may yet take them away (D50). */
  private settledRecent: OutboxItem[] = [];
  private reqCounter = 0;
  private started = false;
  private stopped = false;
  private final = false;
  private backoff: number;
  private dialFn: Dial;
  private timers: { reconnect?: unknown; offline?: unknown; ping?: unknown; dead?: unknown } = {};

  private constructor(private readonly options: FeLinkOptions, private readonly writer: SerialWriter, private readonly outbox: Outbox, private readonly cursors: StreamCursors, tablesRetired: Record<string, RetiredLog[]> = {}) {
    this.clock = options.clock ?? systemClock;
    this.conn = initialConn(this.clock.now());
    this.backoff = options.reconnectMinMs ?? 250;
    this.dialFn = options.dial;
    this.tables = new TableCopies(tablesRetired);
  }

  /** Loads the storage (a fresh or wiped one gets a new origin epoch) and returns a link that has not dialed yet. */
  static async open(options: FeLinkOptions): Promise<FeLink> {
    const clock = options.clock ?? systemClock;
    const state = await options.storage.load();
    const writer = new SerialWriter(options.storage);
    const outbox = await Outbox.open({ origin: options.deviceId, state, writer, newEpoch: options.newEpoch, now: () => clock.now() });
    return new FeLink(options, writer, outbox, new StreamCursors(state.cursors, state.retired), state.retired);
  }

  // -------------------------------------------------------------------------------------------
  // Public API

  get status(): ConnModel { return this.conn; }
  get state(): ConnectionState { return this.conn.state; }
  get epoch(): OriginEpoch { return this.outbox.epoch; }
  cursor(stream: StreamId): StoredCursor | null { return this.cursors.get(stream); }
  retired(stream: StreamId): RetiredLog[] { return this.cursors.retiredOf(stream); }

  on(listener: (event: FeLinkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.armOffline();
    this.dial();
  }

  /**
   * Ends any active session cleanly and dials a new socket immediately (optionally replacing `dial`).
   * The old session is closed before the new dial starts, so two sessions never run at once (D18).
   */
  replaceSocket(dial?: Dial): void {
    if (dial) this.dialFn = dial;
    if (!this.started || this.stopped || this.final) return;
    this.clearTimer("reconnect");
    this.backoff = this.options.reconnectMinMs ?? 250;
    const session = this.session;
    if (session) {
      this.send(session, { t: "bye", reason: "closing" });
      this.endSession(session, "switching path");
      this.clearTimer("reconnect");
    }
    this.dial();
  }

  /** Ends the session and stops reconnecting; waits for queued storage writes. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const key of Object.keys(this.timers) as Array<keyof typeof this.timers>) this.clearTimer(key);
    const session = this.session;
    if (session) {
      this.send(session, { t: "bye", reason: "closing" });
      this.endSession(session, "closing");
    }
    await this.writer.idle();
  }

  async close(): Promise<void> {
    await this.stop();
    await this.options.storage.close();
  }

  /** Resolves when every storage write queued so far is durable (tests, shutdown). */
  idle(): Promise<void> { return this.writer.idle(); }

  /**
   * Puts a command in the outbox. Resolves once it is durable (the UI shows it as waiting only then, §11.2, D45); it
   * goes out at once when the session allows writes, otherwise on the next attach.
   */
  async submit(target: Target, cmd: Command, basis?: Cursor): Promise<OutboxItem> {
    const item = await this.outbox.submit(target, cmd, basis);
    const key = slotKey(item.slot);
    this.visibleAt.set(key, this.clock.now());
    this.clock.setTimeout(() => { if (this.outbox.get(key)?.state === "waiting") this.emit({ type: "pending" }); }, this.markerMs);
    this.emit({ type: "pending" });
    if (this.session && this.canSend()) this.trySend(this.session, item);
    return item;
  }

  /** Asks the owner to drop an item it has not applied (§11.3); exactly one outcome still comes. */
  async cancel(slot: Slot): Promise<void> {
    const item = await this.outbox.requestCancel(slot);
    if (item && this.session?.welcomed) this.send(this.session, { t: "cancel", slot });
  }

  /** The UI is done with a resolved item. */
  async dismiss(slot: Slot): Promise<void> {
    if (await this.outbox.dismiss(slot)) this.emit({ type: "pending" });
  }

  /** The UI dismissed the "history restored" notice. */
  dismissRestored(): void { this.reduce({ type: "restore seen" }); }

  /** Follow a stream (sent at once when attached, and on every attach). */
  subscribe(stream: StreamId): void {
    if (this.subs.has(stream)) return;
    this.subs.add(stream);
    if (this.session?.welcomed) this.sendSub(this.session, stream);
  }

  unsubscribe(stream: StreamId): void {
    if (!this.subs.delete(stream)) return;
    if (this.session?.welcomed) this.send(this.session, { t: "unsub", stream });
    this.receiver.drop(stream);
  }

  /** The caller lost its cache of a stream: forget the cursor, so the next sub asks for a snap. */
  async dropCache(stream: StreamId): Promise<void> {
    this.cursors.drop(stream);
    await this.writer.run(() => ({ ops: [{ op: "cursor", stream, cursor: null }], commit: () => undefined }));
    if (this.session?.welcomed && this.subs.has(stream)) this.sendSub(this.session, stream);
  }

  /** Outbox items to render in place, oldest first (optionally only one target's). */
  pending(target?: Target): PendingView[] {
    const now = this.clock.now();
    return this.outbox.list().filter((item) => !target || item.slot.target === target).map((item) => {
      const key = slotKey(item.slot);
      const shown = this.visibleAt.get(key) ?? item.createdAt;
      return {
        key, slot: item.slot, cmd: item.cmd, ...(item.basis ? { basis: item.basis } : {}),
        state: item.state, ...(item.heldAt ? { heldAt: item.heldAt } : {}),
        ...(item.state === "not sent" && item.outcome ? { reason: reasonOf(item.outcome) } : {}),
        ...(item.state === "not sent" && item.outcome?.kind === "refused" && REFUSE_REASON_TEXT[item.outcome.reason] ? { reasonText: REFUSE_REASON_TEXT[item.outcome.reason] } : {}),
        lost: item.lost === true,
        sending: item.state === "waiting" && now - shown >= this.markerMs,
        ...(this.cancelNoted.has(key) && (item.state === "waiting" || item.state === "held") ? { cancelNoted: true as const } : {}),
        createdAt: item.createdAt,
        ...this.ownerWords(item),
      };
    });
  }

  /** Every server as the attached server last said (itself first); empty before the first welcome. */
  servers(): ServerView[] {
    return [...this.serverViews.values()].map((view) => ({ ...view }));
  }

  /** The server that owns a target: `srv:<id>` names it; a bot is a peer's when that peer's table holds it. */
  ownerOf(target: Target | StreamId): string | null {
    if (target.startsWith("srv:")) return target.slice(4);
    if (target.startsWith("bot:")) return this.tables.ownerOfBot(target.slice(4)) ?? this.serverId;
    return this.serverId;
  }

  /** A peer's `srv:` table as this front end holds it (summary rows by key); null when not followed. */
  table(serverId: string): { logId: LogId | null; rev: number; rows: ReadonlyMap<string, unknown>; caught: boolean } | null {
    const copy = this.tables.get(`srv:${serverId}`);
    return copy ? { logId: copy.logId, rev: copy.rev, rows: copy.rows, caught: copy.caught } : null;
  }

  /** When the attached server last heard the stream's owner, while it serves the stream from its cache (`stale`). */
  staleSince(stream: StreamId): number | null {
    return this.staleStreams.get(stream) ?? null;
  }

  private ownerWords(item: OutboxItem): Partial<PendingView> {
    const owner = this.ownerOf(item.slot.target);
    const words: Partial<PendingView> = {};
    if (owner) {
      words.owner = owner;
      const view = this.serverViews.get(owner);
      // Another server's name only: this machine's own items keep this machine's words ("this machine's history").
      if (view && !view.self) {
        words.ownerName = view.name;
        if ((item.state === "waiting" || item.state === "held") && !view.self && view.state !== "live") words.waitingFor = view.name;
      }
    }
    if (item.heldAt) { const at = this.serverViews.get(item.heldAt); if (at) words.heldAtName = at.name; }
    return words;
  }

  /** The running segment of a stream's turn; `stale` while the session is down (§9.4). */
  live(stream: StreamId): { view: LiveSegmentView; stale: boolean } | null {
    const view = this.receiver.view(stream);
    return view ? { view: { ...view }, stale: this.liveStale.has(stream) } : null;
  }

  /**
   * Sends a front-end message that is neither a command nor a stream request: the window's answer to a server request
   * (`shell.done`). Returns false when no session is attached (the server's request died with its session).
   */
  post(message: MessageOf<"shell.done">): boolean {
    const session = this.session;
    return !!session?.welcomed && this.send(session, message);
  }

  /** A read on the session (no slot, §11.1). Rejects when the session ends first. */
  /** The id the server told in its last `welcome` (srv: targets need it); null before the first. */
  get server(): string | null { return this.serverId; }
  /** The server id the link is attached to (M4-01b); null before the first welcome. */
  attachedServerId(): string | null { return this.serverId; }

  request(cmd: Command): Promise<unknown> {
    return this.ask({ t: "req", req: this.nextReq(), cmd }, "res");
  }

  /**
   * The content path's local part (§9A.4): which reference a line holds for a file (`content.find`), or the pinned file
   * of a reference (`content.open`). `req` is filled in here. Rejects when no session is attached or it ends first.
   */
  content(message: Omit<MessageOf<"content.find">, "req"> | Omit<MessageOf<"content.open">, "req">): Promise<ContentAnswer> {
    return this.ask({ ...message, req: this.nextReq() } as Message & { req: string }, "content") as Promise<ContentAnswer>;
  }

  /**
   * The content path's tailnet part (M2 step 9): which reference a line holds for a file, with a URL ticket once hashed
   * (`content.locate` → `content.located`), or a ticket for a known reference, renewed under the same text
   * (`content.ticket` → `content.granted` | `content.gone`). Rejects when no session is attached or it ends first.
   */
  remoteContent(message: Omit<MessageOf<"content.locate">, "req"> | Omit<MessageOf<"content.ticket">, "req">): Promise<RemoteContentAnswer> {
    return this.ask({ ...message, req: this.nextReq() } as Message & { req: string }, "content") as Promise<RemoteContentAnswer>;
  }

  /** Whether a session is attached (welcomed) now. */
  get attached(): boolean { return !!this.session?.welcomed; }

  /**
   * An upload frame (M2 step 12, v1 §9A.9): a `content.put` (text) or one of its `content.chunk`s (binary, bulk lane).
   * The answers (`content.stored`, `content.credit`, `content.gone`) come to `onUpload(req, …)`. False when no session
   * is attached or the transport carries no binary frame.
   */
  postUpload(message: MessageOf<"content.put"> | MessageOf<"content.chunk">): boolean {
    const session = this.session;
    if (!session?.welcomed || session.closed || !session.socket) return false;
    if (message.t === "content.put") return this.send(session, message);
    const sendBytes = session.socket.sendBytes;
    if (!sendBytes) return false;
    const encoded = encodeChunkFrame(message, "fe", { local: this.local });
    if (!encoded.ok) { this.emit({ type: "error", error: new Error(`fe-link: cannot send content.chunk: ${encoded.detail}`) }); return false; }
    try { sendBytes.call(session.socket, encoded.bytes); } catch (error) { this.onClosed(session, String(error)); return false; }
    this.armPing(session);
    return true;
  }

  /** Hears the server's answers to the upload `req` until the returned function is called. */
  onUpload(req: string, listener: (message: MessageOf<"content.stored"> | MessageOf<"content.credit"> | MessageOf<"content.gone">) => void): () => void {
    this.uploadListeners.set(req, listener);
    return () => { if (this.uploadListeners.get(req) === listener) this.uploadListeners.delete(req); };
  }

  /**
   * A content read over the session (M2 step 14, v1 §9A.4: the page's service worker on the relay path): `content.get`
   * for a byte range of a reference, then `content.credit` as the player reads and `content.cancel` when it seeks away
   * or closes. The answers come to `onContent(req, …)`. False when no session is attached.
   */
  postContent(message: MessageOf<"content.get"> | MessageOf<"content.credit"> | MessageOf<"content.cancel">): boolean {
    const session = this.session;
    if (!session?.welcomed || session.closed) return false;
    return this.send(session, message);
  }

  /** Hears the server's answers to the content read `req` (`null`: the session ended, the read is over). */
  onContent(req: string, listener: (message: ContentReadMessage | null) => void): () => void {
    this.contentReaders.set(req, listener);
    return () => { if (this.contentReaders.get(req) === listener) this.contentReaders.delete(req); };
  }

  /** A fresh request id (uploads name their own). */
  newReq(): string { return this.nextReq(); }

  /** Older lines of a stream (§8.4). A page of a retired logId is refused. */
  history(stream: StreamId, before: string, bytes?: number): Promise<MessageOf<"history.page">> {
    return this.ask({ t: "history", req: this.nextReq(), stream, before, ...(bytes ? { bytes } : {}) }, "history.page", stream) as Promise<MessageOf<"history.page">>;
  }

  // -------------------------------------------------------------------------------------------
  // Session

  private get markerMs(): number { return this.options.sendingMarkerMs ?? 150; }
  private get local(): boolean { return this.options.local ?? true; }
  private srvStream(): StreamId | null { return this.serverId ? (`srv:${this.serverId}` as StreamId) : null; }
  private streams(): StreamId[] {
    const srv = this.srvStream();
    return srv && !this.subs.has(srv) ? [...this.subs, srv] : [...this.subs];
  }

  private dial(): void {
    if (this.stopped || this.final) return;
    const session: Session = { socket: null, openedEarly: false, helloSent: false, welcomed: false, closed: false, sent: new Set() };
    this.session = session;
    const handlers: SocketHandlers = {
      open: () => {
        if (this.session !== session || session.closed) return;
        if (session.socket) this.sendHello(session);
        else session.openedEarly = true;
      },
      frame: (frame) => { if (this.session === session && !session.closed) this.onFrame(session, frame); },
      close: (detail) => { if (this.session === session) this.onClosed(session, detail ?? "closed"); },
    };
    try {
      session.socket = this.dialFn(handlers);
    } catch (error) {
      this.onClosed(session, String(error));
      return;
    }
    if (session.openedEarly && !session.closed) this.sendHello(session);
  }

  private sendHello(session: Session): void {
    if (session.helloSent) return;
    session.helloSent = true;
    this.armDead(session);
    const cursors: Record<string, Cursor> = {};
    for (const stream of this.streams()) {
      const cursor = this.cursors.get(stream);
      if (cursor) cursors[stream] = { logId: cursor.logId, seq: cursor.seq };
    }
    this.send(session, {
      t: "hello", deviceId: this.options.deviceId, feVersion: this.options.feVersion, protocol: PROTOCOL_VERSION,
      originEpoch: this.outbox.epoch, cursors, outbox: [], want: [...this.subs], ...(this.options.token ? { token: this.options.token } : {}),
    });
  }

  private send(session: Session, message: Message): boolean {
    if (session.closed || !session.socket) return false;
    const encoded = encodeFrame(message, "fe", { local: this.local });
    if (!encoded.ok) { this.emit({ type: "error", error: new Error(`fe-link: cannot send ${message.t}: ${encoded.detail}`) }); return false; }
    try { session.socket.send(encoded.text); } catch (error) { this.onClosed(session, String(error)); return false; }
    this.armPing(session);
    return true;
  }

  private onFrame(session: Session, frame: string | Uint8Array): void {
    this.armDead(session);
    const decoded = decodeWireFrame(frame, "server", { local: this.local });
    if (!decoded.ok) {
      this.send(session, { t: "bye", reason: decoded.bye.reason, detail: decoded.detail });
      this.endSession(session, decoded.detail);
      return;
    }
    if (decoded.message.t === "rows") {
      if (!session.welcomed) { this.send(session, { t: "bye", reason: "malformed", detail: `"rows" before welcome` }); this.endSession(session, "message before welcome"); return; }
      this.onRows(session, decoded.message as Rows);
      return;
    }
    const message = decoded.message as Message;
    if (!session.welcomed && message.t !== "welcome" && message.t !== "ping" && message.t !== "bye") {
      this.send(session, { t: "bye", reason: "malformed", detail: `"${message.t}" before welcome` });
      this.endSession(session, "message before welcome");
      return;
    }
    switch (message.t) {
      case "welcome": if (!session.welcomed) this.onWelcome(session, message); return;
      case "batch": this.onBatch(session, message); return;
      case "snap": this.onSnap(session, message); return;
      case "reset": this.onReset(session, message); return;
      case "live": this.onLive(session, message); return;
      case "held": void this.outbox.held(message.slot, message.at).then((item) => { if (item) this.emit({ type: "pending" }); }, (error) => this.emit({ type: "error", error })); return;
      case "cmd.result": this.onResult(message); return;
      case "cmd.retry": this.onRetry(session, message); return;
      case "cancel.noted": this.onCancelNoted(message); return;
      case "res": case "history.page": this.onAnswer(message); return;
      case "res.part": this.onResPart(message); return;
      case "content.stored": case "content.credit": this.uploadListeners.get(message.req)?.(message); return;
      case "content.meta": case "content.chunk": { const reader = this.contentReaders.get(message.req); if (reader) { reader(message); return; } this.emit({ type: "message", message }); return; }
      case "content.gone": {
        const upload = this.uploadListeners.get(message.req); if (upload) { upload(message); return; }
        const reader = this.contentReaders.get(message.req); if (reader) { reader(message); return; }
        this.onContentAnswer(message); return;
      }
      case "content.found": case "content.file": case "content.located": case "content.granted": this.onContentAnswer(message); return;
      case "bye":
        if (message.reason === "version") this.updateRequired(session, "a newer version");
        else {
          this.emit({ type: "bye", reason: message.reason, ...(message.detail ? { detail: message.detail } : {}) });
          this.endSession(session, `bye: ${message.reason}`);
        }
        return;
      case "ping": return;
      case "peer": this.onPeer(session, message); this.emit({ type: "message", message }); return;
      case "stale": this.staleStreams.set(message.stream, message.since); this.emit({ type: "servers" }); this.emit({ type: "message", message }); return;
      default: this.emit({ type: "message", message });
    }
  }

  private onWelcome(session: Session, welcome: MessageOf<"welcome">): void {
    if (welcome.protocol.min > PROTOCOL_VERSION || welcome.protocol.max < PROTOCOL_VERSION) { this.updateRequired(session, welcome.minFeVersion); return; }
    if (versionBelow(this.options.feVersion, welcome.minFeVersion)) { this.updateRequired(session, welcome.minFeVersion); return; }
    session.welcomed = true;
    this.serverId = welcome.serverId;
    this.backoff = this.options.reconnectMinMs ?? 250;
    this.clearTimer("offline");
    // §11.4: the owner is past this store's counter for a target (a storage restored from an older copy): new slots go
    // under a new epoch, so they never collide with slots the owner already has.
    if (Object.entries(welcome.next).some(([target, next]) => next > this.outbox.nextN(target as Target))) {
      void this.outbox.rotateEpoch().catch((error) => this.emit({ type: "error", error }));
    }
    this.serverViews.clear();
    for (const server of welcome.servers) this.serverViews.set(server.id, { id: server.id, name: server.name, state: server.state, since: server.since, self: server.id === welcome.serverId });
    if (!this.serverViews.has(welcome.serverId)) this.serverViews.set(welcome.serverId, { id: welcome.serverId, name: welcome.serverId, state: "live", since: null, self: true });
    for (const server of welcome.servers) if (server.id !== welcome.serverId) this.tables.add(`srv:${server.id}`);
    for (const stream of this.streams()) this.send(session, { t: "sub", stream, cursor: this.cursors.subCursor(stream) });
    for (const stream of this.tables.streams()) this.send(session, { t: "sub", stream: stream as StreamId, cursor: this.tables.subCursor(stream, this.clock.now()) });
    this.emit({ type: "servers" });
    if (this.tables.streams().length) {
      // A table the attached server has no copy of stops holding the outbox after a while (tablesCaught).
      this.clock.setTimeout(() => { if (this.session === session && !session.closed) { this.updateCatching(); this.sendOutbox(session); } }, (this.options.absentTableMs ?? 5_000) + 1);
    }
    this.reduce({ type: "welcome", catching: this.catchingNow() });
    this.sendOutbox(session);
    this.emit({ type: "attached", attached: true });
  }

  private updateRequired(session: Session, minFeVersion: string): void {
    this.final = true;
    this.reduce({ type: "update required", minFeVersion });
    this.send(session, { t: "bye", reason: "version" });
    this.endSession(session, "update required");
  }

  private sendSub(session: Session, stream: StreamId): void {
    this.send(session, { t: "sub", stream, cursor: this.cursors.subCursor(stream) });
    this.updateCatching();
  }

  private canSend(): boolean {
    return !!this.session?.welcomed && writesSent(this.conn.state);
  }

  /**
   * The `inc` a command carries: its owner's `srv:` logId as this front end knows it (§11.1, §13.1). Null until every
   * `srv:` table had its catch-up on this session (the outbox waits for all of them, §13.1 step 2 before 3), so the
   * directory and the incarnations are current when anything is (re-)sent.
   */
  private incFor(target: Target): LogId | null {
    const srv = this.srvStream();
    if (!srv || !this.tablesCaught()) return null;
    const owner = this.ownerOf(target);
    if (owner && owner !== this.serverId) return this.tables.get(`srv:${owner}`)?.logId ?? null;
    return this.cursors.currentLogId(srv);
  }

  private sendOutbox(session: Session): void {
    if (!this.canSend()) return;
    for (const item of this.outbox.unresolved()) this.trySend(session, item);
  }

  private trySend(session: Session, item: OutboxItem): void {
    const key = slotKey(item.slot);
    if (session.sent.has(key) || session.closed) return;
    const inc = this.incFor(item.slot.target);
    if (!inc) return; // the owner's srv: stream is not known yet: sent once its snap comes
    if (item.retryInc && item.retryInc !== inc) return; // D49: wait for the owner's reset
    if (!this.send(session, { t: "cmd", ...this.outbox.envelope(item, inc) } as Message)) return;
    session.sent.add(key);
    if (item.cancel) this.send(session, { t: "cancel", slot: item.slot });
  }

  // -------------------------------------------------------------------------------------------
  // Streams

  private onBatch(session: Session, batch: MessageOf<"batch">): void {
    if (!this.followed(batch.stream)) return;
    this.freshFrom(batch.stream);
    const decision = this.cursors.onBatch(batch);
    switch (decision.kind) {
      case "drop": return;
      case "gap": this.send(session, { t: "sub", stream: batch.stream, cursor: decision.cursor }); return;
      case "mismatch":
        this.cursors.drop(batch.stream);
        this.persistCursor(batch.stream, null);
        this.emit({ type: "dropped", stream: batch.stream, why: "hash mismatch" });
        this.sendSub(session, batch.stream);
        return;
      case "apply": {
        this.emit({ type: "entries", stream: batch.stream, entries: decision.entries });
        this.persistCursor(batch.stream, decision.cursor);
        this.send(session, { t: "ack", stream: batch.stream, cursor: { logId: decision.cursor.logId, seq: decision.cursor.seq } });
        this.takeEntries(batch.stream, decision.entries);
        void this.settle(batch.stream as Target);
        this.updateCatching();
      }
    }
  }

  private takeEntries(stream: StreamId, entries: Entry[]): void {
    for (const entry of entries) {
      if (TURN_END.has(entry.kind)) this.dropLive(stream);
      const body = entry.body as Record<string, unknown>;
      const outcome = outcomeOf(entry);
      const slot = (entry.slot ?? body.slot) as Slot | undefined;
      if (outcome && entry.kind !== "cmd.skipped" && slot && slot.origin === this.options.deviceId) {
        void this.resolveSlot(slot, outcome, { logId: entry.logId, seq: entry.seq });
      }
      if (entry.kind === "cmd.skipped" && body.origin === this.options.deviceId) {
        void this.outbox.skipped({ originEpoch: String(body.originEpoch), target: String(body.target) as Target }, Number(body.from), Number(body.to), { logId: entry.logId, seq: entry.seq })
          .then((changed) => { if (changed?.length) { for (const item of changed) this.emit({ type: "outcome", item }); this.emit({ type: "pending" }); } }, (error) => this.emit({ type: "error", error }));
      }
    }
  }

  private onSnap(session: Session, snap: MessageOf<"snap">): void {
    if (!this.followed(snap.stream)) return;
    this.freshFrom(snap.stream);
    if (!this.cursors.onSnap(snap)) return;
    this.emit({ type: "snap", snap });
    this.persistCursor(snap.stream, { logId: snap.logId, seq: snap.seq, hash: snap.hash });
    this.send(session, { t: "ack", stream: snap.stream, cursor: { logId: snap.logId, seq: snap.seq } });
    this.dropLive(snap.stream);
    void this.settle(snap.stream as Target);
    if (snap.stream === this.srvStream()) this.sendOutbox(session);
    this.updateCatching();
  }

  private onReset(session: Session, reset: MessageOf<"reset">): void {
    if (this.tables.has(reset.stream)) { this.onTableReset(session, reset); return; }
    if (!this.followed(reset.stream)) return;
    const added = this.cursors.onReset(reset);
    if (added === null) return;
    void this.writer.run(() => ({ ops: [{ op: "retired", stream: reset.stream, retired: reset.retired.map((old) => ({ logId: old.logId, keptSeq: old.keptSeq })) }], commit: () => undefined }))
      .catch((error) => this.emit({ type: "error", error }));
    void this.outbox.markLost(reset.stream as Target, reset.retired).then((changed) => { if (changed?.length) this.emit({ type: "pending" }); }, (error) => this.emit({ type: "error", error }));
    this.reviveLost(reset.stream as Target, reset.retired);
    this.dropLive(reset.stream);
    // A bot another server owns was reset by that server's restore: its words are the item's ("delivered, then lost
    // when <P> was restored"), never "this machine's history was restored".
    const peerBot = reset.stream.startsWith("bot:") ? this.tables.lastOwnerOfBot(reset.stream.slice(4)) : null;
    if (!peerBot || peerBot === this.serverId) this.reduce({ type: "reset", ...(reset.restoredTo !== undefined ? { restoredTo: reset.restoredTo } : {}) });
    this.emit({ type: "reset", reset });
    // The owner's srv: stream moved: items told to retry under this inc go out now (D49).
    if (reset.stream === this.srvStream()) this.sendOutbox(session);
    this.updateCatching();
  }

  // -------------------------------------------------------------------------------------------
  // Other servers (M3 step 11)

  private onRows(session: Session, batch: Rows): void {
    const decision = this.tables.onRows(batch);
    switch (decision.kind) {
      case "wait": case "drop": return;
      case "resub": this.send(session, { t: "sub", stream: batch.stream as StreamId, cursor: decision.cursor }); this.updateCatching(); return;
      case "apply": {
        this.emit({ type: "servers", table: { stream: batch.stream, changed: decision.changed, removed: decision.removed } });
        // Every table caught up: the outbox goes out with each owner's current inc (§13.1).
        this.sendOutbox(session);
        this.updateCatching();
        this.emit({ type: "pending" });
      }
    }
  }

  private onTableReset(session: Session, reset: MessageOf<"reset">): void {
    const taken = this.tables.onReset(reset);
    if (!taken) return;
    if (taken.added.length) {
      void this.writer.run(() => ({ ops: [{ op: "retired", stream: reset.stream, retired: taken.added }], commit: () => undefined })).catch((error) => this.emit({ type: "error", error }));
    }
    void this.outbox.markLost(reset.stream as Target, reset.retired).then((changed) => { if (changed?.length) this.emit({ type: "pending" }); }, (error) => this.emit({ type: "error", error }));
    this.reviveLost(reset.stream as Target, reset.retired);
    this.emit({ type: "servers", table: { stream: reset.stream, changed: [], removed: taken.removed } });
    this.emit({ type: "reset", reset });
    this.updateCatching();
    // The whole table of the new logId follows (`after: 0`); items wait for it.
    void session;
  }

  private onPeer(session: Session, peer: MessageOf<"peer">): void {
    if (peer.serverId === this.serverId) return;
    const known = this.serverViews.get(peer.serverId);
    this.serverViews.set(peer.serverId, { id: peer.serverId, name: known?.name ?? peer.serverId, state: peer.state, since: peer.since, self: false });
    if (peer.state === "live") {
      for (const stream of [...this.staleStreams.keys()]) if (this.ownerOf(stream as StreamId) === peer.serverId) this.staleStreams.delete(stream);
    }
    const stream = `srv:${peer.serverId}`;
    if (!this.tables.has(stream)) {
      this.tables.add(stream);
      this.send(session, { t: "sub", stream: stream as StreamId, cursor: this.tables.subCursor(stream, this.clock.now()) });
      this.updateCatching();
    }
    this.emit({ type: "servers" });
    this.emit({ type: "pending" });
  }

  /** A frame of the stream came from its owner (through the attached server): it is not stale any more. */
  private freshFrom(stream: StreamId): void {
    if (this.staleStreams.delete(stream)) this.emit({ type: "servers" });
  }

  /** Settled delivered items whose entry a reset took away come back as "delivered, then lost" (D50). */
  private reviveLost(target: Target, retired: RetiredLog[]): void {
    const settled = this.settledRecent.filter((item) => item.slot.target === target);
    if (!settled.length) return;
    void this.outbox.reviveLost(target, retired, settled).then((back) => {
      if (!back?.length) return;
      const keys = new Set(back.map((item) => slotKey(item.slot)));
      this.settledRecent = this.settledRecent.filter((item) => !keys.has(slotKey(item.slot)));
      for (const item of back) this.emit({ type: "outcome", item });
      this.emit({ type: "pending" });
    }, (error) => this.emit({ type: "error", error }));
  }

  private onLive(session: Session, frame: MessageOf<"live">): void {
    if (!this.followed(frame.stream)) return;
    const applied = this.receiver.apply(frame);
    if (applied === "resync") this.send(session, { t: "live.resync", stream: frame.stream });
    if (applied !== "applied") return;
    this.freshFrom(frame.stream);
    this.liveStale.delete(frame.stream);
    this.emit({ type: "live", stream: frame.stream, view: this.receiver.view(frame.stream), stale: false });
  }

  private dropLive(stream: StreamId): void {
    if (!this.receiver.view(stream)) return;
    this.receiver.drop(stream);
    this.liveStale.delete(stream);
    this.emit({ type: "live", stream, view: null, stale: false });
  }

  private followed(stream: StreamId): boolean {
    return this.subs.has(stream) || stream === this.srvStream() || this.tables.has(stream);
  }

  private persistCursor(stream: StreamId, cursor: StoredCursor | null): void {
    void this.writer.run(() => ({ ops: [{ op: "cursor", stream, cursor }], commit: () => undefined })).catch((error) => this.emit({ type: "error", error }));
  }

  // -------------------------------------------------------------------------------------------
  // Commands

  private onResult(result: MessageOf<"cmd.result">): void {
    if (this.cursors.isRetired(result.slot.target, result.logId)) return; // D50: never an outcome of a retired incarnation
    void this.resolveSlot(result.slot, result.outcome, { logId: result.logId, seq: result.seq });
  }

  /** D59: the owner committed the cancel; the slot's outcome (cancelled) follows as a `cmd.result` or log entry. */
  private onCancelNoted(noted: MessageOf<"cancel.noted">): void {
    const key = slotKey(noted.slot);
    const item = this.outbox.get(key);
    if (!item || !item.cancel || (item.state !== "waiting" && item.state !== "held") || this.cancelNoted.has(key)) return;
    this.cancelNoted.add(key);
    this.emit({ type: "pending" });
  }

  private onRetry(session: Session, retry: MessageOf<"cmd.retry">): void {
    const key = slotKey(retry.slot);
    const item = this.outbox.get(key);
    if (!item || (item.state !== "waiting" && item.state !== "held")) return; // no longer held: ignore (§11.2)
    void this.outbox.retry(retry.slot, retry.inc).then((updated) => {
      session.sent.delete(key);
      const current = updated ?? this.outbox.get(key);
      if (current && this.session === session && this.canSend()) this.trySend(session, current);
    }, (error) => this.emit({ type: "error", error }));
  }

  private async resolveSlot(slot: Slot, outcome: Outcome, from: { logId: LogId; seq: number | null }): Promise<void> {
    let result: ResolveResult | undefined;
    try {
      result = await this.outbox.resolve(slot, outcome, from);
    } catch (error) {
      this.emit({ type: "error", error });
      return;
    }
    if (!result) return;
    this.visibleAt.delete(slotKey(slot));
    this.cancelNoted.delete(slotKey(slot));
    if (result.kind === "moved") {
      this.visibleAt.set(slotKey(result.item.slot), this.clock.now());
      if (this.session && this.canSend()) this.trySend(this.session, result.item);
    } else {
      this.emit({ type: "outcome", item: result.item });
      if (result.kind === "delivered") await this.settle(slot.target);
    }
    this.emit({ type: "pending" });
  }

  /** Delivered items whose entry the cursor now covers leave the outbox; all of them for a stream nobody follows. */
  private async settle(target: Target): Promise<void> {
    try {
      const gone = await this.outbox.settle(target, this.cursors.get(target), !this.followed(target));
      if (gone?.length) {
        this.settledRecent = [...this.settledRecent, ...gone].slice(-SETTLED_KEPT);
        this.emit({ type: "pending" });
      }
    } catch (error) {
      this.emit({ type: "error", error });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Requests

  private nextReq(): string { return `r${++this.reqCounter}`; }

  private ask(message: Message & { req: string }, kind: PendingRequest["kind"], stream?: string): Promise<unknown> {
    const session = this.session;
    if (!session?.welcomed) return Promise.reject(new Error("fe-link: not attached"));
    return new Promise((resolve, reject) => {
      this.requests.set(message.req, { resolve: resolve as (value: never) => void, reject, kind, stream });
      if (!this.send(session, message)) { this.requests.delete(message.req); reject(new Error("fe-link: not sent")); }
    });
  }

  private onContentAnswer(message: ContentAnswer | RemoteContentAnswer): void {
    const pending = this.requests.get(message.req);
    if (!pending || pending.kind !== "content") return;
    this.requests.delete(message.req);
    pending.resolve(message as never);
  }

  /** A part of a `res` over the frame limit: the answer once its last part is in; parts no request waits for are dropped. */
  private onResPart(part: MessageOf<"res.part">): void {
    const pending = this.requests.get(part.req);
    if (!pending || pending.kind !== "res") { this.resParts.drop(part.req); return; }
    const joined = this.resParts.push(part, { local: this.local });
    if (!joined.ok) {
      this.requests.delete(part.req);
      pending.reject(Object.assign(new Error(`fe-link: ${joined.detail}`), { wire: { code: "internal", message: joined.detail.slice(0, 2_000) } }));
      return;
    }
    if (joined.message) this.onAnswer(joined.message);
  }

  private onAnswer(message: MessageOf<"res"> | MessageOf<"history.page">): void {
    const pending = this.requests.get(message.req);
    if (!pending || pending.kind !== message.t) return;
    this.requests.delete(message.req);
    if (message.t === "history.page") {
      if (this.cursors.isRetired(message.stream, message.logId)) pending.reject(new Error("fe-link: a page of a retired logId"));
      else pending.resolve(message as never);
    } else if (message.ok) {
      pending.resolve(message.result as never);
    } else {
      pending.reject(Object.assign(new Error(message.error.message), { wire: message.error }));
    }
  }

  // -------------------------------------------------------------------------------------------
  // Ending, reconnecting, timers

  private endSession(session: Session, why: string): void {
    if (session.closed) return;
    try { session.socket?.close(); } catch { /* already gone */ }
    this.onClosed(session, why);
  }

  private onClosed(session: Session, _why: string): void {
    if (session.closed) return;
    session.closed = true;
    if (session.welcomed) this.emit({ type: "attached", attached: false });
    if (this.session === session) this.session = null;
    this.clearTimer("ping");
    this.clearTimer("dead");
    for (const [req, pending] of this.requests) { this.requests.delete(req); pending.reject(new Error("fe-link: the session ended")); }
    for (const [req, reader] of [...this.contentReaders]) { this.contentReaders.delete(req); reader(null); }
    this.resParts.drop();
    this.cursors.detach();
    this.tables.detach();
    for (const stream of this.subs) {
      const view = this.receiver.view(stream);
      if (view && !this.liveStale.has(stream)) { this.liveStale.add(stream); this.emit({ type: "live", stream, view: { ...view }, stale: true }); }
    }
    this.reduce({ type: "lost" });
    if (this.stopped || this.final) return;
    this.armOffline();
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.options.reconnectMaxMs ?? 5_000);
    this.clearTimer("reconnect");
    this.timers.reconnect = this.clock.setTimeout(() => { this.timers.reconnect = undefined; this.dial(); }, delay);
  }

  private armOffline(): void {
    if (this.timers.offline !== undefined || this.conn.offline) return;
    this.timers.offline = this.clock.setTimeout(() => { this.timers.offline = undefined; this.reduce({ type: "offline" }); }, this.options.offlineAfterMs ?? 10_000);
  }

  private armPing(session: Session): void {
    this.clearTimer("ping");
    this.timers.ping = this.clock.setTimeout(() => {
      this.timers.ping = undefined;
      if (this.session === session) this.send(session, { t: "ping", at: this.clock.now() });
    }, this.options.pingAfterMs ?? 15_000);
  }

  private armDead(session: Session): void {
    this.clearTimer("dead");
    this.timers.dead = this.clock.setTimeout(() => {
      this.timers.dead = undefined;
      if (this.session !== session) return;
      this.send(session, { t: "bye", reason: "dead" });
      this.endSession(session, "no frame for too long");
    }, this.options.deadAfterMs ?? 45_000);
  }

  private clearTimer(name: keyof FeLink["timers"]): void {
    const handle = this.timers[name];
    if (handle !== undefined) this.clock.clearTimeout(handle);
    this.timers[name] = undefined;
  }

  private updateCatching(): void {
    if (!this.session?.welcomed) return;
    this.reduce({ type: "catching", catching: this.catchingNow() });
  }

  private tablesCaught(): boolean { return this.tables.allCaught(this.clock.now(), this.options.absentTableMs ?? 5_000); }

  /** A snap or catch-up pages are due on a followed stream, or a peer's table has not had its catch-up yet. */
  private catchingNow(): boolean {
    return this.cursors.catching(this.streams()) || !this.tablesCaught();
  }

  private reduce(event: ConnEvent): void {
    const next = connReduce(this.conn, event, this.clock.now());
    if (next === this.conn) return;
    const changed = next.state !== this.conn.state || next.restoredAt !== this.conn.restoredAt || next.restoredTo !== this.conn.restoredTo;
    this.conn = next;
    if (changed) this.emit({ type: "state", status: next });
  }

  private emit(event: FeLinkEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* a listener's error is its own */ }
    }
  }
}

function reasonOf(outcome: Outcome): string {
  switch (outcome.kind) {
    case "refused": return outcome.reason;
    case "cancelled": return "cancelled";
    case "skipped": return "skipped";
    default: return "";
  }
}
