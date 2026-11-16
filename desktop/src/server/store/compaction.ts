// One-time cleanup of a bloated server.db (decided 2026-11-16: server.db had grown to 8.5 GB, 7.6 GB of it old full
// state snapshots in `entries`: `subagent.updated`, `bot.updated` (also mirrored on `srv:`), `message.updated`).
//
//   1. PRUNE, in the background after botlingd is up (`pruneInBackground`, started by Botlingd.listenAll PRUNE_DELAY_MS
//      after it listens). Doing it at open blocked the start for minutes, and the install script (botling.dev swap.ts
//      HEALTH_WAIT_S_V3 = 120 s, written by the OLD build) puts the old app back when the new one has no window attached
//      by then. It runs as many short writer commands (a few hundred entries each), so nothing else waits for long.
//      Each own log stream (`streams.state` active/archived) loses its old entries by the one eviction the log supports
//      (`evictEntries`, protocol v1 §7.3): the entries up to a cut go, `streams.tail/tailHash` move to the last of them,
//      so the kept rest still chains from `tailHash` to `headHash`. Rows are never taken from the middle (that would
//      break the chain and leave a gap no reader could pass).
//        cut = the stream's newest entries are kept: at most `keepEntries` (500, one catch-up page) and at most
//        `keepBytes` (8 MiB of body), but never fewer than `minKeepEntries` (50). The cut is just below the oldest kept.
//      A reader (window, phone, peer) whose cursor is at or past the tail gets entries as before; one behind it gets a
//      `snap` (hub.ts `pump`), which is built from the read models (`messages`, `cards`, `bots`), not from entries.
//      Those tables are not touched: the history UI, `history` pages and `snap` read them only, and `applyReadModel`
//      only runs on append. So the conversation stays whole; what goes is the old event stream (every
//      `message.added` / `message.updated` / `subagent.updated` / `bot.updated` / `turn.*` entry below the cut).
//      The one reader of entry bodies is `SummaryRows.reconcile`: it takes, from the `srv:` stream, the last
//      `bot.updated` of each bot and the last `settings.updated`. For that stream the latest of each is first written
//      again at the head (an ordinary `appendEntries`, same body) when it lies below the cut and no newer one of it is
//      above the cut (an update that came in during the scan wins), so it stays the "first kept full state" of its
//      object. Bots no longer in `bots` are not carried.
//      Entries are evicted in steps (`batchEntries` per command); a stop or crash between steps leaves a shorter log
//      that still verifies, and the next run plans again and continues. `compaction.pruned` is written when every
//      stream is done.
//   2. VACUUM, at the first start after the prune finished (`runStartupVacuum`, at open, before the writer and any
//      reader exist): `auto_vacuum` is set to INCREMENTAL (it takes effect in the VACUUM) and the file shrinks to its
//      live pages. It needs the whole file and blocks every write, so it cannot be a background job; on the measured
//      sample it took ~23 s for a 0.44 GB result (the file's live pages after the prune are ~0.9 GB for the user's
//      8.5 GB: ~30-40 s), well inside the install script's 120 s. VACUUM is atomic (it replaces the file when done).
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
import { WriterClosedError } from "./writer";

export const PRUNED_KEY = "compaction.pruned";
export const VACUUMED_KEY = "compaction.vacuumed";
/** The last schema whose `entries.body` is always the whole body (v15 and later may hold differences). */
export const PRUNE_MAX_SCHEMA = 14;
/** The background prune starts this long after botlingd listens (the window attaches and `healthy` is written first). */
export const PRUNE_DELAY_MS = 60_000;
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
}

export interface StreamPrune {
  stream: string;
  evicted: number;
  kept: number;
  carried: number;
}

export type VacuumOutcome = "done" | "nothing-to-reclaim" | "low-disk";

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

const bigEnough = (db: Db, options: CompactionOptions): boolean =>
  Number(db.pragma("page_count")) * Number(db.pragma("page_size")) >= (options.minDbBytes ?? 1024 * MIB);

/**
 * The lowest seq to keep of `stream` (entries above `tail`): the newest `keepEntries` entries, fewer when they pass
 * `keepBytes` (but at least `minKeepEntries`). Walks back from the head over contiguous seqs only.
 */
