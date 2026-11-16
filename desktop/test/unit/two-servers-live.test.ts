// Live text across servers between real botlingd on this machine (M3, after step 8's deviation 5). Server B owns a bot
// (bots.create on B's own socket); a front end on A's local socket subscribes to it (pass-through); B runs fake-engine
// turns (`/say <words>`: one word every 15 ms). The A–B session runs through a fault proxy in front of each server
// (statements written into each server.db while it is stopped, as in steps 3 and 8). A second front end on B's own
// socket watches the same bot, to compare the first-frame latency with and without the extra hop.
//
// Checked: the front end on A gets ≥ 5 live frames before the reply commits, at most 10 in any second, none with a
// `via`; every text it shows is a prefix of the reply B commits (`turn.finished.text`), the last one the whole reply;
// its entries are B's (seq, hash, content) with no gap and no duplicate. Under a dropped frame and a cut mid-turn (each
// ends the session, D58) the stream comes back after the redial and the same holds.
// Requires `npm run build` (out/server/main.cjs).
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FrameSplitter, packFrame, type Entry, type Message, type MessageOf, type Slot } from "../../src/protocol";
import { decodeFrame, encodeFrame } from "../../src/protocol/frame";
import { readEntries } from "../../src/server/log";
import { verifyChain } from "../../src/server/log/chain";
import type { Db } from "../../src/server/store";
import { LiveReceiver } from "../../src/server/live";
import { until } from "../helpers";
import type { FaultProxy } from "../support/fault-proxy";
import { makeCluster, profile, readServerKeys, writeStatements, type MemberKeysInfo } from "../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../support/two-servers";

const TIMERS = { ping: 300, dead: 1_500, redial: 150, redialMax: 800, revoked: 2_500 };
const ENV = { BOTLING_SERVER_PEER_TIMERS: Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(","), BOTLING_SERVER_PEER_CACHE: "bytes=8388608" };

let cluster: TestCluster;
let a: TestServer, b: TestServer;
let ka: MemberKeysInfo, kb: MemberKeysInfo;
let pa: FaultProxy, pb: FaultProxy;
let botB: string;
let stream: string;
const report: Record<string, unknown> = {};

function withDb<T>(server: TestServer, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout = 10000"); return run(db); } finally { db.close(); }
}
const headOf = (server: TestServer) => withDb(server, (db) => {
  const row = db.prepare("SELECT logId, head FROM streams WHERE stream = ?").get(stream) as { logId: string; head: number } | undefined;
  return row ? { logId: String(row.logId), seq: Number(row.head) } : null;
});
const entriesOf = (server: TestServer, logId: string) => withDb(server, (db) => new Map(
  readEntries(db as unknown as Db, stream, 1, { maxEntries: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER }).entries
    .filter((entry) => entry.logId === logId)
    .map((entry) => [entry.seq, { hash: entry.hash, kind: entry.kind, body: JSON.stringify(entry.body) }]),
));

/** A front end on a server's local socket that follows the bot: entries checked, live frames through a LiveReceiver. */
class Fe {
  readonly received: Message[] = [];
  readonly violations: string[] = [];
  readonly entries = new Map<string, Entry>();
  readonly live: Array<{ at: number; frame: MessageOf<"live"> }> = [];
  /** Texts shown, per turn. */
  readonly shown = new Map<string, string[]>();
  readonly receiver = new LiveReceiver();
  resyncs = 0;
  logId: string | null = null;
  seq = -1;
  lastHash: string | null = null;
  private socket: Socket | null = null;
  private readonly splitter = new FrameSplitter();
  constructor(readonly name: string) {}

