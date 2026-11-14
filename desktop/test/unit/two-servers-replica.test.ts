// Botling 3 M3 step 7 (m3-brief §4 row 7): summary replication between real botlingd on this machine. Three servers
// (A, B, C) from the two-server harness; the A–B sessions run through a fault proxy in front of each of them, C is
// reached directly (statements written into each server.db while it is stopped, as in step 3).
//
// - A holds B's `srv:` table equal to B's after each batch (bot summary rows from a real fake-engine turn, the machine
//   row, rows of a kind this version does not know, tombstones), and C's table too (a third server's table reaches A
//   over its own session).
// - Proxy drop, duplicate, cut and partition while B keeps writing: each ends the session; A catches up from its
//   cursor; afterwards A's copy equals B's table, every row written is there exactly once, the copy's head never went
//   down. During the partition A marks B stale since its own last frame time and an attached front end gets
//   `peer{B, stale, since}`; the front end reads B's table from A's copy as `rows` batches meanwhile.
// - SIGKILL of B mid-writes and of A: the copy survives A's restart and catches up.
// - B restored (`botlingd restore`): A takes the `reset`, retires the old logId, drops the rows written after the
//   backup, and never applies an old row again (also not after A's own restart).
// Requires `npm run build` (out/server/main.cjs).
import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FrameSplitter, packFrame, type Message, type MessageOf, type Slot, type WireMessage } from "../../src/protocol";
import { decodeWireFrame, encodeFrame } from "../../src/protocol/frame";
import type { Rows } from "../../src/protocol/table-rows";
import { MAIN } from "../botlingd-harness";
import { until } from "../helpers";
import type { FaultProxy } from "../support/fault-proxy";
import { makeCluster, profile, readServerKeys, writeStatements, type MemberKeysInfo } from "../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../support/two-servers";
import { applyRows, emptyTable, type TableCopy } from "../../src/server/replica/tables";

const TIMERS = { ping: 300, dead: 1_500, redial: 150, redialMax: 1_000, revoked: 2_500 };
const TIMERS_ENV = { BOTLING_SERVER_PEER_TIMERS: Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(",") };

let cluster: TestCluster;
let a: TestServer, b: TestServer, c: TestServer;
let ka: MemberKeysInfo, kb: MemberKeysInfo, kc: MemberKeysInfo;
let pa: FaultProxy, pb: FaultProxy;
let streamB: string, streamC: string;

// ---------------------------------------------------------------------------------------------
// Reading and writing a server's store from the test (WAL: a second connection reads committed state)

type RowMap = Record<string, { rev: number; body: unknown }>;

function withDb<T>(server: TestServer, run: (db: DatabaseSync) => T, readOnly = true): T {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly });
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    return run(db);
  } finally { db.close(); }
}

/** A table's live rows (the owner's own table, or a server's copy of a peer's). */
function liveRows(server: TestServer, stream: string): RowMap {
  return withDb(server, (db) => {
    const out: RowMap = {};
    for (const row of db.prepare("SELECT key, rev, body FROM rows WHERE stream = ? AND deleted = 0 ORDER BY key").all(stream) as Array<{ key: string; rev: number; body: string }>) {
      out[row.key] = { rev: Number(row.rev), body: JSON.parse(row.body) };
    }
    return out;
  });
}
const ownRev = (server: TestServer, stream: string) => withDb(server, (db) => Number((db.prepare("SELECT MAX(rev) AS rev FROM rows WHERE stream = ?").get(stream) as { rev: number | null }).rev ?? 0));
function streamRow(server: TestServer, stream: string): { logId: string; head: number; state: string; heardAt: number | null } | null {
  return withDb(server, (db) => {
    const row = db.prepare("SELECT logId, head, state, heardAt FROM streams WHERE stream = ?").get(stream) as { logId: string; head: number; state: string; heardAt: number | null } | undefined;
    return row ? { logId: String(row.logId), head: Number(row.head), state: String(row.state), heardAt: row.heardAt == null ? null : Number(row.heardAt) } : null;
  });
}
const retiredOf = (server: TestServer, stream: string) => withDb(server, (db) => (db.prepare("SELECT logId FROM retired WHERE stream = ?").all(stream) as Array<{ logId: string }>).map((row) => String(row.logId)));

