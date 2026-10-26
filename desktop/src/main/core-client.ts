// Main's side of the core process: start it, route answers to whoever asked, pass events on, and
// restart it if it dies. Requests that were waiting when it died fail with `core_unavailable`; the
// renderer sees a new epoch and takes a fresh snapshot. Nothing is re-sent automatically.
import { MessageChannelMain, utilityProcess, type UtilityProcess } from "electron";
import { PluginChildren } from "./plugin-children";
import { PASS_WHILE_DRAINING, type HoldMode, type SwapPorts } from "./core-swap";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EventEnvelope, PROTOCOL_VERSION, ResponseEnvelope, describeIssues,
  type Command, type EventEnvelope as EventEnvelopeT, type ResponseEnvelope as ResponseEnvelopeT, type ResultOf, type CommandType,
} from "../contract";

export interface CoreClientOptions {
  script: string;
  env: Record<string, string>;
  onEvent: (event: EventEnvelopeT) => void;
  audit: (entry: string) => void;
  /** Seals or opens a plugin secret (safeStorage); throws when it cannot. */
  seal?: (op: "seal" | "open", text: string) => string;
  /** The plugin host's utility-process entry (out/host/host-utility.mjs); main never runs another file for it. */
  hostScript?: string;
  /** The core's process ledger (`<data>/core/children.json`): plugins' process groups are kept there too. */
  ledgerFile?: string;
  /** Developer mode's asks (core/self-update.ts): a picture of the main window, or quitting for an install. */
  app?: (op: "screenshot" | "quit" | "installRelease") => Promise<{ ok: boolean; file?: string; error?: string }>;
}

interface Pending { resolve: (response: ResponseEnvelopeT) => void }
interface Held { cmd: Command; id: string; resolve: (response: ResponseEnvelopeT) => void }

export class CoreClient {
  private child: UtilityProcess | null = null;
  private pending = new Map<string, Pending>();
  private counter = 0;
  private restarts = 0;
  private quitting = false;
  /** Cores ended by a hot swap: their exit is no crash (no restart). */
  private retired = new WeakSet<UtilityProcess>();
  /** During a hot swap: requests held for the new core (main/core-swap.ts). */
  private holdMode: HoldMode = "none";
  private held: Held[] = [];
  /** Answers to `drain`, by id. */
  private drains = new Map<number, (answer: { ok: boolean; entries?: unknown; interrupted?: unknown; error?: unknown }) => void>();
  private drainCount = 0;
  pid: number | undefined;
  /** Plugin hosts main runs for the core (utility processes), by the core's id for each. */
  private hosts = new Map<number, UtilityProcess>();

  /** Plugins' own process groups, per host (ended with their host). */
  readonly pluginChildren: PluginChildren;

  constructor(private options: CoreClientOptions) {
    this.pluginChildren = new PluginChildren({
      ...(options.ledgerFile ? { ledgerFile: options.ledgerFile } : {}),
      protectedPids: () => [...(this.pid ? [this.pid] : []), ...this.hostPids],
      log: (text) => process.stderr.write(`[plugin host] ${text}\n`),
    });
  }

  /** A newer release main found: the core posts the update notice in the main bot's chat (core/self-update.ts). */
  announceRelease(release: { version: string; name: string; url: string; current: string; unavailable: string | null }) {
    this.child?.postMessage({ botling: "release", ...release });
  }

  async commitUpdateBoot(): Promise<void> {
    this.options.env.BOTLING_UPDATE_PENDING = "0";
    await this.call({ type: "boot.commit" });
  }

  /** Pids of the plugin hosts running now (for tests). */
  get hostPids(): number[] { return [...this.hosts.values()].map((host) => host.pid ?? -1); }
  /** Process groups plugins started in the running hosts (for tests). */
  get pluginGroups(): number[] { return [...this.hosts.keys()].flatMap((id) => this.pluginChildren.of(id)); }

