// Botling 3 M4-06 (tasks-m4.md §3): what a server does when another server becomes invalid (§4.6, §10.5, D5, D47, D58).
//
// Three real botlingd on loopback (s1 = root, s2 = peer + owner + forwarder, s3 = peer to revoke):
//   1. A live session with s3 ends within one frame after s3's revocation is merged.
//   2. A new handshake from s3 gets only the D47 exchange, then bye{revoked}.
//   3. A forward-queue row whose target is one of s3's bots, not yet delivered, gets cmd.refused{revoked} to the FE,
//      and the row is deleted.
//   4. A command from an FE attached to s3 (origin through s3) not yet applied at this owner is refused. One already
//      applied stays applied.
//   5. Front ends get peer{s3, state: "gone"}. s3's summary rows stay readable (and offline only -> stale, not gone).
//   6. When a later Root leaves that revocation out (write it directly), s3 is valid again and its state leaves gone.
//   7. Relay allow list excludes revoked server token (it.todo: belongs to M4-16a).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decodeWireFrame, encodeFrame, encodeWireFrame, fromBase64Url, type Message, type MessageOf, type Slot, type WireMessage,
} from "../../src/protocol";
import { SessionLink } from "../../src/session";
import { webSocketConnector } from "../../src/server/peer";
import type { StoredStatement } from "../../src/server/roster";
import type { ScriptClient } from "../botlingd-harness";
import { until } from "../helpers";
import type { FaultProxy } from "../support/fault-proxy";
import { makeRecovery, nextRoot, profile, readServerKeys, sign, signRecovery, writeStatements, type MemberKeysInfo, type Recovery } from "../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../support/two-servers";
import { pairPhone, type DeviceKeys } from "../support/ws-device";

const TIMERS = { ping: 300, dead: 1_500, redial: 150, redialMax: 800, revoked: 2_500 };
const TIMERS_ENV = { BOTLING_SERVER_PEER_TIMERS: Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(",") };
const REMOTE = { local: false } as const;
const PEER_KIND = { local: false } as const;
const encoder = new TextEncoder();

interface PeerFileEntry { member: string; state: string; since: number | null; initiator?: string; sessionId?: string }
function peerStates(server: TestServer): PeerFileEntry[] {
  try { return (JSON.parse(readFileSync(join(server.dataDir, "botlingd.peers.json"), "utf8")) as { peers: PeerFileEntry[] }).peers; } catch { return []; }
}
const peerOf = (server: TestServer, member: string) => peerStates(server).find((p) => p.member === member) ?? null;
const logLines = (server: TestServer, pattern: RegExp) => server.log.split("\n").filter((line) => pattern.test(line));

function withDb<T>(server: TestServer, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout = 10000"); return run(db); } finally { db.close(); }
}
const hasRow = (server: TestServer, slot: Slot) => withDb(server, (db) => !!db.prepare("SELECT 1 FROM forwardq WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ?").get(slot.origin, slot.originEpoch, slot.target, slot.n));
const forwardCount = (server: TestServer) => withDb(server, (db) => Number((db.prepare("SELECT COUNT(*) AS n FROM forwardq").get() as { n: number }).n));
const logIdOf = (server: TestServer, stream: string) => withDb(server, (db) => (db.prepare("SELECT logId FROM streams WHERE stream = ?").get(stream) as { logId: string } | undefined)?.logId ?? null);

interface AttachedFe {
  got: WireMessage[];
  open: boolean;
  send(message: Message): boolean;
  close(): void;
}

