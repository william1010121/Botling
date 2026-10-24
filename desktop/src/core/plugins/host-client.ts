// The core's side of the plugin host (PluginHost.swift's `PluginHostClient`): it runs the existing
// Node plugin host (Web/host/src/host.ts, bundled to out/host/host.mjs) for every enabled plugin with a
// program part, and talks to it with one JSON-RPC message per line on stdin/stdout.
//
// The host is NOT the trusted core. It is a separate process in its own process group, started with
// a small allow-listed environment (no BOTLING_* variables, no core paths, no secrets of other
// plugins: each plugin's own secrets reach it only in that plugin's spec), in the plugin-data folder,
// with stderr captured and capped. Everything it sends is checked (shape, size, which methods may
// be called at all) before the core acts on it; what a request may do is decided in index.ts.
// If it dies it is started again after 300 ms and the plugins are loaded again; the plugins whose
// code it was running are blamed (three times in ten minutes turns one off).
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { processTreeAdapter, type ManagedProcess } from "../process/tree";
import type { HostSpec } from "./registry";

export interface HostCommand {
  /** Node, or Electron run as Node (development). */
  command: string;
  prefixArgs?: string[];
  env?: Record<string, string>;
}

export interface HostTiming { hook: number; call: number; load: number; ready: number; restartDelay: number }
export const DEFAULT_TIMING: HostTiming = { hook: 5_000, call: 60_000, load: 30_000, ready: 5_000, restartDelay: 300 };

const HostMessage = z.strictObject({
  id: z.number().int().nonnegative().optional(),
  method: z.string().max(200).optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string().max(20_000) }).optional(),
});
type HostMessage = z.infer<typeof HostMessage>;

/** The longest line the host may send (a reply text, a command's result). */
const MAX_LINE = 4 * 1024 * 1024;

/** Environment variables a plugin's program part may see (beside CCB_PLUGIN_HOST). */
const PASSED_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TZ|TMPDIR|TEMP|TMP|SYSTEMROOT|APPDATA|LOCALAPPDATA|USERPROFILE|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy)$/;

export type Outcome = { send: string } | { stoppedBy: string };

export class PluginHostClient {
  running = false;
  beforeSendHooks = 0;
  afterReplyHooks = 0;
  commands: string[] = [];
  problem: string | null = null;
  restarts = 0;
  /** The host asks the core for something (bots.list, routines.add, …). */
  onRequest: (method: string, params: unknown) => Promise<unknown> = async (method) => { throw new Error(`Unknown method "${method}".`); };
  /** The host tells the core something (notify, bots.send, …). */
  onNotification: (method: string, params: unknown) => void = () => {};
  /** A program part threw, or the host died while running it (`fatal`: it failed to load at all). */
  onPluginFailure: (plugin: string | null, message: string, fatal: boolean) => void = () => {};
  /** Registered hooks or commands changed. */
  onRegistered: () => void = () => {};

