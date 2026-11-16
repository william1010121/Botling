// One-time cleanup of a bloated server.db (decided 2026-11-16: server.db had grown to 8.5 GB, 7.6 GB of it old full
// state snapshots in `entries`: `subagent.updated`, `bot.updated` (also mirrored on `srv:`), `message.updated`).
// Runs when the file is opened (`openServerStore`), before the pre-migration backup, the writer and any reader:
//
//   1. PRUNE. Each own log stream (`streams.state` active/archived) loses its old entries by the one eviction the log
//      supports (`evictEntries`, protocol v1 §7.3): the entries up to a cut go, `streams.tail/tailHash` move to the
//      last of them, so the kept rest still chains from `tailHash` to `headHash`. Rows are never taken from the middle
//      (that would break the chain and leave a gap no reader could pass).
//        cut = the stream's newest entries are kept: at most `keepEntries` (500, one catch-up page) and at most
//        `keepBytes` (8 MiB of body), but never fewer than `minKeepEntries` (50). The cut is just below the oldest kept.
//      A reader (window, phone, peer) whose cursor is at or past the tail gets entries as before; one behind it gets a
//      `snap` (hub.ts `pump`), which is built from the read models (`messages`, `cards`, `bots`), not from entries.
//      Those tables are not touched: the history UI, `history` pages and `snap` read them only, and `applyReadModel`
//      only runs on append. So the conversation stays whole; what goes is the old event stream (every
//      `message.added` / `message.updated` / `subagent.updated` / `bot.updated` / `turn.*` entry below the cut).
//      The one reader of entry bodies is `SummaryRows.reconcile`: it takes, from the `srv:` stream, the last
//      `bot.updated` of each bot and the last `settings.updated`. For that stream the latest of each is first written
//      again at the head (an ordinary `appendEntries`, same body) when it lies below the cut, so it stays the "first
//      kept full state" of its object. Bots no longer in `bots` are not carried.
//      Each stream is one transaction: a crash keeps the stream as it was, and a second run finds nothing to evict.
//   2. VACUUM, once the prune is done and the disk has room: `auto_vacuum` is set to INCREMENTAL (it takes effect in the
//      VACUUM) and the file shrinks to its live pages. VACUUM is atomic (it only replaces the file when finished).
//
// Run once: `meta` keys `compaction.pruned` and `compaction.vacuumed` (JSON: when and what). A VACUUM skipped for lack
// of disk is tried again at the next start. A file under `minDbBytes` (1 GiB) is left alone and gets no marker: this
// is for the one old oversized file, not for the normal history of a young one. Only the schemas up to
// PRUNE_MAX_SCHEMA are pruned: later ones may store bodies as differences and need the decoding reads of log-store.
import { statfsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { appendEntries, evictEntries, readStream, type AppendItem } from "../log/log-store";
import { schemaVersion } from "./schema";
import type { Db } from "./sqlite";

export const PRUNED_KEY = "compaction.pruned";
export const VACUUMED_KEY = "compaction.vacuumed";
/** The last schema whose `entries.body` is always the whole body (v15 and later may hold differences). */
export const PRUNE_MAX_SCHEMA = 14;
const MIB = 1024 * 1024;

export interface CompactionOptions {
  log?: (line: string) => void;
  /** Files smaller than this are left alone (default 1 GiB). */
  minDbBytes?: number;
  keepEntries?: number;
  keepBytes?: number;
  minKeepEntries?: number;
  /** VACUUM only when at least this much would come back (default 64 MiB). */
  minReclaimBytes?: number;
  /** Free space kept untouched on top of what VACUUM needs (default 1 GiB). */
  headroomBytes?: number;
  /** Free bytes on the volume holding `path` (default: statfs). */
  freeBytes?: (path: string) => number;
  now?: () => number;
  /** Test seam: runs inside a stream's transaction after its eviction, before COMMIT (a throw is a crash). */
  beforeCommit?: (stream: string) => void;
}

export interface StreamPrune {
  stream: string;
  evicted: number;
  kept: number;
  carried: number;
}

export type VacuumOutcome = "done" | "nothing-to-reclaim" | "low-disk" | "skipped";

export interface CompactionReport {
  ran: boolean;
  /** Why nothing was done at all ("small", "schema", "done"), or null. */
  skipped: string | null;
  streams: StreamPrune[];
  failed: string[];
  vacuum: VacuumOutcome | null;
  bytesBefore: number;
  bytesAfter: number;
}

function fileBytes(db: Db): number {
  let total = 0;
  for (const suffix of ["", "-wal"]) {
    try { total += statSync(db.path + suffix).size; } catch { /* no such file */ }
  }
  return total;
}

function freeOf(path: string): number {
  const stat = statfsSync(path);
  return Number(stat.bavail) * Number(stat.bsize);
}

function marker(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? String(row.value) : null;
}

function setMarker(db: Db, key: string, value: unknown): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}

