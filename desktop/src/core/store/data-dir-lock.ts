// One core per data folder (`<core data>/core.lock`).
//
// Every core keeps the chats in memory and rewrites chat.json (and the other stores) whole, so two
// cores on one folder overwrite each other: the one with the older copy wipes out what the other
// wrote. Main's Chromium single-instance lock is not enough on its own: it lives in the Electron
// profile, and when the data folder is renamed and replaced under a running app (an updater
// rollback, a data move) the lock goes with the old folder and a second app starts beside the first.
//
// The lock lives inside the folder itself, so it follows the folder through a rename or a symlink.
// core.lock is a directory holding one record, `<pid>.<random>.json`: {pid, boot, at, started,
// machineBoot, version, app}. A core makes its record in a temp directory and renames that into place,
// which the system refuses while core.lock holds a record, so nobody ever reads half of one. A record is
// stale when its holder is not running, ran before this machine last started, or its pid now belongs to
// a process that started after the record was written (pid reuse). A stale record is broken by removing
// it by its own name, so a core can only ever remove the record it judged, never a fresh one another
// core just put there (7be956c7 moved the whole lock aside and put it back when it was not the stale
// one; while it was aside a third core took the folder). The model is spec/models/datalock.
// The holder checks it every few seconds (`owns`): when the folder at this path is no longer the one it
// claimed (renamed aside and replaced), or the record names another core, this core is no longer the
// folder's owner and must stop writing at once.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BOOT_ID } from "../durable/atomic";

/** The lock: a directory holding the holder's record (a plain file in 7be956c7's builds, still honoured). */
export const LOCK_DIR = "core.lock";
/** The core's exit code when another core owns its data folder; main does not restart it then. */
export const CORE_EXIT_DATA_DIR_IN_USE = 75;
/** How often a running core makes sure it still owns its folder. */
export const LOCK_CHECK_MS = 3_000;

