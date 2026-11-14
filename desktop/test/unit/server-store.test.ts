// Botling 3 server.db (src/server/store): the node:sqlite wrapper, settings, schema and migrations, savepoint isolation,
// and online backup. The writer's timing rules are in server-store-writer.test.ts, the SIGKILL test in
// server-store-crash.test.ts.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  externalDiskNote, LATEST_SCHEMA_VERSION, listBackups, MIGRATIONS, openReaderDb, openServerStore, openWriterDb,
  schemaVersion, SchemaTooNewError, StoreCommitError, type Migration, type ServerStore,
} from "../../src/server/store";
import { openDb, sqliteVersion } from "../../src/server/store/sqlite";

const dirs: string[] = [];
const stores: ServerStore[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "botling-store-"));
  dirs.push(dir);
  return dir;
}
async function open(dir = tempDir(), options: Parameters<typeof openServerStore>[1] = {}): Promise<ServerStore> {
  const store = await openServerStore(dir, options);
  stores.push(store);
  return store;
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const insertEntry = (stream: string, seq: number, body = "x") => (db: import("../../src/server/store").Db) =>
  db.prepare("INSERT INTO entries (stream, seq, hlc, kind, body, slot, hash) VALUES (?, ?, '0', 'test', ?, NULL, 'h')").run(stream, seq, body);
const entryCount = (store: ServerStore, stream?: string) => {
  const reader = store.openReader();
  try {
    const row = stream
      ? reader.prepare("SELECT count(*) AS n FROM entries WHERE stream = ?").get(stream)
      : reader.prepare("SELECT count(*) AS n FROM entries").get();
    return Number(row!.n);
  } finally {
    reader.close();
  }
};

describe("node:sqlite wrapper (risk 7)", () => {
  it("is the only module under src/ that imports node:sqlite for the server", () => {
    const root = join(__dirname, "../../src/server");
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && /from\s+["']node:sqlite["']|require\(["']node:sqlite["']\)/.test(readFileSync(path, "utf8"))) importers.push(relative(root, path));
      }
    };
    walk(root);
    expect(importers).toEqual(["store/sqlite.ts"]);
  });

  it("runs statements, caches prepared ones and reports transactions", () => {
    const db = openDb(":memory:");
    try {
      db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)");
      expect(db.prepare("INSERT INTO t (b) VALUES (?)").run("one")).toEqual({ changes: 1, lastInsertRowid: 1 });
      expect(db.prepare("INSERT INTO t (b) VALUES (?)")).toBe(db.prepare("INSERT INTO t (b) VALUES (?)"));
      expect(db.prepare("SELECT b FROM t WHERE a = ?").get(1)).toEqual({ b: "one" });
      expect(db.inTransaction).toBe(false);
      db.exec("BEGIN");
      expect(db.inTransaction).toBe(true);
      db.exec("ROLLBACK");
      expect(db.isOpen).toBe(true);
    } finally {
      db.close();
    }
    expect(db.isOpen).toBe(false);
    expect(sqliteVersion()).toMatch(/^3\.\d+\.\d+$/);
  });
});

describe("settings (v1 §7.2)", () => {
  it("opens the writer in WAL with synchronous FULL, fullfsync, foreign keys and the journal limit", () => {
    const dir = tempDir();
    const db = openWriterDb(join(dir, "server.db"));
    try {
      expect(db.pragma("journal_mode")).toBe("wal");
      expect(Number(db.pragma("synchronous"))).toBe(2);
      expect(Number(db.pragma("fullfsync"))).toBe(1);
      expect(Number(db.pragma("checkpoint_fullfsync"))).toBe(1);
      expect(Number(db.pragma("foreign_keys"))).toBe(1);
      expect(Number(db.pragma("busy_timeout"))).toBe(5000);
      expect(Number(db.pragma("journal_size_limit"))).toBe(67108864);
    } finally {
      db.close();
    }
  });

  it("gives a Doctor note only for a data folder on an external macOS volume (D43)", () => {
    expect(externalDiskNote("/Volumes/Some Disk/botling", "darwin")).toMatch(/external disk/);
    expect(externalDiskNote(tempDir(), "darwin")).toBeNull();
    expect(externalDiskNote("/Volumes/Some Disk/botling", "linux")).toBeNull();
  });
});

