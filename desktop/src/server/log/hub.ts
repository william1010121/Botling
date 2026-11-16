// Readers of bot log streams, and of the server's own `srv:` stream with `serverStreams` (protocol v1 §8.3, §10.2, §10.4, D50): `sub` / `ack` / `unsub` / `history` from a
// session, and `batch` / `snap` / `reset` pushed back through its `send`.
//
// A subscription is a cursor `(logId, sent)` plus what the reader acknowledged. The rules:
// - `sub` with no cursor → `snap`, then entries after it.
// - Cursor of the current logId: from `seq + 1` on; behind the evicted tail → `snap` (same logId); beyond the head →
//   an unnoticed rewind (§7.6): every own stream gets a new logId, then `reset` + `snap`.
// - Cursor of a retired logId, or of one this store never had → `reset` (listing every retired logId with its kept
//   seq, and the foreign one) + `snap`. A retired logId is never served again: no batch, snap or answer names it.
// - Window: at most `pageEntries` entries and `pageBytes` bytes sent and not acknowledged; a catch-up page ends there
//   and the next goes after `ack`; a reader at the head gets new entries pushed until the window is full (§10.4).
//   Batches are also cut to fit one frame. The owner never waits on a reader: `send` must not block.
// - Every frame is read from committed state (a reader connection), so nothing uncommitted ever leaves.
import { BATCH_ENTRIES_LIMIT, type Cursor, type Entry, type Message, type MessageOf, type StreamId } from "../../protocol";
import { FRAME_LIMIT } from "../../protocol/frame";
import type { Command, Db } from "../store";
import { appendEntries, evictEntries, hashAfter, listRetired, readEntries, readStream, retireOwnStreams, type AppendItem, type RetiredLog } from "./log-store";
import { readHistory, readSnap } from "./snap";

/** What the hub needs of the store (`ServerStore` has it). */
export interface LogStore {
  submit<T>(command: Command<T>): Promise<T>;
  openReader(): Db;
}

export interface LogHubOptions {
  /** Unacknowledged entries per subscription (default 500, §20). */
  pageEntries?: number;
  /** Unacknowledged bytes per subscription (default 1 MiB, §20). */
  pageBytes?: number;
  /**
   * Runs in the rewind transaction after every own stream got its new logId: the rest of the restore step of §7.6
   * (new `originEpoch`s, `started` effects marked `interrupted`, the audit row), owned by other modules.
   */
  onRewind?: (db: Db) => void;
  /** Told when a stored entry cannot be rebuilt and its reader gets a snap instead (log-store.ts `unreadable`). */
  log?: (line: string) => void;
  /**
   * Also serve this server's `srv:` stream (botlingd, step 9): its snap is a small view (`{serverId, bots}`, snap.ts)
   * and its logId is the `inc` front ends put on every command (D49). Off by default: only bot streams.
   */
  serverStreams?: boolean;
}

/** Room in a batch frame for its own fields around the entries. */
const BATCH_SLACK = 1024;
const BATCH_FRAME_BYTES = FRAME_LIMIT - BATCH_SLACK;

interface Subscription {
  stream: StreamId;
  logId: string;
  /** Last seq sent. */
  sent: number;
  /** Last seq the reader acknowledged. */
  acked: number;
  /** Sizes of entries sent and not acknowledged, in seq order: [seq, bytes]. */
  inflight: Array<[number, number]>;
  inflightBytes: number;
  /** A sub is being answered (a rewind may be committing); pushes wait. */
  busy: boolean;
}

export type SubResult = { ok: true } | { ok: false; reason: "unknown stream" | "not a bot stream" | "closed" };

export class LogReader {
  private readonly subs = new Map<StreamId, Subscription>();
  private closed = false;

  constructor(private readonly hub: LogHub, private readonly send: (message: Message) => void) {}

  get isClosed(): boolean { return this.closed; }

  /** The reader's subscription state (for tests and diagnostics). */
  subscription(stream: StreamId): { logId: string; sent: number; acked: number } | null {
    const sub = this.subs.get(stream);
    return sub ? { logId: sub.logId, sent: sub.sent, acked: sub.acked } : null;
  }

  async sub(stream: StreamId, cursor: Cursor | null): Promise<SubResult> {
    if (this.closed) return { ok: false, reason: "closed" };
    if (!stream.startsWith("bot:") && !(this.hub.serverStreams && stream.startsWith("srv:"))) return { ok: false, reason: "not a bot stream" };
    this.subs.delete(stream);
    const db = this.hub.reader();
    let row = readStream(db, stream);
    if (!row) return { ok: false, reason: "unknown stream" };
    if (cursor && cursor.logId === row.logId && cursor.seq > row.head) {
      // Unnoticed rewind (§7.6): the reader saw more of this incarnation than the store holds.
      const placeholder: Subscription = { stream, logId: row.logId, sent: row.head, acked: row.head, inflight: [], inflightBytes: 0, busy: true };
      this.subs.set(stream, placeholder);
      await this.hub.rewind(stream, cursor);
      if (this.closed || this.subs.get(stream) !== placeholder) return { ok: true }; // unsub, a newer sub, or close
      this.subs.delete(stream);
      row = readStream(this.hub.reader(), stream)!;
    }
    if (cursor === null) {
      this.snap(stream);
    } else if (cursor.logId === row.logId) {
      if (cursor.seq < row.tail) this.snap(stream);
      else if (cursor.seq > row.head) this.resetAndSnap(stream, cursor.logId); // a rewind another reader handled, then a second one
      else this.follow(stream, row.logId, cursor.seq);
    } else {
      this.resetAndSnap(stream, cursor.logId);
    }
    return { ok: true };
  }

