// `api.exec` and `api.spawn` (plugin-platform.md §4.2): a thin layer over child_process that every
// plugin would otherwise get wrong. Each child leads a process group of its own (POSIX), so ending it
// ends what it started too; `exec` has a time limit (60 s) and an output cap (1 MB) as the core's
// component commands do (core/components/commands.ts). The plugin's children end when it unloads;
// when the host is a utility process, main also ends every group once the host is gone (children.ts).
import { spawn as spawnChild, type ChildProcess } from "node:child_process";

type Dispose = () => void;

export interface ExecOptions { cwd?: string; timeoutMs?: number; maxBytes?: number; env?: Record<string, string> }
export interface ExecResult { stdout: string; stderr: string; code: number | null; timedOut: boolean }
export interface SpawnOptions { cwd?: string; env?: Record<string, string> }

/** A running child of `api.spawn`: its output as it comes, and a way to end it (and its group). */
export interface ChildHandle {
  readonly pid: number | null;
  onStdout(fn: (chunk: string) => void): Dispose;
  onStderr(fn: (chunk: string) => void): Dispose;
  onExit(fn: (code: number | null, signal: string | null) => void): Dispose;
  write(text: string): void;
  /** Ends the child's whole process group (SIGTERM, then SIGKILL after 2 s). */
  kill(): void;
  /** Resolves when it has exited. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

export const EXEC_TIMEOUT_MS = 60_000;
export const EXEC_MAX_BYTES = 1_000_000;
const KILL_GRACE_MS = 2_000;
const groups = process.platform !== "win32";

/** Ends a child and everything in its process group. */
function endGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (groups) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* already gone */ }
}

function stop(child: ChildProcess) {
  endGroup(child, "SIGTERM");
  const timer = setTimeout(() => endGroup(child, "SIGKILL"), KILL_GRACE_MS);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
}

const merged = (env?: Record<string, string>) => (env ? { ...process.env, ...env } : process.env);

/** The children a plugin started, all ended when it unloads. */
export class Children {
  private readonly running = new Set<ChildProcess>();
  track(child: ChildProcess) {
    this.running.add(child);
    child.once("exit", () => this.running.delete(child));
    child.once("error", () => this.running.delete(child));
  }
  endAll() {
    for (const child of this.running) stop(child);
    this.running.clear();
  }
}

/** Runs `command` in the user's shell; never rejects for the command's own failure (see `code`). */
export function exec(command: string, options: ExecOptions, defaults: { cwd: string }, children: Children): Promise<ExecResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? EXEC_TIMEOUT_MS);
  const maxBytes = Math.max(0, options.maxBytes ?? EXEC_MAX_BYTES);
  const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : process.env.SHELL || "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnChild(shell, args, { cwd: options.cwd ?? defaults.cwd, env: merged(options.env), detached: groups, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    children.track(child);
    const out = { stdout: "", stderr: "", bytes: 0 };
    let timedOut = false;
    let capped = false;
    const take = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      if (capped) return;
      const room = maxBytes - out.bytes;
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      out[stream] += piece.toString("utf8");
      out.bytes += piece.length;
      // Over the cap: what came so far is kept and the command is ended.
      if (chunk.length > room) { capped = true; stop(child); }
    };
    child.stdout!.on("data", take("stdout"));
    child.stderr!.on("data", take("stderr"));
    const timer = setTimeout(() => { timedOut = true; stop(child); }, timeoutMs);
    timer.unref();
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: out.stdout, stderr: out.stderr, code: timedOut || capped ? null : code, timedOut });
    });
  });
}

/** Starts `file` with `args` (no shell), for output that streams. */
export function spawn(file: string, args: string[], options: SpawnOptions, defaults: { cwd: string }, children: Children): ChildHandle {
  const child = spawnChild(file, args, { cwd: options.cwd ?? defaults.cwd, env: merged(options.env), detached: groups, stdio: ["pipe", "pipe", "pipe"] });
  children.track(child);
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdin!.on("error", () => {});
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    // A file that does not exist: an exit with no code, not an unhandled error in the host.
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  return {
    pid: child.pid ?? null,
    onStdout: (fn) => { child.stdout!.on("data", fn); return () => child.stdout!.off("data", fn); },
    onStderr: (fn) => { child.stderr!.on("data", fn); return () => child.stderr!.off("data", fn); },
    onExit: (fn) => {
      let live = true;
      void exited.then(({ code, signal }) => { if (live) fn(code, signal); });
      return () => { live = false; };
    },
    write: (text) => { if (!child.stdin!.destroyed) child.stdin!.write(text); },
    kill: () => stop(child),
    exited,
  };
}
