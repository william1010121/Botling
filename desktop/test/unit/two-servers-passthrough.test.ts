// Botling 3 M3 step 8 (m3-brief §4 row 8): detail on demand between real botlingd on this machine. Server B owns a bot
// (made with bots.create on B's own socket, lines from a real fake-engine turn, then reactions); a front end on A's local
// socket subscribes to it; A passes the sub through to B (`via`) and relays B's frames. The A–B session runs through a
// fault proxy in front of each server (statements written into each server.db while it is stopped, as in step 3).
//
// Checked on every frame the front end gets: valid M1 wire with no `via`; never an entry ≤ its cursor in one logId,
// never a gap, never a retired logId, never an older snapshot; every batch chains on its last hash; the entries it holds
// of B's current logId are B's own (seq, hash, content). Scenarios:
//   - open + live pushes: the FE reaches B's head; A's cache (peerlogs) holds B's snap and the entries after it;
//   - drop, duplicate, cut, partition while B writes: each ends the session, the FE resumes from its cursor with no gap
//     or duplicate; during the partition the FE gets `stale{since}` and a new FE on A gets A's cache, then `stale`;
//   - SIGKILL of B mid-writes, SIGKILL of A (its cache survives in server.db; served while B is stopped);
//   - B restored (`botlingd restore`): the FE gets a `reset` naming its logId as retired, then the new incarnation;
//     nothing of the old logId reaches it afterwards; A's cache moved to the new logId.
// Requires `npm run build` (out/server/main.cjs).
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FrameSplitter, packFrame, type Cursor, type Entry, type Message, type MessageOf, type Slot } from "../../src/protocol";
import { decodeFrame, encodeFrame } from "../../src/protocol/frame";
import { verifyChain } from "../../src/server/log/chain";
import type { ScriptClient } from "../botlingd-harness";
import { until } from "../helpers";
import type { FaultProxy } from "../support/fault-proxy";
import { makeCluster, profile, readServerKeys, writeStatements, type MemberKeysInfo } from "../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../support/two-servers";

const TIMERS = { ping: 300, dead: 1_500, redial: 150, redialMax: 800, revoked: 2_500 };
const ENV = {
  BOTLING_SERVER_PEER_TIMERS: Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(","),
  BOTLING_SERVER_PEER_CACHE: "bytes=8388608",
};

let cluster: TestCluster;
let a: TestServer, b: TestServer;
let ka: MemberKeysInfo, kb: MemberKeysInfo;
let pa: FaultProxy, pb: FaultProxy;
let botB: string;
let messageB: string;
let stream: string;

function withDb<T>(server: TestServer, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout = 10000"); return run(db); } finally { db.close(); }
}
const headOf = (server: TestServer) => withDb(server, (db) => {
  const row = db.prepare("SELECT logId, head FROM streams WHERE stream = ?").get(stream) as { logId: string; head: number } | undefined;
  return row ? { logId: String(row.logId), seq: Number(row.head) } : null;
});
/** B's entries of `logId` by seq: hash and content (the hash covers the canonical entry). */
const entriesOf = (server: TestServer, logId: string) => withDb(server, (db) => new Map(
  (db.prepare("SELECT seq, hash, kind, body FROM entries WHERE stream = ? AND logId = ?").all(stream, logId) as Array<{ seq: number; hash: string; kind: string; body: string }>)
    .map((row) => [Number(row.seq), { hash: String(row.hash), kind: String(row.kind), body: String(row.body) }]),
));
const cacheOf = (server: TestServer) => withDb(server, (db) => {
  const row = db.prepare("SELECT logId, snapSeq, head, retired FROM peerlogs WHERE stream = ?").get(stream) as { logId: string; snapSeq: number; head: number; retired: string } | undefined;
  if (!row) return null;
  const entries = (db.prepare("SELECT seq, entry FROM peerlog_entries WHERE stream = ? ORDER BY seq").all(stream) as Array<{ seq: number; entry: string }>).map((item) => JSON.parse(item.entry) as Entry);
  return { logId: String(row.logId), snapSeq: Number(row.snapSeq), head: Number(row.head), retired: (JSON.parse(row.retired) as { list: Array<{ logId: string }> }).list.map((old) => old.logId), entries };
});

