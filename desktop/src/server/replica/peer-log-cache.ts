// This server's cache of peers' bot logs (M3 step 8, protocol v1 §8.3, §8.4, §10.3, §10.5, D50; m3-brief §11 Q5).
//
// What the cache keeps of a stream `bot:X` owned by peer B is exactly what pass-through relayed from B: the newest `snap`
// B sent and the entries after it, by `(logId, seq)`. It never builds bot state (only front ends run the reducer).
//
//   snap  of logId L at seq s   → replaces the cache when it is not older: another logId (B moved on; a retired one is
//                                 dropped), or the same logId at s ≥ the cache's head ("never an older snapshot")
//   batch of logId L, from..to  → appends the entries above the head when they follow it and the hash chain holds from
//                                 the head's hash; a batch below the head is a duplicate, one above it leaves a gap
//                                 (ignored: the cache stays a prefix; the next snap refreshes it); a broken chain drops
//                                 the stream's cache (§8.1: "drops its cache of the stream and asks again")
//   reset to L'                 → the listed logIds are remembered as retired (D50); the cache of a retired logId is
//                                 emptied and waits for the snap that follows
//
// When B is unreachable the attached server serves the cache (`frames`): from the reader's cursor, the snap and entries
// after it, a `reset` first when the reader's logId is one the cache knows as retired, nothing when the reader is
// ahead or on a logId the cache cannot place (a reader is never moved to an older table, never back to a retired logId).
//
// Bounded: all streams together stay under `capBytes` (one budget with the peer chunk cache, Q5; lowered in tests);
// over it, whole streams are evicted least recently used first, streams in use and followed bots last. Kept in
// server.db (`peerlogs`, `peerlog_entries`, schema v9): it survives this server's restart (shown stale until the next
// session with the owner).
import { BATCH_ENTRIES_LIMIT, type Cursor, type Entry, type LogId, type Message, type MessageOf, type StreamId } from "../../protocol";
import { FRAME_LIMIT } from "../../protocol/frame";
import { verifyChain } from "../log/chain";
import type { Db, ServerStore } from "../store";

/** v1 §10.5: 2 GB of peers' logs and chunks per server (one budget, Q5). */
export const PEER_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
/** Room in a served batch frame for its own fields. */
const SERVE_FRAME_BYTES = FRAME_LIMIT - 4 * 1024;

type Snap = MessageOf<"snap">;
type Batch = MessageOf<"batch">;
type Reset = MessageOf<"reset">;

interface RetiredInfo {
  list: Array<{ logId: string; keptSeq: number }>;
  reason: Reset["reason"];
  restoredTo?: number;
}

/** One stream's place in the cache (the entries themselves stay in the store). */
export interface CachedLog {
  stream: string;
  owner: string;
  logId: string;
  /** Seq of the snap kept (-1: none yet, e.g. right after a reset). */
  snapSeq: number;
  head: number;
  headHash: string | null;
  retired: RetiredInfo;
  bytes: number;
  usedAt: number;
  /** This server's clock when the owner last sent something for the stream. */
  heardAt: number | null;
}

export type CacheTake = "taken" | "duplicate" | "older" | "gap" | "retired" | "other logId" | "chain" | "ignored";

export interface PeerLogCacheOptions {
  store: Pick<ServerStore, "submit">;
  /** A reader connection (committed state). */
  reader: () => Db;
  capBytes?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** Eviction order: lower goes first (0 = idle, 1 = in use, 2 = followed). */
  priority?: (stream: string) => number;
}

const RETIRED_KEEP = 1_000;

export class PeerLogCache {
  private readonly logs = new Map<string, CachedLog>();
  private writes: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  readonly capBytes: number;
  /** Counters (tests, status). */
  readonly counts = { taken: 0, duplicate: 0, older: 0, gap: 0, retired: 0, otherLogId: 0, chain: 0, evicted: 0 };

  constructor(private readonly options: PeerLogCacheOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.capBytes = Math.max(64 * 1024, options.capBytes ?? PEER_CACHE_BYTES);
    this.load();
  }

