// Roster validity (protocol v1 §4.2) and the root chain (§4.8, D46, D48): a pure, synchronous function of the
// evaluating server, its cluster id and a set of statements whose signatures were already checked (verify.ts).
// Written for N servers, used with one in M2. Nothing here depends on the order of the set: every result is a
// least fixpoint or a minimum over it, and duplicates (same id) collapse.
//
// Rules, as implemented (each named in the comments below):
//  R1 cluster: a statement counts only when its `cluster` is the evaluating server's cluster.
//  R2 root chain: `Root{1}` counts when it is signed by its own `recoveryPub` and the cluster id is derived from that
//     key (§3), so a Root{1} with another recovery key belongs to no member's cluster. `Root{g+1}` counts when its
//     `prev` is the current `Root{g}` and it is signed by the recovery key named there. Of several counting Roots of
//     one gen, the smallest id wins. The current root R is the end of that chain.
//  R3 known servers ("a server the set knows"): the evaluating server, the `root` of every Root signed by a recovery
//     key of this cluster (gen 1 bound to the cluster id, later gens signed by a key such a Root names), and, as a
//     least fixpoint, the member of every `Add{kind: server}` whose `by` is a known server. An Add signed by a device
//     or by a stranger names no server, so devices' signatures never count for Add (and so never for Revoke).
//  R4 counts(revoke):
//     - device clause: `by` is a known server. It marks `member` as a revoked DEVICE whatever else the set says, and
//       never depends on the root, so it only grows with the set (R3 only grows): a revoked device is never valid as
//       a device again.
//     - root clause (§4.2, D46): `member` is a known server, `member ≠ R.root`, and either `by = R.root ∧ gen = R.gen`,
//       or its id is in `R.keep` and it was signed by the chain's root of its own earlier gen (`keep` holds "the server
//       revocations signed by earlier roots", §4.8; anything else listed there does not count). It removes the member
//       whatever its kind; with `cascade: true` (D61) also every member of Cascade(member) (never R.root): the least
//       fixpoint over joining Adds (D60, `joined` true or absent on a device Add) signed by member or by one already in it.
//  R5 Revoked = root-revoked ∪ (device-revoked members that are not known servers).
//  R6 valid_T(m): least fixpoint from T (T valid unless root-revoked). An Add or Endorse for m by a known server that
//     is itself valid makes m valid when m is not root-revoked and, for a device Add, m is not a known server and not
//     device-revoked. An Endorse counts only with the Add it names, and only when that Add's `by` is a known server (the Add
//     carries the keys and the kind; an "Add" a device signed is no Add, even when a server endorses it).
// An id named both as a device and as a server (only a known server can sign such Adds) is judged as a server: a
// device revoke cannot remove a machine (only the root can, D46), and the id is never valid as a device again once
// device-revoked; it can come back only as a server, through a server Add, which is the same power as adding any new
// server (and is removed with that server by a cascading revoke, since its server Add joined it).
import { addJoins, revokeCascades, type DeviceScope, type StatementBody } from "../../protocol";

type Add = Extract<StatementBody, { type: "add" }>;
type Endorse = Extract<StatementBody, { type: "endorse" }>;
type Revoke = Extract<StatementBody, { type: "revoke" }>;
type Root = Extract<StatementBody, { type: "root" }>;

/**
 * A statement whose signature verify.ts checked: for a member-signed kind against the signer's key (taken from an Add
 * whose member id is the hash of that key, or the evaluating server's own key); for a Root against `recoveryKey`.
 */
export interface VerifiedStatement {
  id: string;
  body: StatementBody;
  /** A member id, or "recovery" for a Root. */
  signer: string;
  /** Root only: the recovery public key (base64url) the signature verified with. */
  recoveryKey?: string;
  /** Root only: the cluster id derived from `recoveryKey` (§3). */
  recoveryKeyCluster?: string;
  /** Local receipt time (`roster.receivedAt`), when passed from the store. */
  receivedAt?: number;
}

export interface CurrentRoot {
  id: string;
  gen: number;
  root: string;
  recoveryPub: string;
  keep: ReadonlySet<string>;
}

export interface MemberInfo {
  member: string;
  kind: "server" | "device";
  keys: { sign: string; dh: string };
  name: string;
  /** A device's scopes (from its newest counting Add). */
  scope?: readonly DeviceScope[];
  /** The id of the Add this info is taken from. */
  addId: string;
  by: string;
  at: number;
}

/** A server revocation from an earlier root that did not carry over across a reroot (D63, §4.8). */
export interface DroppedRow {
  revokeId: string;
  member: string;
  signer: string;
  gen: number;
  receivedAt: number | null;
  why: "left-out" | "arrived-after";
}

