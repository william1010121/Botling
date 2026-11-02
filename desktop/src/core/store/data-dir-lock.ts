// One core per data folder (`<core data>/core.lock`).
//
// Every core keeps the chats in memory and rewrites chat.json (and the other stores) whole, so two
// cores on one folder overwrite each other: the one with the older copy wipes out what the other
// wrote. Main's Chromium single-instance lock is not enough on its own: it lives in the Electron
// profile, and when the data folder is renamed and replaced under a running app (an updater
// rollback, a data move) the lock goes with the old folder and a second app starts beside the first.
//
// The lock is a file inside the folder itself, so it follows the folder through a rename or a
// symlink. It is written whole to a temp file and linked into place (link fails when the name is
// taken), so nobody ever reads half of one. It holds {pid, boot, at, started, machineBoot, version,
// app}. It is stale when its holder is not running, ran before this machine last started, or its pid
// now belongs to a process that started after the lock was written (pid reuse). The holder checks it
// every few seconds (`owns`): when the folder at this path is no longer the one it claimed (renamed
// aside and replaced), or the file names another core, this core is no longer the folder's owner and
// must stop writing at once.
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BOOT_ID } from "../durable/atomic";

export const LOCK_FILE = "core.lock";
/** The core's exit code when another core owns its data folder; main does not restart it then. */
export const CORE_EXIT_DATA_DIR_IN_USE = 75;
/** How often a running core makes sure it still owns its folder. */
export const LOCK_CHECK_MS = 3_000;

export interface LockHolder {
  pid: number;
  boot: string;
  /** When the lock was written (ms). */
  at: number;
  /** When the holder process started (ms, approximate). */
  started?: number;
  machineBoot?: number;
  /** The holder's app version and where it runs from, for the "already running" notice. */
  version?: string;
  app?: string;
}
export type Claim = { ok: true } | { ok: false; holder: LockHolder };

/** When this machine started (ms), to the second or so. */
export const machineBootTime = () => Date.now() - uptime() * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** When the process with this pid started (ms, to the second), or null when the system cannot say. */
export function processStartTime(pid: number): number | null {
  if (process.platform === "win32") return null;
  try {
    const text = execFileSync(process.platform === "darwin" ? "/bin/ps" : "ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000, env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const time = Date.parse(text.replace(/\s+/g, " "));
    return Number.isFinite(time) ? time : null;
  } catch {
    return null;
  }
}

/** Reads the holder named in `<dir>/core.lock`, or null when there is none (or it does not parse). */
export function readLockHolder(dir: string): LockHolder | null {
  return readHolderFile(join(dir, LOCK_FILE));
}

function readHolderFile(file: string): LockHolder | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<LockHolder>;
    if (typeof value?.pid !== "number" || typeof value.boot !== "string") return null;
    const holder: LockHolder = { pid: value.pid, boot: value.boot, at: typeof value.at === "number" ? value.at : 0 };
    if (typeof value.started === "number") holder.started = value.started;
    if (typeof value.machineBoot === "number") holder.machineBoot = value.machineBoot;
    if (typeof value.version === "string") holder.version = value.version.slice(0, 100);
    if (typeof value.app === "string") holder.app = value.app.slice(0, 1_000);
    return holder;
  } catch {
    return null;
  }
}

/** Two boot times this close are the same boot (uptime is not exact). */
const SAME_BOOT_MS = 120_000;
/**
 * A process that started this long after a lock was written did not write it. The margin covers ps's
 * whole seconds and clock adjustments; a reused pid is normally hours or days younger than the lock.
 */
const STARTED_AFTER_MS = 60_000;

export interface DataDirLockOptions {
  pid?: number;
  boot?: string;
  started?: number;
  version?: string;
  app?: string;
  alive?: (pid: number) => boolean;
  startTime?: (pid: number) => number | null;
  machineBoot?: () => number;
}

export class DataDirLock {
  readonly file: string;
  private readonly pid: number;
  private readonly boot: string;
  private readonly started: number;
  private readonly version: string | undefined;
  private readonly app: string | undefined;
  private readonly alive: (pid: number) => boolean;
  private readonly startTime: (pid: number) => number | null;
  private readonly machineBoot: () => number;
  /** The folder this core claimed (device and inode): another folder at the same path is not ours. */
  private claimed: string | null = null;

