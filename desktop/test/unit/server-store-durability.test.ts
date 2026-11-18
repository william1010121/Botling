// D75 (protocol v1 §7.2 as narrowed): server.db commits with synchronous = NORMAL, and a batch that wrote a durable
// table is flushed (one synchronous = FULL commit) before its promises settle; the boot check at open says when the
// previous run may have lost its unflushed commits. The model is spec/models/store (spec/tests/store.spec.test.ts
// replays it against the real store with simulated power losses); these are the guards one by one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOOT_KEY, DURABLE_TABLES, durabilityGate, lostTail, migrate, OPEN_KEY, openServerStore, openWriterDb, StoreCommitError, Writer,
  type BatchInfo, type Db, type ServerStore,
} from "../../src/server/store";
import { openDb } from "../../src/server/store/sqlite";

const dirs: string[] = [];
const stores: ServerStore[] = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "botling-durable-")); dirs.push(dir); return dir; };
async function open(dir: string, options: Parameters<typeof openServerStore>[1] = {}): Promise<ServerStore> {
  const store = await openServerStore(dir, { compaction: false, ...options });
  stores.push(store);
  return store;
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const entry = (seq: number) => (db: Db) => {
  db.prepare("INSERT INTO entries (stream, seq, hlc, kind, body, slot, hash) VALUES ('bot:a', ?, '0', 'test', 'x', NULL, 'h')").run(seq);
};
const slot = (n: number) => (db: Db) => {
  db.prepare("INSERT INTO slots (origin, originEpoch, target, next) VALUES ('fe', 'e', 'bot:a', ?) ON CONFLICT (origin, originEpoch, target) DO UPDATE SET next = excluded.next").run(n);
};
const row = (stream: string, key: string) => (db: Db) => {
  db.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, 1, '{}', 0) ON CONFLICT (stream, key) DO UPDATE SET rev = rev + 1").run(stream, key);
};
const metaOf = (dir: string, key: string) => {
  const db = openDb(join(dir, "server.db"), { readOnly: true });
  try { return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value; } finally { db.close(); }
};

describe("durability gate (D75)", () => {
  it("flushes a batch that wrote a durable table before it settles, and only such a batch", async () => {
    const batches: BatchInfo[] = [];
    const store = await open(tempDir(), { onBatch: (info) => batches.push(info) });
    await store.submit(entry(1));
    await store.submit(slot(1));
    await store.submit(entry(2)); // the mark of the batch before is not carried over
    expect(batches.map((b) => b.durable)).toEqual([false, true, false]);
    expect(batches[1]!.flushMs).toBeGreaterThan(0);
    expect(batches[0]!.flushMs).toBe(0);
  });

  it("an engine event riding in a batch with a durable write is flushed with it", async () => {
    const batches: BatchInfo[] = [];
    const store = await open(tempDir(), { onBatch: (info) => batches.push(info) });
    await Promise.all([store.submit(entry(1)), store.submit(slot(1)), store.submit(entry(2))]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ size: 3, durable: true });
  });

  it("marks every table of DURABLE_TABLES, and the srv: rows but not a bot's rows", () => {
    const dir = tempDir();
    const db = openWriterDb(join(dir, "server.db"));
    try {
      migrate(db); // the schema of the released migrations
      const gate = durabilityGate(db);
      const triggers = new Set(db.prepare("SELECT name FROM sqlite_temp_master WHERE type = 'trigger'").all().map((r) => String(r.name)));
      for (const table of DURABLE_TABLES) for (const op of ["insert", "update", "delete"]) expect(triggers.has(`durable_${table}_${op}`), `${table} ${op}`).toBe(true);
      const marks = (run: (db: Db) => void) => { gate.clear(); db.exec("BEGIN"); run(db); db.exec("ROLLBACK"); return gate.marked(); };
      expect(marks(row("srv:abc", "plugin:x"))).toBe(true);
      expect(marks(row("chat:alpha", "m1"))).toBe(false);
      expect(marks(entry(1))).toBe(false);
      expect(marks(slot(1))).toBe(true);
      expect(marks((tx) => { tx.prepare("INSERT INTO meta (key, value) VALUES ('k', 'v')").run(); })).toBe(true);
    } finally {
      db.close();
    }
  });

  it("the flush is a FULL commit that leaves the connection on NORMAL", () => {
    const dir = tempDir();
    const db = openWriterDb(join(dir, "server.db"));
    try {
      db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID");
      const execs: string[] = [];
      const spy: Db = Object.assign(Object.create(db) as Db, { exec: (sql: string) => { execs.push(sql); db.exec(sql); } });
      const gate = durabilityGate(spy);
      execs.length = 0;
      gate.flush();
      expect(execs).toEqual(["PRAGMA synchronous = FULL", "BEGIN IMMEDIATE", "COMMIT", "PRAGMA synchronous = NORMAL"]);
      expect(Number(db.pragma("synchronous"))).toBe(1);
      expect(db.prepare("SELECT value FROM meta WHERE key = 'store.synced'").get()?.value).toMatch(/:1$/);
      expect(gate.flushes).toBe(1);
      expect(gate.marked()).toBe(false);
    } finally {
      db.close();
    }
  });

  it("a flush that fails rejects every command of the batch (no acknowledgement without the flush)", async () => {
    const dir = tempDir();
    const db = openWriterDb(join(dir, "server.db"));
    try {
      db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID; CREATE TABLE slots (n INTEGER)");
      const real = durabilityGate(db);
      const gate = { clear: () => real.clear(), marked: () => real.marked(), flushes: 0, flush: () => { throw new Error("EIO"); } };
      const writer = new Writer(db, { durability: gate });
      const results = await Promise.allSettled([
        writer.submit((tx) => { tx.prepare("INSERT INTO slots VALUES (1)").run(); }),
        writer.submit(() => "event"),
      ]);
      expect(results.every((r) => r.status === "rejected" && r.reason instanceof StoreCommitError)).toBe(true);
      // An unmarked batch still settles without a flush.
      await expect(writer.submit(() => "ok")).resolves.toBe("ok");
      await writer.close();
    } finally {
      db.close();
    }
  });
});

