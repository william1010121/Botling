// Summary replication between servers (M3 step 7, protocol v1 §8.2, §10.1, §10.2, §10.5, §13.1, D50, D58).
//
// Two halves, both in this file:
//
// - `TableFeeds` serves table streams as `rows` batches: this server's own `srv:<self>` table to its peers (and front
//   ends), and its copies of peers' tables to front ends ("FEs get every server's srv: table through their attached
//   server"). A subscriber gives a cursor `(logId, rev)` or none; it gets the catch-up (every row with `rev > cursor`,
//   one read transaction, one atomic batch, tables.ts `readCatchUp`), then every later change pushed as it commits
//   (`notify`). A cursor of another `logId` gets `reset{logId, retired}` first (the stream's retired logIds, plus the
//   cursor's own when this store never had it) and then the whole table with `after: 0`, which replaces the reader's
//   copy (D50: the reader moves to the new logId only through a reset that lists its own as retired).
//
// - `PeerTables` keeps this server's copy of every peer's `srv:` table, in the store's `rows` table under the peer's
//   stream name, with a `streams` row (owner = the peer, `logId`, `head` = the owner's rev the copy is at, `state`
//   live / stale / gone, `heardAt` = this server's clock at the last frame from the owner, §7.3). While a full peer
//   session is open it subscribes from its cursor; each batch is applied in one transaction once its last part is in:
//     - a batch or reset naming a retired `logId` of that stream is dropped (D50), whichever server sent it;
//     - `after: 0` replaces the copy, otherwise a batch starting above the copy's head is a gap (re-`sub` from the
//       cursor) and one at or below it is applied (each row is that key's latest change, so overlap is harmless);
//     - rows of a logId other than the copy's, without a reset, are dropped and the cursor sent again (the owner then
//       answers with the reset);
//     - `reset` that lists the copy's logId as retired: in one transaction the listed logIds are remembered as
//       retired, the copy is emptied and moves to the new logId at head 0; the whole table follows (after: 0);
//     - tombstones are kept in the copy (deleted = 1), so a front end catching up from the copy sees deletions too;
//       a whole-table replacement sets the copy's purge mark to its `to`, so a front end below it gets the whole table;
//     - rows of a kind this version does not know are kept and passed on verbatim (plan change N4).
//   The state follows the peer registry (`peers.ts`): `live` while the session is open, `stale since T` (T = the last
//   frame heard, on this server's clock; no clock is compared across machines), `gone` while the roster says the peer
//   is not valid (the copy is kept, read only). The copy survives restarts of this server (shown as stale until the
//   next session).
//
// Q1 (m3-brief §11): only the `rows` table is replicated; the `srv:` entry stream stays the local window's feed.
import { tableOwner, type Rows } from "../../protocol/table-rows";
import type { Cursor, LogId, MessageOf, ServerState, StreamId, WireMessage } from "../../protocol";
import { listRetired } from "../log/log-store";
import type { Db, ServerStore } from "../store";
import { readCatchUp, tableRev } from "./tables";

/** How often the own table's rev is looked at for rows written outside the summary writer (the roster's `audit:` rows). */
export const OWN_TABLE_POLL_MS = 1_000;

type Sink = (message: WireMessage) => boolean;

interface Feed {
  stream: string;
  /** The logId and rev this subscriber was last brought to (null: nothing sent yet, the stream did not exist). */
  logId: string | null;
  sentTo: number;
  sink: Sink;
  closed: boolean;
}

export interface TableFeedsOptions {
  /** A reader connection (sees every committed write). */
  reader: () => Db;
  /** This server's own table stream, `srv:<self>`. */
  ownStream: string;
  log?: (line: string) => void;
  pollMs?: number;
}

/** A table stream's head: the own table's top rev, or the owner's rev a copy is at (`streams.head`). */
export function tableHead(db: Db, stream: string, own: boolean): number {
  if (own) return tableRev(db, stream);
  return Number(db.prepare("SELECT head FROM streams WHERE stream = ?").get(stream)?.head ?? 0);
}

function streamLogId(db: Db, stream: string): string | null {
  const row = db.prepare("SELECT logId FROM streams WHERE stream = ?").get(stream);
  return row ? String(row.logId) : null;
}

