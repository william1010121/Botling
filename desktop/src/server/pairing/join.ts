// Server pairing (protocol v1 §4.5, D46, D60; M3 step 4): `botlingd join` on the joining server N, `botlingd
// add-machine <link>` on a member S, both over each server's local socket (`admin`, local only).
//
//   N  join.offer     a one-time offer: id, a 32-byte secret (mixed into the `pair` handshake, as a device pairing
//                     offer) and an 8-character code (`53RV-XFK8`). The link names N's id, keys and loopback address and
//                     the secret, never the code: the user reads the code off N's screen and types it into S. The
//                     secret and the code live in N's memory only (never in server.db, a file or the log); 5 minutes,
//                     single use, three wrong codes burn it. Refused while N belongs to a cluster ("a server joins only
//                     while it has no other members"; a cluster of its own counts, its Root would have to go).
//   S  machine.add    S dials N's address from the link in `pair` mode with the offer and its secret (N's static key
//                     from the link is proven by HS2). Both send `join.hello` (name, signing key, a proof over the
//                     transcript, cluster, members): S then shows N's fingerprint (its member id), N shows S's.
//   S  machine.code   the typed code goes to N (`join.code`); N answers `join.wrong{left}`, `join.declined{code}` on the
//                     third wrong one, or `join.checked`.
//   S                 commits `Add{N, server, joined: true}` (and a Profile naming the address it reached N at, and its
//                     own Profile), then sends `join.welcome` with every statement it holds, the cluster VAPID key
//                     (made now if this is the first server pairing, §18.4 / Q4) and the preferences.
//   N                 takes the cluster id, commits the statements, `Add{S, server, joined: false}` (D60) and its own
//                     Profile in one transaction with `meta.clusterId`, endorses every member it finds valid
//                     (store.ts), writes the VAPID key (0600), and answers `join.done{add}`; S stores N's Add.
// Both commits happen before either side calls the pairing done. A cut after S's commit leaves S's Add (it is idempotent:
// a retry with the same link gets the same Add) and gives N's offer back while it lasts; N never becomes the root.
//
// The handshake runs before either side has a common cluster, so its transcript names the placeholder cluster
// `JOIN_CLUSTER`; the real cluster id travels inside the session, in the signed Add. Every `join.*` frame is decoded as a
// pairing session between peers (roles.ts): nothing else is taken on it.
import {
  decodeWireFrame, encodeWireFrame, fromBase64Url, JOIN_CODE_TRIES, JOIN_OFFER_TTL_MS, JOIN_ROSTER_LIMIT, JoinCode, joinCodeFromBytes,
  joinLink, joinOfferExpired, memberFingerprint, memberIdFromKey, parseJoinLink, PROTOCOL_VERSION, toBase64Url,
  type AdminEvent, type AdminOp, type JoinOffer, type PrefRow, type SignedStatement, type WireMessage, type WireMessageOf,
} from "../../protocol";
import { signPairProof, verifyPairProof, SessionLink, type LocalStatic, type PeerClaim, type PeerDecision, type SessionEnd, type SessionInfo, type SessionTransport } from "../../session";
import { ensureVapidKeys, readVapidKeys, vapidFilePath, writeVapidKeys } from "../identity/vapid";
import { addressesForUrl } from "../peer/config";
import { webSocketConnector, type PeerConnection, type PeerConnector } from "../peer/connector";
import type { RosterStore } from "../roster/store";
import { rmSync } from "node:fs";

/** The cluster id a join handshake's transcript names (neither side shares a cluster yet). */
export const JOIN_CLUSTER = "0".repeat(32);
/** How long an established join session may take for its `join.hello`. */
export const JOIN_HELLO_TIMEOUT_MS = 15_000;
/** How long S waits for N's answer to a code or to the welcome. */
export const JOIN_REPLY_TIMEOUT_MS = 30_000;
const PAIRING_KIND = { local: false, pairing: true } as const;
const LOOPBACK_WS = /^ws:\/\/127\.0\.0\.1:([0-9]{1,5})\/v3\/ws$/;
const encoder = new TextEncoder();

export class JoinError extends Error {
  constructor(readonly code: "member" | "no-cluster" | "no-address" | "bad-link" | "expired" | "unknown" | "state" | "unreachable" | "declined" | "bad-peer", message: string) {
    super(message);
    this.name = "JoinError";
  }
}

