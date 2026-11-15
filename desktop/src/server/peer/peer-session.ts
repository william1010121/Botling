// One encrypted session between two botlingd (M3 step 3, protocol v1 §4.6, §5.1, §5.2, §6.2, D47, D58).
//
// - Handshake: KK, both static keys from the roster. The dialler names the peer's keys from its roster (an Add of kind
//   server); the acceptor takes a KK whose decrypted static key equals the one its roster names for a server member
//   (`serverPeerCheck`). A key no Add names as a server is refused at HS1: nothing is answered, nothing parsed.
// - Once both keys are proven, each side decides alone whether the session is full or **exchange only**: it is
//   exchange only when this server finds the peer, or itself, not valid (revoked). Unknown keys never get this far.
// - Every peer session starts with `roster.revocations` from each side (every Revoke and Root this side holds, in
//   chunks of ≤ 200; the last chunk is shorter than 200, empty if need be): the D47 exchange, and the "re-sent at the
//   start of every peer session" of §4.6. Roster sync is the first exchange: a full session takes nothing else from
//   the peer before its last revocation chunk.
// - Exchange only: the one frame kind parsed is `roster.revocations` (and `bye`); the statements are merged (each
//   counts only by its own signatures, §4.2), validity recomputed, then `bye{revoked}` and close. Frames after the last
//   chunk are not even decoded. Anything else first ends the session (`bye{role}`).
// - Full: `roster.revocations` pushes are merged; `ping` counts as heard; `bye` ends; other peer frames go to the
//   host's handler (later steps: gossip, replication, forwarding), or are dropped with one log line per type. Frames
//   are handled one at a time in order (the link awaits onFrame: D58).
// - Keepalive: `ping` after `pingMs` of this side's silence, `bye{dead}` after `deadMs` heard nothing.
import {
  decodeWireFrame, encodeChunkFrame, encodeWireFrame, fromBase64Url, statementId, type MessageOf, type SignedStatement, type WireMessage,
} from "../../protocol";
import { SessionLink, type LocalStatic, type PeerClaim, type PeerDecision, type PeerStatic, type SessionEnd, type SessionInfo, type SessionTransport } from "../../session";
import type { RosterChange, RosterView } from "../roster";
import type { PeerTimers } from "./config";

const PEER_KIND = { local: false } as const;
/** Statements per `roster.revocations` frame (the message's own cap). */
export const REVOCATIONS_PER_FRAME = 200;
/** The most statements one `roster.revocations` set (chunks up to the short last one) may carry before the session ends. */
export const MAX_REVOCATION_SET = 20_000;
/** How long a `bye` may take to leave before the link is closed anyway. */
const BYE_FLUSH_MS = 1_000;
const encoder = new TextEncoder();

type ByeReason = MessageOf<"bye">["reason"];

/** The roster as peer sessions use it (server/roster/store.ts). */
export interface PeerRoster {
  readonly clusterId: string | null;
  readonly memberId: string;
  readonly view: RosterView;
  revocations(): Array<{ id: string; statement: SignedStatement }>;
  mergeRevocations(statements: readonly unknown[]): Promise<string[]>;
  profile(member: string, field: "addresses"): string | null;
  onChange(listener: (change: RosterChange) => void): () => void;
}

export interface PeerSessionHost {
  roster: PeerRoster;
  self: LocalStatic;
  timers: PeerTimers;
  log(line: string): void;
  now?: () => number;
  /**
   * Later steps' handler for peer frames past the roster sync (gossip, replication, forwarding). Returning false means
   * "not mine": the frame is dropped with one log line per type.
   */
  onMessage?(session: PeerSession, message: WireMessage): void | boolean | Promise<void | boolean>;
  /** The registry kept this full session as the pair's one session (peers.ts), and when any session ended. */
  sessionOpened?(session: PeerSession): void;
  sessionClosed?(session: PeerSession): void;
}

/** A server member's keys in this roster (valid or not), or null when no Add names `member` as a server. */
export function serverKeys(view: RosterView, member: string): PeerStatic | null {
  if (member === view.self) return null;
  const info = view.members.get(member);
  if (!info || info.kind !== "server") return null;
  const dh = fromBase64Url(info.keys.dh);
  return dh && dh.length === 32 ? { memberId: member, dhPub: dh } : null;
}