  /** The reader applied everything up to `cursor`; frees its window and sends what waits. */
  ack(stream: StreamId, cursor: Cursor): void {
    const sub = this.subs.get(stream);
    if (!sub || sub.busy || cursor.logId !== sub.logId) return; // a late ack of an older incarnation or subscription
    if (cursor.seq > sub.sent || cursor.seq <= sub.acked) return;
    sub.acked = cursor.seq;
    while (sub.inflight.length && sub.inflight[0][0] <= cursor.seq) sub.inflightBytes -= sub.inflight.shift()![1];
    this.pump(sub);
  }

  unsub(stream: StreamId): void {
    this.subs.delete(stream);
  }

  history(request: MessageOf<"history">): MessageOf<"history.page"> | null {
    if (this.closed) return null;
    return readHistory(this.hub.reader(), request);
  }

  close(): void {
    this.closed = true;
    this.subs.clear();
    this.hub.detach(this);
  }

  /** New entries were committed on `stream` (or it was evicted): push to a reader that has room. */
  notify(stream: StreamId): void {
    const sub = this.subs.get(stream);
    if (sub && !sub.busy) this.pump(sub);
  }

  /** The stream got a new logId under this reader: it moves only through `reset` + `snap` (D50). */
  retired(stream: StreamId, oldLogId: string): void {
    const sub = this.subs.get(stream);
    if (!sub || sub.busy || sub.logId !== oldLogId) return;
    this.subs.delete(stream);
    this.resetAndSnap(stream, oldLogId);
  }

  private emit(message: Message): void {
    if (!this.closed) this.send(message);
  }

  private follow(stream: StreamId, logId: string, seq: number): void {
    const sub: Subscription = { stream, logId, sent: seq, acked: seq, inflight: [], inflightBytes: 0, busy: false };
    this.subs.set(stream, sub);
    this.pump(sub);
  }

  private snap(stream: StreamId): void {
    const snap = readSnap(this.hub.reader(), stream);
    if (!snap) return;
    this.emit(snap.frame);
    this.follow(stream, snap.row.logId, snap.row.head);
  }

  /** `reset` naming the reader's `logId` among the retired ones, then a `snap` of the current incarnation. */
  private resetAndSnap(stream: StreamId, readerLogId: string): void {
    const db = this.hub.reader();
    const row = readStream(db, stream);
    if (!row) return;
    const retired = listRetired(db, stream);
    const listed: Array<{ logId: string; keptSeq: number }> = retired.map(({ logId, keptSeq }) => ({ logId, keptSeq }));
    if (readerLogId !== row.logId && !retired.some((old) => old.logId === readerLogId)) {
      // A logId this store never had (another machine's, or a newer one lost with a restore of an older backup): it
      // is retired for this reader too; nothing of it is known to be kept.
      listed.push({ logId: readerLogId, keptSeq: 0 });
    }
    const reason: RetiredLog["reason"] = retired.length ? retired[retired.length - 1].reason : "restored";
    // A restore (botlingd restore) notes when its backup was taken, so the window can say "restored to <time>".
    const restoredTo = reason === "restored" ? Number(db.prepare("SELECT value FROM meta WHERE key = 'restoredTo'").get()?.value ?? NaN) : NaN;
    this.emit({ t: "reset", stream, logId: row.logId, retired: listed.slice(-1_000), reason, ...(Number.isSafeInteger(restoredTo) && restoredTo >= 0 ? { restoredTo } : {}) });
    this.snap(stream);
  }

