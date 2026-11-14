// Randomized resend / reorder / duplicate / drop sequences against src/server/slots (protocol v1 §11.3, D12, D49,
// D50). No TLA model backs these rules in M1, so this test is the exactly-once evidence. Each run is seeded (replay a
// failure with its seed) and drives:
//   - three queues (two epochs of one origin on one bot, another origin on another bot), 6–25 commands each, all in
//     the origins' outboxes from the start (every one is "acknowledged" and must end with exactly one outcome);
//   - a network that reorders, duplicates and drops copies and replies, and delivers bursts into one transaction;
//   - cancels, apply steps that refuse, transient apply errors and failed COMMITs, engine restarts (held buffer lost);
//   - in the second group, restores: server.db rewinds to an earlier snapshot and gets a new incarnation (new `inc`
//     and logIds); origins learn the retired logIds (the `reset`) and their new `inc` only from `cmd.retry`.
// Checked: a slot is applied at most once per history, never again once its origin saw an outcome (NoRerunSeen), with
// no restore at most once overall; every command ends with exactly one outcome at its origin (all copies of its
// result agree); no slot conflict and, without restores, no skip; and the store holds at most one outcome per slot.
import { describe, expect, it } from "vitest";
import { canonicalJson, slotKey, type CmdBody, type Outcome, type Slot } from "../../src/protocol";
import type { Db } from "../../src/server/store";
import { findReceipt, SlotEngine, SlotRefusal, type ApplyFn, type SlotReply } from "../../src/server/slots";
import { EPOCH_A, EPOCH_B, entries, FakeLog, memoryStore, rng } from "./server-slots-harness";

interface Queue { origin: string; originEpoch: string; target: string }
const QUEUES: Queue[] = [
  { origin: "desktop", originEpoch: EPOCH_A, target: "bot:a" },
  { origin: "desktop", originEpoch: EPOCH_B, target: "bot:a" },
  { origin: "phone", originEpoch: EPOCH_A, target: "bot:c" },
];

class Origin {
  readonly items = new Map<number, CmdBody["cmd"]>();
  /** Every result this origin took for a slot (not from a retired logId): exactly one distinct value each. */
  readonly results = new Map<number, Set<string>>();
  readonly accepted = new Map<number, Outcome>();
  inc: string;
  constructor(readonly q: Queue, count: number, inc: string) {
    this.inc = inc;
    const botId = q.target.slice(4);
    for (let n = 1; n <= count; n++) this.items.set(n, { type: "chat.react", botId, messageId: `m${n}`, emoji: "👍", present: n % 2 === 0 });
  }
  unresolved(): number[] { return [...this.items.keys()].filter((n) => !this.accepted.has(n)); }
  floor(n: number): number { return Math.min(n, ...this.unresolved()); }
  slot(n: number): Slot { return { ...this.q, n }; }
  copy(n: number): CmdBody { return { slot: this.slot(n), floor: this.floor(n), inc: this.inc, cmd: this.items.get(n)! } as CmdBody; }
}

type ToServer = { kind: "cmd"; body: CmdBody } | { kind: "cancel"; slot: Slot };

interface RunOptions { seed: number; restores: boolean; steps: number }

