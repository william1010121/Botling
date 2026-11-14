// Botling 3 M2 step 2: server identity, cluster creation with the recovery code, the roster store, device revoke and
// audit rows (src/server/identity, src/server/roster). Real WebCrypto keys and a real server.db in a temp folder.
// - keys: made once, server-keys.json 0600 in a 0700 folder, private keys non-extractable, serverId from the signing
//   key, a damaged / swapped / missing keys file refused, server.db bound to the member id;
// - recovery code: 26 base32 characters (130 bits), groups of four, the key derived the same from any spelling;
// - cluster: made only after the code is typed back; a wrong, malformed or late code changes nothing; the code is
//   found nowhere in the data folder afterwards (byte scan of every file, WAL included) nor in the log;
// - roster store: Add / Revoke of a device with audit rows in the srv: table stream, listeners told, idempotent revoke,
//   a revoked key refused on re-pairing, a server not revocable here, everything kept across a reopen;
// - with a second server merged in: this server endorses what that server added (Endorse, self), so the device stays
//   valid when the root revokes that server without the cascade, and goes with it with the cascade;
// - botlingd (the built server, plain Node): keys made on the first start, the welcome names the member id, a restart
//   keeps it.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { clusterIdFromRecoveryKey, fromBase64Url, memberIdFromKey, toBase64Url, type SignedStatement, type StatementBody } from "../../src/protocol";
import {
  bindServerIdentity, CLUSTER_SETUP_TTL_MS, ClusterSetup, formatRecoveryCode, KEYS_FILE, loadOrCreateServerIdentity, newRecoveryCode,
  normalizeRecoveryCode, recoveryKeyFromCode, ServerIdentityError,
} from "../../src/server/identity";
import { readAudits, RosterError, RosterStore, signStatement, signWith, type RosterChange } from "../../src/server/roster";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { BotlingdProcess, ScriptClient, testRoot } from "../botlingd-harness";

const root = testRoot("roster");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const open: ServerStore[] = [];
afterEach(async () => { for (const store of open.splice(0)) await store.close(); });

