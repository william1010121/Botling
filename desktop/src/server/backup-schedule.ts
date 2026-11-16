// Daily backups of server.db while botlingd runs (protocol v1 §7.6, M1 step 12): a check a few minutes after start and
// then every hour takes a `daily` backup when the newest one is a day old or there is none; `takeBackup` keeps 7.
// They are OFF unless asked for (a full copy of an 8 GB server.db, seven times, fills the disk): see `backupCheckMs`.
// `pre-migration` and manual backups are not affected. The copy is SQLite's online backup from its own read connection, so the writer keeps committing meanwhile.
// One backup at a time; `stop` waits for one under way, so the store is never closed under it.
import { rmSync } from "node:fs";
import { listBackups, newestBackup, stampTime } from "./store";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** The first check after start: late enough not to slow a start, early enough for a server started each morning. */
export const FIRST_CHECK_MS = 5 * 60 * 1000;
export const CHECK_EVERY_MS = 60 * 60 * 1000;

/** A daily backup stamped later than this past `now` is bogus (a clock that jumped, a placeholder), not "just taken". */
export const FUTURE_SLACK_MS = 5 * 60 * 1000;

/**
 * A daily backup is due when there is none, or the newest (by the time in its name) is a day old. A newest one stamped
 * in the future never counts as recent: it would hold the next backup back until that time.
 */
export function dailyBackupDue(backupsDir: string, now = Date.now()): boolean {
  const newest = newestBackup(backupsDir, "daily");
  return !newest || newest.at === null || newest.at > now + FUTURE_SLACK_MS || now - newest.at >= DAY_MS;
}

/** Deletes the daily backups stamped (in their names) in the future; returns the paths removed. Other kinds are left. */
export function removeFutureDailyBackups(backupsDir: string, now = Date.now()): string[] {
  const removed: string[] = [];
  for (const path of listBackups(backupsDir, "daily")) {
    const at = stampTime(path);
    if (at === null || at <= now + FUTURE_SLACK_MS) continue;
    try { rmSync(path, { force: true }); removed.push(path); } catch { /* left in place; dailyBackupDue ignores it anyway */ }
  }
  return removed;
}

export interface DailyBackupOptions {
  backupsDir: string;
  /** Takes one daily backup; resolves with its path. */
  take: () => Promise<string>;
  log: (line: string) => void;
  firstMs?: number;
  everyMs?: number;
  now?: () => number;
}

/**
 * Whether daily backups run, and when it checks (null = off, the default):
 * - `BOTLING_SERVER_BACKUP_CHECK_MS` a positive number: on, the first check and the interval in ms (tests); `0`, empty or
 *   anything else is off, whatever the next variable says;
 * - else `BOTLING_SERVER_DAILY_BACKUP=1|on|true`: on with the normal times (first check after 5 minutes, then hourly).
 */
export function backupCheckMs(env: Record<string, string | undefined>): { firstMs: number; everyMs: number } | null {
  const raw = env.BOTLING_SERVER_BACKUP_CHECK_MS;
  if (raw !== undefined && raw !== "") {
    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return { firstMs: ms, everyMs: ms };
  }
  if (["1", "on", "true"].includes((env.BOTLING_SERVER_DAILY_BACKUP ?? "").toLowerCase())) return { firstMs: FIRST_CHECK_MS, everyMs: CHECK_EVERY_MS };
  return null;
}

export const dailyBackupsOn = (env: Record<string, string | undefined>): boolean => backupCheckMs(env) !== null;

export class DailyBackups {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly options: DailyBackupOptions) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.schedule(this.options.firstMs ?? FIRST_CHECK_MS);
  }

  /** Checks now (and backs up when due); resolves when done. */
  check(): Promise<void> {
    if (this.running) return this.running;
    if (this.stopped) return Promise.resolve();
    this.running = (async () => {
      try {
        if (!dailyBackupDue(this.options.backupsDir, (this.options.now ?? Date.now)())) return;
        const path = await this.options.take();
        this.options.log(`daily backup: ${path}`);
      } catch (error) {
        this.options.log(`daily backup failed: ${String((error as Error)?.message ?? error)}`);
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check().finally(() => { if (!this.stopped) this.schedule(this.options.everyMs ?? CHECK_EVERY_MS); });
    }, ms);
    this.timer.unref();
  }
}
