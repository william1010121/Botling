// Main's side of the core process: start it, route answers to whoever asked, pass events on, and
// restart it if it dies. Requests that were waiting when it died fail with `core_unavailable`; the
// renderer sees a new epoch and takes a fresh snapshot. Nothing is re-sent automatically.
import { utilityProcess, type UtilityProcess } from "electron";
import {
  EventEnvelope, PROTOCOL_VERSION, ResponseEnvelope, describeIssues,
  type Command, type EventEnvelope as EventEnvelopeT, type ResponseEnvelope as ResponseEnvelopeT, type ResultOf, type CommandType,
} from "../contract";

export interface CoreClientOptions {
  script: string;
  env: Record<string, string>;
  onEvent: (event: EventEnvelopeT) => void;
  audit: (entry: string) => void;
}

interface Pending { resolve: (response: ResponseEnvelopeT) => void }

export class CoreClient {
  private child: UtilityProcess | null = null;
  private pending = new Map<string, Pending>();
  private counter = 0;
  private restarts = 0;
  private quitting = false;
  pid: number | undefined;

  constructor(private options: CoreClientOptions) {}

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

  /** Asks the core to stop its work and exit (it ends running agent trees on SIGTERM). */
  stop(): Promise<void> {
    this.quitting = true;
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), 4_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
  }
}
