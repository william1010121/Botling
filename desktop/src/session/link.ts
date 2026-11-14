// One encrypted session over any transport that carries whole binary frames in order (protocol v1 §5): it runs the
// handshake, then seals and opens frames with exact counters, keeps the two lanes, and rekeys in-band.
//
// Data and rekey frames:  kind (1) ‖ epoch (u32) ‖ counter (u64) ‖ AES-256-GCM(plaintext), AAD = frameAad(...).
//
// - Counters are per direction and per epoch and must be exactly the next one; a replayed, skipped, reordered or
//   altered frame (or one of a kind the sender may not send) ends the session (§5.2). Nothing is ever retried here:
//   reliability comes from cursors and slots above.
// - Nothing reaches `onFrame` before the handshake finished, i.e. before both static keys were proven and the roster
//   check passed; a frame that comes before that ends the session unopened.
// - Rekey (§5.1, after REKEY_AFTER_FRAMES frames or REKEY_AFTER_MS in either direction): the handshake's initiator sends
//   REKEY{e_i'} under the current keys; the responder answers REKEY_ACK{e_r'} as its last frame of the epoch and then
//   sends under the new keys; the initiator switches its receiving side on the ACK and sends SWITCH as its last frame
//   of the epoch. Both epochs' counters stay exact across the change, so a frame dropped around it still ends the
//   session. The session (its id, its queues, the transport) goes on; only the keys change. A direction that passes
//   the limits by the hard margin without a rekey ends the session.
import {
  aesOpen, aesSeal, concat, readU32, readU64, SessionError, u32, u64, type SessionEndReason,
} from "./bytes";
import {
  FRAME_KIND, frameAad, frameNonce, Initiator, rekeySchedule, Responder,
  type Direction, type HandshakeMode, type InitiatorOptions, type PeerStatic, type ResponderOptions, type Role, type SessionSecrets, type TransportKind,
} from "./handshake";
import { LaneQueue, RELAY_BULK_FRAME_LIMIT, BULK_FRAME_LIMIT, SESSION_FRAME_LIMIT, type Lane } from "./lanes";
import { generateDhKeyPair, type DhKeyPair } from "./x25519";

export const REKEY_AFTER_FRAMES = 2 ** 20;
export const REKEY_AFTER_MS = 24 * 60 * 60 * 1000;
/** `ping` after this much silence; no frame for DEAD_AFTER_MS means the session is dead (§5.2; sent by the layer above). */
export const PING_AFTER_MS = 15_000;
export const DEAD_AFTER_MS = 45_000;
const HEADER_BYTES = 13;
const TAG_BYTES = 16;
/** Frames that may wait unopened while a handshake step runs (HS3 and the first data frames follow at once). */
const HANDSHAKE_INBOX_LIMIT = 64;
/** The largest frame the wire can carry: header, the largest plaintext, tag (bigger than every handshake message). */
const WIRE_FRAME_LIMIT = HEADER_BYTES + SESSION_FRAME_LIMIT + TAG_BYTES;

/** A transport that carries whole binary frames, in order (WebSocket, relay `d` frames, an in-memory pair). */
export interface SessionTransport {
  send(frame: Uint8Array): void;
  close(): void;
}

export interface SessionLimits {
  rekeyAfterFrames: number;
  rekeyAfterMs: number;
  /** Frames past `rekeyAfterFrames` a direction may go while a rekey is under way. */
  hardFrameMargin: number;
  /** Time past `rekeyAfterMs` an epoch may last while a rekey is under way. */
  hardAgeMarginMs: number;
  handshakeTimeoutMs: number;
  /**
   * Bytes received but not yet handled (opened and passed through `onFrame`). Frames come in faster than they are
   * opened when `onFrame` is slow, or when the transport (a relay) pushes junk: past this the session ends (`limit`),
   * so neither the peer nor the path in between can grow memory without bound.
   */
  inboxBytes: number;
}
export const DEFAULT_LIMITS: SessionLimits = {
  rekeyAfterFrames: REKEY_AFTER_FRAMES,
  rekeyAfterMs: REKEY_AFTER_MS,
  hardFrameMargin: 2 ** 16,
  hardAgeMarginMs: 60 * 60 * 1000,
  handshakeTimeoutMs: 15_000,
  inboxBytes: 32 * 1024 * 1024,
};

