// M3 step 7: copies of peers' `srv:` tables (src/server/replica/peer-tables.ts), in one process over real server.db
// files: two servers' TableFeeds + PeerTables joined by an in-memory FIFO peer link that a seeded schedule cuts (a lost,
// duplicated or reordered frame ends a real session, D58, so every fault here ends the session); random writes on the
// owner (rows, tombstones, unknown kinds, purges with the clock jumping), restores of the owner (new logId, older
// table), and a front end reading the copy through the attached server's feed.
//
// Checked: after every applied batch the copy equals the owner's table at that batch's `(logId, to)`; the copy's head
// never goes down within one logId; it never takes a batch or reset of a retired logId (D50), also when one is replayed
// to it by hand; after the last heal the copy equals the owner's table; the front end's copy equals the attached
// server's copy, never goes back within a logId and never returns to a retired one; the copy survives a restart of the
// reader (reopened store) and catches up from its cursor.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Cursor, MessageOf, WireMessage } from "../../src/protocol";
import { decodeWireFrame, encodeWireFrame } from "../../src/protocol/frame";
import type { Rows } from "../../src/protocol/table-rows";
import { listRetired, newLogId, retireStream } from "../../src/server/log/log-store";
import {
  applyRows, deleteRow, emptyTable, PeerTables, purgeTombstones, putRow, readTable, TableFeeds, tableRev, type TablePeerSession, type TableCopy,
} from "../../src/server/replica";
import { openServerStore, type Db, type ServerStore } from "../../src/server/store";
import { rng } from "./server-slots-harness";

const A = "AAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBB";
const DAY = 24 * 60 * 60 * 1000;

interface Server {
  id: string;
  dir: string;
  store: ServerStore;
  reader: Db;
  feeds: TableFeeds;
  tables: PeerTables;
  logs: string[];
  now: { t: number };
}

const dirs: string[] = [];
const opened: Server[] = [];

