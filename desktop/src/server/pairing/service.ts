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
  DeviceScope, memberFingerprint, pairLink, PAIR_OFFER_TTL_MS, PAIR_PENDING_LIMIT, PairOffer, toBase64Url,
  type AdminEvent, type AdminOp, type Message, type SignedStatement,
} from "../../protocol";
import type { PeerClaim, PeerDecision, SessionInfo } from "../../session";
import { RosterError } from "../roster/store";
import type { RosterView } from "../roster/validity";
import { PairingError, type DeviceRow, type DroppedListResult, type DroppedListRow, type MachineRemovePreview, type Offer, type OfferState, type PairChannel, type PairLink, type PairingOptions, type PairOfferResult, type RecoveryStatusResult, type RerootPreview, type RerootResult } from "./service-types";
import { PairingRecovery } from "./service-recovery";

/** How long an established pairing session may take to send `pair.hello`. */
export const PAIR_HELLO_TIMEOUT_MS = 15_000;

// Moved to service-types.ts (M7-S22); every name stays exported from here.
export type { PairAddresses, PairingOptions, PairLink, PairChannel, PairOfferResult, DeviceRow, MachineRemovePreview, DroppedListRow, DroppedListResult, RecoveryStatusResult, RerootKeepCandidate, RerootPreview, RerootAddedMember, RerootResult } from "./service-types";
export { PairingError } from "./service-types";
// Moved to service-recovery.ts (M7-S92); stays exported from here.
export { PAIR_ACK_TIMEOUT_MS } from "./service-recovery";

export class PairSession implements PairChannel {
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
  private readonly recovery: PairingRecovery;
  private get offers(): Map<string, Offer> { return this.recovery.offers; }
  private get used(): Map<string, number> { return this.recovery.used; }
  private get closedAll(): boolean { return this.recovery.closedAll; }
  private readonly listeners = new Set<(event: AdminEvent) => void>();
  private readonly now: () => number;
  private readonly offerListeners = new Set<() => void>();
  private recoveryReplaceOwner: object | null = null;
  private readonly closedAdminSessions = new WeakSet<object>();

  constructor(private readonly options: PairingOptions) {
    this.now = options.now ?? Date.now;
    this.recovery = new PairingRecovery({
      options, now: () => this.now(), listeners: this.listeners, offersChanged: () => this.offersChanged(),
      setRecoveryReplaceOwner: (owner) => { this.recoveryReplaceOwner = owner; },
    });
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

  // ---------------------------------------------------------------------------------------------
  // Moved to service-recovery.ts (M7-S92): the reroot / recovery half and the offer and pairing-session lifecycle.

  rerootPreview(): RerootPreview { return this.recovery.rerootPreview(); }
  reroot(code: string, oldRootLost: boolean, keep: string[]): Promise<RerootResult> { return this.recovery.reroot(code, oldRootLost, keep); }
  confirmRecoveryReplace(newCode: string) { return this.recovery.confirmRecoveryReplace(newCode); }
  onPairMessage(session: PairSession, message: Message): void { this.recovery.onPairMessage(session, message); }
  sessionClosed(session: PairSession): void { this.recovery.sessionClosed(session); }
  dropSession(session: PairSession, why: string): void { this.recovery.dropSession(session, why); }
  pending(): Array<{ offer: string; state: OfferState["kind"]; expiresAt: number }> { return this.recovery.pending(); }
  close(): void { this.recovery.close(); }
  private serverDisplayName(id: string, view: RosterView): string { return this.recovery.serverDisplayName(id, view); }
  private armAck(offer: Offer, session: PairSession): void { this.recovery.armAck(offer, session); }
  private giveBack(offer: Offer, event: "ack lost" | null): void { this.recovery.giveBack(offer, event); }
  private burn(offer: Offer, reason: "code" | "expired" | "cancelled"): void { this.recovery.burn(offer, reason); }
  private expire(offer: Offer): void { this.recovery.expire(offer); }
  private expired(offer: Offer): boolean { return this.recovery.expired(offer); }
  private prune(): void { this.recovery.prune(); }
  private trustSet(addId: string): SignedStatement[] { return this.recovery.trustSet(addId); }
  private emit(event: AdminEvent): void { this.recovery.emit(event); }
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
