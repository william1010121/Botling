// Botling 3 M3 step 9 (m3-brief §4 row 9, §5.9: stand-in for the skipped `Routing` forwarding gate): commands from
// phones attached to server A for bots owned by server B, forwarded by A, between real botlingd on this machine.
// The A–B peer session runs through a fault proxy in front of each server; the phones reach A through a third proxy.
//
// - The seeded fault runs: two phones (paired at A through the real pairing path; B learns them by gossip) send
//   commands to a bot on B and to B's server stream, cancel some, while the proxies drop and duplicate frames at random,
//   cut every connection, partition and heal, and A or B is SIGKILLed and restarted at random points. Then everything
//   heals. Checked: every command has exactly one outcome at its phone and exactly one outcome entry in B's log (0 lost,
//   0 applied twice), outcomes in slot order per (origin, epoch, target) in B's log, the phone's outcome = B's; every
//   cancel answered (cancel.noted or the slot's cmd.result); A's forwardq and fwdcancels empty; `held` only for a slot
//   whose row A committed (checked while B is cut off: the row is there when `held` arrives).
// - F3: while B is unreachable A answers `held` and nothing else; only B's decision comes back.
// - Q3: a target no server claims is refused definitely (an outcome from the server that decides it), never held.
// - B restored from a backup while A holds commands for it: copies under the old `inc` get cmd.retry (A drops them and
//   passes them on), are re-sent under the new `inc`, and run once; nothing the phone saw runs again (D49).
// - A device revoked on A while A holds its commands for B: B refuses them (origin), none applied; A never refuses.
// Requires `npm run build` (out/server/main.cjs). Runs: FORWARD_FAULT_RUNS × FORWARD_FAULT_COMMANDS (default 6 × 60;
// the evidence run used 20 × 200).
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, decodeFrame, encodeFrame, fromBase64Url, slotKey, type Message, type MessageOf, type Slot } from "../../src/protocol";
import { SessionLink } from "../../src/session";
import { webSocketConnector } from "../../src/server/peer";
import type { ScriptClient } from "../botlingd-harness";
import { until } from "../helpers";
import type { FaultProxy } from "../support/fault-proxy";
import { seededRandom } from "../support/fault-proxy";
import { makeCluster, profile, readServerKeys, writeStatements, type MemberKeysInfo } from "../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../support/two-servers";
import { admin, pairPhone, type DeviceKeys } from "../support/ws-device";

const TIMERS = { ping: 300, dead: 1_500, redial: 150, redialMax: 800, revoked: 2_500 };
const TIMERS_ENV = { BOTLING_SERVER_PEER_TIMERS: Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(",") };
const RUNS = Number(process.env.FORWARD_FAULT_RUNS ?? 6);
const COMMANDS = Number(process.env.FORWARD_FAULT_COMMANDS ?? 60);
const REMOTE = { local: false } as const;
const encoder = new TextEncoder();

let cluster: TestCluster;
let a: TestServer, b: TestServer;
let ka: MemberKeysInfo, kb: MemberKeysInfo;
let pa: FaultProxy, pb: FaultProxy, pf: FaultProxy;
let clusterId: string;
let botB: string;
let messageB: string;
const srvB = () => `srv:${kb.memberId}`;

// ---------------------------------------------------------------------------------------------
// Reading a running server's store (WAL: a second connection reads committed state)

function withDb<T>(server: TestServer, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout = 10000"); return run(db); } finally { db.close(); }
}
const forwardLeft = (server: TestServer) => withDb(server, (db) => ({
  rows: Number((db.prepare("SELECT COUNT(*) AS n FROM forwardq").get() as { n: number }).n),
  cancels: Number((db.prepare("SELECT COUNT(*) AS n FROM fwdcancels").get() as { n: number }).n),
}));
const hasRow = (server: TestServer, slot: Slot) => withDb(server, (db) => !!db.prepare("SELECT 1 FROM forwardq WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ?").get(slot.origin, slot.originEpoch, slot.target, slot.n));
/** The logId of B's srv: stream as A's copy knows it: what a front end on A stamps as `inc` for B (§11.1, §13.1). */
const incAtA = () => withDb(a, (db) => (db.prepare("SELECT logId FROM streams WHERE stream = ?").get(srvB()) as { logId: string } | undefined)?.logId ?? null);
const logIdOf = (server: TestServer, stream: string) => withDb(server, (db) => String((db.prepare("SELECT logId FROM streams WHERE stream = ?").get(stream) as { logId: string }).logId));
const retiredAtB = () => withDb(b, (db) => new Set((db.prepare("SELECT logId FROM retired").all() as Array<{ logId: string }>).map((row) => String(row.logId))));