function keepFrom(db: Db, stream: string, head: number, tail: number, keep: Keep): number {
  const rows = db.prepare("SELECT seq, length(CAST(body AS BLOB)) AS n FROM entries WHERE stream = ? AND seq > ? ORDER BY seq DESC LIMIT ?")
    .all(stream, tail, keep.keepEntries);
  let first = head + 1;
  let bytes = 0;
  for (const row of rows) {
    const seq = Number(row.seq);
    if (seq !== first - 1) break; // a gap: keep from just above it
    const size = Number(row.n);
    if (head + 1 - first >= keep.minKeepEntries && bytes + size > keep.keepBytes) break;
    first = seq;
    bytes += size;
  }
  return first;
}

type Keep = Required<Pick<CompactionOptions, "keepEntries" | "keepBytes" | "minKeepEntries">>;

/** The latest `bot.updated` of each bot and `settings.updated` seen so far in an `srv:` stream, by seq (what `reconcile` reads). */
interface LatestState { bots: Map<string, number>; settings: number | null }
const emptyState = (): LatestState => ({ bots: new Map(), settings: null });

/** Adds the state entries with seq in [from, to] of `stream` to `into` (later seqs replace earlier ones). */
function scanLatestState(db: Db, stream: string, from: number, to: number, into: LatestState): void {
  const rows = db.prepare(
    "SELECT seq, kind, json_extract(body, '$.bot.id') AS id, json_extract(body, '$.settings') IS NOT NULL AS has FROM entries " +
    "WHERE stream = ? AND seq >= ? AND seq <= ? AND kind IN ('bot.updated', 'settings.updated') AND json_valid(body) ORDER BY seq",
  ).all(stream, from, to);
  for (const row of rows) {
    if (row.kind === "bot.updated") { if (row.id != null) into.bots.set(String(row.id), Number(row.seq)); }
    else if (Number(row.has) === 1) into.settings = Number(row.seq);
  }
}

/**
 * Writes the latest state entries of `latest` (all at or below `cut`) again at the head of the `srv:` stream, except
 * those a newer entry above `cut` already replaces (an update that came in while the scan ran) and bots that are gone.
 * Returns how many.
 */