/** The acceptor's roster check of a KK claim. Reads only (the claim is not proven when it runs). */
export function serverPeerCheck(roster: PeerRoster, claim: PeerClaim): PeerDecision {
  if (roster.clusterId === null) return { ok: false, detail: "no cluster yet" };
  if (claim.mode !== "kk") return { ok: false, detail: "servers dial in KK" };
  const keys = serverKeys(roster.view, claim.memberId);
  if (!keys) return { ok: false, detail: "not a server of this roster" };
  if (keys.dhPub.length !== claim.dhPub.length || keys.dhPub.some((byte, i) => byte !== claim.dhPub[i])) return { ok: false, detail: "another key than the roster's" };
  return { ok: true };
}

export interface PeerSessionEnd {
  reason: string;
  detail: string;
  /** This side ran the session as exchange only (D47). */
  exchangeOnly: boolean;
  /** What the peer's `bye` said, if it sent one. */
  peerBye: ByeReason | null;
  /** The handshake finished. */
  opened: boolean;
  lastHeard: number;
}

export interface PeerSessionEvents {
  /** A full session opened (not called for an exchange-only one). */
  opened?(session: PeerSession): void;
  /** An exchange-only session opened (D47). */
  exchange?(session: PeerSession): void;
  closed?(session: PeerSession, end: PeerSessionEnd): void;
}

export class PeerSession {
  readonly link: SessionLink;
  /** The member id of the side that dialled. */
  initiator: string | null;
  peer: string | null;
  exchangeOnly = false;
  state: "handshake" | "exchange" | "open" | "closed" = "handshake";
  /** Frames decoded (parsed) from the peer, and frames received after an exchange that were not decoded. */
  parsed = 0;
  unread = 0;
  /** Statements the peer's `roster.revocations` carried that were new here. */
  learned = 0;
  lastHeard: number;
  private lastSent: number;
  /** Revocation ids this session sent or received (pushes send only the others). */
  private readonly known = new Set<string>();
  /** The `roster.revocations` set being received: merged whole once its short last chunk is in (review P1). */
  private pending: SignedStatement[] = [];
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private peerSynced = false;
  private exchangeDone = false;
  private peerBye: ByeReason | null = null;
  private flushing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly ignored = new Set<string>();
  private readonly now: () => number;

  constructor(transport: SessionTransport, side: { dial: PeerStatic } | { accept: true; transport?: "tailnet" | "relay" }, private readonly host: PeerSessionHost, private readonly events: PeerSessionEvents = {}) {
    this.now = host.now ?? Date.now;
    this.lastHeard = this.lastSent = this.now();
    const cluster = host.roster.clusterId ?? "0".repeat(32);
    const linkEvents = { onFrame: (plaintext: Uint8Array) => this.onFrame(plaintext), onEnd: (end: SessionEnd) => this.onLinkEnd(end) };
    if ("dial" in side) {
      this.initiator = host.self.memberId;
      this.peer = side.dial.memberId;
      this.link = SessionLink.initiate(transport, { mode: "kk", transport: "tailnet", cluster, self: host.self, responder: side.dial }, linkEvents);
    } else {
      this.initiator = null;
      this.peer = null;
      this.link = SessionLink.respond(transport, {
        transport: side.transport ?? "tailnet", cluster, self: host.self, modes: ["kk"], kkFromRoster: true,
        checkPeer: (claim) => serverPeerCheck(host.roster, claim),
      }, linkEvents);
    }
    this.link.established.then((info) => this.onEstablished(info), () => undefined);
  }

  /** One frame from the transport. */
  receive(frame: Uint8Array): void { this.link.receive(frame); }
  /** The transport closed under the session. */
  transportClosed(): void { this.link.transportClosed(); }

