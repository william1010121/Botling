// Online backup of server.db (protocol v1 §7.6): daily and before every schema migration into <data>/backups/,
// keeping 7 daily and 1 pre-migration copy (a whole server.db is GBs; see PRE_MIGRATION_FULL_COPY_MAX_BYTES). The copy is read from its own read connection in one step, so it is the
// state of one committed moment (never a transaction in progress) and the writer keeps committing meanwhile.
// The file appears under its final name only once complete and flushed.
//
// A copy of server.db carries when it was taken in its own `meta` table (`backupAt`, ms since the epoch: the moment
// before the copy began, so nothing committed after it is in the copy; M1 step 12). `botlingd restore` reads it for
// "history restored to <time>", which a file time cannot be trusted for (a copy or a sync tool changes it).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { openReaderDb } from "./connection";
import { backupDb, openDb, type SqlRow } from "./sqlite";

export type BackupKind = "daily" | "pre-migration" | "manual";

/** The `meta` key of a backup copy that says when it was taken (absent in a live server.db). */
export const BACKUP_AT_KEY = "backupAt";

export const KEEP: Record<BackupKind, number> = { daily: 7, "pre-migration": 1, manual: Infinity };

/**
 * The biggest server.db (with its -wal) that is copied whole before a schema migration: 2 GiB. server.db grows with
 * every state snapshot the log keeps (8.5 GB on the owner's machine on 2026-11-16, 1.3 GB a day before), and a whole
 * copy of that next to the live file fills the disk (the internal one had about 27 GB free). Above the limit the
 * migration is preceded by a conversations-only copy instead (`takeConversationsBackup`, tens of MB): the messages are
 * what cannot be rebuilt; the snapshots in the log can.
 */
export const PRE_MIGRATION_FULL_COPY_MAX_BYTES = 2 * 1024 ** 3;

/** The `meta` key that marks a conversations-only file (never a whole server.db); `restore` refuses such a file. */
export const CONVERSATIONS_ONLY_KEY = "conversationsOnly";
/** The tables a conversations-only backup holds. */
const CONVERSATION_TABLES = ["bots", "messages"] as const;

