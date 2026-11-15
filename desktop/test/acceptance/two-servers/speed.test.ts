// Botling 3 M3 acceptance §5.10 (reported, not gated): speed across two servers on loopback (fake engine, no proxy).
//
//   - forwarded command → outcome at the phone: a phone attached to A sends `chat.react` to a bot owned by B; the time
//     from `cmd` sent to `cmd.result` back, one at a time (idle) and 200 in flight at once (under load). The same for
//     a bot owned by A itself, as the one-server baseline;
//   - summary row fan-out: a bot made on B (on B's own socket) → its row is in A's copy of B's `srv:` table,
//     measured from B's `cmd.result` to the creator.
// First video byte and PDF page 1 through a peer are measured by peer-content.test.ts and media-peer.test.ts.
//
//   npm run build
//   npx vitest run --config test/acceptance/vitest.config.mts test/acceptance/two-servers/speed.test.ts
import { loadavg } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Message, MessageOf, Slot } from "../../../src/protocol";
import type { ScriptClient } from "../../botlingd-harness";
import { until } from "../../helpers";
import { writeReport } from "../m1-accept";
import { makeCluster, profile, readServerKeys, writeStatements, type MemberKeysInfo } from "../../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../../support/two-servers";
import { pairPhone, PhoneSession } from "../../support/ws-device";

const TIMERS = { ping: 300, dead: 1_500, redial: 150, redialMax: 800, revoked: 2_500 };
const TIMERS_ENV = { BOTLING_SERVER_PEER_TIMERS: Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(",") };
const IDLE = 100;
const BURST = 200;
const FANOUT = 20;
const report: Record<string, unknown> = {};

let cluster: TestCluster;
let a: TestServer, b: TestServer;
let ka: MemberKeysInfo, kb: MemberKeysInfo;
let phone: PhoneSession;
const bots: Record<"A" | "B", { botId: string; messageId: string }> = {} as never;

function withDb<T>(server: TestServer, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout = 10000"); return run(db); } finally { db.close(); }
}
const logIdAt = (server: TestServer, stream: string) => withDb(server, (db) => (db.prepare("SELECT logId FROM streams WHERE stream = ?").get(stream) as { logId: string } | undefined)?.logId ?? null);

async function botWithLine(server: TestServer, name: string): Promise<{ botId: string; messageId: string }> {
  const client: ScriptClient = await server.client("script", "d".repeat(32));
  await client.sub(client.srv);
  const snap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
  client.cmd({ origin: "script", originEpoch: client.originEpoch, target: client.srv, n: 1 } as Slot, { type: "bots.create", name, job: "speed test" }, snap.logId);
  const created = await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === 1, "bots.create");
  const botId = (created.outcome as { result: { botId: string } }).result.botId;
  client.cmd({ origin: "script", originEpoch: client.originEpoch, target: `bot:${botId}`, n: 1 } as Slot, { type: "chat.send", botId, text: "/say hello" }, snap.logId);
  await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.target === `bot:${botId}`, "chat.send");
  const messageId = await until(() => withDb(server, (db) => (db.prepare("SELECT msgId FROM messages WHERE botId = ? ORDER BY seq LIMIT 1").get(botId) as { msgId: string } | undefined)?.msgId ?? null), { timeout: 30_000, what: "a line" });
  client.close();
  return { botId, messageId };
}

function stats(values: number[]) {
  const sorted = [...values].sort((x, y) => x - y);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  const round = (x: number) => Math.round(x * 10) / 10;
  return { n: sorted.length, median: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(sorted[sorted.length - 1]!) };
}

let n = 0;
const sent = new Map<string, number>();
const took = new Map<string, number>();
function send(owner: "A" | "B", present: boolean): string {
  const { botId, messageId } = bots[owner];
  const target = `bot:${botId}`;
  const inc = owner === "A" ? logIdAt(a, `srv:${ka.memberId}`) : logIdAt(a, `srv:${kb.memberId}`);
  const slot = { origin: phoneId, originEpoch: "e".repeat(32), target, n: ++slots[target]! } as Slot;
  const key = `${target}#${slot.n}`;
  sent.set(key, performance.now());
  phone.send({ t: "cmd", slot, floor: slot.n, inc, cmd: { type: "chat.react", botId, messageId, emoji: "👍", present } } as Message);
  n++;
  return key;
}
let phoneId = "";
const slots: Record<string, number> = {};

