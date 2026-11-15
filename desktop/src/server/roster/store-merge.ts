// The merge / join / recovery half of `RosterStore` (M7-S90): moved out of store.ts unchanged. `RosterMerge` owns the
// statement set and the state that follows it (`stored`, `verified`, `current`, `cluster`, `queue`, `gossipCache`,
// `auditedDropped`, `pendingReplace`) and the act pipeline (`serial`, `sign`, `apply`, `commit`); `RosterStore`
// (store.ts) keeps its public methods and reaches the moved members through one-line delegates and a block of
// forwarders. What the moved code borrows from `RosterStore` (backend, identity, options, the clock, the change
// listeners, `keepCandidates`, `statements`) comes through `RosterMergeHost`, and the block of forwarders at the top of
// the class is that interface in one screen. Nothing here imports store.ts, so there is no import cycle.
import { clusterIdFromRecoveryKey, encodePushSubscription, fromBase64Url, MemberKeys, memberIdFromKey, parsePushSubscription, RevocationStatement, RootStatement, SignedStatement, statementId, type ProfileField, type PushSubscription, type StatementBody } from "../../protocol";
import { normalizeRecoveryCode, recoveryKeyFromCode } from "../identity/recovery";
import type { Db } from "../store";
import { gossipKeeps, MAX_GOSSIP_SET, memberOf, RosterError, type AuditBody, type KeepCandidate, type PendingRecoveryReplace, type RecoveryConfirmResult, type RosterBackend, type RosterChange, type RosterIdentity, type RosterStoreOptions } from "./store-types";
import { computeRoster, validDevice, type MemberInfo, type RosterView, type VerifiedStatement } from "./validity";
import { signStatement, signWith, storedBytes, verifySignature, verifyStatements, type StoredStatement } from "./verify";

/** What `RosterMerge` borrows from the `RosterStore` that made it. */
export interface RosterMergeHost {
  readonly backend: RosterBackend;
  readonly identity: RosterIdentity;
  readonly options: RosterStoreOptions;
  readonly listeners: ReadonlySet<(change: RosterChange) => void>;
  now(): number;
  keepCandidates(): KeepCandidate[];
  statements(): StoredStatement[];
}

export class RosterMerge {
  stored = new Map<string, StoredStatement>();
  verified: VerifiedStatement[] = [];
  current: RosterView;
  cluster: string | null;
  queue: Promise<unknown> = Promise.resolve();
  gossipCache: { view: RosterView; items: StoredStatement[] } | null = null;
  readonly auditedDropped = new Set<string>();
  pendingReplace: PendingRecoveryReplace | null = null;

  constructor(private readonly host: RosterMergeHost, cluster: string | null) {
    this.cluster = cluster;
    this.current = computeRoster(host.identity.memberId, cluster, []);
  }

  // Bridge block: the names the moved code uses on `this` that the store owns.
  private get backend(): RosterBackend { return this.host.backend; }
  private get identity(): RosterIdentity { return this.host.identity; }
  private get options(): RosterStoreOptions { return this.host.options; }
  private get listeners(): ReadonlySet<(change: RosterChange) => void> { return this.host.listeners; }
  private now(): number { return this.host.now(); }
  private keepCandidates(): KeepCandidate[] { return this.host.keepCandidates(); }
  private statements(): StoredStatement[] { return this.host.statements(); }