  /**
   * The core asks main to start or end its plugin host (core/plugins/utility-host.ts). Main forks
   * only its own host script, with the folder and the allow-listed environment the core gives, and
   * hands the core one end of a MessageChannel; the host gets the other.
   */
  private host(raw: { op?: unknown; id?: unknown; cwd?: unknown; env?: unknown; graceMs?: unknown }) {
    const child = this.child;
    if (!child || typeof raw.id !== "number") return;
    const id = raw.id;
    if (raw.op === "kill") {
      const host = this.hosts.get(id);
      if (!host) { child.postMessage({ botling: "hostExit", id, code: null }); return; }
      host.kill();
      const grace = typeof raw.graceMs === "number" ? Math.min(Math.max(raw.graceMs, 0), 10_000) : 1_000;
      setTimeout(() => { if (this.hosts.get(id) === host && host.pid) { try { process.kill(host.pid, "SIGKILL"); } catch { /* gone */ } } }, grace).unref();
      return;
    }
    if (raw.op !== "start" || !this.options.hostScript) {
      child.postMessage({ botling: "hostFailed", id, error: "Main cannot start a plugin host." });
      return;
    }
    const env: Record<string, string> = {};
    if (raw.env && typeof raw.env === "object") {
      for (const [key, value] of Object.entries(raw.env as Record<string, unknown>)) if (typeof value === "string" && !key.startsWith("ELECTRON_")) env[key] = value;
    }
    let host: UtilityProcess;
    try {
      host = utilityProcess.fork(this.options.hostScript, [], {
        serviceName: "Botling Plugin Host", stdio: "pipe", env, ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
      });
    } catch (error) {
      child.postMessage({ botling: "hostFailed", id, error: String((error as Error)?.message ?? error).slice(0, 500) });
      return;
    }
    this.hosts.set(id, host);
    host.on("message", (message: { botling?: unknown; pid?: unknown } | null) => {
      if (message && typeof message === "object" && message.botling === "child") this.pluginChildren.add(id, message.pid);
    });
    host.stdout?.on("data", () => {});
    host.stderr?.on("data", (chunk) => process.stderr.write(`[plugin host] ${chunk}`));
    host.once("spawn", () => {
      const { port1, port2 } = new MessageChannelMain();
      host.postMessage({ botling: "port" }, [port1]);
      if (this.child === child) child.postMessage({ botling: "hostStarted", id, pid: host.pid ?? 0 }, [port2]);
      else host.kill();
    });
    host.once("exit", (code) => {
      if (this.hosts.get(id) === host) this.hosts.delete(id);
      // However it ended (shut down, killed, crashed), what its plugins started ends with it.
      void this.pluginChildren.end(id);
      if (this.child === child) child.postMessage({ botling: "hostExit", id, code });
    });
  }

  /** Ends every plugin host (the core went away, or the app quits) and what their plugins started. */
  private endHosts(): Promise<void> {
    for (const host of this.hosts.values()) host.kill();
    this.hosts.clear();
    return this.pluginChildren.endAll();
  }

