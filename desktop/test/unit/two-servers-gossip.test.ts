// Botling 3 M3 step 5 (m3-brief §4 row 5): roster and preference gossip between real botlingd on this machine. Three
// servers (A, B, C) from the two-server harness, each behind a fault proxy (each advertises its proxy's port in its own
// address Profile, so every peer session runs through a proxy).
//
// Start state, written into each server.db while it is stopped:
//   - A and B: Root{1, root A}, each one's Add of the other; each holds the other's address Profile.
//   - C: joined through A only (A's Add of C, C's write-back Add of A, A's address). B holds nothing of C.
// Then:
//   - B learns C (its Add and its own address Profile) only through gossip with A, dials C, and the three converge
//     (same statement set; every server endorses each server it did not add exactly once).
//   - A phone paired on B (a real pairing over B's /v3/ws) is let in by A and by C after the gossip.
//   - Revoked on A: its live session on B gets `bye{revoked}` within a second or two (connected peers).
//   - A second phone revoked on A while every proxy is partitioned: B still lets it in (the honest limit), and once
//     the partition heals its session on B ends with `bye{revoked}`; it is never let in again anywhere.
//   - Preferences set on different servers converge to each key's (hlc, writer) maximum.
// Requires `npm run build` (out/server/main.cjs).
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comparePrefVersions, type PrefRow } from "../../src/protocol";
import { parseStored } from "../../src/server/roster";
import { until } from "../helpers";
import type { FaultProxy } from "../support/fault-proxy";
import { makeCluster, profile, readServerKeys, sign, writeStatements, type MemberKeysInfo } from "../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../support/two-servers";
import { admin, pairPhone, PhoneSession, type DeviceKeys } from "../support/ws-device";

const TIMERS = { ping: 300, dead: 1_500, redial: 150, redialMax: 1_000, revoked: 2_500 };
const TIMERS_ENV = { BOTLING_SERVER_PEER_TIMERS: Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(",") };

let cluster: TestCluster;
let a: TestServer, b: TestServer, c: TestServer;
let ka: MemberKeysInfo, kb: MemberKeysInfo, kc: MemberKeysInfo;
let pa: FaultProxy, pb: FaultProxy, pc: FaultProxy;
let clusterId: string;

function withDb<T>(server: TestServer, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout = 10000"); return run(db); } finally { db.close(); }
}
const rosterIds = (server: TestServer) => withDb(server, (db) => (db.prepare("SELECT id FROM roster ORDER BY id").all() as Array<{ id: string }>).map((row) => String(row.id)));
function statementsOf(server: TestServer) {
  return withDb(server, (db) => (db.prepare("SELECT bytes FROM roster").all() as Array<{ bytes: Uint8Array | string }>).flatMap((row) => {
    const parsed = parseStored(typeof row.bytes === "string" ? new TextEncoder().encode(row.bytes) : row.bytes);
    return parsed ? [{ statement: parsed }] : [];
  }));
}
const prefsOf = (server: TestServer) => withDb(server, (db) => (db.prepare("SELECT key, value, hlc, writer FROM prefs ORDER BY key").all() as Array<Record<string, string>>)
  .map((row) => ({ key: row.key, value: JSON.parse(row.value!), hlc: (({ ms, c }) => ({ ms, c }))(JSON.parse(row.hlc!)), writer: row.writer })));
const live = (server: TestServer, peer: MemberKeysInfo) => new RegExp(`peer ${peer.memberId}: live`).test(server.log);

async function converged(what: string, timeout = 30_000): Promise<string[]> {
  return until(() => {
    const ids = [rosterIds(a), rosterIds(b), rosterIds(c)].map((list) => list.join(","));
    return ids[0] === ids[1] && ids[1] === ids[2] ? rosterIds(a) : null;
  }, { timeout, every: 100, what });
}

