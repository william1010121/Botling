// Shared pieces of the M1 acceptance runs (test/acceptance/*.test.ts): botlingd as a child process (plain Node, or
// Electron's Node with ELECTRON_RUN_AS_NODE=1), a front end on the real fe-link (durable SQLite outbox) over the Unix
// socket, reads of server.db after the fact, a load sampler and the JSON report. No window, no Electron main.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { FeLink, type FeLinkOptions } from "../../src/fe-link";
import { SqliteFeStorage } from "../../src/fe-link/sqlite-storage";
import { unixDial } from "../../src/main-v3/unix-dial";
import { ServerClient } from "../../src/main-v3/server-client";
import type { EventEnvelope } from "../../src/contract";
import { botlingdEnv, botlingdScript } from "../botlingd-harness";
import { until } from "../helpers";

export { MAIN, ScriptClient, testRoot } from "../botlingd-harness";

/** Where the JSON reports go (V3_ACCEPT_REPORT_DIR, else the OS temp folder). */
export function reportDir(): string {
  const dir = process.env.V3_ACCEPT_REPORT_DIR || join(tmpdir(), "botling-v3-accept");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeReport(name: string, data: unknown): string {
  const file = join(reportDir(), `${name}.json`);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

export type Runtime = "node" | "electron";
export function runtimeOf(): Runtime { return process.env.V3_ACCEPT_RUNTIME === "electron" ? "electron" : "node"; }

/** The binary that runs botlingd: this Node, or Electron's binary as Node (no window: ELECTRON_RUN_AS_NODE=1). */
export function runtimeCommand(runtime: Runtime): { bin: string; env: Record<string, string> } {
  if (runtime === "node") return { bin: process.execPath, env: {} };
  const bin = createRequire(import.meta.url)("electron") as unknown as string;
  return { bin, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** botlingd started with `start`, like the harness's BotlingdProcess, with a choice of runtime. */
export class Daemon {
  readonly child: ChildProcessWithoutNullStreams;
  stdout = "";
  stderr = "";
  readonly startedAt = Date.now();
  readyAt = 0;
  private readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(readonly dataDir: string, extra: Record<string, string> = {}, readonly runtime: Runtime = runtimeOf()) {
    const { bin, env } = runtimeCommand(runtime);
    this.child = spawn(bin, ["--no-warnings", botlingdScript, "start"], { env: { ...botlingdEnv(dataDir, extra), ...env }, stdio: "pipe" });
    this.closed = new Promise((resolve) => this.child.once("close", (code, signal) => resolve({ code, signal })));
    createInterface({ input: this.child.stdout }).on("line", (line) => { this.stdout += `${line}\n`; if (line.startsWith("ready ") && !this.readyAt) this.readyAt = Date.now(); });
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-65_536); });
  }

  get pid(): number { return this.child.pid!; }
  get socket(): string { return join(this.dataDir, "botlingd.sock"); }
  get token(): string { return readFileSync(join(this.dataDir, "botlingd.token"), "utf8").trim(); }
  get log(): string { try { return readFileSync(join(this.dataDir, "botlingd.log"), "utf8"); } catch { return ""; } }
  get alive(): boolean { return this.child.exitCode === null && this.child.signalCode === null; }

  async ready(timeout = 90_000): Promise<number> {
    await until(() => {
      if (!this.alive) throw new Error(`botlingd exited ${this.child.exitCode ?? this.child.signalCode}\n${this.stderr}\n${this.log.slice(-4_000)}`);
      return this.readyAt > 0;
    }, { timeout, every: 10, what: "botlingd ready" });
    return this.readyAt - this.startedAt;
  }

  kill(): void { if (this.alive) this.child.kill("SIGKILL"); }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.alive) this.child.kill(signal);
    return this.closed;
  }

  exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> { return this.closed; }
}

/** A botlingd CLI command (status, backup, stop) run to its end. */
export function cli(dataDir: string, args: string[], extra: Record<string, string> = {}): { code: number | null; stdout: string; stderr: string } {
  const { bin, env } = runtimeCommand(runtimeOf());
  const run = spawnSync(bin, ["--no-warnings", botlingdScript, ...args], { env: { ...botlingdEnv(dataDir, extra), ...env }, encoding: "utf8", timeout: 90_000 });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** A front end on the real fe-link: the durable outbox and cursors in a node:sqlite file, the Unix-socket dial. */
export async function openLink(dataDir: string, storageFile: string, options: Partial<FeLinkOptions> = {}): Promise<{ link: FeLink; storage: SqliteFeStorage }> {
  const storage = new SqliteFeStorage(storageFile);
  const tokenFile = join(dataDir, "botlingd.token");
  const link = await FeLink.open({
    storage, dial: unixDial({ path: join(dataDir, "botlingd.sock") }), deviceId: "accept", feVersion: "3.0.0-m1",
    reconnectMinMs: 100, reconnectMaxMs: 400, offlineAfterMs: 60_000,
    get token() { try { return readFileSync(tokenFile, "utf8").trim(); } catch { return undefined; } },
    ...options,
  });
  return { link, storage };
}

/** Reads server.db read-only (botlingd stopped or running: WAL readers do not block it). */
export function readDb<T>(dataDir: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(dataDir, "server.db"), { readOnly: true });
  try { return read(db); } finally { db.close(); }
}

