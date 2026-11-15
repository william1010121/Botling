// The attached server's own table rows as the front end holds them (M5-14e).
//
// The attached server's `srv:<own>` stream is followed through the log cursors (§13.1), so it is not one of the peer tables
// in tables.ts (their `reset` and "every table caught" rules belong to peers). On `sub srv:<own>` the server also sends the
// `plugin:` rows of its own table as `rows` frames (session-core.ts), whole at first (`after: 0`), then as deltas; this
// copy keeps them so the page reads them as it reads a peer's (`link.table(<own id>)`).
//
// The rules are the peer table's, without the resub: the server's feed is ordered and a (re-)`sub` always restarts it with
// the whole table, so a frame that does not fit is dropped, never asked for again.
// - `after: 0` replaces the copy and moves it to the frame's logId (a restore: the log path hears its own `reset`).
// - a delta applies when it is of the copy's logId and starts at or below the copy's rev (each row is its key's latest
//   change, so overlap is harmless); a gap, another logId, or a copy that never had a whole table is dropped.
// - the parts of one batch (`more`) are applied once the last one is in.
//
// Pure TypeScript: no Node built-ins.
import type { LogId, Rows } from "../protocol";

export interface OwnRowsView {
  logId: LogId;
  rev: number;
  rows: ReadonlyMap<string, unknown>;
  /** A whole table or a delta came on this session. */
  caught: boolean;
}

export type OwnRowsResult = { changed: string[]; removed: string[] } | null;

export class OwnRows {
  private serverId: string | null = null;
  private logId: LogId | null = null;
  private rev = 0;
  private rows = new Map<string, unknown>();
  private caught = false;
  private held: { logId: LogId; after: number; to: number; rows: Rows["rows"] } | null = null;

  /** The copy, or null while no batch ever came for `serverId` (an older server sends none: "not readable"). */
  view(serverId: string): OwnRowsView | null {
    if (this.serverId !== serverId || this.logId === null) return null;
    return { logId: this.logId, rev: this.rev, rows: this.rows, caught: this.caught };
  }

  /** A welcome from `serverId`: another server than the copy's drops it. */
  attach(serverId: string): void {
    this.held = null;
    if (this.serverId !== serverId) {
      this.serverId = serverId;
      this.logId = null;
      this.rev = 0;
      this.rows = new Map();
    }
  }

  /** The session ended: the rows stay (a cache) but are not caught any more. */
  detach(): void {
    this.caught = false;
    this.held = null;
  }

  /** One `rows` frame of the own stream; null when it changed nothing (a part, or dropped). */
  onRows(batch: Rows): OwnRowsResult {
    let rows = batch.rows;
    const held = this.held;
    if (held) {
      if (held.logId !== batch.logId || held.after !== batch.after || held.to !== batch.to) this.held = null;
      else rows = [...held.rows, ...batch.rows];
    }
    if (batch.more) {
      this.held = { logId: batch.logId, after: batch.after, to: batch.to, rows };
      return null;
    }
    this.held = null;
    const replace = batch.after === 0;
    if (!replace && (this.logId === null || batch.logId !== this.logId || batch.after > this.rev)) return null;
    const changed: string[] = [];
    const removed: string[] = [];
    if (replace) {
      const before = new Set(this.rows.keys());
      this.rows = new Map();
      for (const row of rows) if (!row.deleted) this.rows.set(row.key, row.body);
      for (const key of before) if (!this.rows.has(key)) removed.push(key);
      changed.push(...this.rows.keys());
    } else {
      for (const row of rows) {
        if (row.deleted) { if (this.rows.delete(row.key)) removed.push(row.key); }
        else { this.rows.set(row.key, row.body); changed.push(row.key); }
      }
    }
    this.logId = batch.logId;
    this.rev = Math.max(replace ? 0 : this.rev, batch.to);
    this.caught = true;
    return { changed, removed };
  }
}