  private load(): void {
    let rows: Array<Record<string, unknown>>;
    try { rows = this.options.reader().prepare("SELECT stream, owner, logId, snapSeq, head, headHash, retired, bytes, usedAt, heardAt FROM peerlogs").all() as Array<Record<string, unknown>>; } catch { return; }
    for (const row of rows) {
      let retired: RetiredInfo = { list: [], reason: "restored" };
      try { retired = JSON.parse(String(row.retired)) as RetiredInfo; } catch { /* kept empty */ }
      this.logs.set(String(row.stream), {
        stream: String(row.stream), owner: String(row.owner), logId: String(row.logId), snapSeq: Number(row.snapSeq), head: Number(row.head),
        headHash: row.headHash == null ? null : String(row.headHash), retired, bytes: Number(row.bytes), usedAt: Number(row.usedAt),
        heardAt: row.heardAt == null ? null : Number(row.heardAt),
      });
    }
  }

  /** Every stream the cache holds something of. */
  streams(): CachedLog[] { return [...this.logs.values()].map((log) => ({ ...log, retired: { ...log.retired, list: [...log.retired.list] } })); }
  get(stream: string): CachedLog | null { const log = this.logs.get(stream); return log ? { ...log } : null; }
  get totalBytes(): number { let total = 0; for (const log of this.logs.values()) total += log.bytes; return total; }

  /** True when `logId` is one the owner retired for `stream` (as far as this cache heard). */
  isRetired(stream: string, logId: string): boolean {
    return !!this.logs.get(stream)?.retired.list.some((old) => old.logId === logId);
  }

  /** The cursor the cache is at (its logId and head), or null when it holds no snap. */
  cursor(stream: string): Cursor | null {
    const log = this.logs.get(stream);
    return log && log.snapSeq >= 0 ? { logId: log.logId as LogId, seq: log.head } : null;
  }

  /** Resolves once every write submitted so far has committed (so `frames` reads them). */
  idle(): Promise<void> { return this.writes.then(() => undefined, () => undefined); }

  touch(stream: string): void {
    const log = this.logs.get(stream);
    if (!log) return;
    log.usedAt = this.now();
    const at = log.usedAt;
    this.write((tx) => { tx.prepare("UPDATE peerlogs SET usedAt = ? WHERE stream = ?").run(at, stream); });
  }

  /** The owner sent a snap (via removed). */
  takeSnap(owner: string, snap: Snap): CacheTake {
    const stream = snap.stream;
    const log = this.logs.get(stream);
    if (log?.retired.list.some((old) => old.logId === snap.logId)) return this.count("retired");
    if (log && log.snapSeq >= 0 && log.logId === snap.logId && snap.seq < log.head) return this.count("older");
    if (log && log.snapSeq >= 0 && log.logId === snap.logId && snap.seq === log.head && log.snapSeq === snap.seq) return this.count("duplicate");
    const text = JSON.stringify(snap);
    const now = this.now();
    const next: CachedLog = {
      stream, owner, logId: snap.logId, snapSeq: snap.seq, head: snap.seq, headHash: snap.hash,
      retired: log?.retired ?? { list: [], reason: "restored" }, bytes: Buffer.byteLength(text), usedAt: log?.usedAt ?? now, heardAt: now,
    };
    this.logs.set(stream, next);
    const retired = JSON.stringify(next.retired);
    this.write((tx) => {
      tx.prepare("DELETE FROM peerlog_entries WHERE stream = ?").run(stream);
      tx.prepare(`INSERT INTO peerlogs (stream, owner, logId, snapSeq, head, headHash, snap, retired, bytes, usedAt, heardAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (stream) DO UPDATE SET owner = excluded.owner, logId = excluded.logId, snapSeq = excluded.snapSeq, head = excluded.head, headHash = excluded.headHash,
        snap = excluded.snap, retired = excluded.retired, bytes = excluded.bytes, usedAt = excluded.usedAt, heardAt = excluded.heardAt`)
        .run(stream, owner, next.logId, next.snapSeq, next.head, next.headHash, text, retired, next.bytes, next.usedAt, now);
    });
    this.evict(stream);
    return this.count("taken");
  }

