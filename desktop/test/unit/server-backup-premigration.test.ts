// The backup before a schema migration (protocol v1 §7.6), kept to one copy and bounded in size:
// - a server.db up to PRE_MIGRATION_FULL_COPY_MAX_BYTES (2 GiB, wal included) is copied whole, as before;
// - a bigger one gets a small, separate "conversations" file instead (`…-conversations.db`: the `messages` and `bots`
//   tables, a `meta` that says what it is), never a second multi-GB copy;
// - only 1 pre-migration copy is kept, whichever shape it has;
// - a conversations file is not a server.db: `botlingd restore` refuses it before touching anything, and it is not
//   reported as "the newest backup" (it cannot restore the server).
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StreamId } from "../../src/protocol";
import { appendEntries, ensureStream } from "../../src/server/log";
import { newestAnyBackup } from "../../src/server/notes";
import { RestoreError, restoreBackup } from "../../src/server/restore";
import {
  isConversationsBackup, KEEP, listBackups, newestBackup, openReaderDb, openServerStore, PRE_MIGRATION_FULL_COPY_MAX_BYTES, serverDbBytes,
  stampTime, takeBackup, takePreMigrationBackup, type ServerStore,
} from "../../src/server/store";
import { MIGRATIONS, type Migration } from "../../src/server/store/schema";

const dirs: string[] = [];
const stores: ServerStore[] = [];
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), "botling-premig-")); dirs.push(dir); return dir; };
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BOT = "bot:b1" as StreamId;
async function storeWithConversation(): Promise<ServerStore> {
  const store = await openServerStore(tempDir());
  stores.push(store);
  await store.submit((db) => {
    ensureStream(db, BOT);
    appendEntries(db, BOT, [{ kind: "message.added", body: { botId: "b1", message: { id: "m1", role: "user", text: "hello", time: new Date(0).toISOString() } } }]);
    db.prepare("INSERT OR REPLACE INTO bots (botId, head, unread, model) VALUES ('b1', 7, 2, 'sonnet')").run();
    db.prepare("INSERT OR REPLACE INTO messages (botId, msgId, rev, seq, body) VALUES ('b1', 'm1', 3, 5, '{\"text\":\"hello\"}')").run();
  });
  return store;
}
const tables = (file: string): string[] => {
  const db = openReaderDb(file);
  try { return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => String(row.name)); } finally { db.close(); }
};
const metaOf = (file: string, key: string) => {
  const db = openReaderDb(file);
  try { return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value; } finally { db.close(); }
};

