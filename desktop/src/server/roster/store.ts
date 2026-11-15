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
import { addJoins, clusterIdFromRecoveryKey, DEFAULT_DEVICE_SCOPE, DeviceScope, fromBase64Url, MemberKeys, memberIdFromKey, RevocationStatement, revokeCascades, RootStatement, rosterDigest, SignedStatement, statementId, type StatementBody } from "../../protocol";
import { normalizeRecoveryCode, recoveryKeyFromCode } from "../identity/recovery";
import type { Command, Db } from "../store";
import { computeRoster, validDevice, type DroppedRow, type MemberInfo, type RosterView, type VerifiedStatement } from "./validity";
import { parseStored, signStatement, signWith, storedBytes, verifySignature, verifyStatements, type StoredStatement } from "./verify";

export interface RosterBackend {
  submit<T>(command: Command<T>): Promise<T>;
  openReader(): Db;
}

/** What the roster needs of the server's identity (identity/keys.ts). */
export interface RosterIdentity {
  readonly memberId: string;
  readonly keys: { readonly sign: string; readonly dh: string };
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

export type RosterRefusal =
  | "no-cluster" | "cluster-exists" | "bad-root" | "self-revoked" | "bad-keys" | "revoked" | "not-a-device" | "server-revoke-root-only"
  | "cannot-revoke-root" | "not-a-server" | "bad-join" | "bad-code" | "already-root" | "bad-keep" | "not-dropped";

export class RosterError extends Error {
  constructor(readonly reason: RosterRefusal, message: string) { super(message); this.name = "RosterError"; }
}

export interface RosterChange {
  view: RosterView;
  /** Members valid before the change and not after it. */
  invalidated: string[];
}

export type AuditAct = "cluster.create" | "cluster.join" | "device.add" | "device.revoke" | "server.add" | "server.revoke" | "server.revoke.dropped" | "member.endorse" | "profile.write" | "statement.merge" | "root.change";

export interface AuditBody {
  act: AuditAct;
  at: number;
  statement: string;
  by: string;
  member?: string;
  name?: string;
  reason?: string;
}

export interface RosterStoreOptions {
  now?: () => number;
  log?: (line: string) => void;
}

/** A pending server revocation offered for `keep` at reroot (§4.8). */
export interface KeepCandidate {
  revokeId: string;
  member: string;
  signer: string;
  gen: number;
  receivedAt: number | null;
}

const memberOf = (body: StatementBody) => (body.type === "root" ? body.root : body.member);

/** The most statements one gossip set (`roster.statements` chunks up to the short last one) may carry. */
export const MAX_GOSSIP_SET = 20_000;

/**
 * Whether gossip stores a verified statement (§4.7, M3 step 5): see `RosterStore.mergeGossip`. A Root reaching here
 * already passed the chain-key check. Every clause only grows with the set.
 */
export function gossipKeeps(statement: VerifiedStatement, view: RosterView): boolean {
  const body = statement.body;
  switch (body.type) {
    case "root": return true;
    case "add": case "endorse": case "revoke": return view.servers.has(body.by) && statement.signer === body.by;
    case "profile": {
      const signer = statement.signer;
      if (view.servers.has(signer)) return true;
      return signer === body.member && (signer === view.self || view.members.has(signer));
    }
    default: return false;
  }
}

export class RosterStore {
  private stored = new Map<string, StoredStatement>();
  private verified: VerifiedStatement[] = [];
  private current: RosterView;
  private cluster: string | null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(change: RosterChange) => void>();
  private readonly now: () => number;
  private gossipCache: { view: RosterView; items: StoredStatement[] } | null = null;
  private readonly dismissed = new Set<string>();
  private readonly auditedDropped = new Set<string>();

