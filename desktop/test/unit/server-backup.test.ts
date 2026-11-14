// Backup metadata, restore and daily backups (M1 step 12), in process on temp folders:
// - a backup copy carries when it was taken (meta.backupAt, the moment before the copy), not a file time;
// - restore: integrity, schema and "is a server backup" checks before anything is touched; the replaced file kept;
//   every own stream a new logId listing the old one with the kept seq; restoredTo from backupAt, else the name's
//   stamp, else the file time; backupAt not left in the live file; restoredAt / restoredFrom written;
// - daily backups: due when there is none or the newest is a day old; one at a time; stop waits for it; keep 7;
// - the Doctor notes: no backup, an old backup, an external disk, a restore.
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StreamId } from "../../src/protocol";
import { backupCheckMs, DailyBackups, dailyBackupDue, DAY_MS } from "../../src/server/backup-schedule";
import { appendEntries, ensureStream, listRetired, readStream } from "../../src/server/log";
import { serverNotes } from "../../src/server/notes";
import { inspectBackup, RestoreError, restoreBackup } from "../../src/server/restore";
import { LATEST_SCHEMA_VERSION, listBackups, openReaderDb, openServerStore, stampTime, takeBackup, type ServerStore } from "../../src/server/store";

const dirs: string[] = [];
const stores: ServerStore[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "botling-backup-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BOT = "bot:b1" as StreamId;
async function storeWith(lines: number, dir = tempDir()): Promise<ServerStore> {
  const store = await openServerStore(dir);
  stores.push(store);
  await store.submit((db) => {
    ensureStream(db, BOT);
    appendEntries(db, BOT, Array.from({ length: lines }, (_, i) => ({ kind: "message.added", body: { botId: "b1", message: { id: `m${i}`, role: "user", text: `line ${i}`, time: new Date(0).toISOString() } } })));
  });
  return store;
}
const headOf = (file: string) => {
  const db = openReaderDb(file);
  try { return readStream(db, BOT)!.head; } finally { db.close(); }
};
const notesOf = (dir: string, now?: number) => {
  const db = openReaderDb(join(dir, "server.db"));
  try { return serverNotes(dir, db, now); } finally { db.close(); }
};
const metaOf = (file: string, key: string) => {
  const db = openReaderDb(file);
  try { return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value; } finally { db.close(); }
};

describe("backup metadata", () => {
  it("a copy says when it was taken (before the copy began); the live file has no backupAt", async () => {
    const store = await storeWith(3);
    const at = new Date(Date.UTC(2026, 10, 14, 8, 30, 15, 250));
    const file = await takeBackup(store.file, store.backupsDir, "manual", at);
    expect(Number(metaOf(file, "backupAt"))).toBe(at.getTime());
    expect(metaOf(store.file, "backupAt")).toBeUndefined();
    expect(stampTime(file)).toBe(Date.UTC(2026, 10, 14, 8, 30, 15));
    expect(stampTime("/x/server-daily-20260101T000000Z-3.db")).toBe(Date.UTC(2026, 0, 1));
    expect(stampTime("/x/copy.db")).toBeNull();
    expect(inspectBackup(file)).toMatchObject({ takenAt: at.getTime(), from: "metadata", schema: LATEST_SCHEMA_VERSION });
  });
});

describe("restore", () => {
  it("puts the backup back: new logIds listing the kept seq, restoredTo from the copy, the replaced file kept", async () => {
    const dir = tempDir();
    const store = await storeWith(4, dir);
    const before = (() => { const db = store.openReader(); try { return readStream(db, BOT)!; } finally { db.close(); } })();
    const backup = await takeBackup(store.file, store.backupsDir, "manual", new Date(Date.UTC(2026, 0, 2, 3, 4, 5)));
    await store.submit((db) => { appendEntries(db, BOT, [{ kind: "message.added", body: { botId: "b1", message: { id: "late", role: "user", text: "after the backup", time: new Date(0).toISOString() } } }]); });
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const result = await restoreBackup(dir, backup, () => 1_800_000_000_000);
    expect(result).toMatchObject({ restoredTo: Date.UTC(2026, 0, 2, 3, 4, 5), restoredToFrom: "metadata", streams: expect.any(Number) });
    expect(result.streams).toBeGreaterThanOrEqual(1);
    expect(result.keptAs && existsSync(result.keptAs)).toBeTruthy();
    const db = openReaderDb(join(dir, "server.db"));
    try {
      const row = readStream(db, BOT)!;
      expect(row.logId).not.toBe(before.logId);
      expect(row.head).toBe(4); // the line after the backup is gone; seq numbering continues from the kept head
      expect(listRetired(db, BOT)).toEqual([{ logId: before.logId, keptSeq: 4, reason: "restored" }]);
      const meta = (key: string) => db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
      expect(meta("restoredTo")).toBe(String(Date.UTC(2026, 0, 2, 3, 4, 5)));
      expect(meta("restoredAt")).toBe("1800000000000");
      expect(meta("restoredFrom")).toBe(backup.split("/").pop());
      expect(meta("backupAt")).toBeUndefined();
    } finally {
      db.close();
    }
    // The kept file still has the lost line: a restore can be undone.
    expect(headOf(result.keptAs!)).toBe(5);
    // The Doctor note says so.
    expect(notesOf(dir).find((note) => note.id === "restored")?.text).toMatch(/restored on 2027-01-15T08:00:00Z to 2026-01-02T03:04:05Z from server-manual-/);
  });

  it("an old copy without backupAt: the time in its name, else its file time", async () => {
    const store = await storeWith(1);
    const named = await takeBackup(store.file, store.backupsDir, "daily", new Date(Date.UTC(2026, 4, 6, 7, 8, 9)));
    const db = (await import("../../src/server/store/sqlite")).openDb(named);
    db.prepare("DELETE FROM meta WHERE key = 'backupAt'").run();
    db.close();
    expect(inspectBackup(named)).toMatchObject({ takenAt: Date.UTC(2026, 4, 6, 7, 8, 9), from: "name" });
    const plain = join(tempDir(), "copy.db");
    copyFileSync(named, plain);
    utimesSync(plain, new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2025, 0, 1)));
    expect(inspectBackup(plain)).toMatchObject({ takenAt: Date.UTC(2025, 0, 1), from: "file time" });
  });

  it("refuses a missing, damaged, foreign or newer-schema file before touching server.db", async () => {
    const dir = tempDir();
    const store = await storeWith(2, dir);
    const backup = await takeBackup(store.file, store.backupsDir, "manual");
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const kept = readdirSync(join(dir, "backups")).length;

    await expect(restoreBackup(dir, join(dir, "nope.db"))).rejects.toBeInstanceOf(RestoreError);
    const damaged = join(dir, "damaged.db");
    writeFileSync(damaged, Buffer.alloc(8192, 7));
    await expect(restoreBackup(dir, damaged)).rejects.toThrow();
    const foreign = join(dir, "foreign.db");
    const { openDb } = await import("../../src/server/store/sqlite");
    const other = openDb(foreign);
    other.exec("CREATE TABLE t (x)");
    other.close();
    await expect(restoreBackup(dir, foreign)).rejects.toThrow(/not a Botling server backup/);
    const newer = join(dir, "newer.db");
    copyFileSync(backup, newer);
    const nd = openDb(newer);
    nd.prepare("UPDATE meta SET value = ? WHERE key = 'schemaVersion'").run(String(LATEST_SCHEMA_VERSION + 1));
    nd.close();
    await expect(restoreBackup(dir, newer)).rejects.toThrow(/newer botlingd/);
    // Nothing was replaced: no new kept copy, the stream still has its logId and both lines.
    expect(readdirSync(join(dir, "backups")).length).toBe(kept);
    expect(headOf(join(dir, "server.db"))).toBe(2);
  });
});

