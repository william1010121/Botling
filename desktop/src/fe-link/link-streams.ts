// The stream half of FeLink (M7-S94, moved from link.ts): the session's ending and timers, the commands' send and
// outcomes, the streams' batches, snaps and resets, the other servers' tables, the requests and the connection model. It
// holds no state of its own yet: the fields stay on `FeLink` and are lent through `LinkHost` (the bridge below).
import { outcomeOf, slotKey } from "../protocol";
import type { Entry, LogId, Message, MessageOf, Outcome, Slot, StreamId, Target } from "../protocol";
import type { Rows } from "../protocol/table-rows";
import { connReduce, writesSent, type ConnEvent } from "./connection-state";
import { cleanServerAddresses, SETTLED_KEPT, TURN_END, UNSETTLED_STOP_AFTER } from "./link-types";
import type { ContentAnswer, FeLinkEvent, LinkHost, LinkTimers, PendingRequest, RemoteContentAnswer, Session } from "./link-types";
import type { ResolveResult } from "./outbox";
import type { OutboxItem, RetiredLog, StoredCursor } from "./storage";

export class LinkStreams {
  constructor(private readonly host: LinkHost) {}
  /** The inc an item's last copy was sent under (memory only: after a reload a `cmd.retry` item is sent once and learns it again). */
  private readonly sentUnder = new Map<string, LogId>();
  /** The inc the copy a `cmd.retry` refused was sent under (`sentUnder` when the refusal arrives: one copy per session is out at a time). */
  private readonly refusedUnder = new Map<string, LogId>();

  // The bridge: the names the moved bodies borrow from FeLink, one line each (`LinkHost`).
  private get options() { return this.host.options; }
  private get clock() { return this.host.clock; }
  private get writer() { return this.host.writer; }
  private get outbox() { return this.host.outbox; }
  private get cursors() { return this.host.cursors; }
  private get tables() { return this.host.tables; }
  private get ownRows() { return this.host.ownRows; }
  private get receiver() { return this.host.receiver; }
  private get liveStale() { return this.host.liveStale; }
  private get subs() { return this.host.subs; }
  private get listeners() { return this.host.listeners; }
  private get requests() { return this.host.requests; }
  private get resParts() { return this.host.resParts; }
  private get contentReaders() { return this.host.contentReaders; }
  private get visibleAt() { return this.host.visibleAt; }
  private get cancelNoted() { return this.host.cancelNoted; }
  private get unsettledCounts() { return this.host.unsettledCounts; }
  private get unsettledStopped() { return this.host.unsettledStopped; }
  private get serverViews() { return this.host.serverViews; }
  private get staleStreams() { return this.host.staleStreams; }
  private get timers() { return this.host.timers; }
  private get serverId() { return this.host.serverId; }
  private get stopped() { return this.host.stopped; }
  private get final() { return this.host.final; }
  private get local() { return this.host.local; }
  private get session() { return this.host.session; }
  private set session(value) { this.host.session = value; }
  private get conn() { return this.host.conn; }
  private set conn(value) { this.host.conn = value; }
  private get settledRecent() { return this.host.settledRecent; }
  private set settledRecent(value) { this.host.settledRecent = value; }
  /** When the current outage began (a session ended, or the first dial failed); drives the fast local retry. */
  private outageSince: number | null = null;
  private get backoff() { return this.host.backoff; }
  private set backoff(value) { this.host.backoff = value; }
  private get lastByeUnsettled() { return this.host.lastByeUnsettled; }
  private set lastByeUnsettled(value) { this.host.lastByeUnsettled = value; }
  private get reqCounter() { return this.host.reqCounter; }
  private set reqCounter(value) { this.host.reqCounter = value; }
  private send(session: Session, message: Message) { return this.host.send(session, message); }
  private sendSub(session: Session, stream: StreamId) { return this.host.sendSub(session, stream); }
  private srvStream() { return this.host.srvStream(); }
  private streams() { return this.host.streams(); }
  private ownerOf(target: Target | StreamId) { return this.host.ownerOf(target); }
  private dial() { return this.host.dial(); }

