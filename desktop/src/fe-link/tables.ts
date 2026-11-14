// The front end's copies of the other servers' `srv:` tables (M3 step 11; protocol v1 §8.2, §10.1, §13.1, D50).
//
// The attached server S serves every peer's `srv:<P>` table from its own copy as `rows` batches (server/replica/
// peer-tables.ts `TableFeeds`). The front end keeps each copy in memory (a cache: rebuilt from S at any time, §13.2):
// - `sub{srv:<P>, cursor}`: the cursor is `(logId, rev)` of the copy; none (first attach after a page load) asks for the
//   whole table (`after: 0`).
// - A batch is applied once its last part is in (parts share `after` and `to`; all but the last say `more`).
//   `after: 0` replaces the copy; a batch starting above the copy's rev is a gap (sub again from the cursor); one at or
//   below it is applied (each row is that key's latest change). Rows of a logId other than the copy's, with no reset
//   first, are dropped and the cursor sent again. Rows or a reset naming a retired logId are dropped (D50).
// - `reset` that lists the copy's logId (or comes while the copy has none): the listed logIds are retired (kept for
//   good, through the storage), the copy empties and moves to the new logId; the whole table follows.
// - `caught`: the copy got its catch-up on this session. The outbox goes out only once every table is caught (§13.1
//   step 2 before step 3), so `inc` is the owner's logId as the front end knows it now.
// The directory: a bot is owned by the peer whose copy holds a live `bot:<id>` row; otherwise by the attached server.
//
// Pure TypeScript: no Node built-ins.
import type { Cursor, LogId, MessageOf } from "../protocol";
import type { Rows, SummaryRow } from "../protocol/table-rows";
import type { RetiredLog } from "./storage";

export interface TableCopy {
  stream: string;
  /** The incarnation the rows belong to (the owner's `srv:` logId: the `inc` its commands carry); null: none yet. */
  logId: LogId | null;
  /** The owner's table rev the copy is at. */
  rev: number;
  /** Live rows by key (tombstones remove the key). */
  rows: Map<string, unknown>;
  /** The catch-up came on this session. */
  caught: boolean;
  /** When the last `sub` went (the clock the link gives). */
  subAt: number;
}

export type RowsDecision =
  | { kind: "apply"; changed: string[]; removed: string[]; replaced: boolean }
  | { kind: "wait" }
  | { kind: "drop"; why: string }
  | { kind: "resub"; cursor: Cursor | null };

export class TableCopies {
  private readonly copies = new Map<string, TableCopy>();
  private readonly retired = new Map<string, Map<LogId, number>>();
  /** A batch's earlier parts, until its last part is in. */
  private readonly parts = new Map<string, { logId: LogId; after: number; to: number; rows: Rows["rows"] }>();
  /** The last peer each bot was seen in (kept across that table's reset, so a reset of the bot's stream is told apart). */
  private readonly lastOwner = new Map<string, string>();

  constructor(retired: Record<string, RetiredLog[]> = {}) {
    for (const [stream, list] of Object.entries(retired)) {
      if (stream.startsWith("srv:")) this.retired.set(stream, new Map(list.map((old) => [old.logId, old.keptSeq])));
    }
  }

  streams(): string[] { return [...this.copies.keys()]; }
  get(stream: string): TableCopy | null { return this.copies.get(stream) ?? null; }
  has(stream: string): boolean { return this.copies.has(stream); }

  /** Starts following a table (no-op when followed). */
  add(stream: string): void {
    if (!this.copies.has(stream)) this.copies.set(stream, { stream, logId: null, rev: 0, rows: new Map(), caught: false, subAt: 0 });
  }

  remove(stream: string): void { this.copies.delete(stream); this.parts.delete(stream); }

  isRetired(stream: string, logId: string): boolean { return this.retired.get(stream)?.has(logId) ?? false; }

  /** The cursor a `sub` names (the copy's logId and rev; none: the whole table). Marks the copy as not caught. */
  subCursor(stream: string, now = 0): Cursor | null {
    const copy = this.copies.get(stream);
    this.parts.delete(stream);
    if (!copy) return null;
    copy.caught = false;
    copy.subAt = now;
    return copy.logId ? { logId: copy.logId, seq: copy.rev } : null;
  }

  /**
   * Every followed table has had its catch-up on this session. A table this front end never had (no logId) whose
   * catch-up has not come `absentMs` after its sub is let go: the attached server has no copy of it yet (a peer it never
   * reached), and the commands of every other server must not wait for it.
   */
  allCaught(now = 0, absentMs = Number.POSITIVE_INFINITY): boolean {
    for (const copy of this.copies.values()) {
      if (copy.caught) continue;
      if (copy.logId === null && now - copy.subAt >= absentMs) continue;
      return false;
    }
    return true;
  }