const CONVERSATIONS_NAME = /^server-[a-z-]+-\d{8}T\d{6}Z-conversations(?:-\d+)?\.db$/;
/** Whether a backup file is a conversations-only copy (by its name `server-<kind>-<stamp>-conversations.db`). */
export const isConversationsBackup = (name: string): boolean => CONVERSATIONS_NAME.test(basename(name));

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Copies the committed state of the database `file` into `dest` (atomically replaced). Returns `dest`. */
export async function backupFile(file: string, dest: string, now: () => number = Date.now): Promise<string> {
  mkdirSync(dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;
  rmSync(partial, { force: true });
  const source = openReaderDb(file);
  const takenAt = Math.floor(now());
  try {
    await backupDb(source, partial);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  } finally {
    source.close();
  }
  // The backup leaves its copy in rollback-journal mode with everything in the main file; make it one durable file.
  const check = openDb(partial);
  try {
    if (check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()) {
      check.prepare(`INSERT INTO meta (key, value) VALUES ('${BACKUP_AT_KEY}', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(String(takenAt));
    }
    const result = String(check.pragma("quick_check"));
    if (result !== "ok") throw new Error(`backup failed its check: ${result}`);
  } finally {
    check.close();
  }
  fsyncPath(partial);
  renameSync(partial, dest);
  fsyncPath(dirname(dest));
  return dest;
}

/** When a backup file was taken, from its name `server-<kind>-<stamp>[-n].db` (null: not such a name). */
export function stampTime(name: string): number | null {
  const match = /^server-[a-z-]+-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-conversations)?(?:-\d+)?\.db$/.exec(basename(name));
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const time = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(time) ? time : null;
}

/** The newest backup of `kind` (by its name), or null. A conversations-only copy is not one: it cannot restore the server. */
export function newestBackup(backupsDir: string, kind: BackupKind): { path: string; at: number | null } | null {
  const all = listBackups(backupsDir, kind).filter((path) => !isConversationsBackup(path));
  const path = all[all.length - 1];
  return path ? { path, at: stampTime(path) } : null;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); // 20261114T120000Z
}

/** `<data>/backups/server-<kind>-<stamp>.db`, then the oldest of that kind beyond its keep count are deleted. */
export async function takeBackup(file: string, backupsDir: string, kind: BackupKind, now = new Date()): Promise<string> {
  let dest = join(backupsDir, `server-${kind}-${stamp(now)}.db`);
  for (let n = 2; existsSync(dest); n++) dest = join(backupsDir, `server-${kind}-${stamp(now)}-${n}.db`);
  await backupFile(file, dest, () => now.getTime());
  prune(backupsDir, kind, basename(dest));
  return dest;
}

/** The size of a database file with its -wal (0 when it does not exist). */
export function serverDbBytes(file: string): number {
  let total = 0;
  for (const path of [file, `${file}-wal`]) {
    try { total += statSync(path).size; } catch { /* absent */ }
  }
  return total;
}

/**
 * The backup before a schema migration: the whole file when it is at most `maxFullBytes` (default
 * PRE_MIGRATION_FULL_COPY_MAX_BYTES), else a conversations-only copy. One pre-migration copy is kept, of either shape.
 */
export async function takePreMigrationBackup(file: string, backupsDir: string, options: { maxFullBytes?: number; now?: Date } = {}): Promise<string> {
  const now = options.now ?? new Date();
  if (serverDbBytes(file) <= (options.maxFullBytes ?? PRE_MIGRATION_FULL_COPY_MAX_BYTES)) return takeBackup(file, backupsDir, "pre-migration", now);
  let dest = join(backupsDir, `server-pre-migration-${stamp(now)}-conversations.db`);
  for (let n = 2; existsSync(dest); n++) dest = join(backupsDir, `server-pre-migration-${stamp(now)}-conversations-${n}.db`);
  await conversationsBackupFile(file, dest, now.getTime());
  prune(backupsDir, "pre-migration", basename(dest));
  return dest;
}

const PAGE = 2_000;

/**
 * Copies the `bots` and `messages` tables of the database `file` into a new, small database `dest` (atomically placed),
 * from one read transaction, so the copy is the state of one committed moment. The file says what it is
 * (`meta.conversationsOnly`, when: `backupAt`, and the source's schema version) and holds no `streams`, so it is not a
 * server.db and `restore` refuses it.
 */
async function conversationsBackupFile(file: string, dest: string, takenAt: number): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;
  rmSync(partial, { force: true });
  const source = openReaderDb(file);
  const target = openDb(partial);
  try {
    source.exec("BEGIN");
    for (const row of source.prepare(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND (name IN (${CONVERSATION_TABLES.map((t) => `'${t}'`).join(", ")}) OR tbl_name IN (${CONVERSATION_TABLES.map((t) => `'${t}'`).join(", ")})) AND name NOT LIKE 'sqlite_%' ORDER BY type DESC`).all()) {
      target.exec(String(row.sql)); // tables first (type 'table' sorts after 'index' descending), then their indexes
    }
    target.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID");
    target.exec("BEGIN");
    const copy = (table: string, rows: SqlRow[]): void => {
      for (const row of rows) {
        const cols = Object.keys(row);
        target.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c]));
      }
    };
    copy("bots", source.prepare("SELECT * FROM bots").all());
    let last: [string, string] | null = null;
    for (;;) {
      const rows = last
        ? source.prepare("SELECT * FROM messages WHERE (botId, msgId) > (?, ?) ORDER BY botId, msgId LIMIT ?").all(last[0], last[1], PAGE)
        : source.prepare("SELECT * FROM messages ORDER BY botId, msgId LIMIT ?").all(PAGE);
      if (!rows.length) break;
      copy("messages", rows);
      last = [String(rows[rows.length - 1].botId), String(rows[rows.length - 1].msgId)];
    }
    const meta = target.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    meta.run(BACKUP_AT_KEY, String(Math.floor(takenAt)));
    meta.run(CONVERSATIONS_ONLY_KEY, "1");
    meta.run("sourceSchemaVersion", String(source.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()?.value ?? 0));
    target.exec("COMMIT");
    const result = String(target.pragma("quick_check"));
    if (result !== "ok") throw new Error(`conversations backup failed its check: ${result}`);
  } catch (error) {
    target.close();
    source.close();
    rmSync(partial, { force: true });
    throw error;
  }
  target.close();
  source.close();
  fsyncPath(partial);
  renameSync(partial, dest);
  fsyncPath(dirname(dest));
}

export function listBackups(backupsDir: string, kind: BackupKind): string[] {
  if (!existsSync(backupsDir)) return [];
  const prefix = `server-${kind}-`;
  return readdirSync(backupsDir).filter((name) => name.startsWith(prefix) && name.endsWith(".db"))
    // Oldest first: by stamp, then by the -2, -3 … suffix of copies made in the same second.
    .map((name) => ({ name, key: name.slice(0, -3).split("-").map((part) => part.padStart(20, "0")).join("-") }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ name }) => name)
    .map((name) => join(backupsDir, name));
}

function prune(backupsDir: string, kind: BackupKind, keepName: string): void {
  const all = listBackups(backupsDir, kind);
  const excess = all.length - KEEP[kind];
  for (const path of all.slice(0, Math.max(0, excess))) if (basename(path) !== keepName) rmSync(path, { force: true });
}
