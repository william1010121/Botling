// Botling 3 M4-09: `keepCandidates()` and `RosterView.dropped` (D63, §4.8).
// - Uses local receipt time `receivedAt: number | null` (no `at` field on RevokeStatement).
// - `DroppedRow`: `{ revokeId, member, signer, gen, receivedAt, why: "left-out" | "arrived-after" }`.
// - `"left-out"` iff `revoke.receivedAt < currentRoot.receivedAt` (strict `<`); equal or missing `receivedAt` -> `"arrived-after"`.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { memberIdFromKey, statementId, toBase64Url, type SignedStatement, type StatementBody } from "../../src/protocol";
import { bindServerIdentity, loadOrCreateServerIdentity } from "../../src/server/identity";
import { computeRoster, RosterStore, signStatement, signWith, verifyStatements, type DroppedRow, type StoredStatement, type VerifiedStatement } from "../../src/server/roster";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { testRoot } from "../botlingd-harness";

const rootDir = testRoot("roster-dropped");
afterAll(() => rmSync(rootDir, { recursive: true, force: true }));
const openStores: ServerStore[] = [];
afterEach(async () => { for (const store of openStores.splice(0)) await store.close(); });
let seq = 0;

async function makeServer(now: () => number) {
  const dir = join(rootDir, `srv-${++seq}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = await openServerStore(dir);
  openStores.push(store);
  const identity = await loadOrCreateServerIdentity(dir);
  await store.submit((tx) => bindServerIdentity(tx, identity));
  const roster = await RosterStore.open(store, identity, { now });
  return { dir, store, identity, roster };
}

async function makeRecovery() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pub = toBase64Url(raw);
  const { clusterIdFromRecoveryKey } = await import("../../src/protocol");
  return { pub, cluster: await clusterIdFromRecoveryKey(raw), signer: signWith(pair.privateKey) };
}

async function makeDevice() {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  return {
    member: await memberIdFromKey(raw),
    keys: { sign: toBase64Url(raw), dh: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", dh.publicKey))) },
  };
}

// Pure validity helpers (no Date.now(); explicit receivedAt).
const CLUSTER = "c".repeat(32);
const RECOVERY = "R".repeat(43);
const id = (name: string) => (name + "a".repeat(26)).slice(0, 26).toLowerCase().replace(/[^a-z2-7]/g, "a");
const KEYS = { sign: "S".repeat(42) + "A", dh: "D".repeat(42) + "A" };

async function v(body: StatementBody, signer: string, receivedAt?: number): Promise<VerifiedStatement> {
  return {
    id: await statementId(body),
    body,
    signer,
    ...(body.type === "root" ? { recoveryKey: RECOVERY, recoveryKeyCluster: CLUSTER } : {}),
    ...(receivedAt !== undefined ? { receivedAt } : {}),
  };
}

const serverAdd = (member: string, by: string, joined: boolean, at = 1): StatementBody =>
  ({ type: "add", cluster: CLUSTER, member, kind: "server", keys: KEYS, name: "S", by, at, joined });
const deviceAdd = (member: string, by: string, at = 1): StatementBody =>
  ({ type: "add", cluster: CLUSTER, member, kind: "device", keys: KEYS, name: "D", scope: ["read"], by, at });

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function pureClusterBase() {
  const [s1, s2, s3, s4, d] = ["sone", "stwo", "sthree", "sfour", "dphone"].map(id);
  const root1 = await v({ type: "root", cluster: CLUSTER, gen: 1, root: s1, recoveryPub: RECOVERY, keep: [], prev: null }, "recovery", 10);
  const set = [
    root1,
    await v(serverAdd(s2, s1, true), s1, 20), await v(serverAdd(s1, s2, false), s2, 21),
    await v(serverAdd(s3, s1, true), s1, 30), await v(serverAdd(s1, s3, false), s3, 31),
    await v(serverAdd(s4, s1, true), s1, 40), await v(serverAdd(s1, s4, false), s4, 41),
    await v(deviceAdd(d, s1), s1, 50),
  ];
  return { s1, s2, s3, s4, d, root1, set };
}

/** Sets up s1 (root), s2, s3, s4 and returns signed statements + explicit clock helper. */
async function storeScenario() {
  let clock = 100;
  const now = () => clock;
  const recovery = await makeRecovery();
  const s1 = await makeServer(now);
  const s2 = await makeServer(now);
  const s3 = await makeServer(now);
  const s4 = await makeServer(now);
  const cluster = recovery.cluster;
  const s1Id = s1.identity.memberId;
  const s2Id = s2.identity.memberId;
  const s3Id = s3.identity.memberId;
  const s4Id = s4.identity.memberId;

  const root1 = await signStatement({ type: "root", cluster, gen: 1, root: s1Id, recoveryPub: recovery.pub, keep: [], prev: null }, "recovery", recovery.signer);
  const addS2 = await signStatement({ type: "add", cluster, member: s2Id, kind: "server", keys: s2.identity.keys, name: "S2", by: s1Id, at: 10, joined: true }, s1Id, (b) => s1.identity.sign(b));
  const wbS1_2 = await signStatement({ type: "add", cluster, member: s1Id, kind: "server", keys: s1.identity.keys, name: "S1", by: s2Id, at: 11, joined: false }, s2Id, (b) => s2.identity.sign(b));
  const addS3 = await signStatement({ type: "add", cluster, member: s3Id, kind: "server", keys: s3.identity.keys, name: "S3", by: s1Id, at: 12, joined: true }, s1Id, (b) => s1.identity.sign(b));
  const wbS1_3 = await signStatement({ type: "add", cluster, member: s1Id, kind: "server", keys: s1.identity.keys, name: "S1", by: s3Id, at: 13, joined: false }, s3Id, (b) => s3.identity.sign(b));
  const addS4 = await signStatement({ type: "add", cluster, member: s4Id, kind: "server", keys: s4.identity.keys, name: "S4", by: s1Id, at: 14, joined: true }, s1Id, (b) => s1.identity.sign(b));
  const wbS1_4 = await signStatement({ type: "add", cluster, member: s1Id, kind: "server", keys: s1.identity.keys, name: "S1", by: s4Id, at: 15, joined: false }, s4Id, (b) => s4.identity.sign(b));

  await s1.roster.createCluster(root1, cluster);
  await s1.roster.merge([addS2.statement, wbS1_2.statement, addS3.statement, wbS1_3.statement, addS4.statement, wbS1_4.statement]);
  await s2.roster.joinCluster({
    add: addS2.statement,
    roster: [root1.statement, addS3.statement, wbS1_3.statement, addS4.statement, wbS1_4.statement],
    sponsor: { member: s1Id, keys: s1.identity.keys, name: "S1" },
  });

  return {
    recovery, cluster, s1, s2, s3, s4, s1Id, s2Id, s3Id, s4Id, root1,
    setClock: (t: number) => { clock = t; },
    now,
  };
}

describe("M4-09: keepCandidates() and RosterView.dropped", () => {
  it("1. kept revocation: reroot keeps s1's revocation of s4 -> no dropped row and s4 invalid", async () => {
    const { s1, s2, s4, root1, set } = await pureClusterBase();
    const revS4 = await v({ type: "revoke", cluster: CLUSTER, member: s4, reason: "retired", by: s1, gen: 1, cascade: false }, s1, 100);
    const root2 = await v({ type: "root", cluster: CLUSTER, gen: 2, root: s2, recoveryPub: RECOVERY, keep: [revS4.id], prev: root1.id }, "recovery", 200);

    const view = computeRoster(s2, CLUSTER, [...set, revS4, root2]);
    expect(view.dropped).toEqual([]);
    expect(view.valid.has(s4)).toBe(false);
    expect(view.revoked.has(s4)).toBe(true);
    expect(view.countingRevokes).toContain(revS4.id);
  });

  it("2. unticked (left-out): revS4.receivedAt < root2.receivedAt -> one 'left-out' row and s4 valid", async () => {
    const { s1, s2, s4, root1, set } = await pureClusterBase();
    const revS4 = await v({ type: "revoke", cluster: CLUSTER, member: s4, reason: "retired", by: s1, gen: 1, cascade: false }, s1, 100);
    const root2 = await v({ type: "root", cluster: CLUSTER, gen: 2, root: s2, recoveryPub: RECOVERY, keep: [], prev: root1.id }, "recovery", 200);

    const view = computeRoster(s2, CLUSTER, [...set, revS4, root2]);
    expect(view.valid.has(s4)).toBe(true);
    expect(view.revoked.has(s4)).toBe(false);
    const expected: DroppedRow[] = [{
      revokeId: revS4.id,
      member: s4,
      signer: s1,
      gen: 1,
      receivedAt: 100,
      why: "left-out",
    }];
    expect(view.dropped).toEqual(expected);

    // Zero timestamp (`receivedAt: 0`) must be preserved as `0`, not treated as missing/null.
    const revAtZero = await v({ type: "revoke", cluster: CLUSTER, member: s4, reason: "zero", by: s1, gen: 1, cascade: false }, s1, 0);
    const viewZero = computeRoster(s2, CLUSTER, [...set, revAtZero, root2]);
    expect(viewZero.dropped).toEqual([{
      revokeId: revAtZero.id,
      member: s4,
      signer: s1,
      gen: 1,
      receivedAt: 0,
      why: "left-out",
    }]);
  });

  it("3. arrived after, equal timestamp, and missing receivedAt -> 'arrived-after'", async () => {
    const { s1, s2, s4, root1, set } = await pureClusterBase();
    const revBody: StatementBody = { type: "revoke", cluster: CLUSTER, member: s4, reason: "retired", by: s1, gen: 1, cascade: false };
    const root2Body: StatementBody = { type: "root", cluster: CLUSTER, gen: 2, root: s2, recoveryPub: RECOVERY, keep: [], prev: root1.id };

    // Arrived strictly after Root{2}: 300 > 200 -> "arrived-after"
    const revAfter = await v(revBody, s1, 300);
    const root2 = await v(root2Body, "recovery", 200);
    const viewAfter = computeRoster(s2, CLUSTER, [...set, revAfter, root2]);
    expect(viewAfter.valid.has(s4)).toBe(true);
    expect(viewAfter.dropped).toEqual([{
      revokeId: revAfter.id,
      member: s4,
      signer: s1,
      gen: 1,
      receivedAt: 300,
      why: "arrived-after",
    }]);

    // Equal timestamp: 200 === 200 -> "arrived-after" (strict < required for "left-out")
    const revEqual = await v(revBody, s1, 200);
    const viewEqual = computeRoster(s2, CLUSTER, [...set, revEqual, root2]);
    expect(viewEqual.dropped).toEqual([{
      revokeId: revEqual.id,
      member: s4,
      signer: s1,
      gen: 1,
      receivedAt: 200,
      why: "arrived-after",
    }]);

    // Missing receivedAt on revoke (root has 200) -> receivedAt: null, why: "arrived-after"
    const revNoTime = await v(revBody, s1);
    const viewNoRevTime = computeRoster(s2, CLUSTER, [...set, revNoTime, root2]);
    expect(viewNoRevTime.dropped).toEqual([{
      revokeId: revNoTime.id,
      member: s4,
      signer: s1,
      gen: 1,
      receivedAt: null,
      why: "arrived-after",
    }]);

    // Missing receivedAt on root2 (revoke has 100) -> receivedAt: 100, why: "arrived-after"
    const revBefore = await v(revBody, s1, 100);
    const root2NoTime = await v(root2Body, "recovery");
    const viewNoRootTime = computeRoster(s2, CLUSTER, [...set, revBefore, root2NoTime]);
    expect(viewNoRootTime.dropped).toEqual([{
      revokeId: revBefore.id,
      member: s4,
      signer: s1,
      gen: 1,
      receivedAt: 100,
      why: "arrived-after",
    }]);

    // Missing receivedAt on both -> receivedAt: null, why: "arrived-after"
    const viewNeitherTime = computeRoster(s2, CLUSTER, [...set, revNoTime, root2NoTime]);
    expect(viewNeitherTime.dropped).toEqual([{
      revokeId: revNoTime.id,
      member: s4,
      signer: s1,
      gen: 1,
      receivedAt: null,
      why: "arrived-after",
    }]);
  });

  it("4. dropped row disappears when s4 is revoked again at current gen, is no longer valid, or is the current root", async () => {
    const { s1, s2, s3, s4, root1, set } = await pureClusterBase();
    const revS4Gen1 = await v({ type: "revoke", cluster: CLUSTER, member: s4, reason: "old", by: s1, gen: 1, cascade: false }, s1, 100);
    const root2 = await v({ type: "root", cluster: CLUSTER, gen: 2, root: s2, recoveryPub: RECOVERY, keep: [], prev: root1.id }, "recovery", 200);

    // Baseline: dropped has 1 row.
    expect(computeRoster(s2, CLUSTER, [...set, revS4Gen1, root2]).dropped).toHaveLength(1);

    // (a) Revoked again by current root at gen 2 -> disappears.
    const revS4Gen2 = await v({ type: "revoke", cluster: CLUSTER, member: s4, reason: "again", by: s2, gen: 2, cascade: false }, s2, 300);
    const viewAgain = computeRoster(s2, CLUSTER, [...set, revS4Gen1, root2, revS4Gen2]);
    expect(viewAgain.valid.has(s4)).toBe(false);
    expect(viewAgain.dropped).toEqual([]);

    // (b) s4 is no longer a valid server (cascaded via s3): s4 added only by s3, and s2 revokes s3 with cascade: true.
    const s4ViaS3 = [
      root1,
      await v(serverAdd(s2, s1, true), s1, 20), await v(serverAdd(s1, s2, false), s2, 21),
      await v(serverAdd(s3, s1, true), s1, 30), await v(serverAdd(s1, s3, false), s3, 31),
      await v(serverAdd(s4, s3, true), s3, 40),
      revS4Gen1,
      root2,
    ];
    expect(computeRoster(s2, CLUSTER, s4ViaS3).dropped).toHaveLength(1);
    const revS3Cascade = await v({ type: "revoke", cluster: CLUSTER, member: s3, reason: "gone", by: s2, gen: 2, cascade: true }, s2, 300);
    const viewCascade = computeRoster(s2, CLUSTER, [...s4ViaS3, revS3Cascade]);
    expect(viewCascade.valid.has(s4)).toBe(false);
    expect(viewCascade.dropped).toEqual([]);

    // (c) Revocation against the current root itself (`r.member === root.root`) never appears in dropped.
    const revS2Gen1 = await v({ type: "revoke", cluster: CLUSTER, member: s2, reason: "old", by: s1, gen: 1, cascade: false }, s1, 100);
    const viewSelfRoot = computeRoster(s2, CLUSTER, [...set, revS2Gen1, root2]);
    expect(viewSelfRoot.valid.has(s2)).toBe(true);
    expect(viewSelfRoot.dropped).toEqual([]);
  });

  it("5. keepCandidates() lists counting server revocations with receivedAt, never against this server itself, and persists across open()", async () => {
    const sc = await storeScenario();
    const { recovery, cluster, s1, s2, s1Id, s2Id, s3Id, s4Id, root1, setClock, now } = sc;

    // s1 revokes s2 (self on s2) and s4 at gen 1; s3 (non-root) signs an unauthorized revoke of s3/s4.
    const revS2 = await signStatement({ type: "revoke", cluster, member: s2Id, reason: "self", by: s1Id, gen: 1, cascade: false }, s1Id, (b) => s1.identity.sign(b));
    const revS4 = await signStatement({ type: "revoke", cluster, member: s4Id, reason: "retired", by: s1Id, gen: 1, cascade: false }, s1Id, (b) => s1.identity.sign(b));
    const nonRootRev = await signStatement({ type: "revoke", cluster, member: s4Id, reason: "rogue", by: s3Id, gen: 1, cascade: false }, s3Id, (b) => sc.s3.identity.sign(b));

    setClock(500);
    await s2.roster.merge([revS2.statement, revS4.statement, nonRootRev.statement]);

    const candidates = s2.roster.keepCandidates();
    expect(candidates).toEqual([{
      revokeId: revS4.id,
      member: s4Id,
      signer: s1Id,
      gen: 1,
      receivedAt: 500,
    }]);

    // Reopening from SQLite reads `receivedAt` from `roster` table.
    const reopened = await RosterStore.open(s2.store, s2.identity, { now });
    expect(reopened.keepCandidates()).toEqual(candidates);

    // Reroot on s2 at t=700 leaving out revS4 (via mergeRevocations since s2 was self-revoked until Root{2} arrives) -> view.dropped shows "left-out" with receivedAt: 500, and persists across open().
    setClock(700);
    const root2 = await signStatement({ type: "root", cluster, gen: 2, root: s2Id, recoveryPub: recovery.pub, keep: [], prev: root1.id }, "recovery", recovery.signer);
    await s2.roster.mergeRevocations([root2.statement]);

    const expectedDropped: DroppedRow[] = [{
      revokeId: revS4.id,
      member: s4Id,
      signer: s1Id,
      gen: 1,
      receivedAt: 500,
      why: "left-out",
    }];
    expect(s2.roster.view.dropped).toEqual(expectedDropped);

    const reopenedAfterReroot = await RosterStore.open(s2.store, s2.identity, { now });
    expect(reopenedAfterReroot.view.dropped).toEqual(expectedDropped);

    // An already-dropped revocation (not in Root{2}.keep) must NOT reappear in keepCandidates() for a gen 3 reroot.
    expect(reopenedAfterReroot.keepCandidates()).toEqual([]);

    // And a revocation arriving after Root{2} (t=900) shows "arrived-after" in RosterStore as well.
    const revS3 = await signStatement({ type: "revoke", cluster, member: s3Id, reason: "late", by: s1Id, gen: 1, cascade: false }, s1Id, (b) => s1.identity.sign(b));
    setClock(900);
    await reopenedAfterReroot.merge([revS3.statement]);
    expect(reopenedAfterReroot.view.dropped.find((row) => row.revokeId === revS3.id)).toEqual({
      revokeId: revS3.id,
      member: s3Id,
      signer: s1Id,
      gen: 1,
      receivedAt: 900,
      why: "arrived-after",
    });
  });

  it("6. device revocations are never in keepCandidates() or RosterView.dropped (even when signed by the root)", async () => {
    const sc = await storeScenario();
    const { recovery, cluster, s1, s2, s1Id, s2Id, root1, setClock, now } = sc;
    const phone = await makeDevice();
    const tablet = await makeDevice();

    // s1 (the root!) adds & revokes `phone`; s2 adds & revokes `tablet`.
    const addPhone = await signStatement({ type: "add", cluster, member: phone.member, kind: "device", keys: phone.keys, name: "Phone", scope: ["read"], by: s1Id, at: 20 }, s1Id, (b) => s1.identity.sign(b));
    const revPhone = await signStatement({ type: "revoke", cluster, member: phone.member, reason: "lost", by: s1Id, gen: 1, cascade: false }, s1Id, (b) => s1.identity.sign(b));
    const addTablet = await signStatement({ type: "add", cluster, member: tablet.member, kind: "device", keys: tablet.keys, name: "Tablet", scope: ["read"], by: s2Id, at: 21 }, s2Id, (b) => s2.identity.sign(b));
    const revTablet = await signStatement({ type: "revoke", cluster, member: tablet.member, reason: "lost", by: s2Id, gen: 1, cascade: false }, s2Id, (b) => s2.identity.sign(b));

    setClock(400);
    await s2.roster.merge([addPhone.statement, revPhone.statement, addTablet.statement, revTablet.statement]);
    expect(s2.roster.keepCandidates()).toEqual([]);

    setClock(600);
    const root2 = await signStatement({ type: "root", cluster, gen: 2, root: s2Id, recoveryPub: recovery.pub, keep: [], prev: root1.id }, "recovery", recovery.signer);
    await s2.roster.merge([root2.statement]);
    expect(s2.roster.view.dropped).toEqual([]);
    expect(s2.roster.view.revoked.has(phone.member)).toBe(true);
    expect(s2.roster.view.revoked.has(tablet.member)).toBe(true);

    // Also in pure computeRoster:
    const pure = await pureClusterBase();
    const pureRevDevice = await v({ type: "revoke", cluster: CLUSTER, member: pure.d, reason: "lost", by: pure.s1, gen: 1, cascade: false }, pure.s1, 55);
    const pureRoot2 = await v({ type: "root", cluster: CLUSTER, gen: 2, root: pure.s2, recoveryPub: RECOVERY, keep: [], prev: pure.root1.id }, "recovery", 200);
    const pureView = computeRoster(pure.s2, CLUSTER, [...pure.set, pureRevDevice, pureRoot2]);
    expect(pureView.dropped).toEqual([]);

    // Sanity check: reopened RosterStore still sees empty dropped.
    const reopened = await RosterStore.open(s2.store, s2.identity, { now });
    expect(reopened.view.dropped).toEqual([]);
  });

  it("7. the same statements in another order give the exact same dropped rows and keepCandidates()", async () => {
    const { s1, s2, s3, s4, d, root1, set } = await pureClusterBase();
    const revS4Left = await v({ type: "revoke", cluster: CLUSTER, member: s4, reason: "left", by: s1, gen: 1, cascade: false }, s1, 100);
    const revS3After = await v({ type: "revoke", cluster: CLUSTER, member: s3, reason: "after", by: s1, gen: 1, cascade: false }, s1, 300);
    const revS4Equal = await v({ type: "revoke", cluster: CLUSTER, member: s4, reason: "equal", by: s1, gen: 1, cascade: false }, s1, 200);
    const revDevice = await v({ type: "revoke", cluster: CLUSTER, member: d, reason: "dev", by: s1, gen: 1, cascade: false }, s1, 100);
    const root2 = await v({ type: "root", cluster: CLUSTER, gen: 2, root: s2, recoveryPub: RECOVERY, keep: [], prev: root1.id }, "recovery", 200);

    const all = [...set, revS4Left, revS3After, revS4Equal, revDevice, root2];
    const baseline = computeRoster(s2, CLUSTER, all);
    expect(baseline.dropped).toHaveLength(3);

    for (const ordered of [[...all].reverse(), ...Array.from({ length: 15 }, (_, i) => shuffled(all, i + 1))]) {
      const view = computeRoster(s2, CLUSTER, ordered);
      expect(view.dropped).toEqual(baseline.dropped);
      expect([...view.valid].sort()).toEqual([...baseline.valid].sort());
    }

    // Also test verifyStatements -> computeRoster preserves receivedAt across shuffled StoredStatements.
    const sc = await storeScenario();
    const rev1 = await signStatement({ type: "revoke", cluster: sc.cluster, member: sc.s3Id, reason: "r1", by: sc.s1Id, gen: 1, cascade: false }, sc.s1Id, (b) => sc.s1.identity.sign(b));
    const rev2 = await signStatement({ type: "revoke", cluster: sc.cluster, member: sc.s4Id, reason: "r2", by: sc.s1Id, gen: 1, cascade: false }, sc.s1Id, (b) => sc.s1.identity.sign(b));
    const r2 = await signStatement({ type: "root", cluster: sc.cluster, gen: 2, root: sc.s2Id, recoveryPub: sc.recovery.pub, keep: [], prev: sc.root1.id }, "recovery", sc.recovery.signer);
    const storedSet: StoredStatement[] = [
      ...sc.s2.roster.statements().map((item, idx) => ({ ...item, receivedAt: 10 + idx })),
      { ...rev1, receivedAt: 100 },
      { ...rev2, receivedAt: 300 },
      { ...r2, receivedAt: 200 },
    ];
    const self = { memberId: sc.s2Id, signPub: sc.s2.identity.keys.sign };
    const verifiedBase = computeRoster(sc.s2Id, sc.cluster, await verifyStatements(storedSet, self));
    expect(verifiedBase.dropped.map((r) => ({ id: r.revokeId, why: r.why })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: rev1.id, why: "left-out" as const },
      { id: rev2.id, why: "arrived-after" as const },
    ].sort((a, b) => a.id.localeCompare(b.id)));

    for (let i = 1; i <= 10; i++) {
      const reordered = shuffled(storedSet, i * 17);
      const view = computeRoster(sc.s2Id, sc.cluster, await verifyStatements(reordered, self));
      expect(view.dropped).toEqual(verifiedBase.dropped);
    }

    // Also test RosterStore.keepCandidates() order-independence across different merge orders.
    const dirA = join(rootDir, `srv-${++seq}`);
    const dirB = join(rootDir, `srv-${++seq}`);
    mkdirSync(dirA, { recursive: true, mode: 0o700 });
    mkdirSync(dirB, { recursive: true, mode: 0o700 });
    const dbA = await openServerStore(dirA);
    const dbB = await openServerStore(dirB);
    openStores.push(dbA, dbB);
    await dbA.submit((tx) => bindServerIdentity(tx, sc.s1.identity));
    await dbB.submit((tx) => bindServerIdentity(tx, sc.s1.identity));
    const rA = await RosterStore.open(dbA, sc.s1.identity, { now: () => 100 });
    const rB = await RosterStore.open(dbB, sc.s1.identity, { now: () => 100 });
    const baseStmts = sc.s1.roster.statements().filter((x) => x.id !== sc.root1.id).map((x) => x.statement);
    await rA.createCluster(sc.root1, sc.cluster);
    await rB.createCluster(sc.root1, sc.cluster);
    const bundle: SignedStatement[] = [...baseStmts, rev1.statement, rev2.statement];
    await rA.merge(bundle);
    await rB.merge([...bundle].reverse());
    expect(rA.keepCandidates()).toEqual(rB.keepCandidates());
    expect(rA.keepCandidates()).toHaveLength(2);
  });
});