interface OutcomeEntry { seq: number; kind: string; slot: Slot }
/** Every outcome entry in a server's log for slots of `origin`, in seq order per stream. */
function outcomesAt(server: TestServer, origin: string): OutcomeEntry[] {
  return withDb(server, (db) => (db.prepare("SELECT stream, seq, kind, slot FROM entries WHERE kind IN ('cmd.applied', 'cmd.refused', 'cmd.cancelled') AND slot IS NOT NULL ORDER BY stream, seq").all() as Array<{ seq: number; kind: string; slot: string }>)
    .map((row) => ({ seq: Number(row.seq), kind: String(row.kind), slot: JSON.parse(row.slot) as Slot }))
    .filter((entry) => entry.slot.origin === origin));
}

// ---------------------------------------------------------------------------------------------
// A phone on A: an outbox per (target) queue, re-sent in slot order on every session, through the phone proxy.

interface Item { n: number; cmd: Record<string, unknown>; outcome: string | null; cancel: boolean; cancelAnswered: boolean; retryInc: string | null; held: boolean }

class Phone {
  readonly queues = new Map<string, Map<number, Item>>();
  readonly next = new Map<string, number>();
  readonly log: Message[] = [];
  readonly problems: string[] = [];
  link: SessionLink | null = null;
  open = false;
  stopped = false;
  sessions = 0;
  epoch: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The `inc` a front end on A stamps: B's logId as A's copy knows it, or A's own for a target A decides. */
  incFor(target: string): string | null { return target.startsWith("bot:") && target !== `bot:${botB}` ? logIdOf(a, `srv:${ka.memberId}`) : incAtA(); }
  /** Called on each `held` (the test checks the row is there when B is cut off). */
  onHeld: ((slot: Slot) => void) | null = null;

  constructor(readonly keys: DeviceKeys, epoch: string) { this.epoch = epoch; }
  get id(): string { return this.keys.member; }

