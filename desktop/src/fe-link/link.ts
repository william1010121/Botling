// The front end's link to its server (protocol v1 §13): one session at a time over an abstract socket, the durable
// outbox re-sent on every attach, cursors per stream with reset/snap and retired logIds (§8.3, D50), cmd.retry (D49),
// the live buffer (§9.4, through the server's LiveReceiver rules) and the connection states of §13.3.
//
// Attach (§13.1): `hello` → `welcome` → `sub` for every followed stream and the owner's `srv:` stream (its logId is the
// `inc` every `cmd` carries) → the outbox in slot order, as soon as the owner's inc is known. Duplicates are harmless:
// the owner answers a copy it has with the stored outcome. With one server (M1) the attached server owns every target.
//
// Pure TypeScript: no Electron, no core, no Node built-ins; time comes from an injected clock.
import type { Command } from "../contract";
import {
  decodeFrame, encodeFrame, outcomeOf, PROTOCOL_VERSION, slotKey,
  type ConnectionState, type Cursor, type DeliveryState, type Entry, type LogId, type Message, type MessageOf, type OriginEpoch, type Outcome, type Slot, type StreamId, type Target,
} from "../protocol";
import { LiveReceiver, type LiveSegmentView } from "../server/live/receiver";
import { connReduce, initialConn, versionBelow, writesSent, type ConnEvent, type ConnModel } from "./connection-state";
import { StreamCursors } from "./cursors";
import { Outbox, type ResolveResult } from "./outbox";
import { SerialWriter, type FeStorage, type OutboxItem, type RetiredLog, type StoredCursor } from "./storage";

/** One transport connection. Frames are whole messages (a byte-stream transport packs them with `packFrame`). */
export interface FeSocket {
  send(frame: string): void;
  close(): void;
}
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
  /** "delivered, then lost when <machine> was restored" (D50). */
  lost: boolean;
  /** Show the "sending" marker (waiting longer than ~150 ms). */
  sending: boolean;
  createdAt: number;
}

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

interface PendingRequest { resolve(value: never): void; reject(error: Error): void; kind: "res" | "history.page"; stream?: string }

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
  private readonly visibleAt = new Map<string, number>();
  private reqCounter = 0;
  private started = false;
  private stopped = false;
  private final = false;
  private backoff: number;
  private timers: { reconnect?: unknown; offline?: unknown; ping?: unknown; dead?: unknown } = {};

  private constructor(private readonly options: FeLinkOptions, private readonly writer: SerialWriter, private readonly outbox: Outbox, private readonly cursors: StreamCursors) {
    this.clock = options.clock ?? systemClock;
    this.conn = initialConn(this.clock.now());
    this.backoff = options.reconnectMinMs ?? 250;
  }

  /** Loads the storage (a fresh or wiped one gets a new origin epoch) and returns a link that has not dialed yet. */
  static async open(options: FeLinkOptions): Promise<FeLink> {
    const clock = options.clock ?? systemClock;
    const state = await options.storage.load();
    const writer = new SerialWriter(options.storage);
    const outbox = await Outbox.open({ origin: options.deviceId, state, writer, newEpoch: options.newEpoch, now: () => clock.now() });
    return new FeLink(options, writer, outbox, new StreamCursors(state.cursors, state.retired));
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
        lost: item.lost === true,
        sending: item.state === "waiting" && now - shown >= this.markerMs,
        createdAt: item.createdAt,
      };
    });
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

  request(cmd: Command): Promise<unknown> {
    return this.ask({ t: "req", req: this.nextReq(), cmd }, "res");
  }

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
      session.socket = this.options.dial(handlers);
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
    const decoded = decodeFrame(frame, "server", { local: this.local });
    if (!decoded.ok) {
      this.send(session, { t: "bye", reason: decoded.bye.reason, detail: decoded.detail });
      this.endSession(session, decoded.detail);
      return;
    }
    const message = decoded.message;
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
      case "res": case "history.page": this.onAnswer(message); return;
      case "bye":
        if (message.reason === "version") this.updateRequired(session, "a newer version");
        else this.endSession(session, `bye: ${message.reason}`);
        return;
      case "ping": return;
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
    for (const stream of this.streams()) this.send(session, { t: "sub", stream, cursor: this.cursors.subCursor(stream) });
    this.reduce({ type: "welcome", catching: this.cursors.catching(this.streams()) });
    this.sendOutbox(session);
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

  private incFor(_target: Target): LogId | null {
    const srv = this.srvStream();
    return srv ? this.cursors.currentLogId(srv) : null;
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
    if (!this.followed(reset.stream)) return;
    const added = this.cursors.onReset(reset);
    if (added === null) return;
    void this.writer.run(() => ({ ops: [{ op: "retired", stream: reset.stream, retired: reset.retired.map((old) => ({ logId: old.logId, keptSeq: old.keptSeq })) }], commit: () => undefined }))
      .catch((error) => this.emit({ type: "error", error }));
    void this.outbox.markLost(reset.stream as Target, reset.retired).then((changed) => { if (changed?.length) this.emit({ type: "pending" }); }, (error) => this.emit({ type: "error", error }));
    this.dropLive(reset.stream);
    this.reduce({ type: "reset" });
    this.emit({ type: "reset", reset });
    // The owner's srv: stream moved: items told to retry under this inc go out now (D49).
    if (reset.stream === this.srvStream()) this.sendOutbox(session);
    this.updateCatching();
  }

  private onLive(session: Session, frame: MessageOf<"live">): void {
    if (!this.followed(frame.stream)) return;
    const applied = this.receiver.apply(frame);
    if (applied === "resync") this.send(session, { t: "live.resync", stream: frame.stream });
    if (applied !== "applied") return;
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
    return this.subs.has(stream) || stream === this.srvStream();
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
      if (gone?.length) this.emit({ type: "pending" });
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
    if (this.session === session) this.session = null;
    this.clearTimer("ping");
    this.clearTimer("dead");
    for (const [req, pending] of this.requests) { this.requests.delete(req); pending.reject(new Error("fe-link: the session ended")); }
    this.cursors.detach();
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
    this.reduce({ type: "catching", catching: this.cursors.catching(this.streams()) });
  }

  private reduce(event: ConnEvent): void {
    const next = connReduce(this.conn, event, this.clock.now());
    if (next === this.conn) return;
    const changed = next.state !== this.conn.state || next.restoredAt !== this.conn.restoredAt;
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