  private onEstablished(info: SessionInfo): void {
    if (this.state !== "handshake") return;
    this.peer = info.peer.memberId;
    if (this.initiator === null) this.initiator = info.peer.memberId;
    const view = this.host.roster.view;
    this.exchangeOnly = !(view.valid.has(view.self) && view.valid.has(this.peer));
    this.state = this.exchangeOnly ? "exchange" : "open";
    this.lastHeard = this.now();
    if (this.exchangeOnly) {
      const why = view.valid.has(view.self) ? "the peer is not valid here" : "this server finds itself removed";
      this.host.log(`peer ${this.peer}: exchange only (${why}); sending revocations (D47)`);
    }
    this.sendRevocations(this.host.roster.revocations());
    this.startTimers();
    if (this.exchangeOnly) {
      // An exchange is short: it ends within the dead time even if the peer keeps sending (review P2).
      this.deadline = setTimeout(() => this.bye("dead", `the exchange did not finish in ${this.host.timers.deadMs} ms`), this.host.timers.deadMs);
      this.deadline.unref?.();
      this.events.exchange?.(this);
    }
    if (this.state === "open") this.events.opened?.(this);
  }

  /** Sends the revocations this session has not carried yet (a push, §4.6). */
  pushRevocations(): void {
    if (this.state !== "open" || this.flushing) return;
    const fresh = this.host.roster.revocations().filter((item) => !this.known.has(item.id));
    if (fresh.length) this.sendRevocations(fresh);
  }

  /** The peer, or this server, stopped being valid: send what this side holds, then `bye{revoked}` (§4.6). */
  revoke(detail: string): void {
    if (this.state === "closed" || this.flushing) return;
    if (this.state === "open") {
      const fresh = this.host.roster.revocations().filter((item) => !this.known.has(item.id));
      if (fresh.length) this.sendRevocations(fresh);
    }
    this.bye("revoked", detail);
  }

  /** Bytes queued to the peer and not yet sealed and handed to the transport (live frames back off on it). */
  get queuedBytes(): number { return this.link.queuedBytes; }

  /** Sends a frame of a later step's protocol on a full session (false: not open, or not sent). */
  sendWire(message: WireMessage): boolean {
    if (this.state !== "open" || this.flushing) return false;
    return this.send(message);
  }

  /**
   * Sends a `content.chunk` as a binary frame on the bulk lane (M3 step 10, §5.3: control frames still go first, so an
   * approval waits at most one chunk). False: not open, or not sent.
   */
  sendChunk(message: MessageOf<"content.chunk">): boolean {
    if (this.state !== "open" || this.flushing || this.link.state === "ended") return false;
    const encoded = encodeChunkFrame(message, "peer", PEER_KIND);
    if (!encoded.ok) { this.host.log(`peer ${this.peer ?? "?"}: cannot send content.chunk: ${encoded.detail}`); return false; }
    try { this.link.send("bulk", encoded.bytes); } catch { return false; }
    this.lastSent = this.now();
    return true;
  }

  /** Sends `bye` and closes once it left (or after a short wait). */
  bye(reason: ByeReason, detail: string): void {
    if (this.state === "closed" || this.flushing) return;
    if (this.link.state === "open") this.send({ t: "bye", reason, detail: detail.slice(0, 500) });
    this.endWith(`bye ${reason}`, detail);
  }

  /** Ends at once, without a bye. */
  close(detail = "closed by this side"): void { this.finish("closed", detail); }

  private sendRevocations(list: Array<{ id: string; statement: SignedStatement }>): void {
    for (const item of list) this.known.add(item.id);
    const statements = list.map((item) => item.statement);
    // Always end on a chunk shorter than the cap (empty if need be): it tells the peer the set is complete.
    for (let at = 0; ; at += REVOCATIONS_PER_FRAME) {
      const chunk = statements.slice(at, at + REVOCATIONS_PER_FRAME);
      this.send({ t: "roster.revocations", statements: chunk } as WireMessage);
      if (chunk.length < REVOCATIONS_PER_FRAME) break;
    }
  }

  private send(message: WireMessage): boolean {
    if (this.state === "closed" || this.link.state === "ended") return false;
    const encoded = encodeWireFrame(message, "peer", PEER_KIND);
    if (!encoded.ok) { this.host.log(`peer ${this.peer ?? "?"}: cannot send ${message.t}: ${encoded.detail}`); return false; }
    try { this.link.send("control", encoder.encode(encoded.text)); } catch { return false; }
    this.lastSent = this.now();
    return true;
  }

