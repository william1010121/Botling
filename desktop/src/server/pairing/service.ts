// Device pairing on one server (protocol v1 §4.4, M2 step 5): offers, the `pair` handshake's server side, the 6-digit
// code the user compares, the `Add`, and the device's ack (the 2.x held-offer rule).
//
//   offer       `createOffer` makes a one-time 32-byte secret P (5 min, at most 5 pending). The link carries it in the
//               URL fragment; the server keeps it in memory only (never in server.db, a file or the log).
//   handshake   the device dials in `pair` mode with the offer id and P mixed into the key schedule (src/session).
//               `offerSecret` and `checkClaim` only read: the claim they see is not proven yet (a replayed HS1 reaches
//               them too), so they consume nothing.
//   claim       only when the handshake is established (P proven) does a session claim the offer; one session holds an
//               offer at a time, a second one is told `pair.declined{busy}`.
//   hello       the device's `pair.hello` names it and proves its signing key (`verifyPairProof` over the transcript,
//               the member id the handshake named must be that key's).
//   code        the server shows the transcript's 6-digit code (`admin.event pair.code`); the user compares it with the
//               device's and confirms (`confirm(offer, true)`) or declines. A decline (here or on the device) burns the
//               offer: two different codes mean someone else is in the middle.
//   Add         on accept the server commits `Add{device, by: this server, scope}` and sends `pair.added`; the offer is
//               *held* until the device's `pair.ack`. Only then is it used up. A lost ack (the session ends first, or no
//               ack within `ackTimeoutMs`) gives the offer back: the device dials again with the same link and the same
//               keys, compares a new code, and gets the same (already committed) Add.
//
// The cluster is made at the first pairing (§4.8): no offer is made before it exists, so `botlingd pair` (and the desktop
// window) first runs `cluster.create`: the cluster is made at once and its recovery code is shown once (nothing is typed
// back; `cluster.confirm` remains for the older two-step setup). Admin
// requests come only from the local socket (the role table keeps `admin` off every other session) or the CLI over it.
import {
  addJoins, DeviceScope, fromBase64Url, memberFingerprint, pairLink, PAIR_OFFER_TTL_MS, PAIR_PENDING_LIMIT, PairOffer, toBase64Url,
  type AdminEvent, type AdminOp, type Message, type MessageOf, type SignedStatement,
} from "../../protocol";
import { verifyPairProof, type PeerClaim, type PeerDecision, type SessionInfo } from "../../session";
import type { ClusterSetup } from "../identity/cluster";
import { RosterError, type RosterStore } from "../roster/store";
import type { RosterView } from "../roster/validity";

/** How long an established pairing session may take to send `pair.hello`. */
export const PAIR_HELLO_TIMEOUT_MS = 15_000;
/** How long the server waits for the device's `pair.ack` after `pair.added` before it gives the offer back. */
export const PAIR_ACK_TIMEOUT_MS = 30_000;
/** Used offer ids remembered (to answer "used" rather than "unknown"); they expire with the offer anyway. */
const USED_MEMORY = 64;

export interface PairAddresses { tailnet?: string; relay?: { url: string; room: string } }

export interface PairingOptions {
  roster: RosterStore;
  cluster: ClusterSetup;
  /** This server's public keys (the offer names them). */
  identity: { readonly memberId: string; readonly keys: { readonly sign: string; readonly dh: string } };
  /** How the offer names this server. */
  serverName: string;
  /** Where devices reach this server (the offer must name at least one); read at each offer. */
  addresses: () => PairAddresses;
  /** The page the link opens (`<tailnet origin>/v3/`). */
  pageUrl: () => string;
  /** A note for the person pairing when the address is only a placeholder (no tailnet origin set yet), else null. */
  addressNote?: () => string | null;
  now?: () => number;
  log?: (line: string) => void;
  helloTimeoutMs?: number;
  ackTimeoutMs?: number;
}

/** What a pairing session gives the service: send a pairing message, end the session. */
export interface PairLink {
  send(message: Message): boolean;
  end(): void;
}

/** One established pairing session, as the service drives it. */
export interface PairChannel {
  onMessage(message: Message): void;
  closed(): void;
}

export type PairOfferResult = { offer: string; link: string; expiresAt: number; clusterId: string; note?: string };
export interface DeviceRow { id: string; name: string; scope: string[]; valid: boolean; revoked: boolean; addedAt: number; addedBy: string }
export type MachineRemovePreview =
  | { isRoot: false; rootMember: string; rootName: string }
  | {
      isRoot: true;
      member: string;
      name: string;
      fingerprint: string;
      cascade: Array<{ member: string; kind: "server" | "device"; name: string }>;
    };
