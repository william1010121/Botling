// Roster statements written directly (M3 step 3: peer sessions are tested before server pairing exists, step 4).
// The test holds a recovery key and reads each server's signing key from its `server-keys.json`, so it can sign
// what a real cluster would hold: Root{1} (recovery key), each server's Add of the others, Profiles naming loopback
// addresses, a root's Revoke of a server and a later Root that leaves it out (the recovery key, §4.8).
//
//   const keys = await Promise.all([a, b].map((s) => readServerKeys(s.dataDir)));
//   const cluster = await makeCluster(keys);                       // Root{1, root: keys[0]} + every Add
//   writeStatements(a.dataDir, cluster.clusterId, [...cluster.statements, await profile(keys[1], keys[1], portB)]);
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clusterIdFromRecoveryKey, fromBase64Url, memberIdFromKey, toBase64Url, type StatementBody } from "../../src/protocol";
import { signStatement, signWith, storedBytes, type StoredStatement } from "../../src/server/roster";
import { addressesValue } from "../../src/server/peer";

export interface MemberKeysInfo {
  memberId: string;
  sign: string;
  dh: string;
  signKey: CryptoKey;
}

export interface Recovery { pub: string; key: CryptoKey; clusterId: string }

/** A server's keys from its data folder (the test is the only other reader of this 0600 file). */
export async function readServerKeys(dataDir: string): Promise<MemberKeysInfo> {
  const file = JSON.parse(readFileSync(join(dataDir, "server-keys.json"), "utf8")) as { sign: { pub: string; pkcs8: string }; dh: { pub: string } };
  const signKey = await crypto.subtle.importKey("pkcs8", fromBase64Url(file.sign.pkcs8)! as Uint8Array<ArrayBuffer>, { name: "Ed25519" }, false, ["sign"]);
  return { memberId: await memberIdFromKey(fromBase64Url(file.sign.pub)!), sign: file.sign.pub, dh: file.dh.pub, signKey };
}

/** Keys of a member that no roster names (an unknown server). */
export async function strangerKeys(): Promise<MemberKeysInfo & { dhKey: CryptoKey; dhPub: Uint8Array }> {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]) as CryptoKeyPair;
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  const dhPub = new Uint8Array(await crypto.subtle.exportKey("raw", dh.publicKey));
  return { memberId: await memberIdFromKey(signPub), sign: toBase64Url(signPub), dh: toBase64Url(dhPub), signKey: sign.privateKey, dhKey: dh.privateKey, dhPub };
}

export async function makeRecovery(): Promise<Recovery> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pub: toBase64Url(raw), key: pair.privateKey, clusterId: await clusterIdFromRecoveryKey(raw) };
}

export const sign = (body: StatementBody, by: MemberKeysInfo): Promise<StoredStatement> => signStatement(body, by.memberId, signWith(by.signKey));
export const signRecovery = (body: StatementBody, recovery: Recovery): Promise<StoredStatement> => signStatement(body, "recovery", signWith(recovery.key));

/** Root{1, root: servers[0]} and every server's Add of every other server. */
export async function makeCluster(servers: MemberKeysInfo[], recovery?: Recovery): Promise<{ recovery: Recovery; clusterId: string; root: StoredStatement; statements: StoredStatement[] }> {
  const rec = recovery ?? await makeRecovery();
  const clusterId = rec.clusterId;
  const root = await signRecovery({ type: "root", cluster: clusterId, gen: 1, root: servers[0].memberId, recoveryPub: rec.pub, keep: [], prev: null }, rec);
  const statements: StoredStatement[] = [root];
  for (const by of servers) {
    for (const member of servers) {
      if (member === by) continue;
      statements.push(await sign({ type: "add", cluster: clusterId, member: member.memberId, kind: "server", keys: { sign: member.sign, dh: member.dh }, name: `server ${member.memberId.slice(0, 4)}`, by: by.memberId, at: 1_700_000_000_000 }, by));
    }
  }
  return { recovery: rec, clusterId, root, statements };
}

/** `Profile{member, addresses: {loopback: ws://127.0.0.1:<port>/v3/ws}}`, signed by `by`. */
export function profile(clusterId: string, member: MemberKeysInfo, by: MemberKeysInfo, port: number, ms = Date.now()): Promise<StoredStatement> {
  return sign({ type: "profile", cluster: clusterId, member: member.memberId, field: "addresses", value: addressesValue(port), hlc: { ms, c: 0 } }, by);
}

/** The root's `Revoke{member, gen}` of a server. */
export function revokeServer(clusterId: string, root: MemberKeysInfo, member: MemberKeysInfo, gen = 1): Promise<StoredStatement> {
  return sign({ type: "revoke", cluster: clusterId, member: member.memberId, reason: "test", by: root.memberId, gen, cascade: [] }, root);
}

/** `Root{gen, root, keep, prev}` signed by the recovery key (keep [] drops every earlier server revocation). */
export function nextRoot(recovery: Recovery, prev: StoredStatement, root: MemberKeysInfo, keep: string[] = []): Promise<StoredStatement> {
  const body = prev.statement.body;
  if (body.type !== "root") throw new Error("prev is a Root");
  return signRecovery({ type: "root", cluster: recovery.clusterId, gen: body.gen + 1, root: root.memberId, recoveryPub: recovery.pub, keep, prev: prev.id }, recovery);
}

/** Writes statements (and the cluster id, if not set) into a stopped server's server.db. */
export function writeStatements(dataDir: string, clusterId: string, statements: StoredStatement[]): void {
  const db = new DatabaseSync(join(dataDir, "server.db"));
  try {
    db.exec("BEGIN IMMEDIATE");
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'clusterId'").get() as { value?: string } | undefined;
    if (meta?.value && meta.value !== clusterId) throw new Error("that server belongs to another cluster");
    if (!meta) db.prepare("INSERT INTO meta (key, value) VALUES ('clusterId', ?)").run(clusterId);
    const insert = db.prepare("INSERT INTO roster (id, kind, member, bytes, receivedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING");
    for (const { id, statement } of statements) {
      const body = statement.body;
      insert.run(id, body.type, body.type === "root" ? body.root : body.member, storedBytes(statement), Date.now());
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* none open */ }
    throw error;
  } finally {
    db.close();
  }
}
