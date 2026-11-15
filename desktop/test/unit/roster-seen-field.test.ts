// Botling 3 M4-02 (K8, pending D66): reserve the optional `seen` field on a server revocation.
// - A Revoke without `seen` keeps its exact M3 canonical bytes and id (no default `[]` injected).
// - A server Revoke with `seen` parses and verifies; its id changes because `seen` enters the canonical bytes.
// - Duplicate ids in `seen` are refused at parse; a device revocation carrying `seen` is refused at verify.
// - `computeRoster` ignores `seen` until D66 is adopted.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  memberIdFromKey,
  RevokeStatement,
  ROSTER_DOMAIN,
  SignedStatement,
  statementBytes,
  statementId,
  toBase64Url,
  toHex,
  sha256,
  utf8Bytes,
  type StatementBody,
} from "../../src/protocol";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { computeRoster, RosterStore, signStatement, signWith, storedBytes, verifyStatements, type VerifiedStatement } from "../../src/server/roster";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { testRoot } from "../botlingd-harness";

const root = testRoot("roster-seen-field");
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

const CLUSTER = "c".repeat(32);
const RECOVERY = "R".repeat(43);
const id = (name: string) => (name + "a".repeat(26)).slice(0, 26).toLowerCase().replace(/[^a-z2-7]/g, "a");
const KEYS = { sign: "S".repeat(42) + "A", dh: "D".repeat(42) + "A" };
const STMT_1 = "1".repeat(64);
const STMT_2 = "2".repeat(64);

async function verifiedOf(body: StatementBody, signer: string): Promise<VerifiedStatement> {
  return { id: await statementId(body), body, signer, ...(body.type === "root" ? { recoveryKey: RECOVERY, recoveryKeyCluster: CLUSTER } : {}) };
}

