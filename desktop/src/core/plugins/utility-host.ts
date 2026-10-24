// The plugin host as an Electron utility process (the user's call for packaged builds: no Node of
// its own to ship, and Electron's RunAsNode fuse can stay off). Only main can start a utility
// process, so the core asks main over its parent port; main forks `out/host/host-utility.mjs` (always
// that file, whatever the core says) with the environment and folder the core gives, joins the two
// with a MessageChannel and hands the core its end. From then on the core and the host talk
// directly, the same JSON-RPC lines as on stdio, still checked by host-client.ts. Main ends the host
// when the core asks, when the core exits, and when the app quits.
//
// Difference from the Node child: a utility process is not in a process group of its own, so a
// plugin's own child processes are not ended with it (see the README's gaps).
import type { HostHandlers, HostLauncher, HostProcess } from "./host-client";

/** The core's parent port as Electron gives it to a utility process. */
export interface ParentPortLike {
  postMessage(message: unknown): void;
}
/** A MessagePortMain as the core receives it. */
export interface PortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  on(event: "close", listener: () => void): void;
  start(): void;
  close(): void;
}

export type HostToCore =
  | { botling: "hostStarted"; id: number; pid: number }
  | { botling: "hostFailed"; id: number; error: string }
  | { botling: "hostExit"; id: number; code: number | null };

interface Running { handlers: HostHandlers; port: PortLike | null; queued: string[]; pid: number; exited: boolean; gone: Promise<void>; resolveGone: () => void }

export class UtilityHostLauncher {
  private next = 0;
  private readonly running = new Map<number, Running>();

  constructor(private readonly parent: ParentPortLike) {}

  /** For PluginHostClient (`HostCommand.launch`). */
  readonly launch: HostLauncher = (_script, cwd, env, handlers) => {
    const id = ++this.next;
    let resolveGone!: () => void;
    const gone = new Promise<void>((resolve) => (resolveGone = resolve));
    const entry: Running = { handlers, port: null, queued: [], pid: 0, exited: false, gone, resolveGone };
    this.running.set(id, entry);
    this.parent.postMessage({ botling: "host", op: "start", id, cwd, env });
    const process: HostProcess = {
      // Main tells the pid once it started; 0 until then (the client only logs it).
      get pid() { return entry.pid; },
      write: (line) => {
        if (entry.exited) return;
        const text = line.endsWith("\n") ? line.slice(0, -1) : line;
        if (entry.port) entry.port.postMessage(text);
        else entry.queued.push(text);
      },
      terminate: async (graceMs) => {
        if (entry.exited) return;
        this.parent.postMessage({ botling: "host", op: "kill", id, graceMs });
        await entry.gone;
      },
    };
    return process;
  };

  /** Main's messages about a host (with the port, for hostStarted). True: it was one of these. */
  receive(message: unknown, ports: readonly PortLike[] = []): boolean {
    const value = message as { botling?: string; id?: number; pid?: unknown; error?: unknown; code?: unknown } | null;
    if (!value || typeof value !== "object" || typeof value.id !== "number") return false;
    if (value.botling !== "hostStarted" && value.botling !== "hostFailed" && value.botling !== "hostExit") return false;
    const entry = this.running.get(value.id);
    if (!entry) return true;
    if (value.botling === "hostStarted") {
      const port = ports[0];
      if (!port) return true;
      entry.pid = typeof value.pid === "number" ? value.pid : 0;
      entry.port = port;
      port.on("message", (event) => {
        const data = event.data;
        if (typeof data === "string") entry.handlers.data(data + "\n");
        else if (data && typeof data === "object" && typeof (data as { stderr?: unknown }).stderr === "string") entry.handlers.stderr((data as { stderr: string }).stderr);
      });
      port.start();
      for (const line of entry.queued.splice(0)) port.postMessage(line);
    } else if (value.botling === "hostFailed") {
      entry.handlers.error(new Error(typeof value.error === "string" ? value.error.slice(0, 500) : "It did not start."));
      this.end(value.id, entry, 1);
    } else {
      this.end(value.id, entry, typeof value.code === "number" ? value.code : null);
    }
    return true;
  }

  private end(id: number, entry: Running, code: number | null) {
    if (entry.exited) return;
    entry.exited = true;
    this.running.delete(id);
    try { entry.port?.close(); } catch { /* already closed */ }
    entry.handlers.exit(code, null);
    entry.resolveGone();
  }
}