  start(): void {
    this.stopped = false;
    void this.connect();
    this.timer ??= setInterval(() => this.retries(), 100);
  }

  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; this.link?.close(); }
  cut(): void { this.link?.close(); }

  add(target: string, cmd: Record<string, unknown>): Slot {
    const n = (this.next.get(target) ?? 0) + 1;
    this.next.set(target, n);
    let queue = this.queues.get(target);
    if (!queue) this.queues.set(target, (queue = new Map()));
    queue.set(n, { n, cmd, outcome: null, cancel: false, cancelAnswered: false, retryInc: null, held: false });
    if (this.open) this.sendItem(target, n);
    return this.slot(target, n);
  }

  cancel(target: string, n: number): void {
    const item = this.queues.get(target)?.get(n);
    if (!item || item.outcome !== null || item.cancel) return;
    item.cancel = true;
    if (this.open) this.send({ t: "cancel", slot: this.slot(target, n) } as Message);
  }

  unresolved(): Array<{ target: string; item: Item }> {
    const out: Array<{ target: string; item: Item }> = [];
    for (const [target, queue] of this.queues) for (const item of [...queue.values()].sort((x, y) => x.n - y.n)) if (item.outcome === null) out.push({ target, item });
    return out;
  }

  slot(target: string, n: number): Slot { return { origin: this.id, originEpoch: this.epoch, target, n } as Slot; }

  private floor(target: string, n: number): number {
    return Math.min(n, ...[...(this.queues.get(target)?.values() ?? [])].filter((item) => item.outcome === null).map((item) => item.n));
  }

  private sendItem(target: string, n: number): void {
    const item = this.queues.get(target)!.get(n)!;
    const inc = this.incFor(target);
    if (!inc) return;
    item.retryInc = null;
    this.send({ t: "cmd", slot: this.slot(target, n), floor: this.floor(target, n), inc, cmd: item.cmd } as Message);
    if (item.cancel) this.send({ t: "cancel", slot: this.slot(target, n) } as Message);
  }

  /** After cmd.retry{inc}: re-send once A's copy of B's table is on that incarnation (§11.2 step 4). */
  private retries(): void {
    if (!this.open) return;
    try {
      for (const { target, item } of this.unresolved()) if (item.retryInc !== null && item.retryInc === this.incFor(target)) this.sendItem(target, item.n);
    } catch { /* a server is restarting */ }
  }

  private send(message: Message): boolean {
    const encoded = encodeFrame(message, "fe", REMOTE);
    if (!encoded.ok) { this.problems.push(encoded.detail); return false; }
    if (!this.link || this.link.state !== "open") return false;
    try { this.link.send("control", encoder.encode(encoded.text)); return true; } catch { return false; }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const again = () => { this.open = false; this.link = null; if (!this.stopped) setTimeout(() => void this.connect(), 100); };
    let connection;
    try { connection = await webSocketConnector.connect(`ws://127.0.0.1:${pf.port}/v3/ws`); } catch { again(); return; }
    const link = SessionLink.initiate(connection, {
      mode: "ik", transport: "tailnet", cluster: clusterId,
      self: { memberId: this.keys.member, dhPub: this.keys.dh.publicKey, dhKey: this.keys.dh.privateKey },
      responder: { memberId: ka.memberId, dhPub: fromBase64Url(ka.dh)! },
    }, {
      onFrame: (bytes) => { const decoded = decodeFrame(bytes, "server", REMOTE); if (decoded.ok) this.take(decoded.message); else this.problems.push(decoded.detail); },
      onEnd: () => { if (this.link === link) again(); },
    });
    this.link = link;
    connection.bind({ frame: (frame) => link.receive(frame), closed: () => link.transportClosed() });
    link.established.then(() => {
      this.send({ t: "hello", deviceId: this.id, feVersion: "3.0.0", protocol: 1, originEpoch: this.epoch, cursors: {}, outbox: [], want: [] } as Message);
    }, () => undefined);
  }

  private take(message: Message): void {
    this.log.push(message);
    if (message.t === "welcome") {
      this.open = true;
      this.sessions++;
      // Every unresolved item in slot order, each queue (§13.1), cancels after their command.
      for (const { target, item } of this.unresolved()) this.sendItem(target, item.n);
      return;
    }
    if (message.t === "held") {
      const item = this.queues.get(message.slot.target)?.get(message.slot.n);
      if (item) item.held = true;
      if (message.at !== ka.memberId) this.problems.push(`held at ${message.at}`);
      this.onHeld?.(message.slot);
      return;
    }
    if (message.t === "cmd.retry") {
      const item = this.queues.get(message.slot.target)?.get(message.slot.n);
      if (item && item.outcome === null) item.retryInc = message.inc;
      return;
    }
    if (message.t === "cancel.noted") {
      const item = this.queues.get(message.slot.target)?.get(message.slot.n);
      if (item) item.cancelAnswered = true;
      return;
    }
    if (message.t === "cmd.result") {
      if (message.slot.origin !== this.id || message.slot.originEpoch !== this.epoch) return;
      if (retiredAtB().has(message.logId)) return; // D50
      const item = this.queues.get(message.slot.target)?.get(message.slot.n);
      if (!item) { this.problems.push(`result for unknown slot ${message.slot.n}`); return; }
      const value = canonicalJson(message.outcome);
      if (item.outcome !== null && item.outcome !== value) this.problems.push(`slot ${message.slot.target}#${message.slot.n}: ${item.outcome} then ${value}`);
      item.cancelAnswered = true;
      item.outcome ??= value;
    }
  }
}