describe("daily backups", () => {
  it("due when there is none or the newest is a day old", async () => {
    const store = await storeWith(1);
    const now = Date.UTC(2026, 10, 14, 12);
    expect(dailyBackupDue(store.backupsDir, now)).toBe(true);
    await takeBackup(store.file, store.backupsDir, "daily", new Date(now - DAY_MS + 60_000));
    expect(dailyBackupDue(store.backupsDir, now)).toBe(false);
    expect(dailyBackupDue(store.backupsDir, now + 60_000)).toBe(true);
    expect(backupCheckMs({})).toEqual({ firstMs: 5 * 60_000, everyMs: 60 * 60_000 });
    expect(backupCheckMs({ BOTLING_SERVER_BACKUP_CHECK_MS: "250" })).toEqual({ firstMs: 250, everyMs: 250 });
    expect(backupCheckMs({ BOTLING_SERVER_BACKUP_CHECK_MS: "0" })).toBeNull();
  });

  it("takes one when due, one at a time, keeps 7, and stop waits for one under way", async () => {
    const store = await storeWith(1);
    let day = Date.UTC(2026, 0, 1);
    let takes = 0;
    const lines: string[] = [];
    const daily = new DailyBackups({
      backupsDir: store.backupsDir, log: (line) => lines.push(line), now: () => day, firstMs: 3_600_000,
      take: async () => { takes++; return takeBackup(store.file, store.backupsDir, "daily", new Date(day)); },
    });
    const a = daily.check();
    expect(daily.check()).toBe(a); // one at a time
    await a;
    await daily.check(); // not due again the same day
    expect(takes).toBe(1);
    for (let i = 0; i < 9; i++) { day += DAY_MS; await daily.check(); }
    expect(takes).toBe(10);
    expect(listBackups(store.backupsDir, "daily")).toHaveLength(7);
    day += DAY_MS;
    const running = daily.check();
    await daily.stop();
    await running;
    expect(takes).toBe(11);
    await daily.check(); // stopped: nothing more
    expect(takes).toBe(11);
    expect(lines.filter((line) => line.startsWith("daily backup: "))).toHaveLength(11);
  });

  it("a failing backup is logged and does not stop the schedule", async () => {
    const dir = tempDir();
    const lines: string[] = [];
    const daily = new DailyBackups({ backupsDir: join(dir, "backups"), log: (line) => lines.push(line), take: async () => { throw new Error("disk full"); } });
    await daily.check();
    expect(lines).toEqual(["daily backup failed: disk full"]);
  });
});

describe("Doctor notes", () => {
  it("no backup, an old backup, an external disk", async () => {
    const store = await storeWith(1);
    const now = Date.UTC(2026, 10, 14);
    expect(serverNotes(store.dataDir, null, now, "linux").map((note) => note.id)).toEqual(["no-backup"]);
    await takeBackup(store.file, store.backupsDir, "manual", new Date(now - 3 * DAY_MS));
    expect(serverNotes(store.dataDir, null, now, "linux")).toEqual([expect.objectContaining({ id: "old-backup", text: expect.stringMatching(/3 days old/) })]);
    await takeBackup(store.file, store.backupsDir, "daily", new Date(now - 3_600_000));
    expect(notesOf(store.dataDir, now).filter((note) => note.id !== "external-disk")).toEqual([]);
    expect(serverNotes("/Volumes/Some Disk/botling", null, now, "darwin").map((note) => note.id)).toEqual(["external-disk", "no-backup"]);
  });
});