/** `reset` for a reader at `readerLogId`: every retired logId of the stream, and the reader's own if never known here. */
export function tableReset(db: Db, stream: string, logId: string, readerLogId: string, own = true): MessageOf<"reset"> {
  const retired = listRetired(db, stream);
  const listed = retired.map(({ logId: old, keptSeq }) => ({ logId: old as LogId, keptSeq }));
  if (!retired.some((old) => old.logId === readerLogId)) listed.push({ logId: readerLogId as LogId, keptSeq: 0 });
  const reason = retired.length ? retired[retired.length - 1].reason : "restored";
  // When the backup was taken is known for this server's own restore only (a copy's reset says nothing of it).
  const restoredTo = own && reason === "restored" ? Number(db.prepare("SELECT value FROM meta WHERE key = 'restoredTo'").get()?.value ?? NaN) : NaN;
  return {
    t: "reset", stream: stream as StreamId, logId: logId as LogId, retired: listed.slice(-1_000), reason,
    ...(Number.isSafeInteger(restoredTo) && restoredTo >= 0 ? { restoredTo } : {}),
  } as MessageOf<"reset">;
}

export class TableFeeds {
  private readonly feeds = new Set<Feed>();
  private readonly log: (line: string) => void;
  private poll: ReturnType<typeof setInterval> | null = null;
  private lastOwnRev = -1;

  constructor(private readonly options: TableFeedsOptions) {
    this.log = options.log ?? (() => undefined);
  }

  get ownStream(): string { return this.options.ownStream; }

  /** Starts looking at the own table for rows written outside `notify` (audit rows of the roster store). */
  start(): void {
    if (this.poll) return;
    this.poll = setInterval(() => {
      if (![...this.feeds].some((feed) => feed.stream === this.options.ownStream)) return;
      try {
        const rev = tableRev(this.options.reader(), this.options.ownStream);
        if (rev !== this.lastOwnRev) { this.lastOwnRev = rev; this.notify(this.options.ownStream); }
      } catch (error) { this.log(`tables: ${String((error as Error)?.message ?? error)}`); }
    }, this.options.pollMs ?? OWN_TABLE_POLL_MS);
    this.poll.unref?.();
  }

  close(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    for (const feed of this.feeds) feed.closed = true;
    this.feeds.clear();
  }

  /** Subscribers of `stream` now. */
  count(stream: string): number { return [...this.feeds].filter((feed) => feed.stream === stream).length; }

  /**
   * Serves `stream` to `sink` from `cursor` (catch-up, then pushes). Returns a handle to stop it; the feed also stops
   * when `sink` returns false.
   */
  subscribe(stream: string, cursor: Cursor | null, sink: Sink): { close(): void } {
    const feed: Feed = { stream, logId: null, sentTo: 0, sink, closed: false };
    this.feeds.add(feed);
    this.serve(feed, cursor);
    return { close: () => { feed.closed = true; this.feeds.delete(feed); } };
  }

  /** Something committed into `stream`: push it to its subscribers. */
  notify(stream: string): void {
    for (const feed of [...this.feeds]) {
      if (feed.stream !== stream || feed.closed) continue;
      if (feed.logId === null) { this.serve(feed, null); continue; }
      const db = this.options.reader();
      const logId = streamLogId(db, stream);
      if (logId === null) continue;
      if (logId !== feed.logId) { this.serve(feed, { logId: feed.logId as LogId, seq: feed.sentTo }); continue; }
      if (tableHead(db, stream, stream === this.options.ownStream) > feed.sentTo) this.serve(feed, { logId: feed.logId as LogId, seq: feed.sentTo });
    }
  }

  private serve(feed: Feed, cursor: Cursor | null): void {
    if (feed.closed) return;
    const db = this.options.reader();
    const own = feed.stream === this.options.ownStream;
    let frames: WireMessage[];
    let logId: string | null;
    let to = 0;
    try {
      const began = !db.inTransaction;
      if (began) db.exec("BEGIN");
      try {
        logId = streamLogId(db, feed.stream);
        if (logId === null) { frames = []; } else {
          frames = [];
          let after = cursor?.seq ?? 0;
          if (cursor && cursor.logId !== logId) {
            frames.push(tableReset(db, feed.stream, logId, cursor.logId, own));
            after = 0;
          }
          if (!own && cursor && cursor.logId === logId && cursor.seq > tableHead(db, feed.stream, false)) {
            // Monotonic reads (§13.1): this copy is behind the reader's cursor; it is never handed an older table. It
            // gets the rows above its cursor once the copy passes it.
            to = cursor.seq;
          } else {
            const parts = readCatchUp(db, feed.stream, after, own ? {} : { head: (tx) => tableHead(tx, feed.stream, false) });
            to = parts[0]!.to;
            // A push with nothing new is not sent; a first serve always is (the reader learns the logId and the head).
            const nothing = parts.length === 1 && parts[0]!.rows.length === 0 && to === after;
            if (!(nothing && feed.logId !== null && cursor?.logId === logId)) frames.push(...parts);
          }
        }
      } finally {
        if (began && db.inTransaction) db.exec("COMMIT");
      }
    } catch (error) {
      this.log(`tables: ${feed.stream}: ${String((error as Error)?.message ?? error)}`);
      return;
    }
    if (logId === null) return;
    for (const frame of frames) {
      if (!feed.sink(frame)) { feed.closed = true; this.feeds.delete(feed); return; }
    }
    feed.logId = logId;
    feed.sentTo = to;
  }
}