// ---------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Checks one phone's items against B's log: exactly one outcome entry each, slot order per queue, same outcome. */
function checkAgainstB(phone: Phone, what: string): { applied: number; refused: number; cancelled: number } {
  const entries = outcomesAt(b, phone.id);
  const counts = new Map<string, OutcomeEntry[]>();
  for (const entry of entries) {
    const key = slotKey(entry.slot);
    counts.set(key, [...(counts.get(key) ?? []), entry]);
  }
  const tally = { applied: 0, refused: 0, cancelled: 0 };
  for (const [target, queue] of phone.queues) {
    let lastSeq = 0;
    for (const item of [...queue.values()].sort((x, y) => x.n - y.n)) {
      const key = slotKey(phone.slot(target, item.n));
      const found = (counts.get(key) ?? []).filter((entry) => entry.slot.originEpoch === phone.epoch);
      expect(found.length, `${what}: outcome entries for ${target}#${item.n}`).toBe(1);
      expect(item.outcome, `${what}: phone outcome of ${target}#${item.n}`).not.toBeNull();
      const kind = JSON.parse(item.outcome!).kind as string;
      expect(found[0]!.kind, `${what}: ${target}#${item.n}`).toBe(`cmd.${kind}`);
      tally[kind as keyof typeof tally]++;
      expect(found[0]!.seq, `${what}: ${target}#${item.n} decided after ${lastSeq} (slot order)`).toBeGreaterThan(lastSeq);
      lastSeq = found[0]!.seq;
      if (item.cancel) expect(item.cancelAnswered, `${what}: cancel of ${target}#${item.n} answered`).toBe(true);
    }
  }
  return tally;
}

async function resolved(phones: Phone[], what: string, timeout = 120_000): Promise<void> {
  await until(() => phones.every((phone) => phone.unresolved().length === 0 && [...phone.queues.values()].every((q) => [...q.values()].every((item) => !item.cancel || item.cancelAnswered))), { timeout, every: 100, what });
  await until(() => { const left = forwardLeft(a); return left.rows === 0 && left.cancels === 0 ? left : null; }, { timeout: 30_000, every: 100, what: `${what}: A's forward queue empty` });
}

let phone1: Phone, phone2: Phone;
let epochs = 0;
const newEpoch = () => (++epochs).toString(16).padStart(32, "0");

beforeAll(async () => {
  cluster = await startServers({ name: "forward", count: 2, env: { A: TIMERS_ENV, B: TIMERS_ENV } });
  ({ a, b } = cluster);
  await Promise.all([a.stop(), b.stop()]);
  [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
  pa = await cluster.proxy(a, "websocket", 11);
  pb = await cluster.proxy(b, "websocket", 12);
  pf = await cluster.proxy(a.port, "websocket", 13);
  const made = await makeCluster([ka, kb]);
  clusterId = made.clusterId;
  writeStatements(a.dataDir, clusterId, [...made.statements, await profile(clusterId, kb, kb, pb.port)]);
  writeStatements(b.dataDir, clusterId, [...made.statements, await profile(clusterId, ka, ka, pa.port)]);
  await Promise.all([a.start(), b.start()]);

  // A bot on B (bots.create on B's own socket) with one line to react to; A's copy of B's table names it.
  const client: ScriptClient = await b.client("script", "d".repeat(32));
  await client.sub(client.srv);
  const snap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
  client.cmd({ origin: "script", originEpoch: client.originEpoch, target: client.srv, n: 1 } as Slot, { type: "bots.create", name: "Remote helper", job: "forwarding test" }, snap.logId);
  const created = await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === 1, "bots.create");
  botB = (created.outcome as { result: { botId: string } }).result.botId;
  client.cmd({ origin: "script", originEpoch: client.originEpoch, target: `bot:${botB}`, n: 1 } as Slot, { type: "chat.send", botId: botB, text: "/say hello from B" }, snap.logId);
  await client.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.target === `bot:${botB}`, "chat.send on B");
  messageB = await until(() => withDb(b, (db) => (db.prepare("SELECT msgId FROM messages WHERE botId = ? ORDER BY seq LIMIT 1").get(botB) as { msgId: string } | undefined)?.msgId ?? null), { timeout: 30_000, what: "a line on B's bot" });
  client.close();
  await until(() => withDb(a, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(srvB(), `bot:${botB}`)), { timeout: 30_000, what: "A's copy names B's bot" });

  // Two phones paired at A (the real pairing path); B learns them by gossip.
  const local = await a.client("pairing", "f".repeat(32));
  const one = await pairPhone(local, a.port, "Phone one");
  const two = await pairPhone(local, a.port, "Phone two");
  local.close();
  await until(() => withDb(b, (db) => !!db.prepare("SELECT 1 FROM roster WHERE id = ?").get(two.addId)), { timeout: 30_000, what: "B has the phones' Adds" });
  phone1 = new Phone(one.keys, newEpoch());
  phone2 = new Phone(two.keys, newEpoch());
}, 180_000);

