// The roster of one server (protocol v1 §4): the grow-only statement set in server.db (`roster`, schema v1 + v5), the
// validity it gives (validity.ts, recomputed after every change), and the acts this server signs itself.
//
// - Writes: through the server.db writer, one transaction per act, with the act's audit row in the server's `srv:`
//   table stream (`rows`, key `audit:<statement id>`, §8.2). The view in memory is swapped only after COMMIT, and
//   computed before it, so once an act resolves every reader of `view` already sees it (a session that checks
//   `isValid` on its next frame refuses a revoked device, M2 step 4).
// - Acts are serialised (one at a time), so two acts never compute their views from the same old set.
// - What this server signs (§4.3): the cluster's first Root is signed by the recovery key (identity/cluster.ts hands it
//   in); `Add` of a device, `Revoke` of a device it has in its roster, `Revoke` of a server when this server is the
//   current revocation root (D46, D61), and `Endorse` of a member it finds valid that it neither added nor endorsed yet.
// - Listeners hear which members stopped being valid (sessions close, M2 step 4).
import { addJoins, DEFAULT_DEVICE_SCOPE, DeviceScope, fromBase64Url, MemberKeys, memberIdFromKey, revokeCascades, RootStatement, rosterDigest, statementId, type ProfileField, type PushSubscription, type SignedStatement, type StatementBody } from "../../protocol";
import { formatRecoveryCode, newRecoveryCode, normalizeRecoveryCode, recoveryKeyFromCode } from "../identity/recovery";
import type { Db } from "../store";
import { droppedAuditsFor, RosterMerge, writeAudits } from "./store-merge";
import { RECOVERY_REPLACE_TTL_MS, RosterError, type AuditBody, type KeepCandidate, type PendingRecoveryReplace, type RecoveryConfirmResult, type RecoveryReplaceStarted, type RosterChange, type RosterBackend, type RosterIdentity, type RosterStoreOptions } from "./store-types";
import { computeRoster, validDevice, type DroppedRow, type MemberInfo, type RosterView, type VerifiedStatement } from "./validity";
import { parseStored, signStatement, signWith, verifyStatements, type StoredStatement } from "./verify";

// Moved to store-types.ts (M7-S90); stay exported from here.
export { gossipKeeps, MAX_GOSSIP_SET, RECOVERY_REPLACE_TTL_MS, RosterError } from "./store-types";
export type { AuditAct, AuditBody, KeepCandidate, RecoveryConfirmResult, RecoveryReplaceStarted, RosterBackend, RosterChange, RosterIdentity, RosterRefusal, RosterStoreOptions } from "./store-types";

export class RosterStore {
  private readonly merger: RosterMerge;
  private readonly listeners = new Set<(change: RosterChange) => void>();
  private readonly now: () => number;
  private readonly dismissed = new Set<string>();

  private constructor(private readonly backend: RosterBackend, private readonly identity: RosterIdentity, private readonly options: RosterStoreOptions, cluster: string | null) {
    this.now = options.now ?? Date.now;
    this.merger = new RosterMerge({ backend, identity, options, listeners: this.listeners, now: () => this.now(), keepCandidates: () => this.keepCandidates(), statements: () => this.statements() }, cluster);
  }

  // Bridge block (M7-S90): the state and the act pipeline `RosterMerge` (store-merge.ts) owns, under the names the code
  // here uses. The setters stay only until the refinement cards give `RosterMerge` named transitions.
  private get stored(): Map<string, StoredStatement> { return this.merger.stored; }
  private get verified(): VerifiedStatement[] { return this.merger.verified; }
  private set verified(value: VerifiedStatement[]) { this.merger.verified = value; }
  private get current(): RosterView { return this.merger.current; }
  private set current(value: RosterView) { this.merger.current = value; }
  private get cluster(): string | null { return this.merger.cluster; }
  private get queue(): Promise<unknown> { return this.merger.queue; }
  private get auditedDropped(): Set<string> { return this.merger.auditedDropped; }
  private get pendingReplace(): PendingRecoveryReplace | null { return this.merger.pendingReplace; }
  private set pendingReplace(value: PendingRecoveryReplace | null) { this.merger.pendingReplace = value; }
  private self() { return this.merger.self(); }
  private requireCluster(): string { return this.merger.requireCluster(); }
  private sign(body: StatementBody): Promise<StoredStatement> { return this.merger.sign(body); }
  private serial<T>(act: () => Promise<T>): Promise<T> { return this.merger.serial(act); }
  private apply(fresh: StoredStatement[], cluster: string, audits: Array<Omit<AuditBody, "at">>, extra?: (tx: Db) => void): Promise<RosterView> { return this.merger.apply(fresh, cluster, audits, extra); }
  private commit(fresh: StoredStatement[], cluster: string, audits: Array<Omit<AuditBody, "at">>, extra?: (tx: Db) => void): Promise<RosterView> { return this.merger.commit(fresh, cluster, audits, extra); }
  private clearPendingReplace(): void { this.merger.clearPendingReplace(); }