async function attachFe(keys: DeviceKeys, server: TestServer, responder: MemberKeysInfo, clusterId: string, epoch: string): Promise<AttachedFe> {
  const got: WireMessage[] = [];
  const conn = await webSocketConnector.connect(`ws://127.0.0.1:${server.port}/v3/ws`);
  let open = false;
  const link = SessionLink.initiate(conn, {
    mode: "ik", transport: "tailnet", cluster: clusterId,
    self: { memberId: keys.member, dhPub: keys.dh.publicKey, dhKey: keys.dh.privateKey },
    responder: { memberId: responder.memberId, dhPub: fromBase64Url(responder.dh)! },
  }, {
    onFrame: (bytes) => {
      const decoded = decodeWireFrame(bytes, "server", REMOTE);
      if (decoded.ok) got.push(decoded.message);
    },
    onEnd: () => { open = false; },
  });
  conn.bind({ frame: (frame) => link.receive(frame), closed: () => link.transportClosed() });
  await link.established;
  const send = (message: Message): boolean => {
    const encoded = encodeFrame(message, "fe", REMOTE);
    if (!encoded.ok || link.state !== "open") return false;
    try { link.send("control", encoder.encode(encoded.text)); return true; } catch { return false; }
  };
  send({ t: "hello", deviceId: keys.member, feVersion: "3.0.0", protocol: 1, originEpoch: epoch, cursors: {}, outbox: [], want: [] } as Message);
  await until(() => got.some((m) => m.t === "welcome"), { timeout: 15_000, what: `welcome from ${server.name}` });
  open = true;
  return { got, get open() { return open; }, send, close: () => link.close() };
}

let cluster: TestCluster;
let s1: TestServer, s2: TestServer, s3: TestServer;
let k1: MemberKeysInfo, k2: MemberKeysInfo, k3: MemberKeysInfo;
let p1: FaultProxy, p2: FaultProxy, p3: FaultProxy;
let recovery: Recovery;
let clusterId: string;
let root1: StoredStatement;
let bot2: string, bot3: string;
let msg2: string, msg3: string;
let fe2Keys: DeviceKeys, fe3Keys: DeviceKeys;
let fe2: AttachedFe;
let unappliedSlot: Slot;
let appliedSlot: Slot;
const fe2Epoch = "2".repeat(32);
const fe3Epoch = "3".repeat(32);

async function createBot(server: TestServer, name: string): Promise<{ botId: string; msgId: string }> {
  const client: ScriptClient = await server.client("script", "d".repeat(32));
  await client.sub(client.srv);
  const snap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
  client.cmd({ origin: "script", originEpoch: client.originEpoch, target: client.srv, n: 1 } as Slot, { type: "bots.create", name, job: "revoked peer test" }, snap.logId);
  const created = await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === 1, "bots.create");
  const botId = (created.outcome as { result: { botId: string } }).result.botId;
  client.cmd({ origin: "script", originEpoch: client.originEpoch, target: `bot:${botId}`, n: 1 } as Slot, { type: "chat.send", botId, text: `/say hello from ${server.name}` }, snap.logId);
  await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.target === `bot:${botId}`, "chat.send");
  const msgId = await until(() => withDb(server, (db) => (db.prepare("SELECT msgId FROM messages WHERE botId = ? ORDER BY seq LIMIT 1").get(botId) as { msgId: string } | undefined)?.msgId ?? null), { timeout: 20_000, what: `msg on ${server.name}` });
  client.close();
  return { botId, msgId };
}