/** The 1-minute load average every second while a run goes. */
export class LoadSampler {
  readonly samples: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  start(): this {
    this.samples.push(loadavg()[0]);
    this.timer = setInterval(() => this.samples.push(loadavg()[0]), 1_000);
    this.timer.unref();
    return this;
  }
  stop(): { min: number; max: number; mean: number; n: number } {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return summarizeLoad(this.samples);
  }
}

export function summarizeLoad(samples: number[]): { min: number; max: number; mean: number; n: number } {
  if (!samples.length) return { min: 0, max: 0, mean: 0, n: 0 };
  const round = (x: number) => Math.round(x * 100) / 100;
  return { min: round(Math.min(...samples)), max: round(Math.max(...samples)), mean: round(samples.reduce((a, b) => a + b, 0) / samples.length), n: samples.length };
}

export function percentiles(values: number[], ps = [50, 95, 99]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b);
  const out: Record<string, number> = { n: sorted.length };
  if (!sorted.length) return out;
  for (const p of ps) out[`p${p}`] = round3(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
  out.max = round3(sorted[sorted.length - 1]);
  out.mean = round3(sorted.reduce((a, b) => a + b, 0) / sorted.length);
  return out;
}
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Kills the fake engine's leftover processes (heads orphaned by a SIGKILL of botlingd) named in a pid file. */
export function killPids(pidFile: string): number {
  if (!existsSync(pidFile)) return 0;
  let n = 0;
  for (const line of readFileSync(pidFile, "utf8").split("\n")) {
    const pid = Number(line.trim());
    if (!pid) continue;
    try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); n++; } catch { /* gone */ }
  }
  return n;
}

/** Processes still running from this worktree's out/ (plugin hosts, heads) other than the given pids. */
export function strays(except: number[] = []): string[] {
  const lines: string[] = [];
  for (const pattern of [join(botlingdScript, "..", ".."), join(botlingdScript, "..", "..", "..", "test", "fixtures")]) {
    const run = spawnSync("pgrep", ["-fl", pattern], { encoding: "utf8" });
    lines.push(...run.stdout.split("\n").filter(Boolean));
  }
  return [...new Set(lines)].filter((line) => !except.includes(Number(line.split(" ")[0])));
}

export function removeTree(path: string): void { rmSync(path, { recursive: true, force: true }); }

/** "w0001 w0002 …": a scripted reply whose prefix shows how far it got. */
export function scriptedWords(n: number, tag = "w"): string {
  return Array.from({ length: n }, (_, i) => `${tag}${String(i + 1).padStart(4, "0")}`).join(" ");
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Botling 3's window main, headless: the main-v3 ServerClient + renderer adapter with a fake renderer port.


export interface HeadlessWindow {
  client: ServerClient;
  /** Every envelope the renderer would get, with the time it was emitted. */
  events: Array<{ at: number; envelope: EventEnvelope }>;
  audit: string[];
}

/**
 * A window main on botlingd's socket. Its durable state (outbox, cursors) is `<appData>/electron/fe-link.sqlite`, as
 * the real window's; `launch` never starts botlingd (the run starts and kills it).
 */
export async function openWindow(dataDir: string, appData: string): Promise<HeadlessWindow> {
  mkdirSync(appData, { recursive: true });
  const events: HeadlessWindow["events"] = [];
  const audit: string[] = [];
  const client = new ServerClient(
    { script: join(botlingdScript, "..", "..", "core", "main.cjs"), env: { BOTLING_APP_DATA_DIR: appData, BOTLING_SERVER_DATA_DIR: dataDir }, onEvent: (envelope) => events.push({ at: Date.now(), envelope }), audit: (line) => audit.push(line) },
    { launch: () => undefined, link: { reconnectMinMs: 100, reconnectMaxMs: 400, offlineAfterMs: 60_000 } },
  );
  client.start();
  await client.ready();
  return { client, events, audit };
}
