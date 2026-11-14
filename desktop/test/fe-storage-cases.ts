// M1's fe-link storage tests (test/unit/fe-link-storage.test.ts, the SqliteFeStorage part) as cases that run against any
// FeStorage: in Node (test/unit/fe-storage-cases.test.ts: memory and SQLite) and in headless Chromium and WebKit on the
// IndexedDB storage (test/acceptance/web-v3/idb-storage.test.ts). Browser-safe: imports only src/fe-link, no Node
// built-ins, no vitest. The M1 link case there needs the fake server (node:sqlite, node:crypto); here a link with a
// refusing dial checks what the storage owns: the outbox and the epoch survive a restart, a wiped storage gives a new one.
import { applyOps, emptyState, FeLink, MemoryFeStorage, type Dial, type FeStorage, type StorageOp, type StoredState } from "../src/fe-link";

export interface StorageTarget {
  /** Opens the storage (a reopen sees what earlier opens wrote). */
  open(): Promise<FeStorage>;
  /** Removes everything (a wiped storage). */
  wipe(): Promise<void>;
  /** The number of readwrite transactions that fired `complete` so far (IndexedDB only): checks D45's resolve rule. */
  completedWrites?: () => number;
  /** The in-memory test storage checks nothing, so the failed-write case does not apply to it. */
  noValidation?: true;
}

export interface CaseResult { name: string; ok: boolean; detail: string }

const react = (messageId: string) => ({ type: "chat.react", botId: "b1", messageId, emoji: "👍", present: true }) as const;
const slot = (n: number, epoch = "a".repeat(32)) => ({ origin: "desktop", originEpoch: epoch, target: "bot:b1", n });
const item = (n: number, epoch?: string) => ({ slot: slot(n, epoch), cmd: react(`m${n}`), createdAt: n, state: "waiting" as const });

export const OPS: StorageOp[][] = [
  [{ op: "epoch", epoch: "a".repeat(32) }],
  [{ op: "put", item: item(1) }, { op: "counter", target: "bot:b1", next: 2 }],
  [{ op: "put", item: item(2) }, { op: "counter", target: "bot:b1", next: 3 }],
  [{ op: "put", item: { ...item(1), state: "delivered", outcome: { kind: "applied" }, from: { logId: "log-0000001", seq: 4 } } }],
  [{ op: "cursor", stream: "bot:b1", cursor: { logId: "log-0000001", seq: 4, hash: "c".repeat(64) } }, { op: "cursor", stream: "srv:s1", cursor: { logId: "inc-0000001", seq: 0, hash: null } }],
  [{ op: "retired", stream: "bot:b1", retired: [{ logId: "log-0000000", keptSeq: 2 }] }, { op: "retired", stream: "bot:b1", retired: [{ logId: "log-0000000", keptSeq: 2 }] }],
  [{ op: "retired", stream: "bot:b1", retired: [{ logId: "log-000000a", keptSeq: 1 }] }, { op: "retired", stream: "bot:b1", retired: [{ logId: "log-000000b", keptSeq: 3 }] }],
  [{ op: "delete", slot: slot(2) }, { op: "epoch", epoch: "b".repeat(32) }, { op: "put", item: { ...item(1, "b".repeat(32)), movedFrom: slot(2) } }, { op: "counter", target: "bot:b1", next: 2 }],
  [{ op: "cursor", stream: "srv:s1", cursor: null }],
];

/** Plain data, items in slot order: what two storages must agree on (undefined fields dropped as JSON drops them). */
export function normalize(state: StoredState): StoredState {
  const plain = JSON.parse(JSON.stringify(state)) as StoredState;
  plain.items.sort((a, b) => (a.slot.originEpoch + a.slot.n).localeCompare(b.slot.originEpoch + b.slot.n));
  return plain;
}

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function sameAsMemory(target: StorageTarget): Promise<string> {
  await target.wipe();
  const memory = new MemoryFeStorage();
  let disk = await target.open();
  for (const [i, ops] of OPS.entries()) {
    await memory.write(ops);
    const before = target.completedWrites?.();
    await disk.write(ops);
    if (before !== undefined) check(target.completedWrites!() === before + 1, `write ${i} resolved before its transaction's complete`);
    if (i % 3 === 2) { await disk.close(); disk = await target.open(); }
  }
  const fromDisk = await disk.load();
  const fromMemory = await memory.load();
  await disk.close();
  check(same(normalize(fromDisk), normalize(fromMemory)), `disk ${JSON.stringify(normalize(fromDisk))} != memory ${JSON.stringify(normalize(fromMemory))}`);
  check(fromDisk.epoch === "b".repeat(32) && same(fromDisk.counters, { "bot:b1": 2 }), "epoch and counters");
  check(same(fromDisk.retired, { "bot:b1": [{ logId: "log-0000000", keptSeq: 2 }, { logId: "log-000000a", keptSeq: 1 }, { logId: "log-000000b", keptSeq: 3 }] }), `retired ${JSON.stringify(fromDisk.retired)}`);
  check(same(Object.keys(fromDisk.cursors), ["bot:b1"]), "cursors");
  check(same(normalize(applyOps(emptyState(), OPS.flat())), normalize(fromMemory)), "applyOps of all ops");
  return `${OPS.length} writes, ${fromDisk.items.length} item(s)`;
}

