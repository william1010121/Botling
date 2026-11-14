// The shell's side of the content bridge (M2 step 14, protocol v1 §9A.4): on the relay path the page registers its
// service worker (../sw.ts, scope /v3/) and serves the worker's reads over the session.
//
// - The worker posts `sw.get` with a MessagePort for each range a player asks for; the shell sends `content.get` over the
//   session (fe-link `postContent`) and passes `content.meta` and each `content.chunk` down the port (the bytes
//   transferred, never kept), and `content.gone` as a refusal. The worker's `credit` becomes `content.credit`, its
//   `cancel` (the player seeked away or closed) `content.cancel`, so the server stops at once.
// - A session that ends mid-read ends the read (`gone: offline`): the player asks again when it wants to.
// - The tailnet path never registers the worker, and the worker never answers a URL without the `sw=1` mark.
// - Nothing is stored: the bytes pass through memory once.
import type { ContentReadMessage, FeLink } from "../../src/fe-link";
import { markForBridge, type ShellToSw, type SwGet, type SwToShell } from "../sw-wire";

/** How long the page waits for the worker to control it before media falls back to the plain URLs. */
export const CONTROL_WAIT_MS = 5_000;
/** Reads kept in the diagnostics (the newest). */
const READS_KEPT = 200;

export interface BridgeRead { variant: string; offset: number; length: number; bytes: number; ms: number; end: "done" | "cancel" | "gone" | "open" | "offline"; reason?: string }

export interface BridgeDiagnostics {
  state: "off" | "registering" | "ready" | "failed";
  scope?: string;
  error?: string;
  gets: number;
  cancels: number;
  bytes: number;
  gone: number;
  reads: BridgeRead[];
}

export const newBridgeDiagnostics = (): BridgeDiagnostics => ({ state: "off", gets: 0, cancels: 0, bytes: 0, gone: 0, reads: [] });

/** The page's worker registration and its reads. */
export class SwBridge {
  /** True once the worker controls this page (media may then use bridge URLs). */
  readonly ready: Promise<boolean>;
  private resolveReady!: (on: boolean) => void;
  private readonly open = new Set<() => void>();
  private onMessage: ((event: MessageEvent) => void) | null = null;

  constructor(private readonly link: FeLink, private readonly diag: BridgeDiagnostics = newBridgeDiagnostics(), private readonly script = "./sw.js") {
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
  }

  /** The URL the bridge answers for a server content URL. */
  url(contentUrl: string): string { return markForBridge(contentUrl); }

  start(): void {
    const container = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!container) { this.diag.state = "failed"; this.diag.error = "no service worker in this browser"; this.resolveReady(false); return; }
    this.onMessage = (event: MessageEvent) => {
      const data = event.data as SwGet | null;
      if (data?.botling3 !== "sw.get" || !event.ports[0]) return;
      this.serve(data, event.ports[0]);
    };
    container.addEventListener("message", this.onMessage);
    container.startMessages?.();
    this.diag.state = "registering";
    const timer = setTimeout(() => { if (!container.controller) { this.diag.state = "failed"; this.diag.error = "the worker did not take the page"; this.resolveReady(false); } }, CONTROL_WAIT_MS);
    const controlled = () => { clearTimeout(timer); this.diag.state = "ready"; this.resolveReady(true); };
    container.register(this.script, { scope: "./" }).then((registration) => {
      this.diag.scope = new URL(registration.scope).pathname;
      if (container.controller) controlled();
      else container.addEventListener("controllerchange", () => { if (container.controller) controlled(); }, { once: true });
    }, (error: unknown) => {
      clearTimeout(timer);
      this.diag.state = "failed";
      this.diag.error = String((error as Error)?.message ?? error).slice(0, 200);
      this.resolveReady(false);
    });
  }

  stop(): void {
    if (this.onMessage) navigator.serviceWorker?.removeEventListener("message", this.onMessage);
    this.onMessage = null;
    for (const end of [...this.open]) end();
  }

  /** One read for the worker: `content.get` over the session, its answers down the port. */
  private serve(get: SwGet, port: MessagePort): void {
    const t0 = performance.now();
    const req = this.link.newReq();
    const read: BridgeRead = { variant: get.target.variant, offset: get.offset, length: get.length, bytes: 0, ms: 0, end: "open" };
    this.diag.reads.push(read);
    if (this.diag.reads.length > READS_KEPT) this.diag.reads.shift();
    this.diag.gets += 1;
    let expected = Number.POSITIVE_INFINITY;
    let finished = false;
    const send = (message: ShellToSw, transfer?: Transferable[]) => { try { port.postMessage(message, transfer ?? []); } catch { /* the worker went away */ } };
    const finish = (end: BridgeRead["end"], reason?: string) => {
      if (finished) return;
      finished = true;
      read.end = end;
      if (reason) read.reason = reason;
      read.ms = Math.round(performance.now() - t0);
      off();
      port.onmessage = null;
      port.close();
      this.open.delete(stop);
    };
    const stop = () => { if (!finished) { this.link.postContent({ t: "content.cancel", req }); finish("cancel"); } };
    this.open.add(stop);
    const off = this.link.onContent(req, (message: ContentReadMessage | null) => {
      if (message === null) { send({ t: "gone", reason: "offline" }); finish("offline"); return; }
      if (message.t === "content.meta") {
        expected = Math.max(0, Math.min(message.size, get.offset + get.length) - get.offset);
        send({ t: "meta", size: message.size, type: message.type });
        if (expected === 0) finish("done");
      } else if (message.t === "content.chunk") {
        const bytes = message.bytes.slice().buffer as ArrayBuffer;
        read.bytes += bytes.byteLength;
        this.diag.bytes += bytes.byteLength;
        send({ t: "chunk", offset: message.offset, bytes }, [bytes]);
        if (read.bytes >= expected) finish("done");
      } else {
        this.diag.gone += 1;
        send({ t: "gone", reason: message.reason });
        finish("gone", message.reason);
      }
    });
    port.onmessage = (event: MessageEvent) => {
      const message = event.data as SwToShell | null;
      if (finished || !message) return;
      if (message.t === "credit" && message.bytes > 0) this.link.postContent({ t: "content.credit", req, bytes: Math.min(Math.floor(message.bytes), 64 * 1024 * 1024) });
      else if (message.t === "cancel") { this.diag.cancels += 1; stop(); }
    };
    const { owner, id, variant, entry } = get.target;
    const sent = this.link.postContent({ t: "content.get", req, owner, id, variant, offset: get.offset, length: get.length, entry: entry as never });
    if (!sent) { send({ t: "gone", reason: "no-session" }); finish("offline", "no session"); }
  }
}