let written = 0;
/** Rows written straight into B's table while it runs (as the roster writes its audit rows): B's feed pushes them. */
function writeRows(server: TestServer, stream: string, count: number, tag: string, options: { deleteEvery?: number } = {}): string[] {
  const keys: string[] = [];
  withDb(server, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (let i = 0; i < count; i++) {
        const rev = Number((db.prepare("SELECT MAX(rev) AS rev FROM rows WHERE stream = ?").get(stream) as { rev: number | null }).rev ?? 0) + 1;
        written++;
        const unknown = written % 3 === 0;
        const key = unknown ? `future:${tag}${i}` : `audit:${tag}${i}`;
        const body = unknown ? { tag, i, nested: { n: written } } : { act: "test", at: written, reason: `${tag} ${i}` };
        db.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, ?, ?, 0) ON CONFLICT (stream, key) DO UPDATE SET rev = excluded.rev, body = excluded.body, deleted = 0").run(stream, key, rev, JSON.stringify(body));
        keys.push(key);
        if (options.deleteEvery && i % options.deleteEvery === options.deleteEvery - 1) {
          const victim = keys[i - 1]!;
          db.prepare("UPDATE rows SET rev = ?, body = ?, deleted = 1 WHERE stream = ? AND key = ?").run(rev + 1, JSON.stringify({ deletedAt: Date.now() }), stream, victim);
        }
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }, false);
  return keys;
}

/** A's copy of `stream` equals the owner's table, at the owner's rev. */
async function copyEqual(reader: TestServer, owner: TestServer, stream: string, what: string, timeout = 30_000): Promise<RowMap> {
  return until(() => {
    const own = liveRows(owner, stream);
    const copy = liveRows(reader, stream);
    const state = streamRow(reader, stream);
    if (!state || state.head !== ownRev(owner, stream) || state.logId !== streamRow(owner, stream)?.logId) return null;
    return JSON.stringify(copy) === JSON.stringify(own) ? copy : null;
  }, { timeout, every: 50, what });
}

/** Samples the copy's head while `run` runs: it never goes down within one logId. */
function watchHead(reader: TestServer, stream: string): { stop(): void; violations: string[]; samples: number } {
  const seen = new Map<string, number>();
  const result = { violations: [] as string[], samples: 0, stop: () => clearInterval(timer) };
  const timer = setInterval(() => {
    try {
      const state = streamRow(reader, stream);
      if (!state) return;
      result.samples++;
      const before = seen.get(state.logId) ?? 0;
      if (state.head < before) result.violations.push(`head ${before} → ${state.head}`);
      seen.set(state.logId, Math.max(before, state.head));
    } catch { /* the server is restarting */ }
  }, 25);
  return result;
}

// ---------------------------------------------------------------------------------------------
// A front end on A's local socket that reads the M3 wire set (`rows`), unlike the M1 ScriptClient.

class WireClient {
  readonly received: WireMessage[] = [];
  welcome: MessageOf<"welcome"> | null = null;
  closed = false;
  private readonly splitter = new FrameSplitter();
  private socket: Socket | null = null;
  readonly errors: string[] = [];
  copy: TableCopy = emptyTable();
  private parts: Rows[] = [];
  frames = 0;