  /** The session ended: nothing is caught any more. */
  detach(): void {
    for (const copy of this.copies.values()) copy.caught = false;
    this.parts.clear();
  }

  onRows(batch: Rows): RowsDecision {
    const copy = this.copies.get(batch.stream);
    if (!copy) return { kind: "drop", why: "not followed" };
    if (this.isRetired(batch.stream, batch.logId)) return { kind: "drop", why: "retired logId" };
    // Parts of one batch: kept until the last one is in.
    const held = this.parts.get(batch.stream);
    let rows = batch.rows;
    if (held) {
      if (held.logId !== batch.logId || held.after !== batch.after || held.to !== batch.to) {
        this.parts.delete(batch.stream);
        return { kind: "resub", cursor: copy.logId ? { logId: copy.logId, seq: copy.rev } : null };
      }
      rows = [...held.rows, ...batch.rows];
    }
    if (batch.more) {
      this.parts.set(batch.stream, { logId: batch.logId, after: batch.after, to: batch.to, rows });
      return { kind: "wait" };
    }
    this.parts.delete(batch.stream);
    const replace = batch.after === 0;
    if (!replace) {
      if (copy.logId === null) return { kind: "resub", cursor: null };
      if (batch.logId !== copy.logId) return { kind: "resub", cursor: { logId: copy.logId, seq: copy.rev } };
      if (batch.after > copy.rev) return { kind: "resub", cursor: { logId: copy.logId, seq: copy.rev } };
    } else if (copy.logId !== null && batch.logId !== copy.logId) {
      // A whole table of another logId with no reset first: only a reset moves the copy (D50).
      return { kind: "resub", cursor: { logId: copy.logId, seq: copy.rev } };
    }
    const changed: string[] = [];
    const removed: string[] = [];
    if (replace) {
      const before = new Set(copy.rows.keys());
      copy.rows = new Map();
      for (const row of rows) if (!row.deleted) copy.rows.set(row.key, row.body);
      for (const key of before) if (!copy.rows.has(key)) removed.push(key);
      changed.push(...copy.rows.keys());
    } else {
      for (const row of rows) {
        if (row.deleted) { if (copy.rows.delete(row.key)) removed.push(row.key); }
        else { copy.rows.set(row.key, row.body); changed.push(row.key); }
      }
    }
    for (const key of changed) if (key.startsWith("bot:")) this.lastOwner.set(key.slice(4), batch.stream.slice(4));
    copy.logId = batch.logId;
    copy.rev = Math.max(replace ? 0 : copy.rev, batch.to);
    copy.caught = true;
    return { kind: "apply", changed, removed, replaced: replace };
  }

  /** The newly retired logIds when the reset was taken (the copy emptied, on the new logId); null when dropped. */
  onReset(reset: MessageOf<"reset">): { added: RetiredLog[]; removed: string[] } | null {
    const copy = this.copies.get(reset.stream);
    if (!copy) return null;
    if (this.isRetired(reset.stream, reset.logId)) return null;
    if (copy.logId === reset.logId) return null;
    if (copy.logId !== null && !reset.retired.some((old) => old.logId === copy.logId)) return null;
    let known = this.retired.get(reset.stream);
    if (!known) this.retired.set(reset.stream, (known = new Map()));
    const added: RetiredLog[] = [];
    for (const old of reset.retired) {
      if (!known.has(old.logId)) { known.set(old.logId, old.keptSeq); added.push({ logId: old.logId, keptSeq: old.keptSeq }); }
    }
    const removed = [...copy.rows.keys()];
    copy.rows = new Map();
    copy.logId = reset.logId;
    copy.rev = 0;
    copy.caught = false;
    this.parts.delete(reset.stream);
    return { added, removed };
  }

  /** The server whose table holds a live `bot:<botId>` row (null: none of the followed copies). */
  ownerOfBot(botId: string): string | null {
    const key = `bot:${botId}`;
    for (const copy of this.copies.values()) if (copy.rows.has(key)) return copy.stream.slice(4);
    return null;
  }

  /** The peer whose table last held `bot:<botId>` (even if that table was reset since); null: never a peer's. */
  lastOwnerOfBot(botId: string): string | null { return this.ownerOfBot(botId) ?? this.lastOwner.get(botId) ?? null; }

  /** Every live summary row of a table, by bot id. */
  bots(stream: string): Array<{ botId: string; row: SummaryRow }> {
    const copy = this.copies.get(stream);
    if (!copy) return [];
    const found: Array<{ botId: string; row: SummaryRow }> = [];
    for (const [key, body] of copy.rows) if (key.startsWith("bot:")) found.push({ botId: key.slice(4), row: body as SummaryRow });
    return found;
  }
}
