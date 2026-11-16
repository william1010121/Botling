// `botlingd restore <backup>` (M1 step 9, completed in step 12): puts a backup of server.db back while botlingd is
// stopped (the caller holds the data-folder lock), as protocol v1 §7.6 says.
//
// Why only with the server stopped (and not `LogHub.retiredUnder` inside a running botlingd): a running server holds
// state from after the backup in memory — the 2.x core's bots and their stores (DbBotStores read the rows once), turns
// under way in the live channel and the effect worker, slots held ahead of `next`, the content index. Swapping the
// file under them would mix the restored history with that memory, and their next write would bring lost lines back
// or break the hash chain. Stopped, the restore is one cold swap, and the next start's recovery runs on the restored
// file alone (a turn the backup shows as `started` becomes `turn.interrupted`, never runs again). Front ends meanwhile
// see "connecting…", reattach to the new start and get `reset` + `snap`. `botlingd restore --stop` stops a running
// server first.
//
// Steps:
// - the backup must open, pass `integrity_check`, be a server.db, and not be of a newer schema than this build;
// - the current file is first kept as a manual backup (`keptAs`), so a restore can itself be undone;
// - the backup is copied in under the database's name (its -wal / -shm files removed first: they belong to the old file;
//   copied beside it, flushed, then renamed over it);
// - then one transaction: every own stream gets a new logId (`retireOwnStreams(restored)`: front ends get `reset` +
//   `snap` and never use a retired logId again, D50; the srv: stream's new logId is the new `inc`, so a command sent to
//   the old incarnation is answered `cmd.retry`, D49), every own origin counter a new epoch, and the audit in `meta`:
//   `restoredTo` (when the backup was taken: its `backupAt`, else the time in its file name, else its file time),
//   `restoredAt`, `restoredFrom`. The `reset` carries `restoredTo` so the window says "restored to <time>".
// - Slots: receipts and `next` go back with the file. A front end whose items were applied after the backup sends its
//   next items with a `floor` above them → `cmd.skipped` (§11.3), so nothing waits for a slot the owner forgot.
import { randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { retireOwnStreams } from "./log/log-store";
import { BACKUP_AT_KEY, CONVERSATIONS_ONLY_KEY, isConversationsBackup, LATEST_SCHEMA_VERSION, openServerStore, schemaVersion, stampTime, takeBackup } from "./store";
import { openReaderDb } from "./store/connection";

export interface RestoreResult {
  restoredFrom: string;
  /** Where the file it replaced was kept (null: there was none). */
  keptAs: string | null;
  /** When the backup was taken (ms). */
  restoredTo: number;
  /** Where `restoredTo` came from: the backup's own metadata, its file name, or (an old copy) its file time. */
  restoredToFrom: "metadata" | "name" | "file time";
  streams: number;
}

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreError";
  }
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Checks a backup file and says when it was taken. Throws RestoreError when it cannot be restored. */
export function inspectBackup(backup: string): { takenAt: number; from: RestoreResult["restoredToFrom"]; schema: number } {
  if (!existsSync(backup)) throw new RestoreError(`No backup at ${backup}.`);
  const conversationsOnly = (what: string) => new RestoreError(`${what} holds conversations only (the messages and bots of a server too big to copy whole before a migration), not a whole server.db; it cannot be restored.`);
  if (isConversationsBackup(backup)) throw conversationsOnly(backup);
  const check = openReaderDb(backup);
  try {
    // By content too: a conversations-only file renamed to look like a whole backup is still refused.
    if (check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()
      && check.prepare("SELECT 1 FROM meta WHERE key = ?").get(CONVERSATIONS_ONLY_KEY)) throw conversationsOnly(backup);
    const result = String(check.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "");
    if (result !== "ok") throw new RestoreError(`The backup ${backup} is damaged (integrity_check: ${result.slice(0, 200)}).`);
    if (!check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'streams'").get()) throw new RestoreError(`${backup} is not a Botling server backup.`);
    const schema = schemaVersion(check);
    if (schema > LATEST_SCHEMA_VERSION) throw new RestoreError(`${backup} is from a newer botlingd (schema ${schema}; this one knows up to ${LATEST_SCHEMA_VERSION}).`);
    const stored = Number(check.prepare("SELECT value FROM meta WHERE key = ?").get(BACKUP_AT_KEY)?.value ?? NaN);
    if (Number.isSafeInteger(stored) && stored > 0) return { takenAt: stored, from: "metadata", schema };
    const named = stampTime(backup);
    if (named !== null) return { takenAt: named, from: "name", schema };
    return { takenAt: Math.floor(statSync(backup).mtimeMs), from: "file time", schema };
  } finally {
    check.close();
  }
}

export async function restoreBackup(dataDir: string, backup: string, now: () => number = Date.now): Promise<RestoreResult> {
  const { takenAt: restoredTo, from: restoredToFrom } = inspectBackup(backup);
  const file = join(dataDir, "server.db");
  const backupsDir = join(dataDir, "backups");
  const keptAs = existsSync(file) ? await takeBackup(file, backupsDir, "manual") : null;
  for (const suffix of ["-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
  const partial = `${file}.restoring`;
  rmSync(partial, { force: true });
  copyFileSync(backup, partial);
  fsyncPath(partial);
  renameSync(partial, file);
  fsyncPath(dirname(file));
  const store = await openServerStore(dataDir);
  try {
    const streams = await store.submit((db) => {
      const retired = retireOwnStreams(db, "restored");
      for (const row of db.prepare("SELECT target FROM myorigins").all()) {
        db.prepare("UPDATE myorigins SET originEpoch = ?, nextN = 1 WHERE target = ?").run(randomBytes(16).toString("hex"), String(row.target));
      }
      const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
      setMeta.run("restoredTo", String(restoredTo));
      setMeta.run("restoredAt", String(Math.floor(now())));
      setMeta.run("restoredFrom", basename(backup));
      // The live file is no copy: a later backup writes its own time.
      db.prepare("DELETE FROM meta WHERE key = ?").run(BACKUP_AT_KEY);
      return retired.length;
    });
    return { restoredFrom: backup, keptAs, restoredTo, restoredToFrom, streams };
  } finally {
    await store.close();
  }
}