async function failedWriteAppliesNothing(target: StorageTarget): Promise<string> {
  if (target.noValidation) return "not applicable (no validation)";
  await target.wipe();
  const disk = await target.open();
  try {
    await disk.write([{ op: "epoch", epoch: "a".repeat(32) }]);
    const before = target.completedWrites?.();
    const broken = { op: "put", item: { ...item(1), slot: { ...slot(1), n: undefined } } } as unknown as StorageOp;
    let rejected = false;
    await disk.write([{ op: "counter", target: "bot:b1", next: 9 }, { op: "put", item: item(5) }, broken]).catch(() => { rejected = true; });
    check(rejected, "a write with a broken item resolved");
    if (before !== undefined) check(target.completedWrites!() === before, "a failed write completed a transaction");
    const state = await disk.load();
    check(same(state.counters, {}) && state.items.length === 0 && state.epoch === "a".repeat(32), `state after failed writes: ${JSON.stringify(state)}`);
    await disk.write([{ op: "counter", target: "bot:b1", next: 3 }]);
    check(same((await disk.load()).counters, { "bot:b1": 3 }), "a write after a failed one");
  } finally {
    await disk.close();
  }
  return "rejected, nothing applied";
}

async function linkKeepsOutboxAndEpoch(target: StorageTarget): Promise<string> {
  await target.wipe();
  // A server that refuses every connection: the item stays waiting in the outbox.
  const refuse: Dial = (handlers) => { setTimeout(() => handlers.close("refused"), 0); return { send() {}, close() {} }; };
  const open = async () => FeLink.open({ storage: await target.open(), dial: refuse, deviceId: "desktop", feVersion: "3.0.0", reconnectMinMs: 60_000, reconnectMaxMs: 60_000 });
  const first = await open();
  first.start();
  await first.submit("bot:b1", react("m1"));
  await first.submit("bot:b1", react("m2"));
  const epoch = first.epoch;
  await first.close();

  const second = await open();
  const pending = second.pending().map((p) => [p.slot.originEpoch, p.slot.n, p.state]);
  const sameEpoch = second.epoch === epoch;
  await second.close();
  check(sameEpoch, "the epoch changed across a restart");
  check(same(pending, [[epoch, 1, "waiting"], [epoch, 2, "waiting"]]), `pending after restart ${JSON.stringify(pending)}`);

  await target.wipe();
  const wiped = await open();
  const newEpoch = wiped.epoch;
  const left = wiped.pending().length;
  await wiped.close();
  check(newEpoch !== epoch && /^[0-9a-f]{32}$/.test(newEpoch), "a wiped storage kept the epoch");
  check(left === 0, "a wiped storage kept items");
  return "outbox and epoch kept; wiped → new epoch";
}

export const STORAGE_CASES: Array<[string, (target: StorageTarget) => Promise<string>]> = [
  ["keeps the same state as the in-memory storage, across a close and reopen", sameAsMemory],
  ["a write that fails applies nothing", failedWriteAppliesNothing],
  ["a link on the storage keeps its outbox and epoch across a restart; a wiped storage makes a new epoch", linkKeepsOutboxAndEpoch],
];

export async function runStorageCases(target: StorageTarget): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const [name, run] of STORAGE_CASES) {
    try {
      results.push({ name, ok: true, detail: await run(target) });
    } catch (error) {
      results.push({ name, ok: false, detail: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) });
    }
  }
  return results;
}