  canSend(): boolean {
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

  sendOutbox(session: Session): void {
    if (!this.canSend()) return;
    for (const item of this.outbox.unresolved()) this.trySend(session, item);
  }

  private isQueueStopped(slot: Slot): boolean {
    if (this.unsettledStopped.size === 0) return false;
    for (const item of this.outbox.unresolved()) {
      if (
        item.slot.originEpoch === slot.originEpoch
        && item.slot.target === slot.target
        && item.slot.n <= slot.n
        && this.unsettledStopped.has(slotKey(item.slot))
      ) return true;
    }
    return false;
  }

  onByeUnsettled(slot?: Slot): void {
    // D67: skip backoff reset on the next welcome after an unsettled end (including slotless bye{unsettled}).
    this.lastByeUnsettled = true;
    if (!slot) return;
    const key = slotKey(slot);
    for (const other of this.unsettledCounts.keys()) if (other !== key) this.unsettledCounts.delete(other);
    const item = this.outbox.get(key);
    if (!item || (item.state !== "waiting" && item.state !== "held")) return;
    const count = (this.unsettledCounts.get(key) ?? 0) + 1;
    this.unsettledCounts.set(key, count);
    if (count >= UNSETTLED_STOP_AFTER && !this.unsettledStopped.has(key)) {
      this.unsettledStopped.add(key);
      this.emit({ type: "pending" });
    }
  }

  trySend(session: Session, item: OutboxItem): void {
    const key = slotKey(item.slot);
    if (session.sent.has(key) || session.closed || this.isQueueStopped(item.slot)) return;
    const inc = this.incFor(item.slot.target);
    if (!inc) return; // the owner's srv: stream is not known yet: sent once its snap comes
    // D49: wait for the owner's reset, but only while this front end is still on the inc the refused copy was sent under: an owner restored
    // again before the first reset arrived is never shown on `retryInc`, and waiting for it would hold this item (and every one behind it) for ever.
    // The inc at send time, not when the refusal arrives: a late refusal (a forwarded reply) can come after the stream already moved on.
    // The refused copy's inc, not the last copy's: a copy sent under a newer inc and lost to a reconnect was never refused (re-check M7-11b).
    if (item.retryInc && item.retryInc !== inc && this.refusedUnder.get(key) === inc) return;
    if (!this.send(session, { t: "cmd", ...this.outbox.envelope(item, inc) } as Message)) return;
    session.sent.add(key);
    this.sentUnder.set(key, inc);
    if (this.sentUnder.size > 256) {
      for (const other of this.sentUnder.keys()) if (!this.outbox.get(other)) { this.sentUnder.delete(other); this.refusedUnder.delete(other); }
    }
    if (item.cancel) this.send(session, { t: "cancel", slot: item.slot });
  }

  // -------------------------------------------------------------------------------------------
  // Streams

  onBatch(session: Session, batch: MessageOf<"batch">): void {
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
          .then((changed) => {
            if (changed?.length) {
              for (const item of changed) {
                const key = slotKey(item.slot);
                this.unsettledCounts.delete(key);
                this.unsettledStopped.delete(key);
                this.emit({ type: "outcome", item });
              }
              this.emit({ type: "pending" });
            }
          }, (error) => this.emit({ type: "error", error }));
      }
    }
  }

  onSnap(session: Session, snap: MessageOf<"snap">): void {
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

  onReset(session: Session, reset: MessageOf<"reset">): void {
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

  onRows(session: Session, batch: Rows): void {
    if (batch.stream === this.srvStream()) {
      // M5-14e: the own table's rows (the server sends them after the log sub); not a peer table, so no resub or catch-up.
      const own = this.ownRows.onRows(batch);
      if (own) this.emit({ type: "servers", table: { stream: batch.stream, changed: own.changed, removed: own.removed } });
      return;
    }
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

  onPeer(session: Session, peer: MessageOf<"peer">): void {
    if (peer.serverId === this.serverId) return;
    const known = this.serverViews.get(peer.serverId);
    const dh = peer.dh ?? known?.dh;
    const addresses = peer.state === "gone" ? undefined : (peer.addresses !== undefined ? cleanServerAddresses(peer.addresses) : known?.addresses);
    this.serverViews.set(peer.serverId, {
      id: peer.serverId, name: known?.name ?? peer.serverId, state: peer.state, since: peer.since, self: false,
      ...(dh ? { dh } : {}),
      ...(addresses ? { addresses } : {}),
    });
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

  onLive(session: Session, frame: MessageOf<"live">): void {
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

  onResult(result: MessageOf<"cmd.result">): void {
    if (this.cursors.isRetired(result.slot.target, result.logId)) return; // D50: never an outcome of a retired incarnation
    void this.resolveSlot(result.slot, result.outcome, { logId: result.logId, seq: result.seq });
  }

  /** D59: the owner committed the cancel; the slot's outcome (cancelled) follows as a `cmd.result` or log entry. */
  onCancelNoted(noted: MessageOf<"cancel.noted">): void {
    const key = slotKey(noted.slot);
    const item = this.outbox.get(key);
    if (!item || !item.cancel || (item.state !== "waiting" && item.state !== "held") || this.cancelNoted.has(key)) return;
    this.unsettledCounts.delete(key);
    this.unsettledStopped.delete(key);
    this.cancelNoted.add(key);
    this.emit({ type: "pending" });
  }

  onRetry(session: Session, retry: MessageOf<"cmd.retry">): void {
    const key = slotKey(retry.slot);
    const item = this.outbox.get(key);
    if (!item || (item.state !== "waiting" && item.state !== "held")) return; // no longer held: ignore (§11.2)
    // A forwarded refusal can reach a newer session than the one that sent the copy, so `sentUnder` may name a later copy: that is harmless.
    // It holds because the attached server handles peer frames in order (D58) and the owner's `reset J` precedes its refusal under J, so the copy
    // was sent under J (`retryInc === inc`: sent directly) or under an older inc (the stream moves to J first, then it is sent).
    const refused = this.sentUnder.get(key);
    if (refused) this.refusedUnder.set(key, refused);
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
    const key = slotKey(slot);
    this.visibleAt.delete(key);
    this.cancelNoted.delete(key);
    this.sentUnder.delete(key);
    this.refusedUnder.delete(key);
    this.unsettledCounts.delete(key);
    this.unsettledStopped.delete(key);
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

  nextReq(): string { return `r${++this.reqCounter}`; }

  ask(message: Message & { req: string }, kind: PendingRequest["kind"], stream?: string): Promise<unknown> {
    const session = this.session;
    if (!session?.welcomed) return Promise.reject(new Error("fe-link: not attached"));
    return new Promise((resolve, reject) => {
      this.requests.set(message.req, { resolve: resolve as (value: never) => void, reject, kind, stream });
      if (!this.send(session, message)) { this.requests.delete(message.req); reject(new Error("fe-link: not sent")); }
    });
  }

  onContentAnswer(message: ContentAnswer | RemoteContentAnswer): void {
    const pending = this.requests.get(message.req);
    if (!pending || pending.kind !== "content") return;
    this.requests.delete(message.req);
    pending.resolve(message as never);
  }

  /** A part of a `res` over the frame limit: the answer once its last part is in; parts no request waits for are dropped. */
  onResPart(part: MessageOf<"res.part">): void {
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

  onAnswer(message: MessageOf<"res"> | MessageOf<"history.page">): void {
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

  endSession(session: Session, why: string): void {
    if (session.closed) return;
    try { session.socket?.close(); } catch { /* already gone */ }
    this.onClosed(session, why);
  }

  onClosed(session: Session, _why: string): void {
    if (session.closed) return;
    session.closed = true;
    if (session.welcomed) this.emit({ type: "attached", attached: false });
    if (this.session === session) this.session = null;
    this.clearTimer("ping");
    this.clearTimer("dead");
    this.clearTimer("absentTable");
    for (const [req, pending] of this.requests) { this.requests.delete(req); pending.reject(new Error("fe-link: the session ended")); }
    for (const [req, reader] of [...this.contentReaders]) { this.contentReaders.delete(req); reader(null); }
    this.resParts.drop();
    this.cursors.detach();
    this.tables.detach();
    this.ownRows.detach();
    for (const stream of this.subs) {
      const view = this.receiver.view(stream);
      if (view && !this.liveStale.has(stream)) { this.liveStale.add(stream); this.emit({ type: "live", stream, view: { ...view }, stale: true }); }
    }
    this.reduce({ type: "lost" });
    if (this.stopped || this.final) return;
    this.armOffline();
    const maxMs = this.options.reconnectMaxMs ?? 5_000;
    // A welcomed session that ended starts a new outage; a dial that failed during one does not.
    if (session.welcomed || this.outageSince === null) this.outageSince = this.clock.now();
    // The local socket (opt-in): while the outage is young the server is most likely starting or restarting, so retry at
    // `reconnectFastMs` at most (a refused unix connect costs nothing). After `reconnectFastWindowMs` the normal backoff
    // applies, so a server that is really down is not dialed in a tight loop. A bye{unsettled} loop keeps escalating (D67).
    const fastMs = this.options.reconnectFastMs;
    const fast = fastMs !== undefined && this.local && !this.lastByeUnsettled
      && this.clock.now() - this.outageSince < (this.options.reconnectFastWindowMs ?? 60_000);
    const delay = fast ? Math.min(this.backoff, fastMs) : this.backoff;
    this.backoff = Math.min(this.backoff * 2, fast ? Math.min(fastMs, maxMs) : maxMs);
    this.clearTimer("reconnect");
    this.timers.reconnect = this.clock.setTimeout(() => { this.timers.reconnect = undefined; this.dial(); }, delay);
  }

  armOffline(): void {
    if (this.timers.offline !== undefined || this.conn.offline) return;
    this.timers.offline = this.clock.setTimeout(() => { this.timers.offline = undefined; this.reduce({ type: "offline" }); }, this.options.offlineAfterMs ?? 10_000);
  }

  armPing(session: Session): void {
    this.clearTimer("ping");
    this.timers.ping = this.clock.setTimeout(() => {
      this.timers.ping = undefined;
      if (this.session === session) this.send(session, { t: "ping", at: this.clock.now() });
    }, this.options.pingAfterMs ?? 15_000);
  }

  armDead(session: Session): void {
    this.clearTimer("dead");
    this.timers.dead = this.clock.setTimeout(() => {
      this.timers.dead = undefined;
      if (this.session !== session) return;
      this.send(session, { t: "bye", reason: "dead" });
      this.endSession(session, "no frame for too long");
    }, this.options.deadAfterMs ?? 45_000);
  }

  clearTimer(name: keyof LinkTimers): void {
    const handle = this.timers[name];
    if (handle !== undefined) this.clock.clearTimeout(handle);
    this.timers[name] = undefined;
  }

  updateCatching(): void {
    if (!this.session?.welcomed) return;
    this.reduce({ type: "catching", catching: this.catchingNow() });
  }

  private tablesCaught(): boolean { return this.tables.allCaught(this.clock.now(), this.options.absentTableMs ?? 5_000); }

  /** A snap or catch-up pages are due on a followed stream, or a peer's table has not had its catch-up yet. */
  catchingNow(): boolean {
    return this.cursors.catching(this.streams()) || !this.tablesCaught();
  }

  reduce(event: ConnEvent): void {
    const next = connReduce(this.conn, event, this.clock.now());
    if (next === this.conn) return;
    const changed = next.state !== this.conn.state || next.restoredAt !== this.conn.restoredAt || next.restoredTo !== this.conn.restoredTo;
    this.conn = next;
    if (changed) this.emit({ type: "state", status: next });
  }

  emit(event: FeLinkEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* a listener's error is its own */ }
    }
  }
}