/**
 * The lowest seq to keep of `stream` (entries above `tail`): the newest `keepEntries` entries, fewer when they pass
 * `keepBytes` (but at least `minKeepEntries`). Walks back from the head over contiguous seqs only.
 */
function keepFrom(db: Db, stream: string, head: number, tail: number, options: Required<Pick<CompactionOptions, "keepEntries" | "keepBytes" | "minKeepEntries">>): number {
  const rows = db.prepare("SELECT seq, length(CAST(body AS BLOB)) AS n FROM entries WHERE stream = ? AND seq > ? ORDER BY seq DESC LIMIT ?")
    .all(stream, tail, options.keepEntries);
  let first = head + 1;
  let bytes = 0;
  for (const row of rows) {
    const seq = Number(row.seq);
    if (seq !== first - 1) break; // a gap: keep from just above it
    const size = Number(row.n);
    if (head + 1 - first >= options.minKeepEntries && bytes + size > options.keepBytes) break;
    first = seq;
    bytes += size;
  }
  return first;
}

/** The latest `bot.updated` of each bot and `settings.updated` of an `srv:` stream, by seq (the reads `reconcile` makes). */
function latestStateEntries(db: Db, stream: string): Array<{ seq: number; kind: string; botId: string | null }> {
  const found: Array<{ seq: number; kind: string; botId: string | null }> = [];
  const bots = db.prepare(
    "SELECT json_extract(body, '$.bot.id') AS id, max(seq) AS seq FROM entries " +
    "WHERE stream = ? AND kind = 'bot.updated' AND json_valid(body) GROUP BY id HAVING id IS NOT NULL",
  ).all(stream);
  for (const row of bots) found.push({ seq: Number(row.seq), kind: "bot.updated", botId: String(row.id) });
  const settings = db.prepare(
    "SELECT max(seq) AS seq FROM entries WHERE stream = ? AND kind = 'settings.updated' AND json_valid(body) AND json_extract(body, '$.settings') IS NOT NULL",
  ).get(stream);
  if (settings?.seq != null) found.push({ seq: Number(settings.seq), kind: "settings.updated", botId: null });
  return found.sort((a, b) => a.seq - b.seq);
}

/** Writes the latest state entries that lie at or below `cut` again at the head of the `srv:` stream. Returns how many. */
function carryLatestState(db: Db, stream: string, cut: number): number {
  const items: AppendItem[] = [];
  for (const latest of latestStateEntries(db, stream)) {
    if (latest.seq > cut) continue; // already in the kept part
    if (latest.botId !== null && !db.prepare("SELECT 1 FROM bots WHERE botId = ?").get(latest.botId)) continue; // a bot that is gone
    const row = db.prepare("SELECT body FROM entries WHERE stream = ? AND seq = ?").get(stream, latest.seq);
    if (row) items.push({ kind: latest.kind, body: JSON.parse(String(row.body)) as Record<string, unknown> });
  }
  if (items.length) appendEntries(db, stream, items);
  return items.length;
}