describe("M4-02 (K8): Revoke.seen wire reservation", () => {
  it("1. a Revoke without seen parses unchanged, keeping its M3 canonical bytes and id", async () => {
    const s = await withCluster();
    const other = await memberKeys();
    for (const cascade of [false, [] as string[]]) {
      const rawBody = {
        type: "revoke" as const,
        cluster: s.clusterId,
        member: other.member,
        reason: "retired",
        by: s.identity.memberId,
        gen: 1,
        cascade,
      };
      const expectedBytes = utf8Bytes(ROSTER_DOMAIN + canonicalJson(rawBody));
      const expectedId = toHex(await sha256(expectedBytes));

      const parsedBody = RevokeStatement.parse(rawBody);
      expect("seen" in parsedBody).toBe(false);
      expect(statementBytes(parsedBody)).toEqual(expectedBytes);
      expect(await statementId(parsedBody)).toBe(expectedId);

      const signed = await signStatement(parsedBody, s.identity.memberId, (b) => s.identity.sign(b));
      expect(signed.id).toBe(expectedId);
      const roundTripped = SignedStatement.parse(JSON.parse(new TextDecoder().decode(storedBytes(signed.statement))));
      expect("seen" in roundTripped.body).toBe(false);
      expect(await statementId(roundTripped.body)).toBe(expectedId);

      const verified = await verifyStatements([{ id: signed.id, statement: roundTripped }], { memberId: s.identity.memberId, signPub: s.identity.keys.sign });
      expect(verified.map((item) => item.id)).toEqual([expectedId]);
    }
  });

  it("2. a server Revoke with seen parses and verifies, and its id changes", async () => {
    const s = await withCluster();
    const other = await memberKeys();
    const addOther = await signStatement(
      { type: "add", cluster: s.clusterId, member: other.member, kind: "server", keys: other.keys, name: "Peer", by: s.identity.memberId, at: 1, joined: true },
      s.identity.memberId,
      (b) => s.identity.sign(b),
    );
    const baseBody = {
      type: "revoke" as const,
      cluster: s.clusterId,
      member: other.member,
      reason: "",
      by: s.identity.memberId,
      gen: 1,
      cascade: false,
    };
    const withoutSeen = await signStatement(baseBody, s.identity.memberId, (b) => s.identity.sign(b));
    const withSeenBody = { ...baseBody, seen: [STMT_1, STMT_2] };
    expect(RevokeStatement.safeParse(withSeenBody).success).toBe(true);
    const withSeen = await signStatement(withSeenBody, s.identity.memberId, (b) => s.identity.sign(b));
    expect(withSeen.id).not.toBe(withoutSeen.id);
    expect(new TextDecoder().decode(statementBytes(withSeen.statement.body))).toContain('"seen"');

    const verified = await verifyStatements(
      [addOther, withSeen],
      { memberId: s.identity.memberId, signPub: s.identity.keys.sign },
    );
    expect(verified.map((item) => item.id)).toContain(withSeen.id);

    // An explicit empty `seen: []` on a server Revoke also parses, verifies, and differs from absent `seen`.
    const withEmptySeen = await signStatement({ ...baseBody, seen: [] }, s.identity.memberId, (b) => s.identity.sign(b));
    expect(withEmptySeen.id).not.toBe(withoutSeen.id);
    const verifiedEmpty = await verifyStatements(
      [addOther, withEmptySeen],
      { memberId: s.identity.memberId, signPub: s.identity.keys.sign },
    );
    expect(verifiedEmpty.map((item) => item.id)).toContain(withEmptySeen.id);
  });

  it("3. a Revoke with duplicate ids in seen is refused", () => {
    const base = { type: "revoke", cluster: CLUSTER, member: id("stwo"), reason: "", by: id("sone"), gen: 1, cascade: false };
    expect(RevokeStatement.safeParse({ ...base, seen: [STMT_1, STMT_1] }).success).toBe(false);
    expect(RevokeStatement.safeParse({ ...base, seen: [STMT_1, STMT_2, STMT_1] }).success).toBe(false);
    expect(RevokeStatement.safeParse({ ...base, seen: [STMT_1, STMT_2] }).success).toBe(true);
  });

  it("4. a device revocation carrying seen is refused at verify", async () => {
    const s = await withCluster();
    const phone = await memberKeys();
    const added = await s.roster.addDevice({ keys: phone.keys, name: "Phone" });
    const addStored = s.roster.statements().find((item) => item.id === added.addId)!;
    const base = {
      type: "revoke" as const,
      cluster: s.clusterId,
      member: phone.member,
      reason: "",
      by: s.identity.memberId,
      gen: 1,
      cascade: false,
    };
    const revokeWithIds = await signStatement({ ...base, seen: [STMT_1] }, s.identity.memberId, (b) => s.identity.sign(b));
    const revokeWithEmpty = await signStatement({ ...base, seen: [] }, s.identity.memberId, (b) => s.identity.sign(b));

    const self = { memberId: s.identity.memberId, signPub: s.identity.keys.sign };
    const v1 = await verifyStatements([addStored, revokeWithIds], self);
    expect(v1.map((item) => item.id)).toEqual([addStored.id]);
    const v2 = await verifyStatements([addStored, revokeWithEmpty], self);
    expect(v2.map((item) => item.id)).toEqual([addStored.id]);

    // Merging into the store also ignores it, leaving the device valid.
    await s.roster.merge([revokeWithIds.statement, revokeWithEmpty.statement]);
    expect(s.roster.isValid(phone.member)).toBe(true);

    // A bogus device Add signed by a device cannot make a server revocation with seen look like a device revocation.
    const peer = await memberKeys();
    const addPeer = await signStatement(
      { type: "add", cluster: s.clusterId, member: peer.member, kind: "server", keys: peer.keys, name: "Peer", by: s.identity.memberId, at: 2, joined: true },
      s.identity.memberId,
      (b) => s.identity.sign(b),
    );
    const bogusDeviceAdd = await signStatement(
      { type: "add", cluster: s.clusterId, member: peer.member, kind: "device", keys: peer.keys, name: "Fake", scope: ["read"], by: phone.member, at: 3 },
      phone.member,
      phone.signer,
    );
    const revokePeer = await signStatement(
      { type: "revoke", cluster: s.clusterId, member: peer.member, reason: "", by: s.identity.memberId, gen: 1, cascade: false, seen: [STMT_1] },
      s.identity.memberId,
      (b) => s.identity.sign(b),
    );
    const v3 = await verifyStatements([addStored, addPeer, bogusDeviceAdd, revokePeer], self);
    expect(v3.map((item) => item.id)).toContain(revokePeer.id);
  });

  it("5. computeRoster gives the same result with and without seen on a revocation", async () => {
    const [s1, s2, s3, d] = ["sone", "stwo", "sthree", "dphone"].map(id);
    const rootBody: StatementBody = { type: "root", cluster: CLUSTER, gen: 1, root: s1, recoveryPub: RECOVERY, keep: [], prev: null };
    const addS2 = await verifiedOf({ type: "add", cluster: CLUSTER, member: s2, kind: "server", keys: KEYS, name: "S2", by: s1, at: 1, joined: true }, s1);
    const addS1 = await verifiedOf({ type: "add", cluster: CLUSTER, member: s1, kind: "server", keys: KEYS, name: "S1", by: s2, at: 1, joined: false }, s2);
    const addS3 = await verifiedOf({ type: "add", cluster: CLUSTER, member: s3, kind: "server", keys: KEYS, name: "S3", by: s2, at: 2, joined: true }, s2);
    const addS2Back = await verifiedOf({ type: "add", cluster: CLUSTER, member: s2, kind: "server", keys: KEYS, name: "S2", by: s3, at: 2, joined: false }, s3);
    const addD = await verifiedOf({ type: "add", cluster: CLUSTER, member: d, kind: "device", keys: KEYS, name: "D", scope: ["read"], by: s2, at: 3 }, s2);
    const baseSet = [await verifiedOf(rootBody, "recovery"), addS2, addS1, addS3, addS2Back, addD];

    for (const cascade of [false, true]) {
      const withoutSeen = await verifiedOf({ type: "revoke", cluster: CLUSTER, member: s2, reason: "", by: s1, gen: 1, cascade }, s1);
      const withSeen = await verifiedOf({ type: "revoke", cluster: CLUSTER, member: s2, reason: "", by: s1, gen: 1, cascade, seen: [addS3.id] }, s1);

      for (const self of [s1, s2, s3]) {
        const a = computeRoster(self, CLUSTER, [...baseSet, withoutSeen]);
        const b = computeRoster(self, CLUSTER, [...baseSet, withSeen]);
        expect([...b.valid].sort()).toEqual([...a.valid].sort());
        expect([...b.revoked].sort()).toEqual([...a.revoked].sort());
        expect([...b.servers].sort()).toEqual([...a.servers].sort());
        expect([...b.members.keys()].sort()).toEqual([...a.members.keys()].sort());
        expect(b.root?.id).toEqual(a.root?.id);
        expect(b.countingRevokes.length).toBe(a.countingRevokes.length);
      }
    }
  });
});