  /** Sends what fits the window, as batches that each fit a frame. */
  private pump(sub: Subscription): void {
    const db = this.hub.reader();
    for (;;) {
      if (this.closed || this.subs.get(sub.stream) !== sub) return;
      const row = readStream(db, sub.stream);
      if (!row) { this.subs.delete(sub.stream); return; }
      if (row.logId !== sub.logId) { this.retired(sub.stream, sub.logId); return; }
      if (sub.sent >= row.head) return;
      if (sub.sent < row.tail) { this.subs.delete(sub.stream); this.snap(sub.stream); return; } // evicted under it
      const roomEntries = Math.min(this.hub.pageEntries - (sub.sent - sub.acked), BATCH_ENTRIES_LIMIT);
      const roomBytes = Math.min(this.hub.pageBytes - sub.inflightBytes, BATCH_FRAME_BYTES);
      if (roomEntries <= 0 || roomBytes <= 0) return;
      const prevHash = hashAfter(db, row, sub.sent);
      if (prevHash === null) { this.subs.delete(sub.stream); this.snap(sub.stream); return; }
      const read = readEntries(db, sub.stream, sub.sent + 1, { maxEntries: Math.min(roomEntries, row.head - sub.sent), maxBytes: roomBytes, ...(this.hub.log ? { log: this.hub.log } : {}) });
      // Only the current incarnation's entries: a cursor at or above the incarnation's start never reads an older one.
      const entries: Entry[] = [];
      for (const entry of read.entries) { if (entry.logId !== sub.logId) break; entries.push(entry); }
      if (!entries.length) {
        // The next entry is stored but cannot be rebuilt (log-store.ts `unreadable`): never send a wrong body, send a snap.
        if (read.unreadable !== undefined && !read.entries.length) { this.subs.delete(sub.stream); this.snap(sub.stream); return; }
        if (read.entries.length) { this.subs.delete(sub.stream); this.resetAndSnap(sub.stream, read.entries[0].logId); }
        return;
      }
      const from = sub.sent + 1;
      const to = from + entries.length - 1;
      this.emit({ t: "batch", stream: sub.stream, logId: sub.logId, from, to, prevHash, entries, more: to < row.head });
      for (let index = 0; index < entries.length; index++) {
        sub.inflight.push([entries[index].seq, read.sizes[index]]);
        sub.inflightBytes += read.sizes[index];
      }
      sub.sent = to;
    }
  }
}

/** All readers of this server's bot streams, and the writes that must reach them. */
export class LogHub {
  readonly pageEntries: number;
  readonly pageBytes: number;
  readonly serverStreams: boolean;
  readonly log: ((line: string) => void) | undefined;
  private readonly readers = new Set<LogReader>();
  private db: Db | null = null;
  private rewinding: Promise<void> | null = null;

  constructor(private readonly store: LogStore, private readonly options: LogHubOptions = {}) {
    this.pageEntries = Math.max(1, options.pageEntries ?? 500);
    this.pageBytes = Math.max(1024, options.pageBytes ?? 1024 * 1024);
    this.serverStreams = options.serverStreams === true;
    this.log = options.log;
  }

  /** One reader connection for every read the hub does (sync reads: nothing interleaves with them). */
  reader(): Db {
    if (!this.db) this.db = this.store.openReader();
    return this.db;
  }

  attach(send: (message: Message) => void): LogReader {
    const reader = new LogReader(this, send);
    this.readers.add(reader);
    return reader;
  }

  detach(reader: LogReader): void {
    this.readers.delete(reader);
  }

  /** Appends in a command of its own and pushes to readers once it committed. */
  async append(stream: StreamId, items: readonly AppendItem[]): Promise<Entry[]> {
    const entries = await this.store.submit((db) => appendEntries(db, stream, items));
    this.committed([stream]);
    return entries;
  }

  /** Evicts in a command of its own; readers behind the new tail get a snap when they next move. */
  async evict(stream: StreamId, upTo: number): Promise<number> {
    const count = await this.store.submit((db) => evictEntries(db, stream, upTo));
    this.committed([stream]);
    return count;
  }

  /**
   * Call after a command that appended (with `appendEntries` inside its own transaction) has committed: readers at
   * the head get the new entries, readers whose logId was retired get `reset` + `snap`.
   */
  committed(streams: Iterable<StreamId>): void {
    for (const stream of new Set(streams)) for (const reader of [...this.readers]) reader.notify(stream);
  }

  /**
   * A reader showed `(logId, n)` with n above the head of that same logId: the file went back. Every own stream gets a
   * new logId in one transaction (with `onRewind`), then readers of the old ones are reset. Rewinds are serialized,
   * and the check is redone inside the transaction, so two readers noticing at once retire the streams once.
   */
  async rewind(stream: StreamId, cursor: Cursor): Promise<void> {
    while (this.rewinding) await this.rewinding;
    const run = (async () => {
      const retired = await this.store.submit((db) => {
        const row = readStream(db, stream);
        if (!row || row.logId !== cursor.logId || cursor.seq <= row.head) return [] as Array<[StreamId, string]>;
        const before = new Map<string, string>(
          db.prepare("SELECT stream, logId FROM streams WHERE state IN ('active', 'archived')").all().map((r) => [String(r.stream), String(r.logId)]),
        );
        const streams = retireOwnStreams(db, "rewind");
        this.options.onRewind?.(db);
        return streams.map((name) => [name as StreamId, before.get(name)!] as [StreamId, string]);
      });
      for (const [name, oldLogId] of retired) for (const reader of [...this.readers]) reader.retired(name, oldLogId);
    })();
    this.rewinding = run.finally(() => { this.rewinding = null; });
    await this.rewinding;
  }

  /**
   * Readers of streams retired under a running hub: reset + snap. botlingd's restore does not use it: it runs with the
   * server stopped (restore.ts says why), and readers get reset + snap when they subscribe to the next start.
   */
  retiredUnder(streams: Iterable<readonly [StreamId, string]>): void {
    for (const [stream, oldLogId] of streams) for (const reader of [...this.readers]) reader.retired(stream, oldLogId);
  }

  close(): void {
    for (const reader of [...this.readers]) reader.close();
    this.db?.close();
    this.db = null;
  }
}