  async connect(server: TestServer): Promise<void> {
    const socket = createConnection(server.socket);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => { socket.once("connect", () => resolve()); socket.once("error", reject); });
    socket.on("data", (chunk: Buffer) => {
      const split = this.splitter.push(chunk);
      if (!split.ok) { this.violations.push(split.detail); return; }
      const now = performance.now();
      for (const frame of split.frames) {
        const decoded = decodeFrame(frame, "server", { local: true });
        if (!decoded.ok) { this.violations.push(`bad frame: ${decoded.detail}`); continue; }
        this.take(decoded.message, now);
      }
    });
    socket.on("error", () => undefined);
    this.send({ t: "hello", deviceId: `fe-${this.name}`, feVersion: "3.0.0", protocol: 1, originEpoch: "e".repeat(32), cursors: {}, outbox: [], want: [], token: server.token } as Message);
    await until(() => this.received.some((m) => m.t === "welcome") || null, { what: `${this.name} welcome` });
    this.send({ t: "sub", stream, cursor: null } as Message);
  }

  send(message: Message): void {
    const encoded = encodeFrame(message, "fe", { local: true });
    if (!encoded.ok) throw new Error(encoded.detail);
    this.socket?.write(packFrame(encoded.text));
  }

  close(): void { this.socket?.destroy(); }

  framesOf(turnId: string): Array<{ at: number; frame: MessageOf<"live"> }> { return this.live.filter((item) => item.frame.turnId === turnId); }

  private take(message: Message, now: number): void {
    this.received.push(message);
    if ((message as { via?: unknown }).via !== undefined) this.violations.push(`${message.t} with a via`);
    if (!("stream" in message) || message.stream !== stream) return;
    if (message.t === "live") {
      this.live.push({ at: now, frame: message });
      const result = this.receiver.apply(message);
      if (result === "resync") { this.resyncs++; this.send({ t: "live.resync", stream } as Message); }
      const view = this.receiver.view(stream);
      if (result === "applied" && view) { const list = this.shown.get(view.turnId) ?? []; list.push(view.text); this.shown.set(view.turnId, list); }
    } else if (message.t === "reset") {
      this.logId = message.logId; this.seq = -1; this.lastHash = null;
    } else if (message.t === "snap") {
      if (this.logId === message.logId && message.seq < this.seq) this.violations.push(`older snapshot ${message.seq} < ${this.seq}`);
      this.logId = message.logId; this.seq = message.seq; this.lastHash = message.hash;
    } else if (message.t === "batch") {
      if (message.logId !== this.logId) { this.violations.push("batch of another logId"); return; }
      if (message.from <= this.seq) this.violations.push(`duplicate: entry ${message.from} ≤ cursor ${this.seq}`);
      if (message.from > this.seq + 1) this.violations.push(`gap: ${message.from} after ${this.seq}`);
      if (message.prevHash !== this.lastHash) this.violations.push(`prevHash does not chain at ${message.from}`);
      const check = verifyChain(message.prevHash, message.entries);
      if (!check.ok) this.violations.push(`chain broken at ${check.seq}`);
      for (const entry of message.entries) {
        this.entries.set(`${entry.logId}:${entry.seq}`, entry);
        if (entry.kind === "turn.finished") this.receiver.drop(stream); // the entries replace the live text
      }
      this.seq = message.to;
      this.lastHash = message.entries[message.entries.length - 1]!.hash;
      this.send({ t: "ack", stream, cursor: { logId: message.logId, seq: message.to } } as Message);
    }
  }

  finished(turnId: string): { text: string; status: string } | null {
    for (const entry of this.entries.values()) {
      const body = entry.body as { turnId?: string; text?: string; status?: string };
      if (entry.kind === "turn.finished" && body.turnId === turnId) return { text: String(body.text), status: String(body.status) };
    }
    return null;
  }

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

let script: Awaited<ReturnType<TestServer["client"]>> | null = null;
let inc = "";
let n = 1;

/** A `/say` turn on B's bot, from B's own socket; resolves with the time it was sent. */
async function say(text: string): Promise<number> {
  const at = performance.now();
  script!.cmd({ origin: "script", originEpoch: script!.originEpoch, target: stream, n: ++n } as Slot, { type: "chat.send", botId: botB, text: `/say ${text}` }, inc);
  return at;
}

const words = (count: number, tag: string) => Array.from({ length: count }, (_, i) => `${tag}${String(i + 1).padStart(4, "0")}`).join(" ");

/**
 * Most frames in any window of `windowMs` (receive times). The servers space frames ≥ 100 ms apart when they send them;
 * the test process reads them a few ms late now and then, so the checks use a window of 980 ms (20 ms of read jitter)
 * and the report also gives the strict 1000 ms count.
 */
function maxPerSecond(times: number[], windowMs = 1000): number {
  let best = 0;
  for (let i = 0, j = 0; i < times.length; i++) { while (times[i]! - times[j]! >= windowMs) j++; best = Math.max(best, i - j + 1); }
  return best;
}
const JITTER_WINDOW_MS = 980;