  private specs: HostSpec[] = [];
  private process: ManagedProcess | null = null;
  private buffer = "";
  private stderr = "";
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private blame = new Map<number, string>();
  private nextId = 1;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly script: string,
    private readonly node: HostCommand | null,
    private readonly cwd: string,
    private readonly log: (line: string) => void = () => {},
    readonly timing: HostTiming = DEFAULT_TIMING,
    private readonly onPid: (pid: number, alive: boolean) => void = () => {},
  ) {}

  get pid(): number | null { return this.process?.pid ?? null; }

  /** Runs exactly these plugins; with none, the host does not run at all. */
  update(specs: HostSpec[]) {
    if (JSON.stringify(specs) === JSON.stringify(this.specs) && (this.process || !specs.length)) return;
    this.specs = specs;
    if (!specs.length) this.stop();
    else if (!this.process) this.start();
    else if (this.running) void this.load();
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const process = this.process;
    if (process) void process.terminate({ graceMs: 1_000 });
  }

  /** Ends it and waits (quitting). */
  async shutdown() {
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const process = this.process;
    if (!process) return;
    try { await this.request("shutdown", {}, null, 1_000); } catch { /* it goes anyway */ }
    await process.terminate({ graceMs: 1_000 });
  }

  async waitUntilReady(timeout = this.timing.ready): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (!this.running && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    return this.running;
  }

  // ------------------------------------------------------------------------------------------
  // Hooks and calls

  /** Plugins may change or stop a message you send; no answer in time: it goes as it is. */
  async beforeSend(bot: unknown, text: string): Promise<Outcome> {
    if (this.beforeSendHooks <= 0 || !this.running) return { send: text };
    let result: unknown;
    try { result = await this.request("beforeSend", { bot, text }); } catch { return { send: text }; }
    const value = result as { cancel?: unknown; by?: unknown; text?: unknown } | null;
    if (value?.cancel === true) return { stoppedBy: typeof value.by === "string" ? value.by.slice(0, 200) : "" };
    return { send: typeof value?.text === "string" ? value.text.slice(0, 200_000) : text };
  }

  /** Plugins may change a bot's reply before it shows. */
  async afterReply(bot: unknown, text: string): Promise<string> {
    if (this.afterReplyHooks <= 0 || !this.running) return text;
    try {
      const result = await this.request("afterReply", { bot, text }) as { text?: unknown } | null;
      return typeof result?.text === "string" ? result.text.slice(0, 200_000) : text;
    } catch {
      return text;
    }
  }

  /** Tells plugins listening with `bots.onReply`. */
  replied(bot: unknown, text: string) {
    if (this.running) this.write({ method: "reply", params: { bot, text } });
  }

  command(id: string, args: unknown[] = []): Promise<unknown> {
    return this.request("command", { id, args }, id.split(".")[0] ?? null, this.timing.call);
  }

  /** A web part's `host.call` to its own program part. */
  webCall(plugin: string, method: string, params: unknown): Promise<unknown> {
    return this.request("web", { plugin, method, params }, plugin, this.timing.call);
  }

  request(method: string, params: unknown, plugin: string | null = null, timeout = this.timing.hook): Promise<unknown> {
    if (!this.process) return Promise.reject(new Error("The plugin host is not running."));
    const id = this.nextId++;
    if (plugin) this.blame.set(id, plugin);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(id, new Error(`The plugin host did not answer within ${timeout / 1000} s.`)), timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  private finish(id: number, outcome: Error | { value: unknown }) {
    this.blame.delete(id);
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    if (outcome instanceof Error) waiter.reject(outcome);
    else waiter.resolve(outcome.value);
  }

  // ------------------------------------------------------------------------------------------
  // The process

  private environment(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && PASSED_ENV.test(key)) env[key] = value;
    return { ...env, ...(this.node?.env ?? {}), CCB_PLUGIN_HOST: "1" };
  }

  private start() {
    if (!this.node) {
      this.problem = "Node not found, so plugins' program parts can't run.";
      return;
    }
    this.problem = null;
    this.stopping = false;
    mkdirSync(this.cwd, { recursive: true });
    let child: ManagedProcess;
    try {
      child = processTreeAdapter().spawn(this.node.command, [...(this.node.prefixArgs ?? []), this.script], { cwd: this.cwd, env: this.environment() });
    } catch (error) {
      this.problem = `The plugin host failed to start: ${(error as Error).message}`;
      return;
    }
    if (child.pid < 0) {
      this.problem = "The plugin host failed to start.";
      child.child.on("error", () => {});
      return;
    }
    this.process = child;
    this.buffer = "";
    this.onPid(child.pid, true);
    this.log(`plugin host started pid ${child.pid}`);
    child.child.stdout.setEncoding("utf8");
    child.child.stdout.on("data", (chunk: string) => this.read(chunk));
    child.child.stderr.setEncoding("utf8");
    child.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8_000); });
    child.child.stdin.on("error", () => {});
    child.child.on("error", (error) => { this.problem = `The plugin host failed: ${error.message}`; });
    child.child.on("exit", (code, signal) => this.exited(child, code, signal));
  }

  private exited(child: ManagedProcess, code: number | null, signal: NodeJS.Signals | null) {
    this.onPid(child.pid, false);
    if (child !== this.process) return;
    const blamed = new Set(this.blame.values());
    this.process = null;
    this.running = false;
    for (const id of [...this.pending.keys()]) this.finish(id, new Error("The plugin host exited."));
    if (this.stopping) return;
    const status = signal ?? code ?? "?";
    this.log(`plugin host exited (${status})${this.stderr ? `: ${this.stderr.slice(-400)}` : ""}`);
    if (!blamed.size) this.onPluginFailure(null, `The plugin host exited (${status})`, false);
    for (const plugin of blamed) this.onPluginFailure(plugin, `The plugin host crashed while running it (${status})`, false);
    this.restarts++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.process && !this.stopping && this.specs.length) this.start();
    }, this.timing.restartDelay);
    this.restartTimer.unref?.();
  }

  private write(message: HostMessage) {
    const stdin = this.process?.child.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(JSON.stringify(message) + "\n");
  }

  private read(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE && !this.buffer.includes("\n")) {
      this.log("plugin host: a line longer than 4 MB was dropped");
      this.buffer = "";
      return;
    }
    let at: number;
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (line.trim() && line.length <= MAX_LINE) this.receive(line);
    }
  }

  private receive(line: string) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return; }
    const parsed = HostMessage.safeParse(raw);
    if (!parsed.success) { this.log("plugin host: a malformed message was dropped"); return; }
    const message = parsed.data;
    if (message.method !== undefined) {
      if (message.id !== undefined) {
        const id = message.id;
        // The host asks the core for something: the core decides (index.ts), and answers once.
        void Promise.resolve()
          .then(() => this.onRequest(message.method!, message.params ?? null))
          .then((result) => this.write({ id, result: result ?? null }))
          .catch((error) => this.write({ id, error: { message: String((error as Error)?.message ?? error).slice(0, 2_000) } }));
      } else {
        this.notified(message.method, message.params ?? null);
      }
    } else if (message.id !== undefined) {
      this.finish(message.id, message.error ? new Error(message.error.message) : { value: message.result ?? null });
    }
  }

  private notified(method: string, params: unknown) {
    const value = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "ready":
        void this.load();
        return;
      case "registered": {
        const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
        this.beforeSendHooks = count(value.beforeSend);
        this.afterReplyHooks = count(value.afterReply);
        this.commands = Array.isArray(value.commands) ? value.commands.filter((id): id is string => typeof id === "string").slice(0, 500).map((id) => id.slice(0, 200)) : [];
        this.onRegistered();
        return;
      }
      case "pluginError":
        this.onPluginFailure(typeof value.plugin === "string" ? value.plugin : null, typeof value.message === "string" ? value.message.slice(0, 2_000) : "", false);
        return;
      default:
        this.onNotification(method, params);
    }
  }

  private async load() {
    let result: unknown;
    try {
      result = await this.request("load", { plugins: this.specs }, null, this.timing.load);
    } catch (error) {
      this.log(`plugin host: loading failed: ${(error as Error).message}`);
      return;
    }
    const failed = (result as { failed?: unknown })?.failed;
    for (const failure of Array.isArray(failed) ? failed : []) {
      const name = (failure as { name?: unknown })?.name;
      const why = (failure as { message?: unknown })?.message;
      if (typeof name === "string") this.onPluginFailure(name, `The program part failed to load: ${typeof why === "string" ? why.slice(0, 2_000) : ""}`, true);
    }
    this.running = true;
    this.onRegistered();
  }
}
