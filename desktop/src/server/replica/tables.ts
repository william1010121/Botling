// A server's own `srv:<serverId>` table (protocol v1 §8.2, §7.3 `rows`; M3 step 6): keyed rows with `rev`, tombstones,
// and catch-up by rev.
//
// - `rev` is the table's counter: the next rev is MAX(rev) + 1 of the stream, the rule M2's roster store already uses
//   for its `audit:` rows (roster/store.ts `writeAudits`), so both writers share one counter. MAX(rev) never goes down:
//   the tombstone purge keeps the row that holds the top rev.
// - A delete is a tombstone: `deleted = 1`, and `body` keeps `{"deletedAt": ms}` (the server's own clock) so the purge
//   knows its age; the wire form carries no body (`{key, rev, deleted: true}`). Tombstones older than 30 days are
//   purged, and `meta.rowsPurged:<stream>` remembers the highest rev purged.
// - Catch-up (`readCatchUp`): every row with `rev > after`, sorted by `rev`, read in one read transaction, as one
//   batch (cut into `rows` frames sharing `after`/`to`, the last `more: false`); the reader's table then equals the
//   owner's at `to`. A reader whose cursor is below the purge mark (it could miss a purged tombstone) or above `to`
//   (the owner was restored to an older table) gets the whole table with `after: 0`, which replaces its copy
//   (`applyRows`).
// - Writes go through `putRow` / `deleteRow` inside a writer command; an unchanged body is not written again (no new rev).
//   `putRow` writes only the kinds this version knows (its own rows).
// - Plan change N4: rows of a kind this version does not know (`plugin:<name>` from D52, later kinds) are kept, read,
//   caught up and passed on verbatim, and ignored by what reads the known kinds; nothing here refuses or drops them.
//
// Only `rows` go to peers (M3 brief Q1); the `srv:` entry stream stays the local window's feed.
import { canonicalJson, type LogId } from "../../protocol";
import { FRAME_LIMIT } from "../../protocol/frame";
import { TOMBSTONE_KEEP_MS, ROWS_LIMIT, rowBodySchema, type Rows, type TableRow } from "../../protocol/table-rows";
import type { Db } from "../store";

/** Room left in a frame around a `rows` message's own fields. */
const FRAME_SLACK = 4 * 1024;

/** This server's table stream, `srv:<serverId>`. */
export function ownTableStream(db: Db): string {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'serverId'").get();
  if (!row) throw new Error("server.db has no serverId");
  return `srv:${String(row.value)}`;
}

/** The table's rev now (0: no row yet). */
export function tableRev(db: Db, stream: string): number {
  return Number(db.prepare("SELECT MAX(rev) AS rev FROM rows WHERE stream = ?").get(stream)?.rev ?? 0);
}

/** The highest rev a tombstone purge removed (0: none). */
export function purgedRev(db: Db, stream: string): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(`rowsPurged:${stream}`);
  return row ? Number(row.value) : 0;
}

export class RowBodyError extends Error {
  constructor(readonly key: string, readonly reason: string) {
    super(`row ${key} refused: ${reason}`);
    this.name = "RowBodyError";
  }
}

/** Checks a body this server writes against its key's §8.2 schema (limits included); throws RowBodyError. */
export function checkRowBody(key: string, body: unknown): void {
  const schema = rowBodySchema(key);
  if (!schema) throw new RowBodyError(key, "unknown row key");
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new RowBodyError(key, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).slice(0, 3).join("; "));
}

/** A live row's body as stored, or null (no row, or a tombstone). */
export function readRowBody(db: Db, stream: string, key: string): unknown {
  const row = db.prepare("SELECT body, deleted FROM rows WHERE stream = ? AND key = ?").get(stream, key);
  if (!row || Number(row.deleted) === 1 || row.body == null) return null;
  return JSON.parse(String(row.body));
}

/**
 * Writes a row (checked against §8.2) at the next rev. Returns the new rev, or null when the stored body is already
 * the same (nothing written).
 */
export function putRow(tx: Db, stream: string, key: string, body: unknown): number | null {
  checkRowBody(key, body);
  const text = canonicalJson(body);
  const old = tx.prepare("SELECT body, deleted FROM rows WHERE stream = ? AND key = ?").get(stream, key);
  if (old && Number(old.deleted) === 0 && String(old.body) === text) return null;
  const rev = tableRev(tx, stream) + 1;
  tx.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, ?, ?, 0) ON CONFLICT (stream, key) DO UPDATE SET rev = excluded.rev, body = excluded.body, deleted = 0")
    .run(stream, key, rev, text);
  return rev;
}

/** Turns a live row into a tombstone at the next rev. Returns the rev, or null when there is no live row. */
export function deleteRow(tx: Db, stream: string, key: string, now: number): number | null {
  const old = tx.prepare("SELECT deleted FROM rows WHERE stream = ? AND key = ?").get(stream, key);
  if (!old || Number(old.deleted) === 1) return null;
  const rev = tableRev(tx, stream) + 1;
  tx.prepare("UPDATE rows SET rev = ?, body = ?, deleted = 1 WHERE stream = ? AND key = ?").run(rev, JSON.stringify({ deletedAt: now }), stream, key);
  return rev;
}

/**
 * Removes tombstones deleted more than `keepMs` before `now`, except the row holding the table's top rev (so the rev
 * counter never goes down). Returns how many were removed.
 */
