// Remote device sessions on botlingd (M2 step 4, protocol v1 §5, §4.6, §11.1, §11.7, §13.1): a paired phone or browser
// talks to the session core through an encrypted SessionLink (src/session) over any transport that carries whole
// binary frames in order (the loopback WebSocket of step 6, the relay of step 13, an in-memory pair in tests).
//
// - Handshake: botlingd is the responder, IK for paired devices, and `pair` mode when the host has pairing (step 5,
//   server/pairing). `checkPeer` and `offerSecret` only read: the claim they see is not proven yet (anyone with the
//   server's public key can make one, a replayed HS1 reaches them too), so they have no side effect; the session is
//   registered, its device known, or its pairing offer claimed, only once `established` resolved.
// - A `pair` session is not a front-end session: once established its frames (pair.*, ping, bye; decoded as a pairing
//   session) go to the pairing service, which claims the offer; the session core (hello, streams, commands) never runs.
// - Origin = the device's member id from the handshake: the hello's `deviceId` and every command's `slot.origin` must be
//   it (anything else ends the session, `role`). No local token.
// - Validity is checked before every frame after the handshake (a revoked device's next frame ends the session with
//   `bye{revoked}`), and the roster's change listener ends every session of a device the moment it becomes invalid.
//   Commands carry the scope the command needs (remote-reads.ts `statedScope`); the owner's slot check
//   (`slotAuthorize`) refuses a device without that scope, or no longer valid, as each slot is decided, so a revoked
//   device's commands that were not applied yet are refused (`cmd.refused{origin}`), never applied.
// - `req`: the remote read allowlist only, with the `read` scope. Streams (`sub`, `history`) need `read`.
//   `content.find` / `content.open`, `shell.*` and `admin` are local-socket rows of the role table: refused (`role`).
// - Content over the tailnet (step 9): `content.locate` (a line's reference, with a URL ticket once hashed) and
//   `content.ticket` (a ticket, or its renewal) go to the host's `remoteContent` (server/content/remote.ts), which
//   checks the `read` scope and the stream; without it they are answered as not found / `offline`.
// - Lanes: catch-up pages, snaps and read answers on the bulk lane when they fit a bulk frame; the rest on control.
//   Back-pressure by the link's `queuedBytes` (the send queue itself is unbounded): live frames are skipped while more
//   than LIVE_SOFT_BYTES wait (the front end asks for the whole segment again, as for any rev gap), and a session with
//   more than `maxBuffered` waiting is dropped like a local front end that does not read; it re-attaches from cursors.
// - Keepalive as the core does it: `ping` after 15 s of our silence, `bye{dead}` after 45 s heard nothing.
import type { Command } from "../../contract";
import { decodeFrame, encodeFrame, fromBase64Url, type CmdBody, type Message, type MessageOf, type Scope, type StreamId } from "../../protocol";
import {
  BULK_FRAME_LIMIT, RELAY_BULK_FRAME_LIMIT, SessionLink,
  type Lane, type LocalStatic, type PeerClaim, type PeerDecision, type SessionEnd, type SessionInfo, type SessionLinkOptions, type SessionTransport, type TransportKind,
} from "../../session";
import { remoteReadRefusal, statedScope, type DeviceRoster } from "./remote-reads";
import { errorText, MAX_BUFFERED, SessionCore, type SessionHost, type SessionOptions, type ShellRefusal } from "./session-core";

const REMOTE_KIND = { local: false } as const;
const PAIRING_KIND = { local: false, pairing: true } as const;
/** Live frames are skipped while more than this waits in the send queue (the receiver resyncs the segment). */
export const LIVE_SOFT_BYTES = 256 * 1024;
const BULK_TYPES: ReadonlySet<string> = new Set(["snap", "history.page", "res", "res.part"]);
/** How long a `bye` may take to leave before the link is closed anyway. */
const BYE_FLUSH_MS = 1_000;

const encoder = new TextEncoder();

/** The roster as remote sessions use it: devices, the cluster, and changes. */
export interface RemoteRoster extends DeviceRoster {
  readonly clusterId: string | null;
  onChange(listener: (change: { invalidated: string[] }) => void): () => void;
}

/** The pairing service as remote sessions use it (server/pairing/service.ts). */
export interface PairingHook {
  /** The pending offer's secret, or null (unknown, expired, used). Read only. */
  offerSecret(offer: string): Uint8Array | null;
  /** The roster side of a pairing claim. Read only. */
  checkClaim(claim: PeerClaim): PeerDecision;
  /** An established pairing session: the service claims the offer and drives the session. */
  open(info: SessionInfo, link: { send(message: Message): boolean; end(): void }): { onMessage(message: Message): void; closed(): void };
}

