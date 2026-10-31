// The agent process groups this core started, kept on disk (like the Swift ChildProcessLedger).
// Agent CLIs run in their own process group so Stop can end the tree, which also means they do
// not die when the core does. If the core crashes, the next core start ends what the ledger names,
// checking each group leader's start time so a reused pid is never killed.
// On Windows an entry's id is the process id (there are no groups) and the tree is ended by parent
// links; the planned Job Object (KILL_ON_JOB_CLOSE) would end them with the core.
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic, withFileLock } from "../durable/atomic";
import { groupAlive, killTree, processAlive, processStartTime, signalGroup, systemDeps, type ProcessDeps } from "./kill-tree";

interface Entry { pgid: number; started: string; core: number }

export class ProcessLedger {
  constructor(private file: string, private deps?: ProcessDeps) {}

  private update(change: (entries: Entry[]) => Entry[]) {
    withFileLock(this.file, () => {
      const entries = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Entry[]) : [];
      writeFileAtomic(this.file, JSON.stringify(change(entries)));
    });
  }

  record(pgid: number) {
    const started = processStartTime(pgid, this.deps);
    if (!started) return;
    this.update((entries) => [...entries.filter((entry) => entry.pgid !== pgid), { pgid, started, core: process.pid }]);
  }

  forget(pgid: number) {
    this.update((entries) => entries.filter((entry) => entry.pgid !== pgid));
  }

  /** Ends groups left by cores that are gone. Returns the pgids ended. */
  endLeftovers(): number[] {
    if (!existsSync(this.file)) return [];
    const ended: number[] = [];
    this.update((entries) =>
      entries.filter((entry) => {
        if (entry.core !== process.pid && processAlive(entry.core, this.deps)) return true; // Another live core's.
        // The leader may be gone while helpers it started live on in its group. POSIX does not
        // reuse a pid while a process group of that id exists, so a group with no leader is still
        // ours (not on Windows, which has no groups to hold a pid). A live leader must have the
        // recorded start time (otherwise the pid was reused).
        const started = processStartTime(entry.pgid, this.deps);
        if (started === entry.started || (started === null && (this.deps ?? systemDeps).platform !== "win32" && groupAlive(entry.pgid, this.deps))) {
          if (((this.deps ?? systemDeps).platform === "win32" ? killTree : signalGroup)(entry.pgid, "SIGKILL", this.deps)) ended.push(entry.pgid);
        }
        return false;
      }),
    );
    return ended;
  }
}
