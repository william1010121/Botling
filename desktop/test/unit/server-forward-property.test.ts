// Botling 3 M3 step 9 (m3-brief §5.9, stand-in for the skipped `Routing` forwarding gate): the forward queue alone, in
// one process, under random interleavings. Server A runs the real Forwarder (src/server/forward) on its own server.db;
// owner B runs the real OwnerInbox in front of the real SlotEngine (src/server/slots) on another server.db with the
// slot harness's log. Front ends on A send commands and cancels for B's bots. Every link is a FIFO session that can
// lose its whole in-flight suffix and end (D58: a lost frame voids the session); a new session starts over.
//
// Random steps: an FE writes a new item and sends it; an FE re-sends everything unresolved in slot order (with its
// cancels); an FE cancels an item; one frame is delivered on one of the four links; an FE session or the A–B session is
// cut; A restarts (its forwarder's memory gone, its queue kept); B restarts (held-ahead copies gone); B is restored
// from an earlier snapshot (new incarnation: copies with the old `inc` get `cmd.retry`, D49; results of the old
// logIds are retired, D50). At the end every link heals and everything drains.
//
// Checked: every item gets exactly one outcome at its FE, and only one outcome value (0 lost, never two answers);
// within one history of B each slot is decided and applied at most once, applies follow slot order per queue (FIFO);
// a slot whose outcome an FE took is never applied again in a later history (D49, SeenNeverReapplied); A never
// produced an outcome (every cmd.result the FEs got came from B's engine; A only said `held`, F3); `held` only after
// the row's commit; every cancel an FE sent to a live owner got `cancel.noted` or the slot's `cmd.result`; at the end
// A's `forwardq` and `fwdcancels` are empty.
import { describe, expect, it } from "vitest";
import { canonicalJson, slotKey, type CmdBody, type Message, type Slot, type WireMessage } from "../../src/protocol";
import { Directory, Forwarder, OwnerInbox, queueStats, type ForwardSession, type InboxSession } from "../../src/server/forward";
import { SlotEngine, SlotRefusal, type ApplyFn } from "../../src/server/slots";
import type { Db } from "../../src/server/store";
import { entries, FakeLog, memoryStore, rng } from "./server-slots-harness";

const B = "server-b";
const A = "server-a";
const ORIGINS = ["phone-1", "phone-2"];
const BOTS = ["bot:x1", "bot:x2"] as const;

/** A FIFO session in one direction pair: frames wait until delivered; a cut drops what is in flight. */
class Pipe<T> {
  readonly queue: T[] = [];
  id = 1;
  open = true;
  push(item: T): boolean { if (!this.open) return false; this.queue.push(item); return true; }
  cut(): void { this.queue.length = 0; this.open = false; }
  reopen(): void { this.open = true; this.id++; }
}

interface Item { n: number; seen: boolean; outcome: string | null; cancelSent: boolean; cancelAnswered: boolean; heldBeforeCommit: boolean }

/** One front end queue: (origin, epoch, target). */
class FeQueue {
  readonly items = new Map<number, Item>();
  next = 1;
  inc: string;
  constructor(readonly origin: string, readonly epoch: string, readonly target: (typeof BOTS)[number], inc: string) { this.inc = inc; }
  slot(n: number): Slot { return { origin: this.origin, originEpoch: this.epoch, target: this.target, n } as Slot; }
  unresolved(): Item[] { return [...this.items.values()].filter((item) => item.outcome === null).sort((x, y) => x.n - y.n); }
  floor(n: number): number { return Math.min(n, ...this.unresolved().map((item) => item.n)); }
  copy(n: number): CmdBody {
    return { slot: this.slot(n), floor: this.floor(n), inc: this.inc, cmd: { type: "chat.react", botId: this.target.slice(4), messageId: `m${n}`, emoji: "👍", present: true } } as CmdBody;
  }
}