  /**
   * Finishes replacing the recovery code once the user types the new code back (§4.8, M4-12): signs `Root{g+1}` with
   * the old recovery key, carrying forward all currently-counting server revocations in `keep`, and commits it with a
   * `root.change` audit row in one transaction.
   */
  confirmRecovery(typed: string): Promise<RecoveryConfirmResult> {
    return this.serial(async () => {
      const cluster = this.cluster;
      const root = this.current.root;
      if (cluster === null || !root) {
        this.clearPendingReplace();
        return { ok: false, reason: "no-cluster" };
      }
      if (root.root !== this.identity.memberId) {
        this.clearPendingReplace();
        return { ok: false, reason: "not-root" };
      }
      const pending = this.pendingReplace;
      if (!pending) return { ok: false, reason: "no-setup" };
      if (pending.expiresAt <= this.now()) {
        this.clearPendingReplace();
        return { ok: false, reason: "expired" };
      }
      if (pending.rootId !== root.id || pending.cluster !== cluster) {
        this.clearPendingReplace();
        return { ok: false, reason: "stale" };
      }
      if (!normalizeRecoveryCode(typed)) return { ok: false, reason: "malformed" };
      const newKey = await recoveryKeyFromCode(typed);
      let matched = false;
      try {
        matched = newKey.recoveryPub === pending.newRecoveryPub;
      } finally {
        newKey.publicKey.fill(0);
      }
      if (!matched) return { ok: false, reason: "wrong-code" };

      const keep = this.keepCandidates().map((item) => item.revokeId);
      if (keep.length > 1_000) throw new RosterError("bad-keep", "keep exceeds the maximum of 1000 revocations");
      const gen = root.gen + 1;
      const rootBody = RootStatement.parse({
        type: "root",
        cluster,
        gen,
        root: this.identity.memberId,
        recoveryPub: pending.newRecoveryPub,
        keep,
        prev: root.id,
      });
      const rootStmt = await signStatement(rootBody, "recovery", signWith(pending.oldPrivateKey));
      await this.commit([rootStmt], cluster, [{ act: "root.change", statement: rootStmt.id, by: "recovery", member: this.identity.memberId }]);
      this.clearPendingReplace();
      return { ok: true, clusterId: cluster, rootId: rootStmt.id, gen };
    });
  }

  /** Clears a pending recovery-code replacement (cancelled or failed). */
  cancelRecoveryReplace(): void {
    this.clearPendingReplace();
  }

  clearPendingReplace(): void {
    if (!this.pendingReplace) return;
    clearTimeout(this.pendingReplace.timer);
    this.pendingReplace = null;
  }

  /**
   * Merges statements from elsewhere (set union, §4.1). Kept: well-formed statements of this cluster; whether they
   * count is validity's business. Returns the ids that were new, or whose stored copy (one that did not verify) was
   * replaced by one that does. (M2 has no gossip; tests and M3 use this.)
   */
  merge(statements: readonly SignedStatement[]): Promise<string[]> {
    return this.serial(async () => {
      const cluster = this.requireCluster();
      const fresh: StoredStatement[] = [];
      const others: StoredStatement[] = [];
      for (const raw of statements) {
        const parsed = SignedStatement.safeParse(raw);
        if (!parsed.success || parsed.data.body.cluster !== cluster) continue;
        const id = await statementId(parsed.data.body);
        const known = this.stored.get(id);
        if (known) { if (known.statement.sig !== parsed.data.sig) others.push({ id, statement: parsed.data }); continue; }
        if (!fresh.some((item) => item.id === id)) fresh.push({ id, statement: parsed.data });
      }
      // One row per id (§7.3): a stored copy whose signature does not verify gives way to another copy that does.
      const verifiedIds = new Set(this.verified.map((item) => item.id));
      const candidates = others.filter((item) => !verifiedIds.has(item.id));
      let replacing: StoredStatement[] = [];
      if (candidates.length) {
        const trial = new Map(this.stored);
        for (const item of [...fresh, ...candidates]) trial.set(item.id, item);
        const ok = new Set((await verifyStatements(trial.values(), this.self())).map((item) => item.id));
        replacing = candidates.filter((item, index) => ok.has(item.id) && candidates.findIndex((other) => other.id === item.id) === index);
      }
      const changed = [...fresh, ...replacing];
      if (changed.length) await this.apply(changed, cluster, changed.map((item) => ({ act: "statement.merge" as const, statement: item.id, by: item.statement.signer, member: memberOf(item.statement.body) })));
      return changed.map((item) => item.id);
    });
  }