describe("schema and migrations (v1 §7.3)", () => {
  it("creates every table of §7.3 and the meta ids on a fresh data folder", async () => {
    const store = await open();
    expect(store.migrated).toEqual(MIGRATIONS.map((m) => m.version));
    const reader = store.openReader();
    try {
      const tables = reader.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
      expect(tables).toEqual([
        "bots", "cancels", "cards", "chunk_cache", "content", "content_refs", "effects", "entries", "forwardq", "grants",
        "lists", "media_jobs", "messages", "meta", "myorigins", "prefs", "receipts", "retired", "roster", "rows", "slots", "streams",
        "variants",
      ]);
      expect(schemaVersion(reader)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      reader.close();
    }
    expect(store.meta("serverId")).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.meta("dbId")).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.meta("serverId")).not.toBe(store.meta("dbId"));
  });

  it("reopens without migrating again and keeps its ids", async () => {
    const dir = tempDir();
    const first = await openServerStore(dir);
    const serverId = first.meta("serverId");
    await first.close();
    const second = await open(dir);
    expect(second.migrated).toEqual([]);
    expect(second.meta("serverId")).toBe(serverId);
    expect(listBackups(second.backupsDir, "pre-migration")).toEqual([]);
  });

  it("backs up before migrating an existing file, then applies only the new steps", async () => {
    const dir = tempDir();
    const v1 = await openServerStore(dir, { migrations: MIGRATIONS.slice(0, 1) });
    await v1.submit(insertEntry("bot:a", 1, "before"));
    await v1.close();
    const v2: Migration = { version: 2, description: "test column", up: (db) => db.exec("ALTER TABLE bots ADD COLUMN extra TEXT") };
    const store = await open(dir, { migrations: [...MIGRATIONS.slice(0, 1), v2] });
    expect(store.migrated).toEqual([2]);
    expect(store.meta("schemaVersion")).toBe("2");
    const backups = listBackups(store.backupsDir, "pre-migration");
    expect(backups).toHaveLength(1);
    const copy = openDb(backups[0], { readOnly: true });
    try {
      expect(schemaVersion(copy)).toBe(1);
      expect(copy.prepare("SELECT body FROM entries").get()).toEqual({ body: "before" });
    } finally {
      copy.close();
    }
  });

  it("rolls a failing migration back whole and leaves the previous version", async () => {
    const dir = tempDir();
    await (await openServerStore(dir, { migrations: MIGRATIONS.slice(0, 1) })).close();
    const broken: Migration = {
      version: 2, description: "fails half way",
      up: (db) => { db.exec("CREATE TABLE half (a)"); throw new Error("boom"); },
    };
    await expect(openServerStore(dir, { migrations: [...MIGRATIONS.slice(0, 1), broken] })).rejects.toThrow("boom");
    const db = openReaderDb(join(dir, "server.db"));
    try {
      expect(schemaVersion(db)).toBe(1);
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses a file from a newer schema", async () => {
    const dir = tempDir();
    const future: Migration = { version: LATEST_SCHEMA_VERSION + 1, description: "future", up: () => {} };
    await (await openServerStore(dir, { migrations: [...MIGRATIONS, future] })).close();
    await expect(openServerStore(dir)).rejects.toBeInstanceOf(SchemaTooNewError);
  });
});