export interface RemoteHost extends SessionHost {
  roster: RemoteRoster;
  /** This server's static X25519 identity (its member id and key). */
  self: LocalStatic;
  /** Device pairing (`pair` mode); without it only IK is taken. */
  pairing?: PairingHook;
  /** Content over the tailnet (step 9): lookups and URL tickets. */
  remoteContent?: RemoteContentHook;
}

/** server/content/remote.ts `RemoteContent` as the session uses it. */
export interface RemoteContentHook {
  locate(deviceId: string, message: MessageOf<"content.locate">): Promise<MessageOf<"content.located">>;
  ticket(deviceId: string, message: MessageOf<"content.ticket">): Promise<MessageOf<"content.granted"> | MessageOf<"content.gone">>;
}

export interface RemoteSessionOptions extends SessionOptions {
  link?: SessionLinkOptions;
}

/** The roster check of a handshake claim. Reads only: the claim is not proven when it runs. */
export function devicePeerCheck(roster: DeviceRoster, claim: PeerClaim): PeerDecision {
  if (claim.mode !== "ik") return { ok: false, detail: "devices dial in IK" };
  const device = roster.device(claim.memberId);
  if (!device) return { ok: false, detail: "not a valid device" };
  const dh = fromBase64Url(device.keys.dh);
  if (!dh) return { ok: false, detail: "the roster's key is malformed" };
  if (dh.length !== claim.dhPub.length || dh.some((byte, i) => byte !== claim.dhPub[i])) return { ok: false, detail: "another key than the roster's" };
  return { ok: true };
}

export class RemoteSession extends SessionCore {
  protected readonly kind = REMOTE_KIND;
  readonly link: SessionLink;
  private member: string | null = null;
  private peerDh: Uint8Array | null = null;
  private flushing = false;
  private readonly bulkLimit: number;
  private pair: { onMessage(message: Message): void; closed(): void } | null = null;

  constructor(transport: SessionTransport, transportKind: TransportKind, private readonly remote: RemoteHost, options: RemoteSessionOptions = {}) {
    super(remote, options);
    const cluster = remote.roster.clusterId;
    this.bulkLimit = options.link?.bulkFrameLimit ?? (transportKind === "relay" ? RELAY_BULK_FRAME_LIMIT : BULK_FRAME_LIMIT);
    this.link = SessionLink.respond(transport, {
      ...options.link,
      transport: transportKind,
      // Before the first pairing there is no cluster and no device: any handshake fails the roster check.
      cluster: cluster ?? "0".repeat(32),
      self: remote.self,
      modes: remote.pairing ? ["ik", "pair"] : ["ik"],
      checkPeer: (claim) => (cluster === null ? { ok: false, detail: "no cluster yet" }
        : claim.mode === "pair" ? remote.pairing!.checkClaim(claim) : devicePeerCheck(remote.roster, claim)),
      ...(remote.pairing ? { offerSecret: (offer: string) => remote.pairing!.offerSecret(offer) } : {}),
    }, {
      onFrame: (plaintext) => this.onFrame(plaintext),
      onEnd: (end) => this.onLinkEnd(end),
    });
    this.link.established.then((info) => this.onEstablished(info), () => undefined);
  }

  /** The device's member id, once the handshake proved it (null on a pairing session). */
  get memberId(): string | null { return this.member; }
  /** A `pair`-mode session (handled by the pairing service). */
  get pairing(): boolean { return this.link.info?.mode === "pair"; }
  /** Plaintext bytes waiting in the link's send queue. */
  get queuedBytes(): number { return this.link.queuedBytes; }

  /** One frame from the transport. */
  receive(frame: Uint8Array): void { this.link.receive(frame); }
  /** The transport closed under the session. */
  transportClosed(): void { this.link.transportClosed(); }

  private onEstablished(info: SessionInfo): void {
    if (info.mode === "pair") { this.adoptPair(info); return; }
    this.adopt(info);
    if (this.state !== "closed") this.startTimers();
  }

  private adopt(info: SessionInfo): void {
    if (this.member) return;
    this.member = info.peer.memberId;
    this.peerDh = info.peer.dhPub;
    this.lastHeard = Date.now();
  }