  /**
   * Adds a server (§4.5 step 4, on the member S once the joining server's code was checked): signs
   * `Add{server, by: this server}`. Returns the existing Add when that server is already valid here with these keys.
   */
  addServer(input: { keys: { sign: string; dh: string }; name: string }): Promise<{ member: string; addId: string; created: boolean }> {
    return this.serial(async () => {
      const cluster = this.requireCluster();
      const keys = MemberKeys.safeParse(input.keys);
      if (!keys.success) throw new RosterError("bad-keys", "a server's keys are two 32-byte public keys");
      const member = await memberIdFromKey(fromBase64Url(keys.data.sign)!);
      if (member === this.identity.memberId) throw new RosterError("bad-keys", "a server does not add itself");
      if (this.current.revoked.has(member)) throw new RosterError("revoked", "that server was removed from the cluster");
      const existing = this.current.members.get(member);
      if (existing && existing.kind === "server" && this.current.valid.has(member) && existing.keys.dh === keys.data.dh && existing.keys.sign === keys.data.sign) {
        return { member, addId: existing.addId, created: false };
      }
      const name = input.name.trim().slice(0, 100) || "Server";
      const add = await this.sign({ type: "add", cluster, member, kind: "server", keys: keys.data, name, by: this.identity.memberId, at: this.now(), joined: true });
      await this.apply([add], cluster, [{ act: "server.add", statement: add.id, by: this.identity.memberId, member, name }]);
      return { member, addId: add.id, created: true };
    });
  }

  /**
   * Joins a cluster (§4.5 step 4, on the joining server N, which has no cluster yet): takes the cluster id of `add` (the
   * member S's `Add{N, server}`), stores the statement set S sent, signs `Add{S, server, by: N}` and any extra bodies
   * (N's own Profile), all with `meta.clusterId` in one transaction; then endorses every member it finds valid (§4.2).
   * Refused unless the set gives a root chain, S is a known server of it, `add` names this server with its own keys,
   * and this server is valid afterwards. Returns N's Add of S.
   */
  joinCluster(input: { add: SignedStatement; roster: readonly SignedStatement[]; sponsor: { member: string; keys: { sign: string; dh: string }; name: string }; extra?: (cluster: string) => StatementBody[] }): Promise<{ clusterId: string; addId: string; add: SignedStatement }> {
    return this.serial(async () => {
      if (this.cluster !== null) throw new RosterError("cluster-exists", "this server already belongs to a cluster");
      const add = SignedStatement.safeParse(input.add);
      if (!add.success || add.data.body.type !== "add") throw new RosterError("bad-join", "the welcome carries no Add");
      const body = add.data.body;
      const self = this.identity;
      if (body.kind !== "server" || body.joined !== true || body.member !== self.memberId || body.keys.sign !== self.keys.sign || body.keys.dh !== self.keys.dh) {
        throw new RosterError("bad-join", "the Add does not name this server with its keys");
      }
      if (body.by !== input.sponsor.member) throw new RosterError("bad-join", "the Add is not signed by the server this pairing ran with");
      const cluster = body.cluster;
      const set = new Map<string, StoredStatement>();
      for (const raw of [...input.roster, add.data]) {
        const parsed = SignedStatement.safeParse(raw);
        if (!parsed.success || parsed.data.body.cluster !== cluster) continue;
        const id = await statementId(parsed.data.body);
        if (!set.has(id)) set.set(id, { id, statement: parsed.data });
      }
      const sponsorKeys = MemberKeys.safeParse(input.sponsor.keys);
      if (!sponsorKeys.success) throw new RosterError("bad-keys", "the sponsor's keys are malformed");
      const own: StoredStatement[] = [await this.sign({
        type: "add", cluster, member: input.sponsor.member, kind: "server", keys: sponsorKeys.data, name: input.sponsor.name.trim().slice(0, 100) || "Server",
        by: self.memberId, at: this.now(), joined: false,
      })];
      for (const extra of input.extra?.(cluster) ?? []) own.push(await this.sign(extra));
      const trial = [...set.values(), ...own];
      const view = computeRoster(self.memberId, cluster, await verifyStatements(trial, this.self()));
      if (!view.root) throw new RosterError("bad-join", "the statements give no root for that cluster");
      if (!view.servers.has(input.sponsor.member) || !view.valid.has(input.sponsor.member)) throw new RosterError("bad-join", "the sponsor is not a valid server of that cluster");
      if (!view.valid.has(self.memberId)) throw new RosterError("bad-join", "this server would not be valid in that cluster");
      const sponsorInfo = view.members.get(input.sponsor.member);
      if (!sponsorInfo || sponsorInfo.keys.sign !== sponsorKeys.data.sign || sponsorInfo.keys.dh !== sponsorKeys.data.dh) throw new RosterError("bad-join", "the sponsor's keys differ from its Add");
      const addId = own[0].id;
      const addOfSelf = await statementId(body);
      await this.apply(trial, cluster, [
        { act: "cluster.join", statement: addOfSelf, by: body.by, member: self.memberId },
        { act: "server.add", statement: addId, by: self.memberId, member: input.sponsor.member, name: input.sponsor.name.slice(0, 100) },
      ], (tx) => {
        if (tx.prepare("SELECT 1 FROM meta WHERE key = 'clusterId'").get()) throw new RosterError("cluster-exists", "this server already belongs to a cluster");
        tx.prepare("INSERT INTO meta (key, value) VALUES ('clusterId', ?)").run(cluster);
      });
      return { clusterId: cluster, addId, add: own[0].statement };
    });
  }