  /** Reads the stored set and computes the view. Malformed rows are skipped (and counted in the log). */
  static async open(backend: RosterBackend, identity: RosterIdentity, options: RosterStoreOptions = {}): Promise<RosterStore> {
    const reader = backend.openReader();
    let cluster: string | null;
    let serverId: string | null = null;
    const rows: Array<{ id: string; bytes: Uint8Array; receivedAt: number }> = [];
    const dismissedIds: string[] = [];
    const auditedIds: string[] = [];
    try {
      const meta = reader.prepare("SELECT value FROM meta WHERE key = 'clusterId'").get();
      cluster = meta ? String(meta.value) : null;
      const sidRow = reader.prepare("SELECT value FROM meta WHERE key = 'serverId'").get();
      serverId = sidRow ? String(sidRow.value) : null;
      for (const row of reader.prepare("SELECT id, bytes, receivedAt FROM roster").all()) {
        rows.push({ id: String(row.id), bytes: row.bytes as Uint8Array, receivedAt: Number(row.receivedAt) });
      }
      for (const row of reader.prepare("SELECT key FROM meta WHERE key LIKE 'dropped.dismissed:%'").all()) {
        const id = String(row.key).slice("dropped.dismissed:".length);
        if (id) dismissedIds.push(id);
      }
      if (serverId) {
        for (const row of reader.prepare("SELECT body FROM rows WHERE stream = ? AND key LIKE 'audit:dropped:%'").all(`srv:${serverId}`)) {
          try {
            const body = JSON.parse(String(row.body)) as Partial<AuditBody>;
            if (body.act === "server.revoke.dropped" && typeof body.statement === "string") auditedIds.push(body.statement);
          } catch { /* ignore malformed row */ }
        }
      }
    } finally {
      reader.close();
    }
    const roster = new RosterStore(backend, identity, options, cluster);
    for (const id of dismissedIds) roster.dismissed.add(id);
    for (const id of auditedIds) roster.auditedDropped.add(id);
    let skipped = 0;
    for (const row of rows) {
      const statement = parseStored(row.bytes);
      if (!statement || (await statementId(statement.body)) !== row.id) { skipped++; continue; }
      roster.stored.set(row.id, { id: row.id, statement, receivedAt: row.receivedAt });
    }
    if (skipped) options.log?.(`roster: ${skipped} stored statements are malformed and were skipped`);
    roster.verified = await verifyStatements(roster.stored.values(), roster.self());
    roster.current = computeRoster(identity.memberId, cluster, roster.verified);
    const missingDropped = droppedAuditsFor(roster.current, roster.auditedDropped);
    if (serverId && missingDropped.length) {
      const at = roster.now();
      await backend.submit((tx) => writeAudits(tx, missingDropped.map((audit) => ({ ...audit, at }))));
      for (const audit of missingDropped) roster.auditedDropped.add(audit.statement);
    }
    return roster;
  }

  /** The validity view (computed from the committed set). */
  get view(): RosterView { return this.current; }
  get clusterId(): string | null { return this.cluster; }
  get memberId(): string { return this.identity.memberId; }

  isValid(member: string): boolean { return this.current.valid.has(member); }
  /** A valid device's keys, name and scope, or null. */
  device(member: string): MemberInfo | null { return validDevice(this.current, member); }
  /** Every stored statement, by id. */
  statements(): StoredStatement[] { return [...this.stored.values()].sort((a, b) => (a.id < b.id ? -1 : 1)); }

  /**
   * Pending server revocations (§4.8) a reroot offers to `keep`: counting server revocations signed by the current or
   * carried-over earlier roots, minus any against this server itself, sorted by revokeId. Read-only.
   */
  /**
   * Server revocations from earlier roots that did not carry over across a reroot (D63, §4.8), minus any dismissed
   * locally on this server. Pure validity stays in `view.dropped`; dismissing never changes member validity.
   */
  dropped(): DroppedRow[] {
    return this.current.dropped.filter((row) => !this.dismissed.has(row.revokeId));
  }