  constructor(readonly dir: string, options: DataDirLockOptions = {}) {
    this.file = join(dir, LOCK_FILE);
    this.pid = options.pid ?? process.pid;
    this.boot = options.boot ?? BOOT_ID;
    this.started = options.started ?? Math.round(Date.now() - process.uptime() * 1000);
    this.version = options.version;
    this.app = options.app;
    this.alive = options.alive ?? pidAlive;
    this.startTime = options.startTime ?? processStartTime;
    this.machineBoot = options.machineBoot ?? machineBootTime;
  }

  /** Takes the folder, or says who has it. A stale lock is broken; the holder claiming again is fine. */
  claim(): Claim {
    mkdirSync(this.dir, { recursive: true });
    for (let attempt = 0; attempt < 5; attempt++) {
      if (this.link()) {
        this.claimed = this.identity();
        return { ok: true };
      }
      const holder = this.holder();
      if (holder && holder.boot === this.boot) { this.claimed ??= this.identity(); return { ok: true }; }
      if (holder && !this.stale(holder)) return { ok: false, holder };
      this.breakLock(holder);
    }
    const holder = this.holder();
    return holder ? { ok: false, holder } : { ok: false, holder: { pid: 0, boot: "unknown", at: 0 } };
  }

  /**
   * Whether this core still owns the folder. A different folder at this path (the one it claimed was
   * moved aside), or a lock file naming another core, means this one must stop. A lock file that is
   * merely gone from the same folder is claimed back.
   */
  owns(): boolean {
    if (this.claimed && this.identity() !== this.claimed) return false;
    const holder = this.holder();
    if (holder) return holder.boot === this.boot;
    return this.claim().ok;
  }

  /** Gives the folder back on exit; another core's lock is left alone. */
  release(): void {
    if (this.holder()?.boot !== this.boot) return;
    try { unlinkSync(this.file); } catch { /* gone already */ }
  }

  /** Writes this core's record whole and links it in as the lock: false when the name is taken. */
  private link(): boolean {
    const temp = join(this.dir, `.${LOCK_FILE}.${this.pid}.${randomBytes(4).toString("hex")}.tmp`);
    const holder: LockHolder = {
      pid: this.pid, boot: this.boot, at: Date.now(), started: this.started, machineBoot: Math.round(this.machineBoot()),
      ...(this.version ? { version: this.version } : {}), ...(this.app ? { app: this.app } : {}),
    };
    writeFileSync(temp, JSON.stringify(holder), { mode: 0o600, flag: "wx" });
    try {
      linkSync(temp, this.file);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS") throw error;
      // No hard links on this volume (FAT, exFAT): create the name exclusively and write into it.
      try { writeFileSync(this.file, JSON.stringify(holder), { mode: 0o600, flag: "wx" }); return true; }
      catch (fallback) { if ((fallback as NodeJS.ErrnoException).code === "EEXIST") return false; throw fallback; }
    } finally {
      try { unlinkSync(temp); } catch { /* gone already */ }
    }
  }

  /**
   * Breaks the stale lock held by `judged` (null: unreadable). It is moved aside first and checked: if
   * another core broke it and took the folder in the meantime, that core's fresh lock is put back.
   */
  private breakLock(judged: LockHolder | null): void {
    const aside = join(this.dir, `.${LOCK_FILE}.${this.pid}.${randomBytes(4).toString("hex")}.stale`);
    try { renameSync(this.file, aside); } catch { return; /* someone else broke it */ }
    const moved = readHolderFile(aside);
    const same = judged === null ? moved === null : moved?.boot === judged.boot;
    if (!same) { try { linkSync(aside, this.file); } catch { /* the folder is taken again; claim() sees who has it */ } }
    try { unlinkSync(aside); } catch { /* gone already */ }
  }

  private identity(): string | null {
    try { const stat = statSync(this.dir); return `${stat.dev}:${stat.ino}`; } catch { return null; }
  }

  private holder(): LockHolder | null {
    return readLockHolder(this.dir);
  }

  private stale(holder: LockHolder): boolean {
    if (!this.alive(holder.pid)) return true;
    // The holder ran before this machine started: its pid now belongs to another process.
    if (typeof holder.machineBoot === "number" && Math.abs(holder.machineBoot - this.machineBoot()) > SAME_BOOT_MS) return true;
    // The process with that pid started after the lock was written: it is not the one that wrote it.
    const started = holder.at > 0 ? this.startTime(holder.pid) : null;
    return started !== null && started > holder.at + STARTED_AFTER_MS;
  }
}