  /**
   * Writes `Profile{member, field, value}` signed by this server (its own addresses, or a peer's addresses this server
   * just reached it at), unless the value read back is that already. The hlc is above every Profile of that field.
   * Returns the statement, or null when nothing was written.
   */
  writeProfile(member: string, field: ProfileField, value: string): Promise<SignedStatement | null> {
    return this.serial(async () => {
      const cluster = this.requireCluster();
      let storedValue = value;
      if (field === "push") {
        // §18.4: only valid, unrevoked devices hold a push subscription; re-checked inside serial at commit time.
        if (!validDevice(this.current, member)) {
          if (this.current.revoked.has(member)) throw new RosterError("revoked", "cannot store a push subscription for a revoked device");
          throw new RosterError("not-a-device", "push subscriptions belong only to valid devices");
        }
        const parsed = parsePushSubscription(value);
        if (!parsed) throw new RosterError("bad-profile", "push subscription is malformed");
        storedValue = encodePushSubscription(parsed);
      }
      if (this.profile(member, field) === storedValue) return null;
      let ms = this.now();
      let c = 0;
      for (const { body } of this.verified) {
        if (body.type !== "profile" || body.member !== member || body.field !== field) continue;
        if (body.hlc.ms > ms || (body.hlc.ms === ms && body.hlc.c >= c)) { ms = body.hlc.ms; c = body.hlc.c + 1; }
      }
      const profile = await this.sign({ type: "profile", cluster, member, field, value: storedValue.slice(0, 2_000), hlc: { ms, c: Math.min(c, 0xffff) } });
      await this.apply([profile], cluster, [{ act: "profile.write", statement: profile.id, by: this.identity.memberId, member }]);
      return profile.statement;
    });
  }

  /**
   * Every Revoke and Root this server holds, as sent across a refused server handshake and at the start of every peer
   * session (§4.6, D47). Sorted by id.
   */
  revocations(): Array<{ id: string; statement: SignedStatement }> {
    return this.statements().filter((item) => item.statement.body.type === "revoke" || item.statement.body.type === "root");
  }

