// One front end's session on botlingd's local socket (M1 step 9, protocol v1 §5, §6.1, §8.3, §9, §11, §13.1).
//
//   hello (first frame; local token, constant-time compare)  → welcome {serverId, protocol, next for this origin…};
//                                                              the hello's outbox is taken as commands
//   sub / unsub / ack / history                              → LogHub (bot streams and this server's `srv:` stream);
//                                                              a bot stream's live frames come from the live channel,
//                                                              through the connection's LiveGate (≤ 10 frames/s)
//   live.resync                                              → a whole-segment frame (through the gate)
//   cmd                                                      → IntentRuntime (intents, legacy apply), scope `local`;
//                                                              cmd.result / cmd.retry come back through the reply sink
//   cancel                                                   → SlotEngine.cancel ("too late": the stored outcome)
//   req                                                      → read commands only, answered by the engine (`res`)
//   content.find / content.open                              → the content service (step 13), answered with the req
//   shell.done                                               → the shell bridge (the window answers the core's app ops)
//   ping                                                     → nothing (any frame counts as heard)
//
// Frames are checked with the protocol's role table (decodeFrame "fe", local): a malformed, oversized or out-of-role
// frame ends the session with its `bye`. botlingd pings after 15 s of its own silence and drops a session it has not
// heard from for 45 s (fe-link does the same the other way, §5.3). A front end that does not read (its socket buffer
// above `maxBuffered`) is dropped rather than let botlingd's memory grow: it re-attaches from its cursors.
import type { Socket } from "node:net";
import { ContractError, type Command, type CommandType } from "../../contract";
import { decodeFrame, encodeFrame, encodeResFrames, FrameSplitter, packFrame, PROTOCOL_VERSION, type CmdBody, type Message, type MessageOf, type StreamId } from "../../protocol";
import type { TurnEngine } from "../effects";
import { routeOf, type IntentRuntime } from "../intents";
import { readStream, type LogHub, type LogReader } from "../log";
import type { LiveChannel, LiveSubscription } from "../live";
import type { ShellBridge, ShellWindow } from "../shell-bridge";
import { LiveGate, type LiveGateClock } from "./live-gate";
import { sameToken } from "./paths";

/**
 * Commands a front end may send as `req` (answered at once, no slot): every read command, and the ones the 2.x renderer
 * sends as reads although the core changes a little for them: unread marks (chat.read, chat.shown), a Doctor run, a
 * worker's folder, a link a line asked to open, and a plugin web part's reports (loaded, failed, notice, link target;
 * kept in memory). Nothing they change is chat history; their events still go into the log. commands.ts classes them
 * `legacy` for when they come as a `cmd`.
 */
export const REQ_ALSO: ReadonlySet<CommandType> = new Set<CommandType>([
  "chat.read", "chat.shown", "doctor.run", "worker.cwd", "link.authorize", "plugins.linkTarget", "plugins.loaded", "plugins.failed", "plugins.notice",
]);
export function servedAsReq(type: CommandType): boolean {
  return routeOf(type).kind === "read" || REQ_ALSO.has(type);
}

/** The content path's local part (step 13, src/server/content `ContentService.handle`). */
export interface ContentHandler {
  handle(message: MessageOf<"content.find"> | MessageOf<"content.open">): Promise<MessageOf<"content.found"> | MessageOf<"content.file"> | MessageOf<"content.gone">>;
}

/** What every session shares: botlingd's parts. */
export interface SessionHost {
  serverId: string;
  /** Shown in `welcome.servers` (this Mac). */
  serverName: string;
  startedAt: number;
  minFeVersion: string;
  /** The local token as it is now (§6.1). */
  token(): string;
  hub: LogHub;
  live: LiveChannel;
  runtime: IntentRuntime;
  engine: TurnEngine;
  content: ContentHandler | null;
  shell: ShellBridge;
  /** `slots.next` per target for one origin incarnation (welcome.next, §11.4). */
  nextFor(origin: string, originEpoch: string): Record<string, number>;
  /** A bot the engine has whose stream is not made yet: make it (true: the stream exists now). */
  ensureBotStream(botId: string): Promise<boolean>;
  log(text: string): void;
}