beforeAll(async () => {
  cluster = await startServers({ name: "revoked-peer", count: 3, env: { A: TIMERS_ENV, B: TIMERS_ENV, C: TIMERS_ENV } });
  [s1, s2, s3] = cluster.servers;
  await Promise.all([s1.stop(), s2.stop(), s3.stop()]);
  [k1, k2, k3] = await Promise.all([readServerKeys(s1.dataDir), readServerKeys(s2.dataDir), readServerKeys(s3.dataDir)]);
  p1 = await cluster.proxy(s1, "websocket", 21);
  p2 = await cluster.proxy(s2, "websocket", 22);
  p3 = await cluster.proxy(s3, "websocket", 23);

  // Root s1 paired s2 and s3 (joined: true); s2 and s3 cross-add with joined: false so revoking s3 cascades only to
  // s3's own devices (D60), never to s2.
  recovery = await makeRecovery();
  clusterId = recovery.clusterId;
  root1 = await signRecovery({ type: "root", cluster: clusterId, gen: 1, root: k1.memberId, recoveryPub: recovery.pub, keep: [], prev: null }, recovery);
  const statements: StoredStatement[] = [
    root1,
    await sign({ type: "add", cluster: clusterId, member: k2.memberId, kind: "server", keys: { sign: k2.sign, dh: k2.dh }, name: "server B", by: k1.memberId, at: 1_700_000_000_000, joined: true }, k1),
    await sign({ type: "add", cluster: clusterId, member: k3.memberId, kind: "server", keys: { sign: k3.sign, dh: k3.dh }, name: "server C", by: k1.memberId, at: 1_700_000_000_000, joined: true }, k1),
    await sign({ type: "add", cluster: clusterId, member: k1.memberId, kind: "server", keys: { sign: k1.sign, dh: k1.dh }, name: "server A", by: k2.memberId, at: 1_700_000_000_000, joined: false }, k2),
    await sign({ type: "add", cluster: clusterId, member: k3.memberId, kind: "server", keys: { sign: k3.sign, dh: k3.dh }, name: "server C", by: k2.memberId, at: 1_700_000_000_000, joined: false }, k2),
    await sign({ type: "add", cluster: clusterId, member: k1.memberId, kind: "server", keys: { sign: k1.sign, dh: k1.dh }, name: "server A", by: k3.memberId, at: 1_700_000_000_000, joined: false }, k3),
    await sign({ type: "add", cluster: clusterId, member: k2.memberId, kind: "server", keys: { sign: k2.sign, dh: k2.dh }, name: "server B", by: k3.memberId, at: 1_700_000_000_000, joined: false }, k3),
    await profile(clusterId, k1, k1, p1.port),
    await profile(clusterId, k2, k2, p2.port),
    await profile(clusterId, k3, k3, p3.port),
  ];
  for (const server of [s1, s2, s3]) writeStatements(server.dataDir, clusterId, statements);
  await Promise.all([s1.start(), s2.start(), s3.start()]);

  await until(() => peerOf(s2, k1.memberId)?.state === "live" && peerOf(s2, k3.memberId)?.state === "live" && peerOf(s3, k2.memberId)?.state === "live", { timeout: 30_000, what: "all peer sessions live" });
  for (const server of [s1, s2, s3]) server.assertLoopbackOnly({ expectListener: true });

  ({ botId: bot2, msgId: msg2 } = await createBot(s2, "Bot on s2"));
  ({ botId: bot3, msgId: msg3 } = await createBot(s3, "Bot on s3"));
  await until(() => withDb(s2, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(`srv:${k3.memberId}`, `bot:${bot3}`)), { timeout: 30_000, what: "s2 copy has s3 bot" });
  await until(() => withDb(s3, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(`srv:${k2.memberId}`, `bot:${bot2}`)), { timeout: 30_000, what: "s3 copy has s2 bot" });

  const local2 = await s2.client("pair2", "a".repeat(32));
  const paired2 = await pairPhone(local2, s2.port, "FE on s2");
  local2.close();
  fe2Keys = paired2.keys;

  const local3 = await s3.client("pair3", "b".repeat(32));
  const paired3 = await pairPhone(local3, s3.port, "FE on s3");
  local3.close();
  fe3Keys = paired3.keys;

  await until(() => [s1, s2, s3].every((s) => withDb(s, (db) => !!db.prepare("SELECT 1 FROM roster WHERE id = ?").get(paired2.addId) && !!db.prepare("SELECT 1 FROM roster WHERE id = ?").get(paired3.addId))), { timeout: 30_000, what: "all servers have both FE Adds" });

  // FE attached to s3 sends slot 1 targeting s2's bot -> applied at s2 before revocation.
  const fe3OnS3 = await attachFe(fe3Keys, s3, k3, clusterId, fe3Epoch);
  const inc2AtS3 = logIdOf(s3, `srv:${k2.memberId}`)!;
  appliedSlot = { origin: fe3Keys.member, originEpoch: fe3Epoch, target: `bot:${bot2}`, n: 1 } as Slot;
  fe3OnS3.send({ t: "cmd", slot: appliedSlot, floor: 1, inc: inc2AtS3, cmd: { type: "chat.react", botId: bot2, messageId: msg2, emoji: "👍", present: true } } as Message);
  await until(() => fe3OnS3.got.some((m) => m.t === "cmd.result" && m.slot.n === 1 && m.outcome.kind === "applied"), { timeout: 20_000, what: "fe3 slot 1 applied at s2" });
  fe3OnS3.close();

  // Attach fe2 to s2 and subscribe to srv:s3 so fe2 receives peer events and sees summary rows.
  fe2 = await attachFe(fe2Keys, s2, k2, clusterId, fe2Epoch);
  fe2.send({ t: "sub", stream: `srv:${k3.memberId}`, cursor: null } as Message);
  await until(() => fe2.got.some((m) => m.t === "rows" && m.stream === `srv:${k3.memberId}`), { timeout: 15_000, what: "fe2 got srv:s3 rows" });

  // Partition p1 and p2 briefly so s1 holds fe3's slot 2 in forwardq (not yet sent to s2), then stop s1 and heal p1+p2
  // so s2 <-> s3 is live again before s1 starts with Revoke{s3}.
  p1.partition();
  p2.partition();
  await until(() => peerOf(s2, k1.memberId)?.state === "stale" && peerOf(s1, k2.memberId)?.state === "stale", { timeout: 20_000, what: "s1 and s2 see each other stale" });
  const fe3OnS1 = await attachFe(fe3Keys, s1, k1, clusterId, fe3Epoch);
  const inc2AtS1 = logIdOf(s1, `srv:${k2.memberId}`)!;
  unappliedSlot = { origin: fe3Keys.member, originEpoch: fe3Epoch, target: `bot:${bot2}`, n: 2 } as Slot;
  fe3OnS1.send({ t: "cmd", slot: unappliedSlot, floor: 2, inc: inc2AtS1, cmd: { type: "chat.react", botId: bot2, messageId: msg2, emoji: "❤️", present: true } } as Message);
  await until(() => fe3OnS1.got.some((m) => m.t === "held" && m.slot.n === 2), { timeout: 15_000, what: "s1 held fe3 slot 2" });
  fe3OnS1.close();
  await s1.stop();
  p1.heal();
  p2.heal();
  await until(() => peerOf(s2, k3.memberId)?.state === "live" && peerOf(s3, k2.memberId)?.state === "live", { timeout: 20_000, what: "s2 <-> s3 live before revocation" });
}, 180_000);

