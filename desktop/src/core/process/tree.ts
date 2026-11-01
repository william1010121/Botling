// Starting a program and later ending it together with everything it started.
//
// An agent CLI starts its own children (tool commands, MCP servers, background subagents). Killing
// only the CLI leaves those running, unseen and still spending, so "stop" must end the whole tree.
// Each OS does that differently, so the core only talks to this interface.
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { groupAlive, groupMembers, killTree, signalGroup } from "./kill-tree";

export interface TerminateResult {
  /** Process ids that were signalled (the leader's group or tree). */
  killed: number[];
  /** The tree did not end within the grace period and was force-killed. */
  forced: boolean;
  /** Still alive after the force-kill (not confirmed gone): a caller must not take this as the process's exit. */
  alive?: boolean;
}

export interface ManagedProcess {
  readonly pid: number;
  readonly child: ChildProcessWithoutNullStreams;
  /**
   * Ends the whole tree: politely first, forcefully after `graceMs`. A call while one is under way shares it; one that
   * left the tree alive is not kept, so the next call signals again.
   */
  terminate(options?: { graceMs?: number }): Promise<TerminateResult>;
  /** Whether the whole tree is gone, checked now: its leader exited and nothing of its group lives on. */
  gone?(): boolean;
}

/** A process tree the app must see gone before it reuses what it held (a worker's head, an editor's process). */
export interface TreeHandle {
  terminate(graceMs?: number): Promise<TerminateResult>;
  /** Checked now (absent: only the terminate's own answer tells). */
  gone?(): boolean | undefined;
}

/**
 * Ends a tree and confirms it is gone: the one check every worker adapter uses (Claude workers, the component editor,
 * Antigravity). Live, never a remembered answer: a terminate that failed or left the tree alive is no confirmation,
 * and a later call tries again.
 */
export async function endTree(handle: TreeHandle, graceMs?: number, started?: Promise<TerminateResult>): Promise<boolean> {
  // `started`: a terminate of it already asked (its answer is awaited, not a second one).
  const result = await (started ?? handle.terminate(graceMs)).catch(() => null);
  return handle.gone?.() ?? (!!result && !result.alive);
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
      return { pid: -1, child, terminate: async () => ({ killed: [], forced: false }), gone: () => true };
    }
    let ending: Promise<TerminateResult> | null = null;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    return {
      pid,
      child,
      // Its own child: Node knows when the leader exited; the group cannot be another's while it has a member.
      gone: () => exited() && !groupAlive(pid),
      terminate: ({ graceMs = 2_000 } = {}) => {
        ending ??= (async () => {
          const killed = groupMembers(pid);
          if (!groupAlive(pid)) return { killed, forced: false };
          signalGroup(pid, "SIGTERM");
          const deadline = Date.now() + graceMs;
          while (Date.now() < deadline) {
            if (!groupAlive(pid)) return { killed, forced: false };
            await sleep(25);
          }
          signalGroup(pid, "SIGKILL");
          for (let i = 0; i < 80 && groupAlive(pid); i++) await sleep(25);
          return groupAlive(pid) ? { killed, forced: true, alive: true } : { killed, forced: true };
        })();
        const current = ending;
        // Only a terminate under way is shared: one that left the tree alive is tried again next time.
        void current.then((result) => { if (result.alive && ending === current) ending = null; });
        return current;
      },
    };
  }
}

/**
 * Windows 11: UNVERIFIED — written from documentation, never run. See desktop/README.md,
 * "Spike 4", for the plan.
 *
 * Interim behaviour: `taskkill /PID <pid> /T /F` through killTree, at once and again if the
 * CLI is still there after the grace period. `/T` walks the parent-pid links at kill time, so a
 * child whose parent already exited is missed. The planned replacement puts the CLI in a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (through a small
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
    return {
      pid,
      child,
      gone: () => pid < 0 || child.exitCode !== null || child.signalCode !== null,
      terminate: ({ graceMs = 2_000 } = {}) => {
        ending ??= (async () => {
          if (pid < 0 || child.exitCode !== null) return { killed: [], forced: false };
          killTree(pid, "SIGKILL"); // taskkill /T /F: there is no polite form console programs honour.
          const timedOut = await Promise.race([exited.then(() => false), sleep(graceMs).then(() => true)]);
          if (timedOut) killTree(pid, "SIGKILL");
          const gone = !timedOut || await Promise.race([exited.then(() => true), sleep(graceMs).then(() => child.exitCode !== null)]);
          return { killed: [pid], forced: timedOut, ...(gone ? {} : { alive: true }) };
        })();
        const current = ending;
        void current.then((result) => { if (result.alive && ending === current) ending = null; });
        return current;
      },
    };
  }
}