export interface SessionOptions {
  helloTimeoutMs?: number;
  pingAfterMs?: number;
  deadAfterMs?: number;
  /** Bytes waiting in the socket's write buffer above which the session is dropped. */
  maxBuffered?: number;
  liveIntervalMs?: number;
  liveClock?: LiveGateClock;
}

const SESSION_KIND = { local: true } as const;

export class Session implements ShellWindow {
  private readonly splitter = new FrameSplitter();
  private readonly lives = new Map<string, LiveSubscription>();
  private readonly gate: LiveGate;
  private reader: LogReader | null = null;
  private state: "hello" | "open" | "closed" = "hello";
  private deviceId: string | null = null;
  private lastHeard = Date.now();
  private lastSent = Date.now();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly closedHandlers: Array<() => void> = [];
  /** Serializes `sub`s, so a slow one (a rewind, a new bot stream) never lets a later frame on the same stream pass it. */
  private subChain: Promise<void> = Promise.resolve();

  constructor(private readonly socket: Socket, private readonly host: SessionHost, private readonly options: SessionOptions = {}) {
    this.gate = new LiveGate((frame) => this.send(frame, streamOf(frame)), { intervalMs: options.liveIntervalMs ?? 100, ...(options.liveClock ? { clock: options.liveClock } : {}) });
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
    const helloTimer = setTimeout(() => { if (this.state === "hello") this.bye("malformed", "hello first, within 10 s"); }, options.helloTimeoutMs ?? 10_000);
    helloTimer.unref?.();
    this.timers.push(helloTimer);
    const keepalive = setInterval(() => this.keepalive(), Math.min(5_000, Math.max(50, Math.floor((options.pingAfterMs ?? 15_000) / 3))));
    keepalive.unref?.();
    this.timers.push(keepalive);
  }

  get device(): string | null { return this.deviceId; }
  get isOpen(): boolean { return this.state === "open"; }

  onClosed(handler: () => void): void { this.closedHandlers.push(handler); }

  /**
   * Sends one frame; false when it was not sent (the session is closed, or the frame cannot be encoded). A frame that
   * cannot be encoded (over the frame limit, malformed) is never written: the refusal is logged with its reason and
   * `what` (the request it answers, when there is one).
   */
  send(message: Message, what?: string): boolean {
    if (this.state === "closed" || this.socket.destroyed) return false;
    const encoded = encodeFrame(message, "server", SESSION_KIND);
    if (!encoded.ok) {
      this.host.log(`session: cannot send ${message.t}${what ? ` (${what})` : ""}: ${encoded.detail}`);
      return false;
    }
    return this.write([encoded.text]);
  }

  /** Writes encoded frames in order; false when the front end does not read (it is dropped) or the session ended. */
  private write(texts: string[]): boolean {
    if (this.state === "closed" || this.socket.destroyed) return false;
    if (this.socket.writableLength > (this.options.maxBuffered ?? 32 * 1024 * 1024)) {
      this.host.log(`session ${this.deviceId ?? "?"}: dropped, it does not read (${this.socket.writableLength} bytes waiting)`);
      this.close();
      return false;
    }
    for (const text of texts) this.socket.write(packFrame(text));
    this.lastSent = Date.now();
    return true;
  }

  /**
   * Answers a `req`. A result over the frame limit goes as `res.part`s (the front end joins them); one too large even
   * for those is answered with an error naming the command, so the front end's request ends instead of waiting.
   */
  private sendRes(message: MessageOf<"res">, command: string): boolean {
    if (this.state === "closed" || this.socket.destroyed) return false;
    const encoded = encodeResFrames(message, "server", SESSION_KIND);
    if (encoded.ok) return this.write(encoded.texts);
    this.host.log(`session: cannot send res (${command}): ${encoded.detail}`);
    if (!message.ok) return false;
    return this.send({ t: "res", req: message.req, ok: false, error: { code: "internal", message: `The answer to ${command} is too large to send: ${encoded.detail}`.slice(0, 2_000) } }, command);
  }

