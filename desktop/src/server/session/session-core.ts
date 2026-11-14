// The session core (M2 step 4, protocol v1 §5.2, §8.3, §9, §11, §13.1): what one front end's session does whatever
// carries it. The local socket (session.ts, M1's behaviour) and a remote device's encrypted session (remote-session.ts)
// are thin shells around it: they decode frames, authenticate the hello and write frames their own way.
//
//   hello (first frame; checked by the shell)                → welcome {serverId, protocol, next for this origin…};
//                                                              the hello's outbox is taken as commands
//   sub / unsub / ack / history                              → LogHub (bot streams and this server's `srv:` stream);
//                                                              a bot stream's live frames come from the live channel,
//                                                              through the connection's LiveGate (≤ 10 frames/s)
//   live.resync                                              → a whole-segment frame (through the gate)
//   cmd                                                      → IntentRuntime, under the scope the shell states;
//                                                              cmd.result / cmd.retry come back through the reply sink.
//                                                              One queue's commands run one after another, in the
//                                                              order the session carried them (D58); a copy the owner
//                                                              could not keep (a gap it would wait on forever), or
//                                                              could not settle (the store failed, a handler threw),
//                                                              ends the session with bye{unsettled}, so the front end
//                                                              re-sends from its outbox
//   cancel                                                   → SlotEngine.cancel, always answered (D59): the stored
//                                                              cmd.result when too late (also once the slot's handler
//                                                              began: it waits for that outcome), else cancel.noted;
//                                                              a cancel that cannot be committed ends the session the
//                                                              same way
//   req                                                      → the reads the shell allows, answered by the engine (`res`)
//   content.find / content.open, shell.done                  → local socket only (the role table refuses them elsewhere)
//   admin                                                    → local socket only: pairing, the cluster's recovery code,
//                                                              devices (M2 step 5, server/pairing); the session then
//                                                              hears `admin.event`s. Requests and answers are never
//                                                              logged (they carry the recovery code and pairing links).
//   ping                                                     → nothing (any frame counts as heard)
//
// botlingd pings after 15 s of its own silence and drops a session it has not heard from for 45 s (§5.2; fe-link does
// the same the other way).
import { ContractError, type Command, type CommandType } from "../../contract";
import { encodeFrame, encodeResFrames, encodeWireFrame, PROTOCOL_VERSION, type Cursor, type ServerState, type WireMessage, queueKey, type AdminEvent, type AdminOp, type CmdBody, type Message, type MessageOf, type Scope, type SessionKind, type StreamId } from "../../protocol";
import { DEAD_AFTER_MS, PING_AFTER_MS } from "../../session";
import type { TurnEngine } from "../effects";
import { routeOf, type IntentRuntime } from "../intents";
import { cancelAnswer } from "../slots";
import { readStream, type LogHub, type LogReader } from "../log";
import type { LiveChannel, LiveSubscription } from "../live";
import type { ShellBridge } from "../shell-bridge";
import { LiveGate, type LiveGateClock } from "./live-gate";

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

/** Pairing and devices for the local socket's `admin` requests (server/pairing). */
export interface AdminHost {
  /** The `res` result of one request; throws (with an optional `code`) to refuse it. */
  handle(op: AdminOp): Promise<unknown>;
  onEvent(listener: (event: AdminEvent) => void): () => void;
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
  /** Local `admin` requests (M2 step 5); without it they are answered with an error. */
  admin?: AdminHost;
  /** M3 step 7: peer servers' states and their `srv:` tables from this server's copies (none on a lone server). */
  tables?: SessionTables;
}

/** What a front end's session reads of peer servers and their tables (server/replica/peer-tables.ts, server/peer). */
export interface SessionTables {
  /** Every peer server as `welcome.servers` lists it. */
  peers(): Array<{ id: string; name: string; state: ServerState; since: number | null }>;
  /** A peer's state changed (`peer{serverId, state, since}` to front ends, §10.5). */
  onPeer(listener: (peer: { id: string; state: ServerState; since: number | null }) => void): () => void;
  /** A peer's `srv:` table, served from this server's copy (not the log hub). */
  isPeerTable(stream: string): boolean;
  subscribe(stream: string, cursor: Cursor | null, sink: (message: WireMessage) => boolean): { close(): void };
}

export interface SessionOptions {
  helloTimeoutMs?: number;
  pingAfterMs?: number;
  deadAfterMs?: number;
  /** Bytes waiting to be written (socket buffer, or a remote session's send queue) above which the session is dropped. */
  maxBuffered?: number;
  liveIntervalMs?: number;
  liveClock?: LiveGateClock;
}