let n = 0;
function folder(): string {
  const dir = join(root, `d${++n}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function server(dir = folder(), log: string[] = []) {
  const store = await openServerStore(dir);
  open.push(store);
  const identity = await loadOrCreateServerIdentity(dir, { create: store.meta("memberId") === undefined });
  const bound = await store.submit((tx) => bindServerIdentity(tx, identity));
  const roster = await RosterStore.open(store, identity, { log: (line) => log.push(line) });
  const setup = new ClusterSetup(roster);
  return { dir, store, identity, bound, roster, setup, log };
}

async function withCluster(dir?: string) {
  const s = await server(dir);
  const started = await s.setup.begin();
  const confirmed = await s.setup.confirm(started.code);
  expect(confirmed.ok).toBe(true);
  return { ...s, code: started.code, clusterId: started.clusterId };
}

/** A device's (or a second server's) keys made with WebCrypto, as the page would. */
async function memberKeys() {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  const keys = { sign: toBase64Url(signPub), dh: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", dh.publicKey))) };
  return { keys, member: await memberIdFromKey(signPub), signer: signWith(sign.privateKey) };
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

describe("server identity (v1 §3)", () => {
  it("makes the keys once, 0600 in a 0700 folder, serverId from the signing key, private keys not extractable", async () => {
    const dir = folder();
    const first = await loadOrCreateServerIdentity(dir);
    expect(first.created).toBe(true);
    expect(statSync(join(dir, KEYS_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(first.memberId).toMatch(/^[a-z2-7]{26}$/);
    expect(first.memberId).toBe(await memberIdFromKey(first.signPub));
    expect(first.keys.sign).toBe(toBase64Url(first.signPub));
    await expect(crypto.subtle.exportKey("pkcs8", first.signKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("pkcs8", first.dhKey)).rejects.toThrow();

    const again = await loadOrCreateServerIdentity(dir);
    expect(again.created).toBe(false);
    expect(again.memberId).toBe(first.memberId);
    expect(again.keys).toEqual(first.keys);
    // The signature verifies under the public key.
    const message = new TextEncoder().encode("hello");
    const pub = await crypto.subtle.importKey("raw", again.signPub as Uint8Array<ArrayBuffer>, { name: "Ed25519" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "Ed25519" }, pub, (await again.sign(message)) as Uint8Array<ArrayBuffer>, message)).toBe(true);
    // X25519: both sides of a DH agree (the session layer, step 3, uses dhKey).
    const peer = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
    const dhPub = await crypto.subtle.importKey("raw", again.dhPub as Uint8Array<ArrayBuffer>, { name: "X25519" }, true, []);
    const a = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer.publicKey }, again.dhKey, 256));
    const b = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: dhPub }, peer.privateKey, 256));
    expect(a).toEqual(b);
  });

  it("tightens a loose file mode, refuses a damaged or mismatched file and a missing one when server.db names a member", async () => {
    const dir = folder();
    const made = await loadOrCreateServerIdentity(dir);
    const file = join(dir, KEYS_FILE);
    chmodSync(file, 0o644);
    await loadOrCreateServerIdentity(dir);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const text = readFileSync(file, "utf8");
    const parsed = JSON.parse(text);
    const other = await loadOrCreateServerIdentity(folder());
    writeFileSync(file, JSON.stringify({ ...parsed, sign: { ...parsed.sign, pub: other.keys.sign } }), { mode: 0o600 });
    await expect(loadOrCreateServerIdentity(dir)).rejects.toThrow(/does not belong/);
    writeFileSync(file, "{not json", { mode: 0o600 });
    await expect(loadOrCreateServerIdentity(dir)).rejects.toBeInstanceOf(ServerIdentityError);
    writeFileSync(file, text, { mode: 0o600 });
    expect((await loadOrCreateServerIdentity(dir)).memberId).toBe(made.memberId);
    rmSync(file);
    await expect(loadOrCreateServerIdentity(dir, { create: false })).rejects.toThrow(/missing/);
  });

  it("binds server.db: a fresh store is named by the member id; an M1 store keeps its id; another identity is refused", async () => {
    const fresh = await server();
    expect(fresh.bound.serverId).toBe(fresh.identity.memberId);
    expect(fresh.store.meta("serverId")).toBe(fresh.identity.memberId);
    expect(fresh.store.meta("memberId")).toBe(fresh.identity.memberId);
    expect(fresh.store.meta("signPub")).toBe(fresh.identity.keys.sign);

    // An M1 data folder: streams exist under the old serverId.
    const dir = folder();
    const m1 = await openServerStore(dir);
    open.push(m1);
    const oldId = m1.meta("serverId")!;
    await m1.submit((tx) => { tx.prepare("INSERT INTO streams (stream, owner, logId, state) VALUES (?, ?, 'abcdefgh', 'active')").run(`srv:${oldId}`, oldId); });
    const identity = await loadOrCreateServerIdentity(dir);
    const bound = await m1.submit((tx) => bindServerIdentity(tx, identity));
    expect(bound).toEqual({ serverId: oldId, memberId: identity.memberId });

    const stranger = await loadOrCreateServerIdentity(folder());
    await expect(m1.submit((tx) => bindServerIdentity(tx, stranger))).rejects.toThrow(/another server/);
    expect(m1.meta("memberId")).toBe(identity.memberId);
  });
});

describe("recovery code (v1 §4.8, D48)", () => {
  it("is 26 base32 characters shown in groups of four, and any spelling gives the same key", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const code = newRecoveryCode();
      expect(code).toMatch(/^[A-Z2-7]{26}$/);
      codes.add(code);
    }
    expect(codes.size).toBe(50);
    const code = newRecoveryCode();
    const shown = formatRecoveryCode(code);
    expect(shown).toMatch(/^([A-Z2-7]{4}-){6}[A-Z2-7]{2}$/);
    expect(normalizeRecoveryCode(shown.toLowerCase().replace(/-/g, " "))).toBe(code);
    expect(normalizeRecoveryCode(code.slice(1))).toBeNull();
    expect(normalizeRecoveryCode(`${code.slice(1)}1`)).toBeNull();
    const a = await recoveryKeyFromCode(code);
    const b = await recoveryKeyFromCode(shown.toLowerCase());
    expect(a.recoveryPub).toBe(b.recoveryPub);
    expect(a.publicKey).toHaveLength(32);
    expect((await recoveryKeyFromCode(newRecoveryCode())).recoveryPub).not.toBe(a.recoveryPub);
    await expect(crypto.subtle.exportKey("pkcs8", a.privateKey)).rejects.toThrow();
  });
});

describe("cluster creation (v1 §4.8): made only after the code is typed back", () => {
  it("a wrong, malformed or late code changes nothing; the right one stores Root{1} and the cluster id", async () => {
    let now = 1_000_000;
    const s = await server();
    const setup = new ClusterSetup(s.roster, { now: () => now });
    expect(await setup.confirm("ABCD")).toEqual({ ok: false, reason: "no-setup" });
    const started = await setup.begin();
    expect(setup.note()).toMatch(/not typed back/);
    expect(await setup.confirm("not a code")).toEqual({ ok: false, reason: "malformed" });
    expect(await setup.confirm(formatRecoveryCode(newRecoveryCode()))).toEqual({ ok: false, reason: "wrong-code" });
    expect(s.roster.clusterId).toBeNull();
    expect(s.store.meta("clusterId")).toBeUndefined();

    now += CLUSTER_SETUP_TTL_MS + 1;
    expect(await setup.confirm(started.code)).toEqual({ ok: false, reason: "expired" });
    expect(s.roster.clusterId).toBeNull();

    const fresh = await setup.begin();
    expect(fresh.clusterId).not.toBe(started.clusterId);
    const done = await setup.confirm(fresh.code.toLowerCase().replace(/-/g, " "));
    expect(done).toMatchObject({ ok: true, clusterId: fresh.clusterId });
    expect(setup.note()).toBeNull();
    expect(s.store.meta("clusterId")).toBe(fresh.clusterId);
    expect(fresh.clusterId).toBe(await clusterIdFromRecoveryKey((await recoveryKeyFromCode(fresh.code)).publicKey));
    const view = s.roster.view;
    expect(view.root).toMatchObject({ gen: 1, root: s.identity.memberId, recoveryPub: (await recoveryKeyFromCode(fresh.code)).recoveryPub });
    expect(view.valid).toEqual(new Set([s.identity.memberId]));
    expect(readAudits(s.store.openReader())).toEqual([expect.objectContaining({ act: "cluster.create", member: s.identity.memberId, by: "recovery" })]);

    await expect(setup.begin()).rejects.toThrow(/already/);
    expect(await setup.confirm(fresh.code)).toEqual({ ok: false, reason: "cluster-exists" });
  });

  it("the recovery code is in no file of the data folder afterwards (byte scan, WAL included) and not in the log", async () => {
    const log: string[] = [];
    const s = await server(folder(), log);
    const started = await s.setup.begin();
    expect((await s.setup.confirm(started.code)).ok).toBe(true);
    const device = await memberKeys();
    await s.roster.addDevice({ keys: device.keys, name: "Phone" });
    const normal = normalizeRecoveryCode(started.code)!;
    const needles = [normal, normal.toLowerCase(), started.code, started.code.toLowerCase(), started.code.replace(/-/g, " ")].map((text) => Buffer.from(text));
    const scan = () => {
      const files = filesUnder(s.dir);
      expect(files.some((file) => file.endsWith("server.db"))).toBe(true);
      expect(files.some((file) => file.endsWith(KEYS_FILE))).toBe(true);
      for (const file of files) {
        const bytes = readFileSync(file);
        for (const needle of needles) expect(bytes.includes(needle), `${file} holds the recovery code`).toBe(false);
      }
    };
    scan(); // while open (the WAL holds the last commits)
    await s.store.close();
    open.splice(open.indexOf(s.store), 1);
    scan(); // after the checkpoint
    for (const line of log) for (const needle of needles) expect(line.includes(needle.toString())).toBe(false);
  });
});

describe("roster store: devices (v1 §4.3, §4.4, §4.6)", () => {
  it("adds a device with the default scope, revokes it (listeners told, audit rows), refuses its key again, keeps it all across a reopen", async () => {
    const s = await withCluster();
    const changes: RosterChange[] = [];
    s.roster.onChange((change) => changes.push(change));
    const phone = await memberKeys();
    const added = await s.roster.addDevice({ keys: phone.keys, name: "Phone" });
    expect(added).toMatchObject({ member: phone.member, created: true });
    expect(s.roster.device(phone.member)).toMatchObject({ kind: "device", name: "Phone", scope: ["read", "reply", "approve"], keys: phone.keys, by: s.identity.memberId });
    expect(await s.roster.addDevice({ keys: phone.keys, name: "Phone" })).toMatchObject({ member: phone.member, created: false, addId: added.addId });

    const reader = await memberKeys();
    await s.roster.addDevice({ keys: reader.keys, name: "Tablet", scope: ["read"] });
    expect(s.roster.device(reader.member)?.scope).toEqual(["read"]);

    const revoked = await s.roster.revokeDevice(phone.member, "lost");
    expect(revoked.already).toBe(false);
    // The view is already swapped when the act resolves.
    expect(s.roster.isValid(phone.member)).toBe(false);
    expect(s.roster.device(phone.member)).toBeNull();
    expect(s.roster.isValid(reader.member)).toBe(true);
    expect(changes.at(-1)!.invalidated).toEqual([phone.member]);
    expect(await s.roster.revokeDevice(phone.member)).toEqual({ revokeId: revoked.revokeId, already: true });
    await expect(s.roster.addDevice({ keys: phone.keys, name: "Phone" })).rejects.toMatchObject({ reason: "revoked" });
    await expect(s.roster.revokeDevice(s.identity.memberId)).rejects.toMatchObject({ reason: "server-revoke-root-only" });
    await expect(s.roster.revokeDevice("aaaaaaaaaaaaaaaaaaaaaaaaaa")).rejects.toMatchObject({ reason: "not-a-device" });
    await expect(s.roster.addDevice({ keys: { sign: "x", dh: "y" }, name: "Bad" })).rejects.toBeInstanceOf(RosterError);

    const audits = readAudits(s.store.openReader());
    expect(audits.map((audit) => audit.act)).toEqual(["device.revoke", "device.add", "device.add", "cluster.create"]);
    expect(audits[0]).toMatchObject({ member: phone.member, by: s.identity.memberId, statement: revoked.revokeId, reason: "lost", name: "Phone" });
    const rows = s.store.openReader().prepare("SELECT stream, key, rev FROM rows WHERE key LIKE 'audit:%' ORDER BY rev").all();
    expect(rows.map((row) => String(row.stream))).toEqual(Array(4).fill(`srv:${s.bound.serverId}`));
    expect(rows.map((row) => Number(row.rev))).toEqual([1, 2, 3, 4]);

    // Reopen: same statements, digest and validity.
    const digest = await s.roster.digest();
    const ids = s.roster.statements().map((item) => item.id);
    await s.store.close();
    open.splice(open.indexOf(s.store), 1);
    const again = await server(s.dir);
    expect(again.identity.memberId).toBe(s.identity.memberId);
    expect(again.roster.clusterId).toBe(s.clusterId);
    expect(again.roster.statements().map((item) => item.id)).toEqual(ids);
    expect(await again.roster.digest()).toBe(digest);
    expect(again.roster.isValid(phone.member)).toBe(false);
    expect(again.roster.isValid(reader.member)).toBe(true);
    expect(again.roster.view.root?.root).toBe(s.identity.memberId);
  });

  it("refuses device acts before the cluster exists", async () => {
    const s = await server();
    const phone = await memberKeys();
    await expect(s.roster.addDevice({ keys: phone.keys, name: "Phone" })).rejects.toMatchObject({ reason: "no-cluster" });
  });

  it("endorses what another server added; the root's revoke of that server keeps the device without the cascade, removes it with", async () => {
    for (const cascade of [false, true]) {
      const s = await withCluster();
      const cluster = s.clusterId;
      const other = await memberKeys(); // a second server
      const phone = await memberKeys();
      const sign = (body: StatementBody, signer: string, fn: (bytes: Uint8Array) => Promise<Uint8Array>) => signStatement(body, signer, fn);
      // This server adds the other server (its own act would be the M3 server pairing; signed here directly).
      const addOther = await sign({ type: "add", cluster, member: other.member, kind: "server", keys: other.keys, name: "Other", by: s.identity.memberId, at: 1, joined: true }, s.identity.memberId, (b) => s.identity.sign(b));
      const addPhone = await sign({ type: "add", cluster, member: phone.member, kind: "device", keys: phone.keys, name: "Phone", scope: ["read"], by: other.member, at: 2 }, other.member, other.signer);
      const merged = await s.roster.merge([addPhone.statement, addOther.statement]);
      expect(merged.sort()).toEqual([addOther.id, addPhone.id].sort());
      expect(s.roster.isValid(other.member)).toBe(true);
      expect(s.roster.isValid(phone.member)).toBe(true);
      const endorses = s.roster.statements().filter((item) => item.statement.body.type === "endorse");
      expect(endorses.map((item) => item.statement.body)).toEqual([{ type: "endorse", cluster, member: phone.member, addId: addPhone.id, by: s.identity.memberId }]);

      // The root (this server, gen 1) revokes the other server.
      const revoke = await sign({ type: "revoke", cluster, member: other.member, reason: "retired", by: s.identity.memberId, gen: 1, cascade }, s.identity.memberId, (b) => s.identity.sign(b));
      await s.roster.merge([revoke.statement]);
      expect(s.roster.isValid(other.member)).toBe(false);
      expect(s.roster.isValid(phone.member)).toBe(!cascade);

      // A device-signed Revoke of a device never counts.
      const forged = await sign({ type: "revoke", cluster, member: s.identity.memberId, reason: "x", by: phone.member, gen: 1, cascade: [] }, phone.member, phone.signer);
      await s.roster.merge([forged.statement]);
      expect(s.roster.isValid(s.identity.memberId)).toBe(true);
    }
  });

  it("a statement with a bad signature is stored but never counts, and gives way to a copy that verifies", async () => {
    const s = await withCluster();
    const phone = await memberKeys();
    const good = await signStatement({ type: "add", cluster: s.clusterId, member: phone.member, kind: "device", keys: phone.keys, name: "Phone", scope: ["read"], by: s.identity.memberId, at: 5 }, s.identity.memberId, (b) => s.identity.sign(b));
    const tampered: SignedStatement = { ...good.statement, body: { ...good.statement.body, name: "Evil" } as StatementBody };
    await s.roster.merge([tampered]);
    expect(s.roster.isValid(phone.member)).toBe(false);
    // Same body, a bad signature first: stored, never counts; the good copy then replaces it (one row per id).
    const badSig: SignedStatement = { ...good.statement, sig: `${good.statement.sig.startsWith("A") ? "B" : "A"}${good.statement.sig.slice(1)}` };
    expect(await s.roster.merge([badSig])).toEqual([good.id]);
    expect(s.roster.isValid(phone.member)).toBe(false);
    expect(await s.roster.merge([good.statement])).toEqual([good.id]);
    expect(s.roster.isValid(phone.member)).toBe(true);
    expect(await s.roster.merge([badSig])).toEqual([]); // a verifying copy is never replaced
    expect(s.roster.statements().find((item) => item.id === good.id)?.statement.sig).toBe(good.statement.sig);
    const reader = s.store.openReader();
    expect(reader.prepare("SELECT COUNT(*) AS n FROM roster WHERE id = ?").get(good.id)?.n).toBe(1);
    reader.close();
  });
});

describe("botlingd makes its identity on the first start (built out/server/main.cjs, plain Node, no window)", () => {
  it("server-keys.json 0600, the welcome names the member id, a restart keeps it", async () => {
    const dir = join(folder(), "data");
    const ids: string[] = [];
    for (let round = 0; round < 2; round++) {
      const daemon = new BotlingdProcess(dir);
      try {
        await daemon.ready();
        expect(statSync(join(dir, KEYS_FILE)).mode & 0o777).toBe(0o600);
        const keys = JSON.parse(readFileSync(join(dir, KEYS_FILE), "utf8")) as { sign: { pub: string } };
        const member = await memberIdFromKey(fromBase64Url(keys.sign.pub)!);
        const client = new ScriptClient(`roster-${round}`);
        const welcome = await client.connect(daemon.socket, daemon.token);
        client.close();
        expect(welcome.serverId).toBe(member);
        expect(daemon.log).toContain(`identity: member ${member}${round === 0 ? " (new keys)" : ""}, cluster none yet`);
        expect(daemon.log).not.toContain(JSON.parse(readFileSync(join(dir, KEYS_FILE), "utf8")).sign.pkcs8);
        ids.push(member);
      } finally {
        await daemon.stop();
      }
    }
    expect(ids[1]).toBe(ids[0]);
  }, 120_000);
});