  async connect(server: TestServer): Promise<void> {
    const socket = createConnection(server.socket);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => { socket.once("connect", () => resolve()); socket.once("error", reject); });
    socket.on("data", (chunk: Buffer) => {
      const split = this.splitter.push(chunk);
      if (!split.ok) { this.errors.push(split.detail); return; }
      for (const frame of split.frames) {
        const decoded = decodeWireFrame(frame, "server", { local: true });
        if (!decoded.ok) { this.errors.push(decoded.detail); continue; }
        this.take(decoded.message);
      }
    });
    socket.on("close", () => { this.closed = true; });
    socket.on("error", () => undefined);
    this.send({ t: "hello", deviceId: "wire", feVersion: "3.0.0", protocol: 1, originEpoch: "e".repeat(32), cursors: {}, outbox: [], want: [], token: server.token } as Message);
    this.welcome = await until(() => (this.received.find((m) => m.t === "welcome") as MessageOf<"welcome"> | undefined) ?? null, { what: "welcome" });
  }

  send(message: Message): void {
    const encoded = encodeFrame(message, "fe", { local: true });
    if (!encoded.ok) throw new Error(encoded.detail);
    this.socket!.write(packFrame(encoded.text));
  }

  close(): void { this.socket?.destroy(); }

  private take(message: WireMessage): void {
    this.received.push(message);
    if (message.t !== "rows") return;
    this.frames++;
    this.parts.push(message as Rows);
    if (message.more) return;
    const parts = this.parts;
    this.parts = [];
    try { this.copy = applyRows(this.copy, parts); } catch (error) { this.errors.push(String(error)); }
  }
}

const asMap = (copy: TableCopy): RowMap => Object.fromEntries([...copy.rows.entries()].sort(([x], [y]) => (x < y ? -1 : 1)));
/** The proxy the live A–B session runs through (the dialler connects to the other side's proxy). */
function liveProxy(): FaultProxy {
  const file = JSON.parse(readFileSync(join(a.dataDir, "botlingd.peers.json"), "utf8")) as { peers: Array<{ member: string; initiator?: string }> };
  const initiator = file.peers.find((peer) => peer.member === kb.memberId)?.initiator;
  return initiator === ka.memberId ? pb : pa;
}

beforeAll(async () => {
  cluster = await startServers({ name: "replica", count: 3, env: { A: TIMERS_ENV, B: TIMERS_ENV, C: TIMERS_ENV } });
  ({ a, b } = cluster);
  c = cluster.server("C");
  await Promise.all([a.stop(), b.stop(), c.stop()]);
  [ka, kb, kc] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir), readServerKeys(c.dataDir)]);
  pa = await cluster.proxy(a, "websocket");
  pb = await cluster.proxy(b, "websocket");
  const made = await makeCluster([ka, kb, kc]);
  const id = made.clusterId;
  // A and B reach each other through the proxies; C is reached at its own port and reaches the others directly.
  writeStatements(a.dataDir, id, [...made.statements, await profile(id, kb, kb, pb.port), await profile(id, kc, kc, c.port)]);
  writeStatements(b.dataDir, id, [...made.statements, await profile(id, ka, ka, pa.port), await profile(id, kc, kc, c.port)]);
  writeStatements(c.dataDir, id, [...made.statements, await profile(id, ka, ka, a.port), await profile(id, kb, kb, b.port)]);
  await Promise.all([a.start(), b.start(), c.start()]);
  streamB = `srv:${kb.memberId}`;
  streamC = `srv:${kc.memberId}`;
}, 120_000);

afterAll(async () => { await cluster?.cleanup(); }, 60_000);

