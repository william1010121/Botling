// The one-time prune + VACUUM of an oversized server.db (src/server/store/compaction.ts). The prune runs in the background
// after botlingd is up, as many short writer commands (it must never hold up a start: the install script waits 120 s for
// `healthy`); the VACUUM runs at the first start after it. Old entries leave by the log's own eviction (the chain still
// verifies, readers behind the tail get a snap), the read models stay whole, the latest bot.updated / settings.updated
// of the `srv:` stream stay available to `SummaryRows.reconcile`, it runs once, a stop or crash keeps the log whole, and
// a low disk skips the VACUUM.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BotView } from "../../src/contract";
import { settingsView } from "../../src/core/settings";
import { GENESIS_HASH, type StreamId } from "../../src/protocol";
import { appendEntries, ensureStream, LogHub, readEntries, readSnap, readStream, verifyStream, type AppendItem } from "../../src/server/log";
import { Botlingd } from "../../src/server/botlingd";
import type { BotlingdOptions } from "../../src/server/botlingd-cluster";
import { pruneInBackground, PRUNED_KEY, runStartupVacuum, startBackgroundPrune, VACUUMED_KEY, type CompactionOptions, type PruneDeps, type PruneReport } from "../../src/server/store/compaction";
import { migrate, openServerStore, Writer, type Db, type WriterOptions } from "../../src/server/store";
import { openDb } from "../../src/server/store/sqlite";
import { botlingdEnv, testRoot } from "../botlingd-harness";
import { desktop, until } from "../helpers";
import { FakeFe, message } from "./server-log-helpers";

