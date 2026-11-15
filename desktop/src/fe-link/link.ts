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
  decodeWireFrame, encodeChunkFrame, encodeFrame, PROTOCOL_VERSION, PushSubscribe, REFUSE_REASON_TEXT, ResAssembler, slotKey,
  type ConnectionState, type Cursor, type LogId, type Message, type MessageOf, type OriginEpoch, type Outcome, type StreamId, type Target, type VapidKeyId, type Via,
} from "../protocol";
import type { Rows } from "../protocol/table-rows";
import { LiveReceiver, type LiveSegmentView } from "../server/live/receiver";
import { initialConn, versionBelow, type ConnEvent, type ConnModel } from "./connection-state";
import { StreamCursors } from "./cursors";
import { LinkStreams } from "./link-streams";
import { cleanServerAddresses, systemClock } from "./link-types";
import type { Clock, ContentAnswer, ContentReadMessage, Dial, FeLinkEvent, FeLinkOptions, FeSocket, LinkHost, PendingRequest, PendingView, RemoteContentAnswer, ServerView, Session, SocketHandlers } from "./link-types";
import { OwnRows } from "./own-rows";
import { Outbox } from "./outbox";
import { TableCopies } from "./tables";
import { SerialWriter, type OutboxItem, type RetiredLog, type StoredCursor } from "./storage";

export { systemClock } from "./link-types";
export type { Clock, ContentAnswer, ContentReadMessage, Dial, FeLinkEvent, FeLinkOptions, FeSocket, PendingView, RemoteContentAnswer, ServerView, SocketHandlers } from "./link-types";

export class FeLink {
  private readonly clock: Clock;
  private conn: ConnModel;
  private readonly listeners = new Set<(event: FeLinkEvent) => void>();
  private session: Session | null = null;
  private serverId: string | null = null;
  private serverVapidPublicKey: string | null = null;
  private serverVapidId: VapidKeyId | null = null;
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
  /** M5-14e: the attached server's own `plugin:` rows, which it sends as `rows` after the log `sub` of its `srv:` stream. */
  private readonly ownRows = new OwnRows();
  private readonly serverViews = new Map<string, ServerView>();
  private readonly staleStreams = new Map<string, number>();
  /** Delivered items that left the outbox lately (their line was shown): a reset may yet take them away (D50). */
  private settledRecent: OutboxItem[] = [];
  private reqCounter = 0;
  private started = false;
  private stopped = false;
  private final = false;
  private lastByeUnsettled = false;
  private readonly unsettledCounts = new Map<string, number>();
  private readonly unsettledStopped = new Set<string>();
  private backoff: number;
  private dialFn: Dial;
  private timers: { reconnect?: unknown; offline?: unknown; ping?: unknown; dead?: unknown; absentTable?: unknown } = {};
  /** The stream half (link-streams.ts); the state stays here and is lent to it through `LinkHost`. */
  private readonly half: LinkStreams;