  /**
   * Merges Revoke and Root statements a peer server sent (§4.6, D47), also while this server finds itself revoked:
   * that is how a `Root` that brings it back reaches it. Anything else in the list is ignored. The peer may be invalid
   * or hostile, so only what counts here is stored (security review of M3 step 3): a `Root` of this server's chain
   * (each candidate Root is checked against the recovery key its `prev` names, or for gen 1 against its own key bound
   * to the cluster id, before the set is verified, so foreign Roots cost one check each), and a `Revoke` that counts
   * (§4.2) once the whole list is in. A statement whose stored copy does not verify gives way to one that does.
   * Pass a whole `roster.revocations` set at once: a later root's Revoke counts only next to its Root.
   * Returns the ids that were new (or replaced).
   */
  mergeRevocations(statements: readonly unknown[]): Promise<string[]> {
    return this.serial(async () => {
      const cluster = this.cluster;
      if (cluster === null) return [];
      const verifiedIds = new Set(this.verified.map((item) => item.id));
      const candidates = new Map<string, StoredStatement>();
      for (const raw of statements) {
        const parsed = RevocationStatement.safeParse(raw);
        if (!parsed.success || parsed.data.body.cluster !== cluster) continue;
        const id = await statementId(parsed.data.body);
        if (verifiedIds.has(id) || candidates.has(id)) continue;
        candidates.set(id, { id, statement: parsed.data });
      }
      if (!candidates.size) return [];
      await this.keepChainRoots(candidates);
      if (!candidates.size) return [];
      const trial = new Map(this.stored);
      for (const item of candidates.values()) trial.set(item.id, item);
      const verified = await verifyStatements(trial.values(), this.self());
      const view = computeRoster(this.identity.memberId, cluster, verified);
      const roots = new Map<string, string | null>();
      for (const { id, body } of verified) if (body.type === "root") roots.set(id, body.prev);
      const chain = new Set<string>();
      for (let at = view.root?.id ?? null; at !== null && !chain.has(at);) { chain.add(at); at = roots.get(at) ?? null; }
      const counting = new Set(view.countingRevokes);
      const verifiedNow = new Set(verified.map((item) => item.id));
      const fresh = [...candidates.values()].filter((item) => verifiedNow.has(item.id) && (item.statement.body.type === "root" ? chain.has(item.id) : counting.has(item.id)));
      if (fresh.length) await this.apply(fresh, cluster, fresh.map((item) => ({ act: "statement.merge" as const, statement: item.id, by: item.statement.signer, member: memberOf(item.statement.body) })));
      return fresh.map((item) => item.id);
    });
  }

  /**
   * Merges statements a valid peer sent by gossip (§4.7, M3 step 5): set union, but only what verifies and what a
   * party this set knows signed is stored, so a peer cannot grow this server's store with junk (step 3 review P1):
   *   - Root: signed by the recovery key its `prev` names (gen 1: its own key, bound to the cluster id);
   *   - Add, Endorse, Revoke: signed (and verified) by a known server (R3; revoked or not: a dropped revocation, D63,
   *     is still listed, and a revoked server's device revocations still count, D66 part 4);
   *   - Profile: signed by its member (a member some known server's Add names, or this server) or by a known server
   *     (whether it counts is `profile()`'s business, K12).
   * Each rule only grows with the set, so two servers that end with the same input keep the same set (the digest
   * converges). What fails now is returned as `refused`; it is asked for again after a later change (an Endorse
   * whose Add comes later). Pass a whole set at once: a statement counts only next to the ones that vouch for it.
   * D66 (proposed, not adopted) would narrow these rules inside `gossipKeeps`; nothing else changes then.
   */
  mergeGossip(statements: readonly unknown[], limit = MAX_GOSSIP_SET): Promise<{ fresh: string[]; refused: string[] }> {
    return this.serial(async () => {
      const cluster = this.cluster;
      if (cluster === null || this.current.revoked.has(this.identity.memberId)) return { fresh: [], refused: [] };
      const verifiedIds = new Set(this.verified.map((item) => item.id));
      const candidates = new Map<string, StoredStatement>();
      const refused = new Set<string>();
      for (const raw of statements.slice(0, limit)) {
        const parsed = SignedStatement.safeParse(raw);
        if (!parsed.success || parsed.data.body.cluster !== cluster) continue;
        const id = await statementId(parsed.data.body);
        if (verifiedIds.has(id) || candidates.has(id)) continue;
        candidates.set(id, { id, statement: parsed.data });
      }
      if (!candidates.size) return { fresh: [], refused: [] };
      const all = new Set(candidates.keys());
      await this.keepChainRoots(candidates);
      const trial = new Map(this.stored);
      for (const item of candidates.values()) trial.set(item.id, item);
      const verified = await verifyStatements(trial.values(), this.self());
      const view = computeRoster(this.identity.memberId, cluster, verified);
      const ok = new Map(verified.map((item) => [item.id, item]));
      const fresh = [...candidates.values()].filter((item) => {
        const checked = ok.get(item.id);
        return !!checked && gossipKeeps(checked, view);
      });
      const kept = new Set(fresh.map((item) => item.id));
      for (const id of all) if (!kept.has(id)) refused.add(id);
      if (fresh.length) await this.apply(fresh, cluster, fresh.map((item) => ({ act: "statement.merge" as const, statement: item.id, by: item.statement.signer, member: memberOf(item.statement.body) })));
      return { fresh: fresh.map((item) => item.id), refused: [...refused] };
    });
  }