/** Endorse rows per (signer, member) at one server. */
function endorsements(server: TestServer): Map<string, number> {
  const counts = new Map<string, number>();
  for (const stored of statementsOf(server)) {
    const body = stored.statement.body;
    if (body.type !== "endorse") continue;
    const key = `${body.by} ${body.member}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const server = (k: MemberKeysInfo) => ({ memberId: k.memberId, dh: k.dh });

beforeAll(async () => {
  cluster = await startServers({ name: "gossip", count: 3, env: { A: TIMERS_ENV, B: TIMERS_ENV, C: TIMERS_ENV } });
  ({ a, b } = cluster);
  c = cluster.server("C");
  await Promise.all([a.stop(), b.stop(), c.stop()]);
  [ka, kb, kc] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir), readServerKeys(c.dataDir)]);
  // Proxies before the restart: each server advertises its proxy's port in its own address Profile.
  pa = await cluster.proxy(a, "websocket");
  pb = await cluster.proxy(b, "websocket");
  pc = await cluster.proxy(c, "websocket");
  const made = await makeCluster([ka, kb]);
  clusterId = made.clusterId;
  const addC = await sign({ type: "add", cluster: clusterId, member: kc.memberId, kind: "server", keys: { sign: kc.sign, dh: kc.dh }, name: "server C", by: ka.memberId, at: 1_700_000_000_000, joined: true }, ka);
  const addA = await sign({ type: "add", cluster: clusterId, member: ka.memberId, kind: "server", keys: { sign: ka.sign, dh: ka.dh }, name: "server A", by: kc.memberId, at: 1_700_000_000_000, joined: true }, kc);
  writeStatements(a.dataDir, clusterId, [...made.statements, addC, addA, await profile(clusterId, kb, kb, pb.port)]);
  writeStatements(b.dataDir, clusterId, [...made.statements, await profile(clusterId, ka, ka, pa.port)]);
  writeStatements(c.dataDir, clusterId, [made.root, addC, addA, await profile(clusterId, ka, ka, pa.port)]);
  expect(rosterIds(b).length).toBe(made.statements.length + 1);
  await Promise.all([a.start(), b.start(), c.start()]);
}, 120_000);

afterAll(async () => { await cluster?.cleanup(); }, 60_000);

describe("M3 step 5: roster and preference gossip between botlingd", () => {
  it("B learns C through A's gossip, dials it, and the three converge; every server endorses each other server once", async () => {
    await until(() => live(b, kc) && live(c, kb), { timeout: 45_000, what: "B and C live with each other (C known to B only by gossip)" });
    const ids = await converged("same roster at A, B and C");
    // The set holds C's own address Profile (C wrote it; B has it only by gossip) and B's of C's Add.
    const atB = statementsOf(b);
    expect(atB.some(({ statement }) => statement.body.type === "profile" && statement.body.member === kc.memberId && statement.signer === kc.memberId)).toBe(true);
    expect(atB.some(({ statement }) => statement.body.type === "add" && statement.body.member === kc.memberId)).toBe(true);
    // Endorse: exactly once per (signer, member it did not add), the same at every server.
    await until(() => {
      const counts = endorsements(a);
      return [`${kb.memberId} ${kc.memberId}`, `${kc.memberId} ${kb.memberId}`].every((key) => counts.get(key) === 1) ? counts : null;
    }, { timeout: 30_000, what: "the endorsements of C and B" });
    await converged("same roster after the endorsements");
    for (const s of [a, b, c]) for (const [key, count] of endorsements(s)) expect(count, `${key} at ${s.name}`).toBe(1);
    expect(ids.length).toBeGreaterThan(5);
    for (const s of [a, b, c]) s.assertLoopbackOnly({ expectListener: true });
    expect(b.log).toMatch(/gossip: peer \S+: took \d+ statement/);
  }, 120_000);

  it("a phone paired on B is let in by A and C after the gossip; revoked on A, its live session on B ends at once", async () => {
    const clientB = await b.client("pairing", "b".repeat(32));
    const clientA = await a.client("admin", "a".repeat(32));
    const { keys, addId } = await pairPhone(clientB, b.port);
    await until(() => rosterIds(a).includes(addId) && rosterIds(c).includes(addId), { timeout: 30_000, what: "the phone's Add at A and C" });
    const onA = await PhoneSession.open(keys, a.port, server(ka), clusterId);
    const onC = await PhoneSession.open(keys, c.port, server(kc), clusterId);
    const onB = await PhoneSession.open(keys, b.port, server(kb), clusterId);
    await until(() => onA.welcomed && onB.welcomed && onC.welcomed, { what: "welcome at A, B and C" });

    const at = Date.now();
    await admin(clientA, { op: "device.revoke", deviceId: keys.member, reason: "test" });
    await until(() => onB.ended && onC.ended && onA.ended, { timeout: 10_000, what: "the phone's sessions end everywhere" });
    expect(Date.now() - at).toBeLessThan(5_000);
    expect(onB.bye()?.reason).toBe("revoked");
    expect(onC.bye()?.reason).toBe("revoked");
    // Never let in again anywhere.
    await expectRefused(keys);
    clientA.close(); clientB.close();
    await converged("same roster after the revoke");
  }, 120_000);

  it("revoked on A during a partition: B lets the phone in until the statement arrives, then ends it; never valid again", async () => {
    const clientB = await b.client("pairing2", "c".repeat(32));
    const clientA = await a.client("admin2", "d".repeat(32));
    const { keys, addId } = await pairPhone(clientB, b.port, "Phone 2");
    await until(() => rosterIds(a).includes(addId), { timeout: 30_000, what: "the second phone's Add at A" });
    for (const p of [pa, pb, pc]) p.partition();
    await admin(clientA, { op: "device.revoke", deviceId: keys.member, reason: "partitioned" });
    // B has not heard: a new session there is let in (the honest limit, §4.6).
    const onB = await PhoneSession.open(keys, b.port, server(kb), clusterId);
    await until(() => onB.welcomed, { what: "welcome at B during the partition" });
    await sleep(500);
    expect(onB.ended).toBeNull();
    for (const p of [pa, pb, pc]) p.heal();
    await until(() => onB.ended, { timeout: 30_000, what: "B ends the phone's session after the heal" });
    expect(onB.bye()?.reason).toBe("revoked");
    await converged("same roster after the heal", 45_000);
    await expectRefused(keys);
    clientA.close(); clientB.close();
  }, 120_000);

  it("preferences set on different servers converge to each key's (hlc, writer) maximum", async () => {
    const clients = await Promise.all([a.client("prefsA", "1".repeat(32)), b.client("prefsB", "2".repeat(32)), c.client("prefsC", "3".repeat(32))]);
    const written: PrefRow[] = [];
    for (let round = 0; round < 3; round++) {
      for (const [i, client] of clients.entries()) {
        written.push((await admin(client, { op: "prefs.set", key: "theme", value: `t${round}${i}` }) as { row: PrefRow }).row);
        written.push((await admin(client, { op: "prefs.set", key: `own.s${i}`, value: { round } }) as { row: PrefRow }).row);
      }
    }
    // A cut mid-way: the next session catches up through prefs.have / prefs.ids.
    pb.cut();
    written.push((await admin(clients[1]!, { op: "prefs.set", key: "theme", value: "after-cut" }) as { row: PrefRow }).row);
    const best = new Map<string, PrefRow>();
    for (const row of written) { const held = best.get(row.key); if (!held || comparePrefVersions(held, row) < 0) best.set(row.key, row); }
    const expected = [...best.values()].sort((x, y) => (x.key < y.key ? -1 : 1));
    await until(() => [a, b, c].every((s) => JSON.stringify(prefsOf(s)) === JSON.stringify(expected)), { timeout: 30_000, what: "the same preferences everywhere" });
    const listed = await admin(clients[2]!, { op: "prefs.list" }) as { rows: PrefRow[] };
    expect(listed.rows).toEqual(expected);
    expect(expected.find((row) => row.key === "theme")?.value).toBe("after-cut");
    for (const client of clients) client.close();
  }, 120_000);
});

/** A revoked phone's new sessions are refused at every server (its handshake or first frame ends it). */
async function expectRefused(keys: DeviceKeys): Promise<void> {
  for (const [s, k] of [[a, ka], [b, kb], [c, kc]] as const) {
    const session = await PhoneSession.open(keys, s.port, server(k), clusterId);
    await until(() => session.ended, { timeout: 10_000, what: `a new session of the revoked phone at ${s.name} ends` });
    expect(session.welcomed, `revoked phone let in at ${s.name}`).toBe(false);
  }
}