  /**
   * Hides a dropped revocation locally on this server (`meta`, §4.8, M4-10): signs nothing, replicates nothing, and
   * never changes any member's validity.
   */
  dismissDropped(revokeId: string): Promise<{ already: boolean }> {
    return this.serial(async () => {
      if (this.cluster === null) throw new RosterError("no-cluster", "there is no cluster yet (it is made at the first pairing)");
      if (this.dismissed.has(revokeId)) return { already: true };
      if (!this.current.dropped.some((row) => row.revokeId === revokeId)) {
        throw new RosterError("not-dropped", "no such dropped revocation");
      }
      const at = this.now();
      await this.backend.submit((tx) => {
        tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
          .run(`dropped.dismissed:${revokeId}`, String(at));
      });
      this.dismissed.add(revokeId);
      return { already: false };
    });
  }

  keepCandidates(): KeepCandidate[] {
    if (!this.current.root) return [];
    const counting = new Set(this.current.countingRevokes);
    const self = this.identity.memberId;
    const out: KeepCandidate[] = [];
    for (const item of this.verified) {
      if (item.body.type !== "revoke" || !counting.has(item.id)) continue;
      const { member, by, gen } = item.body;
      if (!this.current.servers.has(member) || member === self) continue;
      out.push({ revokeId: item.id, member, signer: by, gen, receivedAt: item.receivedAt ?? null });
    }
    return out.sort((a, b) => (a.revokeId < b.revokeId ? -1 : a.revokeId > b.revokeId ? 1 : 0));
  }
  /** `roster.have` / `welcome.rosterDigest` (§4.7). */
  digest(): Promise<string> { return rosterDigest(this.stored.keys()); }

