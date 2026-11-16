// Bot log streams in server.db (protocol v1 §7.3, §7.6, §8.1, §8.3): synchronous functions over a `Db`.
// Writes (`ensureStream`, `appendEntries`, `retireStream`, `evictEntries`) run inside a writer command, so an append
// commits with the rest of its command (read models, receipt, effects) or not at all. Reads run on any connection.
//
// Storage: `entries.body` is the canonical JSON of the body, `hlc` and `slot` are JSON; `entries.logId` is the
// incarnation the entry was appended in (seq numbering continues across a restore, so a stream's rows can span
// several logIds). `streams.head/headHash` are the last entry; `streams.tail/tailHash` the last evicted one.
//
// Snapshot kinds (`subagent.updated`, `bot.updated`, `message.added`, `message.updated`) are stored as diffs: a row has
// an object key `okey` (`s:<id>`, `b:<id>`, `m:<id>`); `base` NULL means `body` is the whole body (a baseline), else
// `body` is a patch (diff.ts) against the object's previous state and `base` is the seq of the baseline it hangs on.
// The hash is taken over the whole body before it is encoded, so it, the wire format and every reader are unchanged:
// ONLY this file reads or writes `entries.body` (`appendEntries` encodes; `readEntries` / `rowToEntry` decode and check
// the hash again, and a row that does not decode or does not hash right is never handed out: `unreadable`).
import { randomBytes } from "node:crypto";
import { canonicalJson, Entry, GENESIS_HASH, type EntryContent, type Hlc, type Slot, type StreamId } from "../../protocol";
import { FRAME_LIMIT } from "../../protocol/frame";
import type { Db, SqlRow } from "../store";
import { hashEntry, verifyChain, type ChainCheck } from "./chain";
import { applyPatch, diffJson, DiffError, type PatchOp } from "./diff";
import { applyReadModel } from "./read-model";

/** An entry's JSON must leave room in one `batch` frame for the frame's own fields (stream, logId, prevHash, …). */
export const ENTRY_BYTES_LIMIT = FRAME_LIMIT - 4 * 1024;

export type StreamState = "active" | "archived" | "live" | "stale" | "gone";

export interface StreamRow {
  stream: StreamId;
  owner: string;
  logId: string;
  head: number;
  headHash: string;
  tail: number;
  tailHash: string;
  state: StreamState;
}

export interface RetiredLog {
  logId: string;
  keptSeq: number;
  reason: "restored" | "rewind";
}

export interface AppendItem {
  kind: string;
  body: Record<string, unknown>;
  slot?: Slot;
  /** Defaults to the stream's hybrid logical clock at the time of the append. */
  hlc?: Hlc;
}

export class LogError extends Error {
  constructor(readonly code: "unknown stream" | "not own" | "invalid entry" | "too large" | "no transaction", message: string) {
    super(message);
    this.name = "LogError";
  }
}

/** A random incarnation id (16 base64url characters, 96 bits). */
export function newLogId(): string {
  return randomBytes(12).toString("base64url");
}

function toStream(row: SqlRow): StreamRow {
  return {
    stream: String(row.stream) as StreamId,
    owner: String(row.owner),
    logId: String(row.logId),
    head: Number(row.head),
    headHash: row.headHash == null ? GENESIS_HASH : String(row.headHash),
    tail: Number(row.tail),
    tailHash: row.tailHash == null ? GENESIS_HASH : String(row.tailHash),
    state: String(row.state) as StreamState,
  };
}

export function readStream(db: Db, stream: string): StreamRow | null {
  const row = db.prepare("SELECT stream, owner, logId, head, headHash, tail, tailHash, state FROM streams WHERE stream = ?").get(stream);
  return row ? toStream(row) : null;
}

function requireTransaction(db: Db, what: string): void {
  if (!db.inTransaction) throw new LogError("no transaction", `${what} must run inside a writer command`);
}