  start() {
    const child = utilityProcess.fork(this.options.script, [], {
      serviceName: "Botling Core",
      stdio: "pipe",
      env: this.options.env,
    });
    this.child = child;
    child.stdout?.on("data", (chunk) => process.stdout.write(`[core:out] ${chunk}`));
    child.stderr?.on("data", (chunk) => process.stderr.write(String(chunk)));
    child.on("spawn", () => { this.pid = child.pid; });
    child.on("message", (message) => this.receive(message));
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      for (const answer of this.drains.values()) answer({ ok: false, error: "The core process stopped." });
      this.drains.clear();
      void this.endHosts();
      for (const [id, pending] of this.pending) {
        pending.resolve({ v: PROTOCOL_VERSION, id, ok: false, error: { code: "core_unavailable", message: "The core process stopped." } });
      }
      this.pending.clear();
      if (this.quitting || this.retired.has(child)) return;
      this.options.audit(`core exited with ${code}; restarting`);
      const delay = Math.min(250 * 2 ** this.restarts++, 10_000);
      setTimeout(() => this.start(), delay);
    });
  }

  private receive(message: unknown) {
    const raw = message as { botling?: unknown; id?: unknown; op?: unknown; text?: unknown } | null;
    if (raw && typeof raw === "object" && raw.botling === "host") {
      this.host(raw as Parameters<CoreClient["host"]>[0]);
      return;
    }
    if (raw && typeof raw === "object" && raw.botling === "drained") {
      if (typeof raw.id === "number") this.drains.get(raw.id)?.(raw as { ok: boolean });
      return;
    }
    if (raw && typeof raw === "object" && raw.botling === "app") {
      const child = this.child;
      const reply = (answer: { ok: boolean; file?: string; error?: string }) => child?.postMessage({ botling: "appDone", id: raw.id, ...answer });
      if (typeof raw.id !== "number" || (raw.op !== "screenshot" && raw.op !== "quit" && raw.op !== "installRelease") || !this.options.app) { reply({ ok: false, error: "Refused." }); return; }
      this.options.app(raw.op).then(reply, (error) => reply({ ok: false, error: String((error as Error)?.message ?? error).slice(0, 500) }));
      return;
    }
    if (raw && typeof raw === "object" && raw.botling === "seal") {
      // The core asks main to seal or open a plugin secret (it has no safeStorage of its own).
      const reply = (answer: Record<string, unknown>) => this.child?.postMessage({ botling: "sealed", id: raw.id, ...answer });
      if (typeof raw.id !== "number" || (raw.op !== "seal" && raw.op !== "open") || typeof raw.text !== "string" || raw.text.length > 100_000 || !this.options.seal) {
        reply({ ok: false, error: "Refused." });
        return;
      }
      try {
        reply({ ok: true, text: this.options.seal(raw.op, raw.text) });
      } catch (error) {
        reply({ ok: false, error: String((error as Error)?.message ?? error).slice(0, 500) });
      }
      return;
    }
    const event = EventEnvelope.safeParse(message);
    if (event.success) {
      this.restarts = 0;
      this.options.onEvent(event.data);
      return;
    }
    const response = ResponseEnvelope.safeParse(message);
    if (response.success) {
      const pending = this.pending.get(response.data.id);
      this.pending.delete(response.data.id);
      pending?.resolve(response.data);
      return;
    }
    this.options.audit(`dropped a malformed message from the core: ${describeIssues(event.error)}`);
  }

  /** Sends a command; resolves with the response (never rejects). */
  request(cmd: Command, id = `main.${++this.counter}`): Promise<ResponseEnvelopeT> {
    if (this.holdMode === "all" || (this.holdMode === "drain" && !PASS_WHILE_DRAINING.has(cmd.type))) {
      return new Promise((resolve) => this.held.push({ cmd, id, resolve }));
    }
    return this.send(cmd, id);
  }

  private send(cmd: Command, id: string): Promise<ResponseEnvelopeT> {
    return new Promise((resolve) => {
      if (!this.child) {
        resolve({ v: PROTOCOL_VERSION, id, ok: false, error: { code: "core_unavailable", message: "The core process is not running." } });
        return;
      }
      this.pending.set(id, { resolve });
      this.child.postMessage({ v: PROTOCOL_VERSION, id, cmd });
    });
  }

  /** Like request, for main's own use: the result, or throws. */
  async call<T extends CommandType>(cmd: Extract<Command, { type: T }>): Promise<ResultOf<T>> {
    const response = await this.request(cmd);
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
    return response.result as ResultOf<T>;
  }

  cancel(id: string) {
    const held = this.held.findIndex((request) => request.id === id);
    if (held >= 0) {
      const [request] = this.held.splice(held, 1);
      request!.resolve({ v: PROTOCOL_VERSION, id, ok: false, error: { code: "cancelled", message: "The request was cancelled." } });
      return;
    }
    this.child?.postMessage({ v: PROTOCOL_VERSION, cancel: id });
  }

  /**
   * The real ports of a core hot swap (main/core-swap.ts). `handoverFile` is the core's
   * swap-handover.json; self-checks run on scratch folders under `scratch`.
   */
  swapPorts(handoverFile: string, scratch: string): SwapPorts {
    const options = this.options;
    return {
      get script() { return options.script; },
      probe: (script) => this.probe(script, scratch),
      hold: (mode) => {
        this.holdMode = mode;
        // Let go: what was held goes to the core running now, in order.
        if (mode === "none") for (const request of this.held.splice(0)) void this.request(request.cmd, request.id).then(request.resolve);
      },
      drain: (timeoutMs, boundaryMs) => new Promise((resolve) => {
        const child = this.child;
        if (!child) { resolve({ ok: false, error: "The core process is not running." }); return; }
        const id = ++this.drainCount;
        const timer = setTimeout(() => { this.drains.delete(id); resolve({ ok: false, error: "The core did not finish draining." }); }, timeoutMs + boundaryMs + 30_000);
        this.drains.set(id, (answer) => {
          clearTimeout(timer);
          this.drains.delete(id);
          if (answer.ok) resolve({ ok: true, entries: Number(answer.entries) || 0, interrupted: Array.isArray(answer.interrupted) ? answer.interrupted.map(String) : [] });
          else resolve({ ok: false, error: String(answer.error ?? "Draining failed.") });
        });
        child.postMessage({ botling: "drain", id, timeoutMs, boundaryMs });
      }),
      undrain: () => this.child?.postMessage({ botling: "undrain" }),
      stop: () => this.retire(),
      start: async (script) => {
        this.options.script = script;
        this.restarts = 0;
        this.start();
        const deadline = Date.now() + 30_000;
        let last = "no answer";
        while (Date.now() < deadline) {
          if (!this.child) return `it exited (${last})`;
          const response = await Promise.race([
            this.send({ type: "settings.get" }, `main.swap.${++this.counter}`),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
          ]);
          if (response?.ok) return null;
          last = response ? `${response.error.code}: ${response.error.message}` : "no answer in 2 s";
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return last;
      },
      readHandover: () => { try { return readFileSync(handoverFile, "utf8"); } catch { return null; } },
      writeHandover: (text) => writeFileSync(handoverFile, text),
      log: (line) => this.options.audit(line),
    };
  }

  /** Ends the running core without a restart (its heads end without the tidy after a drain). */
  private retire(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    this.retired.add(child);
    return new Promise((resolve) => {
      const kill = setTimeout(() => { if (child.pid) { try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ } } }, 30_000);
      child.once("exit", () => { clearTimeout(kill); void this.endHosts().then(resolve); });
      child.kill();
    });
  }

  /**
   * A swap's self-check: `script` on a scratch data folder (nothing imported, no clocks, no CLI check) must
   * answer settings.get and chat.snapshot in this protocol version. Null: it did; else why not.
   */
  private probe(script: string, scratch: string): Promise<string | null> {
    let dir: string;
    try { dir = mkdtempSync(join(scratch, "core-probe-")); } catch (error) { return Promise.resolve(`no scratch folder: ${(error as Error).message}`); }
    const env: Record<string, string> = {
      ...this.options.env, BOTLING_DATA_DIR: dir, BOTLING_CORE_PROBE: "1", BOTLING_IMPORT_FROM: "", BOTLING_1X_DIR: "", BOTLING_UPDATE_PENDING: "0",
      BOTLING_ROUTINE_TICK_MS: "0", BOTLING_WATCH_MS: "0", BOTLING_COMPONENT_SCAN_MS: "0", BOTLING_WAITING_SCAN_MS: "0",
    };
    return new Promise((resolve) => {
      let child: UtilityProcess;
      let stderr = "";
      let settled = false;
      const done = (problem: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill(); } catch { /* gone */ }
        setTimeout(() => rmSync(dir, { recursive: true, force: true }), 2_000).unref();
        resolve(problem);
      };
      const timer = setTimeout(() => done(`it did not answer within 20 s${stderr ? `: ${stderr.slice(-500)}` : ""}`), 20_000);
      try {
        child = utilityProcess.fork(script, [], { serviceName: "Botling Core (self-check)", stdio: "pipe", env });
      } catch (error) {
        clearTimeout(timer);
        resolve(`it could not start: ${(error as Error).message}`);
        return;
      }
      child.stdout?.on("data", () => {});
      child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4_000); });
      child.once("exit", (code) => done(`it exited (${code})${stderr ? `: ${stderr.slice(-500)}` : ""}`));
      const answered = new Set<string>();
      child.on("message", (message: unknown) => {
        const raw = message as { botling?: unknown; id?: unknown; v?: unknown } | null;
        if (raw && typeof raw === "object" && raw.botling === "host") { child.postMessage({ botling: "hostFailed", id: raw.id, error: "Self-check." }); return; }
        if (raw && typeof raw === "object" && typeof raw.botling === "string") return;
        if (raw && typeof raw === "object" && "v" in raw && raw.v !== PROTOCOL_VERSION) { done(`it speaks protocol ${String(raw.v)}, this app ${PROTOCOL_VERSION}`); return; }
        const response = ResponseEnvelope.safeParse(message);
        if (!response.success) return;
        if (!response.data.ok) { done(`${response.data.id}: ${response.data.error.code}: ${response.data.error.message}`); return; }
        answered.add(response.data.id);
        if (answered.has("probe.settings") && answered.has("probe.snapshot")) done(null);
      });
      child.postMessage({ v: PROTOCOL_VERSION, id: "probe.settings", cmd: { type: "settings.get" } });
      child.postMessage({ v: PROTOCOL_VERSION, id: "probe.snapshot", cmd: { type: "chat.snapshot" } });
    });
  }

  /** Asks the core to stop its work and exit (it tidies idle bots, then ends running agent trees on SIGTERM). */
  stop(): Promise<void> {
    this.quitting = true;
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      // Awake bots tidy their notes before the core exits, in parallel, with no time limit as in 1.x
      // (`applicationShouldTerminate` waits for `putEveryoneToSleep`); BOTLING_QUIT_TIDY_MS sets one for tests.
      const limit = Number(this.options.env.BOTLING_QUIT_TIDY_MS);
      const timer = this.options.env.BOTLING_QUIT_TIDY_MS && Number.isFinite(limit) ? setTimeout(() => { void this.endHosts().then(resolve); }, limit + 5_000) : undefined;
      child.once("exit", () => { clearTimeout(timer); void this.endHosts().then(resolve); });
      child.kill();
    });
  }
}