export function purgeTombstones(tx: Db, stream: string, now: number, keepMs = TOMBSTONE_KEEP_MS): number {
  const top = tableRev(tx, stream);
  let purged = purgedRev(tx, stream);
  let removed = 0;
  const drop = tx.prepare("DELETE FROM rows WHERE stream = ? AND key = ?");
  for (const row of tx.prepare("SELECT key, rev, body FROM rows WHERE stream = ? AND deleted = 1").all(stream)) {
    const rev = Number(row.rev);
    if (rev === top) continue;
    let deletedAt = 0;
    try { deletedAt = Number((JSON.parse(String(row.body ?? "{}")) as { deletedAt?: unknown }).deletedAt ?? 0) || 0; } catch { deletedAt = 0; }
    if (now - deletedAt < keepMs) continue;
    drop.run(stream, String(row.key));
    purged = Math.max(purged, rev);
    removed += 1;
  }
  if (removed) tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(`rowsPurged:${stream}`, String(purged));
  return removed;
}

/** A table as a reader holds it: key → `{rev, body}` (live rows only), and the rev it is at. */
export interface TableCopy {
  rev: number;
  rows: Map<string, { rev: number; body: unknown }>;
}

export const emptyTable = (): TableCopy => ({ rev: 0, rows: new Map() });

/** The owner's table now (live rows), read in one read transaction. */
export function readTable(db: Db, stream: string): TableCopy {
  return inRead(db, () => {
    const rows = new Map<string, { rev: number; body: unknown }>();
    for (const row of db.prepare("SELECT key, rev, body FROM rows WHERE stream = ? AND deleted = 0 ORDER BY rev").all(stream)) {
      rows.set(String(row.key), { rev: Number(row.rev), body: JSON.parse(String(row.body)) });
    }
    return { rev: tableRev(db, stream), rows };
  });
}

/** The incarnation a table's rows belong to: the `srv:` stream's logId (a restore gives it a new one). */
export function tableLogId(db: Db, stream: string): LogId | null {
  const row = db.prepare("SELECT logId FROM streams WHERE stream = ?").get(stream);
  return row ? (String(row.logId) as LogId) : null;
}

function inRead<T>(db: Db, read: () => T): T {
  if (db.inTransaction) return read();
  db.exec("BEGIN");
  try {
    return read();
  } finally {
    if (db.inTransaction) db.exec("COMMIT");
  }
}

/**
 * The catch-up of a reader at `after`: one atomic batch as `rows` frames (in order; apply once the last is in).
 * `after` above the table's rev or below the purge mark → the whole table with `after: 0`.
 */
export function readCatchUp(db: Db, stream: string, after: number, options: { frameBytes?: number; rowsLimit?: number } = {}): Rows[] {
  const frameBytes = (options.frameBytes ?? FRAME_LIMIT) - FRAME_SLACK;
  const rowsLimit = Math.min(options.rowsLimit ?? ROWS_LIMIT, ROWS_LIMIT);
  return inRead(db, () => {
    const logId = tableLogId(db, stream);
    if (!logId) throw new Error(`readCatchUp: no stream ${stream}`);
    const to = tableRev(db, stream);
    const whole = after > to || after < purgedRev(db, stream);
    const from = whole ? 0 : after;
    const select = whole
      ? db.prepare("SELECT key, rev, body, deleted FROM rows WHERE stream = ? AND deleted = 0 AND rev > ? ORDER BY rev")
      : db.prepare("SELECT key, rev, body, deleted FROM rows WHERE stream = ? AND rev > ? ORDER BY rev");
    const rows: TableRow[] = select.all(stream, from).map((row) => (Number(row.deleted) === 1
      ? { key: String(row.key), rev: Number(row.rev), deleted: true as const }
      : { key: String(row.key), rev: Number(row.rev), body: JSON.parse(String(row.body)) }) as TableRow);
    const parts: Rows[] = [];
    let current: TableRow[] = [];
    let bytes = 0;
    const flush = () => {
      parts.push({ t: "rows", stream, logId, after: from, to, rows: current, more: true } as Rows);
      current = [];
      bytes = 0;
    };
    for (const row of rows) {
      const size = Buffer.byteLength(canonicalJson(row)) + 1;
      if (current.length && (current.length >= rowsLimit || bytes + size > frameBytes)) flush();
      current.push(row);
      bytes += size;
    }
    flush();
    parts[parts.length - 1].more = false;
    return parts;
  });
}

export class RowsGapError extends Error {
  constructor(readonly cursor: number, readonly after: number) {
    super(`a rows batch after ${after} cannot follow a copy at ${cursor}`);
    this.name = "RowsGapError";
  }
}

/**
 * A reader applying one whole catch-up batch (all its parts, in order) to its copy. `after: 0` replaces the copy; a
 * batch starting above the copy's rev is a gap (re-subscribe from the cursor). Rows at or below the copy's rev are each
 * key's latest change, which the copy already holds, so re-applying them is harmless.
 */
export function applyRows(copy: TableCopy, parts: readonly Rows[]): TableCopy {
  if (!parts.length) return copy;
  const { after, to } = parts[0];
  if (after !== 0 && after > copy.rev) throw new RowsGapError(copy.rev, after);
  const rows = after === 0 ? new Map<string, { rev: number; body: unknown }>() : new Map(copy.rows);
  for (const part of parts) {
    if (part.after !== after || part.to !== to) throw new Error("applyRows: the parts of one batch share after and to");
    for (const row of part.rows) {
      if (row.deleted) rows.delete(row.key);
      else rows.set(row.key, { rev: row.rev, body: row.body });
    }
  }
  if (parts[parts.length - 1].more) throw new Error("applyRows: the batch's last part has more: true");
  return { rev: after === 0 ? to : Math.max(copy.rev, to), rows };
}