function carryLatestState(db: Db, stream: string, cut: number, latest: LatestState): number {
  const newer = emptyState();
  scanLatestState(db, stream, cut + 1, Number.MAX_SAFE_INTEGER, newer);
  const picks: Array<{ seq: number; kind: string }> = [];
  for (const [id, seq] of latest.bots) {
    if (seq > cut || newer.bots.has(id)) continue;
    if (!db.prepare("SELECT 1 FROM bots WHERE botId = ?").get(id)) continue; // a bot that is gone
    picks.push({ seq, kind: "bot.updated" });
  }
  if (latest.settings !== null && latest.settings <= cut && newer.settings === null) picks.push({ seq: latest.settings, kind: "settings.updated" });
  const items: AppendItem[] = [];
  for (const pick of picks.sort((x, y) => x.seq - y.seq)) {
    const row = db.prepare("SELECT body FROM entries WHERE stream = ? AND seq = ?").get(stream, pick.seq);
    if (row) items.push({ kind: pick.kind, body: JSON.parse(String(row.body)) as Record<string, unknown> });
  }
  if (items.length) appendEntries(db, stream, items);
  return items.length;
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
  log(`compaction: VACUUM starts (the start waits for it, about ${Math.max(1, Math.round(result / MIB / 20))} s)`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const after = fileBytes(db);
  log(`compaction: VACUUM took ${((performance.now() - started) / 1000).toFixed(1)} s: ${(before / MIB).toFixed(0)} MiB -> ${(after / MIB).toFixed(0)} MiB (auto_vacuum ${String(db.pragma("auto_vacuum"))})`);
  return "done";
}

export interface VacuumReport { vacuum: VacuumOutcome | null; bytesBefore: number; bytesAfter: number }

/**
 * At open, on the writer connection with no transaction open and no other connection: the one-time VACUUM, once the
 * background prune has finished (its marker is there). Does nothing before that, so a start never waits for the prune.
 */
export function runStartupVacuum(db: Db, options: CompactionOptions = {}): VacuumReport {
  const log = options.log ?? (() => undefined);
  const none: VacuumReport = { vacuum: null, bytesBefore: 0, bytesAfter: 0 };
  const version = schemaVersion(db);
  if (version < 2 || version > PRUNE_MAX_SCHEMA) return none;
  if (marker(db, PRUNED_KEY) === null || marker(db, VACUUMED_KEY) !== null) return none;
  const bytesBefore = fileBytes(db);
  const outcome = vacuum(db, options, log);
  if (outcome === "done" || outcome === "nothing-to-reclaim") setMarker(db, VACUUMED_KEY, { at: (options.now ?? Date.now)(), outcome });
  return { vacuum: outcome, bytesBefore, bytesAfter: fileBytes(db) };
}

export interface PruneReport {
  ran: boolean;
  /** Why nothing was done at all ("small", "schema", "done"), or null. */
  skipped: string | null;
  streams: StreamPrune[];
  failed: string[];
  /** Stopped before every stream was done (botlingd is stopping); no marker was written. */
  stopped: boolean;
  /** Writer commands the prune used (each one a short transaction). */
  commands: number;
}

export interface PruneDeps extends CompactionOptions {
  /** Runs a synchronous command inside the writer (`store.submit`): one short transaction. */
  submit<T>(command: (db: Db) => T): Promise<T>;
  /** Entries evicted per command (default 200). */
  batchEntries?: number;
  /** Seqs scanned per command when looking for the latest state of the `srv:` stream (default 200). */
  scanSpan?: number;
  /** Called after a stream's entries changed: readers behind the new tail get a snap (hub.committed). */
  changed?: (stream: string) => void;
  /** Between two commands, so the writer's other work goes first (default 25 ms). */
  pause?: () => Promise<void>;
  stopped?: () => boolean;
}

const pausing = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

/**
 * The one-time prune, as many short writer commands (see the top of this file for the rule). Resumable: it plans each
 * stream afresh, so a run that was stopped or killed is continued by the next. Returns what it did.
 */
export async function pruneInBackground(deps: PruneDeps): Promise<PruneReport> {
  const log = deps.log ?? (() => undefined);
  const report: PruneReport = { ran: false, skipped: null, streams: [], failed: [], stopped: false, commands: 0 };
  const run = <T>(command: (db: Db) => T): Promise<T> => { report.commands += 1; return deps.submit(command); };
  const stopped = () => deps.stopped?.() === true;
  try {
    const gate = await run((db) => {
      const version = schemaVersion(db);
      if (version < 2 || version > PRUNE_MAX_SCHEMA) return { skip: "schema", streams: [] as string[] };
      if (marker(db, PRUNED_KEY) !== null) return { skip: "done", streams: [] as string[] };
      if (!bigEnough(db, deps)) return { skip: "small", streams: [] as string[] };
      const streams = db.prepare("SELECT stream FROM streams WHERE state IN ('active', 'archived') ORDER BY stream").all().map((row) => String(row.stream));
      return { skip: null, streams };
    });
    if (gate.skip) return { ...report, skipped: gate.skip };
    report.ran = true;
    const started = performance.now();
    log(`compaction: pruning old log entries of ${gate.streams.length} streams in the background`);
    for (const stream of gate.streams) {
      if (stopped()) { report.stopped = true; break; }
      try {
        const done = await pruneStream(deps, run, stream);
        report.streams.push(done.result);
        if (done.result.evicted || done.result.carried) log(`compaction: ${stream}: evicted ${done.result.evicted} old entries, kept ${done.result.kept}${done.result.carried ? ` (${done.result.carried} latest state entries written again)` : ""}`);
        if (done.stopped) { report.stopped = true; break; }
      } catch (error) {
        if (error instanceof WriterClosedError) { report.stopped = true; break; }
        report.failed.push(stream);
        log(`compaction: ${stream} left as it is: ${String((error as Error)?.message ?? error)}`);
      }
    }
    const evicted = report.streams.reduce((sum, item) => sum + item.evicted, 0);
    if (!report.stopped && !report.failed.length) {
      await run((db) => setMarker(db, PRUNED_KEY, { at: (deps.now ?? Date.now)(), streams: report.streams.length, evicted }));
    }
    const how = report.stopped ? " (stopped; it continues at the next start)" : report.failed.length ? " (some streams failed; tried again at the next start)" : "; the VACUUM follows at the next start";
    log(`compaction: pruned ${report.streams.length} streams, ${evicted} entries evicted in ${report.commands} short commands, ${((performance.now() - started) / 1000).toFixed(1)} s${how}`);
  } catch (error) {
    if (error instanceof WriterClosedError) return { ...report, stopped: true };
    throw error;
  }
  return report;
}

async function pruneStream(deps: PruneDeps, run: <T>(command: (db: Db) => T) => Promise<T>, stream: string): Promise<{ result: StreamPrune; stopped: boolean }> {
  const keep: Keep = { keepEntries: deps.keepEntries ?? 500, keepBytes: deps.keepBytes ?? 8 * MIB, minKeepEntries: deps.minKeepEntries ?? 50 };
  const batch = Math.max(1, deps.batchEntries ?? 200);
  const span = Math.max(1, deps.scanSpan ?? 200);
  const pause = deps.pause ?? pausing;
  const stopped = () => deps.stopped?.() === true;
  const plan = await run((db) => {
    const row = readStream(db, stream);
    if (!row) throw new Error(`stream ${stream} vanished`);
    return { head: row.head, tail: row.tail, cut: keepFrom(db, stream, row.head, row.tail, keep) - 1, state: row.state };
  });
  const kept = (carried: number) => plan.head - Math.max(plan.cut, plan.tail) + carried;
  if (plan.cut <= plan.tail) return { result: { stream, evicted: 0, kept: kept(0), carried: 0 }, stopped: false };
  let carried = 0;
  if (stream.startsWith("srv:")) {
    if (plan.state !== "active") throw new Error(`${stream} is ${plan.state}: its latest state entries cannot be written again`);
    const latest = emptyState();
    for (let from = plan.tail + 1; from <= plan.cut; from += span) {
      if (stopped()) return { result: { stream, evicted: 0, kept: kept(0), carried: 0 }, stopped: true };
      await run((db) => scanLatestState(db, stream, from, Math.min(plan.cut, from + span - 1), latest));
      await pause();
    }
    carried = await run((db) => carryLatestState(db, stream, plan.cut, latest));
    if (carried) deps.changed?.(stream);
  }
  let evicted = 0;
  for (;;) {
    if (stopped()) { if (evicted) deps.changed?.(stream); return { result: { stream, evicted, kept: kept(carried), carried }, stopped: true }; }
    const step = await run((db) => {
      const row = readStream(db, stream);
      if (!row) throw new Error(`stream ${stream} vanished`);
      if (row.tail >= plan.cut) return { count: 0, done: true };
      const to = Math.min(plan.cut, row.tail + batch);
      return { count: evictEntries(db, stream, to), done: to >= plan.cut };
    });
    evicted += step.count;
    if (step.done) break;
    await pause();
  }
  if (evicted) deps.changed?.(stream);
  return { result: { stream, evicted, kept: kept(carried), carried }, stopped: false };
}

export interface BackgroundPrune { stop(): Promise<void> }

/**
 * Starts the prune `delayMs` from now (default PRUNE_DELAY_MS). `stop()` ends it: the step under way finishes, nothing
 * new starts, and the returned promise settles when it is over (call it before the writer closes).
 */
export function startBackgroundPrune(deps: PruneDeps & { delayMs?: number }): BackgroundPrune {
  let stopping = false;
  let running: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = setTimeout(() => {
    timer = null;
    if (stopping) return;
    running = pruneInBackground({ ...deps, stopped: () => stopping || deps.stopped?.() === true })
      .catch((error) => deps.log?.(`compaction: prune failed: ${String((error as Error)?.message ?? error)}`));
  }, deps.delayMs ?? PRUNE_DELAY_MS);
  timer.unref();
  return {
    async stop() {
      stopping = true;
      if (timer) { clearTimeout(timer); timer = null; }
      await running;
    },
  };
}
