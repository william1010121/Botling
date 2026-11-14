// Bot log streams in server.db (protocol v1 §7.3, §7.6, §8.1, §8.3): synchronous functions over a `Db`.
// Writes (`ensureStream`, `appendEntries`, `retireStream`, `evictEntries`) run inside a writer command, so an append
// commits with the rest of its command (read models, receipt, effects) or not at all. Reads run on any connection.
//
// Storage: `entries.body` is the canonical JSON of the body, `hlc` and `slot` are JSON; `entries.logId` is the
// incarnation the entry was appended in (seq numbering continues across a restore, so a stream's rows can span
// several logIds). `streams.head/headHash` are the last entry; `streams.tail/tailHash` the last evicted one.
import { randomBytes } from "node:crypto";
import { canonicalJson, Entry, GENESIS_HASH, type EntryContent, type Hlc, type Slot, type StreamId } from "../../protocol";
import { FRAME_LIMIT } from "../../protocol/frame";
import type { Db, SqlRow } from "../store";
import { hashEntry, verifyChain, type ChainCheck } from "./chain";
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

function rowToEntry(stream: string, row: SqlRow): Entry {
  const entry: Entry = {
    stream: stream as StreamId,
    logId: String(row.logId),
    seq: Number(row.seq),
    hlc: JSON.parse(String(row.hlc)) as Hlc,
    kind: String(row.kind),
    body: JSON.parse(String(row.body)) as Record<string, unknown>,
    hash: String(row.hash),
  };
  if (row.slot != null) entry.slot = JSON.parse(String(row.slot)) as Slot;
  return entry;
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
  const insert = db.prepare("INSERT INTO entries (stream, seq, logId, hlc, kind, body, slot, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
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
    insert.run(stream, seq, row.logId, canonicalJson(hlc), item.kind, canonicalJson(item.body), item.slot ? canonicalJson(item.slot) : null, entry.hash);
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
}

/** Entries from `from` on, in seq order, within the limits. `sizes[i]` is entry i's JSON size in bytes. */
export function readEntries(db: Db, stream: string, from: number, options: ReadOptions): { entries: Entry[]; sizes: number[]; bytes: number } {
  const entries: Entry[] = [];
  const sizes: number[] = [];
  let bytes = 0;
  const chunk = Math.max(1, Math.min(options.maxEntries, 200));
  const select = db.prepare("SELECT seq, logId, hlc, kind, body, slot, hash FROM entries WHERE stream = ? AND seq >= ? ORDER BY seq LIMIT ?");
  let next = from;
  outer: while (entries.length < options.maxEntries) {
    const rows = select.all(stream, next, Math.min(chunk, options.maxEntries - entries.length));
    if (!rows.length) break;
    for (const row of rows) {
      const entry = rowToEntry(stream, row);
      if (entry.seq !== next) break outer; // never hand out a gap
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (entries.length > 0 && bytes + size > options.maxBytes) break outer;
      entries.push(entry);
      sizes.push(size);
      bytes += size;
      next += 1;
    }
  }
  return { entries, sizes, bytes };
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
  const { changes } = db.prepare("DELETE FROM entries WHERE stream = ? AND seq <= ?").run(stream, to);
  db.prepare("UPDATE streams SET tail = ?, tailHash = ? WHERE stream = ?").run(to, hash, stream);
  return changes;
}

/** Checks the stream's kept entries: gapless from tail + 1 to head, chained from tailHash, ending at headHash. */
export function verifyStream(db: Db, stream: string): ChainCheck {
  const row = readStream(db, stream);
  if (!row) throw new LogError("unknown stream", `no stream ${stream}`);
  const all = readEntries(db, stream, row.tail + 1, { maxEntries: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER });
  const check = verifyChain(row.tailHash, all.entries);
  if (!check.ok) return check;
  if (all.entries.length !== row.head - row.tail) return { ok: false, seq: row.tail + all.entries.length + 1, reason: "gap" };
  if (check.lastHash !== row.headHash) return { ok: false, seq: row.head, reason: "hash" };
  return check;
}