describe("savepoint per command", () => {
  it("rolls back only the failing command of a batch", async () => {
    const store = await open();
    const batches: number[] = [];
    const results = await Promise.allSettled([
      store.submit((db, ctx) => { batches.push(ctx.batch); insertEntry("s", 1)(db); return "a"; }),
      store.submit((db, ctx) => { batches.push(ctx.batch); insertEntry("s", 2)(db); insertEntry("s", 3)(db); throw new Error("refused"); }),
      store.submit((db, ctx) => { batches.push(ctx.batch); insertEntry("s", 1)(db); return "duplicate key"; }), // PK conflict
      store.submit((db, ctx) => { batches.push(ctx.batch); insertEntry("s", 4)(db); return "d"; }),
    ]);
    expect(new Set(batches).size).toBe(1); // one transaction
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "rejected", "fulfilled"]);
    expect((results[1] as PromiseRejectedResult).reason.message).toBe("refused");
    const reader = store.openReader();
    try {
      expect(reader.prepare("SELECT seq FROM entries ORDER BY seq").all().map((r) => r.seq)).toEqual([1, 4]);
    } finally {
      reader.close();
    }
  });

  it("refuses an asynchronous command without touching the batch", async () => {
    const store = await open();
    const [async, sync] = await Promise.allSettled([
      store.submit((async (db: import("../../src/server/store").Db) => insertEntry("s", 9)(db)) as never),
      store.submit(insertEntry("s", 10)),
    ]);
    expect(async.status).toBe("rejected");
    expect(sync.status).toBe("fulfilled");
    expect(entryCount(store, "s")).toBe(1);
  });

  it("fails the whole batch, keeping nothing, when the transaction cannot commit", async () => {
    const store = await open(tempDir(), { beforeCommit: (batch) => { if (batch === 2) throw new Error("disk full"); } });
    await store.submit(insertEntry("s", 1));
    const second = await Promise.allSettled([store.submit(insertEntry("s", 2)), store.submit(insertEntry("s", 3))]);
    expect(second.every((r) => r.status === "rejected" && r.reason instanceof StoreCommitError)).toBe(true);
    await store.submit(insertEntry("s", 4));
    expect(entryCount(store, "s")).toBe(2);
  });
});

describe("online backup (v1 §7.6)", () => {
  it("copies one committed moment while the writer keeps committing", async () => {
    const store = await open();
    for (let i = 1; i <= 200; i++) store.submit(insertEntry("s", i, "y".repeat(500)));
    await store.writer.idle();
    // Writes keep going during the backup; the copy holds every command acknowledged before it started.
    let next = 201;
    let writing = true;
    const writes = (async () => { while (writing) await store.submit(insertEntry("s", next++)); })();
    const file = await store.backup("manual");
    writing = false;
    await writes;
    expect(existsSync(`${file}.partial`)).toBe(false);
    const copy = openDb(file, { readOnly: true });
    try {
      expect(copy.pragma("integrity_check")).toBe("ok");
      const seqs = copy.prepare("SELECT seq FROM entries ORDER BY seq").all().map((r) => Number(r.seq));
      expect(seqs.length).toBeGreaterThanOrEqual(200);
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1)); // a prefix: no gap, nothing partial
      expect(copy.prepare("SELECT value FROM meta WHERE key = 'serverId'").get()!.value).toBe(store.meta("serverId"));
    } finally {
      copy.close();
    }
    expect(entryCount(store)).toBe(next - 1);
  });

  it("keeps 7 daily backups and deletes the oldest", async () => {
    const store = await open();
    const { takeBackup } = await import("../../src/server/store");
    for (let day = 1; day <= 9; day++) await takeBackup(store.file, store.backupsDir, "daily", new Date(Date.UTC(2026, 0, day)));
    const daily = listBackups(store.backupsDir, "daily").map((path) => path.slice(store.backupsDir.length + 1));
    expect(daily).toEqual([3, 4, 5, 6, 7, 8, 9].map((day) => `server-daily-2026010${day}T000000Z.db`));
    // Copies made in the same second sort after the first one, so pruning still drops the oldest.
    const same = new Date(Date.UTC(2026, 0, 10));
    for (let i = 0; i < 3; i++) await takeBackup(store.file, store.backupsDir, "daily", same);
    expect(listBackups(store.backupsDir, "daily").map((path) => path.slice(store.backupsDir.length + 1)).slice(-4)).toEqual([
      "server-daily-20260109T000000Z.db", "server-daily-20260110T000000Z.db", "server-daily-20260110T000000Z-2.db", "server-daily-20260110T000000Z-3.db",
    ]);
    expect(readdirSync(store.backupsDir).filter((n) => n.endsWith(".partial"))).toEqual([]);
  });

  it("replaces a stale partial file and never leaves one", async () => {
    const store = await open();
    const { backupFile } = await import("../../src/server/store");
    const dest = join(store.dataDir, "copy.db");
    writeFileSync(`${dest}.partial`, "junk");
    await backupFile(store.file, dest);
    expect(existsSync(`${dest}.partial`)).toBe(false);
    const copy = openDb(dest, { readOnly: true });
    try { expect(schemaVersion(copy)).toBe(LATEST_SCHEMA_VERSION); } finally { copy.close(); }
  });
});