export interface ServerJoinOptions {
  roster: RosterStore;
  identity: { readonly memberId: string; readonly keys: { readonly sign: string; readonly dh: string }; readonly dhPub: Uint8Array; readonly dhKey: CryptoKey; readonly signKey: CryptoKey };
  serverName: string;
  version: string;
  /** The data folder (the cluster VAPID key lives there). */
  dataDir: string;
  /** This server's Profile `addresses` value (its loopback listener), or null while it has none. */
  ownAddresses: () => string | null;
  /** The WebSocket URLs a join offer names (this server's loopback `/v3/ws`); empty while there is no listener. */
  joinAddresses: () => string[];
  connector?: PeerConnector;
  /** M3 step 5: the cluster preferences, handed to N in the welcome (§4.5 step 3) and merged there after the join. */
  prefs?: { rows(): PrefRow[]; merge(rows: readonly unknown[]): Promise<PrefRow[]> };
  now?: () => number;
  log?: (line: string) => void;
  helloTimeoutMs?: number;
  replyTimeoutMs?: number;
}

export interface JoinOfferResult { offer: string; link: string; code: string; server: string; name: string; fingerprint: string; expiresAt: number }
export interface MachineAddResult { attempt: string; server: string; name: string; fingerprint: string; self: { server: string; fingerprint: string }; expiresAt: number }
export type MachineCodeResult =
  | { ok: true; server: string; name: string; addId: string; created: boolean; cluster: string }
  | { ok: false; reason: "wrong"; left: number }
  | { ok: false; reason: "malformed" | "code" | "expired" | "used" | "busy" | "cancelled" | "member" | "cluster" | "unsupported" | "lost" | "refused"; detail?: string };

// ---------------------------------------------------------------------------------------------
// One encrypted join session (either side): frames in order, a small inbox S reads from.

class JoinChannel {
  readonly link: SessionLink;
  info: SessionInfo | null = null;
  ended = false;
  private readonly inbox: WireMessage[] = [];
  private waiter: ((message: WireMessage | null) => void) | null = null;

  constructor(transport: SessionTransport, side: { dial: Parameters<typeof SessionLink.initiate>[1] } | { accept: Parameters<typeof SessionLink.respond>[1] }, private readonly onMessage: ((message: WireMessage) => void | Promise<void>) | null, private readonly onEnd: (end: SessionEnd) => void, private readonly log: (line: string) => void) {
    const events = { onFrame: (plaintext: Uint8Array) => this.frame(plaintext), onEnd: (end: SessionEnd) => this.end(end) };
    this.link = "dial" in side ? SessionLink.initiate(transport, side.dial, events) : SessionLink.respond(transport, side.accept, events);
    this.link.established.then((info) => { this.info = info; }, () => undefined);
  }

  send(message: WireMessage): boolean {
    if (this.ended || this.link.state === "ended") return false;
    const encoded = encodeWireFrame(message, "peer", PAIRING_KIND);
    if (!encoded.ok) { this.log(`server pairing: cannot send ${message.t}: ${encoded.detail}`); return false; }
    try { this.link.send("control", encoder.encode(encoded.text)); } catch { return false; }
    return true;
  }

  /** Sends what is queued, then closes. */
  finish(): void {
    if (this.ended) return;
    const link = this.link;
    const timer = setTimeout(() => link.close(), 1_000);
    timer.unref?.();
    void link.drain().then(() => { clearTimeout(timer); link.close(); });
  }

  close(): void { this.link.close(); }

  /** The next message (S side), or null when the session ended or the wait timed out. */
  next(timeoutMs: number): Promise<WireMessage | null> {
    if (this.inbox.length) return Promise.resolve(this.inbox.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiter = null; resolve(null); }, timeoutMs);
      timer.unref?.();
      this.waiter = (message) => { clearTimeout(timer); this.waiter = null; resolve(message); };
    });
  }

  private async frame(plaintext: Uint8Array): Promise<void> {
    if (this.ended) return;
    const decoded = decodeWireFrame(plaintext, "peer", PAIRING_KIND);
    if (!decoded.ok) { this.send(decoded.bye); this.log(`server pairing: a frame was refused (${decoded.reason})`); this.finish(); return; }
    if (this.onMessage) { await this.onMessage(decoded.message); return; }
    if (this.waiter) this.waiter(decoded.message); else this.inbox.push(decoded.message);
  }

  private end(end: SessionEnd): void {
    if (this.ended) return;
    this.ended = true;
    this.waiter?.(null);
    this.onEnd(end);
  }
}

// ---------------------------------------------------------------------------------------------
// N's side: offers and the sessions that answer them.

