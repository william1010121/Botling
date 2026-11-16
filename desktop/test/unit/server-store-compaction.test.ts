// The one-time prune + VACUUM of an oversized server.db (src/server/store/compaction.ts): old entries leave by the log's
// own eviction (the chain still verifies, readers behind the tail get a snap), the read models stay whole, the latest
// bot.updated / settings.updated of the `srv:` stream stay available to `SummaryRows.reconcile`, it runs once, a crash
// keeps a stream as it was, and a low disk skips the VACUUM.
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BotView } from "../../src/contract";
import { settingsView } from "../../src/core/settings";
import { GENESIS_HASH, type StreamId } from "../../src/protocol";
import { appendEntries, ensureStream, LogHub, readEntries, readSnap, readStream, verifyStream, type AppendItem } from "../../src/server/log";
import { PRUNED_KEY, runCompaction, VACUUMED_KEY, type CompactionOptions } from "../../src/server/store/compaction";
import { migrate, openServerStore, Writer, type Db } from "../../src/server/store";
import { openDb } from "../../src/server/store/sqlite";
import { FakeFe, message } from "./server-log-helpers";

const A = "bot:alpha" as StreamId;
const B = "bot:beta" as StreamId;
const SRV = "srv:s1" as StreamId;
const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open(): { db: Db; file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "botling-compact-"));
  dirs.push(dir);
  const file = join(dir, "server.db");
  const db = openDb(file);
  dbs.push(db);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA foreign_keys = ON;");
  migrate(db);
  return { db, file, dir };
}