/** §5.2: `ping` after 15 s of silence, dead after 45 s heard nothing (the session layer's constants, step 3). */
export { DEAD_AFTER_MS, PING_AFTER_MS };
export const HELLO_TIMEOUT_MS = 10_000;
export const MAX_BUFFERED = 32 * 1024 * 1024;

/** A refusal the shell gives for a frame: a `bye` reason and its detail. */
export interface ShellRefusal { reason: MessageOf<"bye">["reason"]; detail: string }

export abstract class SessionCore {
  protected readonly lives = new Map<string, LiveSubscription>();
  protected readonly gate: LiveGate;
  protected reader: LogReader | null = null;
  protected state: "hello" | "open" | "closed" = "hello";
  protected deviceId: string | null = null;
  protected lastHeard = Date.now();
  protected lastSent = Date.now();
  private readonly timers: Array<ReturnType<typeof setTimeout>> = [];
  private readonly closedHandlers: Array<() => void> = [];
  /** Serializes `sub`s, so a slow one (a rewind, a new bot stream) never lets a later frame on the same stream pass it. */
  private subChain: Promise<void> = Promise.resolve();
  /** One promise chain per command queue (D58, `queueCmd`). */
  private readonly cmdChains = new Map<string, Promise<void>>();
  private adminEvents: (() => void) | null = null;
  /** M3 step 7: feeds of peers' tables this front end subscribed to, and its listener of peer states. */
  private readonly tableFeeds = new Map<string, { close(): void }>();
  private peerEvents: (() => void) | null = null;
  /** Settles when the session closes (a cancel waiting on a running handler stops waiting for this session). */
  private readonly closedSignal: Promise<void>;

  /** The session kind frames are encoded and decoded for (local socket or not). */
  protected abstract readonly kind: SessionKind;

  protected constructor(protected readonly host: SessionHost, protected readonly options: SessionOptions = {}) {
    this.gate = new LiveGate((frame) => this.send(frame, streamOf(frame)), { intervalMs: options.liveIntervalMs ?? 100, ...(options.liveClock ? { clock: options.liveClock } : {}) });
    this.closedSignal = new Promise<void>((resolve) => this.closedHandlers.push(resolve));
  }

  get device(): string | null { return this.deviceId; }
  get isOpen(): boolean { return this.state === "open"; }

  onClosed(handler: () => void): void { this.closedHandlers.push(handler); }

  // ---------------------------------------------------------------------------------------------
  // What a shell provides

  /** False when nothing can be written any more (the transport is gone). */
  protected abstract get writable(): boolean;
  /** Writes encoded text frames in order, whole or not at all; false when they were not written. */
  protected abstract writeTexts(texts: string[], t: string, what?: string): boolean;
  /** After a `bye`: lets what was written leave, then ends the transport. */
  protected abstract endTransport(): void;
  /** On close: drops the transport (unless endTransport is already letting it go). */
  protected abstract destroyTransport(): void;
  /** Checks the hello (who may open this session); a refusal ends it with that `bye`. */
  protected abstract checkHello(hello: MessageOf<"hello">): ShellRefusal | null;
  /** The scope this server states for a front end's command (§11.1), or a refusal that ends the session. */
  protected abstract cmdScope(body: CmdBody): { scope: Scope } | ShellRefusal;
  /** Why this `req` is not answered here (an error `res`), or null. */
  protected abstract reqRefusal(cmd: Command): { code: "bad_request" | "forbidden"; message: string } | null;
  /** Checked before every frame once the hello came (remote: the device is still valid); a refusal ends the session. */
  protected frameRefusal(): ShellRefusal | null { return null; }
  /** Why this stream may not be read here, or null. */
  protected subRefusal(_stream: StreamId): string | null { return null; }
  /** After the welcome went. */
  protected opened(_hello: MessageOf<"hello">): void {}
  /** On close, before the handlers run. */
  protected closing(): void {}

  // ---------------------------------------------------------------------------------------------
  // Sending