  private async onFrame(plaintext: Uint8Array): Promise<void> {
    if (this.state === "closed" || this.flushing) return;
    this.lastHeard = this.now();
    if (this.state === "exchange" && this.exchangeDone) { this.unread++; return; }
    const decoded = decodeWireFrame(plaintext, "peer", PEER_KIND);
    if (!decoded.ok) { this.send(decoded.bye); this.endWith(`bye ${decoded.bye.reason}`, decoded.detail); return; }
    this.parsed++;
    const message = decoded.message;
    if (message.t === "bye") { this.peerBye = message.reason; this.finish("peer bye", `${message.reason}${message.detail ? `: ${message.detail}` : ""}`); return; }
    if (this.state === "exchange") {
      if (message.t !== "roster.revocations") { this.bye("role", "a session that is exchange only carries roster.revocations and bye (D47)"); return; }
      const last = await this.merge(message.statements);
      if (!last || this.state !== "exchange") return;
      this.exchangeDone = true;
      this.host.log(`peer ${this.peer}: exchange done (${this.learned} new statements taken)`);
      this.bye("revoked", "exchange only: a member of this pair is not valid here (D47)");
      return;
    }
    if (message.t === "roster.revocations") {
      const last = await this.merge(message.statements);
      if (last) this.peerSynced = true;
      return;
    }
    if (!this.peerSynced) { this.bye("role", "the roster sync comes first in a peer session (§4.6)"); return; }
    if (message.t === "ping") return;
    if (this.host.onMessage && (await this.host.onMessage(this, message)) !== false) return;
    if (!this.ignored.has(message.t)) { this.ignored.add(message.t); this.host.log(`peer ${this.peer}: ${message.t} is not handled yet; dropped`); }
  }

  /**
   * Takes one `roster.revocations` chunk; once the set's short last chunk is in, merges the whole set (a later root's
   * Revoke counts only next to its Root, which may come in another chunk) and returns true. A set larger than
   * MAX_REVOCATION_SET ends the session. Only ids the roster holds afterwards are remembered (pushes skip them).
   */
  private async merge(statements: SignedStatement[]): Promise<boolean> {
    if (this.pending.length + statements.length > MAX_REVOCATION_SET) {
      this.pending = [];
      this.bye("too-large", `a roster.revocations set holds at most ${MAX_REVOCATION_SET} statements`);
      return false;
    }
    this.pending.push(...statements);
    if (statements.length >= REVOCATIONS_PER_FRAME) return false;
    const set = this.pending;
    this.pending = [];
    const fresh = await this.host.roster.mergeRevocations(set);
    const held = new Set(this.host.roster.revocations().map((item) => item.id));
    for (const statement of set) {
      const id = await statementId(statement.body);
      if (held.has(id)) this.known.add(id);
    }
    this.learned += fresh.length;
    if (fresh.length) this.host.log(`peer ${this.peer}: took ${fresh.length} revocation statement(s)`);
    return true;
  }

  private startTimers(): void {
    const { pingMs, deadMs } = this.host.timers;
    const every = Math.max(10, Math.min(pingMs, deadMs) / 4);
    this.timer = setInterval(() => {
      if (this.state === "closed" || this.flushing) return;
      const now = this.now();
      if (now - this.lastHeard >= deadMs) { this.bye("dead", `nothing heard for ${deadMs} ms`); return; }
      if (now - this.lastSent >= pingMs) this.send({ t: "ping", at: now });
    }, every);
    this.timer.unref?.();
  }

  private endWith(reason: string, detail: string): void {
    if (this.state === "closed" || this.flushing) return;
    this.flushing = true;
    const link = this.link;
    const timer = setTimeout(() => link.close(), BYE_FLUSH_MS);
    timer.unref?.();
    void link.drain().then(() => { clearTimeout(timer); link.close(); });
    this.finish(reason, detail);
  }

  private onLinkEnd(end: SessionEnd): void {
    this.finish(end.reason, end.detail);
  }

  private finish(reason: string, detail: string): void {
    if (this.state === "closed") return;
    const opened = this.state !== "handshake";
    this.state = "closed";
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.deadline) { clearTimeout(this.deadline); this.deadline = null; }
    this.pending = [];
    if (!this.flushing) this.link.close();
    this.events.closed?.(this, { reason, detail, exchangeOnly: this.exchangeOnly, peerBye: this.peerBye, opened, lastHeard: this.lastHeard });
  }
}