function tx<T>(db: Db, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = run();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

const view = (id: string, over: Partial<BotView> = {}): BotView => ({
  id, name: `Bot ${id}`, role: "manager", avatar: "circle", folder: `/work/${id}`, phase: "awake", working: false,
  approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [], ...over,
});
const line = (botId: string, id: string, text: string, kind = "message.updated"): AppendItem => ({ kind, body: { botId, message: message(id, text) } });
const botUpdated = (id: string, unread: number): AppendItem => ({ kind: "bot.updated", body: { bot: view(id, { unread }) } });
const BIG = "x".repeat(4000);

/** A bot stream with `count` entries: line l<n> added, then re-sent (a growing state snapshot) over and over. */
function fillBot(db: Db, stream: StreamId, count: number): void {
  const botId = stream.slice(4);
  tx(db, () => {
    ensureStream(db, stream, "s1");
    for (let i = 0; i < count; i++) {
      const id = `l${i % 7}`;
      appendEntries(db, stream, [line(botId, id, `${BIG}${i}`, i < 7 ? "message.added" : "message.updated")]);
    }
  });
}

const SMALL: CompactionOptions = { minDbBytes: 0, keepEntries: 20, keepBytes: 1e9, minKeepEntries: 5, minReclaimBytes: 1, headroomBytes: 0, freeBytes: () => 1e12 };
const table = (db: Db, name: string) => db.prepare(`SELECT * FROM ${name} ORDER BY 1, 2`).all();

describe("prune: the old entries of each own stream go by eviction", () => {
  it("moves the tail up so the newest keepEntries stay, the chain still verifies and the read models are untouched", () => {
    const { db } = open();
    fillBot(db, A, 80);
    fillBot(db, B, 12); // already short: nothing to evict
    const before = { messages: table(db, "messages"), bots: table(db, "bots"), cards: table(db, "cards") };
    const headHash = readStream(db, A)!.headHash;
    const report = runCompaction(db, SMALL);
    expect(report.ran).toBe(true);
    const row = readStream(db, A)!;
    expect(row).toMatchObject({ head: 80, tail: 60, headHash });
    expect(readStream(db, B)).toMatchObject({ head: 12, tail: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM entries WHERE stream = ?").get(A)!.n).toBe(20);
    expect(db.prepare("SELECT min(seq) AS n FROM entries WHERE stream = ?").get(A)!.n).toBe(61);
    expect(verifyStream(db, A).ok).toBe(true);
    expect(verifyStream(db, B).ok).toBe(true);
    // The tail hash is the hash of the last evicted entry: the first kept entry chains from it.
    const all = readEntries(db, A, 61, { maxEntries: 100, maxBytes: 1e9 }).entries;
    expect(all).toHaveLength(20);
    expect(table(db, "messages")).toEqual(before.messages);
    expect(table(db, "bots")).toEqual(before.bots);
    expect(table(db, "cards")).toEqual(before.cards);
    expect(before.messages.length).toBe(14); // 7 lines in each of the two bots
  });

  it("keeps fewer entries when they are big (keepBytes) but never fewer than minKeepEntries", () => {
    const { db } = open();
    fillBot(db, A, 80);
    runCompaction(db, { ...SMALL, keepEntries: 50, keepBytes: 18000, minKeepEntries: 2 });
    expect(readStream(db, A)!.head - readStream(db, A)!.tail).toBe(4);
    const second = open();
    fillBot(second.db, A, 80);
    runCompaction(second.db, { ...SMALL, keepEntries: 50, keepBytes: 1, minKeepEntries: 7 });
    expect(readStream(second.db, A)!.head - readStream(second.db, A)!.tail).toBe(7);
  });

  it("only touches own streams: a followed (live) stream's row and entries stay", () => {
    const { db } = open();
    fillBot(db, A, 40);
    db.prepare("INSERT INTO streams (stream, owner, logId, head, headHash, state, tail, tailHash) VALUES ('bot:peer', 'other', 'lid', 40, 'h40', 'live', 0, ?)").run(GENESIS_HASH);
    for (let seq = 1; seq <= 40; seq++) db.prepare("INSERT INTO entries (stream, seq, logId, hlc, kind, body, hash) VALUES ('bot:peer', ?, 'lid', '{}', 'turn.delta', '{}', ?)").run(seq, `h${seq}`);
    runCompaction(db, SMALL);
    expect(readStream(db, "bot:peer")).toMatchObject({ tail: 0, head: 40, state: "live" });
    expect(db.prepare("SELECT count(*) AS n FROM entries WHERE stream = 'bot:peer'").get()!.n).toBe(40);
    expect(readStream(db, A)!.tail).toBe(20);
  });

  it("a reader at the tail still gets entries; one behind it gets a snap whose messages are all there (catch-up before the tail)", async () => {
    const { db, file } = open();
    fillBot(db, A, 80);
    const early = readEntries(db, A, 1, { maxEntries: 80, maxBytes: 1e9 }).entries;
    runCompaction(db, SMALL);
    const writer = new Writer(db);
    const hub = new LogHub({ submit: (command) => writer.submit(command), openReader: () => { const r = openDb(file, { readOnly: true }); dbs.push(r); return r; } });
    try {
      const row = readStream(db, A)!;
      const atTail = new FakeFe("tail");
      atTail.forceCursor(A, { logId: row.logId, seq: row.tail }, early[row.tail - 1].hash);
      await hub.attach(atTail.receive).sub(A, atTail.cursor(A));
      expect(atTail.frames.map((f) => f.t)).toEqual(["batch"]);
      expect(atTail.cursor(A)!.seq).toBe(80);
      const behind = new FakeFe("behind");
      behind.forceCursor(A, { logId: row.logId, seq: 10 }, early[9].hash);
      await hub.attach(behind.receive).sub(A, behind.cursor(A));
      expect(behind.frames.map((f) => f.t)).toEqual(["snap"]);
      expect(behind.cursor(A)!.seq).toBe(80);
      for (const fe of [atTail, behind]) expect(fe.violations).toEqual([]);
      const snap = readSnap(db, A)!.frame.view as { messages: Array<{ id: string }> };
      expect(snap.messages.map((m) => m.id).sort()).toEqual(["l0", "l1", "l2", "l3", "l4", "l5", "l6"]);
      // New appends chain on from the head as before.
      tx(db, () => appendEntries(db, A, [line("alpha", "l1", "later")]));
      expect(verifyStream(db, A).ok).toBe(true);
    } finally {
      hub.close();
      await writer.close();
    }
  });
});

describe("prune: the srv: stream keeps the latest state SummaryRows.reconcile reads", () => {
  function fillSrv(db: Db): void {
    tx(db, () => {
      db.prepare("INSERT INTO bots (botId) VALUES ('B1'), ('B2')").run();
      ensureStream(db, SRV, "s1");
      appendEntries(db, SRV, [botUpdated("B2", 7), { kind: "settings.updated", body: { settings: settingsView({}) } }, botUpdated("GONE", 1)]);
      for (let i = 0; i < 60; i++) appendEntries(db, SRV, [botUpdated("B1", i)]);
    });
  }
  const latest = (db: Db) => {
    const found = new Map<string, unknown>();
    for (const row of db.prepare("SELECT kind, body FROM entries WHERE stream = ? AND kind IN ('bot.updated', 'settings.updated') ORDER BY seq").all(SRV)) {
      const body = JSON.parse(String(row.body)) as { bot?: BotView; settings?: unknown };
      if (row.kind === "bot.updated") found.set(body.bot!.id, body.bot); else found.set("settings", body.settings);
    }
    return found;
  };

  it("writes the latest bot.updated of each live bot and settings.updated at the head before evicting below them", () => {
    const { db } = open();
    fillSrv(db);
    const before = latest(db);
    const report = runCompaction(db, SMALL);
    expect(report.streams.find((s) => s.stream === SRV)).toMatchObject({ evicted: 43, carried: 2 });
    const after = latest(db);
    expect(after.get("B1")).toEqual(before.get("B1"));
    expect(after.get("B2")).toEqual(before.get("B2")); // its only entry was below the cut
    expect(after.get("settings")).toEqual(before.get("settings"));
    expect(after.has("GONE")).toBe(false); // a bot no longer in `bots` is not carried
    expect(verifyStream(db, SRV).ok).toBe(true);
    const row = readStream(db, SRV)!;
    expect(row.head).toBe(65);
    expect(row.tail).toBe(43);
  });
});

describe("runs once, and a kill in the middle is safe", () => {
  it("writes its markers, and a second run (or a new open) does nothing", () => {
    const { db } = open();
    fillBot(db, A, 60);
    const first = runCompaction(db, SMALL);
    expect(first).toMatchObject({ ran: true, failed: [], vacuum: "done" });
    expect(db.prepare("SELECT value FROM meta WHERE key = ?").get(PRUNED_KEY)).toBeTruthy();
    expect(db.prepare("SELECT value FROM meta WHERE key = ?").get(VACUUMED_KEY)).toBeTruthy();
    fillBot(db, B, 60); // history that would be pruned again
    const again = runCompaction(db, SMALL);
    expect(again).toMatchObject({ ran: false, skipped: "done" });
    expect(readStream(db, B)!.tail).toBe(0);
  });

  it("leaves a stream as it was when the process dies before its COMMIT, and the next run finishes the job", () => {
    const { db } = open();
    fillBot(db, A, 80);
    fillBot(db, B, 80);
    const beforeA = readStream(db, A)!;
    let killed = 0;
    const crash = () => { killed++; throw new Error("killed"); };
    // beforeCommit throwing is a crash inside the transaction of the first stream (A): the failure is logged, A is whole.
    const report = runCompaction(db, { ...SMALL, beforeCommit: (stream) => { if (stream === A) crash(); } });
    expect(killed).toBe(1);
    expect(report.failed).toEqual([A]);
    expect(report.vacuum).toBe("skipped");
    expect(readStream(db, A)).toEqual(beforeA);
    expect(verifyStream(db, A).ok).toBe(true);
    expect(db.inTransaction).toBe(false);
    expect(readStream(db, B)!.tail).toBe(60); // the other stream went through
    expect(db.prepare("SELECT 1 FROM meta WHERE key = ?").get(PRUNED_KEY)).toBeUndefined(); // not done: it is tried again
    const next = runCompaction(db, SMALL);
    expect(next.failed).toEqual([]);
    expect(readStream(db, A)).toMatchObject({ tail: 60, head: 80 });
    expect(readStream(db, B)!.tail).toBe(60);
    expect(verifyStream(db, A).ok && verifyStream(db, B).ok).toBe(true);
    expect(db.prepare("SELECT 1 FROM meta WHERE key = ?").get(PRUNED_KEY)).toBeTruthy();
  });

  it("a connection closed with the stream's transaction open (the process dying) keeps the stream whole on the next open", () => {
    const { db, file } = open();
    fillBot(db, A, 80);
    const beforeA = readStream(db, A)!;
    expect(() => runCompaction(db, { ...SMALL, beforeCommit: () => { db.close(); throw new Error("killed"); } })).not.toThrow();
    const reopened = openDb(file);
    dbs.push(reopened);
    expect(readStream(reopened, A)).toEqual(beforeA);
    expect(verifyStream(reopened, A).ok).toBe(true);
    expect(reopened.prepare("SELECT 1 FROM meta WHERE key = ?").get(PRUNED_KEY)).toBeUndefined();
    const next = runCompaction(reopened, SMALL);
    expect(next.failed).toEqual([]);
    expect(readStream(reopened, A)).toMatchObject({ tail: 60, head: 80 });
  });

  it("a process death between the prune and the VACUUM only repeats the cheap checks", () => {
    const { db } = open();
    fillBot(db, A, 80);
    runCompaction(db, { ...SMALL, freeBytes: () => 0 }); // prune done, VACUUM refused
    expect(db.prepare("SELECT 1 FROM meta WHERE key = ?").get(PRUNED_KEY)).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM meta WHERE key = ?").get(VACUUMED_KEY)).toBeUndefined();
    const evicted = readStream(db, A)!.tail;
    const next = runCompaction(db, SMALL);
    expect(next.streams).toEqual([]); // no second prune
    expect(next.vacuum).toBe("done");
    expect(readStream(db, A)!.tail).toBe(evicted);
  });
});

describe("VACUUM", () => {
  it("shrinks the file and switches auto_vacuum to INCREMENTAL", () => {
    const { db, file } = open();
    fillBot(db, A, 400);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = statSync(file).size;
    expect(Number(db.pragma("auto_vacuum"))).toBe(0);
    const report = runCompaction(db, { ...SMALL, keepEntries: 10 });
    expect(report.vacuum).toBe("done");
    expect(Number(db.pragma("auto_vacuum"))).toBe(2);
    expect(Number(db.pragma("freelist_count"))).toBe(0);
    expect(statSync(file).size).toBeLessThan(before / 5);
    expect(db.pragma("integrity_check")).toBe("ok");
    expect(verifyStream(db, A).ok).toBe(true);
  });

  it("is skipped with a log line when the disk has no room, the prune still happens, and it is retried at the next start", () => {
    const { db } = open();
    fillBot(db, A, 200);
    const lines: string[] = [];
    const lowDisk = runCompaction(db, { ...SMALL, freeBytes: () => 10, log: (text) => lines.push(text) });
    expect(lowDisk.vacuum).toBe("low-disk");
    expect(lines.some((text) => /VACUUM skipped: it needs/.test(text))).toBe(true);
    expect(Number(db.pragma("auto_vacuum"))).toBe(0);
    expect(Number(db.pragma("freelist_count"))).toBeGreaterThan(0);
    expect(readStream(db, A)!.tail).toBeGreaterThan(0);
    // The data folder's volume needs 2x the result, the temp folder's 1x: either one short is enough to skip.
    const tight = runCompaction(db, { ...SMALL, freeBytes: (path) => (path === db.path.replace(/\/server\.db$/, "") ? 1e12 : 10) });
    expect(tight.vacuum).toBe("low-disk");
    const later = runCompaction(db, SMALL);
    expect(later.vacuum).toBe("done");
    expect(Number(db.pragma("freelist_count"))).toBe(0);
  });

  it("is skipped when little would come back", () => {
    const { db } = open();
    fillBot(db, A, 10);
    const report = runCompaction(db, { ...SMALL, minReclaimBytes: 1e9 });
    expect(report.vacuum).toBe("nothing-to-reclaim");
    expect(Number(db.pragma("auto_vacuum"))).toBe(0);
  });
});

describe("when it runs at all", () => {
  it("leaves a file under minDbBytes alone, with no marker", () => {
    const { db } = open();
    fillBot(db, A, 80);
    const report = runCompaction(db, { ...SMALL, minDbBytes: 1e12 });
    expect(report).toMatchObject({ ran: false, skipped: "small" });
    expect(readStream(db, A)!.tail).toBe(0);
    expect(db.prepare("SELECT 1 FROM meta WHERE key LIKE 'compaction.%'").get()).toBeUndefined();
  });

  it("is not done on a schema whose bodies may be differences", () => {
    const { db } = open();
    fillBot(db, A, 80);
    db.prepare("UPDATE meta SET value = '15' WHERE key = 'schemaVersion'").run();
    expect(runCompaction(db, SMALL)).toMatchObject({ ran: false, skipped: "schema" });
    expect(readStream(db, A)!.tail).toBe(0);
  });

  it("runs from openServerStore on an existing file, before the pre-migration backup", async () => {
    const { dir, db } = open();
    fillBot(db, A, 80);
    db.exec("DROP TABLE slot_results");
    db.prepare("UPDATE meta SET value = '13' WHERE key = 'schemaVersion'").run(); // one migration (v14) to apply
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    const store = await openServerStore(dir, { compaction: SMALL });
    try {
      expect(store.migrated).toEqual([14]);
      expect(store.meta(PRUNED_KEY)).toBeDefined();
      const reader = store.openReader();
      try { expect(readStream(reader, A)).toMatchObject({ tail: 60, head: 80 }); } finally { reader.close(); }
      expect(existsSync(join(dir, "backups"))).toBe(true);
    } finally {
      await store.close();
    }
    // A fresh file, and an off switch, are left alone.
    const fresh = mkdtempSync(join(tmpdir(), "botling-compact-fresh-"));
    dirs.push(fresh);
    const young = await openServerStore(fresh, { compaction: SMALL });
    expect(young.meta(PRUNED_KEY)).toBeUndefined();
    await young.close();
  });
});
