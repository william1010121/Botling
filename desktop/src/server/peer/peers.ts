// Every peer server of this botlingd (M3 step 3, protocol v1 §4.6, §6.2, §10.5, D47): the dialler, the acceptor's
// sessions, one live session per pair, and each peer's state (`peer{serverId, state, since}`).
//
// Who is a peer: every member an Add in this roster names as a server (valid or not), except this server.
// When to dial (re-decided at start and after every roster change):
//   - this server valid, peer valid  → dial while no live session, with backoff (redialMin doubling to redialMax,
//     ±25 %; a session that went live resets it);
//   - this server valid, peer not    → never dial it (its handshakes still get the exchange, D47); state `gone`;
//   - this server removed            → dial each peer every `revokedRedialMs` (10 min) for the exchange only, so a
//     `Root` that brings it back reaches it (§4.8);
//   - a session that ended as an exchange (this side found a member not valid, or the peer said `bye{revoked}`) and
//     did not make both valid here → the next dial to that peer waits `revokedRedialMs` too.
// One session per pair (§6.2): when a second full session with the same peer opens, the one dialled by the smaller
// member id (the server id of a 3.x data folder) is kept; with the same dialler, the newer. Both sides apply the
// same rule to the same facts, so they keep the same session; the other gets `bye{closing}`.
// State: `live` (since it opened) while a full session is open; `stale` since the last frame heard once it ends (or
// `since: null` before any session in this run); `gone` while the roster says the peer is not valid.
import { writeFileSync } from "node:fs";
import type { ServerState } from "../../protocol";
import type { SessionTransport } from "../../session";
import { loopbackAddress, type PeerTimers } from "./config";
import { webSocketConnector, type PeerConnector } from "./connector";
import { PeerSession, serverKeys, type PeerSessionEnd, type PeerSessionHost } from "./peer-session";

export interface PeerState {
  member: string;
  name: string;
  state: ServerState;
  since: number | null;
  /** The live session's dialler and id. */
  initiator?: string;
  sessionId?: string;
}

export interface PeerSessionsOptions {
  connector?: PeerConnector;
  /** Written (0600) on every state change: `botlingd.peers.json`. */
  stateFile?: string;
  random?: () => number;
}

type Policy = "normal" | "none" | "revoked";

interface Entry {
  member: string;
  state: ServerState;
  since: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  dialing: boolean;
  attempts: number;
  /** No dial before this time (a refused exchange, or the removed server's 10-min rhythm). */
  holdUntil: number;
  noAddressLogged: boolean;
}

export class PeerSessions {
  private readonly entries = new Map<string, Entry>();
  private readonly live = new Map<string, PeerSession>();
  private readonly sessions = new Set<PeerSession>();
  /** The exchange-only session each peer dialled in (one per peer: a newer one closes the older, review P2). */
  private readonly inboundExchanges = new Map<string, PeerSession>();
  private readonly listeners = new Set<(state: PeerState) => void>();
  private readonly connector: PeerConnector;
  private readonly random: () => number;
  private readonly now: () => number;
  private unlisten: (() => void) | null = null;
  private started = false;
  private closed = false;

  constructor(private readonly host: PeerSessionHost, private readonly options: PeerSessionsOptions = {}) {
    this.connector = options.connector ?? webSocketConnector;
    this.random = options.random ?? Math.random;
    this.now = host.now ?? Date.now;
  }

  get timers(): PeerTimers { return this.host.timers; }