  /**
   * The statements gossip carries and digests (§4.7): the stored ones that verify and that `gossipKeeps` would take
   * now (Roots only of this cluster's recovery-key chain). A statement stored without that (written directly, or by
   * M2's `merge`) stays stored but is neither counted in the digest nor sent, so it cannot keep two servers' digests
   * apart. Sorted by id; cached per view.
   */
  gossipStatements(): StoredStatement[] {
    if (this.gossipCache?.view === this.current) return this.gossipCache.items;
    const view = this.current;
    const rootOk = new Map<string, Extract<StatementBody, { type: "root" }>>();
    const roots = this.verified.filter((item) => item.body.type === "root").sort((x, y) => (x.body as { gen: number }).gen - (y.body as { gen: number }).gen);
    for (const item of roots) {
      const body = item.body as Extract<StatementBody, { type: "root" }>;
      const first = body.gen === 1 && body.prev === null && item.recoveryKey === body.recoveryPub && item.recoveryKeyCluster === this.cluster;
      const prev = body.prev !== null ? rootOk.get(body.prev) : undefined;
      if (first || (prev && prev.gen === body.gen - 1 && item.recoveryKey === prev.recoveryPub)) rootOk.set(item.id, body);
    }
    const keep = new Set<string>();
    for (const item of this.verified) {
      if (item.body.cluster !== this.cluster) continue;
      if (item.body.type === "root" ? rootOk.has(item.id) : gossipKeeps(item, view)) keep.add(item.id);
    }
    const items = this.statements().filter((item) => keep.has(item.id));
    this.gossipCache = { view, items };
    return items;
  }

  /** The stored statements with these ids (answers to `roster.want`). */
  statementsById(ids: Iterable<string>): StoredStatement[] {
    const out: StoredStatement[] = [];
    for (const id of new Set(ids)) { const item = this.stored.get(id); if (item) out.push(item); }
    return out;
  }

  /**
   * Leaves in `candidates` only the Roots a recovery key of this chain signed, checked one each (gen order, so a
   * candidate can be another's prev): foreign Roots cost one check each (step 3 review P1). Other kinds are untouched.
   */
  private async keepChainRoots(candidates: Map<string, StoredStatement>): Promise<void> {
    const cluster = this.cluster;
    const roots = new Map<string, Extract<StatementBody, { type: "root" }>>();
    for (const { id, body } of this.verified) if (body.type === "root") roots.set(id, body);
    const rootCandidates = [...candidates.values()].filter((item) => item.statement.body.type === "root")
      .sort((x, y) => (x.statement.body as { gen: number }).gen - (y.statement.body as { gen: number }).gen);
    for (const item of rootCandidates) {
      candidates.delete(item.id);
      const body = item.statement.body as Extract<StatementBody, { type: "root" }>;
      let key: string | null = null;
      if (body.gen === 1 && body.prev === null) {
        const raw = fromBase64Url(body.recoveryPub);
        if (raw && raw.length === 32 && (await clusterIdFromRecoveryKey(raw)) === cluster) key = body.recoveryPub;
      } else if (body.prev !== null) {
        const prev = roots.get(body.prev);
        if (prev && prev.gen === body.gen - 1) key = prev.recoveryPub;
      }
      if (key === null || !(await verifySignature(item.statement, key))) continue;
      roots.set(item.id, body);
      candidates.set(item.id, item);
    }
  }