async function atHead(fe: Fe, what: string, timeout = 45_000): Promise<void> {
  await until(() => { const head = headOf(b); return head && fe.logId === head.logId && fe.seq === head.seq ? true : null; }, { timeout, every: 50, what });
}

/** The turn whose live frames carry `marker` (a word of its text). */
async function turnOf(fe: Fe, marker: string, what: string): Promise<string> {
  return until(() => fe.live.find((item) => item.frame.text.includes(marker))?.frame.turnId ?? null, { timeout: 30_000, every: 10, what });
}

/** The connections open through a proxy now, from its events. */
function openConns(proxy: FaultProxy): Set<number> {
  const open = new Set<number>();
  for (const event of proxy.events) {
    if (event.action === "open") open.add(event.conn);
    else if (event.action === "close") open.delete(event.conn);
  }
  return open;
}
const sessionEnds = () => (a.log.match(/session ended/g) ?? []).length + (b.log.match(/session ended/g) ?? []).length;

/** The checks every turn must pass at the front end on A. */
function checkTurn(fe: Fe, turnId: string, expected: string, label: string): { frames: number; beforeCommit: number; maxPerSecond: number; strictPerSecond: number; minGapMs: number } {
  const finished = fe.finished(turnId)!;
  expect(finished, label).toBeTruthy();
  expect(finished.text.trim(), label).toBe(expected);
  const shown = fe.shown.get(turnId) ?? [];
  for (const text of shown) expect(finished.text.startsWith(text), `${label}: "${text.slice(-30)}" is not a prefix of the reply`).toBe(true);
  const frames = fe.framesOf(turnId);
  const commitAt = fe.received.findIndex((m) => m.t === "batch" && m.entries.some((e) => e.kind === "turn.finished" && (e.body as { turnId?: string }).turnId === turnId));
  const beforeCommit = frames.filter((item) => fe.received.indexOf(item.frame) < commitAt).length;
  const times = frames.map((item) => item.at);
  const minGapMs = Math.round(Math.min(...times.slice(1).map((at, i) => at - times[i]!)));
  return { frames: frames.length, beforeCommit, maxPerSecond: maxPerSecond(times, JITTER_WINDOW_MS), strictPerSecond: maxPerSecond(times), minGapMs };
}

beforeAll(async () => {
  cluster = await startServers({ name: "live", count: 2, env: { A: ENV, B: ENV } });
  ({ a, b } = cluster);
  await Promise.all([a.stop(), b.stop()]);
  [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
  pa = await cluster.proxy(a, "websocket", 31);
  pb = await cluster.proxy(b, "websocket", 32);
  const made = await makeCluster([ka, kb]);
  writeStatements(a.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, kb, kb, pb.port)]);
  writeStatements(b.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, ka, ka, pa.port)]);
  await Promise.all([a.start(), b.start()]);

  script = await b.client("script", "d".repeat(32));
  await script.sub(script.srv);
  const snap = await script.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === script!.srv, "srv snap");
  inc = snap.logId;
  script.cmd({ origin: "script", originEpoch: script.originEpoch, target: script.srv, n: 1 } as Slot, { type: "bots.create", name: "Remote writer", job: "live text test" }, inc);
  const created = await script.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === 1, "bots.create");
  botB = (created.outcome as { result: { botId: string } }).result.botId;
  stream = `bot:${botB}`;
  await until(() => withDb(a, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(`srv:${kb.memberId}`, stream)), { timeout: 30_000, what: "A's copy names B's bot" });
}, 180_000);

afterAll(async () => {
  script?.close();
  console.log(JSON.stringify({ liveAcrossServers: report }));
  await cluster?.cleanup();
}, 60_000);