  /** Starts dialling (now and after every roster change). */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.unlisten = this.host.roster.onChange((change) => this.rosterChanged(change.invalidated));
    this.reconcile();
  }

  /** Each peer's state. */
  states(): PeerState[] {
    return [...this.entries.values()].sort((a, b) => (a.member < b.member ? -1 : 1)).map((entry) => this.stateOf(entry));
  }

  /** The live session with `member`, if any. */
  session(member: string): PeerSession | null { return this.live.get(member) ?? null; }
  /** Every session (handshakes and exchanges included). */
  get all(): PeerSession[] { return [...this.sessions]; }

  onState(listener: (state: PeerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A transport whose first frame is a KK HS1 (server/peer/router.ts): this side answers it. */
  accept(transport: SessionTransport, kind: "tailnet" | "relay" = "tailnet"): PeerSession {
    const session = new PeerSession(transport, { accept: true, transport: kind }, this.host, this.sessionEvents());
    this.sessions.add(session);
    if (this.closed) session.close("botlingd is stopping");
    return session;
  }

  /** Every session gets `bye{closing}`; no more dials. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unlisten?.();
    for (const entry of this.entries.values()) if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    for (const session of [...this.sessions]) {
      if (session.state === "open" || session.state === "exchange") session.bye("closing", "botlingd is stopping");
      else session.close("botlingd is stopping");
    }
  }

  // ---------------------------------------------------------------------------------------------

  private policy(member: string): Policy {
    const view = this.host.roster.view;
    if (!view.valid.has(view.self)) return "revoked";
    return view.valid.has(member) ? "normal" : "none";
  }

  private peerIds(): string[] {
    const view = this.host.roster.view;
    if (this.host.roster.clusterId === null) return [];
    return [...view.members.values()].filter((info) => info.kind === "server" && info.member !== view.self).map((info) => info.member).sort();
  }

  private entry(member: string): Entry {
    let entry = this.entries.get(member);
    if (!entry) {
      entry = { member, state: "stale", since: null, timer: null, dialing: false, attempts: 0, holdUntil: 0, noAddressLogged: false };
      this.entries.set(member, entry);
    }
    return entry;
  }

  private rosterChanged(invalidated: string[]): void {
    if (this.closed) return;
    const self = this.host.roster.memberId;
    const gone = new Set(invalidated);
    for (const session of [...this.sessions]) {
      if (session.state !== "open") continue;
      if (gone.has(self)) session.revoke("this server was removed from the roster");
      else if (session.peer && gone.has(session.peer)) session.revoke("that server was removed from the roster");
      else session.pushRevocations();
    }
    this.reconcile();
  }

  /** Re-decides every peer's dial and state. */
  private reconcile(): void {
    if (this.closed || !this.started) return;
    for (const member of this.peerIds()) {
      const entry = this.entry(member);
      const policy = this.policy(member);
      if (policy === "none") {
        if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
        if (!this.live.has(member)) this.setState(entry, "gone", this.now());
        continue;
      }
      if (entry.state === "gone" && !this.live.has(member)) this.setState(entry, "stale", entry.since);
      // A peer that had no keys or address when last dialled (a server learned through gossip, M3 step 5): dial now
      // that the roster names them, instead of waiting out the backoff.
      if (entry.noAddressLogged && entry.timer && serverKeys(this.host.roster.view, member) && loopbackAddress(this.host.roster.profile(member, "addresses"))) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      this.schedule(entry, policy);
    }
  }

  private schedule(entry: Entry, policy: Policy): void {
    if (this.closed || entry.timer || entry.dialing || this.live.has(entry.member) || policy === "none") return;
    const { redialMinMs, redialMaxMs } = this.host.timers;
    let delay: number;
    if (entry.attempts === 0) delay = this.random() * Math.min(250, redialMinMs);
    else delay = Math.min(redialMaxMs, redialMinMs * 2 ** (entry.attempts - 1)) * (0.75 + this.random() * 0.5);
    delay = Math.max(delay, entry.holdUntil - this.now(), 0);
    entry.timer = setTimeout(() => { entry.timer = null; void this.dial(entry); }, delay);
    entry.timer.unref?.();
  }

  private async dial(entry: Entry): Promise<void> {
    const member = entry.member;
    const policy = this.policy(member);
    if (this.closed || entry.dialing || this.live.has(member) || policy === "none") return;
    const keys = serverKeys(this.host.roster.view, member);
    const url = loopbackAddress(this.host.roster.profile(member, "addresses"));
    entry.attempts++;
    if (policy === "revoked") entry.holdUntil = this.now() + this.host.timers.revokedRedialMs;
    if (!keys || !url) {
      // Not a try: the peer's Add or Profile may still be on its way (gossip, M3 step 5); a roster change that brings
      // them redials at once (reconcile).
      entry.attempts = Math.max(0, entry.attempts - 1);
      if (!entry.noAddressLogged) { entry.noAddressLogged = true; this.host.log(`peer ${member}: no ${keys ? "loopback address in its profile" : "server keys in the roster"}; not dialled yet`); }
      this.schedule(entry, policy);
      return;
    }
    entry.noAddressLogged = false;
    entry.dialing = true;
    this.host.log(`peer ${member}: dialling${policy === "revoked" ? " (exchange only: this server finds itself removed, D47)" : ""}`);
    let connection;
    try {
      connection = await this.connector.connect(url);
    } catch (error) {
      entry.dialing = false;
      this.host.log(`peer ${member}: dial failed: ${String((error as Error)?.message ?? error)}`);
      this.schedule(entry, this.policy(member));
      return;
    }
    if (this.closed) { connection.close(); entry.dialing = false; return; }
    const session = new PeerSession(connection, { dial: keys }, this.host, this.sessionEvents(entry));
    this.sessions.add(session);
    connection.bind({ frame: (frame) => session.receive(frame), closed: () => session.transportClosed() });
  }

  private sessionEvents(dialled?: Entry) {
    return {
      opened: (session: PeerSession) => this.opened(session),
      exchange: (session: PeerSession) => this.exchangeOpened(session),
      closed: (session: PeerSession, end: PeerSessionEnd) => {
        if (dialled) dialled.dialing = false;
        this.closedSession(session, end);
      },
    };
  }

  private opened(session: PeerSession): void {
    const peer = session.peer!;
    if (this.closed) { session.bye("closing", "botlingd is stopping"); return; }
    const existing = this.live.get(peer);
    let keep = session;
    if (existing && existing !== session && existing.state === "open") {
      const smaller = this.host.roster.memberId < peer ? this.host.roster.memberId : peer;
      const newWins = session.initiator === smaller || existing.initiator !== smaller;
      keep = newWins ? session : existing;
      const loser = newWins ? existing : session;
      this.live.set(peer, keep);
      this.host.log(`peer ${peer}: two sessions; keeping the one dialled by ${keep.initiator} (one per pair)`);
      loser.bye("closing", "one session per pair: the session dialled by the smaller server id is kept");
    }
    this.live.set(peer, keep);
    const entry = this.entry(peer);
    entry.attempts = 0;
    entry.holdUntil = 0;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    if (keep === session) {
      try { this.host.sessionOpened?.(session); } catch (error) { this.host.log(`peer ${peer}: ${String((error as Error)?.message ?? error)}`); }
      this.host.log(`peer ${peer}: live (session ${session.link.info?.sessionId ?? "?"}, dialled by ${session.initiator})`);
      this.setState(entry, "live", this.now(), true);
    }
  }

  /** A peer that is not valid here holds at most one connection: its newer exchange closes the older one. */
  private exchangeOpened(session: PeerSession): void {
    const peer = session.peer;
    if (!peer || session.initiator === this.host.roster.memberId) return;
    const older = this.inboundExchanges.get(peer);
    this.inboundExchanges.set(peer, session);
    if (older && older !== session) older.bye("closing", "one exchange per peer: a newer one opened");
  }

  private closedSession(session: PeerSession, end: PeerSessionEnd): void {
    this.sessions.delete(session);
    try { this.host.sessionClosed?.(session); } catch { /* a listener never stops the registry */ }
    if (session.peer && this.inboundExchanges.get(session.peer) === session) this.inboundExchanges.delete(session.peer);
    const peer = session.peer;
    if (this.closed) return;
    if (end.opened) this.host.log(`peer ${peer}: session ended (${end.reason}: ${end.detail})`);
    else this.host.log(`peer ${peer ?? "?"}: handshake ended (${end.reason}: ${end.detail})`);
    if (!peer) return;
    const known = this.peerIds().includes(peer);
    if (!known) return;
    const entry = this.entry(peer);
    const wasLive = this.live.get(peer) === session;
    if (wasLive) this.live.delete(peer);
    const policy = this.policy(peer);
    const exchanged = end.opened && (end.exchangeOnly || end.peerBye === "revoked");
    if (exchanged) {
      const improved = end.exchangeOnly && policy === "normal";
      if (improved) { entry.attempts = 0; entry.holdUntil = 0; }
      else entry.holdUntil = Math.max(entry.holdUntil, this.now() + this.host.timers.revokedRedialMs);
    }
    if (wasLive) this.setState(entry, policy === "none" ? "gone" : "stale", policy === "none" ? this.now() : end.lastHeard);
    if (policy !== "none") this.schedule(entry, policy);
  }

  private stateOf(entry: Entry): PeerState {
    const view = this.host.roster.view;
    const live = this.live.get(entry.member);
    return {
      member: entry.member, name: view.members.get(entry.member)?.name ?? entry.member, state: entry.state, since: entry.since,
      ...(live && entry.state === "live" ? { initiator: live.initiator ?? undefined, sessionId: live.link.info?.sessionId } : {}),
    };
  }

  private setState(entry: Entry, state: ServerState, since: number | null, force = false): void {
    if (!force && entry.state === state) return;
    entry.state = state;
    entry.since = since;
    const view = this.stateOf(entry);
    if (state !== "live") this.host.log(`peer ${entry.member}: ${state}${since !== null ? ` since ${new Date(since).toISOString()}` : ""}`);
    for (const listener of this.listeners) { try { listener(view); } catch { /* a listener never stops the registry */ } }
    this.writeStateFile();
  }

  private writeStateFile(): void {
    if (!this.options.stateFile) return;
    try { writeFileSync(this.options.stateFile, `${JSON.stringify({ pid: process.pid, peers: this.states() })}\n`, { mode: 0o600 }); } catch { /* status then says nothing */ }
  }
}