const A = "bot:alpha" as StreamId;
const B = "bot:beta" as StreamId;
const SRV = "srv:s1" as StreamId;
const dirs: string[] = [];
const dbs: Db[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
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
const noPause = async () => undefined;
const marked = (db: Db, key: string) => db.prepare("SELECT 1 FROM meta WHERE key = ?").get(key) !== undefined;

interface Run { report: PruneReport; commands: number }

/** Runs the background prune on `db` through a writer (the way botlingd does), with no pause between commands. */
async function prune(db: Db, over: Partial<PruneDeps> = {}, writerOptions: WriterOptions = {}): Promise<Run> {
  const writer = new Writer(db, writerOptions);
  try {
    const report = await pruneInBackground({ ...SMALL, submit: (command) => writer.submit(command), pause: noPause, ...over });
    return { report, commands: report.commands };
  } finally {
    await writer.close();
  }
}

describe("prune: the old entries of each own stream go by eviction", () => {
  it("moves the tail up so the newest keepEntries stay, the chain still verifies and the read models are untouched", async () => {
    const { db } = open();
    fillBot(db, A, 80);
    fillBot(db, B, 12); // already short: nothing to evict
    const before = { messages: table(db, "messages"), bots: table(db, "bots"), cards: table(db, "cards") };
    const headHash = readStream(db, A)!.headHash;
    const { report } = await prune(db);
    expect(report).toMatchObject({ ran: true, failed: [], stopped: false });
    const row = readStream(db, A)!;
    expect(row).toMatchObject({ head: 80, tail: 60, headHash });
    expect(readStream(db, B)).toMatchObject({ head: 12, tail: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM entries WHERE stream = ?").get(A)!.n).toBe(20);
    expect(db.prepare("SELECT min(seq) AS n FROM entries WHERE stream = ?").get(A)!.n).toBe(61);
    expect(verifyStream(db, A).ok).toBe(true);
    expect(verifyStream(db, B).ok).toBe(true);
    const all = readEntries(db, A, 61, { maxEntries: 100, maxBytes: 1e9 }).entries;
    expect(all).toHaveLength(20);
    expect(table(db, "messages")).toEqual(before.messages);
    expect(table(db, "bots")).toEqual(before.bots);
    expect(table(db, "cards")).toEqual(before.cards);
    expect(before.messages.length).toBe(14); // 7 lines in each of the two bots
  });

  it("keeps fewer entries when they are big (keepBytes) but never fewer than minKeepEntries", async () => {
    const { db } = open();
    fillBot(db, A, 80);
    await prune(db, { keepEntries: 50, keepBytes: 18000, minKeepEntries: 2 });
    expect(readStream(db, A)!.head - readStream(db, A)!.tail).toBe(4);
    const second = open();
    fillBot(second.db, A, 80);
    await prune(second.db, { keepEntries: 50, keepBytes: 1, minKeepEntries: 7 });
    expect(readStream(second.db, A)!.head - readStream(second.db, A)!.tail).toBe(7);
  });

  it("only touches own streams: a followed (live) stream's row and entries stay", async () => {
    const { db } = open();
    fillBot(db, A, 40);
    db.prepare("INSERT INTO streams (stream, owner, logId, head, headHash, state, tail, tailHash) VALUES ('bot:peer', 'other', 'lid', 40, 'h40', 'live', 0, ?)").run(GENESIS_HASH);
    for (let seq = 1; seq <= 40; seq++) db.prepare("INSERT INTO entries (stream, seq, logId, hlc, kind, body, hash) VALUES ('bot:peer', ?, 'lid', '{}', 'turn.delta', '{}', ?)").run(seq, `h${seq}`);
    await prune(db);
    expect(readStream(db, "bot:peer")).toMatchObject({ tail: 0, head: 40, state: "live" });
    expect(db.prepare("SELECT count(*) AS n FROM entries WHERE stream = 'bot:peer'").get()!.n).toBe(40);
    expect(readStream(db, A)!.tail).toBe(20);
  });

  it("a reader at the tail still gets entries; one behind it gets a snap whose messages are all there (catch-up before the tail)", async () => {
    const { db, file } = open();
    fillBot(db, A, 80);
    const early = readEntries(db, A, 1, { maxEntries: 80, maxBytes: 1e9 }).entries;
    await prune(db);
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
      tx(db, () => appendEntries(db, A, [line("alpha", "l1", "later")]));
      expect(verifyStream(db, A).ok).toBe(true);
    } finally {
      hub.close();
      await writer.close();
    }
  });
});

describe("prune: many short commands, never one long transaction", () => {
  it("evicts at most batchEntries per command and uses many commands", async () => {
    const { db } = open();
    fillBot(db, A, 240); // cut 220
    const tails: number[] = [];
    const writer = new Writer(db);
    try {
      const report = await pruneInBackground({
        ...SMALL, batchEntries: 25, pause: noPause,
        submit: async (command) => { const out = await writer.submit(command); tails.push(readStream(db, A)!.tail); return out; },
      });
      expect(report).toMatchObject({ ran: true, failed: [], stopped: false });
    } finally { await writer.close(); }
    const steps = tails.map((tail, index) => tail - (index ? tails[index - 1] : 0));
    expect(Math.max(...steps)).toBeLessThanOrEqual(25);
    expect(steps.filter((step) => step > 0).length).toBe(9); // 220 = 8 x 25 + 20
    expect(readStream(db, A)!.tail).toBe(220);
    expect(verifyStream(db, A).ok).toBe(true);
  });

  it("other writes get in between: an append that arrives mid-prune chains on, and the chain verifies", async () => {
    const { db } = open();
    fillBot(db, A, 120);
    const writer = new Writer(db);
    let appended = 0;
    try {
      const report = await pruneInBackground({
        ...SMALL, batchEntries: 10, submit: (command) => writer.submit(command),
        pause: async () => { appended++; await writer.submit((tx2) => appendEntries(tx2, A, [line("alpha", "l1", `during ${appended}`)])); },
      });
      expect(report.failed).toEqual([]);
    } finally { await writer.close(); }
    expect(appended).toBeGreaterThan(3);
    const row = readStream(db, A)!;
    expect(row.head).toBe(120 + appended);
    expect(row.tail).toBe(100); // the cut was planned at head 120 (keep 20)
    expect(verifyStream(db, A).ok).toBe(true);
  });

  it("reports the streams it changed, so readers behind the new tail get a snap", async () => {
    const { db } = open();
    fillBot(db, A, 80);
    fillBot(db, B, 12);
    const changed: string[] = [];
    await prune(db, { changed: (stream) => changed.push(stream) });
    expect(changed).toEqual([A]);
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

  it("writes the latest bot.updated of each live bot and settings.updated at the head before evicting below them", async () => {
    const { db } = open();
    fillSrv(db);
    const before = latest(db);
    const { report } = await prune(db, { scanSpan: 7 }); // the scan is several commands
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

  it("a newer bot.updated that arrives during the scan wins: the stale copy is not written after it", async () => {
    const { db } = open();
    fillSrv(db);
    const writer = new Writer(db);
    let first = true;
    try {
      await pruneInBackground({
        ...SMALL, scanSpan: 7, submit: (command) => writer.submit(command),
        pause: async () => {
          if (!first) return;
          first = false;
          await writer.submit((tx2) => appendEntries(tx2, SRV, [botUpdated("B2", 99)]));
        },
      });
    } finally { await writer.close(); }
    const states = db.prepare("SELECT body FROM entries WHERE stream = ? AND kind = 'bot.updated' ORDER BY seq").all(SRV)
      .map((row) => (JSON.parse(String(row.body)) as { bot: BotView }).bot).filter((bot) => bot.id === "B2");
    expect(states.map((bot) => bot.unread)).toEqual([99]); // not [99, 7]: the old copy did not follow the newer one
    expect(verifyStream(db, SRV).ok).toBe(true);
  });
});

describe("stop, crash and run once", () => {
  it("writes its marker, and a second run does nothing", async () => {
    const { db } = open();
    fillBot(db, A, 60);
    const first = await prune(db);
    expect(first.report).toMatchObject({ ran: true, failed: [] });
    expect(marked(db, PRUNED_KEY)).toBe(true);
    fillBot(db, B, 60); // history that would be pruned again
    const again = await prune(db);
    expect(again.report).toMatchObject({ ran: false, skipped: "done" });
    expect(readStream(db, B)!.tail).toBe(0);
  });

  it("stopped between commands: no marker, the log is shorter but whole, and the next run finishes", async () => {
    const { db } = open();
    fillBot(db, A, 240);
    let commands = 0;
    const stopped = await prune(db, { batchEntries: 25, stopped: () => commands >= 4 }, { onBatch: () => { commands++; } });
    expect(stopped.report).toMatchObject({ stopped: true });
    expect(marked(db, PRUNED_KEY)).toBe(false);
    const part = readStream(db, A)!;
    expect(part.tail).toBeGreaterThan(0);
    expect(part.tail).toBeLessThan(220);
    expect(verifyStream(db, A).ok).toBe(true);
    const next = await prune(db, { batchEntries: 25 });
    expect(next.report).toMatchObject({ ran: true, stopped: false, failed: [] });
    expect(readStream(db, A)).toMatchObject({ tail: 220, head: 240 });
    expect(verifyStream(db, A).ok).toBe(true);
    expect(marked(db, PRUNED_KEY)).toBe(true);
  });

  it("a writer closed under it (botlingd stopping) ends it quietly, with no marker", async () => {
    const { db } = open();
    fillBot(db, A, 240);
    const writer = new Writer(db);
    let calls = 0;
    const report = await pruneInBackground({
      ...SMALL, batchEntries: 25, pause: noPause,
      submit: (command) => { if (++calls === 4) void writer.close(); return writer.submit(command); },
    });
    expect(report.stopped).toBe(true);
    expect(report.failed).toEqual([]);
    expect(marked(db, PRUNED_KEY)).toBe(false);
    expect(verifyStream(db, A).ok).toBe(true);
  });

  it("leaves a stream as it was when its commit fails, goes on with the others, and the next run finishes the job", async () => {
    const { db } = open();
    fillBot(db, A, 80);
    fillBot(db, B, 80);
    const beforeA = readStream(db, A)!;
    // Batches: 1 the gate, 2 A's plan, 3 A's eviction (killed), 4 B's plan, 5 B's eviction.
    const killed = await prune(db, {}, { beforeCommit: (batch) => { if (batch === 3) throw new Error("killed"); } });
    expect(killed.report.failed).toEqual([A]);
    expect(readStream(db, A)).toEqual(beforeA);
    expect(verifyStream(db, A).ok).toBe(true);
    expect(db.inTransaction).toBe(false);
    expect(readStream(db, B)!.tail).toBe(60); // the other stream went through
    expect(marked(db, PRUNED_KEY)).toBe(false); // not done: it is tried again
    const next = await prune(db);
    expect(next.report.failed).toEqual([]);
    expect(readStream(db, A)).toMatchObject({ tail: 60, head: 80 });
    expect(readStream(db, B)!.tail).toBe(60);
    expect(verifyStream(db, A).ok && verifyStream(db, B).ok).toBe(true);
    expect(marked(db, PRUNED_KEY)).toBe(true);
  });

  it("a process death in the middle (the connection gone) keeps the log whole on the next open", async () => {
    const { db, file } = open();
    fillBot(db, A, 240);
    let commands = 0;
    const writer = new Writer(db);
    await pruneInBackground({
      ...SMALL, batchEntries: 25, pause: noPause, submit: (command) => writer.submit(command), stopped: () => ++commands > 4,
    });
    await writer.close();
    db.close(); // the process dies here
    const reopened = openDb(file);
    dbs.push(reopened);
    expect(verifyStream(reopened, A).ok).toBe(true);
    expect(marked(reopened, PRUNED_KEY)).toBe(false);
    const next = await prune(reopened, { batchEntries: 25 });
    expect(next.report.failed).toEqual([]);
    expect(readStream(reopened, A)).toMatchObject({ tail: 220, head: 240 });
  });
});

describe("startBackgroundPrune", () => {
  it("waits delayMs before it starts anything, and stop() before then means it never runs", async () => {
    const { db } = open();
    fillBot(db, A, 80);
    const writer = new Writer(db);
    try {
      const calls: number[] = [];
      const later = startBackgroundPrune({ ...SMALL, delayMs: 150, pause: noPause, submit: (command) => { calls.push(1); return writer.submit(command); } });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(calls).toEqual([]);
      await until(() => marked(db, PRUNED_KEY), { timeout: 5_000, what: "the prune marker" });
      await later.stop();
      const earlyStop = open();
      fillBot(earlyStop.db, A, 80);
      const w2 = new Writer(earlyStop.db);
      const never = startBackgroundPrune({ ...SMALL, delayMs: 30, submit: (command) => w2.submit(command) });
      await never.stop();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(readStream(earlyStop.db, A)!.tail).toBe(0);
      await w2.close();
    } finally { await writer.close(); }
  });
});

describe("VACUUM (at the first start after the prune)", () => {
  it("does nothing before the prune has finished", () => {
    const { db } = open();
    fillBot(db, A, 200);
    expect(runStartupVacuum(db, SMALL)).toMatchObject({ vacuum: null });
    expect(Number(db.pragma("auto_vacuum"))).toBe(0);
  });

  it("shrinks the file and switches auto_vacuum to INCREMENTAL, and it is done once", async () => {
    const { db, file } = open();
    fillBot(db, A, 400);
    await prune(db, { keepEntries: 10 });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = statSync(file).size;
    expect(Number(db.pragma("auto_vacuum"))).toBe(0);
    const report = runStartupVacuum(db, SMALL);
    expect(report.vacuum).toBe("done");
    expect(Number(db.pragma("auto_vacuum"))).toBe(2);
    expect(Number(db.pragma("freelist_count"))).toBe(0);
    expect(statSync(file).size).toBeLessThan(before / 5);
    expect(db.pragma("integrity_check")).toBe("ok");
    expect(verifyStream(db, A).ok).toBe(true);
    expect(marked(db, VACUUMED_KEY)).toBe(true);
    expect(runStartupVacuum(db, SMALL)).toMatchObject({ vacuum: null });
  });

  it("is skipped with a log line when the disk has no room, and it is retried at the next start", async () => {
    const { db } = open();
    fillBot(db, A, 200);
    await prune(db);
    const lines: string[] = [];
    const lowDisk = runStartupVacuum(db, { ...SMALL, freeBytes: () => 10, log: (text) => lines.push(text) });
    expect(lowDisk.vacuum).toBe("low-disk");
    expect(lines.some((text) => /VACUUM skipped: it needs/.test(text))).toBe(true);
    expect(Number(db.pragma("auto_vacuum"))).toBe(0);
    expect(Number(db.pragma("freelist_count"))).toBeGreaterThan(0);
    expect(marked(db, VACUUMED_KEY)).toBe(false);
    // The data folder's volume needs 3x the result, the temp folder's 1x: either one short is enough to skip.
    const tight = runStartupVacuum(db, { ...SMALL, freeBytes: (path) => (path === db.path.replace(/\/server\.db$/, "") ? 1e12 : 10) });
    expect(tight.vacuum).toBe("low-disk");
    expect(runStartupVacuum(db, SMALL).vacuum).toBe("done");
    expect(Number(db.pragma("freelist_count"))).toBe(0);
  });

  it("is skipped (and not tried again) when little would come back", async () => {
    const { db } = open();
    fillBot(db, A, 10);
    await prune(db);
    const report = runStartupVacuum(db, { ...SMALL, minReclaimBytes: 1e9 });
    expect(report.vacuum).toBe("nothing-to-reclaim");
    expect(Number(db.pragma("auto_vacuum"))).toBe(0);
    expect(marked(db, VACUUMED_KEY)).toBe(true);
  });
});

describe("when it runs at all", () => {
  it("leaves a file under minDbBytes alone, with no marker", async () => {
    const { db } = open();
    fillBot(db, A, 80);
    const { report } = await prune(db, { minDbBytes: 1e12 });
    expect(report).toMatchObject({ ran: false, skipped: "small" });
    expect(readStream(db, A)!.tail).toBe(0);
    expect(db.prepare("SELECT 1 FROM meta WHERE key LIKE 'compaction.%'").get()).toBeUndefined();
  });

  it("is not done on a schema whose bodies may be differences", async () => {
    const { db } = open();
    fillBot(db, A, 80);
    db.prepare("UPDATE meta SET value = '15' WHERE key = 'schemaVersion'").run();
    const { report } = await prune(db);
    expect(report).toMatchObject({ ran: false, skipped: "schema" });
    expect(readStream(db, A)!.tail).toBe(0);
    expect(runStartupVacuum(db, SMALL)).toMatchObject({ vacuum: null });
  });

  it("openServerStore does not prune and does not VACUUM while the prune is still to do, and opens at once", async () => {
    const { dir, db } = open();
    fillBot(db, A, 400);
    db.exec("DROP TABLE slot_results");
    db.prepare("UPDATE meta SET value = '13' WHERE key = 'schemaVersion'").run(); // one migration (v14) to apply
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const free = Number(db.pragma("freelist_count"));
    db.close();
    const started = performance.now();
    const store = await openServerStore(dir, { compaction: SMALL });
    try {
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(store.migrated).toEqual([14]);
      expect(store.meta(PRUNED_KEY)).toBeUndefined();
      expect(store.meta(VACUUMED_KEY)).toBeUndefined();
      const reader = store.openReader();
      try {
        expect(readStream(reader, A)).toMatchObject({ tail: 0, head: 400 });
        expect(Number(reader.pragma("auto_vacuum"))).toBe(0);
        expect(Number(reader.pragma("freelist_count"))).toBe(free);
      } finally { reader.close(); }
    } finally {
      await store.close();
    }
  });

  it("openServerStore VACUUMs once the prune is done, before the pre-migration backup, and a fresh file is left alone", async () => {
    const { dir, db } = open();
    fillBot(db, A, 400);
    await prune(db, { keepEntries: 10 });
    db.exec("DROP TABLE slot_results");
    db.prepare("UPDATE meta SET value = '13' WHERE key = 'schemaVersion'").run();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    const store = await openServerStore(dir, { compaction: SMALL });
    try {
      expect(store.migrated).toEqual([14]);
      expect(store.meta(VACUUMED_KEY)).toBeDefined();
      const reader = store.openReader();
      try {
        expect(Number(reader.pragma("auto_vacuum"))).toBe(2);
        expect(Number(reader.pragma("freelist_count"))).toBe(0);
      } finally { reader.close(); }
      expect(existsSync(join(dir, "backups"))).toBe(true);
    } finally {
      await store.close();
    }
    const fresh = mkdtempSync(join(tmpdir(), "botling-compact-fresh-"));
    dirs.push(fresh);
    const young = await openServerStore(fresh, { compaction: SMALL });
    expect(young.meta(PRUNED_KEY)).toBeUndefined();
    await young.close();
  });
});

describe("botlingd: the prune runs after the start, then the next start VACUUMs", () => {
  it("starts with the file as it was, prunes in the background, and the following start compacts it", async () => {
    const root = testRoot("compaction");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const options = (logs: string[], compaction: BotlingdOptions["compaction"]) => ({
      env: botlingdEnv(dataDir, { BOTLING_SERVER_PORT: "off", BOTLING_SERVER_BACKUP_CHECK_MS: "0" }),
      outDir: join(desktop, "out"),
      log: (text: string) => logs.push(text),
      compaction,
    });
    // A server.db that has seen a server: make it, then give a bot stream a long history.
    const made = await Botlingd.start(options([], false));
    const main = made.store.meta("ids.main")!;
    await made.stop();
    const stream = `bot:${main}` as StreamId;
    const seeded = await openServerStore(dataDir, { compaction: false });
    await seeded.submit((db) => {
      ensureStream(db, stream, "s1");
      for (let i = 0; i < 300; i++) appendEntries(db, stream, [line(main, `l${i % 5}`, `${BIG}${i}`, i < 5 ? "message.added" : "message.updated")]);
    });
    const headBefore = await seeded.submit((db) => readStream(db, stream)!.head);
    await seeded.close();

    const logs: string[] = [];
    const daemon = await Botlingd.start(options(logs, { ...SMALL, delayMs: 400, batchEntries: 40 }));
    let stopped = false;
    try {
      // The start returned with nothing pruned yet; the prune follows by itself.
      expect(daemon.store.meta(PRUNED_KEY)).toBeUndefined();
      expect(logs.some((text) => text.includes("started:"))).toBe(true);
      await until(() => daemon.store.meta(PRUNED_KEY) !== undefined, { timeout: 30_000, what: "the background prune" });
      const reader = daemon.store.openReader();
      try {
        const row = readStream(reader, stream)!;
        expect(row.head).toBeGreaterThanOrEqual(headBefore);
        expect(row.head - row.tail).toBeLessThanOrEqual(40);
        expect(verifyStream(reader, stream).ok).toBe(true);
      } finally { reader.close(); }
      expect(logs.some((text) => /compaction: pruned \d+ streams/.test(text))).toBe(true);
      await daemon.stop();
      stopped = true;
    } finally {
      if (!stopped) await daemon.stop();
    }

    const logs2: string[] = [];
    const again = await Botlingd.start(options(logs2, { ...SMALL, delayMs: 60_000 }));
    try {
      expect(again.store.meta(VACUUMED_KEY)).toBeDefined();
      expect(logs2.some((text) => /compaction: VACUUM took/.test(text))).toBe(true);
    } finally {
      await again.stop();
    }
  }, 120_000);
});
