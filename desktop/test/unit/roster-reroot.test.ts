// Botling 3 M4-08: reroot from the recovery code (`reroot`, `root.change` audit, secret handling, D48, D62).
// Uses real WebCrypto keys and real server.db stores in temp folders (no windows, loopback-only / in-memory).
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { memberIdFromKey, toBase64Url, toHex, type SignedStatement, type WireMessage } from "../../src/protocol";
import {
  bindServerIdentity,
  ClusterSetup,
  loadOrCreateServerIdentity,
  newRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_INFO,
  RECOVERY_SALT,
} from "../../src/server/identity";
import { Gossip, PrefsStore, readAudits, RosterError, RosterStore, type GossipSession, type RosterChange } from "../../src/server/roster";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { testRoot } from "../botlingd-harness";

const root = testRoot("roster-reroot");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const open: ServerStore[] = [];
afterEach(async () => { for (const store of open.splice(0)) await store.close(); });

let n = 0;
function folder(): string {
  const dir = join(root, `d${++n}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function makeServer(now = () => 1_000_000, logs: string[] = []) {
  const dir = folder();
  const store = await openServerStore(dir);
  open.push(store);
  const identity = await loadOrCreateServerIdentity(dir);
  await store.submit((tx) => bindServerIdentity(tx, identity));
  const roster = await RosterStore.open(store, identity, { now, log: (line) => logs.push(line) });
  return { dir, store, identity, roster, setup: new ClusterSetup(roster), logs };
}

async function deviceKeys() {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  const keys = { sign: toBase64Url(signPub), dh: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", dh.publicKey))) };
  return { keys, member: await memberIdFromKey(signPub) };
}

/** Builds s1 (root) + s2 + s3 (joined through s1), with a phone paired to s1 and a phone paired to s2, all synced. */
async function clusterWithThreeServers() {
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
  const addS3 = await s1.roster.addServer({ keys: s3.identity.keys, name: "Server Three" });
  const addS3Stmt = s1.roster.statements().find((item) => item.id === addS3.addId)!.statement;
  await s3.roster.joinCluster({
    add: addS3Stmt,
    roster: s1.roster.statements().map((item) => item.statement),
    sponsor: { member: s1.identity.memberId, keys: s1.identity.keys, name: "Root One" },
  });

  const phone1 = await deviceKeys();
  const addPhone1 = await s1.roster.addDevice({ keys: phone1.keys, name: "Phone One" });
  const phone2 = await deviceKeys();
  await s2.roster.addDevice({ keys: phone2.keys, name: "Phone Two" });

  const all = [...s1.roster.statements(), ...s2.roster.statements(), ...s3.roster.statements()].map((item) => item.statement);
  await s1.roster.merge(all);
  await s2.roster.merge(all);
  await s3.roster.merge(all);

  return { s1, s2, s3, phone1, addPhone1, addS2, addS3, phone2, code: started.code, tick };
}

async function rawSeedFromCode(typed: string): Promise<Uint8Array> {
  const normal = normalizeRecoveryCode(typed)!;
  const enc = new TextEncoder();
  const ikm = await crypto.subtle.importKey("raw", enc.encode(normal), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: enc.encode(RECOVERY_SALT), info: enc.encode(RECOVERY_INFO) },
      ikm,
      256,
    ),
  );
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

describe("M4-08: reroot from the recovery code", () => {
  it("1. a wrong or malformed code is refused with bad-code, and nothing is written", async () => {
    const { s1, s2, code } = await clusterWithThreeServers();
    const beforeStmts = s2.roster.statements().map((item) => item.id);
    const beforeAudits = readAudits(s2.store.openReader()).length;
    const wrongCode = newRecoveryCode();
    expect(wrongCode).not.toBe(normalizeRecoveryCode(code));

    let thrown: unknown;
    try {
      await s2.roster.reroot({ code: wrongCode, oldRootLost: false, keep: [] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RosterError);
    expect((thrown as RosterError).reason).toBe("bad-code");
    expect((thrown as Error).message).not.toContain(wrongCode);

    await expect(s2.roster.reroot({ code: "not-a-code!", oldRootLost: true, keep: [] })).rejects.toMatchObject({ reason: "bad-code" });
    expect(s2.roster.statements().map((item) => item.id)).toEqual(beforeStmts);
    expect(readAudits(s2.store.openReader()).length).toBe(beforeAudits);
    expect(s2.roster.view.root?.root).toBe(s1.identity.memberId);
    expect(s2.roster.view.root?.gen).toBe(1);
  });

  it("2. the right code on s2: Root{2, root: s2} counts, and s2 is the root on every view with the same statements", async () => {
    const { s1, s2, s3, code } = await clusterWithThreeServers();
    const res = await s2.roster.reroot({ code: code.toLowerCase().replace(/-/g, " "), oldRootLost: false, keep: [] });
    expect(res.gen).toBe(2);
    expect(res.revokeId).toBeNull();

    const root2 = s2.roster.statements().find((item) => item.id === res.rootId)?.statement;
    expect(root2?.signer).toBe("recovery");
    expect(root2?.body).toMatchObject({
      type: "root",
      cluster: s2.roster.clusterId,
      gen: 2,
      root: s2.identity.memberId,
      recoveryPub: s1.roster.view.root?.recoveryPub,
      keep: [],
      prev: s1.roster.view.root?.id,
    });

    const audits = readAudits(s2.store.openReader());
    expect(audits[0]).toMatchObject({ act: "root.change", statement: res.rootId, by: "recovery", member: s2.identity.memberId });

    // Sync to s1 and s3: every view agrees s2 is the gen-2 root.
    await s1.roster.merge([root2!]);
    await s3.roster.merge([root2!]);
    for (const srv of [s1, s2, s3]) {
      expect(srv.roster.view.root?.id).toBe(res.rootId);
      expect(srv.roster.view.root?.gen).toBe(2);
      expect(srv.roster.view.root?.root).toBe(s2.identity.memberId);
    }

    // Reopen persists the new root.
    await s2.store.close();
    open.splice(open.indexOf(s2.store), 1);
    const reopenedStore = await openServerStore(s2.dir);
    open.push(reopenedStore);
    const reopened = await RosterStore.open(reopenedStore, s2.identity);
    expect(reopened.view.root?.id).toBe(res.rootId);
    expect(reopened.view.root?.root).toBe(s2.identity.memberId);
  });

  it("3. with oldRootLost: the old root is invalid, cascade is false, seen is filled, and members it paired stay valid", async () => {
    const { s1, s2, s3, phone1, addPhone1, addS2, addS3, phone2, code } = await clusterWithThreeServers();
    const prefs = await PrefsStore.open(s2.store, { self: s2.identity.memberId });
    const gossip = new Gossip({ roster: s2.roster, prefs, log: () => undefined });
    gossip.start();
    const sent: WireMessage[] = [];
    const session: GossipSession = {
      peer: s3.identity.memberId,
      state: "open",
      sendWire: (msg) => { sent.push(msg); return true; },
      bye: () => undefined,
    };
    gossip.opened(session);
    await new Promise((r) => setTimeout(r, 10));
    sent.length = 0;

    const changes: RosterChange[] = [];
    s2.roster.onChange((c) => changes.push(c));

    const res = await s2.roster.reroot({ code, oldRootLost: true, keep: [] });
    expect(res.gen).toBe(2);
    expect(res.revokeId).toBeTruthy();

    // One commit notified listeners once with old root invalidated, members kept.
    expect(changes).toHaveLength(1);
    expect(changes[0].invalidated).toEqual([s1.identity.memberId]);

    expect(s2.roster.isValid(s1.identity.memberId)).toBe(false);
    expect(s2.roster.isValid(s2.identity.memberId)).toBe(true);
    expect(s2.roster.isValid(s3.identity.memberId)).toBe(true);
    expect(s2.roster.isValid(phone1.member)).toBe(true);
    expect(s2.roster.isValid(phone2.member)).toBe(true);

    const revStmt = s2.roster.statements().find((item) => item.id === res.revokeId)?.statement;
    expect(revStmt?.signer).toBe(s2.identity.memberId);
    expect(revStmt?.body).toMatchObject({
      type: "revoke",
      cluster: s2.roster.clusterId,
      member: s1.identity.memberId,
      by: s2.identity.memberId,
      gen: 2,
      cascade: false,
    });
    if (revStmt?.body.type === "revoke") {
      // s1's joining Adds held by s2: addS2, addS3, addPhone1 (excludes s1's write-back if any).
      expect(revStmt.body.seen).toEqual([addS2.addId, addS3.addId, addPhone1.addId].sort());
    }

    // Both audit rows written in the same commit.
    const audits = readAudits(s2.store.openReader());
    expect(audits.some((a) => a.act === "root.change" && a.statement === res.rootId)).toBe(true);
    expect(audits.some((a) => a.act === "server.revoke" && a.statement === res.revokeId && a.member === s1.identity.memberId)).toBe(true);

    // Gossip pushed both Root{2} and Revoke{s1} immediately on onChange.
    const pushedStmts = sent
      .filter((msg): msg is Extract<WireMessage, { t: "roster.statements" }> => msg.t === "roster.statements")
      .flatMap((msg) => msg.statements as SignedStatement[]);
    expect(pushedStmts.some((stmt) => stmt.body.type === "root" && stmt.body.gen === 2 && stmt.body.root === s2.identity.memberId)).toBe(true);
    expect(pushedStmts.some((stmt) => stmt.body.type === "revoke" && stmt.body.member === s1.identity.memberId)).toBe(true);
    gossip.close();
  });

  it("4. without oldRootLost: the old root stays a valid member, and can no longer revoke servers", async () => {
    const { s1, s2, s3, code } = await clusterWithThreeServers();
    const res = await s2.roster.reroot({ code, oldRootLost: false, keep: [] });
    expect(res.revokeId).toBeNull();
    expect(s2.roster.isValid(s1.identity.memberId)).toBe(true);
    expect(s2.roster.view.root?.root).toBe(s2.identity.memberId);

    const root2 = s2.roster.statements().find((item) => item.id === res.rootId)!.statement;
    await s1.roster.merge([root2]);
    expect(s1.roster.isValid(s1.identity.memberId)).toBe(true);
    await expect(s1.roster.revokeServer(s3.identity.memberId, true)).rejects.toMatchObject({ reason: "server-revoke-root-only" });
  });

  it("5. two reroots at the same gen on two servers (partition): every view picks the one with the smaller id", async () => {
    const { s1, s2, s3, code } = await clusterWithThreeServers();
    const r2 = await s2.roster.reroot({ code, oldRootLost: false, keep: [] });
    const r3 = await s3.roster.reroot({ code, oldRootLost: false, keep: [] });
    expect(r2.gen).toBe(2);
    expect(r3.gen).toBe(2);
    expect(r2.rootId).not.toBe(r3.rootId);

    const stmt2 = s2.roster.statements().find((item) => item.id === r2.rootId)!.statement;
    const stmt3 = s3.roster.statements().find((item) => item.id === r3.rootId)!.statement;

    // Merge in opposite orders on s1, s2, s3.
    await s1.roster.merge([stmt3, stmt2]);
    await s2.roster.merge([stmt3]);
    await s3.roster.merge([stmt2]);

    const winnerId = r2.rootId < r3.rootId ? r2.rootId : r3.rootId;
    const winnerMember = r2.rootId < r3.rootId ? s2.identity.memberId : s3.identity.memberId;
    for (const srv of [s1, s2, s3]) {
      expect(srv.roster.view.root?.id).toBe(winnerId);
      expect(srv.roster.view.root?.root).toBe(winnerMember);
    }
  });

  it("6. byte scan of the data folder after reroot finds neither the code (in 5 spellings) nor the private key", async () => {
    const { s2, code } = await clusterWithThreeServers();
    const raw = normalizeRecoveryCode(code)!;
    const seed = await rawSeedFromCode(code);
    try {
      await s2.roster.reroot({ code, oldRootLost: true, keep: [] });
      const spellings = [
        raw, // 1. uppercase no separators
        raw.match(/.{1,4}/g)!.join("-"), // 2. uppercase dashes
        raw.match(/.{1,4}/g)!.join(" "), // 3. uppercase spaces
        raw.toLowerCase(), // 4. lowercase no separators
        raw.toLowerCase().match(/.{1,4}/g)!.join("-"), // 5. lowercase dashes
        raw.toLowerCase().match(/.{1,4}/g)!.join(" "), // 6. lowercase spaces
      ];
      const keyPatterns: Buffer[] = [
        Buffer.from(seed),
        Buffer.from(toHex(seed), "utf8"),
        Buffer.from(toBase64Url(seed), "utf8"),
        ...spellings.map((s) => Buffer.from(s, "utf8")),
      ];

      const scan = () => {
        for (const file of walkFiles(s2.dir)) {
          const bytes = readFileSync(file);
          for (const pat of keyPatterns) {
            expect(bytes.indexOf(pat), `secret pattern found in ${file}`).toBe(-1);
          }
        }
      };

      // Scan while DB (and any WAL) is open, then close and scan again.
      scan();
      await s2.store.close();
      open.splice(open.indexOf(s2.store), 1);
      scan();

      // Nothing sensitive in logs either.
      const logText = s2.logs.join("\n");
      for (const s of spellings) expect(logText).not.toContain(s);
    } finally {
      seed.fill(0);
    }
  });

  it("7. a revocation by the old root not in keep stops counting (member comes back); one in keep stays revoked", async () => {
    const { s1, s2, s3, code, tick } = await clusterWithThreeServers();
    const s4 = await makeServer(tick);
    const addS4 = await s1.roster.addServer({ keys: s4.identity.keys, name: "Server Four" });
    const addS4Stmt = s1.roster.statements().find((item) => item.id === addS4.addId)!.statement;
    await s4.roster.joinCluster({
      add: addS4Stmt,
      roster: s1.roster.statements().map((item) => item.statement),
      sponsor: { member: s1.identity.memberId, keys: s1.identity.keys, name: "Root One" },
    });
    const synced = [...s1.roster.statements(), ...s4.roster.statements()].map((item) => item.statement);
    await s1.roster.merge(synced);
    await s2.roster.merge(synced);
    await s3.roster.merge(synced);
    await s4.roster.merge(synced);

    // Old root s1 revokes s3 and s4 (and even s2 itself!).
    const revS3 = await s1.roster.revokeServer(s3.identity.memberId, false, "old-real");
    const revS4 = await s1.roster.revokeServer(s4.identity.memberId, false, "thief-revoke");
    const revS2 = await s1.roster.revokeServer(s2.identity.memberId, false, "thief-locked-s2");
    const withRevokes = s1.roster.statements().map((item) => item.statement);
    await s2.roster.merge(withRevokes);
    await s3.roster.merge(withRevokes);
    await s4.roster.merge(withRevokes);

    // s2 is self-revoked now, yet reroot is still allowed on it!
    expect(s2.roster.isValid(s2.identity.memberId)).toBe(false);
    expect(s2.roster.isValid(s3.identity.memberId)).toBe(false);
    expect(s2.roster.isValid(s4.identity.memberId)).toBe(false);
    expect(s4.roster.isValid(s4.identity.memberId)).toBe(false);

    // Reroot on s2 keeping only revS3 (leaving out revS4 and revS2).
    const res = await s2.roster.reroot({ code, oldRootLost: false, keep: [revS3.revokeId] });
    const root2 = s2.roster.statements().find((item) => item.id === res.rootId)!.statement;
    await s1.roster.merge([root2]);
    // s4 and s3 were self-revoked, so they receive Root{2} via the D47 exchange (mergeRevocations).
    await s4.roster.mergeRevocations([root2]);
    await s3.roster.mergeRevocations([root2]);

    for (const srv of [s1, s2, s4]) {
      expect(srv.roster.isValid(s2.identity.memberId)).toBe(true);
      expect(srv.roster.isValid(s3.identity.memberId)).toBe(false);
      expect(srv.roster.isValid(s4.identity.memberId)).toBe(true);
    }
    expect(s3.roster.view.root?.id).toBe(res.rootId);
    expect(s3.roster.isValid(s3.identity.memberId)).toBe(false);
  });

  it("refuses already-root, no-cluster, and invalid keep entries without writing anything", async () => {
    const { s1, s2, addPhone1, addS2, code } = await clusterWithThreeServers();
    const beforeS1 = s1.roster.statements().map((item) => item.id);
    await expect(s1.roster.reroot({ code, oldRootLost: false, keep: [] })).rejects.toMatchObject({ reason: "already-root" });
    expect(s1.roster.statements().map((item) => item.id)).toEqual(beforeS1);

    // Unclustered server refuses with no-cluster.
    const fresh = await makeServer();
    await expect(fresh.roster.reroot({ code, oldRootLost: false, keep: [] })).rejects.toMatchObject({ reason: "no-cluster" });

    // Unknown id, Add id, Root id, or device revocation id in keep are refused with bad-keep.
    const phone = await deviceKeys();
    const addedDev = await s1.roster.addDevice({ keys: phone.keys, name: "Temp Phone" });
    const devRevoke = await s1.roster.revokeDevice(addedDev.member);
    await s2.roster.merge(s1.roster.statements().map((item) => item.statement));
    const beforeS2 = s2.roster.statements().map((item) => item.id);

    await expect(s2.roster.reroot({ code, oldRootLost: false, keep: ["0".repeat(64)] })).rejects.toMatchObject({ reason: "bad-keep" });
    await expect(s2.roster.reroot({ code, oldRootLost: false, keep: [addS2.addId] })).rejects.toMatchObject({ reason: "bad-keep" });
    await expect(s2.roster.reroot({ code, oldRootLost: false, keep: [addPhone1.addId] })).rejects.toMatchObject({ reason: "bad-keep" });
    await expect(s2.roster.reroot({ code, oldRootLost: false, keep: [s2.roster.view.root!.id] })).rejects.toMatchObject({ reason: "bad-keep" });
    await expect(s2.roster.reroot({ code, oldRootLost: false, keep: [devRevoke.revokeId] })).rejects.toMatchObject({ reason: "bad-keep" });

    expect(s2.roster.statements().map((item) => item.id)).toEqual(beforeS2);
  });
});