async function run({ seed, restores, steps }: RunOptions): Promise<{ applies: number; restored: number; resolved: number }> {
  const random = rng(seed);
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)];
  const fail = (message: string): never => { throw new Error(`seed ${seed}: ${message}`); };

  let failCommit = false;
  let currentBatch = 0;
  let history = 0;
  const pending: Array<{ key: string; batch: number; seen: boolean; history: number }> = [];
  const confirmed: Array<{ key: string; history: number; seen: boolean }> = [];
  const { db, writer } = memoryStore({
    beforeCommit: () => { if (failCommit) { failCommit = false; throw new Error("injected I/O error"); } },
    onBatch: (info) => {
      const mine = pending.filter((p) => p.batch === info.batch);
      for (const p of mine) pending.splice(pending.indexOf(p), 1);
      if (info.committed) confirmed.push(...mine.map(({ key, history: h, seen }) => ({ key, history: h, seen })));
    },
  });
  const log = new FakeLog();
  const origins = QUEUES.map((q) => new Origin(q, 6 + Math.floor(random() * 20), log.inc));
  const originOf = (s: Slot) => origins.find((o) => o.q.origin === s.origin && o.q.originEpoch === s.originEpoch && o.q.target === s.target)!;
  const retired = new Set<string>();

  let transientApplyError = false;
  const apply: ApplyFn = ({ tx, slot, log: l }) => {
    if (transientApplyError) { transientApplyError = false; throw new Error("injected transient error"); }
    if (slot.n % 7 === 0) throw new SlotRefusal("invalid", "refused by the apply step");
    l.appendEntry(tx, slot.target, "test.intent", { n: slot.n }, slot);
    pending.push({ key: slotKey(slot), batch: currentBatch, seen: originOf(slot).accepted.has(slot.n), history });
    return { result: { n: slot.n } };
  };
  const newEngine = () => new SlotEngine({
    submit: (command) => writer.submit((tx, ctx) => { currentBatch = ctx.batch; return command(tx, ctx); }),
    log, apply,
  });
  let engine = newEngine();

  const toServer: ToServer[] = [];
  const toOrigin: SlotReply[] = [];
  const reply = (message: SlotReply) => { toOrigin.push(message); };

  const deliverToServer = async (message: ToServer) => {
    try {
      if (message.kind === "cmd") await engine.receive(message.body, { scope: "local", reply });
      else {
        const status = await engine.cancel(message.slot);
        if (status.status === "too late") reply(status.message);
      }
    } catch (error) {
      if (!/injected/.test(String((error as Error).message))) throw error;
    }
  };
  const deliverToOrigin = (message: SlotReply) => {
    const origin = originOf(message.slot);
    if (message.t === "cmd.retry") {
      origin.inc = message.inc; // it has the owner's reset; re-sends happen on later "send" steps
      return;
    }
    if (retired.has(message.logId)) return; // D50: never take an outcome of a retired incarnation
    const { n } = message.slot;
    if (message.outcome.kind === "refused" && message.outcome.reason === "slot conflict") fail(`slot conflict for ${n}`);
    if (!restores && message.outcome.kind === "skipped") fail(`skip without a restore for ${n}`);
    const seen = origin.results.get(n) ?? new Set();
    seen.add(canonicalJson(message.outcome));
    origin.results.set(n, seen);
    if (!origin.accepted.has(n)) origin.accepted.set(n, message.outcome);
  };
  const takeRandom = <T>(list: T[], keepChance: number): T | undefined => {
    if (!list.length) return undefined;
    const index = Math.floor(random() * list.length);
    const item = list[index];
    if (random() >= keepChance) list.splice(index, 1);
    return item;
  };

  const TABLES = ["entries", "receipts", "slots", "cancels"];
  const snapshots: Array<Record<string, Array<Record<string, unknown>>>> = [];
  const snapshot = () => writer.submit((tx) => Object.fromEntries(TABLES.map((t) => [t, tx.prepare(`SELECT * FROM ${t}`).all()])));
  const checkStore = (tx: Db) => {
    // At most one outcome per slot in this history: own outcome entries and skip ranges never overlap.
    const decided = new Map<string, number>();
    for (const entry of entries(tx)) {
      if (entry.kind === "cmd.skipped") {
        const { origin, originEpoch, target, from, to } = entry.body as { origin: string; originEpoch: string; target: string; from: number; to: number };
        for (let n = from; n <= to; n++) decided.set(slotKey({ origin, originEpoch, target, n }), (decided.get(slotKey({ origin, originEpoch, target, n })) ?? 0) + 1);
      } else if (entry.kind.startsWith("cmd.") && entry.slot) {
        decided.set(slotKey(entry.slot), (decided.get(slotKey(entry.slot)) ?? 0) + 1);
      }
    }
    for (const [key, count] of decided) if (count > 1) fail(`slot ${key.replace(/\u0000/g, "/")} has ${count} outcomes in one history`);
    const intents = new Map<string, number>();
    for (const entry of entries(tx)) if (entry.kind === "test.intent") intents.set(slotKey(entry.slot!), (intents.get(slotKey(entry.slot!)) ?? 0) + 1);
    for (const [key, count] of intents) if (count > 1) fail(`slot ${key} applied ${count} times in one history`);
  };
  let restored = 0;

  for (let step = 0; step < steps; step++) {
    const roll = random();
    if (roll < 0.25) {
      const origin = pick(origins);
      const open = origin.unresolved();
      if (open.length) {
        // Mostly re-send the oldest unresolved items, sometimes any of them (reorder at the source).
        const n = random() < 0.6 ? open[Math.floor(random() * Math.min(3, open.length))] : pick(open);
        toServer.push({ kind: "cmd", body: origin.copy(n) });
      }
    } else if (roll < 0.5) {
      if (random() < 0.05) failCommit = true;
      if (random() < 0.05) transientApplyError = true;
      const message = takeRandom(toServer, 0.25);
      if (message) await deliverToServer(message);
      failCommit = transientApplyError = false; // a fault armed for a delivery never hits a snapshot or a check
    } else if (roll < 0.58) {
      // A burst: several copies submitted in the same event-loop turn share one transaction.
      const burst: ToServer[] = [];
      for (let i = 0; i < 2 + Math.floor(random() * 4); i++) { const m = takeRandom(toServer, 0.2); if (m) burst.push(m); }
      if (random() < 0.05) failCommit = true;
      await Promise.all(burst.map(deliverToServer));
      failCommit = false;
    } else if (roll < 0.8) {
      const message = takeRandom(toOrigin, 0.2);
      if (message) deliverToOrigin(message);
    } else if (roll < 0.86) {
      if (random() < 0.5) takeRandom(toServer, 0); else takeRandom(toOrigin, 0); // drop one
    } else if (roll < 0.9) {
      const origin = pick(origins);
      const open = origin.unresolved();
      if (open.length) toServer.push({ kind: "cancel", slot: origin.slot(pick(open)) });
    } else if (roll < 0.94) {
      await writer.idle();
      engine = newEngine(); // a restart: the held buffer is gone, the store is everything
    } else if (roll < 0.97) {
      snapshots.push(await snapshot());
    } else if (restores && snapshots.length && restored < 3) {
      await writer.idle();
      await writer.submit(checkStore);
      const back = pick(snapshots);
      const oldIds = [log.inc, ...log.logIds.values()];
      await writer.submit((tx) => {
        for (const table of TABLES) {
          tx.exec(`DELETE FROM ${table}`);
          for (const row of back[table]) {
            const columns = Object.keys(row);
            tx.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...(columns.map((c) => row[c]) as never[]));
          }
        }
      });
      log.restore();
      for (const id of oldIds) retired.add(id); // the origins get the reset (retired logIds); their inc stays old
      history++;
      restored++;
      engine = newEngine();
    }
  }

  // Drain without faults: origins re-send their outboxes until every command has an outcome (nothing waits forever).
  for (let round = 0; origins.some((o) => o.unresolved().length); round++) {
    if (round > 60) fail(`stuck: ${origins.map((o) => o.unresolved().join(",")).join(" | ")}`);
    for (const origin of origins) for (const n of origin.unresolved()) toServer.push({ kind: "cmd", body: origin.copy(n) });
    while (toServer.length || toOrigin.length) {
      while (toServer.length) await deliverToServer(toServer.shift()!);
      while (toOrigin.length) deliverToOrigin(toOrigin.shift()!);
    }
  }
  await writer.idle();
  await writer.submit(checkStore);

  // NoRerunSeen: no confirmed apply of a slot whose outcome its origin had already taken.
  const rerun = confirmed.find((c) => c.seen);
  if (rerun) fail(`slot ${rerun.key} applied after its origin saw its outcome`);
  // At most once per history; with no restore, at most once overall.
  const perHistory = new Map<string, number>();
  for (const c of confirmed) perHistory.set(`${c.history}|${c.key}`, (perHistory.get(`${c.history}|${c.key}`) ?? 0) + 1);
  for (const [key, count] of perHistory) if (count > 1) fail(`slot ${key} applied ${count} times in one history`);

  for (const origin of origins) {
    for (const n of origin.items.keys()) {
      const results = origin.results.get(n);
      if (!results || results.size !== 1) fail(`slot ${n} of ${origin.q.origin}/${origin.q.originEpoch.slice(0, 1)} has ${results?.size ?? 0} distinct outcomes: ${[...(results ?? [])].join(" ; ")}`);
      if (!restored) {
        // The origin's outcome is the store's, and the apply ran iff the outcome says applied.
        const stored = await writer.submit((tx) => findReceipt(tx, origin.slot(n)));
        expect(canonicalJson(stored?.outcome)).toBe([...results!][0]);
        const appliedTimes = confirmed.filter((c) => c.key === slotKey(origin.slot(n))).length;
        expect(appliedTimes, `seed ${seed} slot ${n}`).toBe(origin.accepted.get(n)!.kind === "applied" ? 1 : 0);
      }
    }
  }
  await writer.close();
  db.close();
  return { applies: confirmed.length, restored, resolved: origins.reduce((sum, o) => sum + o.items.size, 0) };
}

describe("slots under random resend / reorder / duplicate / drop (exactly-once, §11.3)", () => {
  it("without restores: every slot applies at most once, every command has exactly one outcome, equal to the stored receipt (150 seeds)", async () => {
    let applies = 0;
    let commands = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const result = await run({ seed, restores: false, steps: 250 });
      applies += result.applies;
      commands += result.resolved;
    }
    expect(commands).toBeGreaterThan(150 * 3 * 6 - 1);
    expect(applies).toBeGreaterThan(0);
  }, 120_000);

  it("with restores (rewind + new incarnation): never re-applied once seen (D49/D50), at most once per history, exactly one outcome each (150 seeds)", async () => {
    let restored = 0;
    for (let seed = 1001; seed <= 1150; seed++) restored += (await run({ seed, restores: true, steps: 250 })).restored;
    expect(restored).toBeGreaterThan(30);
  }, 120_000);
});
