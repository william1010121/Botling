// `botlingd restore <backup>` (M1 step 9, minimal; step 12 completes it end to end): puts a backup of server.db back
// while botlingd is stopped (the caller holds the data-folder lock), as protocol v1 §7.6 says:
// - the backup must open and pass `integrity_check`; the current file is first kept as a manual backup;
// - the backup is copied in under the database's name (its -wal / -shm files removed first: they belong to the old file);
// - then one transaction: every own stream gets a new logId (`retireOwnStreams(restored)`: front ends get `reset` +
//   `snap` and never use a retired logId again, D50), every own origin counter a new epoch (a slot this server sent
//   after the backup must not be reused), and `meta.restoredTo` = when the backup was taken (its file time), which the
//   `reset` carries so the window can say "restored to <time>". A turn the backup shows as `started` is interrupted by
//   the effect recovery at the next start (never run again).
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { retireOwnStreams } from "./log/log-store";
import { openServerStore, takeBackup } from "./store";
import { openReaderDb } from "./store/connection";

export interface RestoreResult {
  restoredFrom: string;
  /** Where the file it replaced was kept (null: there was none). */
  keptAs: string | null;
  restoredTo: number;
  streams: number;
}

export async function restoreBackup(dataDir: string, backup: string): Promise<RestoreResult> {
  if (!existsSync(backup)) throw new Error(`No backup at ${backup}.`);
  const check = openReaderDb(backup);
  try {
    const result = String(check.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "");
    if (result !== "ok") throw new Error(`The backup ${backup} is damaged (integrity_check: ${result.slice(0, 200)}).`);
    if (!check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'streams'").get()) throw new Error(`${backup} is not a Botling server backup.`);
  } finally {
    check.close();
  }
  const file = join(dataDir, "server.db");
  const backupsDir = join(dataDir, "backups");
  const keptAs = existsSync(file) ? await takeBackup(file, backupsDir, "manual") : null;
  const restoredTo = Math.floor(statSync(backup).mtimeMs);
  for (const suffix of ["-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
  const partial = `${file}.restoring`;
  copyFileSync(backup, partial);
  rmSync(file, { force: true });
  copyFileSync(partial, file);
  rmSync(partial, { force: true });
  const store = await openServerStore(dataDir);
  try {
    const streams = await store.submit((db) => {
      const retired = retireOwnStreams(db, "restored");
      for (const row of db.prepare("SELECT target FROM myorigins").all()) {
        db.prepare("UPDATE myorigins SET originEpoch = ?, nextN = 1 WHERE target = ?").run(randomBytes(16).toString("hex"), String(row.target));
      }
      db.prepare("INSERT INTO meta (key, value) VALUES ('restoredTo', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(restoredTo));
      return retired.length;
    });
    return { restoredFrom: backup, keptAs, restoredTo, streams };
  } finally {
    await store.close();
  }
}