afterAll(async () => {
  phone1?.stop(); phone2?.stop();
  await cluster?.cleanup();
}, 60_000);

const react = (present: boolean) => ({ type: "chat.react", botId: botB, messageId: messageB, emoji: "👍", present });

describe("M3 step 9: forwarding between botlingd (Routing stand-in)", () => {
  it("F3 and Q3: A answers `held` (row committed first) while B is cut off and only B's outcome follows; an unknown target is refused definitely", async () => {
    phone1.start();
    await until(() => phone1.open, { what: "phone one attached to A" });
    pa.partition(); pb.partition();
    await until(() => withDb(a, (db) => (db.prepare("SELECT state FROM streams WHERE stream = ?").get(srvB()) as { state: string }).state === "stale"), { timeout: 20_000, what: "A sees B stale" });
    const heldChecks: boolean[] = [];
    phone1.onHeld = (slot) => heldChecks.push(hasRow(a, slot));
    const target = `bot:${botB}`;
    const slots = [phone1.add(target, react(true)), phone1.add(target, react(false)), phone1.add(srvB(), { type: "bots.create", name: "Made through A", job: "a server-level command forwarded" })];
    await until(() => slots.every((slot) => phone1.queues.get(slot.target)!.get(slot.n)!.held), { what: "held for each" });
    expect(heldChecks.length).toBeGreaterThanOrEqual(3);
    expect(heldChecks.every(Boolean), "the row is in A's forwardq when held arrives").toBe(true);
    await sleep(1_000);
    // Nothing but `held` from A while B is unreachable: no outcome of A's own (F3).
    expect(phone1.log.filter((m) => m.t === "cmd.result" || m.t === "cmd.retry")).toEqual([]);
    expect(forwardLeft(a).rows).toBe(3);
    // Q3: a bot nobody has → decided (refused) by the server that decides unclaimed targets, never held.
    const unknown = phone1.add("bot:00000000-0000-4000-8000-00000000dead", { type: "chat.react", botId: "00000000-0000-4000-8000-00000000dead", messageId: "m1", emoji: "👍", present: true });
    await until(() => phone1.queues.get(unknown.target)!.get(1)!.outcome, { what: "unknown target answered" });
    expect(JSON.parse(phone1.queues.get(unknown.target)!.get(1)!.outcome!)).toMatchObject({ kind: "refused" });
    expect(phone1.queues.get(unknown.target)!.get(1)!.held).toBe(false);
    phone1.queues.delete(unknown.target);
    pa.heal(); pb.heal();
    await resolved([phone1], "after the partition");
    const tally = checkAgainstB(phone1, "F3");
    // The two reactions run on B; bots.create needs the desktop window, so B refuses it (its decision, relayed by A).
    expect(tally).toEqual({ applied: 2, refused: 1, cancelled: 0 });
    const refusal = withDb(b, (db) => (db.prepare("SELECT body FROM entries WHERE kind = 'cmd.refused'").all() as Array<{ body: string }>).map((row) => JSON.parse(row.body) as { slot: Slot; reason: string }))
      .find((body) => body.slot.origin === phone1.id && body.slot.target === srvB());
    expect(refusal?.reason).toBe("scope");
    phone1.onHeld = null;
  }, 120_000);

  it(`seeded fault runs: ${RUNS} × ${COMMANDS} commands from two phones with drops, duplicates, cuts, partitions and SIGKILLs of A and B`, async () => {
    phone2.start();
    await until(() => phone1.open && phone2.open, { what: "both phones attached" });
    const totals = { commands: 0, cancels: 0, applied: 0, refused: 0, cancelled: 0, kills: 0, cuts: 0, partitions: 0, drops: 0, duplicates: 0, retries: 0, sessionEnds: 0 };
    const target = `bot:${botB}`;
    for (let run = 1; run <= RUNS; run++) {
      const random = seededRandom(1_000 + run);
      const fault = { drop: 0.01 + random() * 0.02, duplicate: 0.005 + random() * 0.01 };
      for (const proxy of [pa, pb, pf]) proxy.schedule(fault);
      const dropsBefore = [pa, pb, pf].reduce((sum, p) => sum + p.count("drop"), 0);
      const dupsBefore = [pa, pb, pf].reduce((sum, p) => sum + p.count("duplicate"), 0);
      for (let i = 0; i < COMMANDS; i++) {
        const phone = random() < 0.5 ? phone1 : phone2;
        const toServer = random() < 0.05;
        const slot = phone.add(toServer ? srvB() : target, toServer ? { type: "bots.create", name: `Forwarded ${run}.${i}`, job: "refused by B (scope)" } : react(random() < 0.5));
        totals.commands++;
        if (random() < 0.08) { phone.cancel(slot.target, slot.n); totals.cancels++; }
        const r = random();
        if (r < 0.015) { await a.kill(); await a.start(); totals.kills++; }
        else if (r < 0.03) { await b.kill(); await b.start(); totals.kills++; }
        else if (r < 0.05) { pa.cut(); pb.cut(); totals.cuts++; }
        else if (r < 0.06) { pf.cut(); totals.cuts++; }
        else if (r < 0.07) { pa.partition(); pb.partition(); await sleep(200 + random() * 1_500); pa.heal(); pb.heal(); totals.partitions++; }
        else if (r < 0.08) { phone.cut(); totals.cuts++; }
        await sleep(random() * 30);
      }
      for (const proxy of [pa, pb, pf]) proxy.schedule(null);
      totals.drops += [pa, pb, pf].reduce((sum, p) => sum + p.count("drop"), 0) - dropsBefore;
      totals.duplicates += [pa, pb, pf].reduce((sum, p) => sum + p.count("duplicate"), 0) - dupsBefore;
      await resolved([phone1, phone2], `run ${run}`);
      for (const phone of [phone1, phone2]) {
        const tally = checkAgainstB(phone, `run ${run} (seed ${1_000 + run})`);
        if (run === RUNS) { totals.applied += tally.applied; totals.refused += tally.refused; totals.cancelled += tally.cancelled; }
        expect(phone.problems, `run ${run}`).toEqual([]);
      }
    }
    totals.retries = [phone1, phone2].reduce((sum, phone) => sum + phone.log.filter((m) => m.t === "cmd.retry").length, 0);
    totals.sessionEnds = (a.log.match(/session ended/g) ?? []).length;
    console.log(`forward faults: ${JSON.stringify(totals)}`);
    // The faults happened; every command of every run (and the F3 test's) has its one outcome.
    expect(totals.drops + totals.duplicates).toBeGreaterThan(0);
    expect(totals.applied + totals.refused + totals.cancelled).toBeGreaterThanOrEqual(totals.commands);
    expect(totals.applied).toBeGreaterThan(0);
    // No `cmd.retry` without a restore (B's incarnation never changed in these runs).
    expect(totals.retries).toBe(0);
  }, 1_800_000);

  it("B restored while A holds its commands: old-inc copies get cmd.retry and run once under the new inc; nothing seen runs again (D49)", async () => {
    const target = `bot:${botB}`;
    await until(() => phone1.open, { what: "phone one attached" });
    const backup = b.backup();
    const oldInc = logIdOf(b, srvB());
    // Seen before the restore (their outcome is taken), then lost by the restore.
    const seenSlots = [phone1.add(target, react(true)), phone1.add(target, react(false))];
    await until(() => seenSlots.every((slot) => phone1.queues.get(target)!.get(slot.n)!.outcome), { what: "seen outcomes" });
    // Held at A for B, under the old inc, while B is cut off and restored.
    pa.partition(); pb.partition();
    await until(() => withDb(a, (db) => (db.prepare("SELECT state FROM streams WHERE stream = ?").get(srvB()) as { state: string }).state === "stale"), { timeout: 20_000, what: "A sees B stale" });
    const pending = [phone1.add(target, react(true)), phone1.add(target, react(false)), phone1.add(target, react(true))];
    await until(() => pending.every((slot) => phone1.queues.get(target)!.get(slot.n)!.held), { what: "held under the old inc" });
    await b.restore(backup);
    const newInc = logIdOf(b, srvB());
    expect(newInc).not.toBe(oldInc);
    pa.heal(); pb.heal();
    await resolved([phone1], "after the restore");
    expect(phone1.log.filter((m) => m.t === "cmd.retry").length).toBeGreaterThanOrEqual(1);
    // Each pending slot decided exactly once in B's new history; the seen ones were skipped (never re-applied).
    const entries = outcomesAt(b, phone1.id).filter((entry) => entry.slot.originEpoch === phone1.epoch && entry.slot.target === target);
    for (const slot of pending) expect(entries.filter((entry) => entry.slot.n === slot.n)).toHaveLength(1);
    for (const slot of seenSlots) expect(entries.filter((entry) => entry.slot.n === slot.n), `seen slot ${slot.n} not re-applied`).toHaveLength(0);
    const skipped = withDb(b, (db) => (db.prepare("SELECT body FROM entries WHERE kind = 'cmd.skipped'").all() as Array<{ body: string }>).map((row) => JSON.parse(row.body) as { origin: string; from: number; to: number }));
    expect(skipped.some((skip) => skip.origin === phone1.id && seenSlots.every((slot) => slot.n >= skip.from && slot.n <= skip.to))).toBe(true);
  }, 300_000);

  it("a device revoked on A while A holds its commands: B refuses them (origin), none applied; A never refuses", async () => {
    const target = `bot:${botB}`;
    await until(() => phone2.open, { what: "phone two attached" });
    pa.partition(); pb.partition();
    await until(() => withDb(a, (db) => (db.prepare("SELECT state FROM streams WHERE stream = ?").get(srvB()) as { state: string }).state === "stale"), { timeout: 20_000, what: "A sees B stale" });
    const queued = [phone2.add(target, react(true)), phone2.add(target, react(false))];
    await until(() => queued.every((slot) => phone2.queues.get(target)!.get(slot.n)!.held), { what: "held" });
    const local = await a.client("revoker", "c".repeat(32));
    await admin(local, { op: "device.revoke", deviceId: phone2.id, reason: "test" });
    local.close();
    phone2.stop();
    const isQueued = (slot: Slot) => slot.originEpoch === phone2.epoch && slot.target === target && queued.some((q) => q.n === slot.n);
    expect(outcomesAt(b, phone2.id).filter((entry) => isQueued(entry.slot))).toEqual([]);
    pa.heal(); pb.heal();
    await until(() => { const left = forwardLeft(a); return left.rows === 0 ? left : null; }, { timeout: 60_000, every: 100, what: "A's rows for the revoked device answered" });
    const decided = await until(() => { const found = outcomesAt(b, phone2.id).filter((entry) => isQueued(entry.slot)); return found.length >= queued.length ? found : null; }, { timeout: 30_000, what: "B decided the revoked device's slots" });
    expect(decided.map((entry) => entry.slot.n).sort()).toEqual(queued.map((slot) => slot.n).sort());
    expect(decided.every((entry) => entry.kind === "cmd.refused")).toBe(true);
    const reasons = withDb(b, (db) => (db.prepare("SELECT body FROM entries WHERE kind = 'cmd.refused'").all() as Array<{ body: string }>).map((row) => JSON.parse(row.body) as { slot: Slot; reason: string }))
      .filter((body) => body.slot.origin === phone2.id && queued.some((slot) => slot.n === body.slot.n && slot.originEpoch === body.slot.originEpoch));
    expect(reasons.every((body) => body.reason === "origin")).toBe(true);
    // A wrote no outcome entry of its own for B's bot.
    expect(outcomesAt(a, phone2.id).filter((entry) => entry.slot.target === target)).toEqual([]);
  }, 180_000);
});
