// botlingd's Doctor notes (M1 step 12): what the owner should know about the server's own data, shown by
// `botlingd status` (text and `--json`) and written to botlingd.log at start. The window's Doctor page lists engine
// checks only (contract `DoctorCheck.tool` is a closed set), so these notes stay on the server's side in M1.
//
// - D43: the data folder is on an external disk, so "durable" depends on the enclosure honouring F_FULLFSYNC;
// - backups (only when daily backups are on, which they are not by default): none yet, or the newest is older than two
//   days (the daily backup did not run: the server was not up);
// - a restore: when, from which file, to when, and what that means for commands applied after the backup;
// - media tools (M2 step 10, D42): what the running server did not find on its PATH (no ffmpeg: no previews, the
//   original plays), as it recorded in `meta.mediaTools` at start.
import { join } from "node:path";
import { externalDiskNote, listBackups, newestBackup, type Db } from "./store";

export interface ServerNote {
  /** `peer-stale` and `forward-queue-old` come from machines.ts (M3 step 13). */
  id: "external-disk" | "no-backup" | "old-backup" | "restored" | "media-tools" | "peer-stale" | "forward-queue-old";
  level: "info" | "warning";
  text: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A newest backup older than this is noted (the daily backup normally keeps it under a day). */
export const OLD_BACKUP_MS = 2 * DAY_MS;

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

/** The newest backup of any kind, by the time in its name. */
export function newestAnyBackup(backupsDir: string): { path: string; at: number } | null {
  let best: { path: string; at: number } | null = null;
  for (const kind of ["daily", "manual", "pre-migration"] as const) {
    const newest = newestBackup(backupsDir, kind);
    if (newest?.at != null && (!best || newest.at > best.at)) best = { path: newest.path, at: newest.at };
  }
  return best;
}

/**
 * The notes for this data folder; `db` (a reader of server.db) adds the restore note. The two backup notes appear only
 * when `backupsOn` (daily backups are on: `dailyBackupsOn(env)`); with them off, a missing or old backup is nothing to nag about.
 */
export function serverNotes(dataDir: string, db: Db | null, now = Date.now(), platform: NodeJS.Platform = process.platform, backupsOn = false): ServerNote[] {
  const notes: ServerNote[] = [];
  const disk = externalDiskNote(dataDir, platform);
  if (disk) notes.push({ id: "external-disk", level: "warning", text: disk });
  const backupsDir = join(dataDir, "backups");
  const newest = backupsOn ? newestAnyBackup(backupsDir) : null;
  if (backupsOn && !newest) {
    notes.push({ id: "no-backup", level: "warning", text: "There is no backup of server.db yet; botlingd takes one every day while it runs (or run botlingd backup)." });
  } else if (newest && now - newest.at > OLD_BACKUP_MS) {
    const days = Math.floor((now - newest.at) / DAY_MS);
    notes.push({ id: "old-backup", level: "warning", text: `The newest backup of server.db is ${days} days old (${iso(newest.at)}); botlingd takes one every day while it runs.` });
  }
  if (db) {
    const meta = (key: string) => db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
    const restoredAt = Number(meta("restoredAt") ?? NaN);
    const restoredTo = Number(meta("restoredTo") ?? NaN);
    if (Number.isFinite(restoredAt) && Number.isFinite(restoredTo)) {
      const from = meta("restoredFrom");
      notes.push({
        id: "restored", level: "info",
        text: `History was restored on ${iso(restoredAt)} to ${iso(restoredTo)}${from ? ` from ${String(from)}` : ""}. Lines after that are gone; a command applied after the backup whose outcome its sender had not seen may have run again.`,
      });
    }
    const tools = meta("mediaTools");
    if (tools) {
      try {
        const parsed = JSON.parse(String(tools)) as { notes?: unknown };
        if (Array.isArray(parsed.notes)) {
          for (const text of parsed.notes) if (typeof text === "string") notes.push({ id: "media-tools", level: text.startsWith("qpdf") ? "info" : "warning", text });
        }
      } catch { /* an unreadable value says nothing */ }
    }
  }
  return notes;
}

/** How many daily backups are kept (for status). */
export function dailyBackups(dataDir: string): number {
  return listBackups(join(dataDir, "backups"), "daily").length;
}
