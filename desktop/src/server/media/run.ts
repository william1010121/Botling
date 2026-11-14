// Runs one external tool for a media job: at a lower priority (`nice -n 10`), with a time limit, its output kept short.
// While it runs, its pid is in `<variants>/.tmp/tool.pid`, so a botlingd killed mid-job (SIGKILL does not reach the
// child) stops the leftover tool at the next start (`killLeftoverTool`) instead of letting it run on.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { MediaTools } from "./tools";

export interface ToolRun {
  code: number | null;
  signal: string | null;
  stdout: string;
  /** The last 4 KB of stderr. */
  stderr: string;
}

export class ToolError extends Error {
  constructor(readonly tool: string, readonly run: ToolRun) {
    super(`${tool} failed (${run.signal ?? `exit ${run.code}`}): ${run.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 500)}`);
    this.name = "ToolError";
  }
}

const STDOUT_LIMIT = 1024 * 1024;
const STDERR_TAIL = 4096;

export interface RunOptions {
  timeoutMs: number;
  /** Where the running tool's pid is written (and removed after). */
  pidFile?: string;
  signal?: AbortSignal;
}

/** Runs `tool args…` under `nice` (when found); rejects with `ToolError` on a non-zero exit or a timeout. */
export function runTool(tools: MediaTools, tool: string, args: string[], options: RunOptions): Promise<ToolRun> {
  const command = tools.paths.nice ?? tool;
  const argv = tools.paths.nice ? ["-n", "10", tool, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ["ignore", "pipe", "pipe"] });
    if (options.pidFile && child.pid) {
      try { writeFileSync(options.pidFile, `${child.pid} ${basename(tool)}\n`); } catch { /* best effort */ }
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (stdout.length < STDOUT_LIMIT) stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_TAIL); });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    const abort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", abort, { once: true });
    const done = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (options.pidFile) rmSync(options.pidFile, { force: true });
    };
    child.on("error", (error) => { done(); reject(error); });
    child.on("close", (code, signal) => {
      done();
      const run = { code, signal, stdout, stderr };
      if (code === 0) resolve(run);
      else reject(new ToolError(basename(tool), run));
    });
  });
}

/** Tools a media job may leave running (the names `runTool` writes in the pid file). */
const OUR_TOOLS = new Set(["ffmpeg", "ffprobe", "qpdf", "pdftoppm", "sips", "qlmanage"]);

/**
 * At start: a tool a killed botlingd left running (its pid file names it, and that pid still runs that tool) is
 * stopped. Returns the pid stopped, or null.
 */
export function killLeftoverTool(pidFile: string): number | null {
  let text: string;
  try { text = readFileSync(pidFile, "utf8"); } catch { return null; }
  rmSync(pidFile, { force: true });
  const [pidText, name] = text.trim().split(/\s+/);
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 1 || !name || !OUR_TOOLS.has(name)) return null;
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
  const command = (ps.stdout ?? "").trim();
  if (!command || basename(command) !== name) return null;
  try { process.kill(pid, "SIGKILL"); return pid; } catch { return null; }
}