  /** A pairing session: the pairing service takes it (once). */
  private adoptPair(info: SessionInfo): void {
    if (this.pair || this.state === "closed" || !this.remote.pairing) return;
    this.pair = this.remote.pairing.open(info, {
      send: (message) => {
        if (this.state === "closed" || !this.writable) return false;
        const encoded = encodeFrame(message, "server", PAIRING_KIND);
        if (!encoded.ok) { this.host.log(`pairing: cannot send ${message.t}: ${encoded.detail}`); return false; }
        try { this.link.send("control", encoder.encode(encoded.text)); } catch { return false; }
        this.lastSent = Date.now();
        return true;
      },
      end: () => { this.endTransport(); this.close(); },
    });
  }

  private onPairFrame(plaintext: Uint8Array): void {
    if (!this.pair && this.link.info) this.adoptPair(this.link.info);
    const decoded = decodeFrame(plaintext, "fe", PAIRING_KIND);
    if (!decoded.ok) { this.send(decoded.bye); this.endTransport(); this.close(); return; }
    try {
      this.pair?.onMessage(decoded.message);
    } catch (error) {
      this.host.log(`pairing: ${decoded.message.t} failed: ${errorText(error)}`);
    }
  }

  protected closing(): void {
    const pair = this.pair;
    this.pair = null;
    pair?.closed();
  }

  private onLinkEnd(end: SessionEnd): void {
    if (this.state !== "closed" && end.reason !== "closed") this.host.log(`remote session ${this.member ?? "?"}: ended (${end.reason}: ${end.detail})`);
    this.close();
  }

  private onFrame(plaintext: Uint8Array): void {
    if (this.state === "closed") return;
    if (this.link.info?.mode === "pair") { this.lastHeard = Date.now(); this.onPairFrame(plaintext); return; }
    // The link opens frames only after the handshake: its info is set by then, even before `established` is handled.
    if (!this.member && this.link.info) this.adopt(this.link.info);
    this.lastHeard = Date.now();
    const decoded = decodeFrame(plaintext, "fe", REMOTE_KIND);
    if (!decoded.ok) { this.send(decoded.bye); this.endTransport(); this.close(); return; }
    try {
      this.onMessage(decoded.message);
    } catch (error) {
      this.frameFailed(decoded.message, error);
    }
  }

  protected onMessage(message: Message): void {
    if (this.state === "open" && (message.t === "content.locate" || message.t === "content.ticket")) {
      const refused = this.frameRefusal();
      if (refused) { this.bye(refused.reason, refused.detail); return; }
      void this.remoteContent(message);
      return;
    }
    super.onMessage(message);
  }

  private async remoteContent(message: MessageOf<"content.locate"> | MessageOf<"content.ticket">): Promise<void> {
    const hook = this.remote.remoteContent;
    const member = this.member;
    let answer: Message;
    try {
      if (!hook || !member) throw new Error("no content service");
      answer = message.t === "content.locate" ? await hook.locate(member, message) : await hook.ticket(member, message);
    } catch (error) {
      this.host.log(`session: ${message.t}: ${errorText(error)}`);
      answer = message.t === "content.locate"
        ? { t: "content.located", req: message.req, ref: null }
        : { t: "content.gone", req: message.req, id: message.id, reason: "offline" };
    }
    this.send({ ...answer, req: message.req } as Message, message.t);
  }

  // ---------------------------------------------------------------------------------------------
  // The shell

  protected get writable(): boolean { return this.link.state !== "ended" && !this.flushing; }

  protected writeTexts(texts: string[], t: string, what?: string): boolean {
    if (this.state === "closed" || !this.writable) return false;
    const queued = this.link.queuedBytes;
    if (queued > (this.options.maxBuffered ?? MAX_BUFFERED)) {
      this.host.log(`session ${this.deviceId ?? this.member ?? "?"}: dropped, it does not read (${queued} bytes waiting)`);
      this.close();
      return false;
    }
    if (t === "live" && queued > LIVE_SOFT_BYTES) return false;
    const frames = texts.map((text) => encoder.encode(text));
    const lane: Lane = BULK_TYPES.has(t) && frames.every((frame) => frame.length <= this.bulkLimit) ? "bulk" : "control";
    try {
      for (const frame of frames) this.link.send(lane, frame);
    } catch (error) {
      this.host.log(`session: cannot send ${t}${what ? ` (${what})` : ""}: ${errorText(error)}`);
      return false;
    }
    this.lastSent = Date.now();
    return true;
  }