// ---------------------------------------------------------------------------------------------
// A front end on A's local socket that checks every frame of the peer's bot

class Fe {
  readonly received: Message[] = [];
  readonly violations: string[] = [];
  /** Entries applied, by `logId:seq`. */
  readonly entries = new Map<string, Entry>();
  readonly retired = new Set<string>();
  logId: string | null = null;
  seq = -1;
  lastHash: string | null = null;
  closed = false;
  private socket: Socket | null = null;
  private readonly splitter = new FrameSplitter();

  constructor(readonly name: string) {}

  cursor(): Cursor | null { return this.logId && this.seq >= 0 ? { logId: this.logId as Cursor["logId"], seq: this.seq } : null; }

  async connect(server: TestServer): Promise<void> {
    this.closed = false;
    const socket = createConnection(server.socket);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => { socket.once("connect", () => resolve()); socket.once("error", reject); });
    socket.on("data", (chunk: Buffer) => {
      const split = this.splitter.push(chunk);
      if (!split.ok) { this.violations.push(split.detail); return; }
      for (const frame of split.frames) {
        const decoded = decodeFrame(frame, "server", { local: true });
        if (!decoded.ok) { this.violations.push(`bad frame: ${decoded.detail}`); continue; }
        this.take(decoded.message);
      }
    });
    socket.on("close", () => { this.closed = true; });
    socket.on("error", () => undefined);
    const from = this.received.length;
    this.send({ t: "hello", deviceId: `fe-${this.name}`, feVersion: "3.0.0", protocol: 1, originEpoch: "e".repeat(32), cursors: {}, outbox: [], want: [], token: server.token } as Message);
    await until(() => this.received.slice(from).some((m) => m.t === "welcome") || null, { what: `${this.name} welcome` });
    this.send({ t: "sub", stream, cursor: this.cursor() } as Message);
  }

  send(message: Message): void {
    const encoded = encodeFrame(message, "fe", { local: true });
    if (!encoded.ok) throw new Error(encoded.detail);
    this.socket?.write(packFrame(encoded.text));
  }

  close(): void { this.socket?.destroy(); }

  stales(): Array<MessageOf<"stale">> { return this.received.filter((m): m is MessageOf<"stale"> => m.t === "stale"); }

  private take(message: Message): void {
    this.received.push(message);
    if ((message as { via?: unknown }).via !== undefined) this.violations.push(`${message.t} with a via`);
    if (!("stream" in message) || message.stream !== stream) return;
    if (message.t === "reset") {
      if (this.retired.has(message.logId)) this.violations.push("reset back to a retired logId");
      if (this.logId && !message.retired.some((old) => old.logId === this.logId)) this.violations.push("reset that does not retire the FE's logId");
      for (const old of message.retired) this.retired.add(old.logId);
      this.logId = message.logId; this.seq = -1; this.lastHash = null;
    } else if (message.t === "snap") {
      if (this.retired.has(message.logId)) this.violations.push("snap of a retired logId");
      if (this.logId && this.logId !== message.logId) this.violations.push("snap of another logId without a reset");
      if (this.logId === message.logId && message.seq < this.seq) this.violations.push(`older snapshot ${message.seq} < ${this.seq}`);
      this.logId = message.logId; this.seq = message.seq; this.lastHash = message.hash;
    } else if (message.t === "batch") {
      if (this.retired.has(message.logId)) { this.violations.push("batch of a retired logId"); return; }
      if (message.logId !== this.logId) { this.violations.push("batch of another logId"); return; }
      if (message.from <= this.seq) this.violations.push(`entry ${message.from} ≤ cursor ${this.seq}`);
      if (message.from > this.seq + 1) this.violations.push(`gap: ${message.from} after ${this.seq}`);
      if (message.prevHash !== this.lastHash) this.violations.push(`prevHash does not chain at ${message.from}`);
      const check = verifyChain(message.prevHash, message.entries);
      if (!check.ok) this.violations.push(`chain broken at ${check.seq}`);
      for (const entry of message.entries) this.entries.set(`${entry.logId}:${entry.seq}`, entry);
      this.seq = message.to;
      this.lastHash = message.entries[message.entries.length - 1]!.hash;
      this.send({ t: "ack", stream, cursor: { logId: message.logId, seq: message.to } } as Message);
    }
  }

  /** The entries this FE holds of B's current logId are B's own. */
  checkAgainst(owner: TestServer): void {
    const head = headOf(owner)!;
    const truth = entriesOf(owner, head.logId);
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(`${head.logId}:`)) continue;
      const row = truth.get(entry.seq);
      if (!row || row.hash !== entry.hash || row.kind !== entry.kind || JSON.stringify(JSON.parse(row.body)) !== JSON.stringify(entry.body)) this.violations.push(`entry ${key} is not B's`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Writes on B: reactions to one line of its bot, from B's own socket

let writer: ScriptClient | null = null;
let writerInc = "";
let writerN = 0;

async function bWriter(): Promise<ScriptClient> {
  if (writer && !writer.closed) return writer;
  writer = await b.client("writer", Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join(""));
  await writer.sub(writer.srv);
  writerInc = (await writer.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === writer!.srv, "srv snap on B")).logId;
  writerN = 0;
  return writer;
}