export interface SessionLinkOptions {
  limits?: Partial<SessionLimits>;
  now?: () => number;
  /** Bulk frame cap; default by transport (64 KiB direct, 128 KiB relay content chunks). */
  bulkFrameLimit?: number;
}

export interface SessionInfo {
  readonly role: Role;
  readonly mode: HandshakeMode;
  readonly transport: TransportKind;
  readonly cluster: string;
  readonly sessionId: string;
  readonly code: string;
  readonly transcriptHash: Uint8Array;
  readonly peer: PeerStatic;
  readonly offer?: string;
}

export interface SessionEnd { reason: SessionEndReason; detail: string }

export interface SessionEvents {
  /** A plaintext frame, in order. Awaited: the next frame waits for it. Throwing ends the session (`app`). */
  onFrame(plaintext: Uint8Array): void | Promise<void>;
  onEnd?(end: SessionEnd): void;
}

interface Keys { key: CryptoKey; epoch: number; next: number; since: number }
interface Urgent { kind: number; plaintext: Uint8Array; after?: () => void }

export class SessionLink {
  /** The initiator side; sends HS1 at once. */
  static initiate(transport: SessionTransport, options: InitiatorOptions & SessionLinkOptions, events: SessionEvents): SessionLink {
    const link = new SessionLink("initiator", transport, options, events);
    link.initiator = new Initiator(options);
    link.initiator.start().then((hs1) => { if (!link.ended) transport.send(hs1); }).catch((error) => link.fail(error));
    return link;
  }

  /** The responder side; waits for HS1. */
  static respond(transport: SessionTransport, options: ResponderOptions & SessionLinkOptions, events: SessionEvents): SessionLink {
    const link = new SessionLink("responder", transport, options, events);
    link.responder = new Responder(options);
    return link;
  }

  /** Resolves when the session is open (both keys proven, roster check passed); rejects with the end otherwise. */
  readonly established: Promise<SessionInfo>;
  info: SessionInfo | null = null;

  private initiator: Initiator | null = null;
  private responder: Responder | null = null;
  private responderGotHs1 = false;
  private secrets: SessionSecrets | null = null;
  private send_: Keys | null = null;
  private recv: Keys | null = null;
  private chain: Uint8Array | null = null;
  private rekeying = false;
  private rekeyOwn: DhKeyPair | null = null;
  private pendingRecv: { key: CryptoKey; epoch: number } | null = null;
  private readonly queue: LaneQueue;
  private readonly urgent: Urgent[] = [];
  private pumping = false;
  private inbox: Promise<void> = Promise.resolve();
  private inboxDepth = 0;
  private inboxBytes = 0;
  private ended = false;
  private endInfo: SessionEnd | null = null;
  private resolveOpen!: (info: SessionInfo) => void;
  private rejectOpen!: (error: SessionError) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly limits: SessionLimits;
  private readonly now: () => number;
  /** Frames opened and handed to `onFrame` (tests check nothing is opened before the handshake). */
  delivered = 0;