  private constructor(private readonly backend: RosterBackend, private readonly identity: RosterIdentity, private readonly options: RosterStoreOptions, cluster: string | null) {
    this.now = options.now ?? Date.now;
    this.cluster = cluster;
    this.current = computeRoster(identity.memberId, cluster, []);
  }

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
      const verifiedById = new Map(this.verified.map((item) => [item.id, item]));
      for (const id of keep) {
        const item = verifiedById.get(id);
        if (!item || item.body.type !== "revoke" || !this.current.servers.has(item.body.member)) {
          throw new RosterError("bad-keep", "keep may list only server revocations this server holds");
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
  writeProfile(member: string, field: "name" | "icon" | "addresses", value: string): Promise<SignedStatement | null> {
    return this.serial(async () => {
      const cluster = this.requireCluster();
      if (this.profile(member, field) === value) return null;
      let ms = this.now();
      let c = 0;
      for (const { body } of this.verified) {
        if (body.type !== "profile" || body.member !== member || body.field !== field) continue;
        if (body.hlc.ms > ms || (body.hlc.ms === ms && body.hlc.c >= c)) { ms = body.hlc.ms; c = body.hlc.c + 1; }
      }
      const profile = await this.sign({ type: "profile", cluster, member, field, value: value.slice(0, 2_000), hlc: { ms, c: Math.min(c, 0xffff) } });
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
  profile(member: string, field: "name" | "icon" | "addresses"): string | null {
    let best: { value: string; ms: number; c: number; id: string } | null = null;
    for (const { id, body, signer } of this.verified) {
      if (body.type !== "profile" || body.member !== member || body.field !== field || body.cluster !== this.cluster) continue;
      if (signer !== member && !(this.current.servers.has(signer) && this.current.valid.has(signer))) continue;
      const { ms, c } = body.hlc;
      if (!best || ms > best.ms || (ms === best.ms && (c > best.c || (c === best.c && id < best.id)))) best = { value: body.value, ms, c, id };
    }
    return best?.value ?? null;
  }

  private self() {
    return { memberId: this.identity.memberId, signPub: this.identity.keys.sign };
  }

  private requireCluster(): string {
    if (this.cluster === null) throw new RosterError("no-cluster", "there is no cluster yet (it is made at the first pairing)");
    if (this.current.revoked.has(this.identity.memberId)) throw new RosterError("self-revoked", "this server was removed from the cluster");
    return this.cluster;
  }

  private sign(body: StatementBody): Promise<StoredStatement> {
    return signStatement(body, this.identity.memberId, (bytes) => this.identity.sign(bytes));
  }

  private serial<T>(act: () => Promise<T>): Promise<T> {
    const run = this.queue.then(act, act);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Stores `fresh` (and runs `extra` in the same transaction), then swaps the view. The new view is computed before
   * the commit and published right after it; then members this server should endorse are endorsed.
   */
  private async apply(fresh: StoredStatement[], cluster: string, audits: Array<Omit<AuditBody, "at">>, extra?: (tx: Db) => void): Promise<RosterView> {
    const view = await this.commit(fresh, cluster, audits, extra);
    const endorse = this.missingEndorsements(view);
    if (endorse.length) {
      const signed: StoredStatement[] = [];
      for (const info of endorse) signed.push(await this.sign({ type: "endorse", cluster, member: info.member, addId: info.addId, by: this.identity.memberId }));
      return this.commit(signed, cluster, signed.map((item, index) => ({ act: "member.endorse" as const, statement: item.id, by: this.identity.memberId, member: endorse[index].member })));
    }
    return view;
  }

  private async commit(fresh: StoredStatement[], cluster: string, audits: Array<Omit<AuditBody, "at">>, extra?: (tx: Db) => void): Promise<RosterView> {
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
function droppedAuditsFor(view: RosterView, audited: ReadonlySet<string>): Array<Omit<AuditBody, "at">> {
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

function writeAudits(tx: Db, audits: AuditBody[]): void {
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

/** The audit rows (newest first), for `botlingd devices` and tests. */
export function readAudits(db: Db, limit = 200): AuditBody[] {
  const serverId = db.prepare("SELECT value FROM meta WHERE key = 'serverId'").get();
  if (!serverId) return [];
  return db.prepare("SELECT body FROM rows WHERE stream = ? AND key LIKE 'audit:%' ORDER BY rev DESC LIMIT ?").all(`srv:${String(serverId.value)}`, limit)
    .map((row) => JSON.parse(String(row.body)) as AuditBody);
}
