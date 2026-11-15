// The command half of a session (M7-S91, moved unchanged out of session-core.ts): what the core does with the frames
// that run work: `cmd` (one FIFO queue per origin, originEpoch and target, D58), `cancel` (D59), `req`, `slot.result`,
// `content.*`, uploads and `admin`. `SessionCore` keeps the transport, the streams and the hello; this class borrows what
// it needs from it through the `SessionLink` the core hands over, so the file imports nothing from session-core.ts.
import { ContractError, type Command } from "../../contract";
import { queueKey, type CmdBody, type Message, type MessageOf, type Scope, type SessionKind, Slot } from "../../protocol";
import { cancelAnswer } from "../slots";
import { routeOf } from "../intents";
import type { LocalPeerReadSink } from "../content/local-peer-read";
import type { SessionHost, SessionOptions } from "./session-types";

/** What `SessionCommands` borrows from the session that owns it (the core builds this in its constructor). */
export interface SessionLink {
  readonly host: SessionHost;
  readonly options: SessionOptions;
  /** The session itself: the key the admin host and the peer reads know it by. */
  readonly self: object;
  kind(): SessionKind;
  state(): "hello" | "open" | "closed";
  deviceId(): string | null;
  closedSignal(): Promise<void>;
  send(message: Message, what?: string): boolean;
  sendRes(message: MessageOf<"res">, command: string): boolean;
  bye(reason: MessageOf<"bye">["reason"], detail?: string, slot?: Slot): void;
  unsettled(detail: string, slot?: Slot): void;
  cmdScope(body: CmdBody): { scope: Scope } | { reason: MessageOf<"bye">["reason"]; detail: string };
  reqRefusal(cmd: Command): { code: "bad_request" | "forbidden"; message: string } | null;
  uploadRefusal(): string | null;
  cancelRefusal(message: MessageOf<"cancel">): boolean;
  writeChunk(message: MessageOf<"content.chunk">): boolean;
}

export class SessionCommands {
  // The bridge block: the names the moved bodies reach through `this`, one line each.
  private get host(): SessionHost { return this.session.host; }
  private get options(): SessionOptions { return this.session.options; }
  private get self(): object { return this.session.self; }
  private get kind(): SessionKind { return this.session.kind(); }
  private get state(): "hello" | "open" | "closed" { return this.session.state(); }
  private get deviceId(): string | null { return this.session.deviceId(); }
  private get closedSignal(): Promise<void> { return this.session.closedSignal(); }
  private send(message: Message, what?: string): boolean { return this.session.send(message, what); }
  private sendRes(message: MessageOf<"res">, command: string): boolean { return this.session.sendRes(message, command); }
  private bye(reason: MessageOf<"bye">["reason"], detail?: string, slot?: Slot): void { this.session.bye(reason, detail, slot); }
  private unsettled(detail: string, slot?: Slot): void { this.session.unsettled(detail, slot); }
  private cmdScope(body: CmdBody) { return this.session.cmdScope(body); }
  private reqRefusal(cmd: Command) { return this.session.reqRefusal(cmd); }
  private uploadRefusal(): string | null { return this.session.uploadRefusal(); }
  private cancelRefusal(message: MessageOf<"cancel">): boolean { return this.session.cancelRefusal(message); }
  private writeChunk(message: MessageOf<"content.chunk">): boolean { return this.session.writeChunk(message); }