/** The stream's row, made (active, owned by this server, a fresh logId, empty) when missing. */
export function ensureStream(db: Db, stream: StreamId, owner?: string): StreamRow {
  const found = readStream(db, stream);
  if (found) return found;
  requireTransaction(db, "ensureStream");
  const serverId = owner ?? String(db.prepare("SELECT value FROM meta WHERE key = 'serverId'").get()?.value ?? "");
  db.prepare("INSERT INTO streams (stream, owner, logId, head, headHash, state, tail, tailHash) VALUES (?, ?, ?, 0, ?, 'active', 0, ?)")
    .run(stream, serverId, newLogId(), GENESIS_HASH, GENESIS_HASH);
  return readStream(db, stream)!;
}

function rowToEntry(stream: string, row: SqlRow, body: Record<string, unknown>): Entry {
  const entry: Entry = {
    stream: stream as StreamId,
    logId: String(row.logId),
    seq: Number(row.seq),
    hlc: JSON.parse(String(row.hlc)) as Hlc,
    kind: String(row.kind),
    body,
    hash: String(row.hash),
  };
  if (row.slot != null) entry.slot = JSON.parse(String(row.slot)) as Slot;
  return entry;
}

// ---- Snapshot bodies stored as diffs -------------------------------------------------------------------------------

/** Kinds whose body is a whole state of one object, stored as diffs against that object's previous state. */
export function okeyOf(kind: string, body: Record<string, unknown>): string | null {
  const field = kind === "subagent.updated" ? "subagent" : kind === "bot.updated" ? "bot"
    : kind === "message.added" || kind === "message.updated" ? "message" : null;
  if (!field) return null;
  const object = body[field];
  const id = typeof object === "object" && object !== null ? (object as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !id) return null;
  return `${field === "subagent" ? "s" : field === "bot" ? "b" : "m"}:${id}`;
}

/**
 * Streams whose bodies are still read with raw SQL by code outside this file (`replica/summary.ts` reads the `srv:`
 * stream's `bot.updated` and `settings.updated` bodies as full JSON). Their rows are tracked (`okey`) but always stored
 * whole, until those readers decode through `readEntries`; then this predicate goes (one line).
 */
function storedWhole(stream: string): boolean {
  return stream.startsWith("srv:");
}

/** At most this many diffs hang on one baseline (the read applies them one by one). */
export const MAX_DIFFS_PER_BASE = 200;
/** A body shorter than this is always stored whole (a patch would save nothing). */
const MIN_DIFF_BODY_BYTES = 256;
/** Upper bound of the writer's cache of object states (UTF-16 units of their JSON, about 64 MB). */
const STATE_CACHE_LIMIT = 32 * 1024 * 1024;

/** An object's current state and what the next row needs to know to choose between a diff and a new baseline. */
interface ObjState {
  /** The state, parsed lazily from `json` (a baseline row read as it is stored). */
  value: unknown;
  json: string | null;
  baseSeq: number;
  baseBytes: number;
  diffCount: number;
  diffBytes: number;
  /** The row this state is the result of, and its hash: a cached state is used only while that row is still there. */
  seq: number;
  hash: string;
}

const valueOf = (state: ObjState): unknown => {
  if (state.json !== null) { state.value = JSON.parse(state.json); state.json = null; }
  return state.value;
};

/** The next state of an object after its row: a baseline replaces it, a diff (hanging on the same baseline) patches it. */
function step(state: ObjState | null, row: { seq: number; body: string; base: number | null; hash: string }): ObjState {
  if (row.base === null) return { value: null, json: row.body, baseSeq: row.seq, baseBytes: row.body.length, diffCount: 0, diffBytes: 0, seq: row.seq, hash: row.hash };
  if (!state || state.baseSeq !== row.base) throw new DiffError(`entry ${row.seq} hangs on baseline ${row.base}, which is not the object's state`);
  const base = state.json !== null ? JSON.parse(state.json) : state.value;
  const value = applyPatch(base, JSON.parse(row.body));
  return { value, json: null, baseSeq: state.baseSeq, baseBytes: state.baseBytes, diffCount: state.diffCount + 1, diffBytes: state.diffBytes + row.body.length, seq: row.seq, hash: row.hash };
}