interface Offer {
  id: string;
  secret: Uint8Array;
  code: string;
  name: string;
  expiresAt: number;
  left: number;
  state: "open" | "busy" | "used";
  owner: object | null;
  session: NSession | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface NSession {
  channel: JoinChannel;
  offer: Offer | null;
  sponsor: { member: string; name: string; sign: string; dh: string } | null;
  checked: boolean;
  joining: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------------------------
// S's side: one attempt per link.

interface Attempt {
  id: string;
  offer: JoinOffer;
  url: string;
  channel: JoinChannel;
  peer: { member: string; name: string } | null;
  busy: boolean;
  welcoming: boolean;
  owner: object | null;
  ownerClosed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export class ServerJoin {
  private readonly offers = new Map<string, Offer>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly listeners = new Set<(event: AdminEvent) => void>();
  private readonly closedOwners = new WeakSet<object>();
  private readonly ownerAborts = new Map<object, Set<() => void>>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly connector: PeerConnector;
  private closed = false;

  constructor(private readonly options: ServerJoinOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.connector = options.connector ?? webSocketConnector;
  }

  private get self(): LocalStatic { return { memberId: this.options.identity.memberId, dhPub: this.options.identity.dhPub, dhKey: this.options.identity.dhKey }; }

  onEvent(listener: (event: AdminEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The local socket's join requests. */
  async admin(op: AdminOp, session?: object): Promise<unknown> {
    if (session && this.closedOwners.has(session)) throw new JoinError("state", "the admin session closed");
    switch (op.op) {
      case "join.offer": return this.createOffer(op.name, session);
      case "join.cancel": return this.cancelOffer(op.offer);
      case "machine.add": return this.addMachine(op.link, session);
      case "machine.code": return this.code(op.attempt, op.code);
      case "machine.cancel": return this.cancelAttempt(op.attempt);
      default: throw new JoinError("state", `${op.op} is not a server pairing request`);
    }
  }

  /** M4-46 (J8): burns offers and cancels attempts owned by a local admin session that left, letting an in-flight welcome finish. */
  adminClosed(session: object): void {
    this.closedOwners.add(session);
    const aborts = this.ownerAborts.get(session);
    if (aborts) {
      this.ownerAborts.delete(session);
      for (const abort of [...aborts]) abort();
    }
    for (const offer of [...this.offers.values()]) {
      if (offer.owner === session && !offer.session?.joining) this.burn(offer, "cancelled");
    }
    for (const attempt of [...this.attempts.values()]) {
      if (attempt.owner !== session) continue;
      attempt.ownerClosed = true;
      if (!attempt.welcoming) this.cancelAttempt(attempt.id);
    }
  }

  /** Whether `offerId` names one of this server's join offers (server/peer/router.ts sends that HS1 here). */
  isOffer(offerId: string): boolean { return this.offers.has(offerId); }

  /** botlingd stops: offers forgotten, sessions closed. */
  close(): void {
    this.closed = true;
    for (const aborts of this.ownerAborts.values()) for (const abort of [...aborts]) abort();
    this.ownerAborts.clear();
    for (const offer of [...this.offers.values()]) this.burn(offer, "cancelled");
    for (const attempt of [...this.attempts.values()]) this.dropAttempt(attempt, "botlingd is stopping");
  }

  private trackOwnerAbort(owner: object | undefined, abort: () => void): () => void {
    if (!owner) return () => undefined;
    let set = this.ownerAborts.get(owner);
    if (!set) { set = new Set(); this.ownerAborts.set(owner, set); }
    set.add(abort);
    return () => {
      set!.delete(abort);
      if (set!.size === 0) this.ownerAborts.delete(owner);
    };
  }

  // ---------------------------------------------------------------------------------------------
  // N

  /** A join offer (refused while this server belongs to a cluster). */
  createOffer(name?: string, owner?: object): JoinOfferResult {
    if (owner && this.closedOwners.has(owner)) throw new JoinError("state", "the admin session closed");
    if (this.options.roster.clusterId !== null) throw new JoinError("member", "this server already belongs to a cluster, so it cannot join another one (a server joins only while it has no other members)");
    const addresses = this.options.joinAddresses();
    if (!addresses.length) throw new JoinError("no-address", "this server has no loopback listener another server could reach (BOTLING_SERVER_PORT)");
    for (const offer of [...this.offers.values()]) if (offer.state !== "busy") this.burn(offer, "cancelled");
    const id = toBase64Url(randomBytes(16));
    const secret = randomBytes(32);
    const code = joinCodeFromBytes(randomBytes(5));
    const expiresAt = this.now() + JOIN_OFFER_TTL_MS;
    const serverName = (name?.trim() || this.options.serverName).slice(0, 100) || "Botling";
    const link = joinLink({
      v: 1, offer: id, server: this.options.identity.memberId, name: serverName,
      keys: { sign: this.options.identity.keys.sign, dh: this.options.identity.keys.dh }, secret: toBase64Url(secret), expiresAt, addresses,
    });
    const offer: Offer = { id, secret, code: JoinCode.parse(code), name: serverName, expiresAt, left: JOIN_CODE_TRIES, state: "open", owner: owner ?? null, session: null, timer: null };
    // The offer's time holds for an open session too (review J1): an intruder with the link's secret who keeps a session
    // open must not keep the secret and the code alive past it. Only a welcome being taken is let finish.
    offer.timer = setTimeout(() => { if (!offer.session?.joining) this.burn(offer, "expired"); }, Math.max(0, expiresAt - this.now()) + 5);
    offer.timer.unref?.();
    this.offers.set(id, offer);
    this.log(`server pairing: join offer ${id} made (until ${new Date(expiresAt).toISOString()})`);
    return { offer: id, link, code, server: this.options.identity.memberId, name: serverName, fingerprint: memberFingerprint(this.options.identity.memberId), expiresAt };
  }

  cancelOffer(offerId: string): { ok: boolean } {
    const offer = this.offers.get(offerId);
    if (!offer) return { ok: false };
    this.burn(offer, "cancelled");
    return { ok: true };
  }

  /** A transport whose first frame is a `pair` HS1 naming one of this server's join offers. */
  accept(transport: SessionTransport): { readonly link: { readonly established: Promise<unknown> }; receive(frame: Uint8Array): void; transportClosed(): void } {
    const session: NSession = { channel: null!, offer: null, sponsor: null, checked: false, joining: false, timer: null };
    session.channel = new JoinChannel(transport, {
      accept: {
        transport: "tailnet", cluster: JOIN_CLUSTER, self: this.self, modes: ["pair"],
        checkPeer: (claim) => this.checkClaim(claim),
        offerSecret: (offerId) => {
          const offer = this.offers.get(offerId);
          return offer && offer.state === "open" && !joinOfferExpired(offer, this.now()) ? offer.secret : null;
        },
      },
    }, (message) => this.onN(session, message), () => this.nClosed(session), this.log);
    session.channel.link.established.then((info) => this.nEstablished(session, info), () => undefined);
    return { link: session.channel.link, receive: (frame) => session.channel.link.receive(frame), transportClosed: () => session.channel.link.transportClosed() };
  }

  /** Read only (the claim is not proven when this runs). */
  private checkClaim(claim: PeerClaim): PeerDecision {
    if (claim.mode !== "pair" || !claim.offer || !this.offers.has(claim.offer)) return { ok: false, detail: "not a join offer of this server" };
    if (this.options.roster.clusterId !== null) return { ok: false, detail: "this server already belongs to a cluster" };
    return { ok: true };
  }

  private nEstablished(session: NSession, info: SessionInfo): void {
    const offer = info.offer ? this.offers.get(info.offer) : undefined;
    const channel = session.channel;
    if (this.closed || !offer || joinOfferExpired(offer, this.now())) { channel.send({ t: "join.declined", reason: "expired" }); channel.finish(); return; }
    if (offer.state !== "open") { channel.send({ t: "join.declined", reason: offer.state === "used" ? "used" : "busy" }); channel.finish(); return; }
    if (this.options.roster.clusterId !== null) { channel.send({ t: "join.declined", reason: "member" }); channel.finish(); this.burn(offer, "member"); return; }
    offer.state = "busy";
    offer.session = session;
    session.offer = offer;
    session.timer = setTimeout(() => { if (!session.sponsor) { this.log(`server pairing: offer ${offer.id}: no join.hello in time`); channel.finish(); } }, this.options.helloTimeoutMs ?? JOIN_HELLO_TIMEOUT_MS);
    session.timer.unref?.();
    void this.sendHello(channel, info, offer.name);
  }

  private async sendHello(channel: JoinChannel, info: SessionInfo, name: string): Promise<void> {
    const view = this.options.roster.view;
    const proof = await signPairProof(this.options.identity.signKey, info.transcriptHash);
    channel.send({
      t: "join.hello", name, sign: this.options.identity.keys.sign, proof: toBase64Url(proof), version: this.options.version, protocol: PROTOCOL_VERSION,
      cluster: this.options.roster.clusterId, members: [...view.members.keys()].filter((member) => member !== view.self).length,
    });
  }

  private async onN(session: NSession, message: WireMessage): Promise<void> {
    const offer = session.offer;
    const channel = session.channel;
    if (!offer || offer.session !== session || channel.ended) return;
    // Review J1: nothing a session sends is taken once the offer's time is up (a code typed late costs no try).
    if ((message.t === "join.code" || message.t === "join.welcome") && joinOfferExpired(offer, this.now())) { this.burn(offer, "expired"); return; }
    switch (message.t) {
      case "join.hello": {
        if (session.sponsor) { channel.finish(); return; }
        const sign = fromBase64Url(message.sign);
        const proof = fromBase64Url(message.proof);
        const info = channel.info!;
        const ok = !!sign && !!proof && await verifyPairProof(sign, info.peer.memberId, info.transcriptHash, proof);
        if (!ok) { this.log(`server pairing: offer ${offer.id}: join.hello's proof does not verify`); channel.send({ t: "join.declined", reason: "unsupported" }); channel.finish(); return; }
        if (message.cluster === null) { channel.send({ t: "join.declined", reason: "cluster" }); channel.finish(); return; }
        if (session.timer) { clearTimeout(session.timer); session.timer = null; }
        session.sponsor = { member: info.peer.memberId, name: message.name.trim().slice(0, 100) || "Server", sign: message.sign, dh: toBase64Url(info.peer.dhPub) };
        this.log(`server pairing: offer ${offer.id}: server ${info.peer.memberId} opened the pairing`);
        this.emit({ kind: "join.hello", offer: offer.id, server: info.peer.memberId, name: session.sponsor.name, fingerprint: memberFingerprint(info.peer.memberId) });
        return;
      }
      case "join.code": {
        if (!session.sponsor || session.checked) { channel.finish(); return; }
        if (!sameCode(message.code, offer.code)) {
          offer.left--;
          this.log(`server pairing: offer ${offer.id}: a wrong code (${offer.left} left)`);
          if (offer.left <= 0) { this.emit({ kind: "join.wrong", offer: offer.id, left: 0 }); this.burn(offer, "code"); return; }
          channel.send({ t: "join.wrong", left: offer.left });
          this.emit({ kind: "join.wrong", offer: offer.id, left: offer.left });
          return;
        }
        session.checked = true;
        this.log(`server pairing: offer ${offer.id}: the code was typed right`);
        channel.send({ t: "join.checked" });
        return;
      }
      case "join.welcome": {
        if (!session.checked || session.joining || !session.sponsor) { channel.finish(); return; }
        session.joining = true;
        await this.takeWelcome(session, offer, message);
        return;
      }
      case "join.declined": this.burn(offer, message.reason === "code" ? "code" : message.reason === "member" ? "member" : "cancelled"); return;
      case "ping": return;
      case "bye": channel.finish(); return;
      default: this.log(`server pairing: ${message.t} is not part of a join`); channel.finish();
    }
  }

  private async takeWelcome(session: NSession, offer: Offer, welcome: WireMessageOf<"join.welcome">): Promise<void> {
    const channel = session.channel;
    const sponsor = session.sponsor!;
    const ownAddresses = this.options.ownAddresses();
    const hadVapid = readVapidKeys(this.options.dataDir) !== null;
    let joined: { clusterId: string; addId: string; add: SignedStatement };
    try {
      writeVapidKeys(this.options.dataDir, welcome.vapid);
      joined = await this.options.roster.joinCluster({
        add: welcome.add, roster: welcome.roster, sponsor: { member: sponsor.member, keys: { sign: sponsor.sign, dh: sponsor.dh }, name: sponsor.name },
        extra: (cluster) => (ownAddresses ? [{ type: "profile", cluster, member: this.options.identity.memberId, field: "addresses", value: ownAddresses, hlc: { ms: this.now(), c: 0 } }] : []),
      });
    } catch (error) {
      if (!hadVapid) rmSync(vapidFilePath(this.options.dataDir), { force: true });
      const text = String((error as Error)?.message ?? error);
      this.log(`server pairing: offer ${offer.id}: the welcome was refused (${text})`);
      channel.send({ t: "join.declined", reason: "unsupported" });
      this.burn(offer, "cancelled");
      return;
    }
    offer.state = "used";
    this.retire(offer);
    if (welcome.prefs.length && this.options.prefs) {
      try { await this.options.prefs.merge(welcome.prefs); } catch (error) { this.log(`server pairing: the welcome's preferences were not kept (${String((error as Error)?.message ?? error)}); gossip brings them`); }
    }
    this.log(`server pairing: joined cluster ${joined.clusterId} through server ${sponsor.member} (Add ${joined.addId})`);
    channel.send({ t: "join.done", add: joined.add });
    channel.finish();
    this.emit({ kind: "join.done", offer: offer.id, server: sponsor.member, cluster: joined.clusterId });
  }

  private nClosed(session: NSession): void {
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    const offer = session.offer;
    if (!offer || offer.session !== session || offer.state !== "busy" || session.joining) return;
    // Cut before the join finished: the offer goes back while it lasts (wrong tries stay counted).
    offer.session = null;
    offer.state = "open";
    if (joinOfferExpired(offer, this.now())) { this.burn(offer, "expired"); return; }
    this.log(`server pairing: offer ${offer.id}: the session ended before the join finished; the offer is open again`);
  }

  private burn(offer: Offer, reason: "code" | "expired" | "cancelled" | "member"): void {
    if (this.offers.get(offer.id) !== offer) return;
    const session = offer.session;
    this.retire(offer);
    if (session && !session.channel.ended) {
      session.offer = null;
      session.channel.send({ t: "join.declined", reason: reason === "cancelled" ? "cancelled" : reason });
      session.channel.finish();
    }
    this.log(`server pairing: join offer ${offer.id} ${reason === "code" ? "declined (three wrong codes)" : reason}`);
    this.emit({ kind: "join.declined", offer: offer.id, reason });
  }

  private retire(offer: Offer): void {
    if (offer.timer) clearTimeout(offer.timer);
    offer.timer = null;
    offer.secret.fill(0);
    offer.code = "";
    this.offers.delete(offer.id);
  }

  // ---------------------------------------------------------------------------------------------
  // S

  /** Opens the pairing session with the server the link names; resolves once both said who they are. */
  async addMachine(linkText: string, owner?: object): Promise<MachineAddResult> {
    if (owner && this.closedOwners.has(owner)) throw new JoinError("declined", "the admin session closed");
    const offer = parseJoinLink(linkText);
    if (!offer) throw new JoinError("bad-link", "that is not a join link (botlingd join prints one)");
    if (joinOfferExpired(offer, this.now())) throw new JoinError("expired", "the join link expired; run botlingd join on the other machine again");
    const roster = this.options.roster;
    if (roster.clusterId === null) throw new JoinError("no-cluster", "this server has no cluster yet: create it first (the recovery code is shown once and typed back)");
    if (!roster.isValid(roster.memberId)) throw new JoinError("state", "this server was removed from its cluster");
    if (offer.server === roster.memberId) throw new JoinError("bad-link", "that link is this server's own");
    const sign = fromBase64Url(offer.keys.sign);
    const dh = fromBase64Url(offer.keys.dh);
    if (!sign || !dh || (await memberIdFromKey(sign)) !== offer.server) throw new JoinError("bad-link", "the link's keys do not belong to the server it names");
    const url = offer.addresses.find((address) => LOOPBACK_WS.test(address));
    if (!url) throw new JoinError("no-address", "the link names no loopback address (ws://127.0.0.1:<port>/v3/ws); other paths come with M4");
    const known = this.attempts.get(offer.offer);
    if (known) this.dropAttempt(known, "a new attempt with the same link");
    let connection: PeerConnection;
    let aborted = false;
    const offConnect = this.trackOwnerAbort(owner, () => { aborted = true; });
    try { connection = await this.connector.connect(url); } catch (error) {
      offConnect();
      throw new JoinError("unreachable", `cannot reach that server: ${String((error as Error)?.message ?? error)}`);
    }
    offConnect();
    if (aborted || (owner && this.closedOwners.has(owner)) || this.closed) {
      connection.close();
      throw new JoinError("declined", "the admin session closed");
    }
    const secret = fromBase64Url(offer.secret)!;
    const attempt: Attempt = { id: offer.offer, offer, url, channel: null!, peer: null, busy: false, welcoming: false, owner: owner ?? null, ownerClosed: false, timer: null };
    attempt.channel = new JoinChannel(connection, {
      dial: { mode: "pair", transport: "tailnet", cluster: JOIN_CLUSTER, self: this.self, responder: { memberId: offer.server, dhPub: dh }, pair: { offer: offer.offer, secret } },
    }, null, () => { if (this.attempts.get(attempt.id) === attempt && !attempt.busy) this.dropAttempt(attempt, "the session ended"); }, this.log);
    connection.bind({ frame: (frame) => attempt.channel.link.receive(frame), closed: () => attempt.channel.link.transportClosed() });
    const offHandshake = this.trackOwnerAbort(owner, () => { attempt.ownerClosed = true; attempt.channel.close(); });
    let info: SessionInfo;
    try { info = await attempt.channel.link.established; } catch (error) {
      offHandshake();
      attempt.channel.close();
      throw new JoinError("unreachable", `the pairing handshake failed (${String((error as { detail?: string; message?: string })?.detail ?? (error as Error)?.message ?? error)}); the link may be used, expired or cancelled`);
    }
    offHandshake();
    if (attempt.ownerClosed || (owner && this.closedOwners.has(owner)) || this.closed) {
      attempt.channel.close();
      throw new JoinError("declined", "the admin session closed");
    }
    this.attempts.set(attempt.id, attempt);
    attempt.timer = setTimeout(() => this.dropAttempt(attempt, "the offer expired"), Math.max(0, offer.expiresAt - this.now()) + 5);
    attempt.timer.unref?.();
    const proof = await signPairProof(this.options.identity.signKey, info.transcriptHash);
    attempt.channel.send({
      t: "join.hello", name: this.options.serverName.slice(0, 100) || "Botling", sign: this.options.identity.keys.sign, proof: toBase64Url(proof),
      version: this.options.version, protocol: PROTOCOL_VERSION, cluster: roster.clusterId, members: [...roster.view.members.keys()].filter((member) => member !== roster.memberId).length,
    });
    const hello = await this.expect(attempt, this.options.helloTimeoutMs ?? JOIN_HELLO_TIMEOUT_MS);
    if (!hello || hello.t !== "join.hello") {
      this.dropAttempt(attempt, "no join.hello");
      if (hello?.t === "join.declined") throw new JoinError(hello.reason === "member" ? "member" : "declined", `the other server declined: ${hello.reason}`);
      throw new JoinError("bad-peer", "the other server did not say who it is");
    }
    const peerSign = fromBase64Url(hello.sign);
    const peerProof = fromBase64Url(hello.proof);
    if (hello.sign !== offer.keys.sign || !peerSign || !peerProof || !(await verifyPairProof(peerSign, offer.server, info.transcriptHash, peerProof))) {
      attempt.channel.send({ t: "join.declined", reason: "unsupported" });
      this.dropAttempt(attempt, "the join.hello proof does not verify");
      throw new JoinError("bad-peer", "the other server's proof of its key does not verify");
    }
    if (hello.cluster !== null || hello.members > 0) {
      attempt.channel.send({ t: "join.declined", reason: "member" });
      this.dropAttempt(attempt, "the other server already has members");
      throw new JoinError("member", "that server already belongs to a cluster; a server joins only while it has no other members");
    }
    attempt.peer = { member: offer.server, name: hello.name.trim().slice(0, 100) || offer.name };
    this.log(`server pairing: attempt ${attempt.id}: server ${offer.server} answered; waiting for its code`);
    return {
      attempt: attempt.id, server: offer.server, name: attempt.peer.name, fingerprint: memberFingerprint(offer.server),
      self: { server: roster.memberId, fingerprint: memberFingerprint(roster.memberId) }, expiresAt: offer.expiresAt,
    };
  }

  /** The code typed off the other server's screen. */
  async code(attemptId: string, typed: string): Promise<MachineCodeResult> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || !attempt.peer) return { ok: false, reason: "expired", detail: "no pairing in progress for that link; run botlingd add-machine again" };
    if (attempt.busy) return { ok: false, reason: "busy" };
    const code = JoinCode.safeParse(typed);
    if (!code.success) return { ok: false, reason: "malformed" };
    attempt.busy = true;
    try {
      attempt.channel.send({ t: "join.code", code: code.data });
      const answer = await this.expect(attempt, this.options.replyTimeoutMs ?? JOIN_REPLY_TIMEOUT_MS);
      if (attempt.ownerClosed) { this.cancelAttempt(attempt.id); return { ok: false, reason: "cancelled" }; }
      if (!answer) { this.dropAttempt(attempt, "no answer to the code"); return { ok: false, reason: "lost" }; }
      if (answer.t === "join.wrong") return { ok: false, reason: "wrong", left: answer.left };
      if (answer.t === "join.declined") { this.dropAttempt(attempt, `declined (${answer.reason})`); return { ok: false, reason: answer.reason }; }
      if (answer.t !== "join.checked") { this.dropAttempt(attempt, `${answer.t} instead of an answer to the code`); return { ok: false, reason: "refused" }; }
      attempt.welcoming = true;
      return await this.welcome(attempt);
    } finally {
      attempt.busy = false;
    }
  }

  private async welcome(attempt: Attempt): Promise<MachineCodeResult> {
    const roster = this.options.roster;
    const offer = attempt.offer;
    const peer = attempt.peer!;
    let added: { member: string; addId: string; created: boolean };
    let vapid;
    try {
      added = await roster.addServer({ keys: offer.keys, name: peer.name });
      const own = this.options.ownAddresses();
      if (own) await roster.writeProfile(roster.memberId, "addresses", own);
      const peerAddress = addressesForUrl(attempt.url);
      if (peerAddress) await roster.writeProfile(peer.member, "addresses", peerAddress);
      const made = await ensureVapidKeys(this.options.dataDir);
      vapid = made.keys;
      if (made.created) this.log("server pairing: the cluster's Web Push key pair was made (first server pairing)");
    } catch (error) {
      const text = String((error as Error)?.message ?? error);
      this.log(`server pairing: attempt ${attempt.id}: the Add was refused (${text})`);
      attempt.channel.send({ t: "join.declined", reason: "cancelled" });
      this.dropAttempt(attempt, "the Add was refused");
      return { ok: false, reason: "refused", detail: text };
    }
    this.log(`server pairing: attempt ${attempt.id}: server ${peer.member} added (${added.addId}); sending the welcome`);
    const statements = roster.statements();
    if (statements.length > JOIN_ROSTER_LIMIT) {
      attempt.channel.send({ t: "join.declined", reason: "unsupported" });
      this.dropAttempt(attempt, "too many statements for one welcome");
      return { ok: false, reason: "refused", detail: `the roster holds more than ${JOIN_ROSTER_LIMIT} statements (gossip carries the rest from M3 step 5)` };
    }
    const add = statements.find((item) => item.id === added.addId)!.statement;
    attempt.channel.send({ t: "join.welcome", add, roster: statements.map((item) => item.statement), vapid, prefs: (this.options.prefs?.rows() ?? []).slice(0, 500) });
    const done = await this.expect(attempt, this.options.replyTimeoutMs ?? JOIN_REPLY_TIMEOUT_MS);
    if (!done || done.t !== "join.done") {
      this.dropAttempt(attempt, done ? `${done.t} instead of join.done` : "no join.done");
      return { ok: false, reason: done?.t === "join.declined" ? done.reason : "lost", detail: "the other server did not confirm; this server's Add stays, so the same link can be tried again while it lasts" };
    }
    const body = done.add.body;
    const self = this.options.identity;
    if (body.type !== "add" || body.kind !== "server" || body.member !== self.memberId || body.by !== peer.member || body.joined !== false || body.keys.sign !== self.keys.sign || body.keys.dh !== self.keys.dh || body.cluster !== roster.clusterId) {
      this.dropAttempt(attempt, "join.done carries another Add");
      return { ok: false, reason: "refused", detail: "the other server's Add does not name this server" };
    }
    await roster.merge([done.add]);
    this.log(`server pairing: server ${peer.member} joined the cluster (its Add of this server stored)`);
    attempt.channel.finish();
    this.dropAttempt(attempt, null);
    return { ok: true, server: peer.member, name: peer.name, addId: added.addId, created: added.created, cluster: roster.clusterId! };
  }

  cancelAttempt(attemptId: string): { ok: boolean } {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return { ok: false };
    attempt.channel.send({ t: "join.declined", reason: "cancelled" });
    this.dropAttempt(attempt, "cancelled");
    return { ok: true };
  }

  /** The next join message on the attempt; `ping`s are skipped. */
  private async expect(attempt: Attempt, timeoutMs: number): Promise<WireMessage | null> {
    const until = this.now() + timeoutMs;
    for (;;) {
      const message = await attempt.channel.next(Math.max(1, until - this.now()));
      if (!message || message.t !== "ping") return message;
    }
  }

  private dropAttempt(attempt: Attempt, why: string | null): void {
    if (this.attempts.get(attempt.id) === attempt) this.attempts.delete(attempt.id);
    if (attempt.timer) { clearTimeout(attempt.timer); attempt.timer = null; }
    if (why) this.log(`server pairing: attempt ${attempt.id} ended (${why})`);
    attempt.channel.finish();
  }

  private emit(event: AdminEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { this.log(`server pairing: an event listener failed: ${String((error as Error)?.message ?? error)}`); }
    }
  }
}

/** Two join codes, read forgivingly, compared in constant time. */
function sameCode(typed: string, expected: string): boolean {
  const a = JoinCode.safeParse(typed);
  if (!a.success || !expected || a.data.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= a.data.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