  /**
   * A member's newest verified `Profile` value for `field` (by hlc, then the smaller id), signed by the member itself or
   * by a server that is valid here (a known server that was revoked can no longer redirect a peer's address: M3 step 3
   * review, step 4); null when there is none (§4.1, §6.2: peers' addresses).
   */
  profile(member: string, field: ProfileField): string | null {
    // §18.4: a revoked device's push subscription is never used.
    if (field === "push" && !validDevice(this.current, member)) return null;
    let best: { value: string; ms: number; c: number; id: string } | null = null;
    for (const { id, body, signer } of this.verified) {
      if (body.type !== "profile" || body.member !== member || body.field !== field || body.cluster !== this.cluster) continue;
      if (signer !== member && !(this.current.servers.has(signer) && this.current.valid.has(signer))) continue;
      const { ms, c } = body.hlc;
      if (!best || ms > best.ms || (ms === best.ms && (c > best.c || (c === best.c && id < best.id)))) best = { value: body.value, ms, c, id };
    }
    if (!best) return null;
    if (field === "push" && !parsePushSubscription(best.value)) return null;
    return best.value;
  }

  /** A valid, unrevoked device's parsed Web Push subscription, or null (§18.4). */
  pushSubscription(member: string): PushSubscription | null {
    const raw = this.profile(member, "push");
    return raw ? parsePushSubscription(raw) : null;
  }

  /** Every valid, unrevoked device with a well-formed Web Push subscription, sorted by device id (§18.4). */
  pushSubscriptions(): Array<{ device: string; subscription: PushSubscription }> {
    const out: Array<{ device: string; subscription: PushSubscription }> = [];
    for (const member of [...this.current.valid].sort()) {
      const subscription = this.pushSubscription(member);
      if (subscription) out.push({ device: member, subscription });
    }
    return out;
  }

  self() {
    return { memberId: this.identity.memberId, signPub: this.identity.keys.sign };
  }

  requireCluster(): string {
    if (this.cluster === null) throw new RosterError("no-cluster", "there is no cluster yet (it is made at the first pairing)");
    if (this.current.revoked.has(this.identity.memberId)) throw new RosterError("self-revoked", "this server was removed from the cluster");
    return this.cluster;
  }

  sign(body: StatementBody): Promise<StoredStatement> {
    return signStatement(body, this.identity.memberId, (bytes) => this.identity.sign(bytes));
  }