describe("pre-migration backup", () => {
  it("keeps one copy and the limit is 2 GiB", () => {
    expect(KEEP["pre-migration"]).toBe(1);
    expect(PRE_MIGRATION_FULL_COPY_MAX_BYTES).toBe(2 * 1024 ** 3);
  });

  it("at or under the limit: the whole server.db", async () => {
    const store = await storeWithConversation();
    const size = serverDbBytes(store.file);
    const copy = await takePreMigrationBackup(store.file, store.backupsDir, { maxFullBytes: size });
    expect(basename(copy)).toMatch(/^server-pre-migration-\d{8}T\d{6}Z\.db$/);
    expect(isConversationsBackup(copy)).toBe(false);
    expect(tables(copy)).toContain("entries");
    expect(tables(copy)).toContain("streams");
  });

  it("over the limit: a small conversations file with messages and bots, nothing else of the server", async () => {
    const store = await storeWithConversation();
    const before = Date.now();
    const copy = await takePreMigrationBackup(store.file, store.backupsDir, { maxFullBytes: serverDbBytes(store.file) - 1 });
    expect(basename(copy)).toMatch(/^server-pre-migration-\d{8}T\d{6}Z-conversations\.db$/);
    expect(isConversationsBackup(copy)).toBe(true);
    expect(stampTime(copy)).not.toBeNull();
    expect(tables(copy)).toEqual(["bots", "messages", "meta"]);
    const db = openReaderDb(copy);
    try {
      expect(db.prepare("SELECT botId, head, unread, model FROM bots WHERE botId = 'b1'").get()).toEqual({ botId: "b1", head: 7, unread: 2, model: "sonnet" });
      expect(db.prepare("SELECT rev, seq, body FROM messages WHERE botId = 'b1' AND msgId = 'm1'").get()).toEqual({ rev: 3, seq: 5, body: '{"text":"hello"}' });
      expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    } finally { db.close(); }
    expect(metaOf(copy, "conversationsOnly")).toBe("1");
    expect(Number(metaOf(copy, "backupAt"))).toBeGreaterThanOrEqual(before - 1_000);
    expect(Number(metaOf(copy, "sourceSchemaVersion"))).toBeGreaterThan(0);
    expect(existsSync(`${copy}.partial`)).toBe(false);
    expect(statSync(copy).size).toBeLessThan(serverDbBytes(store.file));
  });

  it("a conversations backup holds a consistent copy of every message, in pages", async () => {
    const store = await storeWithConversation();
    await store.submit((db) => {
      const insert = db.prepare("INSERT INTO messages (botId, msgId, rev, seq, body) VALUES (?, ?, 1, ?, ?)");
      for (let i = 0; i < 2_500; i++) insert.run(`b${i % 3}`, `msg-${String(i).padStart(5, "0")}`, i, `text ${i}`);
    });
    const copy = await takePreMigrationBackup(store.file, store.backupsDir, { maxFullBytes: 0 });
    const count = (file: string) => { const db = openReaderDb(file); try { return Number(db.prepare("SELECT count(*) AS n FROM messages").get()?.n); } finally { db.close(); } };
    expect(count(copy)).toBe(count(store.file));
    expect(count(copy)).toBe(2_501);
  });

  it("keeps 1: a newer copy of either shape replaces the older one", async () => {
    const store = await storeWithConversation();
    const at = (n: number) => new Date(Date.UTC(2026, 10, n));
    const full = await takePreMigrationBackup(store.file, store.backupsDir, { now: at(1) });
    const conv = await takePreMigrationBackup(store.file, store.backupsDir, { now: at(2), maxFullBytes: 0 });
    expect(listBackups(store.backupsDir, "pre-migration")).toEqual([conv]);
    expect(existsSync(full)).toBe(false);
    const full2 = await takePreMigrationBackup(store.file, store.backupsDir, { now: at(3) });
    expect(listBackups(store.backupsDir, "pre-migration")).toEqual([full2]);
    expect(readdirSync(store.backupsDir)).toEqual([basename(full2)]);
    // Manual and daily copies are not pre-migration copies and are left alone.
    const manual = await takeBackup(store.file, store.backupsDir, "manual", at(4));
    await takePreMigrationBackup(store.file, store.backupsDir, { now: at(5), maxFullBytes: 0 });
    expect(existsSync(manual)).toBe(true);
  });

  it("counts the -wal file in the size", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "x.db"), Buffer.alloc(1000));
    expect(serverDbBytes(join(dir, "x.db"))).toBe(1000);
    writeFileSync(join(dir, "x.db-wal"), Buffer.alloc(234));
    expect(serverDbBytes(join(dir, "x.db"))).toBe(1234);
    expect(serverDbBytes(join(dir, "missing.db"))).toBe(0);
  });

  it("a migration over the limit takes the conversations copy; under it, the whole file", async () => {
    const v2: Migration = { version: 2, description: "test column", up: (db) => db.exec("ALTER TABLE bots ADD COLUMN extra TEXT") };
    for (const [limit, conversations] of [[1, true], [PRE_MIGRATION_FULL_COPY_MAX_BYTES, false]] as const) {
      const dir = tempDir();
      const first = await openServerStore(dir, { migrations: MIGRATIONS.slice(0, 1) });
      await first.close();
      const store = await openServerStore(dir, { migrations: [...MIGRATIONS.slice(0, 1), v2], preMigrationFullCopyMaxBytes: limit });
      stores.push(store);
      const copies = listBackups(store.backupsDir, "pre-migration");
      expect(copies).toHaveLength(1);
      expect(isConversationsBackup(copies[0])).toBe(conversations);
      expect(store.meta("schemaVersion")).toBe("2");
    }
  });

  it("restore refuses a conversations backup before it touches anything", async () => {
    const store = await storeWithConversation();
    const copy = await takePreMigrationBackup(store.file, store.backupsDir, { maxFullBytes: 0 });
    const names = readdirSync(store.backupsDir);
    await expect(restoreBackup(store.dataDir, copy)).rejects.toBeInstanceOf(RestoreError);
    await expect(restoreBackup(store.dataDir, copy)).rejects.toThrow(/conversations only/);
    // Even renamed to look like a full backup (the content says what it is).
    const renamed = join(store.dataDir, "looks-full.db");
    writeFileSync(renamed, (await import("node:fs")).readFileSync(copy));
    await expect(restoreBackup(store.dataDir, renamed)).rejects.toThrow(/conversations only/);
    expect(readdirSync(store.backupsDir)).toEqual(names); // no "kept" manual copy of the live file was made
    const db = openReaderDb(store.file);
    try { expect(db.prepare("SELECT 1 FROM streams LIMIT 1").get()).toBeTruthy(); } finally { db.close(); }
  });

  it("a conversations backup is not 'the newest backup' (it cannot restore the server)", async () => {
    const store = await storeWithConversation();
    const old = await takeBackup(store.file, store.backupsDir, "manual", new Date(Date.UTC(2026, 10, 1)));
    await takePreMigrationBackup(store.file, store.backupsDir, { now: new Date(Date.UTC(2026, 10, 5)), maxFullBytes: 0 });
    expect(newestBackup(store.backupsDir, "pre-migration")).toBeNull();
    expect(newestAnyBackup(store.backupsDir)?.path).toBe(old);
  });
});