/** `count` reactions on B's bot (each an entry); waits for the last outcome unless `wait` is false. */
async function writeOnB(count: number, wait = true): Promise<void> {
  const client = await bWriter();
  let last = 0;
  for (let i = 0; i < count; i++) {
    last = ++writerN;
    client.cmd({ origin: "writer", originEpoch: client.originEpoch, target: `bot:${botB}`, n: last } as Slot, { type: "chat.react", botId: botB, messageId: messageB, emoji: "👍", present: last % 2 === 1 }, writerInc);
  }
  if (wait) await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === last && m.slot.originEpoch === client.originEpoch, `reaction ${last}`, { timeout: 30_000 });
}

async function atHead(fe: Fe, what: string, timeout = 45_000): Promise<void> {
  await until(() => {
    const head = headOf(b);
    return head && fe.logId === head.logId && fe.seq === head.seq ? true : null;
  }, { timeout, every: 50, what });
}

const sessionEnds = () => (a.log.match(/session ended/g) ?? []).length + (b.log.match(/session ended/g) ?? []).length;

beforeAll(async () => {
  cluster = await startServers({ name: "passthrough", count: 2, env: { A: ENV, B: ENV } });
  ({ a, b } = cluster);
  await Promise.all([a.stop(), b.stop()]);
  [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
  pa = await cluster.proxy(a, "websocket", 21);
  pb = await cluster.proxy(b, "websocket", 22);
  const made = await makeCluster([ka, kb]);
  writeStatements(a.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, kb, kb, pb.port)]);
  writeStatements(b.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, ka, ka, pa.port)]);
  await Promise.all([a.start(), b.start()]);

  const client = await b.client("script", "d".repeat(32));
  await client.sub(client.srv);
  const snap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
  client.cmd({ origin: "script", originEpoch: client.originEpoch, target: client.srv, n: 1 } as Slot, { type: "bots.create", name: "Remote helper", job: "pass-through test" }, snap.logId);
  const created = await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === 1, "bots.create");
  botB = (created.outcome as { result: { botId: string } }).result.botId;
  stream = `bot:${botB}`;
  client.cmd({ origin: "script", originEpoch: client.originEpoch, target: stream, n: 1 } as Slot, { type: "chat.send", botId: botB, text: "/say hello from B" }, snap.logId);
  await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.target === stream, "chat.send on B");
  messageB = await until(() => withDb(b, (db) => (db.prepare("SELECT msgId FROM messages WHERE botId = ? ORDER BY seq LIMIT 1").get(botB) as { msgId: string } | undefined)?.msgId ?? null), { timeout: 30_000, what: "a line on B's bot" });
  client.close();
  await until(() => withDb(a, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(`srv:${kb.memberId}`, stream)), { timeout: 30_000, what: "A's copy names B's bot" });
}, 180_000);

