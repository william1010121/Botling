// Plugins' own child processes, when the plugin host is a utility process (Phase 5c).
//
// A utility process cannot be put in a process group of its own (Electron starts it; there is no
// setsid), so a plugin's `spawn("sleep", …)` would land in the app's group and live on after the host
// stopped, crashed or the app quit. Before any plugin loads, the host wraps `ChildProcess.prototype.spawn`
// — where every asynchronous starter (spawn, exec, execFile, fork) ends up; exec and execFile do not
// pass a `detached` option on — so that on macOS and Linux each child leads a process group of its own
// (`detached`, setsid), and tells main each group's id. Main keeps
// them per host and ends every group (SIGTERM, then SIGKILL) when that host exits for any reason —
// shut down, killed, crashed — and when the app quits; groups are also kept in the core's ledger so
// that the next start ends what a crashed app left (src/main/plugin-children.ts).
//
// Windows (unverified, nothing has run there): `detached` means a console of its own, so it is not
// set; the pid is reported all the same and main ends it with `taskkill /T /F`. The planned
// replacement is a Job Object with KILL_ON_JOB_CLOSE that main assigns each reported pid to, which
// contains the whole tree whatever the parent links (as for the agent CLIs, process/tree.ts).
//
// The synchronous starters (spawnSync, execSync, execFileSync) are left alone: they return only once
// their child has ended. A child that leaves its group itself (its own setsid) is out of reach, as
// it would be in a Node host's group.
import { createRequire } from "node:module";
import type * as ChildProcessModule from "node:child_process";

const require_ = createRequire(import.meta.url);

/** What the wrapper reports for each child it started: the process group (= the child's pid on POSIX). */
export type ReportChild = (pid: number) => void;

let installed = false;

/** Wraps ChildProcess.prototype.spawn once (it serves CommonJS and ESM callers alike). */
export function containChildren(report: ReportChild, platform: NodeJS.Platform = process.platform): void {
  if (installed) return;
  installed = true;
  const { ChildProcess } = require_("node:child_process") as typeof ChildProcessModule;
  const proto = ChildProcess.prototype as unknown as { spawn(this: { pid?: number }, options: unknown): unknown };
  const original = proto.spawn;
  proto.spawn = function (options: unknown) {
    const given = options !== null && typeof options === "object" ? options as Record<string, unknown> : null;
    const result = original.call(this, given && platform !== "win32" ? { ...given, detached: true } : options);
    if (typeof this.pid === "number" && this.pid > 0) report(this.pid);
    return result;
  };
}