/** The hash before `seq` (GENESIS_HASH for 1), from the entry before it or the stream's tail; null when unknown. */
function hashBefore(db: Db, stream: string, seq: number): string | null {
  if (seq <= 1) return GENESIS_HASH;
  const found = db.prepare("SELECT hash FROM entries WHERE stream = ? AND seq = ?").get(stream, seq - 1);
  if (found) return String(found.hash);
  const tail = db.prepare("SELECT tail, tailHash FROM streams WHERE stream = ?").get(stream);
  if (tail && Number(tail.tail) === seq - 1) return tail.tailHash == null ? GENESIS_HASH : String(tail.tailHash);
  return null;
}

/** Whether `body` is what row `row` of `stream` hashes: the check every decoded diff passes before it is used. */
function hashesRight(stream: string, row: SqlRow, body: unknown, prevHash: string | null): boolean {
  if (prevHash === null) return false;
  const content: EntryContent = {
    stream: stream as StreamId, logId: String(row.logId), seq: Number(row.seq), hlc: JSON.parse(String(row.hlc)) as Hlc, kind: String(row.kind),
    body: body as Record<string, unknown>, ...(row.slot != null ? { slot: JSON.parse(String(row.slot)) as Slot } : {}),
  };
  return hashEntry(prevHash, content) === String(row.hash);
}

const ROW_COLUMNS = "seq, logId, hlc, kind, body, slot, hash, okey, base";

/**
 * Lookups by object key (okey). Each pins the partial index `entries_by_okey` (it holds only the rows written since schema
 * 15) with `INDEXED BY`, and says `okey IS NOT NULL` so SQLite accepts the pin. Without it the planner takes the primary
 * key (stream) and tests `okey` on every row of the stream, reading each huge `body`: with all okey NULL (a database
 * migrated to v15) every first-seen object scanned the whole stream (~21 s on a 93k-row stream) on the writer's thread.
 */
export const CURRENT_STATE_SQL =
  "SELECT seq, base FROM entries INDEXED BY entries_by_okey WHERE stream = ? AND okey IS NOT NULL AND okey = ? ORDER BY seq DESC LIMIT 1";
export const LOAD_CHAIN_SQL =
  `SELECT ${ROW_COLUMNS} FROM entries INDEXED BY entries_by_okey WHERE stream = ? AND okey IS NOT NULL AND okey = ? AND seq >= ? AND seq < ? ORDER BY seq`;
export const REBASE_UPDATE_SQL =
  "UPDATE entries INDEXED BY entries_by_okey SET base = ? WHERE stream = ? AND okey IS NOT NULL AND okey = ? AND base = ? AND seq > ?";

/**
 * Walks the object's rows from its baseline `base` up to (not including) `before`, or to its newest row when `before` is
 * null; null when the chain does not hold together (a missing baseline, a patch that does not fit, a wrong hash at the
 * end). The result is the object's state after the last row it walked.
 */
function loadChain(db: Db, stream: string, okey: string, base: number, before: number | null): ObjState | null {
  const rows = db.prepare(LOAD_CHAIN_SQL)
    .all(stream, okey, base, before ?? Number.MAX_SAFE_INTEGER);
  if (!rows.length || Number(rows[0].seq) !== base || rows[0].base !== null) return null;
  let state: ObjState | null = null;
  try {
    for (const row of rows) state = step(state, { seq: Number(row.seq), body: String(row.body), base: row.base == null ? null : Number(row.base), hash: String(row.hash) });
  } catch (error) {
    if (error instanceof DiffError || error instanceof SyntaxError) return null;
    throw error;
  }
  const last = rows[rows.length - 1];
  if (last.base !== null && !hashesRight(stream, last, valueOf(state!), hashBefore(db, stream, Number(last.seq)))) return null;
  return state;
}

/** The writer's cache of object states, one per connection; every use re-checks that the cached row is still the stored one. */
const caches = new WeakMap<Db, Map<string, ObjState>>();
const cacheSizes = new WeakMap<Db, number>();

function cacheOf(db: Db): Map<string, ObjState> {
  let cache = caches.get(db);
  if (!cache) { cache = new Map(); caches.set(db, cache); cacheSizes.set(db, 0); }
  return cache;
}

const sizeOf = (state: ObjState): number => state.baseBytes + state.diffBytes + 64;

