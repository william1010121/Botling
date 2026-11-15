// Botling 3 M3 step 4: the roster model fixes K1–K3 and K12 (plan-change-roster-fixes.md, D60, D61, pending D66), and
// the roster acts server pairing uses (`addServer`, `joinCluster`, `writeProfile`).
// - K1 `Add.joined`: a server Add without it is refused at parse; a device Add keeps its bytes and id (no field added);
// - K2 `Cascade(m)` computed from joining Adds: CascadeFollowsJoins (s1 → s2 → s3 → phone d; the root revokes s3 with
//   cascade: s3 and d invalid everywhere, s2 valid) and RogueContained (s3, already revoked, signs a joining Add{d2};
//   s1 endorses d2; d2 is invalid wherever the revocation is held), order-independent;
// - K3 `Revoke.cascade` boolean (or M2's `[]`): `[]` verifies with the same id and counts as false; a list is refused;
// - K10: a device revocation signed by a server that is later removed still counts (D61, pending D66 part 4);
// - K12: a Profile signed by a revoked server never wins over the member's own, however new;
// - joinCluster: the joining server takes the cluster, writes `Add{S, joined: false}`, endorses every valid member;
//   refused when it already has a cluster or the welcome does not name it.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AddStatement, memberIdFromKey, RevokeStatement, SignedStatement, statementId, toBase64Url, type StatementBody } from "../../src/protocol";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { computeRoster, RosterStore, signStatement, signWith, verifyStatements, type StoredStatement, type VerifiedStatement } from "../../src/server/roster";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { testRoot } from "../botlingd-harness";

const root = testRoot("roster-fixes");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const open: ServerStore[] = [];
afterEach(async () => { for (const store of open.splice(0)) await store.close(); });
let n = 0;