  /** The owner sent a batch (via removed). */
  takeBatch(_owner: string, batch: Batch): CacheTake {
    const stream = batch.stream;
    const log = this.logs.get(stream);
    if (!log) return "ignored";
    if (log.retired.list.some((old) => old.logId === batch.logId)) return this.count("retired");
    if (log.snapSeq < 0) return "ignored";
    if (log.logId !== batch.logId) return this.count("other logId");
    if (batch.to <= log.head) return this.count("duplicate");
    if (batch.from > log.head + 1) return this.count("gap");
    const fresh = batch.entries.filter((entry) => entry.seq > log.head);
    const check = verifyChain(log.headHash ?? "", fresh);
    if (!check.ok) {
      this.log(`pass-through: the hash chain of ${stream} breaks at seq ${check.seq} (${check.reason}); its cache is dropped`);
      this.drop(stream);
      return this.count("chain");
    }
    const now = this.now();
    let added = 0;
    const texts = fresh.map((entry) => { const text = JSON.stringify(entry); added += Buffer.byteLength(text); return [entry.seq, text] as const; });
    log.head = fresh[fresh.length - 1]!.seq;
    log.headHash = check.lastHash;
    log.bytes += added;
    log.heardAt = now;
    const { head, headHash, bytes } = log;
    this.write((tx) => {
      const insert = tx.prepare("INSERT INTO peerlog_entries (stream, seq, entry) VALUES (?, ?, ?) ON CONFLICT (stream, seq) DO UPDATE SET entry = excluded.entry");
      for (const [seq, text] of texts) insert.run(stream, seq, text);
      tx.prepare("UPDATE peerlogs SET head = ?, headHash = ?, bytes = ?, heardAt = ? WHERE stream = ?").run(head, headHash, bytes, now, stream);
    });
    this.evict(stream);
    return this.count("taken");
  }

  /** The owner sent a reset (via removed): remember the retired logIds; a cache of one of them is emptied. */
  takeReset(owner: string, reset: Reset): CacheTake {
    const stream = reset.stream;
    const log = this.logs.get(stream);
    if (log?.retired.list.some((old) => old.logId === reset.logId)) return this.count("retired");
    const list = [...(log?.retired.list ?? [])];
    for (const old of reset.retired) if (!list.some((known) => known.logId === old.logId)) list.push({ logId: old.logId, keptSeq: old.keptSeq });
    const retired: RetiredInfo = { list: list.slice(-RETIRED_KEEP), reason: reset.reason, ...(reset.restoredTo !== undefined ? { restoredTo: reset.restoredTo } : {}) };
    const now = this.now();
    const emptied = !log || log.logId !== reset.logId;
    const next: CachedLog = emptied
      ? { stream, owner, logId: reset.logId, snapSeq: -1, head: 0, headHash: null, retired, bytes: 0, usedAt: log?.usedAt ?? now, heardAt: now }
      : { ...log, retired, heardAt: now };
    this.logs.set(stream, next);
    const text = JSON.stringify(retired);
    this.write((tx) => {
      if (emptied) tx.prepare("DELETE FROM peerlog_entries WHERE stream = ?").run(stream);
      tx.prepare(`INSERT INTO peerlogs (stream, owner, logId, snapSeq, head, headHash, snap, retired, bytes, usedAt, heardAt) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
        ON CONFLICT (stream) DO UPDATE SET owner = excluded.owner, logId = excluded.logId, snapSeq = excluded.snapSeq, head = excluded.head, headHash = excluded.headHash,
        snap = CASE WHEN ${emptied ? 1 : 0} THEN NULL ELSE snap END, retired = excluded.retired, bytes = excluded.bytes, heardAt = excluded.heardAt`)
        .run(stream, owner, next.logId, next.snapSeq, next.head, next.headHash, text, next.bytes, next.usedAt, now);
    });
    return this.count("taken");
  }

  /** Forgets one stream's cache (evicted, or its chain broke). */
  drop(stream: string): void {
    if (!this.logs.delete(stream)) return;
    this.write((tx) => {
      tx.prepare("DELETE FROM peerlog_entries WHERE stream = ?").run(stream);
      tx.prepare("DELETE FROM peerlogs WHERE stream = ?").run(stream);
    });
  }