  private constructor(private readonly options: FeLinkOptions, private readonly writer: SerialWriter, private readonly outbox: Outbox, private readonly cursors: StreamCursors, tablesRetired: Record<string, RetiredLog[]> = {}) {
    this.clock = options.clock ?? systemClock;
    this.conn = initialConn(this.clock.now());
    this.backoff = options.reconnectMinMs ?? 250;
    this.dialFn = options.dial;
    this.tables = new TableCopies(tablesRetired);
    const link = this;
    this.half = new LinkStreams({
      options, clock: this.clock, writer, outbox, cursors, tables: this.tables, ownRows: this.ownRows, receiver: this.receiver, liveStale: this.liveStale, subs: this.subs, listeners: this.listeners,
      requests: this.requests, resParts: this.resParts, contentReaders: this.contentReaders, visibleAt: this.visibleAt, cancelNoted: this.cancelNoted, unsettledCounts: this.unsettledCounts,
      unsettledStopped: this.unsettledStopped, serverViews: this.serverViews, staleStreams: this.staleStreams, timers: this.timers,
      get session() { return link.session; }, set session(value) { link.session = value; },
      get conn() { return link.conn; }, set conn(value) { link.conn = value; },
      get settledRecent() { return link.settledRecent; }, set settledRecent(value) { link.settledRecent = value; },
      get backoff() { return link.backoff; }, set backoff(value) { link.backoff = value; },
      get lastByeUnsettled() { return link.lastByeUnsettled; }, set lastByeUnsettled(value) { link.lastByeUnsettled = value; },
      get reqCounter() { return link.reqCounter; }, set reqCounter(value) { link.reqCounter = value; },
      get serverId() { return link.serverId; }, get stopped() { return link.stopped; }, get final() { return link.final; }, get local() { return link.local; },
      send: (session, message) => this.send(session, message), sendSub: (session, stream) => this.sendSub(session, stream), srvStream: () => this.srvStream(),
      streams: () => this.streams(), ownerOf: (target) => this.ownerOf(target), dial: () => this.dial(),
    });
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
    this.lastByeUnsettled = false;
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
  async submit(target: Target, cmd: Command, basis?: Cursor, via?: Via): Promise<OutboxItem> {
    const item = await this.outbox.submit(target, cmd, basis, via);
    const key = slotKey(item.slot);
    this.visibleAt.set(key, this.clock.now());
    this.clock.setTimeout(() => { if (this.outbox.get(key)?.state === "waiting" && !this.unsettledStopped.has(key)) this.emit({ type: "pending" }); }, this.markerMs);
    this.emit({ type: "pending" });
    if (this.session && this.canSend()) this.trySend(this.session, item);
    return item;
  }

  /** Asks the owner to drop an item it has not applied (§11.3); exactly one outcome still comes. */
  async cancel(slot: Slot): Promise<void> {
    const item = await this.outbox.requestCancel(slot);
    if (item && this.session?.welcomed && !this.unsettledStopped.has(slotKey(slot))) this.send(this.session, { t: "cancel", slot });
  }

  /**
   * D67: the user gave up on a slot stopped after 5 consecutive `bye{unsettled}`. Transitions it out of
   * `unresolved()` into persisted `state: "not sent"` / `outcome: { kind: "skipped" }`, and immediately sends any
   * later items waiting in the same queue with `floor` past it.
   */
  async giveUp(slot: Slot): Promise<void> {
    const item = await this.outbox.giveUp(slot);
    if (!item) return;
    const key = slotKey(slot);
    this.visibleAt.delete(key);
    this.cancelNoted.delete(key);
    this.unsettledCounts.delete(key);
    this.unsettledStopped.delete(key);
    this.emit({ type: "outcome", item });
    this.emit({ type: "pending" });
    if (this.session && this.canSend()) this.sendOutbox(this.session);
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
      const stopped = this.unsettledStopped.has(key) && (item.state === "waiting" || item.state === "held");
      return {
        key, slot: item.slot, cmd: item.cmd, ...(item.basis ? { basis: item.basis } : {}),
        state: item.state, ...(item.heldAt ? { heldAt: item.heldAt } : {}),
        ...(item.state === "not sent" && item.outcome ? { reason: reasonOf(item.outcome) } : {}),
        ...(item.state === "not sent" && item.outcome?.kind === "refused" && REFUSE_REASON_TEXT[item.outcome.reason] ? { reasonText: REFUSE_REASON_TEXT[item.outcome.reason] } : {}),
        lost: item.lost === true,
        sending: item.state === "waiting" && !stopped && now - shown >= this.markerMs,
        ...(this.cancelNoted.has(key) && (item.state === "waiting" || item.state === "held") ? { cancelNoted: true as const } : {}),
        ...(stopped ? { stopped: true as const } : {}),
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

  /**
   * A server's `srv:` table as this front end holds it (rows by key); null when not followed. A peer's is its whole table;
   * the attached server's own holds the rows it sends over its log stream (`plugin:`, M5-14e), and is null until they came.
   */
  table(serverId: string): { logId: LogId | null; rev: number; rows: ReadonlyMap<string, unknown>; caught: boolean } | null {
    if (serverId === this.serverId) return this.ownRows.view(serverId);
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
  /** The cluster VAPID public key from the last `welcome` (§18.4, M4-25), or null. */
  get vapidPublicKey(): string | null { return this.serverVapidPublicKey; }
  /** Version `(gen, id)` of `vapidPublicKey` from the last `welcome` (§18.4, M4-26 F3), or null. */
  get vapidId(): VapidKeyId | null { return this.serverVapidId; }

  /**
   * Sends this device's Web Push subscription live over the attached remote session (M4-25, §18.4).
   * Never queued in the durable outbox: returns false when unattached, local, or invalid.
   */
  sendPushSubscribe(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): boolean {
    const session = this.session;
    if (this.local || !session?.welcomed || session.closed) return false;
    const parsed = PushSubscribe.safeParse({ t: "push.subscribe", endpoint: subscription.endpoint, keys: subscription.keys });
    if (!parsed.success) return false;
    return this.send(session, parsed.data);
  }

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
          if (message.reason === "unsettled") this.onByeUnsettled(message.slot);
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
    const prevServerId = this.serverId;
    this.serverId = welcome.serverId;
    this.serverVapidPublicKey = welcome.vapidPublicKey ?? null;
    this.serverVapidId = welcome.vapidPublicKey ? (welcome.vapidId ?? null) : null;
    if (prevServerId !== null && prevServerId !== welcome.serverId) this.staleStreams.clear();
    if (!this.lastByeUnsettled) this.backoff = this.options.reconnectMinMs ?? 250;
    this.lastByeUnsettled = false;
    this.clearTimer("offline");
    // §11.4: the owner is past this store's counter for a target (a storage restored from an older copy): new slots go
    // under a new epoch, so they never collide with slots the owner already has.
    if (Object.entries(welcome.next).some(([target, next]) => next > this.outbox.nextN(target as Target))) {
      void this.outbox.rotateEpoch().catch((error) => this.emit({ type: "error", error }));
    }
    this.serverViews.clear();
    for (const server of welcome.servers) {
      const addresses = server.state === "gone" ? undefined : cleanServerAddresses(server.addresses);
      this.serverViews.set(server.id, {
        id: server.id, name: server.name, state: server.state, since: server.since, self: server.id === welcome.serverId,
        ...(server.dh ? { dh: server.dh } : {}),
        ...(addresses ? { addresses } : {}),
      });
    }
    if (!this.serverViews.has(welcome.serverId)) this.serverViews.set(welcome.serverId, { id: welcome.serverId, name: welcome.serverId, state: "live", since: null, self: true });
    // §13.1 switch: the newly attached server's own srv: stream is followed via cursors, never as a peer table.
    this.tables.remove(`srv:${welcome.serverId}`);
    this.ownRows.attach(welcome.serverId);
    for (const server of welcome.servers) if (server.id !== welcome.serverId) this.tables.add(`srv:${server.id}`);
    for (const stream of this.streams()) this.send(session, { t: "sub", stream, cursor: this.cursors.subCursor(stream) });
    for (const stream of this.tables.streams()) this.send(session, { t: "sub", stream: stream as StreamId, cursor: this.tables.subCursor(stream, this.clock.now()) });
    this.emit({ type: "servers" });
    this.clearTimer("absentTable");
    if (this.tables.streams().length) {
      // A table the attached server has no copy of stops holding the outbox after a while (tablesCaught).
      this.timers.absentTable = this.clock.setTimeout(() => {
        this.timers.absentTable = undefined;
        if (this.session === session && !session.closed) { this.updateCatching(); this.sendOutbox(session); }
      }, (this.options.absentTableMs ?? 5_000) + 1);
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

  // The stream half lives in link-streams.ts (LinkStreams); these are its one-line delegates.
  private canSend(): boolean { return this.half.canSend(); }
  private sendOutbox(session: Session): void { this.half.sendOutbox(session); }
  private trySend(session: Session, item: OutboxItem): void { this.half.trySend(session, item); }
  private onBatch(session: Session, batch: MessageOf<"batch">): void { this.half.onBatch(session, batch); }
  private onSnap(session: Session, snap: MessageOf<"snap">): void { this.half.onSnap(session, snap); }
  private onReset(session: Session, reset: MessageOf<"reset">): void { this.half.onReset(session, reset); }
  private onRows(session: Session, batch: Rows): void { this.half.onRows(session, batch); }
  private onPeer(session: Session, peer: MessageOf<"peer">): void { this.half.onPeer(session, peer); }
  private onLive(session: Session, frame: MessageOf<"live">): void { this.half.onLive(session, frame); }
  private onResult(result: MessageOf<"cmd.result">): void { this.half.onResult(result); }
  private onCancelNoted(noted: MessageOf<"cancel.noted">): void { this.half.onCancelNoted(noted); }
  private onRetry(session: Session, retry: MessageOf<"cmd.retry">): void { this.half.onRetry(session, retry); }
  private onAnswer(message: MessageOf<"res"> | MessageOf<"history.page">): void { this.half.onAnswer(message); }
  private onResPart(part: MessageOf<"res.part">): void { this.half.onResPart(part); }
  private onContentAnswer(message: ContentAnswer | RemoteContentAnswer): void { this.half.onContentAnswer(message); }
  private onByeUnsettled(slot?: Slot): void { this.half.onByeUnsettled(slot); }
  private ask(message: Message & { req: string }, kind: PendingRequest["kind"], stream?: string): Promise<unknown> { return this.half.ask(message, kind, stream); }
  private nextReq(): string { return this.half.nextReq(); }
  private endSession(session: Session, why: string): void { this.half.endSession(session, why); }
  private onClosed(session: Session, _why: string): void { this.half.onClosed(session, _why); }
  private armOffline(): void { this.half.armOffline(); }
  private armPing(session: Session): void { this.half.armPing(session); }
  private armDead(session: Session): void { this.half.armDead(session); }
  private clearTimer(name: keyof FeLink["timers"]): void { this.half.clearTimer(name); }
  private updateCatching(): void { this.half.updateCatching(); }
  private catchingNow(): boolean { return this.half.catchingNow(); }
  private reduce(event: ConnEvent): void { this.half.reduce(event); }
  private emit(event: FeLinkEvent): void { this.half.emit(event); }
}


function reasonOf(outcome: Outcome): string {
  switch (outcome.kind) {
    case "refused": return outcome.reason;
    case "cancelled": return "cancelled";
    case "skipped": return "skipped";
    default: return "";
  }
}
