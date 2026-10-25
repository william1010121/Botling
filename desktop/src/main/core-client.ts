// Main's side of the core process: start it, route answers to whoever asked, pass events on, and
// restart it if it dies. Requests that were waiting when it died fail with `core_unavailable`; the
// renderer sees a new epoch and takes a fresh snapshot. Nothing is re-sent automatically.
import { MessageChannelMain, utilityProcess, type UtilityProcess } from "electron";
import { PluginChildren } from "./plugin-children";
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
}

interface Pending { resolve: (response: ResponseEnvelopeT) => void }

export class CoreClient {
  private child: UtilityProcess | null = null;
  private pending = new Map<string, Pending>();
  private counter = 0;
  private restarts = 0;
  private quitting = false;
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
      void this.endHosts();
      for (const [id, pending] of this.pending) {
        pending.resolve({ v: PROTOCOL_VERSION, id, ok: false, error: { code: "core_unavailable", message: "The core process stopped." } });
      }
      this.pending.clear();
      if (this.quitting) return;
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
    this.child?.postMessage({ v: PROTOCOL_VERSION, cancel: id });
  }

  /** Asks the core to stop its work and exit (it tidies idle bots, then ends running agent trees on SIGTERM). */
  stop(): Promise<void> {
    this.quitting = true;
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      // Awake bots tidy their notes before the core exits (BOTLING_QUIT_TIDY_MS, 15 s at most each, in parallel).
      const timer = setTimeout(() => { void this.endHosts().then(resolve); }, Number(this.options.env.BOTLING_QUIT_TIDY_MS ?? 15_000) + 5_000);
      child.once("exit", () => { clearTimeout(timer); void this.endHosts().then(resolve); });
      child.kill();
    });
  }
}