describe("boot check (D75)", () => {
  it("lostTail: only an unclosed run from another (or an unknown) boot", () => {
    expect(lostTail({ open: undefined, boot: undefined }, "b1")).toBe(false); // a file from before D75
    expect(lostTail({ open: "0", boot: "b0" }, "b1")).toBe(false); // closed cleanly
    expect(lostTail({ open: "1", boot: "b1" }, "b1")).toBe(false); // the process alone crashed
    expect(lostTail({ open: "1", boot: "b0" }, "b1")).toBe(true);
    expect(lostTail({ open: "1", boot: "" }, "b1")).toBe(true);
    expect(lostTail({ open: "1", boot: "b1" }, null)).toBe(true);
  });

  it("marks the store open while it runs and closed after a clean close, both flushed", async () => {
    const dir = tempDir();
    const store = await open(dir, { bootId: "b0" });
    expect(metaOf(dir, OPEN_KEY)).toBe("1");
    expect(metaOf(dir, BOOT_KEY)).toBe("b0");
    await store.close();
    expect(metaOf(dir, OPEN_KEY)).toBe("0");
  });

  it("runs onLostTail inside the open, before anything is served, only after an unclosed run and a new boot", async () => {
    const dir = tempDir();
    await (await open(dir, { bootId: "b0" })).close();
    const calls: string[] = [];
    const onLostTail = (db: Db) => { calls.push(String(db.inTransaction)); db.prepare("INSERT INTO meta (key, value) VALUES ('lost', 'yes')").run(); };
    // Clean close, then a reboot: nothing lost.
    let store = await open(dir, { bootId: "b1", onLostTail });
    expect(store.lostTail).toBe(false);
    // The run "ends" without its close (the mark stays "1"): same boot → nothing lost (a process crash).
    const raw = () => { const db = openDb(join(dir, "server.db")); db.prepare("UPDATE meta SET value = '1' WHERE key = ?").run(OPEN_KEY); db.close(); };
    await store.close(); stores.splice(stores.indexOf(store), 1);
    raw();
    store = await open(dir, { bootId: "b1", onLostTail });
    expect(store.lostTail).toBe(false);
    await store.close(); stores.splice(stores.indexOf(store), 1);
    raw();
    store = await open(dir, { bootId: "b2", onLostTail });
    expect(store.lostTail).toBe(true);
    expect(calls).toEqual(["true"]);
    expect(store.meta("lost")).toBe("yes");
    expect(metaOf(dir, BOOT_KEY)).toBe("b2");
  });
});