  onChange(listener: (change: RosterChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Waits for every act started so far. */
  idle(): Promise<void> { return this.queue.then(() => undefined, () => undefined); }

  /**
   * Creates the cluster (identity/cluster.ts, after the recovery code was typed back): stores `meta.clusterId` and the
   * first Root, signed by the recovery key and naming this server as root, in one transaction.
   */
  createCluster(root: StoredStatement, clusterId: string): Promise<RosterView> {
    return this.serial(async () => {
      if (this.cluster !== null) throw new RosterError("cluster-exists", "this server already belongs to a cluster");
      const body = root.statement.body;
      if (body.type !== "root" || body.gen !== 1 || body.root !== this.identity.memberId || body.cluster !== clusterId) {
        throw new RosterError("bad-root", "the first Root names gen 1, this cluster and this server");
      }
      const check = computeRoster(this.identity.memberId, clusterId, await verifyStatements([root], this.self()));
      if (check.root?.id !== root.id) throw new RosterError("bad-root", "the Root does not verify for this cluster");
      const view = await this.apply([root], clusterId, [{ act: "cluster.create", statement: root.id, by: "recovery", member: body.root }], (tx) => {
        if (tx.prepare("SELECT 1 FROM meta WHERE key = 'clusterId'").get()) throw new RosterError("cluster-exists", "this server already belongs to a cluster");
        tx.prepare("INSERT INTO meta (key, value) VALUES ('clusterId', ?)").run(clusterId);
      });
      return view;
    });
  }

  /**
   * Adds a device (§4.4 step 4: after the code was confirmed): signs `Add{device, by: this server, scope}`. Returns the
   * existing Add when the device is already valid with these keys. A revoked device is refused: pairing again makes a
   * new key, hence a new id.
   */
  addDevice(input: { keys: { sign: string; dh: string }; name: string; scope?: readonly DeviceScope[] }): Promise<{ member: string; addId: string; created: boolean }> {
    return this.serial(async () => {
      const cluster = this.requireCluster();
      const keys = MemberKeys.safeParse(input.keys);
      if (!keys.success) throw new RosterError("bad-keys", "a device's keys are two 32-byte public keys");
      const member = await memberIdFromKey(fromBase64Url(keys.data.sign)!);
      if (member === this.identity.memberId || this.current.servers.has(member)) throw new RosterError("not-a-device", "that key is a server's");
      if (this.current.revoked.has(member)) throw new RosterError("revoked", "this device was revoked; pair it again with a new key");
      const existing = this.current.members.get(member);
      if (existing && this.current.valid.has(member) && existing.keys.dh === keys.data.dh) return { member, addId: existing.addId, created: false };
      const scope = [...new Set(input.scope ?? DEFAULT_DEVICE_SCOPE)].map((item) => DeviceScope.parse(item));
      const name = input.name.trim().slice(0, 100) || "Device";
      const add = await this.sign({ type: "add", cluster, member, kind: "device", keys: keys.data, name, scope, by: this.identity.memberId, at: this.now() });
      await this.apply([add], cluster, [{ act: "device.add", statement: add.id, by: this.identity.memberId, member, name }]);
      return { member, addId: add.id, created: true };
    });
  }

  /**
   * Revokes a device this server has in its roster (§4.3, §4.6): `Revoke{device, by: this server, gen, cascade: false}` (D61).
   * Idempotent: a device already revoked returns its counting revoke. A server cannot be revoked here (root only, M4).
   */
  revokeDevice(member: string, reason = ""): Promise<{ revokeId: string; already: boolean }> {
    return this.serial(async () => {
      const cluster = this.requireCluster();
      if (this.current.servers.has(member)) throw new RosterError("server-revoke-root-only", "a server is revoked only by the revocation root (use revokeServer)");
      const info = this.current.members.get(member);
      if (!info || info.kind !== "device") throw new RosterError("not-a-device", "no such device in this roster");
      if (this.current.revoked.has(member)) {
        const counting = this.current.countingRevokes.find((id) => {
          const body = this.stored.get(id)?.statement.body;
          return body?.type === "revoke" && body.member === member;
        });
        return { revokeId: counting ?? "", already: true };
      }
      const revoke = await this.sign({ type: "revoke", cluster, member, reason: reason.slice(0, 500), by: this.identity.memberId, gen: this.current.root?.gen ?? 1, cascade: false });
      await this.apply([revoke], cluster, [{ act: "device.revoke", statement: revoke.id, by: this.identity.memberId, member, name: info.name, ...(reason ? { reason: reason.slice(0, 500) } : {}) }]);
      return { revokeId: revoke.id, already: false };
    });
  }

  /**
   * Preview of the members `revokeServer(member, true)` would remove alongside `member` (D60, D61): the transitive
   * closure of joining Adds signed by `member` or someone already in the set, never the root. Computed on a copy;
   * writes nothing.
   */
  cascadePreview(member: string): string[] {
    const cluster = this.cluster;
    const root = this.current.root;
    if (cluster === null || !root || member === root.root || !this.current.servers.has(member)) return [];
    // Compute on a copy of the verified statements with one synthetic cascading Revoke so validity.ts's own
    // `cascadeOf` closure runs without mutating the store, excluding members already marked revoked.
    const copy: VerifiedStatement[] = [...this.verified, {
      id: "~preview",
      body: { type: "revoke", cluster, member, reason: "", by: root.root, gen: root.gen, cascade: true },
      signer: root.root,
    }];
    const view = computeRoster(this.identity.memberId, cluster, copy);
    return [...view.revoked].filter((id) => id !== member && !this.current.revoked.has(id)).sort();
  }

  /**
   * Revokes a server (§4.3, §4.6, D46, D60, D61, K8): allowed only on the roster's current revocation root, never for
   * the root itself, and only for a known server. Signs `Revoke{member, gen: R.gen, cascade, seen}` in one transaction
   * with the `server.revoke` audit row; `seen` lists every joining Add signed by `member` that this root holds.
   * Idempotent: a second call for the same member and cascade (or when already revoked with cascade) signs nothing.
   */
  revokeServer(member: string, cascade: boolean, reason = ""): Promise<{ revokeId: string; already: boolean }> {
    return this.serial(async () => {
      const cluster = this.requireCluster();
      const root = this.current.root;
      if (!root || root.root !== this.identity.memberId) {
        throw new RosterError("server-revoke-root-only", "only the revocation root can remove a server");
      }
      if (member === root.root) {
        throw new RosterError("cannot-revoke-root", "the revocation root cannot remove itself");
      }
      if (!this.current.servers.has(member)) {
        throw new RosterError("not-a-server", "no such server in this roster");
      }
      // Idempotent for the same member and cascade (or if already revoked with cascade, which covers non-cascading).
      const existing = this.current.countingRevokes.find((id) => {
        const body = this.stored.get(id)?.statement.body;
        return body?.type === "revoke" && body.member === member && (revokeCascades(body) === cascade || revokeCascades(body));
      });
      if (existing) return { revokeId: existing, already: true };
      // K8 (D66): record every joining Add signed by `member` that the root holds (sorted for deterministic canonical bytes).
      const seen = this.verified
        .filter((item) => item.body.type === "add" && item.body.cluster === cluster && item.body.by === member && addJoins(item.body))
        .map((item) => item.id)
        .sort();
      const cleanReason = reason.slice(0, 500);
      const revoke = await this.sign({
        type: "revoke",
        cluster,
        member,
        reason: cleanReason,
        by: this.identity.memberId,
        gen: root.gen,
        cascade,
        seen,
      });
      const info = this.current.members.get(member);
      await this.commit([revoke], cluster, [{
        act: "server.revoke",
        statement: revoke.id,
        by: this.identity.memberId,
        member,
        ...(info?.name ? { name: info.name } : {}),
        ...(cleanReason ? { reason: cleanReason } : {}),
      }]);
      return { revokeId: revoke.id, already: false };
    });
  }

  /**
   * Reroots the cluster onto this server from the recovery code (§4.8, D48, D62): allowed on any non-root server
   * (valid or not). Signs `Root{g+1, root: self, recoveryPub, keep, prev}` with the recovery key and, when
   * `oldRootLost` is true, signs `Revoke{oldRoot, gen: g+1, cascade: false, seen}` in one transaction; drops the
   * code and key immediately.
   */
  reroot(input: { code: string; oldRootLost: boolean; keep: string[] }): Promise<{ rootId: string; revokeId: string | null; gen: number }> {
    return this.serial(async () => {
      const cluster = this.cluster;
      const root = this.current.root;
      if (cluster === null || !root) throw new RosterError("no-cluster", "there is no cluster yet (it is made at the first pairing)");
      if (root.root === this.identity.memberId) throw new RosterError("already-root", "this server is already the revocation root");

      const keep = [...new Set(input.keep)].sort();
      if (keep.length > 1_000) throw new RosterError("bad-keep", "keep exceeds the maximum of 1000 revocations");
      // §4.8, D63: keep must be a subset of pending server revocations (excludes dropped and self-revocations).
      const candidates = new Set(this.keepCandidates().map((c) => c.revokeId));
      for (const id of keep) {
        if (!candidates.has(id)) {
          throw new RosterError("bad-keep", "keep may list only pending server revocations this server holds");
        }
      }

      if (!normalizeRecoveryCode(input.code)) throw new RosterError("bad-code", "the recovery code is malformed");
      const recovery = await recoveryKeyFromCode(input.code);
      try {
        if (recovery.recoveryPub !== root.recoveryPub) {
          throw new RosterError("bad-code", "the recovery code does not match this cluster");
        }
        const gen = root.gen + 1;
        const rootBody = RootStatement.parse({
          type: "root",
          cluster,
          gen,
          root: this.identity.memberId,
          recoveryPub: root.recoveryPub,
          keep,
          prev: root.id,
        });
        const rootStmt = await signStatement(rootBody, "recovery", signWith(recovery.privateKey));

        let revokeStmt: StoredStatement | null = null;
        if (input.oldRootLost) {
          const oldRoot = root.root;
          // D66: record every joining Add signed by the old root that this server holds; D62: never cascade.
          const seen = this.verified
            .filter((item) => item.body.type === "add" && item.body.cluster === cluster && item.body.by === oldRoot && addJoins(item.body))
            .map((item) => item.id)
            .sort();
          revokeStmt = await this.sign({
            type: "revoke",
            cluster,
            member: oldRoot,
            reason: "",
            by: this.identity.memberId,
            gen,
            cascade: false,
            seen,
          });
        }

        const fresh = revokeStmt ? [rootStmt, revokeStmt] : [rootStmt];
        const audits: Array<Omit<AuditBody, "at">> = [
          { act: "root.change", statement: rootStmt.id, by: "recovery", member: this.identity.memberId },
        ];
        if (revokeStmt) {
          const oldInfo = this.current.members.get(root.root);
          audits.push({
            act: "server.revoke",
            statement: revokeStmt.id,
            by: this.identity.memberId,
            member: root.root,
            ...(oldInfo?.name ? { name: oldInfo.name } : {}),
          });
        }
        await this.commit(fresh, cluster, audits);
        return { rootId: rootStmt.id, revokeId: revokeStmt?.id ?? null, gen };
      } finally {
        recovery.publicKey.fill(0);
      }
    });
  }

  /**
   * Begins replacing the recovery code on the current revocation root (§4.8, M4-12): verifies `oldCode` against the
   * current `recoveryPub`, creates a new recovery code (returned once, formatted), and holds only the pending public
   * key and non-extractable old signing handle in memory. Writes nothing until `confirmRecovery` succeeds.
   */
  replaceRecovery(oldCode: string): Promise<RecoveryReplaceStarted> {
    return this.serial(async () => {
      const cluster = this.cluster;
      const root = this.current.root;
      if (cluster === null || !root) throw new RosterError("no-cluster", "there is no cluster yet (it is made at the first pairing)");
      if (this.current.revoked.has(this.identity.memberId)) throw new RosterError("self-revoked", "this server was removed from the cluster");
      if (root.root !== this.identity.memberId) throw new RosterError("not-root", "only the revocation root can replace the recovery code");

      if (!normalizeRecoveryCode(oldCode)) throw new RosterError("bad-code", "the recovery code is malformed");
      const oldKey = await recoveryKeyFromCode(oldCode);
      try {
        if (oldKey.recoveryPub !== root.recoveryPub) {
          throw new RosterError("bad-code", "the recovery code does not match this cluster");
        }
        let rawCode = newRecoveryCode();
        let newKey = await recoveryKeyFromCode(rawCode);
        while (newKey.recoveryPub === root.recoveryPub) {
          newKey.publicKey.fill(0);
          rawCode = newRecoveryCode();
          newKey = await recoveryKeyFromCode(rawCode);
        }
        try {
          this.clearPendingReplace();
          const expiresAt = this.now() + RECOVERY_REPLACE_TTL_MS;
          const pending: PendingRecoveryReplace = {
            rootId: root.id,
            cluster,
            newRecoveryPub: newKey.recoveryPub,
            oldPrivateKey: oldKey.privateKey,
            expiresAt,
            timer: undefined as unknown as ReturnType<typeof setTimeout>,
          };
          pending.timer = setTimeout(() => {
            if (this.pendingReplace === pending) this.clearPendingReplace();
          }, RECOVERY_REPLACE_TTL_MS);
          pending.timer.unref?.();
          this.pendingReplace = pending;
          return { code: formatRecoveryCode(rawCode), clusterId: cluster, expiresAt };
        } finally {
          newKey.publicKey.fill(0);
        }
      } finally {
        oldKey.publicKey.fill(0);
      }
    });
  }
  // Moved to store-merge.ts (M7-S90): the merge / join / recovery half and the act pipeline.
  confirmRecovery(typed: string): Promise<RecoveryConfirmResult> { return this.merger.confirmRecovery(typed); }
  cancelRecoveryReplace(): void { this.merger.cancelRecoveryReplace(); }
  merge(statements: readonly SignedStatement[]): Promise<string[]> { return this.merger.merge(statements); }
  addServer(input: Parameters<RosterMerge["addServer"]>[0]) { return this.merger.addServer(input); }
  joinCluster(input: Parameters<RosterMerge["joinCluster"]>[0]) { return this.merger.joinCluster(input); }
  writeProfile(member: string, field: ProfileField, value: string): Promise<SignedStatement | null> { return this.merger.writeProfile(member, field, value); }
  revocations(): Array<{ id: string; statement: SignedStatement }> { return this.merger.revocations(); }
  mergeRevocations(statements: readonly unknown[]): Promise<string[]> { return this.merger.mergeRevocations(statements); }
  mergeGossip(statements: readonly unknown[], limit?: number): Promise<{ fresh: string[]; refused: string[] }> { return this.merger.mergeGossip(statements, limit); }
  gossipStatements(): StoredStatement[] { return this.merger.gossipStatements(); }
  statementsById(ids: Iterable<string>): StoredStatement[] { return this.merger.statementsById(ids); }
  profile(member: string, field: ProfileField): string | null { return this.merger.profile(member, field); }
  pushSubscription(member: string): PushSubscription | null { return this.merger.pushSubscription(member); }
  pushSubscriptions(): Array<{ device: string; subscription: PushSubscription }> { return this.merger.pushSubscriptions(); }
}

/** The audit rows (newest first), for `botlingd devices` and tests. */
export function readAudits(db: Db, limit = 200): AuditBody[] {
  const serverId = db.prepare("SELECT value FROM meta WHERE key = 'serverId'").get();
  if (!serverId) return [];
  return db.prepare("SELECT body FROM rows WHERE stream = ? AND key LIKE 'audit:%' ORDER BY rev DESC LIMIT ?").all(`srv:${String(serverId.value)}`, limit)
    .map((row) => JSON.parse(String(row.body)) as AuditBody);
}