export interface LockHolder {
  pid: number;
  boot: string;
  /** When the record was written (ms). */
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

/** A record found in core.lock: its name in the directory (null: 7be956c7's lock file), and its holder (null: unreadable). */
interface Found { name: string | null; holder: LockHolder | null }

/** Reads the holder named in `<dir>/core.lock`, or null when there is none (or it does not parse). */
export function readLockHolder(dir: string): LockHolder | null {
  return findRecord(join(dir, LOCK_DIR))?.holder ?? null;
}

/** The record in this lock, or null when there is none. Anything else in it (a .DS_Store) counts as an unreadable one. */
function findRecord(lock: string): Found | null {
  let names: string[];
  try {
    names = readdirSync(lock);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOTDIR" ? { name: null, holder: readHolderFile(lock) } : null;
  }
  const name = names.find((n) => n.endsWith(".json")) ?? names[0];
  return name === undefined ? null : { name, holder: readHolderFile(join(lock, name)) };
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

/** The steps of the protocol, as spec/models/datalock names them. */
export type LockStep = "Try" | "Ident" | "Look" | "Break" | "Check" | "Leave";

export interface DataDirLockOptions {
  pid?: number;
  boot?: string;
  started?: number;
  version?: string;
  app?: string;
  alive?: (pid: number) => boolean;
  startTime?: (pid: number) => number | null;
  machineBoot?: () => number;
  /** Called after each step (the conformance test lets other cores act, or this one die, between two). */
  onStep?: (step: LockStep) => void;
}

export class DataDirLock {
  readonly lock: string;
  private readonly pid: number;
  private readonly boot: string;
  private readonly started: number;
  private readonly version: string | undefined;
  private readonly app: string | undefined;
  private readonly alive: (pid: number) => boolean;
  private readonly startTime: (pid: number) => number | null;
  private readonly machineBoot: () => number;
  private readonly onStep: ((step: LockStep) => void) | undefined;
  /** The folder this core claimed (device and inode): another folder at the same path is not ours. */
  private claimed: string | null = null;
  /** The name of this core's record in core.lock. */
  private record: string | null = null;

  constructor(readonly dir: string, options: DataDirLockOptions = {}) {
    this.lock = join(dir, LOCK_DIR);
    this.pid = options.pid ?? process.pid;
    this.boot = options.boot ?? BOOT_ID;
    this.started = options.started ?? Math.round(Date.now() - process.uptime() * 1000);
    this.version = options.version;
    this.app = options.app;
    this.alive = options.alive ?? pidAlive;
    this.startTime = options.startTime ?? processStartTime;
    this.machineBoot = options.machineBoot ?? machineBootTime;
    this.onStep = options.onStep;
  }

  /** Takes the folder, or says who has it. A stale lock is broken; the holder claiming again is fine. */
  claim(): Claim {
    mkdirSync(this.dir, { recursive: true });
    for (let attempt = 0; attempt < 5; attempt++) {
      const taken = this.take();
      this.onStep?.("Try");
      if (taken) {
        this.record = taken;
        this.claimed = this.identity();
        this.onStep?.("Ident");
        return { ok: true };
      }
      const found = findRecord(this.lock);
      const again = found?.holder?.boot === this.boot;
      const held = !again && found?.holder && !this.stale(found.holder) ? found.holder : null;
      if (again) { this.record = found!.name; this.claimed ??= this.identity(); }
      this.onStep?.("Look");
      if (again) return { ok: true };
      if (held) return { ok: false, holder: held };
      this.breakLock(found);
      this.onStep?.("Break");
    }
    return { ok: false, holder: { pid: 0, boot: "unknown", at: 0 } };
  }

  /**
   * Whether this core still owns the folder. A different folder at this path (the one it claimed was
   * moved aside), or a record naming another core, means this one must stop. A lock that is merely
   * gone from the same folder is claimed back.
   */
  owns(): boolean {
    const moved = this.claimed !== null && this.identity() !== this.claimed;
    const found = moved ? null : findRecord(this.lock);
    this.onStep?.("Check");
    if (moved) return false;
    if (found?.holder) return found.holder.boot === this.boot;
    return this.claim().ok;
  }

  /** Gives the folder back on exit: this core's own record goes, by its name; another core's stays. */
  release(): void {
    if (this.record) {
      try { unlinkSync(join(this.lock, this.record)); } catch { /* gone already */ }
      try { rmdirSync(this.lock); } catch { /* gone, or another core's record is in it */ }
    }
    this.onStep?.("Leave");
  }

  /**
   * Makes this core's record in a temp directory and renames that in as the lock: the record's name, or
   * null when the lock is held (the system refuses to rename onto a directory that is not empty).
   */
  private take(): string | null {
    const id = `${this.pid}.${randomBytes(4).toString("hex")}`;
    const temp = join(this.dir, `.${LOCK_DIR}.${id}.tmp`);
    const holder: LockHolder = {
      pid: this.pid, boot: this.boot, at: Date.now(), started: this.started, machineBoot: Math.round(this.machineBoot()),
      ...(this.version ? { version: this.version } : {}), ...(this.app ? { app: this.app } : {}),
    };
    mkdirSync(temp);
    try {
      writeFileSync(join(temp, `${id}.json`), JSON.stringify(holder), { mode: 0o600, flag: "wx" });
      renameSync(temp, this.lock);
      return `${id}.json`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A record is in it (ENOTEMPTY, EEXIST on some systems; EPERM on Windows), or it is 7be956c7's lock file (ENOTDIR).
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM" || code === "ENOTDIR") return null;
      throw error;
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  /**
   * Breaks the lock whose record was judged stale (null: none was in it) by removing that record by its
   * name, then the directory if it is empty. A record another core put in place since has another name,
   * and a directory with a record in it is not removed, so only the judged one can go.
   */
  private breakLock(found: Found | null): void {
    if (found && found.name === null) {
      // 7be956c7's lock file (unlink cannot remove a directory, so a lock made since stays).
      try { unlinkSync(this.lock); } catch { /* broken already */ }
      return;
    }
    if (found?.name) { try { unlinkSync(join(this.lock, found.name)); } catch { /* broken already */ } }
    try { rmdirSync(this.lock); } catch { /* gone, or another core's record is in it */ }
  }

  private identity(): string | null {
    try { const stat = statSync(this.dir); return `${stat.dev}:${stat.ino}`; } catch { return null; }
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