// ---------------------------------------------------------------------------------------------
// The copies of peers' tables

/** What PeerTables needs of a peer session (server/peer/peer-session.ts). */
export interface TablePeerSession {
  readonly peer: string | null;
  readonly state: string;
  sendWire(message: WireMessage): boolean;
}

export interface PeerTablesOptions {
  store: ServerStore;
  /** A reader connection (sees every committed write). */
  reader: () => Db;
  feeds: TableFeeds;
  /** A peer's `srv:` copy changed (rows applied, or reset): who owns which bot may have changed (`Directory.peerOwner`). */
  copyChanged?: (stream: string) => void;
  log?: (line: string) => void;
  now?: () => number;
}

/** A copy's place in the store: logId, head (the owner's rev), state, heardAt. */
export interface CopyState { stream: string; owner: string; logId: string; head: number; state: ServerState; heardAt: number | null }

interface Receiving {
  session: TablePeerSession;
  parts: Rows[];
}

export class PeerTables {
  private readonly receiving = new Map<string, Receiving>();
  /** The feed of this server's own table to each peer session that subscribed to it. */
  private readonly served = new Map<TablePeerSession, { close(): void }>();
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  /** Batches applied (by stream), and rows frames dropped as retired: counters for tests and status. */
  readonly applied = new Map<string, number>();
  droppedRetired = 0;