afterEach(async () => {
  for (const server of opened.splice(0)) { server.feeds.close(); server.reader.close(); await server.store.close().catch(() => undefined); }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function server(id: string, dir?: string): Promise<Server> {
  const folder = dir ?? mkdtempSync(join(tmpdir(), `peer-tables-${id.slice(0, 1)}-`));
  if (!dir) dirs.push(folder);
  const store = await openServerStore(folder);
  await store.submit((tx) => {
    tx.prepare("INSERT INTO meta (key, value) VALUES ('serverId', ?) ON CONFLICT (key) DO NOTHING").run(id);
    tx.prepare("INSERT INTO streams (stream, owner, logId, head, headHash, state, heardAt) VALUES (?, ?, ?, 0, NULL, 'active', NULL) ON CONFLICT (stream) DO NOTHING").run(`srv:${id}`, id, newLogId());
  });
  const reader = store.openReader();
  const logs: string[] = [];
  const now = { t: 1_700_000_000_000 };
  const feeds = new TableFeeds({ reader: () => reader, ownStream: `srv:${id}`, log: (line) => logs.push(line) });
  const tables = new PeerTables({ store, reader: () => reader, feeds, log: (line) => logs.push(line), now: () => now.t });
  const made = { id, dir: folder, store, reader, feeds, tables, logs, now };
  opened.push(made);
  return made;
}

/** The live rows of a table as `key → {rev, body}` (own table or a copy). */
function liveRows(db: Db, stream: string): Map<string, { rev: number; body: unknown }> {
  return readTable(db, stream).rows;
}
const asObject = (rows: Map<string, { rev: number; body: unknown }>) => Object.fromEntries([...rows.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
function copyState(db: Db, stream: string): { logId: string; head: number; state: string; heardAt: number | null } | null {
  const row = db.prepare("SELECT logId, head, state, heardAt FROM streams WHERE stream = ?").get(stream);
  return row ? { logId: String(row.logId), head: Number(row.head), state: String(row.state), heardAt: row.heardAt == null ? null : Number(row.heardAt) } : null;
}
const logIdOf = (db: Db, stream: string) => String(db.prepare("SELECT logId FROM streams WHERE stream = ?").get(stream)!.logId);

/**
 * One peer session between two servers: FIFO frames through the real wire encoder (peer role), delivered one at a
 * time (D58). `cut()` ends it on both sides, as a lost / duplicated frame or a dropped connection ends a real session.
 */
class Link {
  readonly sides: [Side, Side];
  private queue: Array<{ to: Side; text: string }> = [];
  private running = false;
  open = true;
  /** Every rows/reset frame delivered to each side, decoded (for replays and counting). */
  readonly delivered: Array<{ to: string; message: WireMessage }> = [];
  onDelivered: ((to: Server, message: WireMessage) => void | Promise<void>) | null = null;
  /** Called before each frame; returning true cuts the session there (the frame is lost). */
  fault: (() => boolean) | null = null;

  constructor(readonly x: Server, readonly y: Server) {
    this.sides = [new Side(this, x, y), new Side(this, y, x)];
  }

  async start(): Promise<void> {
    await Promise.all([this.x.tables.opened(this.sides[0]), this.y.tables.opened(this.sides[1])]);
    await this.drain();
  }

  enqueue(from: Side, message: WireMessage): boolean {
    if (!this.open) return false;
    const encoded = encodeWireFrame(message, "peer", { local: false });
    if (!encoded.ok) throw new Error(`cannot encode ${message.t}: ${encoded.detail}`);
    this.queue.push({ to: from === this.sides[0] ? this.sides[1] : this.sides[0], text: encoded.text });
    return true;
  }

  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.open && this.queue.length) {
        if (this.fault?.()) { await this.cut(); break; }
        const { to, text } = this.queue.shift()!;
        const decoded = decodeWireFrame(new TextEncoder().encode(text), "peer", { local: false });
        if (!decoded.ok) throw new Error(`cannot decode: ${decoded.detail}`);
        const handled = await to.self.tables.onMessage(to, decoded.message);
        expect(handled).toBe(true);
        if (decoded.message.t === "rows" || decoded.message.t === "reset") this.delivered.push({ to: to.self.id, message: decoded.message });
        await this.onDelivered?.(to.self, decoded.message);
      }
    } finally {
      this.running = false;
    }
  }

  async cut(lastHeard?: number): Promise<void> {
    if (!this.open) return;
    this.open = false;
    this.queue = [];
    for (const side of this.sides) {
      side.state = "closed";
      side.self.tables.sessionClosed(side);
      await side.self.tables.peerState(side.other.id, "stale", lastHeard ?? side.self.now.t);
    }
  }
}

class Side implements TablePeerSession {
  state = "open";
  constructor(private readonly link: Link, readonly self: Server, readonly other: Server) {}
  get peer(): string { return this.other.id; }
  sendWire(message: WireMessage): boolean {
    if (this.state !== "open") return false;
    return this.link.enqueue(this, message);
  }
}

/** A front end reading a peer's table through its attached server's feed (as session-core does). */
class FrontEnd {
  copy: TableCopy = emptyTable();
  logId: string | null = null;
  readonly retired = new Set<string>();
  private parts: Rows[] = [];
  private feed: { close(): void } | null = null;
  violations: string[] = [];
  frames = 0;

  constructor(readonly stream: string) {}

  attach(server: Server): void {
    this.feed?.close();
    this.parts = [];
    const cursor: Cursor | null = this.logId ? { logId: this.logId as Cursor["logId"], seq: this.copy.rev } : null;
    this.feed = server.feeds.subscribe(this.stream, cursor, (frame) => { this.take(frame); return true; });
  }

  detach(): void { this.feed?.close(); this.feed = null; }

  private take(frame: WireMessage): void {
    this.frames++;
    // What a front end decodes: the wire frame from a server to an FE.
    const encoded = encodeWireFrame(frame, "server", { local: true });
    if (!encoded.ok) { this.violations.push(`cannot encode for an FE: ${encoded.detail}`); return; }
    if (frame.t === "reset") {
      if (this.logId && !frame.retired.some((old) => old.logId === this.logId)) { this.violations.push("a reset that does not retire the FE's logId"); return; }
      if (this.retired.has(frame.logId)) { this.violations.push("a reset back to a retired logId"); return; }
      for (const old of frame.retired) this.retired.add(old.logId);
      this.logId = frame.logId;
      this.copy = emptyTable();
      this.parts = [];
      return;
    }
    if (frame.t !== "rows") { this.violations.push(`unexpected ${frame.t}`); return; }
    if (this.retired.has(frame.logId)) { this.violations.push("rows of a retired logId"); return; }
    if (this.logId && frame.logId !== this.logId) { this.violations.push("rows of another logId without a reset"); return; }
    this.parts.push(frame as Rows);
    if (frame.more) return;
    const parts = this.parts;
    this.parts = [];
    const before = this.copy.rev;
    this.copy = applyRows(this.copy, parts);
    if (frame.after !== 0 && this.copy.rev < before) this.violations.push(`went back from ${before} to ${this.copy.rev}`);
    this.logId = frame.logId;
  }
}

/** The owner's writes: rows of known and unknown kinds, tombstones, purges (the clock jumps). Returns a description. */
async function randomWrite(owner: Server, random: () => number, n: number): Promise<string> {
  const stream = `srv:${owner.id}`;
  const pick = random();
  const key = Math.floor(random() * 12);
  const result = await owner.store.submit((tx) => {
    if (pick < 0.5) return putRow(tx, stream, `audit:a${key}`, { act: "test", at: n, reason: `write ${n}` }) !== null ? "put" : "same";
    if (pick < 0.65) {
      // A kind this version does not know (N4), written as a newer server would.
      const rev = tableRev(tx, stream) + 1;
      tx.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, ?, ?, 0) ON CONFLICT (stream, key) DO UPDATE SET rev = excluded.rev, body = excluded.body, deleted = 0")
        .run(stream, `future:k${key}`, rev, JSON.stringify({ n, nested: { list: [n, "x"] } }));
      return "unknown";
    }
    if (pick < 0.9) {
      const live = tx.prepare("SELECT key FROM rows WHERE stream = ? AND deleted = 0 ORDER BY key").all(stream).map((row) => String(row.key));
      if (!live.length) return "none";
      return deleteRow(tx, stream, live[Math.floor(random() * live.length)]!, owner.now.t) !== null ? "delete" : "none";
    }
    owner.now.t += Math.floor(random() * 20 * DAY);
    return `purge ${purgeTombstones(tx, stream, owner.now.t)}`;
  });
  owner.feeds.notify(stream);
  return result;
}