  private constructor(readonly role: Role, private readonly transport: SessionTransport, options: SessionLinkOptions & { transport: TransportKind }, private readonly events: SessionEvents) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.queue = new LaneQueue(options.bulkFrameLimit ?? (options.transport === "relay" ? RELAY_BULK_FRAME_LIMIT : BULK_FRAME_LIMIT));
    this.established = new Promise<SessionInfo>((resolve, reject) => { this.resolveOpen = resolve; this.rejectOpen = reject; });
    this.established.catch(() => undefined);
    this.timer = setTimeout(() => this.end("timeout", "the handshake did not finish in time"), this.limits.handshakeTimeoutMs);
  }

  get state(): "handshake" | "open" | "ended" { return this.ended ? "ended" : this.secrets ? "open" : "handshake"; }
  /** The current epochs (0 until the first rekey). */
  get epochs(): { send: number; receive: number } { return { send: this.send_?.epoch ?? 0, receive: this.recv?.epoch ?? 0 }; }
  get ending(): SessionEnd | null { return this.endInfo; }
  get queuedBytes(): number { return this.queue.queuedBytes; }

  /** Queues a plaintext frame on a lane. Frames queued before the session opens leave right after it does. */
  send(lane: Lane, plaintext: Uint8Array): void {
    if (this.ended) throw new SessionError("closed", "the session has ended");
    this.queue.push(lane, plaintext);
    void this.pump();
  }

  /** One frame from the transport. */
  receive(frame: Uint8Array): void {
    if (this.ended) return;
    if (frame.length > WIRE_FRAME_LIMIT) { this.end("malformed", "a frame is larger than any session frame"); return; }
    if (!this.secrets && ++this.inboxDepth > HANDSHAKE_INBOX_LIMIT) { this.end("handshake", "too many frames during the handshake"); return; }
    this.inboxBytes += frame.length;
    if (this.inboxBytes > this.limits.inboxBytes) { this.end("limit", "too many received bytes waiting to be handled"); return; }
    const copy = new Uint8Array(frame);
    this.inbox = this.inbox
      .then(async () => { try { await this.handle(copy); } finally { this.inboxBytes -= copy.length; } })
      .catch((error) => this.fail(error));
  }

  close(): void { this.end("closed", "closed by this side"); }

  /**
   * Resolves once every frame queued so far has been sealed and handed to the transport, or the session ended (a
   * `bye` then leaves before `close`). Before the session opens nothing is sealed: it waits for the open or the end.
   */
  async drain(): Promise<void> {
    while (!this.ended && (this.pumping || this.queue.length > 0 || this.urgent.length > 0)) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  /** Resolves once the frames received so far were handled (opened and delivered, or the session ended on one). */
  received(): Promise<void> { return this.inbox.then(() => undefined, () => undefined); }
  /** The transport closed under the session. */
  transportClosed(): void { this.end("transport", "the transport closed"); }

  private fail(error: unknown): void {
    if (error instanceof SessionError) this.end(error.reason, error.message);
    else this.end("malformed", error instanceof Error ? error.message : String(error));
  }

  private end(reason: SessionEndReason, detail: string): void {
    if (this.ended) return;
    this.ended = true;
    this.endInfo = { reason, detail };
    this.queue.clear();
    this.urgent.length = 0;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.chain?.fill(0);
    this.rejectOpen(new SessionError(reason, detail));
    if (reason !== "transport") { try { this.transport.close(); } catch { /* already closed */ } }
    this.events.onEnd?.({ reason, detail });
  }

  private open(secrets: SessionSecrets): void {
    const now = this.now();
    this.secrets = secrets;
    this.chain = new Uint8Array(secrets.chain);
    // Counter 0 of epoch 0 carried HS2 / HS3 in each direction.
    this.send_ = { key: secrets.sendKey, epoch: 0, next: 1, since: now };
    this.recv = { key: secrets.receiveKey, epoch: 0, next: 1, since: now };
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.info = {
      role: secrets.role, mode: secrets.mode, transport: secrets.transport, cluster: secrets.cluster, sessionId: secrets.sessionId,
      code: secrets.code, transcriptHash: secrets.transcriptHash, peer: secrets.peer, offer: secrets.offer,
    };
    this.resolveOpen(this.info);
    void this.pump();
  }

  private get sendDir(): Direction { return this.role === "initiator" ? "i2r" : "r2i"; }
  private get recvDir(): Direction { return this.role === "initiator" ? "r2i" : "i2r"; }

  private async handle(frame: Uint8Array): Promise<void> {
    if (this.ended) return;
    if (!this.secrets) {
      this.inboxDepth--;
      if (this.initiator) {
        const { hs3, secrets } = await this.initiator.receive(frame);
        if (this.ended) return;
        this.transport.send(hs3);
        this.open(secrets);
      } else if (!this.responderGotHs1) {
        this.responderGotHs1 = true;
        const hs2 = await this.responder!.receive(frame);
        if (this.ended) return;
        this.transport.send(hs2);
      } else {
        const secrets = await this.responder!.finish(frame);
        if (this.ended) return;
        this.open(secrets);
      }
      return;
    }
    await this.openFrame(frame);
  }

  private checkHard(keys: Keys, what: string): void {
    const { rekeyAfterFrames, rekeyAfterMs, hardFrameMargin, hardAgeMarginMs } = this.limits;
    if (keys.next > rekeyAfterFrames + hardFrameMargin) throw new SessionError("limit", `${what}: too many frames without a rekey`);
    if (this.now() - keys.since > rekeyAfterMs + hardAgeMarginMs) throw new SessionError("limit", `${what}: the keys are too old`);
  }

  private async openFrame(frame: Uint8Array): Promise<void> {
    const recv = this.recv!;
    const secrets = this.secrets!;
    if (frame.length < HEADER_BYTES + TAG_BYTES || frame.length > WIRE_FRAME_LIMIT) throw new SessionError("malformed", "a frame has the wrong size");
    const kind = frame[0]!;
    const allowed = this.role === "responder"
      ? kind === FRAME_KIND.DATA || kind === FRAME_KIND.REKEY || kind === FRAME_KIND.SWITCH
      : kind === FRAME_KIND.DATA || kind === FRAME_KIND.REKEY_ACK;
    if (!allowed) throw new SessionError("malformed", `the peer may not send frame kind ${kind}`);
    const epoch = readU32(frame, 1);
    const counter = readU64(frame, 5);
    if (epoch !== recv.epoch || counter !== recv.next) {
      throw new SessionError("order", `expected epoch ${recv.epoch} frame ${recv.next}, got epoch ${epoch} frame ${counter} (replayed, skipped or reordered)`);
    }
    this.checkHard(recv, "receiving");
    const plaintext = await aesOpen(recv.key, frameNonce(this.recvDir, epoch, counter), frameAad(secrets.sessionIdBytes, kind, this.recvDir, epoch, counter), frame.subarray(HEADER_BYTES));
    if (this.ended) return;
    if (!plaintext) throw new SessionError("auth", "a frame failed authentication (altered or not from this session)");
    recv.next++;
    switch (kind) {
      case FRAME_KIND.DATA:
        if (plaintext.length === 0) throw new SessionError("malformed", "an empty data frame");
        this.delivered++;
        try { await this.events.onFrame(plaintext); }
        catch (error) { throw new SessionError("app", `the frame's receiver failed: ${error instanceof Error ? error.message : String(error)}`); }
        break;
      case FRAME_KIND.REKEY: await this.onRekey(plaintext); break;
      case FRAME_KIND.SWITCH: this.onSwitch(plaintext); break;
      case FRAME_KIND.REKEY_ACK: await this.onRekeyAck(plaintext); break;
    }
    if (this.role === "initiator") void this.pump();
  }

  /** Responder: the initiator's REKEY{e_i'}. */
  private async onRekey(peerEphemeral: Uint8Array): Promise<void> {
    const send = this.send_!, recv = this.recv!;
    if (this.pendingRecv || send.epoch !== recv.epoch) throw new SessionError("rekey", "a rekey before the last one finished");
    if (peerEphemeral.length !== 32) throw new SessionError("rekey", "a malformed REKEY");
    const epoch = recv.epoch + 1;
    const own = await generateDhKeyPair();
    const schedule = await rekeySchedule(this.secrets!, this.chain!, epoch, own, peerEphemeral);
    if (this.ended) return;
    this.chain!.fill(0);
    this.chain = schedule.chain;
    this.pendingRecv = { key: schedule.i2r, epoch };
    this.urgent.unshift({
      kind: FRAME_KIND.REKEY_ACK, plaintext: own.publicKey,
      after: () => { this.send_ = { key: schedule.r2i, epoch, next: 0, since: this.now() }; },
    });
    void this.pump();
  }

  /** Responder: the initiator's last frame of the epoch. */
  private onSwitch(plaintext: Uint8Array): void {
    const pending = this.pendingRecv;
    if (!pending || plaintext.length !== 4 || readU32(plaintext, 0) !== pending.epoch) throw new SessionError("rekey", "a SWITCH without a matching rekey");
    this.recv = { key: pending.key, epoch: pending.epoch, next: 0, since: this.now() };
    this.pendingRecv = null;
  }

  /** Initiator: the responder's REKEY_ACK{e_r'}, its last frame of the epoch. */
  private async onRekeyAck(peerEphemeral: Uint8Array): Promise<void> {
    const own = this.rekeyOwn;
    if (!own || peerEphemeral.length !== 32) throw new SessionError("rekey", "a REKEY_ACK without a rekey");
    const epoch = this.recv!.epoch + 1;
    const schedule = await rekeySchedule(this.secrets!, this.chain!, epoch, own, peerEphemeral);
    if (this.ended) return;
    this.rekeyOwn = null;
    this.chain!.fill(0);
    this.chain = schedule.chain;
    this.recv = { key: schedule.r2i, epoch, next: 0, since: this.now() };
    this.urgent.unshift({
      kind: FRAME_KIND.SWITCH, plaintext: u32(epoch),
      after: () => { this.send_ = { key: schedule.i2r, epoch, next: 0, since: this.now() }; this.rekeying = false; },
    });
  }

  private rekeyDue(): boolean {
    const { rekeyAfterFrames, rekeyAfterMs } = this.limits;
    const now = this.now();
    const send = this.send_!, recv = this.recv!;
    return send.next >= rekeyAfterFrames || recv.next >= rekeyAfterFrames || now - send.since >= rekeyAfterMs || now - recv.since >= rekeyAfterMs;
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.ended || !this.secrets) return;
    this.pumping = true;
    try {
      while (!this.ended) {
        if (this.role === "initiator" && !this.rekeying && this.rekeyDue()) {
          this.rekeying = true;
          const own = await generateDhKeyPair();
          if (this.ended) break;
          this.rekeyOwn = own;
          this.urgent.unshift({ kind: FRAME_KIND.REKEY, plaintext: own.publicKey });
        }
        const urgent = this.urgent.shift();
        const item: Urgent | undefined = urgent ?? (() => { const next = this.queue.shift(); return next && { kind: FRAME_KIND.DATA, plaintext: next.plaintext }; })();
        if (!item) break;
        const frame = await this.seal(item.kind, item.plaintext);
        if (this.ended) break;
        this.transport.send(frame);
        item.after?.();
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.pumping = false;
    }
  }

  private async seal(kind: number, plaintext: Uint8Array): Promise<Uint8Array> {
    const send = this.send_!;
    this.checkHard(send, "sending");
    const counter = send.next++;
    const sealed = await aesSeal(send.key, frameNonce(this.sendDir, send.epoch, counter), frameAad(this.secrets!.sessionIdBytes, kind, this.sendDir, send.epoch, counter), plaintext);
    return concat(Uint8Array.of(kind), u32(send.epoch), u64(counter), sealed);
  }
}

/** A frame as base64url text, for a transport that carries only text. */
export function frameToText(frame: Uint8Array): string {
  let text = "";
  for (let at = 0; at < frame.length; at += 0x8000) text += String.fromCharCode(...frame.subarray(at, at + 0x8000));
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The frame in base64url text, or null when the text is not base64url. */
export function frameFromText(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}