function remember(db: Db, key: string, state: ObjState): void {
  const cache = cacheOf(db);
  let total = cacheSizes.get(db)!;
  const old = cache.get(key);
  if (old) { total -= sizeOf(old); cache.delete(key); }
  cache.set(key, state);
  total += sizeOf(state);
  for (const [oldest, value] of cache) {
    if (total <= STATE_CACHE_LIMIT || oldest === key) break;
    cache.delete(oldest);
    total -= sizeOf(value);
  }
  cacheSizes.set(db, total);
}

/** The object's newest stored state: from the cache when its row is still there, else rebuilt from the table (null: none). */
function currentState(db: Db, stream: string, okey: string): ObjState | null {
  const key = `${stream}\u0000${okey}`;
  const cached = cacheOf(db).get(key);
  if (cached) {
    const row = db.prepare("SELECT hash FROM entries WHERE stream = ? AND seq = ?").get(stream, cached.seq);
    if (row && String(row.hash) === cached.hash) return cached;
  }
  const last = db.prepare(CURRENT_STATE_SQL).get(stream, okey);
  if (!last) return null;
  const state = loadChain(db, stream, okey, last.base == null ? Number(last.seq) : Number(last.base), null);
  if (state) remember(db, key, state);
  return state;
}

/**
 * Whether `body` is what the object's newest stored state already is (a redraw of the same state, nothing to log).
 * Only the snapshot kinds have a state to compare with; every other kind, and an object not seen yet, is never "same".
 */
export function sameAsStored(db: Db, stream: string, kind: string, body: Record<string, unknown>): boolean {
  const okey = okeyOf(kind, body);
  if (!okey) return false;
  const state = currentState(db, stream, okey);
  return !!state && diffJson(valueOf(state), JSON.parse(canonicalJson(body))).length === 0;
}

interface StoredBody { okey: string | null; base: number | null; body: string }

/** What goes into `entries` for this entry, and the cache's new state of its object. */
function encodeBody(db: Db, stream: string, seq: number, kind: string, bodyJson: string, item: Record<string, unknown>, hash: string): StoredBody {
  const okey = okeyOf(kind, item);
  if (!okey) return { okey: null, base: null, body: bodyJson };
  const key = `${stream}\u0000${okey}`;
  const next = JSON.parse(bodyJson) as unknown;
  const baseline = (): StoredBody => {
    remember(db, key, { value: next, json: null, baseSeq: seq, baseBytes: bodyJson.length, diffCount: 0, diffBytes: 0, seq, hash });
    return { okey, base: null, body: bodyJson };
  };
  if (storedWhole(stream) || bodyJson.length < MIN_DIFF_BODY_BYTES) return baseline();
  const prev = currentState(db, stream, okey);
  if (!prev) return baseline();
  const patch = JSON.stringify(diffJson(valueOf(prev), next) satisfies PatchOp[]);
  // A new baseline when the diffs since the last one would outweigh a whole body, or are too many to apply one by one.
  if (patch.length >= bodyJson.length || prev.diffCount + 1 > MAX_DIFFS_PER_BASE || prev.diffBytes + patch.length > prev.baseBytes) return baseline();
  remember(db, key, { value: next, json: null, baseSeq: prev.baseSeq, baseBytes: prev.baseBytes, diffCount: prev.diffCount + 1, diffBytes: prev.diffBytes + patch.length, seq, hash });
  return { okey, base: prev.baseSeq, body: patch };
}

/** The next clock value after `last`: never behind it, never behind `now`. */
export function nextHlc(last: Hlc | null, now: number): Hlc {
  const ms = Math.max(Math.floor(now), last?.ms ?? 0);
  if (!last || ms > last.ms) return { ms, c: 0 };
  return last.c < 0xffff ? { ms, c: last.c + 1 } : { ms: ms + 1, c: 0 };
}

/**
 * Appends entries to an own, active stream: each gets the next seq of the current logId and its hash chained to the
 * previous one; the read models follow (read-model.ts). Must run inside a writer command; returns the entries as
 * stored. A malformed or oversized entry throws and the command rolls back to its savepoint.
 */