afterAll(async () => {
  fe2?.close();
  await cluster?.cleanup();
}, 60_000);

describe("M4-06: what a server does when another server becomes invalid", () => {
  it("1. A live session with s3 ends within one frame after s3's revocation is merged", async () => {
    expect(peerOf(s2, k3.memberId)?.state).toBe("live");
    const s2LogsBefore = s2.log.length;
    const revokeS3: StoredStatement = await sign({
      type: "revoke", cluster: clusterId, member: k3.memberId, reason: "compromised", by: k1.memberId, gen: 1, cascade: true,
    }, k1);
    writeStatements(s1.dataDir, clusterId, [revokeS3]);
    await s1.start();

    await until(() => {
      const p = peerOf(s2, k3.memberId);
      const delta = s2.log.slice(s2LogsBefore);
      return p?.state === "gone" && delta.includes(`peer ${k3.memberId}: session ended (bye revoked`);
    }, { timeout: 20_000, what: "s2 ends live session with s3 on revocation merge" });

    const delta = s2.log.slice(s2LogsBefore);
    expect(delta).toContain("took 1 revocation statement");
    expect(delta).toContain(`peer ${k3.memberId}: session ended (bye revoked: that server was removed from the roster)`);
  }, 60_000);

  it("2. A new handshake from s3 gets only the D47 exchange, then bye{revoked}", async () => {
    const exchangesBefore = logLines(s2, new RegExp(`peer ${k3.memberId}: exchange done`)).length;
    await until(() => logLines(s2, new RegExp(`peer ${k3.memberId}: exchange done`)).length > exchangesBefore, { timeout: 20_000, what: "s2 ran D47 exchange on s3 handshake" });
    const recent = logLines(s2, new RegExp(`peer ${k3.memberId}:`)).slice(-10).join("\n");
    expect(recent).toContain("exchange only (the peer is not valid here)");
    expect(recent).toContain("exchange done");

    const s3File = JSON.parse(readFileSync(join(s3.dataDir, "server-keys.json"), "utf8")) as { dh: { pkcs8: string; pub: string } };
    const s3DhKey = await crypto.subtle.importKey("pkcs8", fromBase64Url(s3File.dh.pkcs8)! as Uint8Array<ArrayBuffer>, { name: "X25519" }, false, ["deriveBits"]);
    const conn = await webSocketConnector.connect(`ws://127.0.0.1:${s2.port}/v3/ws`);
    const frames: WireMessage[] = [];
    const link = SessionLink.initiate(conn, {
      mode: "kk", transport: "tailnet", cluster: clusterId,
      self: { memberId: k3.memberId, dhPub: fromBase64Url(k3.dh)!, dhKey: s3DhKey },
      responder: { memberId: k2.memberId, dhPub: fromBase64Url(k2.dh)! },
    }, {
      onFrame: (bytes) => { const d = decodeWireFrame(bytes, "server", PEER_KIND); if (d.ok) frames.push(d.message); },
      onEnd: () => undefined,
    });
    conn.bind({ frame: (f) => link.receive(f), closed: () => link.transportClosed() });
    await link.established;
    const rev = encodeWireFrame({ t: "roster.revocations", statements: [] } as WireMessage, "peer", PEER_KIND);
    expect(rev.ok).toBe(true);
    if (rev.ok) link.send("control", encoder.encode(rev.text));
    await until(() => frames.some((m) => m.t === "bye"), { timeout: 10_000, what: "bye from s2" });
    expect(frames.every((m) => m.t === "roster.revocations" || m.t === "bye")).toBe(true);
    expect(frames.find((m) => m.t === "bye")).toMatchObject({ t: "bye", reason: "revoked" });
    link.close();
  }, 60_000);

  it("4. A command from an FE attached to s3 not yet applied at this owner is refused; one already applied stays applied", async () => {
    const result = await until(() => withDb(s2, (db) => {
      const rows = db.prepare("SELECT seq, kind, slot, body FROM entries WHERE stream = ? AND kind IN ('cmd.applied', 'cmd.refused') ORDER BY seq").all(`bot:${bot2}`) as Array<{ seq: number; kind: string; slot: string; body: string }>;
      const parsed = rows.map((r) => ({ seq: Number(r.seq), kind: String(r.kind), slot: JSON.parse(String(r.slot)) as Slot, body: JSON.parse(String(r.body)) as { reason?: string } }));
      const s1Applied = parsed.find((e) => e.slot.origin === appliedSlot.origin && e.slot.n === appliedSlot.n);
      const s2Refused = parsed.find((e) => e.slot.origin === unappliedSlot.origin && e.slot.n === unappliedSlot.n);
      return s1Applied && s2Refused ? { s1Applied, s2Refused } : null;
    }), { timeout: 25_000, what: "s2 refused unapplied slot 2 and kept slot 1 applied" });

    expect(result.s1Applied.kind).toBe("cmd.applied");
    expect(result.s2Refused.kind).toBe("cmd.refused");
    expect(result.s2Refused.body.reason).toBe("origin");
  }, 60_000);

  it("5. Front ends get peer{s3, state: 'gone'}, s3's summary rows stay readable, and offline-only is stale not gone", async () => {
    const peerGone = fe2.got.filter((m): m is MessageOf<"peer"> => m.t === "peer" && m.serverId === k3.memberId);
    expect(peerGone.some((m) => m.state === "gone")).toBe(true);
    const s1Peers = fe2.got.filter((m): m is MessageOf<"peer"> => m.t === "peer" && m.serverId === k1.memberId);
    expect(s1Peers.some((m) => m.state === "stale")).toBe(true);
    expect(s1Peers.some((m) => m.state === "gone")).toBe(false);

    const fe2b = await attachFe(fe2Keys, s2, k2, clusterId, "4".repeat(32));
    fe2b.send({ t: "sub", stream: `srv:${k3.memberId}`, cursor: null } as Message);
    const rows = await until(() => fe2b.got.find((m): m is Extract<WireMessage, { t: "rows" }> => m.t === "rows" && m.stream === `srv:${k3.memberId}`), { timeout: 15_000, what: "s3 summary rows readable" });
    expect(rows.rows.some((r) => r.key === `bot:${bot3}` && !r.deleted)).toBe(true);
    fe2b.close();
  }, 60_000);

  it("6. When a later Root leaves that revocation out, s3 is valid again and its state leaves gone", async () => {
    const root2 = await nextRoot(recovery, root1, k1, []);
    await s1.stop();
    writeStatements(s1.dataDir, clusterId, [root2]);
    await s1.start();

    await until(() => peerOf(s2, k3.memberId)?.state === "live" && peerOf(s3, k2.memberId)?.state === "live", { timeout: 30_000, what: "s3 valid again and live" });
    await until(() => fe2.got.some((m) => m.t === "peer" && m.serverId === k3.memberId && m.state !== "gone"), { timeout: 15_000, what: "fe2 peer state left gone" });
  }, 60_000);

  it("3. A forward-queue row whose target is one of s3's bots, not yet delivered, gets cmd.refused{revoked} to the FE and is deleted", async () => {
    await s3.stop();
    await until(() => peerOf(s2, k3.memberId)?.state === "stale", { timeout: 20_000, what: "s2 sees s3 stale (offline, not gone)" });
    const inc3AtS2 = logIdOf(s2, `srv:${k3.memberId}`)!;
    const queuedSlot = { origin: fe2Keys.member, originEpoch: fe2Epoch, target: `bot:${bot3}`, n: 1 } as Slot;
    fe2.send({ t: "cmd", slot: queuedSlot, floor: 1, inc: inc3AtS2, cmd: { type: "chat.react", botId: bot3, messageId: msg3, emoji: "🎉", present: true } } as Message);
    await until(() => fe2.got.some((m) => m.t === "held" && m.slot.target === `bot:${bot3}` && m.slot.n === 1), { timeout: 15_000, what: "s2 held command for s3 bot" });
    expect(hasRow(s2, queuedSlot)).toBe(true);

    const revokeS3Gen2: StoredStatement = await sign({
      type: "revoke", cluster: clusterId, member: k3.memberId, reason: "revoked while queued", by: k1.memberId, gen: 2, cascade: true,
    }, k1);
    await s1.stop();
    writeStatements(s1.dataDir, clusterId, [revokeS3Gen2]);
    await s1.start();

    const refused = await until(() => fe2.got.find((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.target === `bot:${bot3}` && m.slot.n === 1), { timeout: 20_000, what: "fe2 gets cmd.refused{revoked}" });
    expect(refused.outcome).toMatchObject({ kind: "refused", reason: "revoked" });
    await until(() => forwardCount(s2) === 0, { timeout: 10_000, what: "s2 forwardq row deleted" });
    expect(hasRow(s2, queuedSlot)).toBe(false);
  }, 60_000);

});
