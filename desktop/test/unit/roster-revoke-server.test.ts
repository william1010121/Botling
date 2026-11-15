// Botling 3 M4-04: the revocation root can remove a server (`revokeServer`, `cascadePreview`, `seen`, `server.revoke` audit).
// Uses real WebCrypto keys and real server.db stores in temp folders (no windows, loopback-only / in-memory).
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { memberIdFromKey, toBase64Url, type SignedStatement, type WireMessage } from "../../src/protocol";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity, recoveryKeyFromCode } from "../../src/server/identity";
import { Gossip, PrefsStore, readAudits, RosterError, RosterStore, signStatement, signWith, type GossipSession, type RosterChange } from "../../src/server/roster";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { testRoot } from "../botlingd-harness";

const root = testRoot("roster-revoke-server");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const open: ServerStore[] = [];
afterEach(async () => { for (const store of open.splice(0)) await store.close(); });

let n = 0;
function folder(): string {
  const dir = join(root, `d${++n}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function makeServer(now = () => 1_000_000) {
  const dir = folder();
  const store = await openServerStore(dir);
  open.push(store);
  const identity = await loadOrCreateServerIdentity(dir);
  await store.submit((tx) => bindServerIdentity(tx, identity));
  const roster = await RosterStore.open(store, identity, { now });
  return { dir, store, identity, roster, setup: new ClusterSetup(roster) };
}

async function deviceKeys() {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  const keys = { sign: toBase64Url(signPub), dh: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", dh.publicKey))) };
  return { keys, member: await memberIdFromKey(signPub), signer: signWith(sign.privateKey) };
}

/** Builds s1 (root) → s2 → s3 (each joined through the one before), with phone d paired to s3, all synced to s1. */
async function chainCluster() {
  let clock = 1_000;
  const tick = () => ++clock;
  const s1 = await makeServer(tick);
  const started = await s1.setup.begin();
  expect((await s1.setup.confirm(started.code)).ok).toBe(true);

  const s2 = await makeServer(tick);
  const addS2 = await s1.roster.addServer({ keys: s2.identity.keys, name: "Server Two" });
  const addS2Stmt = s1.roster.statements().find((item) => item.id === addS2.addId)!.statement;
  await s2.roster.joinCluster({
    add: addS2Stmt,
    roster: s1.roster.statements().map((item) => item.statement),
    sponsor: { member: s1.identity.memberId, keys: s1.identity.keys, name: "Root One" },
  });

  const s3 = await makeServer(tick);
  const addS3 = await s2.roster.addServer({ keys: s3.identity.keys, name: "Server Three" });
  const addS3Stmt = s2.roster.statements().find((item) => item.id === addS3.addId)!.statement;
  await s3.roster.joinCluster({
    add: addS3Stmt,
    roster: s2.roster.statements().map((item) => item.statement),
    sponsor: { member: s2.identity.memberId, keys: s2.identity.keys, name: "Server Two" },
  });

  const phone = await deviceKeys();
  const addPhone = await s3.roster.addDevice({ keys: phone.keys, name: "Phone" });

  // Sync statements across s1, s2, s3 (as gossip does).
  const all = [...s1.roster.statements(), ...s2.roster.statements(), ...s3.roster.statements()].map((item) => item.statement);
  await s1.roster.merge(all);
  await s2.roster.merge(all);
  await s3.roster.merge(all);

  return { s1, s2, s3, phone, addPhone, code: started.code, tick };
}

describe("M4-04: revokeServer and cascadePreview", () => {
  it("1. refuses on a non-root server with server-revoke-root-only and writes nothing", async () => {
    const { s1, s2, s3 } = await chainCluster();
    const beforeStmts = s2.roster.statements().map((item) => item.id);
    const beforeAudits = readAudits(s2.store.openReader()).length;

    await expect(s2.roster.revokeServer(s3.identity.memberId, true)).rejects.toThrow(RosterError);
    await expect(s2.roster.revokeServer(s3.identity.memberId, true)).rejects.toMatchObject({ reason: "server-revoke-root-only" });
    await expect(s2.roster.revokeServer(s1.identity.memberId, true)).rejects.toMatchObject({ reason: "server-revoke-root-only" });
    await expect(s2.roster.revokeServer(s2.identity.memberId, true)).rejects.toMatchObject({ reason: "server-revoke-root-only" });

    expect(s2.roster.statements().map((item) => item.id)).toEqual(beforeStmts);
    expect(readAudits(s2.store.openReader()).length).toBe(beforeAudits);
    expect(s2.roster.isValid(s3.identity.memberId)).toBe(true);
  });

  it("2 & 3. cascadePreview lists s3's cascade before removal; revokeServer(s3, true) signs gen=R.gen and removes s3 and phone d, keeping s2", async () => {
    const { s1, s2, s3, phone } = await chainCluster();
    expect(s1.roster.cascadePreview(s3.identity.memberId)).toEqual([phone.member]);
    expect(s1.roster.cascadePreview(s2.identity.memberId)).toEqual([s3.identity.memberId, phone.member].sort());

    const changes: RosterChange[] = [];
    s1.roster.onChange((change) => changes.push(change));

    const res = await s1.roster.revokeServer(s3.identity.memberId, true, "retired");
    expect(res.already).toBe(false);
    expect(s1.roster.isValid(s3.identity.memberId)).toBe(false);
    expect(s1.roster.isValid(phone.member)).toBe(false);
    expect(s1.roster.isValid(s2.identity.memberId)).toBe(true);
    expect(s1.roster.isValid(s1.identity.memberId)).toBe(true);
    expect(changes.at(-1)?.invalidated.sort()).toEqual([s3.identity.memberId, phone.member].sort());

    const revStmt = s1.roster.statements().find((item) => item.id === res.revokeId)?.statement;
    expect(revStmt?.body).toMatchObject({
      type: "revoke",
      member: s3.identity.memberId,
      by: s1.identity.memberId,
      gen: 1,
      cascade: true,
      reason: "retired",
    });

    // Reopen persists validity and statements.
    await s1.store.close();
    open.splice(open.indexOf(s1.store), 1);
    const reopenedStore = await openServerStore(s1.dir);
    open.push(reopenedStore);
    const reopened = await RosterStore.open(reopenedStore, s1.identity);
    expect(reopened.isValid(s3.identity.memberId)).toBe(false);
    expect(reopened.isValid(phone.member)).toBe(false);
    expect(reopened.isValid(s2.identity.memberId)).toBe(true);
  });

  it("4. revokeServer(s3, false) removes s3 while keeping d valid", async () => {
    const { s1, s2, s3, phone } = await chainCluster();
    const res = await s1.roster.revokeServer(s3.identity.memberId, false);
    expect(res.already).toBe(false);
    expect(s1.roster.isValid(s3.identity.memberId)).toBe(false);
    expect(s1.roster.isValid(phone.member)).toBe(true);
    expect(s1.roster.isValid(s2.identity.memberId)).toBe(true);

    const revStmt = s1.roster.statements().find((item) => item.id === res.revokeId)?.statement;
    expect(revStmt?.body).toMatchObject({ type: "revoke", member: s3.identity.memberId, cascade: false, gen: 1 });
  });

  it("5. seen lists exactly the joining Adds signed by s3 that the root holds (excluding s3's write-back Add)", async () => {
    const { s1, s3, addPhone } = await chainCluster();
    // s3 signed two Adds: a write-back Add{s2, joined: false} and a joining Add{phone}. Only phone's Add belongs in seen.
    const res = await s1.roster.revokeServer(s3.identity.memberId, true);
    const revStmt = s1.roster.statements().find((item) => item.id === res.revokeId)?.statement;
    expect(revStmt?.body.type).toBe("revoke");
    if (revStmt?.body.type === "revoke") {
      expect(revStmt.body.seen).toEqual([addPhone.addId]);
    }
  });

  it("5b. when the revoked server signed zero joining Adds, seen is still present as [] (not omitted)", async () => {
    const { s1, s3 } = await chainCluster();
    // Make a fresh server s4 added by s1 with no joining Adds signed by s4.
    const s4 = await makeServer();
    await s1.roster.addServer({ keys: s4.identity.keys, name: "Server Four" });
    expect(s1.roster.cascadePreview(s4.identity.memberId)).toEqual([]);
    const res = await s1.roster.revokeServer(s4.identity.memberId, false);
    const revStmt = s1.roster.statements().find((item) => item.id === res.revokeId)?.statement;
    expect(revStmt?.body.type).toBe("revoke");
    if (revStmt?.body.type === "revoke") {
      expect(revStmt.body.seen).toEqual([]);
    }
    expect(s1.roster.isValid(s3.identity.memberId)).toBe(true);
  });

  it("6. the root cannot revoke itself, nor a non-server (device or unknown id)", async () => {
    const { s1, phone } = await chainCluster();
    const before = s1.roster.statements().map((item) => item.id);
    const beforeAudits = readAudits(s1.store.openReader()).length;

    await expect(s1.roster.revokeServer(s1.identity.memberId, true)).rejects.toMatchObject({ reason: "cannot-revoke-root" });
    await expect(s1.roster.revokeServer(phone.member, true)).rejects.toMatchObject({ reason: "not-a-server" });
    await expect(s1.roster.revokeServer("aaaaaaaaaaaaaaaaaaaaaaaaaa", true)).rejects.toMatchObject({ reason: "not-a-server" });
    expect(s1.roster.cascadePreview(s1.identity.memberId)).toEqual([]);
    expect(s1.roster.cascadePreview(phone.member)).toEqual([]);

    expect(s1.roster.statements().map((item) => item.id)).toEqual(before);
    expect(readAudits(s1.store.openReader()).length).toBe(beforeAudits);
    expect(s1.roster.isValid(s1.identity.memberId)).toBe(true);
  });

  it("7. calling revokeServer twice with the same member and cascade signs once (already: true); upgrading false→true signs once", async () => {
    const { s1, s3, phone } = await chainCluster();
    const first = await s1.roster.revokeServer(s3.identity.memberId, true, "stolen");
    expect(first.already).toBe(false);
    const countAfterFirst = s1.roster.statements().length;

    const second = await s1.roster.revokeServer(s3.identity.memberId, true, "stolen");
    expect(second).toEqual({ revokeId: first.revokeId, already: true });
    expect(s1.roster.statements().length).toBe(countAfterFirst);
    expect(readAudits(s1.store.openReader()).filter((a) => a.act === "server.revoke")).toHaveLength(1);

    // Calling cascade=false on an already cascade=true revoked server also does not re-sign.
    const downgrade = await s1.roster.revokeServer(s3.identity.memberId, false);
    expect(downgrade).toEqual({ revokeId: first.revokeId, already: true });
    expect(s1.roster.statements().length).toBe(countAfterFirst);

    // Upgrading cascade=false to cascade=true on another server signs the cascading revoke.
    const s4 = await makeServer();
    await s1.roster.addServer({ keys: s4.identity.keys, name: "Server Four" });
    const phone4 = await deviceKeys();
    const addPhone4 = await signStatement(
      { type: "add", cluster: s1.roster.clusterId!, member: phone4.member, kind: "device", keys: phone4.keys, name: "Phone 4", scope: ["read"], by: s4.identity.memberId, at: 5 },
      s4.identity.memberId,
      (bytes) => s4.identity.sign(bytes),
    );
    await s1.roster.merge([addPhone4.statement]);

    const nonCascade = await s1.roster.revokeServer(s4.identity.memberId, false);
    expect(nonCascade.already).toBe(false);
    expect(s1.roster.isValid(phone4.member)).toBe(true);
    expect(await s1.roster.revokeServer(s4.identity.memberId, false)).toEqual({ revokeId: nonCascade.revokeId, already: true });

    const upgrade = await s1.roster.revokeServer(s4.identity.memberId, true);
    expect(upgrade.already).toBe(false);
    expect(upgrade.revokeId).not.toBe(nonCascade.revokeId);
    expect(s1.roster.isValid(phone4.member)).toBe(false);
    expect(s1.roster.isValid(phone.member)).toBe(false);
  });

  it("8. writes one server.revoke audit row per revocation in the same transaction, and gossip pushes it at once", async () => {
    const { s1, s2, s3 } = await chainCluster();
    const prefs = await PrefsStore.open(s1.store, { self: s1.identity.memberId });
    const gossip = new Gossip({ roster: s1.roster, prefs, log: () => undefined });
    gossip.start();

    const sentToS2: WireMessage[] = [];
    const session: GossipSession = {
      peer: s2.identity.memberId,
      state: "open",
      sendWire: (msg) => { sentToS2.push(msg); return true; },
      bye: () => undefined,
    };
    gossip.opened(session);
    // Wait for initial sendHave microtasks and clear initial frames.
    await new Promise((r) => setTimeout(r, 10));
    sentToS2.length = 0;

    const res = await s1.roster.revokeServer(s3.identity.memberId, true, "decommissioned");
    const audits = readAudits(s1.store.openReader());
    const serverRevokes = audits.filter((row) => row.act === "server.revoke");
    expect(serverRevokes).toHaveLength(1);
    expect(serverRevokes[0]).toMatchObject({
      act: "server.revoke",
      statement: res.revokeId,
      by: s1.identity.memberId,
      member: s3.identity.memberId,
      name: "Server Three",
      reason: "decommissioned",
    });

    // Gossip pushed the new Revoke statement synchronously on roster.onChange, followed by roster.have once digests finish.
    const pushedStmts = sentToS2
      .filter((msg): msg is Extract<WireMessage, { t: "roster.statements" }> => msg.t === "roster.statements")
      .flatMap((msg) => msg.statements as SignedStatement[]);
    expect(pushedStmts.some((stmt) => stmt.body.type === "revoke" && stmt.body.member === s3.identity.memberId)).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(sentToS2.some((msg) => msg.t === "roster.have")).toBe(true);
    gossip.close();
  });

  it("uses the roster's current root (after reroot, gen 2 root revokes with gen=2 and old gen 1 root is refused)", async () => {
    const { s1, s2, s3, code } = await chainCluster();
    const recovery = await recoveryKeyFromCode(code);
    const gen1Id = s1.roster.view.root!.id;
    const root2 = await signStatement(
      { type: "root", cluster: s1.roster.clusterId!, gen: 2, root: s2.identity.memberId, recoveryPub: recovery.recoveryPub, keep: [], prev: gen1Id },
      "recovery",
      signWith(recovery.privateKey),
    );
    await s1.roster.merge([root2.statement]);
    await s2.roster.merge([root2.statement]);

    expect(s1.roster.view.root?.root).toBe(s2.identity.memberId);
    await expect(s1.roster.revokeServer(s3.identity.memberId, true)).rejects.toMatchObject({ reason: "server-revoke-root-only" });

    const res = await s2.roster.revokeServer(s3.identity.memberId, true);
    const revStmt = s2.roster.statements().find((item) => item.id === res.revokeId)?.statement;
    expect(revStmt?.body).toMatchObject({ type: "revoke", member: s3.identity.memberId, by: s2.identity.memberId, gen: 2, cascade: true });
    expect(s2.roster.isValid(s3.identity.memberId)).toBe(false);
    expect(s2.roster.isValid(s2.identity.memberId)).toBe(true);
  });

  it("never puts the current root in its own cascade even if the revoked server signed a joining Add naming the root", async () => {
    const { s1, s2, s3, code } = await chainCluster();
    const recovery = await recoveryKeyFromCode(code);
    const root2 = await signStatement(
      { type: "root", cluster: s1.roster.clusterId!, gen: 2, root: s2.identity.memberId, recoveryPub: recovery.recoveryPub, keep: [], prev: s1.roster.view.root!.id },
      "recovery",
      signWith(recovery.privateKey),
    );
    // s3 signs a joining Add naming s2 (which is now the gen-2 root).
    const joiningAddOfRoot = await signStatement(
      { type: "add", cluster: s1.roster.clusterId!, member: s2.identity.memberId, kind: "server", keys: s2.identity.keys, name: "Root Two", by: s3.identity.memberId, at: 9999, joined: true },
      s3.identity.memberId,
      (bytes) => s3.identity.sign(bytes),
    );
    await s2.roster.merge([root2.statement, joiningAddOfRoot.statement]);
    expect(s2.roster.cascadePreview(s3.identity.memberId)).not.toContain(s2.identity.memberId);
    await s2.roster.revokeServer(s3.identity.memberId, true);
    expect(s2.roster.isValid(s2.identity.memberId)).toBe(true);
    expect(s2.roster.isValid(s3.identity.memberId)).toBe(false);
  });
});
