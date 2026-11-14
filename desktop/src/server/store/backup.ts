// Online backup of server.db (protocol v1 §7.6): daily and before every schema migration into <data>/backups/,
// keeping 7 daily and 3 pre-migration copies. The copy is read from its own read connection in one step, so it is the
// state of one committed moment (never a transaction in progress) and the writer keeps committing meanwhile.
// The file appears under its final name only once complete and flushed.
//
// A copy of server.db carries when it was taken in its own `meta` table (`backupAt`, ms since the epoch: the moment
// before the copy began, so nothing committed after it is in the copy; M1 step 12). `botlingd restore` reads it for
// "history restored to <time>", which a file time cannot be trusted for (a copy or a sync tool changes it).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { openReaderDb } from "./connection";
import { backupDb, openDb } from "./sqlite";

export type BackupKind = "daily" | "pre-migration" | "manual";

/** The `meta` key of a backup copy that says when it was taken (absent in a live server.db). */
export const BACKUP_AT_KEY = "backupAt";

export const KEEP: Record<BackupKind, number> = { daily: 7, "pre-migration": 3, manual: Infinity };

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
  const match = /^server-[a-z-]+-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-\d+)?\.db$/.exec(basename(name));
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const time = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(time) ? time : null;
}

/** The newest backup of `kind` (by its name), or null. */
export function newestBackup(backupsDir: string, kind: BackupKind): { path: string; at: number | null } | null {
  const all = listBackups(backupsDir, kind);
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