  /**
   * What a reader at `cursor` is served from the cache while the owner is unreachable (§10.3 step 3): frames as the
   * owner would have sent them (no `via`), or none. Reads committed state, after the writes submitted so far.
   */
  async frames(stream: string, cursor: Cursor | null): Promise<Message[]> {
    await this.idle();
    const log = this.logs.get(stream);
    if (!log || log.snapSeq < 0) return [];
    const out: Message[] = [];
    let from: number;
    if (cursor === null) {
      from = -1;
    } else if (cursor.logId === log.logId) {
      if (cursor.seq >= log.head) return [];
      from = cursor.seq >= log.snapSeq ? cursor.seq : -1;
    } else if (log.retired.list.some((old) => old.logId === cursor.logId)) {
      const listed = log.retired.list.filter((old) => old.logId !== log.logId).slice(-RETIRED_KEEP);
      if (!listed.length) return [];
      out.push({
        t: "reset", stream: stream as StreamId, logId: log.logId as LogId, retired: listed.map((old) => ({ logId: old.logId as LogId, keptSeq: old.keptSeq })),
        reason: log.retired.reason, ...(log.retired.restoredTo !== undefined ? { restoredTo: log.retired.restoredTo } : {}),
      } as Reset);
      from = -1;
    } else {
      return []; // a logId this cache cannot place: the reader may be ahead of it (it is never moved back)
    }
    const db = this.options.reader();
    const began = !db.inTransaction;
    if (began) db.exec("BEGIN");
    try {
      const row = db.prepare("SELECT logId, snapSeq, head, snap FROM peerlogs WHERE stream = ?").get(stream);
      if (!row || String(row.logId) !== log.logId || row.snap == null) return [];
      const snap = JSON.parse(String(row.snap)) as Snap;
      let prevHash: string;
      if (from < 0) { out.push(snap); from = snap.seq; prevHash = snap.hash; } else if (from === snap.seq) {
        prevHash = snap.hash;
      } else {
        const at = db.prepare("SELECT entry FROM peerlog_entries WHERE stream = ? AND seq = ?").get(stream, from);
        if (!at) return out;
        prevHash = (JSON.parse(String(at.entry)) as Entry).hash;
      }
      const head = Number(row.head);
      let entries: Entry[] = [];
      let bytes = 0;
      const flush = () => {
        if (!entries.length) return;
        const first = entries[0]!.seq;
        const to = entries[entries.length - 1]!.seq;
        out.push({ t: "batch", stream: stream as StreamId, logId: log.logId as LogId, from: first, to, prevHash, entries, more: to < head } as Batch);
        prevHash = entries[entries.length - 1]!.hash;
        entries = [];
        bytes = 0;
      };
      for (const item of db.prepare("SELECT seq, entry FROM peerlog_entries WHERE stream = ? AND seq > ? AND seq <= ? ORDER BY seq").all(stream, from, head)) {
        const text = String(item.entry);
        const size = Buffer.byteLength(text);
        if (entries.length && (entries.length >= BATCH_ENTRIES_LIMIT || bytes + size > SERVE_FRAME_BYTES)) flush();
        const entry = JSON.parse(text) as Entry;
        entries.push(entry);
        bytes += size;
      }
      flush();
    } finally {
      if (began && db.inTransaction) db.exec("COMMIT");
    }
    return out;
  }

  private count(what: CacheTake): CacheTake {
    if (what === "other logId") this.counts.otherLogId++;
    else if (what in this.counts) (this.counts as Record<string, number>)[what]++;
    return what;
  }

  private write(command: (tx: Db) => void): void {
    this.writes = this.writes.then(() => this.options.store.submit(command)).catch((error) => {
      this.log(`pass-through: the cache write failed: ${String((error as Error)?.message ?? error)}`);
    });
  }

  /** Over the cap: whole streams go, least recently used first, in-use and followed ones last. */
  private evict(just: string): void {
    let total = this.totalBytes;
    if (total <= this.capBytes) return;
    const priority = this.options.priority ?? (() => 0);
    const order = [...this.logs.values()].sort((x, y) => {
      const px = priority(x.stream) + (x.stream === just ? 0.5 : 0);
      const py = priority(y.stream) + (y.stream === just ? 0.5 : 0);
      return px - py || x.usedAt - y.usedAt;
    });
    for (const log of order) {
      if (total <= this.capBytes) break;
      total -= log.bytes;
      this.counts.evicted++;
      this.log(`pass-through: cache of ${log.stream} evicted (${log.bytes} bytes; the cache holds at most ${this.capBytes})`);
      this.drop(log.stream);
    }
  }
}
