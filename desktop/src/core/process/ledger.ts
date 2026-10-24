// The agent process groups this core started, kept on disk (like the Swift ChildProcessLedger).
// Agent CLIs run in their own process group so Stop can end the tree, which also means they do
// not die when the core does. If the core crashes, the next core start ends what the ledger names,
// checking each group leader's start time so a reused pid is never killed.
// POSIX only for now; on Windows the planned Job Object (KILL_ON_JOB_CLOSE) ends them with the core.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic, withFileLock } from "../durable/atomic";

interface Entry { pgid: number; started: string; core: number }

export function processStartTime(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000, env: { ...process.env, LC_ALL: "C" } }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export class ProcessLedger {
  constructor(private file: string) {}

  private update(change: (entries: Entry[]) => Entry[]) {
    withFileLock(this.file, () => {
      const entries = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Entry[]) : [];
      writeFileAtomic(this.file, JSON.stringify(change(entries)));
    });
  }

  record(pgid: number) {
    const started = processStartTime(pgid);
    if (!started) return;
    this.update((entries) => [...entries.filter((entry) => entry.pgid !== pgid), { pgid, started, core: process.pid }]);
  }

  forget(pgid: number) {
    this.update((entries) => entries.filter((entry) => entry.pgid !== pgid));
  }

  /** Ends groups left by cores that are gone. Returns the pgids ended. */
  endLeftovers(): number[] {
    if (process.platform === "win32" || !existsSync(this.file)) return [];
    const ended: number[] = [];
    this.update((entries) =>
      entries.filter((entry) => {
        if (entry.core !== process.pid && alive(entry.core)) return true; // Another live core's.
        // The leader may be gone while helpers it started live on in its group. POSIX does not
        // reuse a pid while a process group of that id exists, so a group with no leader is still
        // ours. A live leader must have the recorded start time (otherwise the pid was reused).
        const started = processStartTime(entry.pgid);
        if (started === entry.started || (started === null && groupExists(entry.pgid))) {
          try { process.kill(-entry.pgid, "SIGKILL"); ended.push(entry.pgid); } catch { /* gone */ }
        }
        return false;
      }),
    );
    return ended;
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function groupExists(pgid: number) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