  /** One promise chain per command queue (D58, `queueCmd`). */
  private readonly cmdChains = new Map<string, Promise<void>>();
  private adminEvents: (() => void) | null = null;
  /** M2 step 12: this session's upload frames, handled one after another in the order they came (D58). */
  private uploadChain: Promise<void> = Promise.resolve();
  /** Who this session's uploads belong to (a session-unique key). */
  private readonly uploadOwner = `s-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

  constructor(private readonly session: SessionLink) {}

  /** On close: stops hearing the admin host's events. */
  adminClosed(): void {
    this.adminEvents?.();
    this.adminEvents = null;
  }

  /** On close: this session's upload frames settle, then the store drops what it held for them. */
  uploadsEnded(): void {
    const uploads = this.host.uploads;
    if (uploads) void this.uploadChain.then(() => uploads.ended(this.uploadOwner)).catch(() => undefined);
  }

  /**
   * D58: one session is a FIFO stream, and its commands for one queue (origin, originEpoch, target) reach the slot
   * engine in that order, each after the one before it settled. Without this a later copy could be checked before its
   * predecessor committed: a legacy copy is then dropped and an intent copy held, and nothing in the session re-sends
   * it. Different queues do not wait for each other (a slow legacy handler holds up only its own queue).
   */
  queueCmd(body: CmdBody): void {
    this.chain(body.slot, () => this.cmd(body), `cmd ${body.cmd.type} (slot ${body.slot.n})`);
  }

  /** Runs `work` after everything queued before it for the same (origin, originEpoch, target); unsettled ends the session. */
  private chain(slot: CmdBody["slot"], work: () => Promise<void>, what: string): void {
    const key = queueKey(slot);
    const run = (this.cmdChains.get(key) ?? Promise.resolve())
      .then(work)
      .catch((error) => {
        this.host.log(`session: ${what} not settled: ${errorText(error)}`);
        this.unsettled(`${what} was not settled: ${errorText(error)}`, slot);
      });
    this.cmdChains.set(key, run);
    void run.then(() => { if (this.cmdChains.get(key) === run) this.cmdChains.delete(key); });
  }

  /** The peer that owns a target (M3 step 9), or null: this server decides it (always on a lone server). */
  private peerOwner(target: string): string | null {
    return this.host.forward?.ownerOf(target) ?? null;
  }

  /**
   * A cancel. For a target a peer owns it is committed into `fwdcancels` after the queue's earlier commands, so the
   * forwarder sends it after its row (D59); the owner's answer comes back through the relay. Otherwise as M2.
   */
  queueCancel(message: MessageOf<"cancel">): void {
    if (this.cancelRefusal(message)) return;
    const forward = this.host.forward;
    let owner: string | null;
    try { owner = this.peerOwner(message.slot.target); } catch (error) { this.unsettled(`cancel of slot ${message.slot.n}: no owner (${errorText(error)})`, message.slot); return; }
    if (!forward || owner === null) { void this.cancel(message, true); return; }
    this.chain(message.slot, async () => { if (this.state !== "closed") await forward.cancel(message.slot, owner); }, `cancel of slot ${message.slot.n}`);
  }

  async cmd(body: CmdBody): Promise<void> {
    if (this.state === "closed") return;
    const stated = this.cmdScope(body);
    if (!("scope" in stated)) { this.bye(stated.reason, stated.detail); return; }
    const { scope } = stated;
    const reply = (message: Message) => { this.send(message, body.cmd.type); };
    const route = routeOf(body.cmd.type).kind;
    // M2 step 12 (v1 §9A.9): a message with uploaded files is `held` until their bytes are in, then applied once. The
    // wait keeps this queue's later slots behind it (they cannot apply before it anyway); other queues and the upload
    // frames themselves go on. A session that ends meanwhile settles nothing: the front end re-sends the command and
    // resumes the upload on its next session.
    if (!(await this.awaitUploads(body))) return;
    try {
      // M3 step 9: a target a peer owns is committed into the forward queue, then `held` (never before the commit).
      const owner = this.peerOwner(body.slot.target);
      if (owner !== null) {
        await this.host.forward!.commit({ ...body, scope }, owner);
        if (this.state === "open") this.send({ t: "held", slot: body.slot, at: this.host.serverId } as MessageOf<"held">, body.cmd.type);
        return;
      }
      const status = route === "intent" || route === "legacy"
        ? await this.host.runtime.receive(body, { scope, reply })
        // A read or app command sent as a command: the core's own handler, under a slot like any legacy command.
        : await this.host.runtime.legacy.receive(body, { scope, reply });
      // D58: the copy waits on a slot this session did not send before it, and the owner kept no copy: the session
      // broke FIFO. End it; the front end re-attaches and re-sends its outbox in slot order.
      if (status.status === "dropped") this.unsettled(`cmd ${body.cmd.type} (slot ${body.slot.n}) came before an earlier slot of its queue (D58)`, body.slot);
    } catch (error) {
      // Nothing was stored (the store failed, or the handler threw before its result was kept). Going on would let the
      // next slot of this queue be checked without its predecessor (D58): end the session; the outbox re-sends both.
      this.host.log(`session: cmd ${body.cmd.type} (slot ${body.slot.n}) not settled: ${errorText(error)}`);
      this.unsettled(`cmd ${body.cmd.type} (slot ${body.slot.n}) was not settled: ${errorText(error)}`, body.slot);
    }
  }

  /** False when the session ended while the command waited for its files (nothing settled; the outbox re-sends). */
  private async awaitUploads(body: CmdBody): Promise<boolean> {
    const files = body.cmd.type === "chat.send" ? body.cmd.files ?? [] : [];
    const uploads = this.host.uploads;
    if (!files.length || !uploads) return true;
    const ids = files.map((file) => file.id);
    if (ids.every((id) => uploads.complete(id))) return true;
    // A copy of a slot already decided gets its stored outcome without waiting (its files may never come again).
    let next = 1;
    try { next = this.host.nextFor(body.slot.origin, body.slot.originEpoch)[body.slot.target] ?? 1; } catch { next = 1; }
    if (body.slot.n < next) return true;
    if (this.peerOwner(body.slot.target) !== null) return true;
    this.send({ t: "held", slot: body.slot, at: this.host.serverId } as MessageOf<"held">, body.cmd.type);
    const outcome = await uploads.whenComplete(ids, this.closedSignal, this.options.uploadIdleMs);
    return outcome !== "closed" && this.state === "open";
  }

  /** Upload frames in arrival order; a frame the store cannot take is answered `content.gone{offline}`. */
  queueUpload(message: MessageOf<"content.put"> | MessageOf<"content.chunk">): void {
    this.uploadChain = this.uploadChain.then(() => this.upload(message)).catch((error) => this.host.log(`session: ${message.t} failed: ${errorText(error)}`));
  }

  private async upload(message: MessageOf<"content.put"> | MessageOf<"content.chunk">): Promise<void> {
    if (this.state !== "open") return;
    const uploads = this.host.uploads;
    const refused = this.uploadRefusal();
    if (!uploads || refused) {
      if (message.t === "content.put") this.send({ t: "content.gone", req: message.req, id: message.id, reason: "denied" }, "content.put");
      if (refused) this.host.log(`session: upload refused (${refused})`);
      return;
    }
    let replies: Message[];
    try {
      replies = message.t === "content.put" ? await uploads.put(this.uploadOwner, message) : await uploads.chunk(this.uploadOwner, message);
    } catch (error) {
      this.host.log(`session: ${message.t} not kept: ${errorText(error)}`);
      if (message.t === "content.put") replies = [{ t: "content.gone", req: message.req, id: message.id, reason: "offline" }];
      else { replies = []; this.bye("unsettled", `an upload chunk could not be written: ${errorText(error)}`); }
    }
    for (const reply of replies) this.send(reply, message.t);
  }

  private async cancel(message: MessageOf<"cancel">, checked = false): Promise<void> {
    if (!checked && this.cancelRefusal(message)) return;
    try {
      // A cancel for a slot whose handler already began waits for that outcome (SlotEngine.cancel); a session that
      // closes meanwhile stops waiting (its front end sends the cancel again on its next session).
      const status = await Promise.race([this.host.runtime.slots.cancel(message.slot), this.closedSignal.then(() => null)]);
      // D59: every cancel is answered, the stored outcome or `cancel.noted` (after the cancel committed).
      if (status && this.state !== "closed") this.send(cancelAnswer(message.slot, status));
    } catch (error) {
      this.host.log(`session: cancel of slot ${message.slot.n} not settled: ${errorText(error)}`);
      this.unsettled(`cancel of slot ${message.slot.n} was not settled: ${errorText(error)}`, message.slot);
    }
  }

  /** A local admin request (the role table keeps `admin` off every other session; checked here again). */
  async admin(message: MessageOf<"admin">): Promise<void> {
    const admin = this.host.admin;
    if (!this.kind.local || !admin) {
      this.send({ t: "res", req: message.req, ok: false, error: { code: "forbidden", message: "admin requests are taken only on the local socket of a server that pairs" } }, "admin");
      return;
    }
    this.adminEvents ??= admin.onEvent((event) => { this.send({ t: "admin.event", event }, "admin.event"); });
    try {
      const result = await admin.handle(message.op, this.self);
      this.send({ t: "res", req: message.req, ok: true, result: result ?? null }, `admin ${message.op.op}`);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const text = `${typeof code === "string" ? `${code}: ` : ""}${errorText(error)}`;
      this.send({ t: "res", req: message.req, ok: false, error: { code: "conflict", message: text.slice(0, 2_000) } }, `admin ${message.op.op}`);
    }
  }

  async req(message: MessageOf<"req">): Promise<void> {
    const cmd = message.cmd as Command;
    const refused = this.reqRefusal(cmd);
    if (refused) {
      this.send({ t: "res", req: message.req, ok: false, error: refused }, cmd.type);
      return;
    }
    if (cmd.type === "slot.result") { await this.slotResult(message.req, cmd.slot); return; }
    try {
      // A `local` command (botlingd's phone pairing) goes to botlingd's own desk only on this machine's socket (a device
      // was refused above: admin scope).
      const phone = this.kind.local && routeOf(cmd.type).kind === "local" ? this.host.phone : undefined;
      const result = phone?.handles(cmd.type) ? await phone.run(cmd) : await this.host.engine.run(cmd);
      this.sendRes({ t: "res", req: message.req, ok: true, result: result ?? null }, cmd.type);
    } catch (error) {
      const wire = error instanceof ContractError ? error.toWire() : { code: "internal" as const, message: errorText(error).slice(0, 2_000) };
      this.sendRes({ t: "res", req: message.req, ok: false, error: wire }, cmd.type);
    }
  }

  /**
   * `slot.result` (N2): the result this server kept for one of this session's own slots whose result did not fit its
   * `cmd.applied` entry (server/slots/kept-results.ts). Another origin's slot is refused without a lookup; a large result
   * goes as `res.part`s. Answered here, never by the engine.
   */
  private async slotResult(req: string, raw: unknown): Promise<void> {
    const refuse = (code: "bad_request" | "forbidden" | "not_found" | "internal", text: string) =>
      this.send({ t: "res", req, ok: false, error: { code, message: text.slice(0, 2_000) } }, "slot.result");
    const parsed = Slot.safeParse(raw);
    if (!parsed.success) { refuse("bad_request", "slot.result names no valid slot"); return; }
    const slot = parsed.data;
    if (!this.deviceId || slot.origin !== this.deviceId) { refuse("forbidden", "slot.result answers only this session's own slots"); return; }
    try {
      const kept = await this.host.runtime.keptResult(slot);
      if (!kept.found) { refuse("not_found", `the result of slot ${slot.n} is no longer kept (the server keeps only the newest few)`); return; }
      this.sendRes({ t: "res", req, ok: true, result: kept.result ?? null }, "slot.result");
    } catch (error) {
      refuse("internal", `the result of slot ${slot.n} could not be read: ${errorText(error)}`);
    }
  }

  peerRead(message: MessageOf<"content.get"> | MessageOf<"content.credit"> | MessageOf<"content.cancel">): void {
    const reads = this.host.peerReads?.();
    if (!reads) {
      if (message.t === "content.get") this.send({ t: "content.gone", req: message.req, id: message.id, reason: "offline" }, "content.get");
      return;
    }
    if (message.t === "content.get") {
      const sink: LocalPeerReadSink = {
        send: (msg) => this.send(msg, msg.t),
        chunk: (msg) => this.writeChunk?.(msg) ?? false,
      };
      void reads.get(this.self, message, sink);
    } else if (message.t === "content.credit") {
      reads.credit(this.self, message);
    } else {
      reads.cancel(this.self, message);
    }
  }

  async content(message: MessageOf<"content.find"> | MessageOf<"content.open">): Promise<void> {
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
    if (this.kind.local && message.t === "content.find" && answer.t === "content.found" && !answer.ref && this.host.peerLocate) {
      try {
        const located = await this.host.peerLocate({ t: "content.locate", req: message.req, botId: message.botId, line: message.line, url: message.url });
        if (located) {
          answer = {
            t: "content.found",
            req: message.req,
            ref: { owner: located.owner, id: located.id, type: located.type, state: located.state, entry: located.entry },
          };
        }
      } catch (error) {
        this.host.log(`session: ${message.t} peer: ${errorText(error)}`);
      }
    }
    // The answer carries the request's own `req` (the service echoes it; kept here whatever it says).
    this.send({ ...answer, req: message.req } as Message, message.t);
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