export interface DroppedListRow {
  revokeId: string;
  member: string;
  memberName: string;
  memberFingerprint: string;
  signer: string;
  signerName: string;
  gen: number;
  receivedAt: number | null;
  why: "left-out" | "arrived-after";
}
export interface DroppedListResult {
  isRoot: boolean;
  rootMember: string | null;
  rootName: string | null;
  rows: DroppedListRow[];
}
export interface RecoveryStatusResult {
  hasCluster: boolean;
  isRoot: boolean;
  rootMember: string | null;
  rootName: string | null;
  serverName: string;
}

export interface RerootKeepCandidate {
  revokeId: string;
  member: string;
  memberName: string;
  signer: string;
  signerName: string;
  gen: number;
  receivedAt: number | null;
}
export type RerootPreview =
  | { isRoot: true; selfMember: string; selfName: string }
  | {
      isRoot: false;
      selfMember: string;
      selfName: string;
      oldRootMember: string;
      oldRootName: string;
      keepCandidates: RerootKeepCandidate[];
    };
export interface RerootAddedMember {
  member: string;
  kind: "server" | "device";
  name: string;
  at: number;
}
export type RerootResult =
  | {
      ok: true;
      rootId: string;
      revokeId: string | null;
      gen: number;
      oldRootAdded: RerootAddedMember[];
    }
  | { ok: false; reason: "bad-code" };

export class PairingError extends Error {
  constructor(
    readonly code: "no-cluster" | "limit" | "unknown" | "state" | "no-address" | "not-a-device" | "bad-request" | "not-root" | "cannot-revoke-root" | "not-a-server" | "ambiguous" | "bad-code" | "already-root" | "bad-keep" | "self-revoked",
    message: string,
  ) {
    super(message);
    this.name = "PairingError";
  }
}

type OfferState =
  | { kind: "open" }
  | { kind: "hello"; session: PairSession }
  | { kind: "comparing"; session: PairSession }
  | { kind: "adding"; session: PairSession }
  | { kind: "held"; session: PairSession; addId: string };

interface Offer {
  id: string;
  secret: Uint8Array;
  expiresAt: number;
  scope: DeviceScope[] | undefined;
  /** A name the user gave the device at `pair.offer` (else the device's own). */
  name: string | undefined;
  state: OfferState;
  timer: ReturnType<typeof setTimeout> | null;
}

class PairSession implements PairChannel {
  offer: Offer | null = null;
  device: { member: string; name: string; sign: string; dh: string } | null = null;
  ended = false;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly service: PairingService, readonly info: SessionInfo, readonly link: PairLink) {}

  startHelloTimer(ms: number): void {
    this.helloTimer = setTimeout(() => { if (!this.device) this.service.dropSession(this, "no pair.hello in time"); }, ms);
    this.helloTimer.unref?.();
  }

  stopTimers(): void { if (this.helloTimer) clearTimeout(this.helloTimer); this.helloTimer = null; }

  onMessage(message: Message): void { this.service.onPairMessage(this, message); }

  closed(): void {
    if (this.ended) return;
    this.ended = true;
    this.stopTimers();
    this.service.sessionClosed(this);
  }
}

export class PairingService {
  private readonly offers = new Map<string, Offer>();
  private readonly used = new Map<string, number>();
  private readonly listeners = new Set<(event: AdminEvent) => void>();
  private readonly now: () => number;
  private closedAll = false;
  private readonly offerListeners = new Set<() => void>();
  private recoveryReplaceOwner: object | null = null;
  private readonly closedAdminSessions = new WeakSet<object>();

  constructor(private readonly options: PairingOptions) {
    this.now = options.now ?? Date.now;
  }

  // ---------------------------------------------------------------------------------------------
  // The handshake's questions (read only: the claim is not proven when they run)

  /** The pending offer's secret, or null when it is unknown, expired or used up. */
  offerSecret(offerId: string): Uint8Array | null {
    const offer = this.offers.get(offerId);
    if (!offer || this.expired(offer)) return null;
    return offer.secret;
  }

  /**
   * The pending offers' ids, secrets and expiry (M2 step 13): botlingd's relay connector derives each offer's join token
   * from them (src/session/relay-wire.ts) so a device holding the link can reach the room. Memory only, like the offers.
   */
  relayOffers(): Array<{ offer: string; secret: Uint8Array; expiresAt: number }> {
    return [...this.offers.values()].filter((offer) => !this.expired(offer)).map((offer) => ({ offer: offer.id, secret: offer.secret, expiresAt: offer.expiresAt }));
  }

  /** Told whenever an offer is made or retired. */
  onOffersChanged(listener: () => void): () => void {
    this.offerListeners.add(listener);
    return () => this.offerListeners.delete(listener);
  }

  private offersChanged(): void {
    for (const listener of this.offerListeners) { try { listener(); } catch { /* a listener's problem */ } }
  }