export function appendEntries(db: Db, stream: StreamId, items: readonly AppendItem[], options: { now?: number } = {}): Entry[] {
  requireTransaction(db, "appendEntries");
  const row = readStream(db, stream);
  if (!row) throw new LogError("unknown stream", `no stream ${stream}`);
  if (row.state !== "active") throw new LogError("not own", `${stream} is not an own active stream (${row.state})`);
  const now = options.now ?? Date.now();
  let last: Hlc | null = null;
  if (row.head > row.tail) {
    const headRow = db.prepare("SELECT hlc FROM entries WHERE stream = ? AND seq = ?").get(stream, row.head);
    if (headRow) last = JSON.parse(String(headRow.hlc)) as Hlc;
  }
  let seq = row.head;
  let prevHash = row.headHash;
  const out: Entry[] = [];
  const insert = db.prepare("INSERT INTO entries (stream, seq, logId, hlc, kind, body, slot, hash, okey, base) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const botId = botIdOf(stream);
  for (const item of items) {
    if (botId && typeof item.body.botId === "string" && item.body.botId !== botId) {
      throw new LogError("invalid entry", `entry ${item.kind} names bot ${item.body.botId}, not the stream's bot`);
    }
    seq += 1;
    const hlc = item.hlc ?? nextHlc(last, now);
    last = hlc;
    const content: EntryContent = { stream, logId: row.logId, seq, hlc, kind: item.kind, body: item.body, ...(item.slot ? { slot: item.slot } : {}) };
    const entry = { ...content, hash: hashEntry(prevHash, content) } as Entry;
    const parsed = Entry.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new LogError("invalid entry", `entry ${item.kind}: ${issue?.path.join(".") ?? ""} ${issue?.message ?? "invalid"}`.trim());
    }
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (size > ENTRY_BYTES_LIMIT) throw new LogError("too large", `entry ${item.kind} is ${size} bytes; one entry is at most ${ENTRY_BYTES_LIMIT}`);
    const stored = encodeBody(db, stream, seq, item.kind, canonicalJson(item.body), item.body, entry.hash);
    insert.run(stream, seq, row.logId, canonicalJson(hlc), item.kind, stored.body, item.slot ? canonicalJson(item.slot) : null, entry.hash, stored.okey, stored.base);
    applyReadModel(db, entry);
    prevHash = entry.hash;
    out.push(entry);
  }
  if (out.length) {
    db.prepare("UPDATE streams SET head = ?, headHash = ? WHERE stream = ?").run(seq, prevHash, stream);
    if (botId) db.prepare("UPDATE bots SET head = ? WHERE botId = ?").run(seq, botId);
  }
  return out;
}

/** `bot:<botId>` → botId; null for any other stream. */
export function botIdOf(stream: string): string | null {
  return stream.startsWith("bot:") ? stream.slice(4) : null;
}

export interface ReadOptions {
  maxEntries: number;
  /** Stop before an entry that would take the total JSON size above this (the first entry is always taken). */
  maxBytes: number;
  /** Told when a stored entry cannot be rebuilt (see `unreadable`). */
  log?: (line: string) => void;
}

/**
 * Entries from `from` on, in seq order, within the limits, always with whole bodies. `sizes[i]` is entry i's JSON size in
 * bytes. `unreadable` is the seq of the first entry that is stored but cannot be handed out (a diff that does not apply
 * or whose rebuilt body does not hash to the stored hash): nothing from it on is returned and a reader gets a `snap`.
 */
export function readEntries(db: Db, stream: string, from: number, options: ReadOptions): { entries: Entry[]; sizes: number[]; bytes: number; unreadable?: number } {
  const entries: Entry[] = [];
  const sizes: number[] = [];
  let bytes = 0;
  let unreadable: number | undefined;
  const chunk = Math.max(1, Math.min(options.maxEntries, 200));
  const select = db.prepare(`SELECT ${ROW_COLUMNS} FROM entries WHERE stream = ? AND seq >= ? ORDER BY seq LIMIT ?`);
  // The state of each object after the last of its rows this call went through, for the diffs that follow.
  const states = new Map<string, ObjState>();
  let next = from;
  outer: while (entries.length < options.maxEntries) {
    const rows = select.all(stream, next, Math.min(chunk, options.maxEntries - entries.length));
    if (!rows.length) break;
    for (const row of rows) {
      const seq = Number(row.seq);
      if (seq !== next) break outer; // never hand out a gap
      let body: Record<string, unknown>;
      if (row.base == null) {
        if (row.okey != null) states.set(String(row.okey), step(null, { seq, body: String(row.body), base: null, hash: String(row.hash) }));
        body = JSON.parse(String(row.body)) as Record<string, unknown>;
      } else {
        const decoded = decodeDiff(db, stream, row, states, entries.length ? entries[entries.length - 1].hash : undefined);
        if (!decoded) {
          unreadable = seq;
          options.log?.(`${stream}: entry ${seq} is stored as a diff that does not rebuild its body; readers get a snap`);
          break outer;
        }
        body = decoded;
      }
      const entry = rowToEntry(stream, row, body);
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (entries.length > 0 && bytes + size > options.maxBytes) break outer;
      entries.push(entry);
      sizes.push(size);
      bytes += size;
      next += 1;
    }
  }
  return unreadable === undefined ? { entries, sizes, bytes } : { entries, sizes, bytes, unreadable };
}