async function server() {
  const dir = join(root, `d${++n}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = await openServerStore(dir);
  open.push(store);
  const identity = await loadOrCreateServerIdentity(dir);
  await store.submit((tx) => bindServerIdentity(tx, identity));
  const roster = await RosterStore.open(store, identity);
  return { dir, store, identity, roster, setup: new ClusterSetup(roster) };
}

async function withCluster() {
  const s = await server();
  const started = await s.setup.begin();
  expect((await s.setup.confirm(started.code)).ok).toBe(true);
  return { ...s, clusterId: started.clusterId };
}

async function memberKeys() {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  const keys = { sign: toBase64Url(signPub), dh: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", dh.publicKey))) };
  return { keys, member: await memberIdFromKey(signPub), signer: signWith(sign.privateKey) };
}

// A pure model world for computeRoster (validity only reads ids, bodies and who signed).
const CLUSTER = "c".repeat(32);
const RECOVERY = "R".repeat(43);
const id = (name: string) => (name + "a".repeat(26)).slice(0, 26).toLowerCase().replace(/[^a-z2-7]/g, "a");
const KEYS = { sign: "S".repeat(42) + "A", dh: "D".repeat(42) + "A" };
async function v(body: StatementBody, signer: string): Promise<VerifiedStatement> {
  return { id: await statementId(body), body, signer, ...(body.type === "root" ? { recoveryKey: RECOVERY, recoveryKeyCluster: CLUSTER } : {}) };
}
const serverAdd = (member: string, by: string, joined: boolean, at = 1): StatementBody => ({ type: "add", cluster: CLUSTER, member, kind: "server", keys: KEYS, name: "S", by, at, joined });
const deviceAdd = (member: string, by: string, at = 1): StatementBody => ({ type: "add", cluster: CLUSTER, member, kind: "device", keys: KEYS, name: "D", scope: ["read"], by, at });

/** s1 (root) → s2 → s3 → phone d, each server joined through the one before (with its write-back Add). */
async function chain() {
  const [s1, s2, s3, d] = ["sone", "stwo", "sthree", "dphone"].map(id);
  const rootBody: StatementBody = { type: "root", cluster: CLUSTER, gen: 1, root: s1, recoveryPub: RECOVERY, keep: [], prev: null };
  const set = [
    await v(rootBody, "recovery"),
    await v(serverAdd(s2, s1, true), s1), await v(serverAdd(s1, s2, false), s2),
    await v(serverAdd(s3, s2, true), s2), await v(serverAdd(s2, s3, false), s3),
    await v(deviceAdd(d, s3), s3),
  ];
  return { s1, s2, s3, d, set };
}

function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) { state = (state * 1103515245 + 12345) >>> 0; const j = state % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

describe("K1: Add.joined (D60)", () => {
  it("a server Add without joined is refused at parse; with it, accepted", () => {
    const base = { type: "add", cluster: CLUSTER, member: id("stwo"), kind: "server", keys: KEYS, name: "S", by: id("sone"), at: 1 };
    expect(AddStatement.safeParse(base).success).toBe(false);
    expect(AddStatement.safeParse({ ...base, joined: true }).success).toBe(true);
    expect(AddStatement.safeParse({ ...base, joined: false }).success).toBe(true);
  });

  it("a device Add as M2 stored it (no joined) parses unchanged and keeps its id and signature", async () => {
    const phone = await memberKeys();
    const s = await withCluster();
    const body = { type: "add" as const, cluster: s.clusterId, member: phone.member, kind: "device" as const, keys: phone.keys, name: "Phone", scope: ["read" as const], by: s.identity.memberId, at: 5 };
    const signed = await signStatement(body, s.identity.memberId, (b) => s.identity.sign(b));
    const parsed = SignedStatement.parse(JSON.parse(JSON.stringify(signed.statement)));
    expect("joined" in parsed.body).toBe(false);
    expect(await statementId(parsed.body)).toBe(signed.id);
    const verified = await verifyStatements([{ id: signed.id, statement: parsed }], { memberId: s.identity.memberId, signPub: s.identity.keys.sign });
    expect(verified.map((item) => item.id)).toEqual([signed.id]);
    // The roster's own device Adds leave the field out.
    const added = await s.roster.addDevice({ keys: (await memberKeys()).keys, name: "Tablet" });
    const stored = s.roster.statements().find((item) => item.id === added.addId)!;
    expect("joined" in stored.statement.body).toBe(false);
  });
});

describe("K2: Cascade(m) from joining Adds (D60, D61)", () => {
  it("CascadeFollowsJoins: the root revokes s3 with cascade; s3 and its phone go on every server, s2 stays", async () => {
    const { s1, s2, s3, d, set } = await chain();
    const revoke = await v({ type: "revoke", cluster: CLUSTER, member: s3, reason: "", by: s1, gen: 1, cascade: true }, s1);
    for (const self of [s1, s2]) {
      const before = computeRoster(self, CLUSTER, set);
      expect([s1, s2, s3, d].every((m) => before.valid.has(m))).toBe(true);
      const view = computeRoster(self, CLUSTER, [...set, revoke]);
      expect(view.valid.has(s3)).toBe(false);
      expect(view.valid.has(d)).toBe(false);
      expect(view.valid.has(s2)).toBe(true);
      expect(view.valid.has(s1)).toBe(true);
    }
    // Without the cascade the phone stays (s2 or s1 vouch for it once they endorse it).
    const quiet = await v({ type: "revoke", cluster: CLUSTER, member: s3, reason: "", by: s1, gen: 1, cascade: false }, s1);
    const endorse = await v({ type: "endorse", cluster: CLUSTER, member: d, addId: set[5].id, by: s2 }, s2);
    const view = computeRoster(s1, CLUSTER, [...set, endorse, quiet]);
    expect(view.valid.has(s3)).toBe(false);
    expect(view.valid.has(d)).toBe(true);
  });

  it("a write-back Add (joined: false) never puts its member in a cascade; the root is never in one", async () => {
    const { s1, s2, s3, set } = await chain();
    // Revoking s2 with cascade takes s3 (joined through s2) and the phone, never s1 (s2's write-back Add of s1, and the root).
    const revoke = await v({ type: "revoke", cluster: CLUSTER, member: s2, reason: "", by: s1, gen: 1, cascade: true }, s1);
    const view = computeRoster(s1, CLUSTER, [...set, revoke]);
    expect(view.valid.has(s1)).toBe(true);
    expect(view.valid.has(s2)).toBe(false);
    expect(view.valid.has(s3)).toBe(false);
    // A joining Add naming the root (by s3) does not cascade the root either.
    const rogue = await v(serverAdd(s1, s3, true, 9), s3);
    const revoke3 = await v({ type: "revoke", cluster: CLUSTER, member: s3, reason: "", by: s1, gen: 1, cascade: true }, s1);
    expect(computeRoster(s1, CLUSTER, [...set, rogue, revoke3]).valid.has(s1)).toBe(true);
  });

  it("RogueContained: s3, already revoked with cascade, signs Add{d2}; s1 endorses d2; d2 is invalid wherever the revocation is", async () => {
    const { s1, s2, s3, set } = await chain();
    const d2 = id("dtwo");
    const revoke = await v({ type: "revoke", cluster: CLUSTER, member: s3, reason: "", by: s1, gen: 1, cascade: true }, s1);
    const add = await v(deviceAdd(d2, s3, 7), s3);
    const endorse = await v({ type: "endorse", cluster: CLUSTER, member: d2, addId: add.id, by: s1 }, s1);
    // s1 had not heard of the revocation when it endorsed: d2 valid there then.
    expect(computeRoster(s1, CLUSTER, [...set, add, endorse]).valid.has(d2)).toBe(true);
    for (const self of [s1, s2]) {
      const all = [...set, revoke, add, endorse];
      for (let seed = 1; seed <= 20; seed++) {
        const view = computeRoster(self, CLUSTER, shuffled(all, seed));
        expect(view.valid.has(d2)).toBe(false);
        expect(view.valid.has(s3)).toBe(false);
        expect(view.valid.has(s2)).toBe(true);
      }
    }
  });
});

describe("K3: Revoke.cascade is a boolean (D61); M2's [] still reads", () => {
  it("parse: true, false and [] accepted; a list of members refused", () => {
    const base = { type: "revoke", cluster: CLUSTER, member: id("stwo"), reason: "", by: id("sone"), gen: 1 };
    for (const cascade of [true, false, []]) expect(RevokeStatement.safeParse({ ...base, cascade }).success).toBe(true);
    expect(RevokeStatement.safeParse({ ...base, cascade: [id("dphone")] }).success).toBe(false);
    expect(RevokeStatement.safeParse({ ...base }).success).toBe(false);
  });

  it("a Revoke with cascade: [] (as M2 signed) verifies with the same id and counts as cascade: false", async () => {
    const s = await withCluster();
    const other = await memberKeys();
    const phone = await memberKeys();
    const cluster = s.clusterId;
    const self = s.identity.memberId;
    const addOther = await signStatement({ type: "add", cluster, member: other.member, kind: "server", keys: other.keys, name: "Other", by: self, at: 1, joined: true }, self, (b) => s.identity.sign(b));
    const addPhone = await signStatement({ type: "add", cluster, member: phone.member, kind: "device", keys: phone.keys, name: "Phone", scope: ["read"], by: other.member, at: 2 }, other.member, other.signer);
    await s.roster.merge([addOther.statement, addPhone.statement]);
    const old = await signStatement({ type: "revoke", cluster, member: other.member, reason: "", by: self, gen: 1, cascade: [] }, self, (b) => s.identity.sign(b));
    const reparsed = SignedStatement.parse(JSON.parse(JSON.stringify(old.statement)));
    expect(reparsed.body).toMatchObject({ cascade: [] });
    expect(await statementId(reparsed.body)).toBe(old.id);
    expect(await s.roster.merge([reparsed])).toEqual([old.id]);
    expect(s.roster.view.countingRevokes).toContain(old.id);
    expect(s.roster.isValid(other.member)).toBe(false);
    expect(s.roster.isValid(phone.member)).toBe(true); // endorsed by this server, and [] does not cascade
    // New device revocations sign false.
    const tablet = await s.roster.addDevice({ keys: (await memberKeys()).keys, name: "Tablet" });
    const revoked = await s.roster.revokeDevice(tablet.member);
    expect(s.roster.statements().find((item) => item.id === revoked.revokeId)!.statement.body).toMatchObject({ cascade: false });
  });

  it("the same statements in any order give the same valid and revoked sets (cascades included)", async () => {
    const { s1, s3, set } = await chain();
    const extra = [
      await v({ type: "revoke", cluster: CLUSTER, member: s3, reason: "", by: s1, gen: 1, cascade: true }, s1),
      await v({ type: "revoke", cluster: CLUSTER, member: id("stwo"), reason: "", by: s1, gen: 1, cascade: [] }, s1),
      await v(deviceAdd(id("dtwo"), s3, 8), s3),
    ];
    const all = [...set, ...extra];
    const expected = computeRoster(s1, CLUSTER, all);
    for (let seed = 1; seed <= 30; seed++) {
      const view = computeRoster(s1, CLUSTER, shuffled(all, seed));
      expect([...view.valid].sort()).toEqual([...expected.valid].sort());
      expect([...view.revoked].sort()).toEqual([...expected.revoked].sort());
    }
  });
});

describe("K12: profile() takes a Profile only from the member or a valid server (pending D66)", () => {
  it("a removed server's newer Profile of a peer never wins; a valid server's does", async () => {
    const s = await withCluster();
    const cluster = s.clusterId;
    const self = s.identity.memberId;
    const s1 = await memberKeys(); // a peer whose address we read
    const s3 = await memberKeys(); // a server that will be removed
    const add1 = await signStatement({ type: "add", cluster, member: s1.member, kind: "server", keys: s1.keys, name: "S1", by: self, at: 1, joined: true }, self, (b) => s.identity.sign(b));
    const add3 = await signStatement({ type: "add", cluster, member: s3.member, kind: "server", keys: s3.keys, name: "S3", by: self, at: 2, joined: true }, self, (b) => s.identity.sign(b));
    const own = await signStatement({ type: "profile", cluster, member: s1.member, field: "addresses", value: "{\"loopback\":\"ws://127.0.0.1:4001/v3/ws\"}", hlc: { ms: 10, c: 0 } }, s1.member, s1.signer);
    await s.roster.merge([add1.statement, add3.statement, own.statement]);
    expect(s.roster.profile(s1.member, "addresses")).toContain("4001");
    // While s3 is valid, its newer Profile counts (a valid server may write a peer's address).
    const byS3 = await signStatement({ type: "profile", cluster, member: s1.member, field: "addresses", value: "{\"loopback\":\"ws://127.0.0.1:4666/v3/ws\"}", hlc: { ms: 20, c: 0 } }, s3.member, s3.signer);
    await s.roster.merge([byS3.statement]);
    expect(s.roster.profile(s1.member, "addresses")).toContain("4666");
    // The root (this server) removes s3: its Profile no longer counts, however new.
    const revoke = await signStatement({ type: "revoke", cluster, member: s3.member, reason: "", by: self, gen: 1, cascade: false }, self, (b) => s.identity.sign(b));
    await s.roster.merge([revoke.statement]);
    expect(s.roster.isValid(s3.member)).toBe(false);
    expect(s.roster.profile(s1.member, "addresses")).toContain("4001");
    const later = await signStatement({ type: "profile", cluster, member: s1.member, field: "addresses", value: "{\"loopback\":\"ws://127.0.0.1:4777/v3/ws\"}", hlc: { ms: 99, c: 0 } }, s3.member, s3.signer);
    await s.roster.merge([later.statement]);
    expect(s.roster.profile(s1.member, "addresses")).toContain("4001");
  });
});

describe("server pairing acts on the roster", () => {
  it("addServer signs Add{joined: true} once; joinCluster takes the cluster, writes Add{S, joined: false}, endorses the valid members", async () => {
    const s = await withCluster();
    const nServer = await server();
    const phone = await s.roster.addDevice({ keys: (await memberKeys()).keys, name: "Phone" });
    const first = await s.roster.addServer({ keys: nServer.identity.keys, name: "N" });
    const again = await s.roster.addServer({ keys: nServer.identity.keys, name: "N" });
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, addId: first.addId });
    const addOfN = s.roster.statements().find((item) => item.id === first.addId)!.statement;
    expect(addOfN.body).toMatchObject({ type: "add", kind: "server", member: nServer.identity.memberId, joined: true, by: s.identity.memberId });

    // A welcome that names another server is refused, nothing stored.
    const sponsor = { member: s.identity.memberId, keys: { ...s.identity.keys }, name: "S" };
    const roster = s.roster.statements().map((item) => item.statement);
    const strangerAdd = s.roster.statements().find((item) => item.id === phone.addId)!.statement;
    await expect(nServer.roster.joinCluster({ add: strangerAdd, roster, sponsor })).rejects.toMatchObject({ reason: "bad-join" });
    await expect(nServer.roster.joinCluster({ add: addOfN, roster, sponsor: { ...sponsor, member: phone.member } })).rejects.toMatchObject({ reason: "bad-join" });
    await expect(nServer.roster.joinCluster({ add: addOfN, roster: roster.filter((st) => st.body.type !== "root"), sponsor })).rejects.toMatchObject({ reason: "bad-join" });
    expect(nServer.roster.clusterId).toBeNull();

    const joined = await nServer.roster.joinCluster({ add: addOfN, roster, sponsor });
    expect(joined.clusterId).toBe(s.clusterId);
    expect(nServer.roster.clusterId).toBe(s.clusterId);
    expect(joined.add.body).toMatchObject({ type: "add", kind: "server", member: s.identity.memberId, by: nServer.identity.memberId, joined: false });
    const view = nServer.roster.view;
    expect(view.valid.has(nServer.identity.memberId) && view.valid.has(s.identity.memberId) && view.valid.has(phone.member)).toBe(true);
    expect(view.root?.root).toBe(s.identity.memberId);
    const endorsed = nServer.roster.statements().filter((item) => item.statement.body.type === "endorse").map((item) => (item.statement.body as { member: string }).member);
    expect(endorsed).toEqual([phone.member]); // S it added itself; the phone it endorses
    await expect(nServer.roster.joinCluster({ add: addOfN, roster, sponsor })).rejects.toMatchObject({ reason: "cluster-exists" });

    // S stores N's write-back Add; both rosters then hold both Adds.
    expect(await s.roster.merge([joined.add])).toEqual([joined.addId]);
    expect(s.roster.statements().some((item) => item.id === joined.addId)).toBe(true);
  });

  it("writeProfile writes once per value with a rising hlc", async () => {
    const s = await withCluster();
    const value = "{\"loopback\":\"ws://127.0.0.1:4100/v3/ws\"}";
    const first = await s.roster.writeProfile(s.identity.memberId, "addresses", value);
    expect(first).not.toBeNull();
    expect(await s.roster.writeProfile(s.identity.memberId, "addresses", value)).toBeNull();
    const next = await s.roster.writeProfile(s.identity.memberId, "addresses", value.replace("4100", "4101"));
    const hlc = (st: SignedStatement | null) => (st!.body as { hlc: { ms: number; c: number } }).hlc;
    expect(hlc(next).ms > hlc(first).ms || (hlc(next).ms === hlc(first).ms && hlc(next).c > hlc(first).c)).toBe(true);
    expect(s.roster.profile(s.identity.memberId, "addresses")).toContain("4101");
  });
});

describe("K10: device revocations by a removed server keep counting (D61, pending D66 part 4)", () => {
  /** Real signed statements: s1 (root) adds s2 and s3; s2 pairs phone d; s1 and s3 endorse d; s2 revokes d; s1 revokes s2 (cascade: false). */
  async function k10Scenario() {
    const s1 = await withCluster();
    const s2 = await server();
    const s3 = await server();
    const phone = await memberKeys();
    const cluster = s1.clusterId;
    const s1Id = s1.identity.memberId;
    const s2Id = s2.identity.memberId;
    const s3Id = s3.identity.memberId;
    const dId = phone.member;

    const rootStmt = s1.roster.statements()[0];
    const addS2 = await signStatement({ type: "add", cluster, member: s2Id, kind: "server", keys: s2.identity.keys, name: "S2", by: s1Id, at: 1, joined: true }, s1Id, (b) => s1.identity.sign(b));
    const wbS1ByS2 = await signStatement({ type: "add", cluster, member: s1Id, kind: "server", keys: s1.identity.keys, name: "S1", by: s2Id, at: 2, joined: false }, s2Id, (b) => s2.identity.sign(b));
    const addS3 = await signStatement({ type: "add", cluster, member: s3Id, kind: "server", keys: s3.identity.keys, name: "S3", by: s1Id, at: 3, joined: true }, s1Id, (b) => s1.identity.sign(b));
    const wbS1ByS3 = await signStatement({ type: "add", cluster, member: s1Id, kind: "server", keys: s1.identity.keys, name: "S1", by: s3Id, at: 4, joined: false }, s3Id, (b) => s3.identity.sign(b));
    const addD = await signStatement({ type: "add", cluster, member: dId, kind: "device", keys: phone.keys, name: "Phone", scope: ["read"], by: s2Id, at: 5 }, s2Id, (b) => s2.identity.sign(b));
    // s1 and s3 endorse d so that, without s2's revocation of d, removing s2 with cascade: false would keep d valid.
    const endorseDByS1 = await signStatement({ type: "endorse", cluster, member: dId, addId: addD.id, by: s1Id }, s1Id, (b) => s1.identity.sign(b));
    const endorseDByS3 = await signStatement({ type: "endorse", cluster, member: dId, addId: addD.id, by: s3Id }, s3Id, (b) => s3.identity.sign(b));

    const revokeD = await signStatement({ type: "revoke", cluster, member: dId, reason: "lost", by: s2Id, gen: 1, cascade: false }, s2Id, (b) => s2.identity.sign(b));
    const revokeS2 = await signStatement({ type: "revoke", cluster, member: s2Id, reason: "retired", by: s1Id, gen: 1, cascade: false }, s1Id, (b) => s1.identity.sign(b));

    const base = [rootStmt, addS2, wbS1ByS2, addS3, wbS1ByS3, addD, endorseDByS1, endorseDByS3];
    const viewsFor = async (stmts: StoredStatement[]) => Promise.all(
      [s1, s2, s3].map(async (srv) => {
        const verified = await verifyStatements(stmts, { memberId: srv.identity.memberId, signPub: srv.identity.keys.sign });
        return { srv, view: computeRoster(srv.identity.memberId, cluster, verified) };
      }),
    );

    return { s1, s2, s3, s1Id, s2Id, s3Id, dId, base, revokeD, revokeS2, viewsFor };
  }

  it("s2 revokes phone d, then the root revokes s2 with cascade: false; d is not valid on any server view", async () => {
    const { s1Id, s2Id, s3Id, dId, base, revokeD, revokeS2, viewsFor } = await k10Scenario();

    // Baseline check: without revokeD, removing s2 (cascade: false) leaves the endorsed phone d valid on s1 and s3.
    for (const { srv, view } of await viewsFor([...base, revokeS2])) {
      expect(view.valid.has(s2Id)).toBe(false);
      if (srv.identity.memberId !== s2Id) expect(view.valid.has(dId)).toBe(true);
    }

    for (const { srv, view } of await viewsFor([...base, revokeD, revokeS2])) {
      expect(view.valid.has(dId)).toBe(false);
      expect(view.revoked.has(dId)).toBe(true);
      expect(view.valid.has(s2Id)).toBe(false);
      expect(view.revoked.has(s2Id)).toBe(true);
      if (srv.identity.memberId !== s2Id) {
        expect(view.valid.has(s1Id)).toBe(true);
        expect(view.valid.has(s3Id)).toBe(true);
      }
    }
  });

  it("produces the same views when the statements are verified in another order", async () => {
    const { s1Id, s2Id, s3Id, dId, base, revokeD, revokeS2, viewsFor } = await k10Scenario();
    const all = [...base, revokeD, revokeS2];
    const baseline = await viewsFor(all);

    for (const ordered of [[...all].reverse(), ...Array.from({ length: 15 }, (_, i) => shuffled(all, i + 1))]) {
      const views = await viewsFor(ordered);
      for (let i = 0; i < views.length; i++) {
        expect(views[i].view.valid.has(dId)).toBe(false);
        expect(views[i].view.revoked.has(dId)).toBe(true);
        expect([...views[i].view.valid].sort()).toEqual([...baseline[i].view.valid].sort());
        expect([...views[i].view.revoked].sort()).toEqual([...baseline[i].view.revoked].sort());
        if (views[i].srv.identity.memberId !== s2Id) {
          expect(views[i].view.valid.has(s1Id)).toBe(true);
          expect(views[i].view.valid.has(s3Id)).toBe(true);
        }
      }
    }
  });

  it("d stays invalid when s2's device revocation arrives after the root's revocation of s2", async () => {
    const { s1, s1Id, s2Id, s3Id, dId, base, revokeD, revokeS2, viewsFor } = await k10Scenario();

    // Pure computeRoster with revokeD placed after revokeS2.
    for (const { srv, view } of await viewsFor([...base, revokeS2, revokeD])) {
      expect(view.valid.has(dId)).toBe(false);
      expect(view.revoked.has(dId)).toBe(true);
      expect(view.valid.has(s2Id)).toBe(false);
      if (srv.identity.memberId !== s2Id) {
        expect(view.valid.has(s1Id)).toBe(true);
        expect(view.valid.has(s3Id)).toBe(true);
      }
    }

    // Stateful RosterStore.merge: s1 already holds revokeS2 before revokeD arrives.
    await s1.roster.merge([...base.slice(1).map((item) => item.statement), revokeS2.statement]);
    expect(s1.roster.isValid(s2Id)).toBe(false);
    expect(s1.roster.isValid(dId)).toBe(true);
    await s1.roster.merge([revokeD.statement]);
    expect(s1.roster.isValid(dId)).toBe(false);
    expect(s1.roster.view.revoked.has(dId)).toBe(true);
    expect(s1.roster.isValid(s1Id)).toBe(true);
    expect(s1.roster.isValid(s3Id)).toBe(true);
  });
});