beforeAll(async () => {
  cluster = await startServers({ name: "speed", count: 2, env: { A: TIMERS_ENV, B: TIMERS_ENV } });
  ({ a, b } = cluster);
  await Promise.all([a.stop(), b.stop()]);
  [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
  const made = await makeCluster([ka, kb]);
  writeStatements(a.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, kb, kb, b.port)]);
  writeStatements(b.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, ka, ka, a.port)]);
  await Promise.all([a.start(), b.start()]);
  bots.A = await botWithLine(a, "Here");
  bots.B = await botWithLine(b, "There");
  await until(() => withDb(a, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(`srv:${kb.memberId}`, `bot:${bots.B.botId}`)), { timeout: 30_000, what: "A's copy names B's bot" });
  const local = await a.client("pairing", "f".repeat(32));
  const paired = await pairPhone(local, a.port);
  local.close();
  await until(() => withDb(b, (db) => !!db.prepare("SELECT 1 FROM roster WHERE id = ?").get(paired.addId)), { timeout: 30_000, what: "B has the phone's Add" });
  phoneId = paired.keys.member;
  phone = await PhoneSession.open(paired.keys, a.port, { memberId: ka.memberId, dh: ka.dh }, made.clusterId);
  await until(() => phone.welcomed, { what: "the phone welcomed at A" });
  for (const owner of ["A", "B"] as const) slots[`bot:${bots[owner].botId}`] = 0;
  // Every cmd.result the phone gets, timed as it arrives (the session pushes into `got`).
  const push = phone.got.push.bind(phone.got);
  phone.got.push = (...items: Message[]) => {
    const now = performance.now();
    for (const m of items) if (m.t === "cmd.result" && m.slot.origin === phoneId) took.set(`${m.slot.target}#${m.slot.n}`, now);
    return push(...items);
  };
}, 180_000);

afterAll(async () => {
  phone?.close();
  await cluster?.cleanup();
  report.loadavg = loadavg().map((x) => Math.round(x * 100) / 100);
  writeReport("m3-speed", report);
}, 60_000);

const latency = (keys: string[]) => keys.map((key) => took.get(key)! - sent.get(key)!);

describe("M3 §5.10: speed across two servers (reported)", () => {
  it("forwarded command → outcome, idle and 200 in flight, against a bot on the attached server", async () => {
    // Warm both paths once.
    for (const owner of ["A", "B"] as const) { const key = send(owner, true); await until(() => took.has(key) || null, { timeout: 30_000, what: `warm ${owner}` }); }
    const out: Record<string, unknown> = {};
    for (const owner of ["A", "B"] as const) {
      const idle: string[] = [];
      for (let i = 0; i < IDLE; i++) { const key = send(owner, i % 2 === 0); idle.push(key); await until(() => took.has(key) || null, { timeout: 30_000, every: 1, what: `idle ${owner} ${i}` }); }
      const burst: string[] = [];
      for (let i = 0; i < BURST; i++) burst.push(send(owner, i % 2 === 0));
      await until(() => burst.every((key) => took.has(key)) || null, { timeout: 120_000, every: 5, what: `burst ${owner}` });
      out[owner === "A" ? "ownBot" : "peerBot"] = { idle: stats(latency(idle)), burst200: stats(latency(burst)) };
    }
    report.command = out;
    const outcomes = phone.got.filter((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.origin === phoneId);
    expect(new Set(outcomes.map((m) => `${m.slot.target}#${m.slot.n}`)).size).toBe(n);
    expect(outcomes.filter((m) => (m.outcome as { ok?: boolean }).ok === false).length, JSON.stringify(outcomes.find((m) => (m.outcome as { ok?: boolean }).ok === false))).toBe(0);
  }, 300_000);

  it("summary row fan-out: a bot made on B reaches A's copy of B's srv: table", async () => {
    // Timed into A's copy (server.db, polled every ms): the step that crosses servers. A pushes the same commit to its
    // front ends' table feeds at once (TableFeeds.notify), which step 7 checks; the phone helper here does not decode
    // `rows` frames.
    const stream = `srv:${kb.memberId}`;
    const inCopy = (key: string) => withDb(a, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(stream, key));
    const client: ScriptClient = await b.client("script", "c".repeat(32));
    await client.sub(client.srv);
    const snap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
    const delays: number[] = [];
    for (let i = 1; i <= FANOUT; i++) {
      client.cmd({ origin: "script", originEpoch: client.originEpoch, target: client.srv, n: i } as Slot, { type: "bots.create", name: `Fan ${i}`, job: "fan-out" }, snap.logId);
      const created = await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === i, `bots.create ${i}`);
      const at = performance.now();
      const key = `bot:${(created.outcome as { result: { botId: string } }).result.botId}`;
      const seen = await until(() => (inCopy(key) ? performance.now() : null), { timeout: 30_000, every: 1, what: `row ${key} in A's copy` });
      delays.push(seen - at);
    }
    client.close();
    report.fanout = stats(delays);
  }, 300_000);
});