  protected endTransport(): void {
    if (this.flushing || this.link.state === "ended") return;
    this.flushing = true;
    const link = this.link;
    const timer = setTimeout(() => link.close(), BYE_FLUSH_MS);
    timer.unref?.();
    void link.drain().then(() => { clearTimeout(timer); link.close(); });
  }

  protected destroyTransport(): void {
    if (!this.flushing) this.link.close();
  }

  protected checkHello(hello: MessageOf<"hello">): ShellRefusal | null {
    if (hello.token !== undefined) return { reason: "role", detail: "the local token is for the local socket" };
    if (!this.member || hello.deviceId !== this.member) return { reason: "role", detail: "a device's hello names its own member id" };
    return this.frameRefusal();
  }

  /** The device is still valid, with the keys this session was opened with (§4.6). */
  protected frameRefusal(): ShellRefusal | null {
    const device = this.member ? this.remote.roster.device(this.member) : null;
    if (!device) return { reason: "revoked", detail: "this device is no longer in the roster" };
    const dh = fromBase64Url(device.keys.dh);
    const peer = this.peerDh;
    if (!dh || !peer || dh.length !== peer.length || dh.some((byte, i) => byte !== peer[i])) return { reason: "revoked", detail: "this device's keys changed in the roster" };
    return null;
  }

  protected cmdScope(body: CmdBody): { scope: Scope } | ShellRefusal {
    if (body.slot.origin !== this.member) return { reason: "role", detail: "a device's commands name it as their origin" };
    return { scope: statedScope(body.cmd as Command) };
  }

  protected cancelRefusal(message: MessageOf<"cancel">): boolean {
    if (message.slot.origin === this.member) return false;
    this.bye("role", "a device cancels only its own commands");
    return true;
  }

  protected reqRefusal(cmd: Command): { code: "forbidden"; message: string } | null {
    const device = this.member ? this.remote.roster.device(this.member) : null;
    const refusal = device ? remoteReadRefusal(cmd, device.scope ?? []) : "this device is no longer in the roster";
    return refusal ? { code: "forbidden", message: refusal.slice(0, 2_000) } : null;
  }

  protected subRefusal(_stream: StreamId): string | null {
    const device = this.member ? this.remote.roster.device(this.member) : null;
    return device && (device.scope ?? []).includes("read") ? null : "needs the read scope";
  }
}

/**
 * Every remote session of this botlingd: accepts a transport, and ends a device's sessions the moment the roster says
 * it is no longer valid (§4.6). A session counts here once its handshake finished.
 */
export class RemoteSessions {
  private readonly sessions = new Set<RemoteSession>();
  private readonly pending = new Set<RemoteSession>();
  private readonly pairs = new Set<RemoteSession>();
  private readonly unlisten: () => void;
  private closed = false;

  constructor(private readonly host: RemoteHost, private readonly options: RemoteSessionOptions = {}) {
    this.unlisten = host.roster.onChange((change) => {
      const gone = new Set(change.invalidated);
      for (const session of [...this.sessions]) if (session.memberId && gone.has(session.memberId)) session.bye("revoked", "this device was removed from the roster");
    });
  }

  /** Pairing sessions under way (handshake finished). */
  get pairingSessions(): RemoteSession[] { return [...this.pairs]; }

  /** Open sessions (handshake finished). */
  get open(): RemoteSession[] { return [...this.sessions]; }

  /** The sessions of one device. */
  of(member: string): RemoteSession[] { return [...this.sessions].filter((session) => session.memberId === member); }

  /** A new transport: the session waits for HS1 on it. Feed it with `receive`, tell it `transportClosed`. */
  accept(transport: SessionTransport, kind: TransportKind): RemoteSession {
    const session = new RemoteSession(transport, kind, this.host, this.options);
    if (this.closed) { session.close(); return session; }
    this.pending.add(session);
    session.onClosed(() => { this.pending.delete(session); this.sessions.delete(session); });
    session.link.established.then((info) => {
      if (!this.pending.delete(session)) return;
      if (info.mode === "pair") { this.pairs.add(session); session.onClosed(() => this.pairs.delete(session)); return; }
      this.sessions.add(session);
    }, () => undefined);
    return session;
  }

  /** Every session gets a `bye{closing}`; handshakes under way end. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unlisten();
    for (const session of [...this.sessions]) session.bye("closing", "botlingd is stopping");
    for (const session of [...this.pending]) session.close();
    for (const session of [...this.pairs]) session.close();
  }
}