  /** Starts the hello timeout and the keepalive (ping after 15 s of silence, dead after 45 s heard nothing). */
  protected startTimers(): void {
    const helloTimer = setTimeout(() => { if (this.state === "hello") this.bye("malformed", "hello first, within 10 s"); }, this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    helloTimer.unref?.();
    this.timers.push(helloTimer);
    const keepalive = setInterval(() => this.keepalive(), Math.min(5_000, Math.max(50, Math.floor((this.options.pingAfterMs ?? PING_AFTER_MS) / 3))));
    keepalive.unref?.();
    this.timers.push(keepalive);
  }

  /**
   * Sends one frame; false when it was not sent (the session is closed, or the frame cannot be encoded). A frame that
   * cannot be encoded (over the frame limit, malformed) is never written: the refusal is logged with its reason and
   * `what` (the request it answers, when there is one).
   */
  send(message: Message, what?: string): boolean {
    if (this.state === "closed" || !this.writable) return false;
    const encoded = encodeFrame(message, "server", this.kind);
    if (!encoded.ok) {
      this.host.log(`session: cannot send ${message.t}${what ? ` (${what})` : ""}: ${encoded.detail}`);
      return false;
    }
    return this.writeTexts([encoded.text], message.t, what);
  }

  /** Sends a frame of the M3 wire set (a `rows` batch of a peer's table, §8.2); false when it was not sent. */
  protected sendWire(message: WireMessage): boolean {
    if (this.state === "closed" || !this.writable) return false;
    const encoded = encodeWireFrame(message, "server", this.kind);
    if (!encoded.ok) { this.host.log(`session: cannot send ${message.t}: ${encoded.detail}`); return false; }
    return this.writeTexts([encoded.text], message.t);
  }

  /**
   * Answers a `req`. A result over the frame limit goes as `res.part`s (the front end joins them); one too large even
   * for those is answered with an error naming the command, so the front end's request ends instead of waiting.
   */
  protected sendRes(message: MessageOf<"res">, command: string): boolean {
    if (this.state === "closed" || !this.writable) return false;
    const encoded = encodeResFrames(message, "server", this.kind);
    if (encoded.ok) return this.writeTexts(encoded.texts, encoded.texts.length > 1 ? "res.part" : "res", command);
    this.host.log(`session: cannot send res (${command}): ${encoded.detail}`);
    if (!message.ok) return false;
    return this.send({ t: "res", req: message.req, ok: false, error: { code: "internal", message: `The answer to ${command} is too large to send: ${encoded.detail}`.slice(0, 2_000) } }, command);
  }

  /** Ends the session with a `bye` (§5.2). */
  bye(reason: MessageOf<"bye">["reason"], detail?: string): void {
    if (this.state === "closed") return;
    this.send({ t: "bye", reason, ...(detail ? { detail: detail.slice(0, 500) } : {}) });
    this.endTransport();
    this.close();
  }

  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.adminEvents?.();
    this.adminEvents = null;
    this.peerEvents?.();
    this.peerEvents = null;
    for (const feed of this.tableFeeds.values()) feed.close();
    this.tableFeeds.clear();
    for (const timer of this.timers) { clearTimeout(timer); clearInterval(timer); }
    for (const sub of this.lives.values()) sub.close();
    this.lives.clear();
    this.gate.close();
    this.reader?.close();
    this.reader = null;
    this.closing();
    this.destroyTransport();
    for (const handler of this.closedHandlers.splice(0)) handler();
  }

  private keepalive(): void {
    if (this.state !== "open") return;
    const now = Date.now();
    if (now - this.lastHeard > (this.options.deadAfterMs ?? DEAD_AFTER_MS)) { this.bye("dead", "nothing heard for 45 s"); return; }
    if (now - this.lastSent >= (this.options.pingAfterMs ?? PING_AFTER_MS)) this.send({ t: "ping", at: now });
  }

  // ---------------------------------------------------------------------------------------------
  // Receiving

  /** One decoded frame from the front end. */
  protected onMessage(message: Message): void {
    if (this.state === "hello") {
      if (message.t !== "hello") { this.bye("role", "hello first"); return; }
      this.onHello(message);
      return;
    }
    const refused = this.frameRefusal();
    if (refused) { this.bye(refused.reason, refused.detail); return; }
    switch (message.t) {
      case "hello": this.bye("role", "one hello per session"); return;
      case "sub": this.queueSub(message.stream, message.cursor); return;
      case "unsub": this.unsub(message.stream); return;
      case "ack": this.reader?.ack(message.stream, message.cursor); return;
      case "history": this.history(message); return;
      case "live.resync": this.gate.resync(message.stream); return;
      case "cmd": { const { t: _t, ...body } = message; this.queueCmd(body as CmdBody); return; }
      case "cancel": void this.cancel(message); return;
      case "req": void this.req(message); return;
      case "content.find": case "content.open": void this.content(message); return;
      case "admin": void this.admin(message); return;
      case "shell.done": this.host.shell.answer(this.shellWindow(), message); return;
      case "ping": return;
      case "bye": this.close(); return;
      default: this.host.log(`session: ${message.t} is not served here`);
    }
  }