async function run(seed: number, steps: number): Promise<{ items: number; restores: number; cuts: number; retries: number; cancels: number; applies: number; wipes: number }> {
  const random = rng(seed);
  const stats = { items: 0, restores: 0, cuts: 0, retries: 0, cancels: 0, applies: 0, wipes: 0 };
  const fail = (message: string): never => { throw new Error(`seed ${seed}: ${message}`); };
  const chance = (p: number) => random() < p;
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;

  // Owner B.
  const ownerStore = memoryStore();
  const log = new FakeLog();
  let history = 0;
  const seen = new Set<string>();
  const appliedIn = new Map<string, number>(); // `${history}|slot` → applies
  const lastApplied = new Map<string, number>(); // `${history}|queue` → last n applied
  const apply: ApplyFn = ({ tx, slot, log: l }) => {
    if (slot.n % 9 === 0) throw new SlotRefusal("invalid", "refused by the apply step");
    l.appendEntry(tx, slot.target, "test.intent", { n: slot.n }, slot);
    const key = slotKey(slot);
    // (No commit fails in this run, so an apply that ran is an apply that committed.)
    stats.applies++;
    if (seen.has(key)) fail(`slot ${key} applied again after an FE took its outcome (D49)`);
    const once = `${history}|${key}`;
    appliedIn.set(once, (appliedIn.get(once) ?? 0) + 1);
    if (appliedIn.get(once)! > 1) fail(`slot ${key} applied twice in history ${history}`);
    const queue = `${history}|${key.slice(0, key.lastIndexOf("\u0000"))}`;
    if ((lastApplied.get(queue) ?? 0) >= slot.n) fail(`slot ${slot.n} applied after ${lastApplied.get(queue)} (FIFO)`);
    lastApplied.set(queue, slot.n);
    return { result: { n: slot.n } };
  };
  const newEngine = () => new SlotEngine({ submit: (c) => ownerStore.writer.submit(c), log, apply, authorize: () => null });
  let engine = newEngine();
  const runtime = () => ({ receive: (body: CmdBody, options: object) => engine.receive(body, options), slots: engine, legacy: { receive: (body: CmdBody, options: object) => engine.receive(body, options) } });
  let inbox = new OwnerInbox({ self: B, runtime: runtime() as never, log: () => undefined });

  // Forwarder A.
  const fwdStore = memoryStore();
  const committed = new Set<string>();
  const directory = new Directory({ self: A, reader: () => fwdStore.db, peers: () => [B], hasBot: () => false });
  // A's rows for B's bots: the directory reads A's copy of B's srv: table.
  await fwdStore.writer.submit((tx) => { for (const bot of BOTS) tx.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, 1, '{}', 0)").run(`srv:${B}`, bot); });

  // Links: FE ↔ A (one per origin), A ↔ B.
  const feUp = new Map(ORIGINS.map((o) => [o, new Pipe<Message>()]));
  const feDown = new Map(ORIGINS.map((o) => [o, new Pipe<Message>()]));
  const peerUp = new Pipe<WireMessage>();   // A → B
  const peerDown = new Pipe<WireMessage>(); // B → A
  let peerOpen = true;
  // Session objects per session id: one that ended stays closed for anything still running on it.
  const sessionsFor = (id: number): [ForwardSession, InboxSession] => {
    const open = () => peerOpen && peerUp.id === id;
    return [
      { get peer() { return B; }, get state() { return open() ? "open" : "closed"; }, sendWire: (m) => open() && peerUp.push(structuredClone(m)) },
      { get peer() { return A; }, get state() { return open() ? "open" : "closed"; }, sendWire: (m) => open() && peerDown.push(structuredClone(m)), bye: () => { if (open()) cutPeer(); } },
    ];
  };
  let [liveA, liveB] = sessionsFor(1);

  let forwarder!: Forwarder;
  const unrelay: Array<() => void> = [];
  const newForwarder = () => {
    for (const off of unrelay.splice(0)) off();
    forwarder = new Forwarder({ self: A, submit: (c) => fwdStore.writer.submit(c), reader: () => fwdStore.db, directory, log: () => undefined, session: () => (peerOpen ? liveA : null) });
    for (const origin of ORIGINS) unrelay.push(forwarder.attach(origin, (m) => feDown.get(origin)!.push(structuredClone(m))));
    if (peerOpen) forwarder.opened(liveA);
  };
  newForwarder();

  function cutPeer(): void {
    if (!peerOpen) return;
    peerOpen = false;
    peerUp.cut(); peerDown.cut();
    forwarder.closed(liveA);
    inbox.closed(liveB);
    stats.cuts++;
  }
  function openPeer(): void {
    if (peerOpen) return;
    peerUp.reopen(); peerDown.reopen();
    peerOpen = true;
    [liveA, liveB] = sessionsFor(peerUp.id);
    forwarder.opened(liveA);
  }

  // Front ends.
  const queues: FeQueue[] = [];
  for (const origin of ORIGINS) for (const target of BOTS) queues.push(new FeQueue(origin, `${origin.slice(-1)}`.repeat(32), target, log.inc));
  const wiped: FeQueue[] = [];
  let epochs = 0;
  const find = (list: FeQueue[], slot: Slot) => list.find((q) => q.origin === slot.origin && q.epoch === slot.originEpoch && q.target === slot.target);
  const queueOf = (slot: Slot) => find(queues, slot) ?? find(wiped, slot)!;
  const retired = new Set<string>();

  const sendCmd = (q: FeQueue, n: number) => feUp.get(q.origin)!.push({ t: "cmd", ...q.copy(n) } as Message);
  const resendAll = (origin: string) => {
    for (const q of queues.filter((x) => x.origin === origin)) {
      for (const item of q.unresolved()) {
        sendCmd(q, item.n);
        if (item.cancelSent) feUp.get(origin)!.push({ t: "cancel", slot: q.slot(item.n) } as Message);
      }
    }
  };

  // A's handling of one FE frame, as the session core does it for a target a peer owns.
  const atA = async (message: Message) => {
    if (message.t === "cmd") {
      const { t: _t, ...body } = message;
      const owner = forwarder.ownerOf(body.slot.target);
      if (owner !== B) fail(`directory says ${owner} for ${body.slot.target}`);
      await forwarder.commit({ ...(body as CmdBody), scope: "reply" }, B);
      // `held` only after the commit (the session core sends it when commit resolves).
      committed.add(slotKey(body.slot));
      feDown.get(body.slot.origin)!.push({ t: "held", slot: body.slot, at: A } as Message);
    } else if (message.t === "cancel") {
      await forwarder.cancel(message.slot, B);
    }
  };

  const atFe = (origin: string, message: Message) => {
    if (message.t === "held") {
      if (!committed.has(slotKey(message.slot))) fail(`held for ${slotKey(message.slot)} before any commit`);
      return;
    }
    if (message.t === "cmd.retry") { stats.retries++; queueOf(message.slot).inc = message.inc; return; }
    if (message.t === "cancel.noted") { const item = queueOf(message.slot).items.get(message.slot.n); if (item) item.cancelAnswered = true; return; }
    if (message.t === "cmd.result") {
      if (message.slot.origin !== origin) fail("a result relayed to another origin");
      if (retired.has(message.logId)) return; // D50
      const q = queueOf(message.slot);
      const item = q.items.get(message.slot.n);
      if (!item) fail(`a result for slot ${message.slot.n} nobody sent`);
      const value = canonicalJson(message.outcome);
      if (message.outcome.kind === "refused" && message.outcome.reason === "slot conflict") fail(`slot conflict for ${slotKey(message.slot)}`);
      if (item!.outcome !== null && item!.outcome !== value && message.outcome.kind !== "skipped") fail(`slot ${slotKey(message.slot)} answered ${item!.outcome} then ${value}`);
      item!.cancelAnswered = true;
      if (item!.outcome === null) { item!.outcome = value; item!.seen = true; seen.add(slotKey(message.slot)); }
    }
  };

  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await Promise.all([ownerStore.writer.idle(), fwdStore.writer.idle()]);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  const snapshots: Array<{ tables: Record<string, Array<Record<string, unknown>>> }> = [];
  const TABLES = ["entries", "receipts", "slots", "cancels"];
  const take = (tx: Db) => Object.fromEntries(TABLES.map((t) => [t, tx.prepare(`SELECT * FROM ${t}`).all()]));

  const deliverOne = async (): Promise<boolean> => {
    const links: Array<() => Promise<void>> = [];
    for (const origin of ORIGINS) {
      const up = feUp.get(origin)!;
      if (up.queue.length) links.push(async () => { await atA(up.queue.shift()!); });
      const down = feDown.get(origin)!;
      if (down.queue.length) links.push(async () => { atFe(origin, down.queue.shift()!); });
    }
    if (peerUp.queue.length) links.push(async () => { const m = peerUp.queue.shift()!; if (!inbox.onMessage(liveB, m)) fail(`B did not take ${m.t}`); });
    if (peerDown.queue.length) links.push(async () => { const m = peerDown.queue.shift()!; if (!(await forwarder.onMessage(liveA, m))) fail(`A did not take ${m.t}`); });
    if (!links.length) return false;
    await pick(links)();
    await settle();
    return true;
  };

  for (let step = 0; step < steps; step++) {
    const r = random();
    if (r < 0.14) {
      const q = pick(queues);
      const n = q.next++;
      q.items.set(n, { n, seen: false, outcome: null, cancelSent: false, cancelAnswered: false, heldBeforeCommit: false });
      stats.items++;
      sendCmd(q, n);
    } else if (r < 0.18) {
      const q = pick(queues);
      const item = q.unresolved()[0];
      if (item && !item.cancelSent) { item.cancelSent = true; stats.cancels++; feUp.get(q.origin)!.push({ t: "cancel", slot: q.slot(item.n) } as Message); }
    } else if (r < 0.21) {
      const origin = pick(ORIGINS);
      // An FE session cut: what was in flight is lost both ways; the next session re-sends everything unresolved.
      feUp.get(origin)!.cut(); feDown.get(origin)!.cut();
      feUp.get(origin)!.reopen(); feDown.get(origin)!.reopen();
      stats.cuts++;
      resendAll(origin);
    } else if (r < 0.235) {
      cutPeer();
    } else if (r < 0.26) {
      openPeer();
    } else if (r < 0.27) {
      // A restarts: its forwarder's memory goes; the queue in server.db stays; FE sessions end and re-send.
      cutPeer();
      newForwarder();
      for (const origin of ORIGINS) { feUp.get(origin)!.cut(); feDown.get(origin)!.cut(); feUp.get(origin)!.reopen(); feDown.get(origin)!.reopen(); resendAll(origin); }
    } else if (r < 0.28) {
      // B restarts: held-ahead copies (memory) go.
      cutPeer();
      engine = newEngine();
      inbox = new OwnerInbox({ self: B, runtime: runtime() as never, log: () => undefined });
    } else if (r < 0.29) {
      snapshots.push({ tables: await ownerStore.writer.submit(take) });
    } else if (r < 0.293) {
      // An FE's storage is wiped: its unsent intent is gone (D32), a new origin epoch begins. Rows A holds for the old
      // epoch must still drain (answered, or dropped by a cmd.retry), never stay for ever (D58).
      const origin = pick(ORIGINS);
      feUp.get(origin)!.cut(); feDown.get(origin)!.cut(); feUp.get(origin)!.reopen(); feDown.get(origin)!.reopen();
      epochs++;
      for (const q of queues.filter((x) => x.origin === origin)) {
        wiped.push(q);
        queues[queues.indexOf(q)] = new FeQueue(origin, `${origin.slice(-1)}${epochs.toString(16)}`.padEnd(32, "0"), q.target, q.inc);
      }
      stats.wipes++;
    } else if (r < 0.300 && snapshots.length) {
      // B restored from an earlier backup: a new incarnation; the old logIds retired.
      cutPeer();
      const snap = pick(snapshots);
      for (const id of log.logIds.values()) retired.add(id);
      retired.add(log.inc);
      await ownerStore.writer.submit((tx) => {
        for (const table of TABLES) {
          tx.exec(`DELETE FROM ${table}`);
          for (const row of snap.tables[table]!) {
            const keys = Object.keys(row);
            tx.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(keys.map((k) => row[k]) as never[]));
          }
        }
      });
      log.restore();
      history++;
      // Some FEs see B's reset at once through A's copy of B's srv: table (§13.1) and send later items with the new
      // inc while an earlier one still waits under the old inc: the D58 stranded case once that FE is wiped.
      for (const q of queues) if (chance(0.5)) q.inc = log.inc;
      engine = newEngine();
      inbox = new OwnerInbox({ self: B, runtime: runtime() as never, log: () => undefined });
      stats.restores++;
    } else {
      await deliverOne();
    }
    await settle();
  }

  // Heal and drain: every session up; FEs re-send until every item has its outcome.
  for (let round = 0; round < 200; round++) {
    openPeer();
    while (await deliverOne()) { /* drain */ }
    const open = queues.some((q) => q.unresolved().length > 0) || queueStats(fwdStore.db).rows + queueStats(fwdStore.db).cancels > 0;
    if (!open) break;
    // The FE learns the owner's current incarnation from the replicated srv: table before it re-sends (§13.1).
    for (const q of queues) q.inc = log.inc;
    for (const origin of ORIGINS) resendAll(origin);
    // Cancels sent before still pending at A are forwarded again on a new session (a reconnect).
    if (round % 3 === 2) cutPeer();
  }

  // Every item answered exactly once, one value.
  for (const q of queues) for (const item of q.items.values()) if (item.outcome === null) fail(`slot ${slotKey(q.slot(item.n))} never answered`);
  // Cancels answered (noted, or the slot's result).
  for (const q of queues) for (const item of q.items.values()) if (item.cancelSent && !item.cancelAnswered) fail(`cancel of ${slotKey(q.slot(item.n))} never answered`);
  // A's queue is empty.
  const left = queueStats(fwdStore.db);
  if (left.rows || left.cancels) fail(`A still holds ${left.rows} rows and ${left.cancels} cancels`);

  // B's current history: at most one outcome per slot; a skipped slot is not applied in it.
  const decided = new Map<string, number>();
  for (const entry of entries(ownerStore.db)) {
    if (!entry.slot || !entry.kind.startsWith("cmd.") || entry.kind === "cmd.skipped") continue;
    decided.set(slotKey(entry.slot), (decided.get(slotKey(entry.slot)) ?? 0) + 1);
  }
  for (const [key, count] of decided) if (count > 1) fail(`slot ${key} decided ${count} times in B's current history`);
  return stats;
}

describe("M3 step 9: the forward queue under random interleavings (Routing stand-in)", () => {
  it("exactly once, FIFO per queue, held after commit, cancels answered, queue emptied — 24 seeds × 400 steps", async () => {
    const totals = { items: 0, restores: 0, cuts: 0, retries: 0, cancels: 0, applies: 0, wipes: 0 };
    for (let seed = 1; seed <= 24; seed++) {
      const stats = await run(seed, 400);
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += stats[key];
    }
    // The schedule did what it says (summed over the seeds).
    expect(totals.items).toBeGreaterThan(500);
    expect(totals.cuts).toBeGreaterThan(100);
    expect(totals.restores).toBeGreaterThan(3);
    expect(totals.retries).toBeGreaterThan(3);
    expect(totals.cancels).toBeGreaterThan(50);
    expect(totals.applies).toBeGreaterThan(300);
    expect(totals.wipes).toBeGreaterThan(20);
    console.log(`forward property: ${JSON.stringify(totals)}`);
  }, 300_000);
});
