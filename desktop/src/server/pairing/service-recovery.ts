// The reroot / recovery half of `PairingService` and its offer and pairing-session lifecycle (M7-S92): moved out of
// service.ts unchanged. `PairingRecovery` owns `offers`, `used` and `closedAll`; `PairingService` (service.ts) keeps its
// public methods as one-line delegates and reaches the rest of the moved members through them. What the moved code
// borrows from `PairingService` (`options`, the clock, the admin listeners, `offersChanged`, the recovery-replace owner)
// comes through `PairingHost`, and the block of forwarders at the top of the class is that interface in one screen.
import {
  addJoins, fromBase64Url, toBase64Url,
  type AdminEvent, type Message, type MessageOf, type SignedStatement,
} from "../../protocol";
import { verifyPairProof } from "../../session";
import { RosterError } from "../roster/store";
import type { RosterView } from "../roster/validity";
import { PairingError, type Offer, type OfferState, type PairingOptions, type RerootAddedMember, type RerootKeepCandidate, type RerootPreview, type RerootResult } from "./service-types";
// A type-only import: erased at build time, so there is no runtime cycle with service.ts (service-types.ts does the same).
import type { PairSession } from "./service";

/** How long the server waits for the device's `pair.ack` after `pair.added` before it gives the offer back. */
export const PAIR_ACK_TIMEOUT_MS = 30_000;
/** Used offer ids remembered (to answer "used" rather than "unknown"); they expire with the offer anyway. */
const USED_MEMORY = 64;

/** What `PairingRecovery` borrows from the `PairingService` that made it. */
export interface PairingHost {
  readonly options: PairingOptions;
  now(): number;
  readonly listeners: ReadonlySet<(event: AdminEvent) => void>;
  offersChanged(): void;
  setRecoveryReplaceOwner(owner: object | null): void;
}

export class PairingRecovery {
  readonly offers = new Map<string, Offer>();
  readonly used = new Map<string, number>();
  closedAll = false;

  constructor(private readonly host: PairingHost) {}

  // Bridge block: the names the moved code uses on `this` that the service owns.
  private get options(): PairingOptions { return this.host.options; }
  private get listeners(): ReadonlySet<(event: AdminEvent) => void> { return this.host.listeners; }
  private now(): number { return this.host.now(); }
  private offersChanged(): void { this.host.offersChanged(); }
  private set recoveryReplaceOwner(owner: object | null) { this.host.setRecoveryReplaceOwner(owner); }

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

  serverDisplayName(id: string, view: RosterView): string {
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

  armAck(offer: Offer, session: PairSession): void {
    const timer = setTimeout(() => {
      // Only while the offer is still pending: after the ack it was retired (used), and nothing is given back.
      if (this.offers.get(offer.id) === offer && offer.state.kind === "held" && offer.state.session === session) { this.giveBack(offer, "ack lost"); session.link.end(); }
    }, this.options.ackTimeoutMs ?? PAIR_ACK_TIMEOUT_MS);
    timer.unref?.();
  }

  /** The offer is free again (same secret, same expiry). */
  giveBack(offer: Offer, event: "ack lost" | null): void {
    if ("session" in offer.state) { const session = offer.state.session; offer.state = { kind: "open" }; session.offer = null; }
    if (this.expired(offer)) { this.burn(offer, "expired"); return; }
    if (event) {
      this.options.log?.(`pairing: offer ${offer.id}: no ack; the offer is given back`);
      this.emit({ kind: "pair.declined", offer: offer.id, reason: event });
    }
  }

  /** The offer is gone (declined, cancelled, expired); a session on it is told why and ended. */
  burn(offer: Offer, reason: "code" | "expired" | "cancelled"): void {
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

  expire(offer: Offer): void {
    if (this.offers.get(offer.id) !== offer) return;
    // A device that is past the code (its Add is being written or waits for its ack) finishes; the rest end now.
    if (offer.state.kind === "held" || offer.state.kind === "adding") {
      offer.timer = setTimeout(() => this.expire(offer), 1_000);
      offer.timer.unref?.();
      return;
    }
    this.burn(offer, "expired");
  }

  expired(offer: Offer): boolean { return this.now() >= offer.expiresAt; }

  prune(): void {
    for (const offer of [...this.offers.values()]) if (this.expired(offer) && offer.state.kind !== "held" && offer.state.kind !== "adding") this.burn(offer, "expired");
    const now = this.now();
    for (const [id, until] of this.used) if (until <= now) this.used.delete(id);
  }

  /** What a new device needs to trust this cluster: the Roots, the servers' statements, its own Add. */
  trustSet(addId: string): SignedStatement[] {
    const view = this.options.roster.view;
    const out: SignedStatement[] = [];
    for (const { id, statement } of this.options.roster.statements()) {
      const body = statement.body;
      if (id === addId || body.type === "root" || ((body.type === "add" || body.type === "endorse" || body.type === "revoke") && view.servers.has(body.member))) out.push(statement);
      if (out.length >= 200) break;
    }
    return out;
  }

  emit(event: AdminEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { this.options.log?.(`pairing: an event listener failed: ${String((error as Error)?.message ?? error)}`); }
    }
  }
}
