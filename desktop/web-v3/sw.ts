// Botling 3's service worker: the content bridge of a page that reaches its server through the relay (M2 step 14,
// protocol v1 §9A.4: "phone or browser page loaded from the relay … the page's service worker turns each range request
// into `content.get` over the end-to-end session and answers `206` with a pull stream; the relay never sees an HTTP
// request for content").
//
// - Scope `/v3/` (served as /v3/sw.js and registered by the shell with scope "./" only on the relay path).
// - It answers only `/v3/c/…` URLs the shell marked with `sw=1` (sw-wire.ts); it does not answer anything else, so
//   the page's own files, the tailnet path's content URLs, the WebSocket and every other request go to the network as
//   before. Clients: the top-level page and same-origin frames (the PDF viewer, the video player over the page). The
//   2.x chat frame is sandboxed with an opaque origin, which no worker controls (the step 9 spike), so on the relay
//   path the shell plays a line's video in its own player over the page.
// - A request: its range is planned as the server would (`planRange`, the 2.x range code), the read goes to the page's
//   shell over a MessagePort (`sw.get`), which sends `content.get` over the session and hands back `content.meta` and
//   each `content.chunk`. The answer's body is a pull stream: the worker grants the session more window
//   (`content.credit`) only as the player reads (the player's own buffer is the back-pressure, §9A.4), and a player that
//   seeks away or closes cancels the stream, which sends `content.cancel`.
// - Refusals keep the server's statuses (`goneStatus`), and WebKit's media loader gets the empty 200 with
//   `X-Botling-Status` (M2 step 11, `loaderRefusal`).
// - It stores nothing: no Cache Storage, no IndexedDB. What it keeps in memory while it runs is each content id's size
//   and type (a hash names one content forever), so a suffix range or a HEAD needs no extra read the second time.
import {
  answerHeaders, askedRange, bridgeTarget, goneStatus, loaderRefusal, planRange, SW_VERSION,
  type BridgeGone, type BridgeTarget, type RangePlan, type ShellToSw, type SwGet, type SwToShell,
} from "./sw-wire";

// The worker's globals (the DOM lib of this tree has no worker types; only what is used here).
interface WindowClientLike { id: string; url: string; postMessage(message: unknown, transfer?: Transferable[]): void }
interface ExtendableEventLike extends Event { waitUntil(promise: Promise<unknown>): void }
interface FetchEventLike extends ExtendableEventLike { request: Request; respondWith(response: Promise<Response> | Response): void }
interface MessageEventLike extends ExtendableEventLike { data: unknown; source: { postMessage(message: unknown): void } | null }
interface WorkerScope {
  location: Location;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void>; matchAll(options: { type: "window"; includeUncontrolled?: boolean }): Promise<WindowClientLike[]> };
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
}
const sw = self as unknown as WorkerScope;

/** The window a read may hold before the player reads more (the relay session's credit window, v1 §9A.4). */
const WINDOW = 1 << 20;
/** How long the page has to take a read before the request fails (no page holds a session). */
const TAKE_MS = 10_000;
/** A read's whole remainder (the server stops at the file's end). */
const TO_END = Number.MAX_SAFE_INTEGER;

const known = new Map<string, { size: number; type: string }>();
const counts = { requests: 0, gets: 0, cancels: 0, bytes: 0, refused: 0, statuses: {} as Record<string, number> };

sw.addEventListener("install", (event) => { event.waitUntil(sw.skipWaiting()); });
sw.addEventListener("activate", (event) => { event.waitUntil(sw.clients.claim()); });

sw.addEventListener("message", (event) => {
  const data = event.data as { botling3?: string } | null;
  if (data?.botling3 === "sw.ping") event.source?.postMessage({ botling3: "sw.pong", version: SW_VERSION, counts: { ...counts, statuses: { ...counts.statuses } } });
});

sw.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" && request.method !== "HEAD") return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;
  const target = bridgeTarget(url.pathname + url.search);
  if (!target) return;
  counts.requests += 1;
  event.respondWith(answer(request, target).then((response) => {
    counts.statuses[response.status] = (counts.statuses[response.status] ?? 0) + 1;
    return response;
  }));
});

