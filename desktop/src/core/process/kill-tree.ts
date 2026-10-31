// The one place that ends a process tree, asks whether a process lives, and reads when it started.
// Everything that spawns a child (agent CLIs, plugin hosts, tool commands, terminals) calls this
// instead of `process.kill(-pid)` or `ps`, so each OS is handled here and nowhere else.
//
// POSIX: a child spawned `detached` leads its own process group, so `kill(-pid)` reaches it and every
// descendant that stayed in the group; a child that is not a group leader is signalled alone.
// Windows: there are no groups or signals; `taskkill /T /F` ends the tree by parent links at that
// moment (a Job Object would be stronger; see tree.ts). Every signal but 0 becomes a forced kill,
// because console programs ignore the polite form.
//
// Start times only have to be stable per process and different for a reused pid; callers compare them
// for equality and never parse them. The text differs per OS.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** What this module needs from the OS; tests replace it to run another platform's branch. */
export interface ProcessDeps {
  platform: NodeJS.Platform;
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  /** Runs a program to completion and returns its stdout; throws when it fails. */
  exec(file: string, args: string[], timeoutMs: number): string;
  /** Runs taskkill; the exit status (0: done), null when it could not run. */
  taskkill(args: string[]): number | null;
  readFile(path: string): string;
}

export const systemDeps: ProcessDeps = {
  get platform() { return process.platform; },
  kill: (pid, signal) => { process.kill(pid, signal); },
  exec: (file, args, timeout) => execFileSync(file, args, { encoding: "utf8", timeout, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } }),
  taskkill: (args) => spawnSync("taskkill", args, { windowsHide: true, stdio: "ignore", timeout: 5_000 }).status,
  readFile: (path) => readFileSync(path, "utf8"),
};

const withPlatform = (deps: ProcessDeps | undefined) => deps ?? systemDeps;

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** Whether `pid` is a running process (one we may not signal still counts). */
export function processAlive(pid: number, deps?: ProcessDeps): boolean {
  const { kill } = withPlatform(deps);
  try { kill(pid, 0); return true; } catch (error) { return code(error) === "EPERM"; }
}

/** Whether the process group led by `pid` still has a member. Windows has no groups: the process itself. */
export function groupAlive(pid: number, deps?: ProcessDeps): boolean {
  const d = withPlatform(deps);
  if (d.platform === "win32") return processAlive(pid, d);
  try { d.kill(-pid, 0); return true; } catch (error) { return code(error) === "EPERM"; }
}

/** Signal only an existing POSIX group; never fall back to a potentially reused PID. */
export function signalGroup(pgid: number, signal: NodeJS.Signals, deps?: ProcessDeps): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  const d = withPlatform(deps);
  if (d.platform === "win32") return false;
  try { d.kill(-pgid, signal); return true; } catch { return false; }
}

/** Signals `pid`'s whole tree. True when something was signalled; false when it was already gone. */
export function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM", deps?: ProcessDeps): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const d = withPlatform(deps);
  if (d.platform === "win32") return d.taskkill(["/PID", String(pid), "/T", "/F"]) === 0;
  if (signalGroup(pid, signal, d)) return true;
  try { d.kill(pid, signal); return true; } catch { return false; }
}

/** When `pid` started, as a string that is equal on every read of the same process; null when unknown (never throws). */
export function processStartTime(pid: number, deps?: ProcessDeps): string | null {
  const d = withPlatform(deps);
  try {
    if (d.platform === "win32") {
      // Round-trip UTC ("o") sorts and compares as text; the invariant culture keeps it locale-proof.
      const out = d.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)`], 5_000).trim();
      return out || null;
    }
    if (d.platform === "linux") {
      try {
        const ticks = linuxStartTicks(d.readFile(`/proc/${Math.trunc(pid)}/stat`));
        if (ticks) return ticks;
      } catch { /* Gone, or no /proc (a container, BSD): ask ps. */ }
    }
    // darwin, and Linux without /proc: "Thu Oct 30 12:00:00 2026" (LC_ALL=C pins the format).
    const out = d.exec("ps", ["-o", "lstart=", "-p", String(Math.trunc(pid))], 2_000).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Field 22 of /proc/<pid>/stat (clock ticks since boot). The command name in field 2 may hold spaces and parentheses, so count from the last ")". */
export function linuxStartTicks(stat: string): string | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  const ticks = fields[19]; // fields[0] is field 3 (state).
  return ticks && /^\d+$/.test(ticks) ? ticks : null;
}

/** The command lines of every process (POSIX `ps -axo args=`); an empty list on Windows or when ps fails. */
export function processCommandLines(deps?: ProcessDeps): string[] {
  const d = withPlatform(deps);
  if (d.platform === "win32") return [];
  try { return d.exec("ps", ["-axo", "args="], 3_000).split("\n"); } catch { return []; }
}

/** The pids in process group `pgid` (best effort, for reporting only). */
export function groupMembers(pgid: number, deps?: ProcessDeps): number[] {
  const d = withPlatform(deps);
  if (d.platform === "win32") return [pgid];
  try {
    // `ps -g` means "session leader" on some systems; filter on the pgid column instead.
    const out = d.exec("ps", ["-A", "-o", "pid=,pgid="], 2_000);
    return out.split("\n").map((line) => line.trim().split(/\s+/).map(Number)).filter(([, g]) => g === pgid).map(([p]) => p!).filter(Boolean);
  } catch {
    return [pgid];
  }
}