describe("live text across servers (two botlingd, fault proxy)", () => {
  let fe: Fe;
  let local: Fe;

  it("a fake-engine turn on B streams to a front end on A: ≥ 5 frames before the commit, ≤ 10/s, final text = B's entry", async () => {
    fe = new Fe("on-a");
    await fe.connect(a);
    local = new Fe("on-b");
    await local.connect(b);
    await until(() => (fe.logId && local.logId ? true : null), { what: "both front ends subscribed" });
    const text = words(300, "s"); // ≈ 4.5 s of streaming
    const sentAt = await say(text);
    const turnId = await turnOf(fe, "s0001", "first live frame on A");
    await until(() => fe.finished(turnId), { timeout: 60_000, what: "the reply committed" });
    await atHead(fe, "FE on A at B's head");
    await until(() => local.finished(turnId), { timeout: 30_000, what: "the reply on B's own front end" });
    fe.checkAgainst(b);
    expect(fe.violations).toEqual([]);
    expect(local.violations).toEqual([]);
    const got = checkTurn(fe, turnId, text, "stream");
    expect(got.beforeCommit).toBeGreaterThanOrEqual(5);
    expect(got.maxPerSecond).toBeLessThanOrEqual(10);
    expect(fe.resyncs).toBe(0);
    const firstA = fe.framesOf(turnId)[0]!.at - sentAt;
    const firstB = local.framesOf(turnId)[0]!.at - sentAt;
    const gaps = fe.framesOf(turnId).slice(1).map((item, i) => item.at - fe.framesOf(turnId)[i]!.at).sort((x, y) => x - y);
    report.stream = {
      frames: got.frames, beforeCommit: got.beforeCommit, maxPerSecond: got.maxPerSecond, strictPerSecond: got.strictPerSecond, minGapMs: got.minGapMs,
      seconds: +((fe.framesOf(turnId).at(-1)!.at - fe.framesOf(turnId)[0]!.at) / 1000).toFixed(2),
      firstFrameMsOnA: Math.round(firstA), firstFrameMsOnB: Math.round(firstB), extraHopMs: Math.round(firstA - firstB),
      medianGapMs: Math.round(gaps[Math.floor(gaps.length / 2)]!), p95GapMs: Math.round(gaps[Math.floor(gaps.length * 0.95)]!),
      framesOnB: local.framesOf(turnId).length,
    };
    for (const server of [a, b]) server.assertLoopbackOnly({ expectListener: true });
  }, 120_000);

  for (const fault of ["drop", "cut"] as const) {
    it(`a ${fault} mid-turn: the session ends, the stream comes back, no committed text lost or doubled`, async () => {
      const ends = sessionEnds();
      const tag = fault === "drop" ? "d" : "c";
      const text = words(600, tag); // ≈ 9 s
      await say(text);
      const turnId = await turnOf(fe, `${tag}0001`, `first live frame (${fault})`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const framesBefore = fe.framesOf(turnId).length;
      const faultAt = performance.now();
      if (fault === "drop") {
        // Only on the connections open now: a drop still armed when the session ends (its direction had sent nothing
        // yet) must not take the next dial's first handshake frame, which only the 15 s handshake timeout ends.
        for (const proxy of [pa, pb]) {
          const now = openConns(proxy);
          const ours = (_: Buffer, conn: number) => now.has(conn);
          proxy.drop("down", 1, ours).drop("up", 1, ours);
        }
      }
      else { pa.cut(); pb.cut(); }
      await until(() => (sessionEnds() > ends ? true : null), { timeout: 20_000, what: `the ${fault} ended the session` });
      // Live frames come again after the redial, before the turn ends.
      const back = await until(() => fe.framesOf(turnId).find((item) => item.at > faultAt + 50 && sessionEnds() > ends) ?? null, { timeout: 20_000, every: 10, what: `live frames after the ${fault}` });
      await until(() => fe.finished(turnId), { timeout: 60_000, what: `the reply committed (${fault})` });
      await atHead(fe, `FE at B's head after the ${fault}`);
      fe.checkAgainst(b);
      expect(fe.violations, fault).toEqual([]);
      const got = checkTurn(fe, turnId, text, fault);
      expect(got.beforeCommit).toBeGreaterThanOrEqual(5);
      expect(got.maxPerSecond).toBeLessThanOrEqual(10);
      // The reply's text arrived once: one turn.finished, one message.added of the reply (no doubled committed text).
      const ofTurn = [...fe.entries.values()].filter((e) => (e.body as { turnId?: string }).turnId === turnId && e.kind === "turn.finished");
      expect(ofTurn.length).toBe(1);
      report[fault] = { framesBefore, frames: got.frames, beforeCommit: got.beforeCommit, maxPerSecond: got.maxPerSecond, strictPerSecond: got.strictPerSecond, minGapMs: got.minGapMs, backAfterMs: Math.round(back.at - faultAt), feResyncs: fe.resyncs };
    }, 120_000);
  }
});