  /** The roster side of a pairing claim: a cluster exists, and the key is not a revoked device's or a server's. */
  checkClaim(claim: PeerClaim): PeerDecision {
    if (claim.mode !== "pair") return { ok: false, detail: "not a pairing" };
    const view = this.options.roster.view;
    if (view.cluster === null) return { ok: false, detail: "no cluster yet" };
    if (view.revoked.has(claim.memberId)) return { ok: false, detail: "this device was revoked; pair again with a new key" };
    if (view.servers.has(claim.memberId)) return { ok: false, detail: "that key is a server's" };
    return { ok: true };
  }

  /** An established pairing session (both keys proven, P known to the device): it claims its offer now. */
  open(info: SessionInfo, link: PairLink): PairChannel {
    const session = new PairSession(this, info, link);
    if (this.closedAll) { queueMicrotask(() => link.end()); return session; }
    const offer = info.offer ? this.offers.get(info.offer) : undefined;
    if (!offer || this.expired(offer)) {
      link.send({ t: "pair.declined", reason: offer ? "expired" : this.used.has(info.offer ?? "") ? "used" : "expired" });
      link.end();
      return session;
    }
    if (offer.state.kind !== "open") {
      link.send({ t: "pair.declined", reason: "busy" });
      link.end();
      return session;
    }
    session.offer = offer;
    offer.state = { kind: "hello", session };
    session.startHelloTimer(this.options.helloTimeoutMs ?? PAIR_HELLO_TIMEOUT_MS);
    return session;
  }

  // ---------------------------------------------------------------------------------------------
  // Admin (local socket and CLI)