export interface RosterView {
  self: string;
  cluster: string | null;
  root: CurrentRoot | null;
  /** R3. */
  servers: ReadonlySet<string>;
  /** R5 (a device-revoked id that is a known server is not in here: it is judged as a server). */
  revoked: ReadonlySet<string>;
  /** R6. */
  valid: ReadonlySet<string>;
  /** Members named by an Add of this cluster whose `by` is a known server, valid or not. */
  members: ReadonlyMap<string, MemberInfo>;
  /** Ids of the counting revokes (R4), sorted. */
  countingRevokes: readonly string[];
  /** D63: earlier roots' server revocations that did not carry over across a reroot, sorted by revokeId. */
  dropped: readonly DroppedRow[];
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The validity of every member as `self` computes it from `statements` (§4.2). */
export function computeRoster(self: string, cluster: string | null, statements: Iterable<VerifiedStatement>): RosterView {
  // Duplicates collapse (§4.1); R1. One body (one id) may come signed by different keys (a Root body signed by the
  // recovery key and by a foreign one): each (id, key) is kept, so which copy arrived first never matters.
  const unique = new Map<string, VerifiedStatement>();
  for (const statement of statements) {
    const key = `${statement.id}\n${statement.recoveryKey ?? ""}`;
    if (cluster !== null && statement.body.cluster === cluster && !unique.has(key)) unique.set(key, statement);
  }
  const all = [...unique.values()].sort((a, b) => byId(a, b) || ((a.recoveryKey ?? "") < (b.recoveryKey ?? "") ? -1 : (a.recoveryKey ?? "") > (b.recoveryKey ?? "") ? 1 : 0));
  const of = <K extends StatementBody["type"]>(type: K) =>
    all.filter((s) => s.body.type === type) as Array<VerifiedStatement & { body: Extract<StatementBody, { type: K }> }>;
  const roots = of("root");
  const adds = of("add");
  const endorses = of("endorse");
  const revokes = of("revoke");

  // R2: the chain.
  const firstGen = (s: VerifiedStatement & { body: Root }) =>
    s.body.gen === 1 && s.body.prev === null && s.recoveryKey === s.body.recoveryPub && s.recoveryKeyCluster === cluster;
  let current = roots.find(firstGen) ?? null; // sorted by id: the first is the smallest
  const chainRoot = new Map<number, string>(); // gen → the root the chain names at that gen
  if (current) chainRoot.set(1, current.body.root);
  for (let guard = 0; current && guard < 100_000; guard++) {
    const head = current;
    const next = roots.find((s) => s.body.gen === head.body.gen + 1 && s.body.prev === head.id && s.recoveryKey === head.body.recoveryPub);
    if (!next) break;
    current = next;
    chainRoot.set(next.body.gen, next.body.root);
  }
  const root: CurrentRoot | null = current
    ? { id: current.id, gen: current.body.gen, root: current.body.root, recoveryPub: current.body.recoveryPub, keep: new Set(current.body.keep) }
    : null;

  // R3: known servers.
  const servers = new Set<string>([self]);
  const rootKeys = new Set<string>();
  for (const s of roots) if (firstGen(s)) rootKeys.add(s.body.recoveryPub);
  for (let changed = true; changed;) {
    changed = false;
    for (const s of roots) {
      if (s.recoveryKey === undefined || !rootKeys.has(s.recoveryKey)) continue;
      if (!rootKeys.has(s.body.recoveryPub)) { rootKeys.add(s.body.recoveryPub); changed = true; }
    }
  }
  for (const s of roots) if (s.recoveryKey !== undefined && rootKeys.has(s.recoveryKey)) servers.add(s.body.root);
  for (let changed = true; changed;) {
    changed = false;
    for (const s of adds) {
      if (s.body.kind === "server" && servers.has(s.body.by) && !servers.has(s.body.member)) { servers.add(s.body.member); changed = true; }
    }
  }

  // R4, R5.
  const rootCounts = (r: Revoke, id: string): boolean => {
    if (!root || !servers.has(r.member) || r.member === root.root) return false;
    if (r.by === root.root && r.gen === root.gen) return true;
    return root.keep.has(id) && r.gen < root.gen && chainRoot.get(r.gen) === r.by;
  };
  const deviceRevoked = new Set<string>();
  const rootRevoked = new Set<string>();
  const countingRevokes: string[] = [];
  // K2 (D60, D61): Cascade(m), the least fixpoint over joining Adds (`joined`, absent on a device Add = true) by a known
  // server whose `by` is m or already in the set; never R.root. Computed here from this server's own set, so every
  // recompute (a joining Add signed or received later included) takes it in, and two servers with the same set agree.
  const joining = adds.filter((s) => servers.has(s.body.by) && addJoins(s.body)).map((s) => s.body);
  const cascadeOf = (member: string): Set<string> => {
    const set = new Set<string>([member]);
    for (let changed = true; changed;) {
      changed = false;
      for (const add of joining) {
        if (!set.has(add.by) || set.has(add.member) || (root && add.member === root.root)) continue;
        set.add(add.member);
        changed = true;
      }
    }
    set.delete(member);
    return set;
  };
  for (const s of revokes) {
    const device = servers.has(s.body.by);
    const byRoot = rootCounts(s.body, s.id);
    if (device) deviceRevoked.add(s.body.member);
    if (byRoot) {
      rootRevoked.add(s.body.member);
      if (revokeCascades(s.body)) for (const x of cascadeOf(s.body.member)) rootRevoked.add(x);
    }
    if (byRoot || (device && !servers.has(s.body.member))) countingRevokes.push(s.id);
  }
  const revoked = new Set<string>(rootRevoked);
  for (const member of deviceRevoked) if (!servers.has(member)) revoked.add(member);

  // R6: least fixpoint from self.
  const addIds = new Map<string, Add>();
  for (const s of adds) if (servers.has(s.body.by)) addIds.set(s.id, s.body); // an Add a device or stranger signed is no Add
  const vouchers: Array<{ member: string; by: string; kind: "server" | "device" }> = [
    ...adds.map((s) => ({ member: s.body.member, by: s.body.by, kind: s.body.kind })),
    ...endorses.flatMap((s) => {
      const add = addIds.get((s.body as Endorse).addId);
      return add && add.member === s.body.member ? [{ member: s.body.member, by: (s.body as Endorse).by, kind: add.kind }] : [];
    }),
  ];
  const admissible = (v: { member: string; kind: "server" | "device" }) =>
    !rootRevoked.has(v.member) && (v.kind === "server" ? servers.has(v.member) : !servers.has(v.member) && !deviceRevoked.has(v.member));
  const valid = new Set<string>();
  if (!rootRevoked.has(self)) valid.add(self);
  for (let changed = true; changed;) {
    changed = false;
    for (const v of vouchers) {
      if (valid.has(v.member) || !admissible(v)) continue;
      if (servers.has(v.by) && valid.has(v.by)) { valid.add(v.member); changed = true; }
    }
  }

  // Member info: the newest Add (by `at`, then smallest id) by a known server; a valid voucher is preferred.
  const members = new Map<string, MemberInfo>();
  for (const s of adds) {
    const add = s.body;
    if (!servers.has(add.by)) continue;
    const kind = servers.has(add.member) ? "server" : add.kind;
    const info: MemberInfo = {
      member: add.member, kind, keys: { ...add.keys }, name: add.name, addId: s.id, by: add.by, at: add.at,
      ...(add.scope ? { scope: [...add.scope] } : {}),
    };
    const seen = members.get(add.member);
    const better = !seen
      || (valid.has(add.by) && !valid.has(seen.by))
      || (valid.has(add.by) === valid.has(seen.by) && (add.at > seen.at || (add.at === seen.at && s.id < seen.addId)));
    if (better) members.set(add.member, info);
  }

  // D63: earlier roots' server revocations signed by the chain's root of their gen, not in the current `keep`, whose
  // target is still a valid server and is not the current root. Only strict `revoke.receivedAt < currentRoot.receivedAt`
  // is "left-out"; equal or missing receipt time is "arrived-after". Sorted by revokeId (`revokes` comes from `all`).
  const dropped: DroppedRow[] = [];
  if (current && root) {
    const rootAt = current.receivedAt;
    for (const s of revokes) {
      const r = s.body;
      if (r.gen >= root.gen || root.keep.has(s.id)) continue;
      if (chainRoot.get(r.gen) !== r.by || s.signer !== r.by) continue;
      if (!servers.has(r.member) || !valid.has(r.member) || r.member === root.root) continue;
      const why: DroppedRow["why"] =
        s.receivedAt !== undefined && rootAt !== undefined && s.receivedAt < rootAt ? "left-out" : "arrived-after";
      dropped.push({
        revokeId: s.id,
        member: r.member,
        signer: r.by,
        gen: r.gen,
        receivedAt: s.receivedAt ?? null,
        why,
      });
    }
  }

  return { self, cluster, root, servers, revoked, valid, members, countingRevokes, dropped };
}

/** A device's info when it is valid, else null (what a session asks on every frame, M2 step 4). */
export function validDevice(view: RosterView, member: string): MemberInfo | null {
  if (!view.valid.has(member)) return null;
  const info = view.members.get(member);
  return info && info.kind === "device" ? info : null;
}
