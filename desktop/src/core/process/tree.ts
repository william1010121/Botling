// Starting a program and later ending it together with everything it started.
//
// An agent CLI starts its own children (tool commands, MCP servers, background subagents). Killing
// only the CLI leaves those running, unseen and still spending, so "stop" must end the whole tree.
// Each OS does that differently, so the core only talks to this interface.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

export interface TerminateResult {
  /** Process ids that were signalled (the leader's group or tree). */
  killed: number[];
  /** The tree did not end within the grace period and was force-killed. */
  forced: boolean;
}

export interface ManagedProcess {
  readonly pid: number;
  readonly child: ChildProcessWithoutNullStreams;
  /** Ends the whole tree: politely first, forcefully after `graceMs`. Safe to call twice. */
  terminate(options?: { graceMs?: number }): Promise<TerminateResult>;
}

export interface ProcessTreeAdapter {
  readonly platform: string;
  /** Whether this adapter's behaviour has been verified by running tests on its platform. */
  readonly verified: boolean;
  spawn(command: string, args: string[], options: Omit<SpawnOptionsWithoutStdio, "detached" | "stdio">): ManagedProcess;
}

export function processTreeAdapter(platform: NodeJS.Platform = process.platform): ProcessTreeAdapter {
  return platform === "win32" ? new WindowsTreeAdapter() : new PosixGroupAdapter(platform);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * macOS / Linux: the child leads a new session and process group (`setsid`, Node's `detached`),
 * so one `kill(-pgid)` reaches it and every descendant that stayed in the group.
 *
 * Known gap: a descendant that calls `setsid()`/`setpgid()` itself (a daemonizing helper) leaves the
 * group and survives. The Swift app has the same gap; a later step can add a ledger sweep by
 * parent-pid walk (`ps -o pid,ppid,pgid`) for those, like ChildProcessLedger.endLeftovers.
 */
export class PosixGroupAdapter implements ProcessTreeAdapter {
  readonly verified: boolean;
  constructor(readonly platform: string = process.platform) {
    this.verified = platform === "darwin"; // Linux uses the same calls but has not been run here.
  }

  spawn(command: string, args: string[], options: Omit<SpawnOptionsWithoutStdio, "detached" | "stdio">): ManagedProcess {
    const child = spawn(command, args, { ...options, detached: true, stdio: "pipe" });
    const pid = child.pid;
    if (pid === undefined) {
      // spawn failed (ENOENT etc.); the 'error' event carries why. Give a process that is already gone.
      return { pid: -1, child, terminate: async () => ({ killed: [], forced: false }) };
    }
    let ending: Promise<TerminateResult> | null = null;
    const groupAlive = () => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    const members = (): number[] => groupMembers(pid);
    return {
      pid,
      child,
      terminate: ({ graceMs = 2_000 } = {}) => {
        ending ??= (async () => {
          const killed = members();
          if (!groupAlive()) return { killed, forced: false };
          try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
          const deadline = Date.now() + graceMs;
          while (Date.now() < deadline) {
            if (!groupAlive()) return { killed, forced: false };
            await sleep(25);
          }
          try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
          for (let i = 0; i < 80 && groupAlive(); i++) await sleep(25);
          return { killed, forced: true };
        })();
        return ending;
      },
    };
  }
}

/** The pids in process group `pgid` (best effort, for reporting only). */
function groupMembers(pgid: number): number[] {
  try {
    // `ps -g` means "session leader" on some systems; filter on the pgid column instead.
    const out = execFileSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8", timeout: 2_000 });
    return out.split("\n").map((line) => line.trim().split(/\s+/).map(Number)).filter(([, g]) => g === pgid).map(([p]) => p!).filter(Boolean);
  } catch {
    return [pgid];
  }
}

/**
 * Windows 11: UNVERIFIED — written from documentation, never run. See desktop/README.md,
 * "Spike 4", for the plan.
 *
 * Interim behaviour: `taskkill /PID <pid> /T` (polite, WM_CLOSE to windowed processes; console
 * programs mostly ignore it), then `taskkill /PID <pid> /T /F` after the grace period. `/T` walks
 * the parent-pid links at kill time, so a child whose parent already exited is missed. The planned
 * replacement puts the CLI in a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (through a small
 * signed helper or N-API addon), which contains every descendant regardless of reparenting, and
 * ends it with TerminateJobObject.
 */
export class WindowsTreeAdapter implements ProcessTreeAdapter {
  readonly platform = "win32";
  readonly verified = false;

  spawn(command: string, args: string[], options: Omit<SpawnOptionsWithoutStdio, "detached" | "stdio">): ManagedProcess {
    // windowsHide: no console window flashes for the CLI. Not detached: detached on Windows means
    // "own console", which is not what is wanted.
    const child = spawn(command, args, { ...options, windowsHide: true, stdio: "pipe" });
    const pid = child.pid ?? -1;
    let ending: Promise<TerminateResult> | null = null;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const taskkill = (force: boolean) =>
      new Promise<void>((resolve) => {
        const kill = spawn("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { windowsHide: true, stdio: "ignore" });
        kill.once("exit", () => resolve());
        kill.once("error", () => resolve());
      });
    return {
      pid,
      child,
      terminate: ({ graceMs = 2_000 } = {}) => {
        ending ??= (async () => {
          if (pid < 0 || child.exitCode !== null) return { killed: [], forced: false };
          await taskkill(false);
          const timedOut = await Promise.race([exited.then(() => false), sleep(graceMs).then(() => true)]);
          if (timedOut) await taskkill(true);
          return { killed: [pid], forced: timedOut };
        })();
        return ending;
      },
    };
  }
}