  /**
   * A shell's handling of one decoded frame threw. A `cmd` or `cancel` that was not settled ends the session (D58): the
   * front end re-sends from its outbox; anything else is logged and the session goes on.
   */
  protected frameFailed(message: Message, error: unknown): void {
    this.host.log(`session: ${message.t} failed: ${errorText(error)}`);
    if (message.t === "cmd" || message.t === "cancel") this.unsettled(`${message.t} for slot ${message.slot.n} failed: ${errorText(error)}`);
  }

  /** D58: a `cmd` or `cancel` this session carried could not be settled: end the session, the outbox re-sends. */
  private unsettled(detail: string): void {
    if (this.state === "open") this.bye("unsettled", detail);
  }

  /** The window the shell bridge knows this session as (the local session itself). */
  protected shellWindow(): { send(message: Message): boolean } { return this; }

  private onHello(hello: MessageOf<"hello">): void {
    const refused = this.checkHello(hello);
    if (refused) { this.bye(refused.reason, refused.detail); return; }
    this.state = "open";
    this.deviceId = hello.deviceId;
    this.reader = this.host.hub.attach((message) => { this.send(message, streamOf(message)); this.onLogFrame(message); });
    let next: Record<string, number> = {};
    try { next = this.host.nextFor(hello.deviceId, hello.originEpoch); } catch (error) { this.host.log(`session: next for ${hello.deviceId}: ${errorText(error)}`); }
    this.send({
      t: "welcome", serverId: this.host.serverId, protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION }, minFeVersion: this.host.minFeVersion,
      rosterDigest: null, servers: [{ id: this.host.serverId, name: this.host.serverName, state: "live", since: this.host.startedAt }, ...this.peerList()], next, views: {},
    } as MessageOf<"welcome">);
    const tables = this.host.tables;
    if (tables) this.peerEvents = tables.onPeer((peer) => { this.send({ t: "peer", serverId: peer.id, state: peer.state, since: peer.since } as MessageOf<"peer">); });
    this.opened(hello);
    // `cursors` / `want`: fe-link sends a `sub` for each after the welcome (§13.1); taking both would send two snaps.
    for (const body of hello.outbox) this.queueCmd(body);
  }

  // ---------------------------------------------------------------------------------------------
  // Streams

  private peerList(): Array<{ id: string; name: string; state: ServerState; since: number | null }> {
    try { return (this.host.tables?.peers() ?? []).slice(0, 63); } catch (error) { this.host.log(`session: peers: ${errorText(error)}`); return []; }
  }

  private queueSub(stream: StreamId, cursor: MessageOf<"sub">["cursor"]): void {
    this.subChain = this.subChain.then(() => this.sub(stream, cursor)).catch((error) => this.host.log(`session: sub ${stream}: ${errorText(error)}`));
  }

  private async sub(stream: StreamId, cursor: MessageOf<"sub">["cursor"]): Promise<void> {
    const reader = this.reader;
    if (!reader || this.state !== "open") return;
    const refused = this.subRefusal(stream);
    if (refused) { this.host.log(`session: sub ${stream} refused (${refused})`); return; }
    const tables = this.host.tables;
    if (tables?.isPeerTable(stream)) {
      // M3 step 7: a peer's `srv:` table comes from this server's copy as `rows` batches, never from the log hub.
      this.tableFeeds.get(stream)?.close();
      this.tableFeeds.set(stream, tables.subscribe(stream, cursor, (frame) => this.sendWire(frame)));
      return;
    }
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
    const feed = this.tableFeeds.get(stream);
    if (feed) { feed.close(); this.tableFeeds.delete(stream); return; }
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
    if (this.subRefusal(request.stream)) return;
    const page = this.reader?.history(request);
    if (page) { this.send(page, `history of ${request.stream}`); return; }
    // An unknown line (2.x answers not_found): an empty page of the current incarnation ends the paging.
    const row = readStream(this.host.hub.reader(), request.stream);
    if (row) this.send({ t: "history.page", req: request.req, stream: request.stream, logId: row.logId as MessageOf<"history.page">["logId"], messages: [], hasMore: false, older: 0 });
  }

  // ---------------------------------------------------------------------------------------------
  // Commands and requests

  /**
   * D58: one session is a FIFO stream, and its commands for one queue (origin, originEpoch, target) reach the slot
   * engine in that order, each after the one before it settled. Without this a later copy could be checked before its
   * predecessor committed: a legacy copy is then dropped and an intent copy held, and nothing in the session re-sends
   * it. Different queues do not wait for each other (a slow legacy handler holds up only its own queue).
   */
  private queueCmd(body: CmdBody): void {
    const key = queueKey(body.slot);
    const run = (this.cmdChains.get(key) ?? Promise.resolve())
      .then(() => this.cmd(body))
      .catch((error) => {
        this.host.log(`session: cmd ${body.cmd.type} (slot ${body.slot.n}) not settled: ${errorText(error)}`);
        this.unsettled(`cmd ${body.cmd.type} (slot ${body.slot.n}) was not settled: ${errorText(error)}`);
      });
    this.cmdChains.set(key, run);
    void run.then(() => { if (this.cmdChains.get(key) === run) this.cmdChains.delete(key); });
  }

  protected async cmd(body: CmdBody): Promise<void> {
    if (this.state === "closed") return;
    const stated = this.cmdScope(body);
    if (!("scope" in stated)) { this.bye(stated.reason, stated.detail); return; }
    const { scope } = stated;
    const reply = (message: Message) => { this.send(message, body.cmd.type); };
    const route = routeOf(body.cmd.type).kind;
    try {
      const status = route === "intent" || route === "legacy"
        ? await this.host.runtime.receive(body, { scope, reply })
        // A read or app command sent as a command: the core's own handler, under a slot like any legacy command.
        : await this.host.runtime.legacy.receive(body, { scope, reply });
      // D58: the copy waits on a slot this session did not send before it, and the owner kept no copy: the session
      // broke FIFO. End it; the front end re-attaches and re-sends its outbox in slot order.
      if (status.status === "dropped") this.unsettled(`cmd ${body.cmd.type} (slot ${body.slot.n}) came before an earlier slot of its queue (D58)`);
    } catch (error) {
      // Nothing was stored (the store failed, or the handler threw before its result was kept). Going on would let the
      // next slot of this queue be checked without its predecessor (D58): end the session; the outbox re-sends both.
      this.host.log(`session: cmd ${body.cmd.type} (slot ${body.slot.n}) not settled: ${errorText(error)}`);
      this.unsettled(`cmd ${body.cmd.type} (slot ${body.slot.n}) was not settled: ${errorText(error)}`);
    }
  }

  private async cancel(message: MessageOf<"cancel">): Promise<void> {
    if (this.cancelRefusal(message)) return;
    try {
      // A cancel for a slot whose handler already began waits for that outcome (SlotEngine.cancel); a session that
      // closes meanwhile stops waiting (its front end sends the cancel again on its next session).
      const status = await Promise.race([this.host.runtime.slots.cancel(message.slot), this.closedSignal.then(() => null)]);
      // D59: every cancel is answered, the stored outcome or `cancel.noted` (after the cancel committed).
      if (status && this.state !== "closed") this.send(cancelAnswer(message.slot, status));
    } catch (error) {
      this.host.log(`session: cancel of slot ${message.slot.n} not settled: ${errorText(error)}`);
      this.unsettled(`cancel of slot ${message.slot.n} was not settled: ${errorText(error)}`);
    }
  }

  /** True when this cancel is not this session's to send (it was answered with a `bye`). */
  protected cancelRefusal(_message: MessageOf<"cancel">): boolean { return false; }

  /** A local admin request (the role table keeps `admin` off every other session; checked here again). */
  private async admin(message: MessageOf<"admin">): Promise<void> {
    const admin = this.host.admin;
    if (!this.kind.local || !admin) {
      this.send({ t: "res", req: message.req, ok: false, error: { code: "forbidden", message: "admin requests are taken only on the local socket of a server that pairs" } }, "admin");
      return;
    }
    this.adminEvents ??= admin.onEvent((event) => { this.send({ t: "admin.event", event }, "admin.event"); });
    try {
      const result = await admin.handle(message.op);
      this.send({ t: "res", req: message.req, ok: true, result: result ?? null }, `admin ${message.op.op}`);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const text = `${typeof code === "string" ? `${code}: ` : ""}${errorText(error)}`;
      this.send({ t: "res", req: message.req, ok: false, error: { code: "conflict", message: text.slice(0, 2_000) } }, `admin ${message.op.op}`);
    }
  }

  private async req(message: MessageOf<"req">): Promise<void> {
    const cmd = message.cmd as Command;
    const refused = this.reqRefusal(cmd);
    if (refused) {
      this.send({ t: "res", req: message.req, ok: false, error: refused }, cmd.type);
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
export function streamOf(message: Message): string | undefined {
  const stream = (message as { stream?: unknown }).stream;
  return typeof stream === "string" ? stream : undefined;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