function pruneStream(db: Db, stream: string, options: CompactionOptions, keep: Required<Pick<CompactionOptions, "keepEntries" | "keepBytes" | "minKeepEntries">>): StreamPrune {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = readStream(db, stream);
    if (!row) throw new Error(`stream ${stream} vanished`);
    const first = keepFrom(db, stream, row.head, row.tail, keep);
    const cut = first - 1;
    let evicted = 0;
    let carried = 0;
    if (cut > row.tail) {
      if (stream.startsWith("srv:")) {
        if (row.state !== "active") throw new Error(`${stream} is ${row.state}: its latest state entries cannot be written again`);
        carried = carryLatestState(db, stream, cut);
      }
      evicted = evictEntries(db, stream, cut);
    }
    options.beforeCommit?.(stream);
    db.exec("COMMIT");
    return { stream, evicted, kept: row.head + carried - Math.max(cut, row.tail), carried };
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function vacuum(db: Db, options: CompactionOptions, log: (line: string) => void): VacuumOutcome {
  const pageSize = Number(db.pragma("page_size"));
  const pages = Number(db.pragma("page_count"));
  const free = Number(db.pragma("freelist_count"));
  const reclaim = free * pageSize;
  if (reclaim < (options.minReclaimBytes ?? 64 * MIB)) {
    log(`compaction: VACUUM skipped, only ${(reclaim / MIB).toFixed(1)} MiB would come back`);
    return "nothing-to-reclaim";
  }
  // The new file is as big as the live pages; it is built in the temp folder and then copied back through the WAL.
  // Measured on a 1.8 GB sample (result 0.44 GB): temp + WAL + the prune's WAL peaked at 1.1 GB above the old file,
  // 2.5x the result. So the data folder's volume needs 3x the result, the temp folder's 1x, each with headroom.
  const result = (pages - free) * pageSize;
  const headroom = options.headroomBytes ?? 1024 * MIB;
  const freeBytes = options.freeBytes ?? freeOf;
  const dataFree = freeBytes(dirname(db.path));
  const tempFree = freeBytes(process.env.SQLITE_TMPDIR || tmpdir());
  if (dataFree < 3 * result + headroom || tempFree < result + headroom) {
    log(`compaction: VACUUM skipped: it needs about ${((3 * result + headroom) / MIB).toFixed(0)} MiB free beside server.db and ${((result + headroom) / MIB).toFixed(0)} MiB in the temp folder; ${(dataFree / MIB).toFixed(0)} MiB and ${(tempFree / MIB).toFixed(0)} MiB are free. It is tried again at the next start.`);
    return "low-disk";
  }
  const started = performance.now();
  const before = fileBytes(db);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const after = fileBytes(db);
  log(`compaction: VACUUM took ${((performance.now() - started) / 1000).toFixed(1)} s: ${(before / MIB).toFixed(0)} MiB -> ${(after / MIB).toFixed(0)} MiB (auto_vacuum ${String(db.pragma("auto_vacuum"))})`);
  return "done";
}

/**
 * Runs the one-time prune and VACUUM on the writer connection `db` (no transaction open, no other connection).
 * Returns what it did. Throws only on a crash-like error (a failed stream is logged and left whole).
 */
export function runCompaction(db: Db, options: CompactionOptions = {}): CompactionReport {
  const log = options.log ?? (() => undefined);
  const report: CompactionReport = { ran: false, skipped: null, streams: [], failed: [], vacuum: null, bytesBefore: 0, bytesAfter: 0 };
  const version = schemaVersion(db);
  if (version < 2) return { ...report, skipped: "schema" };
  if (version > PRUNE_MAX_SCHEMA) return { ...report, skipped: "schema" };
  const pruned = marker(db, PRUNED_KEY) !== null;
  const vacuumed = marker(db, VACUUMED_KEY) !== null;
  if (pruned && vacuumed) return { ...report, skipped: "done" };
  report.bytesBefore = fileBytes(db);
  if (!pruned && Number(db.pragma("page_count")) * Number(db.pragma("page_size")) < (options.minDbBytes ?? 1024 * MIB)) {
    return { ...report, skipped: "small" };
  }
  report.ran = true;
  const keep = { keepEntries: options.keepEntries ?? 500, keepBytes: options.keepBytes ?? 8 * MIB, minKeepEntries: options.minKeepEntries ?? 50 };
  if (!pruned) {
    const started = performance.now();
    const streams = db.prepare("SELECT stream FROM streams WHERE state IN ('active', 'archived') ORDER BY stream").all().map((row) => String(row.stream));
    for (const stream of streams) {
      try {
        const done = pruneStream(db, stream, options, keep);
        report.streams.push(done);
        if (done.evicted) log(`compaction: ${stream}: evicted ${done.evicted} old entries, kept ${done.kept}${done.carried ? ` (${done.carried} latest state entries written again)` : ""}`);
      } catch (error) {
        report.failed.push(stream);
        log(`compaction: ${stream} left whole: ${String((error as Error)?.message ?? error)}`);
      }
    }
    const evicted = report.streams.reduce((sum, item) => sum + item.evicted, 0);
    log(`compaction: pruned ${report.streams.length} streams, ${evicted} entries evicted, ${((performance.now() - started) / 1000).toFixed(1)} s`);
    if (!report.failed.length) setMarker(db, PRUNED_KEY, { at: (options.now ?? Date.now)(), streams: report.streams.length, evicted });
  }
  if (report.failed.length) {
    report.vacuum = "skipped"; // the prune is tried again at the next start, and the VACUUM after it
  } else if (!vacuumed) {
    report.vacuum = vacuum(db, options, log);
    if (report.vacuum === "done" || report.vacuum === "nothing-to-reclaim") setMarker(db, VACUUMED_KEY, { at: (options.now ?? Date.now)(), outcome: report.vacuum });
  }
  report.bytesAfter = fileBytes(db);
  return report;
}