afterAll(async () => {
  writer?.close();
  await cluster?.cleanup();
}, 60_000);

describe("M3 step 8: pass-through between botlingd", () => {
  let fe: Fe;

  it("a front end on A opens B's bot: B's frames relayed (no via), live pushes, A caches snap + entries", async () => {
    await writeOnB(30);
    fe = new Fe("main");
    await fe.connect(a);
    await atHead(fe, "FE at B's head");
    await writeOnB(40);
    await atHead(fe, "FE follows live pushes");
    fe.checkAgainst(b);
    expect(fe.violations).toEqual([]);
    expect(fe.received.some((m) => m.t === "snap")).toBe(true);
    // A built no state of B's bot: no stream row or entries of it in A's own log.
    expect(withDb(a, (db) => db.prepare("SELECT COUNT(*) AS n FROM entries WHERE stream = ?").get(stream) as { n: number }).n).toBe(0);
    // A's cache: B's snap at snapSeq, then every entry after it, the same as B's.
    const cache = await until(() => { const c = cacheOf(a); return c && c.head === fe.seq ? c : null; }, { what: "A's cache at the FE's head" });
    const truth = entriesOf(b, cache.logId);
    expect(cache.entries.map((e) => e.seq)).toEqual(Array.from({ length: cache.head - cache.snapSeq }, (_, i) => cache.snapSeq + 1 + i));
    for (const entry of cache.entries) expect(truth.get(entry.seq)?.hash).toBe(entry.hash);
    for (const server of [a, b]) server.assertLoopbackOnly({ expectListener: true });
  }, 120_000);

  it("drop, duplicate, cut and partition while B writes: no gap, no duplicate; stale{since} and A's cache during the partition", async () => {
    for (const fault of ["drop", "duplicate", "cut", "partition"] as const) {
      const ends = sessionEnds();
      const live = [pa, pb];
      const at = Date.now();
      const staleBefore = fe.stales().length;
      if (fault === "drop") for (const p of live) p.drop("down", 1).drop("up", 1);
      if (fault === "duplicate") for (const p of live) p.duplicate("down", 1).duplicate("up", 1);
      if (fault === "cut") { pa.cut(); pb.cut(); }
      if (fault === "partition") { pa.partition(); pb.partition(); }
      for (let k = 0; k < 4; k++) { await writeOnB(10); await new Promise((resolve) => setTimeout(resolve, 100)); }
      if (fault === "partition") {
        const stale = await until(() => fe.stales()[staleBefore] ?? null, { timeout: 20_000, what: "stale{since} at the FE" });
        expect(stale.since).toBeLessThanOrEqual(Date.now());
        expect(stale.since).toBeGreaterThan(at - TIMERS.dead - 1_000);
        // A new FE on A meanwhile: A's cache (snap + entries), then stale.
        const late = new Fe("late");
        await late.connect(a);
        const lateStale = await until(() => late.stales()[0] ?? null, { timeout: 10_000, what: "late FE stale" });
        expect(lateStale.since).toBe(stale.since);
        const firstSnap = late.received.findIndex((m) => m.t === "snap");
        expect(firstSnap).toBeGreaterThanOrEqual(0);
        expect(late.received.indexOf(lateStale)).toBeGreaterThan(firstSnap);
        expect(late.seq).toBe(cacheOf(a)!.head);
        expect(late.violations).toEqual([]);
        late.close();
        pa.heal(); pb.heal();
      }
      await atHead(fe, `FE at B's head after ${fault}`);
      expect(sessionEnds(), `the ${fault} ended the session`).toBeGreaterThan(ends);
      fe.checkAgainst(b);
      expect(fe.violations, fault).toEqual([]);
    }
    expect(pa.count("drop") + pb.count("drop")).toBeGreaterThan(0);
    expect(pa.count("duplicate") + pb.count("duplicate")).toBeGreaterThan(0);
  }, 240_000);

  it("SIGKILL of B mid-writes and of A: the FE resumes from its cursor; A's cache survives its restart and is served while B is stopped", async () => {
    await writeOnB(20, false);
    await b.kill();
    writer = null;
    await b.start();
    await writeOnB(15);
    await atHead(fe, "FE after B's SIGKILL");
    expect(fe.violations).toEqual([]);
    // A killed: the FE's session ends; it re-attaches with its cursor once A is back.
    await a.kill();
    await writeOnB(10);
    await a.start();
    fe.close();
    await fe.connect(a);
    await atHead(fe, "FE after A's SIGKILL");
    fe.checkAgainst(b);
    expect(fe.violations).toEqual([]);
    // B stopped: A (restarted earlier, cache from server.db) serves a new FE its cache, then stale.
    await until(() => (cacheOf(a)?.head === fe.seq ? true : null), { what: "A's cache at the head" });
    await b.stop();
    writer = null;
    const cold = new Fe("cold");
    await cold.connect(a);
    await until(() => cold.stales()[0] ?? null, { timeout: 20_000, what: "cold FE stale" });
    expect(cold.seq).toBe(fe.seq);
    expect(cold.violations).toEqual([]);
    cold.close();
    await b.start();
    await writeOnB(5);
    await atHead(fe, "FE after B is back");
    expect(fe.violations).toEqual([]);
  }, 180_000);

  it("B restored: the FE gets reset + the new incarnation, never the old logId again; A's cache moves with it", async () => {
    await atHead(fe, "start");
    const oldLogId = headOf(b)!.logId;
    const backup = b.backup();
    await writeOnB(12);
    await atHead(fe, "FE has the entries written after the backup");
    writer?.close();
    writer = null;
    await b.restore(backup);
    const newLogId = headOf(b)!.logId;
    expect(newLogId).not.toBe(oldLogId);
    await writeOnB(6);
    await atHead(fe, "FE follows the restore");
    const resetAt = fe.received.findIndex((m) => m.t === "reset" && m.stream === stream && m.logId === newLogId);
    expect(resetAt).toBeGreaterThanOrEqual(0);
    expect((fe.received[resetAt] as MessageOf<"reset">).retired.map((old) => old.logId)).toContain(oldLogId);
    expect(fe.received.slice(resetAt).some((m) => (m.t === "batch" || m.t === "snap") && m.logId === oldLogId)).toBe(false);
    fe.checkAgainst(b);
    expect(fe.violations).toEqual([]);
    const cache = await until(() => { const c = cacheOf(a); return c && c.logId === newLogId && c.head === fe.seq ? c : null; }, { what: "A's cache on the new logId" });
    expect(cache.retired).toContain(oldLogId);
    // A's restart keeps the new incarnation; the FE stays on it.
    await a.kill();
    await a.start();
    fe.close();
    await fe.connect(a);
    await writeOnB(4);
    await atHead(fe, "FE after A's restart");
    expect(fe.violations).toEqual([]);
    expect(fe.logId).toBe(newLogId);
    const count = (t: string) => fe.received.filter((m) => m.t === t && (m as { stream?: string }).stream === stream).length;
    console.log(`pass-through FE: ${JSON.stringify({ snaps: count("snap"), batches: count("batch"), resets: count("reset"), stale: count("stale"), entries: fe.entries.size, head: fe.seq })}`);
    fe.close();
  }, 180_000);
});