  constructor(private readonly options: PeerTablesOptions) {
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  /** Every copy this server holds. */
  copies(db: Db = this.options.reader()): CopyState[] {
    return db.prepare("SELECT stream, owner, logId, head, state, heardAt FROM streams WHERE stream LIKE 'srv:%' AND state IN ('live', 'stale', 'gone') ORDER BY stream").all()
      .map((row) => ({ stream: String(row.stream), owner: String(row.owner), logId: String(row.logId), head: Number(row.head), state: String(row.state) as ServerState, heardAt: row.heardAt == null ? null : Number(row.heardAt) }));
  }

  /** Whether `stream` is a peer's table this server keeps a copy of (or will: any `srv:` stream not its own). */
  isPeerTable(stream: string): boolean {
    return stream.startsWith("srv:") && stream !== this.options.feeds.ownStream && tableOwner(stream) !== null;
  }

  /** A full session with `peer` opened: subscribe to its table from the copy's cursor. */
  async opened(session: TablePeerSession): Promise<void> {
    const peer = session.peer;
    if (!peer) return;
    const stream = `srv:${peer}`;
    this.receiving.set(stream, { session, parts: [] });
    const cursor = this.cursor(stream);
    session.sendWire({ t: "sub", stream: stream as StreamId, cursor });
    await this.setState(peer, "live", this.now());
  }

  /** The peer registry's state for `peer` changed (live / stale since T / gone): kept on the copy's row. */
  async peerState(peer: string, state: ServerState, since: number | null): Promise<void> {
    if (state !== "live") {
      const stream = `srv:${peer}`;
      const receiving = this.receiving.get(stream);
      if (receiving && receiving.session.state !== "open") this.receiving.delete(stream);
    }
    await this.setState(peer, state, state === "live" ? this.now() : since);
  }

  /** A session ended: forget what was being received on it (a half batch is never applied). */
  sessionClosed(session: TablePeerSession): void {
    this.served.get(session)?.close();
    this.served.delete(session);
    for (const [stream, receiving] of this.receiving) if (receiving.session === session) this.receiving.delete(stream);
  }

  /**
   * A frame of the table protocol from a peer (`rows`, or a `reset` of a table stream). Returns false when it is not a
   * table frame (the caller hands it on).
   */
  async onMessage(session: TablePeerSession, message: WireMessage): Promise<boolean> {
    if ((message.t === "sub" || message.t === "unsub") && message.via === undefined && message.stream.startsWith("srv:")) {
      this.served.get(session)?.close();
      this.served.delete(session);
      if (message.stream !== this.options.feeds.ownStream) { this.log(`tables: ${message.t} of ${message.stream} from ${session.peer ?? "?"} not served (a server serves its own table to peers)`); return true; }
      if (message.t === "sub") this.served.set(session, this.options.feeds.subscribe(message.stream, message.cursor, (frame) => session.state === "open" && session.sendWire(frame)));
      return true;
    }
    if (message.t === "rows") { await this.onRows(session, message as Rows); return true; }
    if (message.t === "reset" && message.stream.startsWith("srv:") && message.via === undefined) { await this.onReset(session, message); return true; }
    return false;
  }

  private cursor(stream: string): Cursor | null {
    const row = this.options.reader().prepare("SELECT logId, head FROM streams WHERE stream = ?").get(stream);
    return row ? { logId: String(row.logId) as LogId, seq: Number(row.head) } : null;
  }

  private isRetired(db: Db, stream: string, logId: string): boolean {
    return !!db.prepare("SELECT 1 FROM retired WHERE stream = ? AND logId = ?").get(stream, logId);
  }

  private async onRows(session: TablePeerSession, batch: Rows): Promise<void> {
    const peer = session.peer;
    if (batch.via !== undefined) return; // a forwarded front end's subscription: pass-through (step 8)
    if (!peer || batch.stream !== `srv:${peer}`) { this.log(`tables: rows of ${batch.stream} from ${peer ?? "?"} dropped (a peer serves its own table)`); return; }
    const stream = batch.stream;
    const reader = this.options.reader();
    if (this.isRetired(reader, stream, batch.logId)) {
      this.droppedRetired += 1;
      this.log(`tables: rows of ${stream} of a retired logId dropped (D50)`);
      return;
    }
    let receiving = this.receiving.get(stream);
    if (!receiving || receiving.session !== session) { receiving = { session, parts: [] }; this.receiving.set(stream, receiving); }
    const first = receiving.parts[0];
    if (first && (first.logId !== batch.logId || first.after !== batch.after || first.to !== batch.to)) {
      receiving.parts = [];
      this.log(`tables: ${stream}: a batch part that does not belong to the one being received; asking again`);
      this.resubscribe(session, stream);
      return;
    }
    receiving.parts.push(batch);
    if (batch.more) return;
    const parts = receiving.parts;
    receiving.parts = [];
    const now = this.now();
    const result = await this.options.store.submit((tx) => applyCopy(tx, peer, stream, parts, now));
    if (result === "applied") {
      this.applied.set(stream, (this.applied.get(stream) ?? 0) + 1);
      // A first copy made after its session already ended starts stale, not live.
      if (session.state !== "open") await this.setState(peer, "stale", now);
      this.options.feeds.notify(stream);
      this.options.copyChanged?.(stream);
      return;
    }
    if (result === "retired") { this.droppedRetired += 1; this.log(`tables: rows of ${stream} of a retired logId dropped (D50)`); return; }
    this.log(`tables: ${stream}: ${result === "gap" ? "a gap" : "rows of another logId without a reset"}; asking again from the cursor`);
    this.resubscribe(session, stream);
  }

  private async onReset(session: TablePeerSession, reset: MessageOf<"reset">): Promise<void> {
    const peer = session.peer;
    const stream = reset.stream;
    if (!peer || stream !== `srv:${peer}`) { this.log(`tables: reset of ${stream} from ${peer ?? "?"} dropped`); return; }
    const now = this.now();
    const result = await this.options.store.submit((tx) => resetCopy(tx, peer, stream, reset, now));
    if (result === "retired") { this.droppedRetired += 1; this.log(`tables: reset of ${stream} to a retired logId dropped (D50)`); return; }
    if (result === "ignored") { this.log(`tables: reset of ${stream} that does not retire this copy's logId dropped`); return; }
    const receiving = this.receiving.get(stream);
    if (receiving) receiving.parts = [];
    this.log(`tables: ${peer} was ${reset.reason}${reset.restoredTo ? ` to ${new Date(reset.restoredTo).toISOString()}` : ""}: copy of ${stream} reset (${reset.retired.length} retired logId(s))`);
    this.options.feeds.notify(stream);
    this.options.copyChanged?.(stream);
  }

  private resubscribe(session: TablePeerSession, stream: string): void {
    if (session.state !== "open") return;
    session.sendWire({ t: "sub", stream: stream as StreamId, cursor: this.cursor(stream) });
  }

  private async setState(peer: string, state: ServerState, heardAt: number | null): Promise<void> {
    const stream = `srv:${peer}`;
    try {
      const changed = await this.options.store.submit((tx) => {
        const row = tx.prepare("SELECT state, heardAt FROM streams WHERE stream = ?").get(stream);
        if (!row) return false;
        if (String(row.state) === state && (row.heardAt == null ? null : Number(row.heardAt)) === heardAt) return false;
        tx.prepare("UPDATE streams SET state = ?, heardAt = ? WHERE stream = ?").run(state, heardAt, stream);
        return true;
      });
      if (changed && state !== "live") this.log(`tables: copy of ${stream} ${state}${heardAt !== null ? ` since ${new Date(heardAt).toISOString()}` : ""}`);
    } catch (error) { this.log(`tables: ${stream}: ${String((error as Error)?.message ?? error)}`); }
  }
}

type ApplyResult = "applied" | "gap" | "logId" | "retired";

/** Applies one whole batch (all its parts) to the copy of `stream`, in the caller's transaction. */
export function applyCopy(tx: Db, owner: string, stream: string, parts: readonly Rows[], now: number): ApplyResult {
  const { logId, after, to } = parts[0]!;
  if (tx.prepare("SELECT 1 FROM retired WHERE stream = ? AND logId = ?").get(stream, logId)) return "retired";
  const row = tx.prepare("SELECT logId, head FROM streams WHERE stream = ?").get(stream);
  if (row && String(row.logId) !== logId) return "logId";
  const head = row ? Number(row.head) : 0;
  if (after !== 0 && (!row || after > head)) return "gap";
  if (after === 0) {
    tx.prepare("DELETE FROM rows WHERE stream = ?").run(stream);
    tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(`rowsPurged:${stream}`, String(to));
  }
  const upsert = tx.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, ?, ?, ?) ON CONFLICT (stream, key) DO UPDATE SET rev = excluded.rev, body = excluded.body, deleted = excluded.deleted");
  for (const part of parts) {
    for (const item of part.rows) {
      if (item.deleted) upsert.run(stream, item.key, item.rev, null, 1);
      else upsert.run(stream, item.key, item.rev, JSON.stringify(item.body), 0);
    }
  }
  const newHead = after === 0 ? to : Math.max(head, to);
  // The state is the peer registry's (a batch applied after the session ended leaves `stale since T` as it is).
  if (row) tx.prepare("UPDATE streams SET head = ?, heardAt = CASE WHEN state = 'live' THEN ? ELSE heardAt END WHERE stream = ?").run(newHead, now, stream);
  else tx.prepare("INSERT INTO streams (stream, owner, logId, head, headHash, state, heardAt) VALUES (?, ?, ?, ?, NULL, 'live', ?)").run(stream, owner, logId, newHead, now);
  return "applied";
}