/** The whole body of a diff row, or null when it does not rebuild (the chain is broken, the patch does not fit, the hash is wrong). */
function decodeDiff(db: Db, stream: string, row: SqlRow, states: Map<string, ObjState>, previousHash: string | undefined): Record<string, unknown> | null {
  const seq = Number(row.seq);
  const okey = row.okey == null ? null : String(row.okey);
  if (okey === null) return null;
  try {
    let before = states.get(okey) ?? null;
    if (!before) before = loadChain(db, stream, okey, Number(row.base), seq);
    if (!before) return null;
    const state = step(before, { seq, body: String(row.body), base: Number(row.base), hash: String(row.hash) });
    const text = canonicalJson(valueOf(state));
    const body = JSON.parse(text) as Record<string, unknown>;
    if (!hashesRight(stream, row, body, previousHash ?? hashBefore(db, stream, seq))) return null;
    states.set(okey, { ...state, value: null, json: text });
    return body;
  } catch (error) {
    if (error instanceof DiffError || error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
}

/** The chain hash after `seq` (GENESIS_HASH for 0), or null when that entry was evicted below the tail. */
export function hashAfter(db: Db, row: StreamRow, seq: number): string | null {
  if (seq === 0) return GENESIS_HASH;
  if (seq === row.head) return row.headHash;
  if (seq === row.tail) return row.tailHash;
  if (seq < row.tail || seq > row.head) return null;
  const found = db.prepare("SELECT hash FROM entries WHERE stream = ? AND seq = ?").get(row.stream, seq);
  return found ? String(found.hash) : null;
}

/** Every retired logId of the stream, oldest first, each with the last seq its retirement kept (D50). */
export function listRetired(db: Db, stream: string): RetiredLog[] {
  return db.prepare("SELECT logId, keptSeq, reason FROM retired WHERE stream = ? ORDER BY n").all(stream)
    .map((row) => ({ logId: String(row.logId), keptSeq: Number(row.keptSeq), reason: String(row.reason) as RetiredLog["reason"] }));
}

/**
 * Gives the stream a new logId (§7.6): the current one is retired with keptSeq = head; seq numbering and the hash
 * chain go on. Used by restore (step 12) and by rewind detection. Must run inside a writer command.
 */
export function retireStream(db: Db, stream: string, reason: RetiredLog["reason"], now = Date.now()): { retired: RetiredLog; logId: string } {
  requireTransaction(db, "retireStream");
  const row = readStream(db, stream);
  if (!row) throw new LogError("unknown stream", `no stream ${stream}`);
  const n = Number(db.prepare("SELECT coalesce(max(n), 0) AS n FROM retired WHERE stream = ?").get(stream)!.n) + 1;
  db.prepare("INSERT INTO retired (stream, logId, n, keptSeq, reason, retiredAt) VALUES (?, ?, ?, ?, ?, ?)").run(stream, row.logId, n, row.head, reason, now);
  let logId = newLogId();
  while (logId === row.logId || db.prepare("SELECT 1 FROM retired WHERE stream = ? AND logId = ?").get(stream, logId)) logId = newLogId();
  db.prepare("UPDATE streams SET logId = ? WHERE stream = ?").run(logId, stream);
  return { retired: { logId: row.logId, keptSeq: row.head, reason }, logId };
}

/** Retires every own stream (the whole file went back: a restore or a detected rewind, §7.6). */
export function retireOwnStreams(db: Db, reason: RetiredLog["reason"], now = Date.now()): string[] {
  const streams = db.prepare("SELECT stream FROM streams WHERE state IN ('active', 'archived') ORDER BY stream").all().map((row) => String(row.stream));
  for (const stream of streams) retireStream(db, stream, reason, now);
  return streams;
}

/**
 * Deletes the stream's entries up to `upTo` (never above the head) and remembers the last one's hash as the tail, so
 * readers from the tail on are still served with a prevHash; a reader behind the tail gets a `snap`. Returns how many
 * entries went. Own logs are kept whole by default (§7.3); this is for caches and explicit trimming.
 */
export function evictEntries(db: Db, stream: string, upTo: number): number {
  requireTransaction(db, "evictEntries");
  const row = readStream(db, stream);
  if (!row) throw new LogError("unknown stream", `no stream ${stream}`);
  const to = Math.min(Math.floor(upTo), row.head);
  if (to <= row.tail) return 0;
  const hash = hashAfter(db, row, to);
  if (hash === null) throw new LogError("invalid entry", `${stream}: entry ${to} is missing`);
  rebaseKept(db, stream, to);
  const { changes } = db.prepare("DELETE FROM entries WHERE stream = ? AND seq <= ?").run(stream, to);
  db.prepare("UPDATE streams SET tail = ?, tailHash = ? WHERE stream = ?").run(to, hash, stream);
  return changes;
}

/**
 * The diffs that stay but hang on a baseline that goes (parameters: stream, to, to). `okey IS NOT NULL` is redundant
 * (every diff has an okey) and `INDEXED BY` pins the partial index `entries_by_okey`, which holds only the rows
 * written since schema 15 (the planner picks the primary key otherwise): without it the query reads every row above `to`, and the background prune (store/compaction.ts)
 * evicts a stream in many steps, each of which would walk the whole old part of the stream.
 */
export const REBASE_HANGING_SQL =
  "SELECT okey, base, min(seq) AS first FROM entries INDEXED BY entries_by_okey WHERE stream = ? AND okey IS NOT NULL AND seq > ? AND base IS NOT NULL AND base <= ? GROUP BY okey, base";

/**
 * Before the entries up to `to` go: a diff that stays but hangs on a baseline that goes becomes a baseline itself (the
 * first kept row of each such object is rewritten whole, the rows after it hang on it). A chain that does not rebuild
 * or hash right is left as it is: readers meet it as `unreadable` and get a snap, never a wrong body.
 */
function rebaseKept(db: Db, stream: string, to: number): void {
  const hanging = db.prepare(REBASE_HANGING_SQL).all(stream, to, to);
  for (const item of hanging) {
    const okey = String(item.okey);
    const first = Number(item.first);
    const state = loadChain(db, stream, okey, Number(item.base), first + 1);
    if (!state || state.seq !== first) continue; // not provable: leave it (see above)
    const body = canonicalJson(valueOf(state));
    db.prepare("UPDATE entries SET body = ?, base = NULL WHERE stream = ? AND seq = ?").run(body, stream, first);
    db.prepare(REBASE_UPDATE_SQL).run(first, stream, okey, Number(item.base), first);
    cacheOf(db).delete(`${stream}\u0000${okey}`);
  }
}

/** Checks the stream's kept entries: gapless from tail + 1 to head, chained from tailHash, ending at headHash. */
export function verifyStream(db: Db, stream: string): ChainCheck {
  const row = readStream(db, stream);
  if (!row) throw new LogError("unknown stream", `no stream ${stream}`);
  const all = readEntries(db, stream, row.tail + 1, { maxEntries: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER });
  const check = verifyChain(row.tailHash, all.entries);
  if (!check.ok) return check;
  if (all.unreadable !== undefined) return { ok: false, seq: all.unreadable, reason: "hash" };
  if (all.entries.length !== row.head - row.tail) return { ok: false, seq: row.tail + all.entries.length + 1, reason: "gap" };
  if (check.lastHash !== row.headHash) return { ok: false, seq: row.head, reason: "hash" };
  return check;
}