  serial<T>(act: () => Promise<T>): Promise<T> {
    const run = this.queue.then(act, act);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Stores `fresh` (and runs `extra` in the same transaction), then swaps the view. The new view is computed before
   * the commit and published right after it; then members this server should endorse are endorsed.
   */
  async apply(fresh: StoredStatement[], cluster: string, audits: Array<Omit<AuditBody, "at">>, extra?: (tx: Db) => void): Promise<RosterView> {
    const view = await this.commit(fresh, cluster, audits, extra);
    const endorse = this.missingEndorsements(view);
    if (endorse.length) {
      const signed: StoredStatement[] = [];
      for (const info of endorse) signed.push(await this.sign({ type: "endorse", cluster, member: info.member, addId: info.addId, by: this.identity.memberId }));
      return this.commit(signed, cluster, signed.map((item, index) => ({ act: "member.endorse" as const, statement: item.id, by: this.identity.memberId, member: endorse[index].member })));
    }
    return view;
  }

  async commit(fresh: StoredStatement[], cluster: string, audits: Array<Omit<AuditBody, "at">>, extra?: (tx: Db) => void): Promise<RosterView> {
    const at = this.now();
    const stored = new Map(this.stored);
    for (const item of fresh) stored.set(item.id, { ...item, receivedAt: at });
    const verified = await verifyStatements(stored.values(), this.self());
    const view = computeRoster(this.identity.memberId, cluster, verified);
    const droppedAudits = droppedAuditsFor(view, this.auditedDropped);
    const allAudits = [...audits, ...droppedAudits];
    await this.backend.submit((tx) => {
      extra?.(tx);
      const insert = tx.prepare("INSERT INTO roster (id, kind, member, bytes, receivedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET bytes = excluded.bytes, receivedAt = excluded.receivedAt");
      for (const item of fresh) insert.run(item.id, item.statement.body.type, memberOf(item.statement.body), storedBytes(item.statement), at);
      writeAudits(tx, allAudits.map((audit) => ({ ...audit, at })));
    });
    for (const audit of droppedAudits) this.auditedDropped.add(audit.statement);
    const before = this.current;
    this.stored = stored;
    this.verified = verified;
    this.cluster = cluster;
    this.current = view;
    if (this.pendingReplace && view.root?.id !== this.pendingReplace.rootId) this.clearPendingReplace();
    const invalidated = [...before.valid].filter((member) => !view.valid.has(member));
    for (const listener of this.listeners) {
      try { listener({ view, invalidated }); } catch (error) { this.options.log?.(`roster: a change listener failed: ${String((error as Error)?.message ?? error)}`); }
    }
    return view;
  }

  /** Valid members (not this server) with an Add by a known server but no Add or Endorse signed by this server. */
  private missingEndorsements(view: RosterView): MemberInfo[] {
    const self = this.identity.memberId;
    const vouched = new Set<string>();
    for (const { body } of this.verified) {
      if ((body.type === "add" || body.type === "endorse") && body.by === self) vouched.add(body.member);
    }
    return [...view.valid].filter((member) => member !== self && !vouched.has(member)).sort()
      .map((member) => view.members.get(member)).filter((info): info is MemberInfo => !!info);
  }
}

/** Audit rows in the server's `srv:` table stream (§8.2): key `audit:<statement id>`, rev = the stream's next rev. */
export function droppedAuditsFor(view: RosterView, audited: ReadonlySet<string>): Array<Omit<AuditBody, "at">> {
  return view.dropped
    .filter((row) => !audited.has(row.revokeId))
    .map((row) => {
      const name = view.members.get(row.member)?.name;
      return {
        act: "server.revoke.dropped" as const,
        statement: row.revokeId,
        by: row.signer,
        member: row.member,
        ...(name ? { name } : {}),
        reason: `gen ${row.gen}: ${row.why}`,
      };
    });
}

export function writeAudits(tx: Db, audits: AuditBody[]): void {
  if (!audits.length) return;
  const serverId = tx.prepare("SELECT value FROM meta WHERE key = 'serverId'").get();
  if (!serverId) throw new Error("server.db has no serverId");
  const stream = `srv:${String(serverId.value)}`;
  let rev = Number(tx.prepare("SELECT MAX(rev) AS rev FROM rows WHERE stream = ?").get(stream)?.rev ?? 0);
  const put = tx.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, ?, ?, 0) ON CONFLICT (stream, key) DO NOTHING");
  for (const audit of audits) {
    // Dropped-row audits use a distinct audit:dropped: prefix (<= 64 chars after audit:, fitting RowKey) so they do
    // not collide with the Revoke statement's own statement.merge / server.revoke row at audit:<statement id>.
    const key = audit.act === "server.revoke.dropped"
      ? `audit:dropped:${audit.statement.slice(0, 56)}`
      : `audit:${audit.statement}`;
    put.run(stream, key, ++rev, JSON.stringify(audit));
  }
}