const keyOf = (target: BridgeTarget) => `${target.owner}/${target.id}/${target.variant}`;

/** A refusal, as the server sends it (or WebKit's loader's empty 200). */
function refusal(request: Request, status: number, why: string): Response {
  counts.refused += 1;
  if (loaderRefusal(status, request.headers)) {
    return new Response(null, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Length": "0", "Cache-Control": "no-store", "X-Botling-Status": String(status), "X-Botling-Content": why } });
  }
  return new Response(`${why}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "X-Botling-Content": why } });
}

const goneRefusal = (request: Request, reason: BridgeGone) => refusal(request, goneStatus(reason), `gone; reason=${reason}`);

async function answer(request: Request, target: BridgeTarget): Promise<Response> {
  const header = request.headers.get("range");
  const head = request.method === "HEAD";
  let meta = known.get(keyOf(target));
  // The read to start before the size is known: the asked range itself when it names its start, else one byte (the
  // size comes with the first answer; the read is then planned again).
  if (!meta || head) {
    const ask = askedRange(header);
    const direct = !head && (ask.kind === "whole" || (ask.kind === "from" && (ask.end === null || ask.end >= ask.start)));
    const offset = direct && ask.kind === "from" ? ask.start : 0;
    const length = direct ? (ask.kind === "from" && ask.end !== null ? ask.end - ask.start + 1 : TO_END) : 1;
    const read = new Read(target, offset, length, request);
    const first = await read.meta;
    if ("gone" in first) return goneRefusal(request, first.gone);
    meta = first;
    known.set(keyOf(target), meta);
    const plan = planRange(header, meta.size);
    if (direct && plan.status !== 416 && plan.start === offset && plan.length > 0) return read.response(plan, meta);
    read.cancel();
    if (head || plan.status === 416 || plan.length === 0) return headersOnly(plan, meta);
    return new Read(target, plan.start, plan.length, request).respond(plan, meta, request);
  }
  const plan = planRange(header, meta.size);
  if (plan.status === 416 || plan.length === 0) return headersOnly(plan, meta);
  return new Read(target, plan.start, plan.length, request).respond(plan, meta, request);
}

function headersOnly(plan: RangePlan, meta: { size: number; type: string }): Response {
  return new Response(null, { status: plan.status, headers: answerHeaders(meta.type, plan, meta.size) });
}

/** One `content.get` through the page's session: its first answer (`meta`), then a pull stream of its bytes. */
class Read {
  readonly meta: Promise<{ size: number; type: string } | { gone: BridgeGone }>;
  private port: MessagePort | null = null;
  private settle!: (value: { size: number; type: string } | { gone: BridgeGone }) => void;
  private settled = false;
  private early: Uint8Array[] = [];
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private failure: BridgeGone | null = null;
  private enqueued = 0;
  private credited = 0;
  private received = 0;
  private done = false;
  private readonly ports: MessagePort[] = [];

  constructor(private readonly target: BridgeTarget, private readonly offset: number, private length: number, request: Request) {
    this.meta = new Promise((resolve) => { this.settle = resolve; });
    counts.gets += 1;
    request.signal?.addEventListener?.("abort", () => this.cancel());
    void this.start(target);
  }

  private resolve(value: { size: number; type: string } | { gone: BridgeGone }): void {
    if (this.settled) return;
    this.settled = true;
    this.settle(value);
  }

  private async start(target: BridgeTarget): Promise<void> {
    const windows = await sw.clients.matchAll({ type: "window" });
    if (!windows.length) { this.resolve({ gone: "no-session" }); return; }
    const message: SwGet = { botling3: "sw.get", target, offset: this.offset, length: this.length };
    // Every window of the page is asked; the shell that holds a session answers (the PDF viewer and the player over the
    // page do not listen). The first port that answers serves the read; any other is cancelled at once.
    for (const client of windows) {
      const channel = new MessageChannel();
      this.ports.push(channel.port1);
      channel.port1.onmessage = (event) => this.onPort(channel.port1, event.data as ShellToSw);
      try { client.postMessage(message, [channel.port2]); } catch { /* that window went away */ }
    }
    setTimeout(() => { if (!this.port) { this.closePorts(); this.resolve({ gone: "no-session" }); } }, TAKE_MS);
  }

  private onPort(port: MessagePort, message: ShellToSw): void {
    if (this.port === null && !this.done) {
      this.port = port;
      for (const other of this.ports) if (other !== port) { other.postMessage({ t: "cancel" } satisfies SwToShell); other.close(); }
    }
    if (port !== this.port) { port.postMessage({ t: "cancel" } satisfies SwToShell); port.close(); return; }
    if (message.t === "meta") { this.resolve({ size: message.size, type: message.type }); return; }
    if (message.t === "gone") { this.fail(message.reason); return; }
    if (message.t === "chunk") {
      const bytes = new Uint8Array(message.bytes);
      if (message.offset !== this.offset + this.received) { this.fail("deleted"); return; }
      this.received += bytes.byteLength;
      counts.bytes += bytes.byteLength;
      if (this.controller) { this.controller.enqueue(bytes); this.enqueued += bytes.byteLength; }
      else this.early.push(bytes);
      this.maybeClose();
    }
  }

  private fail(reason: BridgeGone): void {
    this.failure = reason;
    this.resolve({ gone: reason });
    if (this.controller && !this.done) { this.done = true; try { this.controller.error(new Error(`content gone: ${reason}`)); } catch { /* closed */ } }
    this.closePorts();
  }

  private maybeClose(): void {
    if (this.received < this.length || !this.controller || this.done) return;
    this.done = true;
    try { this.controller.close(); } catch { /* cancelled */ }
    this.closePorts();
  }

  private closePorts(): void {
    for (const port of this.ports) { port.onmessage = null; port.close(); }
    this.ports.length = 0;
  }

  /** The player seeked away or closed (or the read is not needed): the page sends `content.cancel`. */
  cancel(): void {
    if (this.done) return;
    this.done = true;
    counts.cancels += 1;
    this.port?.postMessage({ t: "cancel" } satisfies SwToShell);
    this.closePorts();
    this.resolve({ gone: "offline" });
  }

  /** Waits for the first answer, then answers with the planned range. */
  async respond(plan: RangePlan, meta: { size: number; type: string }, request: Request): Promise<Response> {
    const first = await this.meta;
    if ("gone" in first) return goneRefusal(request, first.gone);
    if (first.size !== meta.size) { this.cancel(); known.delete(keyOf(this.target)); return goneRefusal(request, "changed"); }
    return this.response(plan, meta);
  }

  /** The answer: the planned status and headers, and the bytes as a pull stream (credit as the player reads). */
  response(plan: RangePlan, meta: { size: number; type: string }): Response {
    // The server stops at the file's end: the planned length is what arrives.
    this.length = plan.length;
    const read = this;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        read.controller = controller;
        for (const bytes of read.early.splice(0)) { controller.enqueue(bytes); read.enqueued += bytes.byteLength; }
        if (read.failure) { read.done = true; controller.error(new Error(`content gone: ${read.failure}`)); return; }
        read.maybeClose();
      },
      pull(controller) {
        // What the player has taken from the queue so far is granted again to the session (v1 §9A.4 flow control).
        const queued = WINDOW - (controller.desiredSize ?? 0);
        const taken = read.enqueued - queued;
        if (taken > read.credited && !read.done && read.port) {
          read.port.postMessage({ t: "credit", bytes: taken - read.credited } satisfies SwToShell);
          read.credited = taken;
        }
      },
      cancel() { read.cancel(); },
    }, new ByteLengthQueuingStrategy({ highWaterMark: WINDOW }));
    return new Response(body, { status: plan.status, headers: answerHeaders(meta.type, plan, meta.size) });
  }
}
