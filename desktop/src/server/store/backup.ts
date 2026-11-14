// Online backup of server.db (protocol v1 §7.6): daily and before every schema migration into <data>/backups/,
// keeping 7 daily and 3 pre-migration copies. The copy is read from its own read connection in one step, so it is the
// state of one committed moment (never a transaction in progress) and the writer keeps committing meanwhile.
// The file appears under its final name only once complete and flushed.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { openReaderDb } from "./connection";
import { backupDb, openDb } from "./sqlite";

export type BackupKind = "daily" | "pre-migration" | "manual";

export const KEEP: Record<BackupKind, number> = { daily: 7, "pre-migration": 3, manual: Infinity };

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Copies the committed state of the database `file` into `dest` (atomically replaced). Returns `dest`. */
export async function backupFile(file: string, dest: string): Promise<string> {
  mkdirSync(dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;
  rmSync(partial, { force: true });
  const source = openReaderDb(file);
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

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); // 20261114T120000Z
}

/** `<data>/backups/server-<kind>-<stamp>.db`, then the oldest of that kind beyond its keep count are deleted. */
export async function takeBackup(file: string, backupsDir: string, kind: BackupKind, now = new Date()): Promise<string> {
  let dest = join(backupsDir, `server-${kind}-${stamp(now)}.db`);
  for (let n = 2; existsSync(dest); n++) dest = join(backupsDir, `server-${kind}-${stamp(now)}-${n}.db`);
  await backupFile(file, dest);
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