/** The owner restored to an older table: new logId (retireStream), rows put back as they were then. */
async function restore(owner: Server, back: { rows: Array<{ key: string; rev: number; body: string | null; deleted: number }>; purged: string | null }): Promise<string> {
  const stream = `srv:${owner.id}`;
  return owner.store.submit((tx) => {
    tx.prepare("DELETE FROM rows WHERE stream = ?").run(stream);
    const insert = tx.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, ?, ?, ?)");
    for (const row of back.rows) insert.run(stream, row.key, row.rev, row.body, row.deleted);
    tx.prepare("DELETE FROM meta WHERE key = ?").run(`rowsPurged:${stream}`);
    if (back.purged !== null) tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(`rowsPurged:${stream}`, back.purged);
    return retireStream(tx, stream, "restored").logId;
  });
}

function backupOf(owner: Server): { rows: Array<{ key: string; rev: number; body: string | null; deleted: number }>; purged: string | null } {
  const stream = `srv:${owner.id}`;
  const rows = owner.reader.prepare("SELECT key, rev, body, deleted FROM rows WHERE stream = ?").all(stream)
    .map((row) => ({ key: String(row.key), rev: Number(row.rev), body: row.body == null ? null : String(row.body), deleted: Number(row.deleted) }));
  const purged = owner.reader.prepare("SELECT value FROM meta WHERE key = ?").get(`rowsPurged:${stream}`);
  return { rows, purged: purged ? String(purged.value) : null };
}

