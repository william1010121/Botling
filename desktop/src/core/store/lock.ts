// A project bot works in the user's own project folder and keeps its notes there
// (`.bot/memory.md`), as in 1.x. Two apps writing that file at once would interleave edits, so a
// project is used by one Botling at a time:
// - 2.0 takes `<project>/.bot/botling.lock` (who: pid, its start time, host, app, data folder);
//   another 2.0 sees a live holder and leaves the bot read-only; a holder that is gone (pid dead
//   or reused) is taken over;
// - 1.x writes no lock (its code is not changed), so 2.0 looks for it instead: a running 1.x app
//   (`…/Contents/MacOS/botling`) whose projects.json lists this folder holds it too.
// The bot shows why it is read-only and tries again when the user sends something.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { processStartTime } from "../process/ledger";
import { readJSON } from "./bot-store";

export const LOCK_FILE = "botling.lock";

export interface LockOwner { app: string; pid: number; started: string | null; host: string; dataDir: string; at: string }

export interface OneXCheck {
  /** 1.x's data folder (its projects.json); null: do not look for 1.x. */
  folder: string | null;
  /** Matches a running 1.x process's command line (`ps -axo args=`). */
  process: RegExp;
}

export const DEFAULT_ONE_X_PROCESS = /\/Contents\/MacOS\/botling(\s|$)/;

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

/** Whether a 1.x app is running and has `folder` as one of its projects. */
export function heldBy1x(folder: string, check: OneXCheck): boolean {
  if (!check.folder || process.platform === "win32") return false;
  let listed = false;
  try {
    const projects = readJSON(join(check.folder, "projects.json"));
    if (Array.isArray(projects)) {
      const wanted = resolve(folder);
      listed = projects.some((project) => {
        const raw = (project as { folder?: unknown })?.folder;
        if (typeof raw !== "string") return false;
        try { return resolve(raw.startsWith("file:") ? fileURLToPath(raw) : raw) === wanted; } catch { return false; }
      });
    }
  } catch { /* An unreadable projects.json lists nothing. */ }
  if (!listed) return false;
  try {
    const out = execFileSync("ps", ["-axo", "args="], { encoding: "utf8", timeout: 3_000, env: { ...process.env, LC_ALL: "C" } });
    return out.split("\n").some((line) => check.process.test(line));
  } catch {
    return false;
  }
}

export type LockResult = { held: true } | { held: false; by: string };

export class ProjectLock {
  private file: string;
  private mine = false;

  constructor(readonly folder: string, private dataDir: string, private oneX: OneXCheck) {
    this.file = join(folder, ".bot", LOCK_FILE);
  }

  get held() { return this.mine; }

  private read(): LockOwner | null {
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as LockOwner;
      return typeof value?.pid === "number" ? value : null;
    } catch {
      return null;
    }
  }

  /** A lock whose holder is gone: its pid is dead, or now another process (start time differs). */
  private stale(owner: LockOwner): boolean {
    if (owner.host !== hostname()) return false;
    if (owner.pid === process.pid && owner.dataDir === this.dataDir) return true; // Ours, from an earlier start of this core.
    if (!alive(owner.pid)) return true;
    const started = processStartTime(owner.pid);
    return !!owner.started && !!started && started !== owner.started;
  }

  /** Takes the project for this core, or says who has it. Cheap to call again. */
  acquire(): LockResult {
    if (heldBy1x(this.folder, this.oneX)) {
      this.release();
      return { held: false, by: "Botling 1.x is running and has this project open" };
    }
    if (this.mine && this.read()?.pid === process.pid) return { held: true };
    this.mine = false;
    const owner: LockOwner = { app: "Botling 2.0", pid: process.pid, started: processStartTime(process.pid), host: hostname(), dataDir: this.dataDir, at: new Date().toISOString() };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        mkdirSync(join(this.folder, ".bot"), { recursive: true });
        writeFileSync(this.file, JSON.stringify(owner), { flag: "wx" });
        this.mine = true;
        return { held: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { held: false, by: `its lock file cannot be written (${(error as Error).message})` };
      }
      const other = this.read();
      if (other && !this.stale(other)) {
        return { held: false, by: `another Botling (${other.app}, pid ${other.pid}${other.host !== hostname() ? ` on ${other.host}` : ""}) has this project open` };
      }
      // Gone (or unreadable): take it over.
      try { unlinkSync(this.file); } catch { /* raced: try again */ }
    }
    return { held: false, by: "another Botling took this project just now" };
  }

  release() {
    if (!this.mine) return;
    this.mine = false;
    try {
      if (existsSync(this.file) && this.read()?.pid === process.pid) unlinkSync(this.file);
    } catch { /* Left for the next start, which sees it is stale. */ }
  }
}