/** Takes a `reset` of a peer's table (D50), in the caller's transaction. */
export function resetCopy(tx: Db, owner: string, stream: string, reset: MessageOf<"reset">, now: number): "reset" | "retired" | "ignored" {
  if (tx.prepare("SELECT 1 FROM retired WHERE stream = ? AND logId = ?").get(stream, reset.logId)) return "retired";
  const row = tx.prepare("SELECT logId FROM streams WHERE stream = ?").get(stream);
  // A reader moves to another logId only through a reset that lists its own as retired (§8.3).
  if (row && String(row.logId) !== reset.logId && !reset.retired.some((old) => old.logId === String(row.logId))) return "ignored";
  if (row && String(row.logId) === reset.logId) return "ignored";
  let n = Number(tx.prepare("SELECT coalesce(max(n), 0) AS n FROM retired WHERE stream = ?").get(stream)?.n ?? 0);
  const insert = tx.prepare("INSERT INTO retired (stream, logId, n, keptSeq, reason, retiredAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (stream, logId) DO NOTHING");
  for (const old of reset.retired) { n += 1; insert.run(stream, old.logId, n, old.keptSeq, reset.reason, now); }
  tx.prepare("DELETE FROM rows WHERE stream = ?").run(stream);
  tx.prepare("DELETE FROM meta WHERE key = ?").run(`rowsPurged:${stream}`);
  if (row) tx.prepare("UPDATE streams SET logId = ?, head = 0, heardAt = CASE WHEN state = 'live' THEN ? ELSE heardAt END WHERE stream = ?").run(reset.logId, now, stream);
  else tx.prepare("INSERT INTO streams (stream, owner, logId, head, headHash, state, heardAt) VALUES (?, ?, ?, 0, NULL, 'live', ?)").run(stream, owner, reset.logId, now);
  return "reset";
}