  /** Ends the session with a `bye` (§5.2). */
  bye(reason: MessageOf<"bye">["reason"], detail?: string): void {
    if (this.state === "closed") return;
    this.send({ t: "bye", reason, ...(detail ? { detail: detail.slice(0, 500) } : {}) });
    this.socket.end();
    this.close();
  }

  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    for (const timer of this.timers) { clearTimeout(timer); clearInterval(timer); }
    for (const sub of this.lives.values()) sub.close();
    this.lives.clear();
    this.gate.close();
    this.reader?.close();
    this.reader = null;
    this.host.shell.detach(this);
    if (!this.socket.destroyed) this.socket.destroy();
    for (const handler of this.closedHandlers.splice(0)) handler();
  }

  private keepalive(): void {
    if (this.state !== "open") return;
    const now = Date.now();
    if (now - this.lastHeard > (this.options.deadAfterMs ?? 45_000)) { this.bye("dead", "nothing heard for 45 s"); return; }
    if (now - this.lastSent >= (this.options.pingAfterMs ?? 15_000)) this.send({ t: "ping", at: now });
  }

  private onData(chunk: Buffer): void {
    if (this.state === "closed") return;
    this.lastHeard = Date.now();
    const split = this.splitter.push(chunk);
    if (!split.ok) { this.bye("too-large", split.detail); return; }
    for (const frame of split.frames) {
      if ((this.state as string) === "closed") return;
      const decoded = decodeFrame(frame, "fe", SESSION_KIND);
      if (!decoded.ok) { this.send(decoded.bye); this.socket.end(); this.close(); return; }
      try {
        this.onMessage(decoded.message);
      } catch (error) {
        this.host.log(`session: ${decoded.message.t} failed: ${errorText(error)}`);
      }
    }
  }

  private onMessage(message: Message): void {
    if (this.state === "hello") {
      if (message.t !== "hello") { this.bye("role", "hello first"); return; }
      this.onHello(message);
      return;
    }
    switch (message.t) {
      case "hello": this.bye("role", "one hello per session"); return;
      case "sub": this.queueSub(message.stream, message.cursor); return;
      case "unsub": this.unsub(message.stream); return;
      case "ack": this.reader?.ack(message.stream, message.cursor); return;
      case "history": this.history(message); return;
      case "live.resync": this.gate.resync(message.stream); return;
      case "cmd": { const { t: _t, ...body } = message; void this.cmd(body as CmdBody); return; }
      case "cancel": void this.cancel(message); return;
      case "req": void this.req(message); return;
      case "content.find": case "content.open": void this.content(message); return;
      case "shell.done": this.host.shell.answer(this, message); return;
      case "ping": return;
      case "bye": this.close(); return;
      default: this.host.log(`session: ${message.t} is not served here`);
    }
  }

  private onHello(hello: MessageOf<"hello">): void {
    if (!sameToken(hello.token, this.host.token())) { this.bye("token", "the local token does not match (read botlingd.token again)"); return; }
    this.state = "open";
    this.deviceId = hello.deviceId;
    this.reader = this.host.hub.attach((message) => { this.send(message, streamOf(message)); this.onLogFrame(message); });
    let next: Record<string, number> = {};
    try { next = this.host.nextFor(hello.deviceId, hello.originEpoch); } catch (error) { this.host.log(`session: next for ${hello.deviceId}: ${errorText(error)}`); }
    this.send({
      t: "welcome", serverId: this.host.serverId, protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION }, minFeVersion: this.host.minFeVersion,
      rosterDigest: null, servers: [{ id: this.host.serverId, name: this.host.serverName, state: "live", since: this.host.startedAt }], next, views: {},
    });
    // The desktop window answers the core's app ops (browser, screenshot, install, quit).
    if (hello.deviceId === "desktop") this.host.shell.attach(this);
    // `cursors` / `want`: fe-link sends a `sub` for each after the welcome (§13.1); taking both would send two snaps.
    for (const body of hello.outbox) void this.cmd(body);
  }

  // ---------------------------------------------------------------------------------------------
  // Streams

  private queueSub(stream: StreamId, cursor: MessageOf<"sub">["cursor"]): void {
    this.subChain = this.subChain.then(() => this.sub(stream, cursor)).catch((error) => this.host.log(`session: sub ${stream}: ${errorText(error)}`));
  }

  private async sub(stream: StreamId, cursor: MessageOf<"sub">["cursor"]): Promise<void> {
    const reader = this.reader;
    if (!reader || this.state !== "open") return;
    let result = await reader.sub(stream, cursor);
    if (!result.ok && result.reason === "unknown stream" && stream.startsWith("bot:")) {
      // A bot the core has but whose stream was not made yet (made at start, or by its first event).
      if (await this.host.ensureBotStream(stream.slice(4))) result = await reader.sub(stream, cursor);
    }
    if (!result.ok) { this.host.log(`session: sub ${stream} refused (${result.reason})`); return; }
    if (stream.startsWith("bot:") && !this.lives.has(stream) && this.state === "open") {
      // M1: the live subscription starts with the log one, not after the catch-up batches (§9.4); the receiver takes a
      // whole-segment frame at any time, so text is only shown early, never lost.
      let subscription: LiveSubscription | null = null;
      const send = this.gate.add(stream, () => subscription?.resync());
      subscription = this.host.live.subscribe(stream, send);
      this.lives.set(stream, subscription);
    }
  }

  private unsub(stream: StreamId): void {
    this.reader?.unsub(stream);
    this.lives.get(stream)?.close();
    this.lives.delete(stream);
    this.gate.remove(stream);
  }

  /** A reset makes the live receiver start over: ask for the whole segment. */
  private onLogFrame(message: Message): void {
    if (message.t === "reset" && this.lives.has(message.stream)) this.gate.resync(message.stream);
  }

  private history(request: MessageOf<"history">): void {
    const page = this.reader?.history(request);
    if (page) { this.send(page, `history of ${request.stream}`); return; }
    // An unknown line (2.x answers not_found): an empty page of the current incarnation ends the paging.
    const row = readStream(this.host.hub.reader(), request.stream);
    if (row) this.send({ t: "history.page", req: request.req, stream: request.stream, logId: row.logId as MessageOf<"history.page">["logId"], messages: [], hasMore: false, older: 0 });
  }

  // ---------------------------------------------------------------------------------------------
  // Commands and requests

  private async cmd(body: CmdBody): Promise<void> {
    const reply = (message: Message) => { this.send(message, body.cmd.type); };
    const route = routeOf(body.cmd.type).kind;
    try {
      if (route === "intent" || route === "legacy") await this.host.runtime.receive(body, { scope: "local", reply });
      // A read or app command sent as a command: the core's own handler, under a slot like any legacy command.
      else await this.host.runtime.legacy.receive(body, { scope: "local", reply });
    } catch (error) {
      // Nothing was stored (the store failed, or the handler threw before its result was kept): the outbox re-sends.
      this.host.log(`session: cmd ${body.cmd.type} (slot ${body.slot.n}) not settled: ${errorText(error)}`);
    }
  }

  private async cancel(message: MessageOf<"cancel">): Promise<void> {
    try {
      const status = await this.host.runtime.slots.cancel(message.slot);
      if (status.status === "too late") this.send(status.message);
    } catch (error) {
      this.host.log(`session: cancel of slot ${message.slot.n}: ${errorText(error)}`);
    }
  }

  private async req(message: MessageOf<"req">): Promise<void> {
    const cmd = message.cmd as Command;
    if (!servedAsReq(cmd.type)) {
      this.send({ t: "res", req: message.req, ok: false, error: { code: "bad_request", message: `${cmd.type} changes state: send it as a cmd, not a req.` } }, cmd.type);
      return;
    }
    try {
      const result = await this.host.engine.run(cmd);
      this.sendRes({ t: "res", req: message.req, ok: true, result: result ?? null }, cmd.type);
    } catch (error) {
      const wire = error instanceof ContractError ? error.toWire() : { code: "internal" as const, message: errorText(error).slice(0, 2_000) };
      this.sendRes({ t: "res", req: message.req, ok: false, error: wire }, cmd.type);
    }
  }

  private async content(message: MessageOf<"content.find"> | MessageOf<"content.open">): Promise<void> {
    const content = this.host.content;
    let answer: Message;
    try {
      if (!content) throw new Error("no content service");
      answer = await content.handle(message);
    } catch (error) {
      this.host.log(`session: ${message.t}: ${errorText(error)}`);
      answer = message.t === "content.find"
        ? { t: "content.found", req: message.req, ref: null }
        : { t: "content.gone", req: message.req, id: message.id, reason: "offline" };
    }
    // The answer carries the request's own `req` (the service echoes it; kept here whatever it says).
    this.send({ ...answer, req: message.req } as Message, message.t);
  }
}

/** The stream a frame is about, for a log line. */
function streamOf(message: Message): string | undefined {
  const stream = (message as { stream?: unknown }).stream;
  return typeof stream === "string" ? stream : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