  onEvent(listener: (event: AdminEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** One `admin` request; the result is the `res` body. Throws PairingError (or RosterError) for a refusal. */
  async admin(op: AdminOp, session?: object): Promise<unknown> {
    switch (op.op) {
      case "cluster.status": {
        const waiting = this.options.cluster.waiting;
        return { clusterId: this.options.roster.clusterId, pending: waiting ? { expiresAt: waiting.expiresAt } : null, note: this.options.cluster.note() };
      }
      case "cluster.create": {
        const made = await this.options.cluster.create();
        this.options.log?.(`pairing: cluster ${made.clusterId} created (its recovery code was shown once, not stored)`);
        return made;
      }
      case "cluster.confirm": {
        const result = await this.options.cluster.confirm(op.code);
        this.options.log?.(result.ok ? `pairing: cluster ${result.clusterId} created (recovery code confirmed)` : `pairing: recovery code not confirmed (${result.reason})`);
        return result;
      }
      case "pair.offer": return this.createOffer({ name: op.name, scope: op.scope });
      case "pair.confirm": return this.confirm(op.offer, op.accept);
      case "pair.cancel": return this.cancel(op.offer);
      case "devices.list": return { devices: this.devices() };
      case "device.revoke": return this.revokeDevice(op.deviceId, op.reason);
      case "machine.removePreview": return this.removeMachinePreview(op.member);
      case "machine.remove": return this.removeMachine(op.member, op.cascade, op.reason);
      case "roster.dropped": return this.droppedList();
      case "roster.dismiss": return this.dismissDropped(op.revokeId);
      case "recovery.status": return this.recoveryStatus();
      case "recovery.replace": return this.beginRecoveryReplace(op.code, session);
      case "recovery.confirm": return this.confirmRecoveryReplace(op.code);
      case "recovery.cancel": this.recoveryReplaceOwner = null; this.options.roster.cancelRecoveryReplace(); return { ok: true };
      case "roster.rerootPreview": return this.rerootPreview();
      case "roster.reroot": return this.reroot(op.code, op.oldRootLost, op.keep);
      default: throw new PairingError("bad-request", `${op.op} is not a device pairing request`);
    }
  }

  /** A new offer and its link. Refused before the cluster exists and while 5 offers are pending. */
  createOffer(input: { name?: string; scope?: readonly DeviceScope[] } = {}): PairOfferResult {
    const clusterId = this.options.roster.clusterId;
    if (clusterId === null) throw new PairingError("no-cluster", "there is no cluster yet: create it first (its recovery code is shown once)");
    this.prune();
    if (this.offers.size >= PAIR_PENDING_LIMIT) throw new PairingError("limit", `at most ${PAIR_PENDING_LIMIT} pairing offers are pending; cancel one or wait for one to expire`);
    const addresses = this.options.addresses();
    if (!addresses.tailnet && !addresses.relay) throw new PairingError("no-address", "this server has no address a device could reach");
    const id = toBase64Url(randomBytes(16));
    const secret = randomBytes(32);
    const expiresAt = this.now() + PAIR_OFFER_TTL_MS;
    const scope = input.scope ? [...new Set(input.scope)].map((item) => DeviceScope.parse(item)) : undefined;
    const offer: PairOffer = PairOffer.parse({
      v: 1, offer: id, server: this.options.identity.memberId, name: this.options.serverName.slice(0, 100) || "Botling",
      keys: { sign: this.options.identity.keys.sign, dh: this.options.identity.keys.dh }, cluster: clusterId,
      secret: toBase64Url(secret), expiresAt, addresses,
    });
    const link = pairLink(this.options.pageUrl(), offer);
    const entry: Offer = { id, secret, expiresAt, scope, name: input.name?.trim() || undefined, state: { kind: "open" }, timer: null };
    entry.timer = setTimeout(() => this.expire(entry), Math.max(0, expiresAt - this.now()) + 5);
    entry.timer.unref?.();
    this.offers.set(id, entry);
    this.offersChanged();
    this.options.log?.(`pairing: offer ${id} made (until ${new Date(expiresAt).toISOString()})`);
    const note = this.options.addressNote?.() ?? null;
    return { offer: id, link, expiresAt, clusterId, ...(note ? { note } : {}) };
  }

  /** The user compared the codes. */
  async confirm(offerId: string, accept: boolean): Promise<{ ok: true; deviceId?: string; addId?: string } | { ok: false; reason: string }> {
    const offer = this.offers.get(offerId);
    if (!offer) return { ok: false, reason: this.used.has(offerId) ? "used" : "unknown" };
    if (offer.state.kind !== "comparing") return { ok: false, reason: `nothing to confirm (${offer.state.kind})` };
    const session = offer.state.session;
    if (this.expired(offer)) { this.burn(offer, "expired"); return { ok: false, reason: "expired" }; }
    if (!accept) { this.burn(offer, "code"); return { ok: true }; }
    const device = session.device!;
    offer.state = { kind: "adding", session };
    let added: { member: string; addId: string; created: boolean };
    try {
      added = await this.options.roster.addDevice({ keys: { sign: device.sign, dh: device.dh }, name: offer.name ?? device.name, scope: offer.scope });
    } catch (error) {
      const reason = error instanceof RosterError ? error.reason : "add failed";
      this.options.log?.(`pairing: offer ${offer.id}: the Add was refused (${reason})`);
      this.burn(offer, "cancelled");
      return { ok: false, reason };
    }
    // The session may have ended while the Add was written: the Add stays (committed), the offer goes back.
    if (session.ended || offer.state.kind !== "adding" || offer.state.session !== session) {
      if (this.offers.get(offer.id) === offer && offer.state.kind === "adding") this.giveBack(offer, "ack lost");
      return { ok: true, deviceId: added.member, addId: added.addId };
    }
    const stored = this.options.roster.statements();
    const add = stored.find((item) => item.id === added.addId)?.statement;
    if (!add) { this.burn(offer, "cancelled"); return { ok: false, reason: "the Add is missing" }; }
    offer.state = { kind: "held", session, addId: added.addId };
    session.link.send({ t: "pair.added", add, roster: this.trustSet(added.addId) });
    this.armAck(offer, session);
    this.options.log?.(`pairing: offer ${offer.id}: device ${added.member} added (${added.addId}), waiting for its ack`);
    return { ok: true, deviceId: added.member, addId: added.addId };
  }

  /** Cancels an offer (a session on it is told `pair.declined{cancelled}`). */
  cancel(offerId: string): { ok: boolean } {
    const offer = this.offers.get(offerId);
    if (!offer) return { ok: false };
    this.burn(offer, "cancelled");
    return { ok: true };
  }

  /** The devices this roster names (valid or revoked). */
  devices(): DeviceRow[] {
    const view = this.options.roster.view;
    return [...view.members.values()].filter((info) => info.kind === "device").sort((a, b) => a.at - b.at || (a.member < b.member ? -1 : 1))
      .map((info) => ({
        id: info.member, name: info.name, scope: [...(info.scope ?? [])], valid: view.valid.has(info.member), revoked: view.revoked.has(info.member),
        addedAt: info.at, addedBy: info.by,
      }));
  }

  /** Revokes a device: its sessions end at once (the roster's change listener, remote-session.ts). */
  async revokeDevice(deviceId: string, reason = ""): Promise<{ revokeId: string; already: boolean }> {
    let result: { revokeId: string; already: boolean };
    try {
      result = await this.options.roster.revokeDevice(deviceId, reason);
    } catch (error) {
      if (error instanceof RosterError && (error.reason === "not-a-device" || error.reason === "server-revoke-root-only")) throw new PairingError("not-a-device", error.message);
      throw error;
    }
    this.options.log?.(`pairing: device ${deviceId} revoked${result.already ? " (already)" : ""}`);
    this.emit({ kind: "device.revoked", deviceId });
    return result;
  }

  /** Preview of removing a server (M4-05): checks root, resolves name/id/fingerprint, and names the cascade. */
  removeMachinePreview(target: string): MachineRemovePreview {
    const view = this.options.roster.view;
    const root = view.root;
    if (this.options.roster.clusterId === null || !root) {
      throw new PairingError("no-cluster", "there is no cluster yet");
    }
    if (root.root !== this.options.roster.memberId) {
      return { isRoot: false, rootMember: root.root, rootName: this.serverDisplayName(root.root, view) };
    }
    const query = target.trim();
    if (!query) throw new PairingError("not-a-server", "no machine name or id given");
    let resolved: string | null = null;
    if (view.servers.has(query)) {
      resolved = query;
    } else {
      const byName = [...view.servers].filter((id) => this.serverDisplayName(id, view) === query).sort();
      if (byName.length > 1) {
        const choices = byName.map((id) => `${id} (${memberFingerprint(id)})`).join(", ");
        throw new PairingError("ambiguous", `more than one machine is named "${query}" (${choices}); pass the id instead`);
      }
      if (byName.length === 1) {
        resolved = byName[0]!;
      } else {
        const fpKey = query.replace(/[\s-]/g, "").toLowerCase();
        if (/^[a-z2-7]{26}$/.test(fpKey) && view.servers.has(fpKey)) resolved = fpKey;
      }
    }
    if (!resolved) throw new PairingError("not-a-server", `no machine named "${query}" in this cluster`);
    if (resolved === root.root) throw new PairingError("cannot-revoke-root", "the revocation root cannot remove itself");
    const cascade = this.options.roster.cascadePreview(resolved).map((id) => {
      const info = view.members.get(id);
      const kind: "server" | "device" = view.servers.has(id) || info?.kind === "server" ? "server" : "device";
      const name = this.options.roster.profile(id, "name") ?? info?.name ?? id;
      return { member: id, kind, name };
    });
    return {
      isRoot: true,
      member: resolved,
      name: this.serverDisplayName(resolved, view),
      fingerprint: memberFingerprint(resolved),
      cascade,
    };
  }

  /** Revokes a server on the revocation root (§4.3, D61, M4-05). */
  async removeMachine(member: string, cascade: boolean, reason = ""): Promise<{ revokeId: string; already: boolean }> {
    const view = this.options.roster.view;
    const root = view.root;
    if (this.options.roster.clusterId === null || !root) {
      throw new PairingError("no-cluster", "there is no cluster yet");
    }
    if (root.root !== this.options.roster.memberId) {
      throw new PairingError("not-root", `Only the revocation root (${this.serverDisplayName(root.root, view)}) can remove a machine. Run this there.`);
    }
    try {
      const result = await this.options.roster.revokeServer(member, cascade, reason);
      this.options.log?.(`pairing: server ${member} removed (cascade=${cascade})${result.already ? " (already)" : ""}`);
      return result;
    } catch (error) {
      if (error instanceof RosterError) {
        if (error.reason === "server-revoke-root-only") {
          throw new PairingError("not-root", `Only the revocation root (${this.serverDisplayName(root.root, view)}) can remove a machine. Run this there.`);
        }
        if (error.reason === "cannot-revoke-root") throw new PairingError("cannot-revoke-root", error.message);
        if (error.reason === "not-a-server") throw new PairingError("not-a-server", error.message);
        if (error.reason === "no-cluster") throw new PairingError("no-cluster", error.message);
      }
      throw error;
    }
  }

  /** Dropped server revocations (D63, §4.8, M4-10), minus any dismissed locally on this server. */
  droppedList(): DroppedListResult {
    const view = this.options.roster.view;
    const root = view.root;
    if (this.options.roster.clusterId === null || !root) {
      return { isRoot: false, rootMember: null, rootName: null, rows: [] };
    }
    const rows: DroppedListRow[] = this.options.roster.dropped().map((row) => ({
      revokeId: row.revokeId,
      member: row.member,
      memberName: this.serverDisplayName(row.member, view),
      memberFingerprint: memberFingerprint(row.member),
      signer: row.signer,
      signerName: this.serverDisplayName(row.signer, view),
      gen: row.gen,
      receivedAt: row.receivedAt,
      why: row.why,
    }));
    return {
      isRoot: root.root === this.options.roster.memberId,
      rootMember: root.root,
      rootName: this.serverDisplayName(root.root, view),
      rows,
    };
  }

  /** Locally dismisses a dropped revocation on this server (writes local meta; signs nothing). */
  async dismissDropped(revokeId: string): Promise<{ already: boolean }> {
    try {
      const result = await this.options.roster.dismissDropped(revokeId);
      this.options.log?.(`pairing: dropped revocation ${revokeId} dismissed${result.already ? " (already)" : ""}`);
      return result;
    } catch (error) {
      if (error instanceof RosterError) {
        if (error.reason === "no-cluster") throw new PairingError("no-cluster", error.message);
        if (error.reason === "not-dropped") throw new PairingError("bad-request", error.message);
      }
      throw error;
    }
  }

  /** Whether this server can replace the recovery code (exists and is the current revocation root). */
  recoveryStatus(): RecoveryStatusResult {
    const view = this.options.roster.view;
    const root = view.root;
    const serverName = this.serverDisplayName(this.options.roster.memberId, view);
    if (this.options.roster.clusterId === null || !root) {
      return { hasCluster: false, isRoot: false, rootMember: null, rootName: null, serverName };
    }
    return {
      hasCluster: true,
      isRoot: root.root === this.options.roster.memberId,
      rootMember: root.root,
      rootName: this.serverDisplayName(root.root, view),
      serverName,
    };
  }

  /** Clears any pending recovery-code replacement started by a local admin session that disconnected. */
  adminClosed(session: object): void {
    this.closedAdminSessions.add(session);
    if (this.recoveryReplaceOwner === session) {
      this.recoveryReplaceOwner = null;
      this.options.roster.cancelRecoveryReplace();
    }
  }

  /** Starts replacing the recovery code on the current root; never logs either code. */
  async beginRecoveryReplace(oldCode: string, session?: object) {
    if (session && this.closedAdminSessions.has(session)) {
      throw new PairingError("state", "the admin session closed");
    }
    try {
      const started = await this.options.roster.replaceRecovery(oldCode);
      if (session && this.closedAdminSessions.has(session)) {
        this.options.roster.cancelRecoveryReplace();
        throw new PairingError("state", "the admin session closed");
      }
      this.recoveryReplaceOwner = session ?? null;
      this.options.log?.(`pairing: a new recovery code was shown for cluster ${started.clusterId} (not stored; waiting to be typed back)`);
      return started;
    } catch (error) {
      if (error instanceof RosterError) {
        if (error.reason === "no-cluster") throw new PairingError("no-cluster", error.message);
        if (error.reason === "self-revoked") throw new PairingError("self-revoked", error.message);
        if (error.reason === "not-root") {
          const view = this.options.roster.view;
          const rootId = view.root?.root;
          const rootLabel = rootId ? this.serverDisplayName(rootId, view) : "the revocation root";
          throw new PairingError("not-root", `Only the revocation root (${rootLabel}) can replace the recovery code. Run this there.`);
        }
        if (error.reason === "bad-code") throw new PairingError("bad-code", error.message);
      }
      throw error;
    }
  }

  /** Preview for `botlingd reroot` (§4.8, M4-11): names self, old root, and pending revocations to keep/untick. */
  rerootPreview(): RerootPreview {
    const view = this.options.roster.view;
    const root = view.root;
    if (this.options.roster.clusterId === null || !root) {
      throw new PairingError("no-cluster", "there is no cluster yet");
    }
    const selfMember = this.options.roster.memberId;
    const selfName = this.serverDisplayName(selfMember, view);
    if (root.root === selfMember) {
      return { isRoot: true, selfMember, selfName };
    }
    const keepCandidates: RerootKeepCandidate[] = this.options.roster.keepCandidates()
      .map((c) => ({
        revokeId: c.revokeId,
        member: c.member,
        memberName: this.serverDisplayName(c.member, view),
        signer: c.signer,
        signerName: this.serverDisplayName(c.signer, view),
        gen: c.gen,
        receivedAt: c.receivedAt,
      }))
      .sort((a, b) => (a.receivedAt ?? 0) - (b.receivedAt ?? 0) || (a.revokeId < b.revokeId ? -1 : a.revokeId > b.revokeId ? 1 : 0));
    return {
      isRoot: false,
      selfMember,
      selfName,
      oldRootMember: root.root,
      oldRootName: this.serverDisplayName(root.root, view),
      keepCandidates,
    };
  }

  /**
   * Reroots the cluster onto this server from the recovery code (§4.8, D48, D62, M4-11).
   * Never logs or returns the recovery code; returns `oldRootAdded` (newest first) when `oldRootLost` is true.
   */
  async reroot(code: string, oldRootLost: boolean, keep: string[]): Promise<RerootResult> {
    const oldRoot = this.options.roster.view.root?.root ?? null;
    try {
      const res = await this.options.roster.reroot({ code, oldRootLost, keep });
      this.options.log?.(`pairing: rerooted to this server (gen ${res.gen}, oldRootLost=${oldRootLost}, keep=${keep.length})`);
      const oldRootAdded = oldRootLost && oldRoot ? this.addedByOldRoot(oldRoot) : [];
      return { ok: true, rootId: res.rootId, revokeId: res.revokeId, gen: res.gen, oldRootAdded };
    } catch (error) {
      if (error instanceof RosterError) {
        if (error.reason === "bad-code") {
          this.options.log?.("pairing: reroot refused (bad-code)");
          return { ok: false, reason: "bad-code" };
        }
        if (error.reason === "no-cluster") throw new PairingError("no-cluster", error.message);
        if (error.reason === "already-root") throw new PairingError("already-root", error.message);
        if (error.reason === "bad-keep") throw new PairingError("bad-keep", error.message);
      }
      throw error;
    }
  }

  /** Confirms the new recovery code and commits the new Root statement; never logs any code. */
  async confirmRecoveryReplace(newCode: string) {
    try {
      const result = await this.options.roster.confirmRecovery(newCode);
      if (result.ok || (result.reason !== "malformed" && result.reason !== "wrong-code")) {
        this.recoveryReplaceOwner = null;
      }
      this.options.log?.(
        result.ok
          ? `pairing: recovery code replaced (Root gen ${result.gen})`
          : `pairing: new recovery code not confirmed (${result.reason})`,
      );
      return result;
    } catch (error) {
      if (error instanceof RosterError) {
        if (error.reason === "bad-keep") throw new PairingError("bad-keep", error.message);
        if (error.reason === "self-revoked") throw new PairingError("self-revoked", error.message);
      }
      throw error;
    }
  }

  /** Valid members staying in the cluster whose joining Add was signed by `oldRoot`, newest first (§4.8). */
  private addedByOldRoot(oldRoot: string): RerootAddedMember[] {
    const view = this.options.roster.view;
    const self = this.options.roster.memberId;
    const byMember = new Map<string, RerootAddedMember>();
    for (const { statement: { body } } of this.options.roster.statements()) {
      if (body.type !== "add" || body.by !== oldRoot || !addJoins(body)) continue;
      if (body.member === oldRoot || body.member === self || !view.valid.has(body.member)) continue;
      const info = view.members.get(body.member);
      const kind: "server" | "device" = view.servers.has(body.member) ? "server" : body.kind;
      const name = kind === "server" ? this.serverDisplayName(body.member, view) : (info?.name ?? body.name);
      const prev = byMember.get(body.member);
      if (!prev || body.at > prev.at) {
        byMember.set(body.member, { member: body.member, kind, name, at: body.at });
      }
    }
    return [...byMember.values()].sort((a, b) => b.at - a.at || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));
  }

  private serverDisplayName(id: string, view: RosterView): string {
    return this.options.roster.profile(id, "name")
      ?? view.members.get(id)?.name
      ?? (id === this.options.roster.memberId ? this.options.serverName : id);
  }

  /** Offers pending now (ids and states), for status and tests. */
  pending(): Array<{ offer: string; state: OfferState["kind"]; expiresAt: number }> {
    this.prune();
    return [...this.offers.values()].map((offer) => ({ offer: offer.id, state: offer.state.kind, expiresAt: offer.expiresAt }));
  }

  /** botlingd stops: every offer is forgotten, every pairing session ends. */
  close(): void {
    this.closedAll = true;
    this.recoveryReplaceOwner = null;
    this.options.roster.cancelRecoveryReplace();
    for (const offer of [...this.offers.values()]) this.burn(offer, "cancelled");
  }

  // ---------------------------------------------------------------------------------------------
  // Pairing sessions

  onPairMessage(session: PairSession, message: Message): void {
    if (session.ended) return;
    const offer = session.offer;
    if (!offer || this.offers.get(offer.id) !== offer || !("session" in offer.state) || offer.state.session !== session) { this.dropSession(session, "no offer"); return; }
    switch (message.t) {
      case "pair.hello": void this.hello(session, offer, message); return;
      case "pair.ack": this.ack(session, offer, message); return;
      case "pair.declined": this.burn(offer, message.reason === "code" ? "code" : "cancelled"); return;
      case "ping": return;
      case "bye": session.link.end(); return;
      default: this.dropSession(session, `${message.t} is not part of a pairing`);
    }
  }

  private async hello(session: PairSession, offer: Offer, hello: MessageOf<"pair.hello">): Promise<void> {
    if (offer.state.kind !== "hello" || session.device) { this.dropSession(session, "one pair.hello per session"); return; }
    const sign = fromBase64Url(hello.sign);
    const proof = fromBase64Url(hello.proof);
    const member = session.info.peer.memberId;
    const ok = !!sign && !!proof && await verifyPairProof(sign, member, session.info.transcriptHash, proof);
    if (session.ended || offer.state.kind !== "hello" || offer.state.session !== session) return;
    if (!ok) {
      // Not a proof of the key the handshake named: the offer goes back (the secret was proven, the key was not).
      this.options.log?.(`pairing: offer ${offer.id}: pair.hello's proof does not verify`);
      session.link.send({ t: "pair.declined", reason: "unsupported" });
      this.dropSession(session, "bad proof");
      return;
    }
    const view = this.options.roster.view;
    if (view.revoked.has(member) || view.servers.has(member)) { session.link.send({ t: "pair.declined", reason: "unsupported" }); this.dropSession(session, "a revoked or server key"); return; }
    session.stopTimers();
    session.device = { member, name: hello.name.trim().slice(0, 100) || "Device", sign: hello.sign, dh: toBase64Url(session.info.peer.dhPub) };
    offer.state = { kind: "comparing", session };
    this.emit({ kind: "pair.code", offer: offer.id, code: session.info.code, deviceId: member, deviceName: offer.name ?? session.device.name });
  }

  private ack(session: PairSession, offer: Offer, ack: MessageOf<"pair.ack">): void {
    if (offer.state.kind !== "held" || ack.addId !== offer.state.addId) { this.dropSession(session, "an ack for another Add"); return; }
    const addId = offer.state.addId;
    this.retire(offer);
    this.used.set(offer.id, offer.expiresAt);
    while (this.used.size > USED_MEMORY) this.used.delete(this.used.keys().next().value!);
    this.options.log?.(`pairing: offer ${offer.id} used: device ${session.device!.member} acknowledged`);
    this.emit({ kind: "pair.done", offer: offer.id, deviceId: session.device!.member, addId });
    session.link.end();
  }

  sessionClosed(session: PairSession): void {
    const offer = session.offer;
    if (!offer || this.offers.get(offer.id) !== offer || !("session" in offer.state) || offer.state.session !== session) return;
    // The ack never came (or the session ended before the Add): the offer goes back for a retry.
    this.giveBack(offer, offer.state.kind === "held" || offer.state.kind === "adding" ? "ack lost" : null);
  }

  dropSession(session: PairSession, why: string): void {
    if (session.ended) return;
    this.options.log?.(`pairing: session ended (${why})`);
    session.link.end();
    session.closed();
  }

  // ---------------------------------------------------------------------------------------------

  private armAck(offer: Offer, session: PairSession): void {
    const timer = setTimeout(() => {
      // Only while the offer is still pending: after the ack it was retired (used), and nothing is given back.
      if (this.offers.get(offer.id) === offer && offer.state.kind === "held" && offer.state.session === session) { this.giveBack(offer, "ack lost"); session.link.end(); }
    }, this.options.ackTimeoutMs ?? PAIR_ACK_TIMEOUT_MS);
    timer.unref?.();
  }

  /** The offer is free again (same secret, same expiry). */
  private giveBack(offer: Offer, event: "ack lost" | null): void {
    if ("session" in offer.state) { const session = offer.state.session; offer.state = { kind: "open" }; session.offer = null; }
    if (this.expired(offer)) { this.burn(offer, "expired"); return; }
    if (event) {
      this.options.log?.(`pairing: offer ${offer.id}: no ack; the offer is given back`);
      this.emit({ kind: "pair.declined", offer: offer.id, reason: event });
    }
  }

  /** The offer is gone (declined, cancelled, expired); a session on it is told why and ended. */
  private burn(offer: Offer, reason: "code" | "expired" | "cancelled"): void {
    if (this.offers.get(offer.id) !== offer) return;
    const session = "session" in offer.state ? offer.state.session : null;
    this.retire(offer);
    if (session && !session.ended) {
      session.offer = null;
      session.link.send({ t: "pair.declined", reason });
      session.link.end();
    }
    this.options.log?.(`pairing: offer ${offer.id} ${reason === "code" ? "declined (the codes differ)" : reason}`);
    this.emit({ kind: "pair.declined", offer: offer.id, reason });
  }

  private retire(offer: Offer): void {
    if (offer.timer) clearTimeout(offer.timer);
    offer.timer = null;
    this.offers.delete(offer.id);
    this.offersChanged();
    offer.secret.fill(0);
  }

  private expire(offer: Offer): void {
    if (this.offers.get(offer.id) !== offer) return;
    // A device that is past the code (its Add is being written or waits for its ack) finishes; the rest end now.
    if (offer.state.kind === "held" || offer.state.kind === "adding") {
      offer.timer = setTimeout(() => this.expire(offer), 1_000);
      offer.timer.unref?.();
      return;
    }
    this.burn(offer, "expired");
  }

  private expired(offer: Offer): boolean { return this.now() >= offer.expiresAt; }

  private prune(): void {
    for (const offer of [...this.offers.values()]) if (this.expired(offer) && offer.state.kind !== "held" && offer.state.kind !== "adding") this.burn(offer, "expired");
    const now = this.now();
    for (const [id, until] of this.used) if (until <= now) this.used.delete(id);
  }

  /** What a new device needs to trust this cluster: the Roots, the servers' statements, its own Add. */
  private trustSet(addId: string): SignedStatement[] {
    const view = this.options.roster.view;
    const out: SignedStatement[] = [];
    for (const { id, statement } of this.options.roster.statements()) {
      const body = statement.body;
      if (id === addId || body.type === "root" || ((body.type === "add" || body.type === "endorse" || body.type === "revoke") && view.servers.has(body.member))) out.push(statement);
      if (out.length >= 200) break;
    }
    return out;
  }

  private emit(event: AdminEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { this.options.log?.(`pairing: an event listener failed: ${String((error as Error)?.message ?? error)}`); }
    }
  }
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