describe("M3 step 7: summary replication between botlingd", () => {
  it("A holds B's and C's srv: tables equal to theirs; a real turn on B reaches A's copy; FEs on A see the peers", async () => {
    const copyB = await copyEqual(a, b, streamB, "A's copy of B");
    expect(Object.keys(copyB)).toEqual(expect.arrayContaining([`bot:${MAIN}`, "machine"]));
    await copyEqual(a, c, streamC, "A's copy of C (third server)");
    await copyEqual(b, a, `srv:${ka.memberId}`, "B's copy of A");
    await copyEqual(c, b, streamB, "C's copy of B");
    expect(streamRow(a, streamB)).toMatchObject({ state: "live" });
    for (const server of [a, b, c]) server.assertLoopbackOnly({ expectListener: true });

    // A real turn on B: B's summary row changes; A's copy follows.
    const client = await b.client("script", "d".repeat(32));
    await client.sub(client.srv);
    const srvSnap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
    const marker = `replicated ${Date.now()}`;
    const slot: Slot = { origin: "script", originEpoch: client.originEpoch, target: `bot:${MAIN}` as Slot["target"], n: 1 };
    client.cmd(slot, { type: "chat.send", botId: MAIN, text: `/say ${marker}` }, srvSnap.logId);
    await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === 1, "cmd.result");
    await until(() => JSON.stringify(liveRows(a, streamB)[`bot:${MAIN}`]?.body ?? {}).includes(marker), { timeout: 30_000, what: "the marker in A's copy of B's main row" });
    client.close();
    await copyEqual(a, b, streamB, "A's copy after the turn");

    // A front end on A: welcome lists B and C; B's table from A's copy as rows batches.
    const fe = new WireClient();
    await fe.connect(a);
    expect(fe.welcome!.servers.map((s) => s.id).sort()).toEqual([ka.memberId, kb.memberId, kc.memberId].sort());
    expect(fe.welcome!.servers.find((s) => s.id === kb.memberId)?.state).toBe("live");
    fe.send({ t: "sub", stream: streamB, cursor: null } as Message);
    await until(() => JSON.stringify(asMap(fe.copy)) === JSON.stringify(liveRows(a, streamB)), { what: "FE copy = A's copy" });
    expect(fe.errors).toEqual([]);
    fe.close();
  }, 120_000);

  it("drop, duplicate, cut and partition while B writes: A catches up with no lost or duplicated row; stale and peer{stale} during the partition", async () => {
    await copyEqual(a, b, streamB, "start");
    const watch = watchHead(a, streamB);
    const fe = new WireClient();
    await fe.connect(a);
    fe.send({ t: "sub", stream: streamB, cursor: null } as Message);
    const all: string[] = [];
    const sessionEnds = () => (a.log.match(/session ended/g) ?? []).length + (b.log.match(/session ended/g) ?? []).length;

    for (const fault of ["drop", "duplicate", "cut", "partition"] as const) {
      const ends = sessionEnds();
      all.push(...writeRows(b, streamB, 20, `${fault}-pre`, { deleteEvery: 5 }));
      await copyEqual(a, b, streamB, `before ${fault}`);
      const at = Date.now();
      const seenBefore = fe.received.length;
      if (fault === "drop") liveProxy().drop("down", 1).drop("up", 1);
      if (fault === "duplicate") liveProxy().duplicate("down", 1).duplicate("up", 1);
      if (fault === "cut") { pa.cut(); pb.cut(); }
      if (fault === "partition") { pa.partition(); pb.partition(); }
      // B keeps writing through the fault (some of it is pushed into the lost frames).
      for (let k = 0; k < 4; k++) { all.push(...writeRows(b, streamB, 15, `${fault}-${k}-`, { deleteEvery: 4 })); await new Promise((resolve) => setTimeout(resolve, 150)); }
      if (fault === "partition") {
        // A says B is stale since its own last frame heard, after the dead time; the FE gets peer{B, stale, since}.
        const stale = await until(() => { const row = streamRow(a, streamB); return row?.state === "stale" ? row : null; }, { timeout: 20_000, what: "A's copy of B stale" });
        expect(Date.now() - at).toBeGreaterThanOrEqual(TIMERS.dead - 200);
        expect(stale.heardAt!).toBeLessThanOrEqual(at + TIMERS.ping + 200);
        expect(stale.heardAt!).toBeGreaterThan(at - TIMERS.dead);
        // (Every session end says stale; the partition's is the last one, once A's copy is stale.)
        const peer = await until(() => (fe.received.slice(seenBefore).findLast((m) => m.t === "peer" && m.serverId === kb.memberId && m.state === "stale") as MessageOf<"peer"> | undefined) ?? null, { what: "peer{B, stale}" });
        expect(peer.since).toBe(stale.heardAt);
        // Meanwhile a new FE still reads B's table from A's copy.
        const late = new WireClient();
        await late.connect(a);
        expect(late.welcome!.servers.find((s) => s.id === kb.memberId)).toMatchObject({ state: "stale", since: stale.heardAt });
        late.send({ t: "sub", stream: streamB, cursor: null } as Message);
        await until(() => JSON.stringify(asMap(late.copy)) === JSON.stringify(liveRows(a, streamB)) && late.frames > 0, { what: "late FE served from the stale copy" });
        late.close();
        pa.heal(); pb.heal();
        await until(() => fe.received.some((m) => m.t === "peer" && m.serverId === kb.memberId && m.state === "live" && fe.received.indexOf(m) > fe.received.indexOf(peer)), { timeout: 30_000, what: "peer{B, live} again" });
      }
      const copy = await copyEqual(a, b, streamB, `after ${fault}`, 45_000);
      expect(sessionEnds(), `the ${fault} ended the session`).toBeGreaterThan(ends);
      // Every row written is in the copy exactly once (keys are unique; the last write of each key is the one kept).
      const own = liveRows(b, streamB);
      for (const key of all) expect(key in copy).toBe(key in own);
    }
    watch.stop();
    expect(watch.violations).toEqual([]);
    expect(watch.samples).toBeGreaterThan(20);
    // The FE on A followed the copy through all of it.
    await until(() => JSON.stringify(asMap(fe.copy)) === JSON.stringify(liveRows(a, streamB)), { what: "FE copy after the faults" });
    expect(fe.errors).toEqual([]);
    fe.close();
    expect(pa.count("drop") + pb.count("drop")).toBeGreaterThan(0);
    expect(pa.count("duplicate") + pb.count("duplicate")).toBeGreaterThan(0);
  }, 240_000);

  it("SIGKILL of B mid-writes and of A: the copy survives A's restart and catches up", async () => {
    await copyEqual(a, b, streamB, "start");
    writeRows(b, streamB, 30, "kill-b-");
    await b.kill();
    await b.start();
    writeRows(b, streamB, 10, "after-b-");
    await copyEqual(a, b, streamB, "after B's SIGKILL");
    const before = streamRow(a, streamB)!;
    await a.kill();
    writeRows(b, streamB, 10, "while-a-down-");
    // The copy is still in A's store while A is down, at its old head.
    expect(streamRow(a, streamB)).toMatchObject({ logId: before.logId, head: before.head });
    await a.start();
    await copyEqual(a, b, streamB, "after A's SIGKILL");
    expect(a.log).not.toMatch(/tables: .*(gap|another logId)/);
  }, 180_000);

  it("B restored: A takes the reset, retires the old logId, drops the rows written after the backup, never applies an old row again", async () => {
    await copyEqual(a, b, streamB, "start");
    const oldLogId = streamRow(b, streamB)!.logId;
    const backup = b.backup();
    const lost = writeRows(b, streamB, 12, "after-backup-");
    const copy = await copyEqual(a, b, streamB, "A has the rows written after the backup");
    for (const key of lost) expect(key in copy).toBe(true);
    await b.restore(backup);
    const newLogId = streamRow(b, streamB)!.logId;
    expect(newLogId).not.toBe(oldLogId);
    const after = await copyEqual(a, b, streamB, "A's copy follows the restore", 45_000);
    for (const key of lost) expect(key in after).toBe(false);
    expect(retiredOf(a, streamB)).toContain(oldLogId);
    expect(streamRow(a, streamB)!.logId).toBe(newLogId);
    expect(a.log).toMatch(/copy of srv:\S+ reset/);
    // New writes after the restore arrive; A's restart keeps the new incarnation, no old row comes back.
    writeRows(b, streamB, 5, "post-restore-");
    await copyEqual(a, b, streamB, "post restore writes");
    await a.kill();
    await a.start();
    const final = await copyEqual(a, b, streamB, "after A's restart");
    for (const key of lost) expect(key in final).toBe(false);
    expect(streamRow(a, streamB)!.logId).toBe(newLogId);
    // C followed the restore too.
    const atC = await copyEqual(c, b, streamB, "C's copy follows the restore", 45_000);
    for (const key of lost) expect(key in atC).toBe(false);
  }, 180_000);
});
