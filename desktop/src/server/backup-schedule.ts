// Daily backups of server.db while botlingd runs (protocol v1 §7.6, M1 step 12): a check a few minutes after start and
// then every hour takes a `daily` backup when the newest one is a day old or there is none; `takeBackup` keeps 7.
// The copy is SQLite's online backup from its own read connection, so the writer keeps committing meanwhile.
// One backup at a time; `stop` waits for one under way, so the store is never closed under it.
import { newestBackup } from "./store";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** The first check after start: late enough not to slow a start, early enough for a server started each morning. */
export const FIRST_CHECK_MS = 5 * 60 * 1000;
export const CHECK_EVERY_MS = 60 * 60 * 1000;

/** A daily backup is due when there is none, or the newest (by the time in its name) is a day old. */
export function dailyBackupDue(backupsDir: string, now = Date.now()): boolean {
  const newest = newestBackup(backupsDir, "daily");
  return !newest || newest.at === null || now - newest.at >= DAY_MS;
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

/** `BOTLING_SERVER_BACKUP_CHECK_MS`: the first check and the interval (tests); `0` turns daily backups off. */
export function backupCheckMs(env: Record<string, string | undefined>): { firstMs: number; everyMs: number } | null {
  const raw = env.BOTLING_SERVER_BACKUP_CHECK_MS;
  if (raw === undefined || raw === "") return { firstMs: FIRST_CHECK_MS, everyMs: CHECK_EVERY_MS };
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return { firstMs: ms, everyMs: ms };
}

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