describe("M3 step 7: copies of peers' srv: tables", () => {
  it("a first session copies the owner's table; later writes are pushed; the copy is equal after each batch", async () => {
    const a = await server(A), b = await server(B);
    for (let n = 1; n <= 5; n++) await b.store.submit((tx) => putRow(tx, `srv:${B}`, `audit:x${n}`, { act: "test", at: n }));
    const link = new Link(a, b);
    await link.start();
    expect(asObject(liveRows(a.reader, `srv:${B}`))).toEqual(asObject(liveRows(b.reader, `srv:${B}`)));
    expect(copyState(a.reader, `srv:${B}`)).toMatchObject({ logId: logIdOf(b.reader, `srv:${B}`), head: 5, state: "live" });
    // B also holds A's (empty) table: a copy exists with head 0.
    expect(copyState(b.reader, `srv:${A}`)).toMatchObject({ head: 0, state: "live" });
    await b.store.submit((tx) => deleteRow(tx, `srv:${B}`, "audit:x2", b.now.t));
    b.feeds.notify(`srv:${B}`);
    await link.drain();
    expect(liveRows(a.reader, `srv:${B}`).has("audit:x2")).toBe(false);
    expect(a.reader.prepare("SELECT deleted FROM rows WHERE stream = ? AND key = 'audit:x2'").get(`srv:${B}`)?.deleted).toBe(1);
    expect(asObject(liveRows(a.reader, `srv:${B}`))).toEqual(asObject(liveRows(b.reader, `srv:${B}`)));
    // Nothing new → nothing sent.
    const frames = link.delivered.length;
    b.feeds.notify(`srv:${B}`);
    await link.drain();
    expect(link.delivered.length).toBe(frames);
  });

  it("property: random writes, session cuts, owner restores and reader restarts → the copy equals the owner at every batch, never back, never a retired logId", async () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    let restores = 0, cuts = 0, wholes = 0, retiredReplays = 0, readerRestarts = 0;
    for (const seed of seeds) {
      const random = rng(seed);
      let a = await server(A);
      const b = await server(B);
      const stream = `srv:${B}`;
      // The owner's table at each (logId, rev) it served from.
      const snapshots = new Map<string, string>();
      const snap = () => snapshots.set(`${logIdOf(b.reader, stream)}:${tableRev(b.reader, stream)}`, JSON.stringify(asObject(liveRows(b.reader, stream))));
      snap();
      const fe = new FrontEnd(stream);
      const heads = new Map<string, number>();
      const oldFrames: Rows[] = [];
      let link: Link | null = null;
      const check = async (to: Server, message: WireMessage) => {
        if (to !== a || message.t !== "rows" || message.more) return;
        const state = copyState(a.reader, stream)!;
        // The copy equals the owner's table at (logId, head) of this batch.
        const expected = snapshots.get(`${state.logId}:${state.head}`);
        expect(expected, `seed ${seed}: a snapshot of the owner at ${state.logId}:${state.head}`).toBeDefined();
        expect(JSON.stringify(asObject(liveRows(a.reader, stream))), `seed ${seed}: copy = owner at ${state.head}`).toBe(expected);
        expect(state.head).toBeGreaterThanOrEqual(heads.get(state.logId) ?? 0);
        heads.set(state.logId, state.head);
        for (const old of listRetired(a.reader, stream)) expect(old.logId).not.toBe(state.logId);
        if (message.after === 0) wholes++;
        oldFrames.push(message as Rows);
      };
      const connect = async () => {
        link = new Link(a, b);
        link.onDelivered = check;
        const p = 0.03 + random() * 0.1;
        link.fault = () => random() < p;
        await link.start();
      };
      fe.attach(a);
      await connect();
      let backup = backupOf(b);
      for (let n = 1; n <= 120; n++) {
        const action = random();
        if (action < 0.75) {
          await randomWrite(b, random, n);
          snap();
        } else if (action < 0.82) {
          if (link!.open) { await link!.cut(); cuts++; }
        } else if (action < 0.87) {
          backup = backupOf(b);
        } else if (action < 0.91) {
          // The owner is restored while the session is down (botlingd restore runs stopped).
          await link!.cut();
          await restore(b, backup);
          snap();
          restores++;
        } else if (action < 0.94) {
          // The reader restarts: its store is reopened from its folder; the copy is still there.
          await link!.cut();
          const dir = a.dir;
          fe.detach();
          a.feeds.close(); a.reader.close(); await a.store.close();
          opened.splice(opened.indexOf(a), 1);
          a = await server(A, dir);
          fe.attach(a);
          readerRestarts++;
        } else if (oldFrames.length) {
          // A frame of an older incarnation replayed to the reader by hand: dropped if retired, never applied.
          const old = oldFrames[Math.floor(random() * oldFrames.length)]!;
          const retired = listRetired(a.reader, stream).some((item) => item.logId === old.logId);
          if (retired && link!.open && link!.sides[0].state === "open") {
            const before = JSON.stringify(asObject(liveRows(a.reader, stream)));
            const dropped = a.tables.droppedRetired;
            await a.tables.onMessage(link!.sides[0], old);
            expect(a.tables.droppedRetired).toBe(dropped + 1);
            expect(JSON.stringify(asObject(liveRows(a.reader, stream)))).toBe(before);
            retiredReplays++;
          }
        }
        // A session that ended stays down a while (writes, purges and restores pile up on the owner meanwhile).
        if (!link!.open && random() < 0.3) await connect();
        if (link!.open) await link!.drain();
      }
      // Heal: no more faults, one clean session.
      link!.fault = null;
      if (!link!.open) await connect();
      link!.fault = null;
      await link!.drain();
      expect(JSON.stringify(asObject(liveRows(a.reader, stream))), `seed ${seed}: final copy`).toBe(JSON.stringify(asObject(liveRows(b.reader, stream))));
      expect(copyState(a.reader, stream)).toMatchObject({ logId: logIdOf(b.reader, stream), head: tableRev(b.reader, stream) });
      // The front end, through A's feed, holds A's copy; it never went back nor returned to a retired logId.
      expect(fe.violations, `seed ${seed}`).toEqual([]);
      expect(fe.logId).toBe(logIdOf(b.reader, stream));
      expect(asObject(fe.copy.rows)).toEqual(asObject(liveRows(a.reader, stream)));
      fe.detach();
    }
    // The schedule really did all of it.
    expect({ cuts: cuts > 20, restores: restores > 3, wholes: wholes > 10, retiredReplays: retiredReplays > 0, readerRestarts: readerRestarts > 3 }).toEqual({ cuts: true, restores: true, wholes: true, retiredReplays: true, readerRestarts: true });
  }, 120_000);

  it("a reset is taken only when it retires the copy's logId; rows of a retired logId are dropped; stale and gone are kept on the copy", async () => {
    const a = await server(A), b = await server(B);
    const stream = `srv:${B}`;
    await b.store.submit((tx) => putRow(tx, stream, "audit:one", { act: "test", at: 1 }));
    const link = new Link(a, b);
    await link.start();
    const oldLogId = logIdOf(b.reader, stream);
    const oldRows = link.delivered.find((item) => item.to === A && item.message.t === "rows")!.message as Rows;
    // A reset from nowhere (does not list the copy's logId) is ignored.
    const stranger = { t: "reset", stream, logId: "zzzzzzzzzzzz", retired: [{ logId: "yyyyyyyyyyyy", keptSeq: 1 }], reason: "restored" } as MessageOf<"reset">;
    await a.tables.onMessage(link.sides[0], stranger);
    expect(copyState(a.reader, stream)!.logId).toBe(oldLogId);
    expect(a.logs.some((line) => /does not retire this copy's logId/.test(line))).toBe(true);
    // Rows of another table from this peer are not taken (a peer serves its own table).
    await a.tables.onMessage(link.sides[0], { ...oldRows, stream: `srv:${"C".repeat(26)}` } as Rows);
    expect(copyState(a.reader, `srv:${"C".repeat(26)}`)).toBeNull();
    // Stale since the last frame heard, on A's clock.
    await link.cut(1_700_000_000_123);
    expect(copyState(a.reader, stream)).toMatchObject({ state: "stale", heardAt: 1_700_000_000_123 });
    await a.tables.peerState(B, "gone", 1_700_000_000_500);
    expect(copyState(a.reader, stream)).toMatchObject({ state: "gone" });
    expect(liveRows(a.reader, stream).has("audit:one")).toBe(true); // kept, read only
    // B restored: the next session gets reset + the whole table; the old logId is retired at A.
    await restore(b, { rows: [], purged: null });
    const again = new Link(a, b);
    await again.start();
    expect(again.delivered.some((item) => item.to === A && item.message.t === "reset")).toBe(true);
    expect(copyState(a.reader, stream)).toMatchObject({ logId: logIdOf(b.reader, stream), head: 0, state: "live" });
    expect(liveRows(a.reader, stream).size).toBe(0);
    expect(listRetired(a.reader, stream).map((item) => item.logId)).toContain(oldLogId);
    // An old batch replayed: dropped (D50), nothing applied.
    await a.tables.onMessage(again.sides[0], oldRows);
    expect(a.tables.droppedRetired).toBe(1);
    expect(liveRows(a.reader, stream).size).toBe(0);
  });

  it("a front end ahead of the copy keeps its table until the copy passes its cursor (monotonic reads)", async () => {
    const a = await server(A), b = await server(B);
    const stream = `srv:${B}`;
    for (let n = 1; n <= 3; n++) await b.store.submit((tx) => putRow(tx, stream, `audit:r${n}`, { act: "test", at: n }));
    const link = new Link(a, b);
    await link.start();
    const logId = logIdOf(b.reader, stream);
    const frames: WireMessage[] = [];
    const feed = a.feeds.subscribe(stream, { logId: logId as Cursor["logId"], seq: 7 }, (frame) => { frames.push(frame); return true; });
    expect(frames).toEqual([]);
    for (let n = 4; n <= 9; n++) { await b.store.submit((tx) => putRow(tx, stream, `audit:r${n}`, { act: "test", at: n })); b.feeds.notify(stream); await link.drain(); }
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect((frame as Rows).after).toBeGreaterThanOrEqual(7);
    expect((frames.at(-1) as Rows).to).toBe(9);
    feed.close();
  });

  it("a copy below the owner's purge mark gets the whole table and drops rows deleted meanwhile; a front end below the copy's mark too", async () => {
    const a = await server(A), b = await server(B);
    const stream = `srv:${B}`;
    for (let n = 1; n <= 4; n++) await b.store.submit((tx) => putRow(tx, stream, `audit:p${n}`, { act: "test", at: n }));
    const link = new Link(a, b);
    await link.start();
    const fe = new FrontEnd(stream);
    fe.attach(a);
    expect(fe.copy.rows.size).toBe(4);
    fe.detach();
    await link.cut();
    // While A is away: p2 is deleted, 31 days pass, another write (the tombstone is not the top row), purge.
    await b.store.submit((tx) => deleteRow(tx, stream, "audit:p2", b.now.t));
    b.now.t += 31 * DAY;
    await b.store.submit((tx) => putRow(tx, stream, "audit:p5", { act: "test", at: 5 }));
    expect(await b.store.submit((tx) => purgeTombstones(tx, stream, b.now.t))).toBe(1);
    const again = new Link(a, b);
    await again.start();
    const batch = again.delivered.find((item) => item.to === A && item.message.t === "rows")!.message as Rows;
    expect(batch.after).toBe(0);
    expect(asObject(liveRows(a.reader, stream))).toEqual(asObject(liveRows(b.reader, stream)));
    expect(liveRows(a.reader, stream).has("audit:p2")).toBe(false);
    // The front end comes back with its old cursor (below the copy's mark): the whole table, p2 gone there too.
    fe.attach(a);
    expect(fe.violations).toEqual([]);
    expect(fe.copy.rows.has("audit:p2")).toBe(false);
    expect(asObject(fe.copy.rows)).toEqual(asObject(liveRows(a.reader, stream)));
    fe.detach();
  });
});
