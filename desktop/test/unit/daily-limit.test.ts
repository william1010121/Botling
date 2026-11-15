// M7-S87 follow-up: unit tests of `DailyLimit` (the daily byte limit of FetchSource, `fetch/daily-limit.ts`).
// No FetchSource, no real db, no timers: `store.submit` and `reader` are in-memory fakes over one `meta` map, and the
// day comes from the `at` argument. A submit can be held open by a gate, so ordering is checked without sleeping.
import { describe, expect, it } from "vitest";
import { DailyLimit, type DailyLimitDeps } from "../../src/server/fetch/daily-limit";
import { DAY_MS } from "../../src/server/fetch/source-shared";

const dayKey = (day: number) => `fetchDailyBytes:${day}`;
// Fixed "dates": the middle of day 20000 and of the next day.
const DAY = 20_000;
const AT = DAY * DAY_MS + 12 * 60 * 60 * 1000;
const NEXT_AT = (DAY + 1) * DAY_MS + 60_000;

interface Gate { promise: Promise<void>; open: () => void }
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
/** Let queued microtasks run (promise chains only; no timer). */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

interface Harness {
  limit: DailyLimit;
  meta: Map<string, string>;
  logs: string[];
  /** Every `submit` call, in call order: the index it was called with. */
  started: number[];
  /** Order in which the submit callbacks actually wrote (each entry is the day keys written). */
  written: string[][];
  readerCalls: string[];
  /** Per submit call (0-based): a gate to hold it, or an error to reject with after running nothing. */
  hold: Map<number, Gate>;
  fail: Map<number, Error>;
}

function harness(initial: Record<string, string> = {}): Harness {
  const meta = new Map<string, string>(Object.entries(initial));
  const h: Harness = {
    limit: undefined as unknown as DailyLimit,
    meta, logs: [], started: [], written: [], readerCalls: [], hold: new Map(), fail: new Map(),
  };
  const select = (calls?: string[]) => ({
    get: (key: string) => {
      calls?.push(key);
      const value = meta.get(key);
      return value === undefined ? undefined : { value };
    },
  });
  const store = {
    submit: async (fn: (tx: unknown) => void) => {
      const index = h.started.length;
      h.started.push(index);
      const g = h.hold.get(index);
      if (g) await g.promise;
      const error = h.fail.get(index);
      if (error) throw error;
      const keys: string[] = [];
      fn({
        prepare: (sql: string) => {
          if (sql.startsWith("SELECT")) return select();
          return { run: (key: string, value: string) => { keys.push(key); meta.set(key, value); } };
        },
      });
      h.written.push(keys);
    },
  };
  const reader = () => ({ prepare: () => select(h.readerCalls) });
  const deps = { store, reader, log: (line: string) => { h.logs.push(line); } } as unknown as DailyLimitDeps;
  h.limit = new DailyLimit(deps);
  return h;
}

const stored = (h: Harness, day = DAY): Record<string, number> => JSON.parse(h.meta.get(dayKey(day)) ?? "{}");

describe("DailyLimit", () => {
  it("get sees add before any flush, and adds up per key", () => {
    const h = harness();
    expect(h.limit.get("bot-a", AT)).toBe(0);
    h.limit.add("bot-a", AT, 100);
    expect(h.limit.get("bot-a", AT)).toBe(100);
    h.limit.add("bot-a", AT, 23);
    h.limit.add("bot-b", AT, 5);
    expect(h.limit.get("bot-a", AT)).toBe(123);
    expect(h.limit.get("bot-b", AT)).toBe(5);
    expect(h.limit.get("bot-c", AT)).toBe(0);
    // Nothing was submitted: counting in memory is independent of flushing.
    expect(h.started).toEqual([]);
    expect(h.meta.size).toBe(0);
  });

  it("a flush writes exactly the added bytes (not doubled) to meta", async () => {
    const h = harness();
    h.limit.add("bot-a", AT, 100);
    h.limit.add("bot-a", AT, 23);
    h.limit.add("bot-b", AT, 5);
    await h.limit.flush();
    expect(stored(h)).toEqual({ "bot-a": 123, "bot-b": 5 });
    expect(h.started).toHaveLength(1);
    // The in-memory count is not changed by a flush either.
    expect(h.limit.get("bot-a", AT)).toBe(123);
  });

  it("flush merges onto the stored value: adds, keeps other keys, never overwrites", async () => {
    const h = harness({ [dayKey(DAY)]: JSON.stringify({ "bot-a": 1000, "bot-old": 7 }) });
    h.limit.add("bot-a", AT, 24);
    h.limit.add("bot-new", AT, 3);
    await h.limit.flush();
    expect(stored(h)).toEqual({ "bot-a": 1024, "bot-old": 7, "bot-new": 3 });
    // A later flush from the same instance adds again onto what is now stored.
    h.limit.add("bot-a", AT, 6);
    await h.limit.flush();
    expect(stored(h)).toEqual({ "bot-a": 1030, "bot-old": 7, "bot-new": 3 });
  });

  it("flush merges with what another writer stored after this instance loaded the day", async () => {
    const h = harness({ [dayKey(DAY)]: JSON.stringify({ "bot-a": 10 }) });
    expect(h.limit.get("bot-a", AT)).toBe(10); // loaded from the reader
    h.meta.set(dayKey(DAY), JSON.stringify({ "bot-a": 50 })); // stored value moved on
    h.limit.add("bot-a", AT, 5);
    await h.limit.flush();
    expect(stored(h)["bot-a"]).toBe(55); // the stored 50 plus the pending 5, not the loaded 10 + 5
  });

  it("pending is cleared after the snapshot: a second flush sends nothing", async () => {
    const h = harness();
    h.limit.add("bot-a", AT, 10);
    await h.limit.flush();
    await h.limit.flush();
    await h.limit.flush();
    expect(h.started).toHaveLength(1);
    expect(stored(h)).toEqual({ "bot-a": 10 });
    // Only the bytes added after the first flush go out with the next one.
    h.limit.add("bot-a", AT, 4);
    await h.limit.flush();
    expect(h.started).toHaveLength(2);
    expect(stored(h)).toEqual({ "bot-a": 14 });
  });

  it("a flush with nothing pending does not call submit", async () => {
    const h = harness();
    await h.limit.flush();
    expect(h.started).toEqual([]);
  });

  it("the date rolls over: each day has its own counts and its own meta key", async () => {
    const h = harness();
    h.limit.add("bot-a", AT, 100);
    h.limit.add("bot-a", NEXT_AT, 7);
    expect(h.limit.get("bot-a", AT)).toBe(100);
    expect(h.limit.get("bot-a", NEXT_AT)).toBe(7);
    expect(h.limit.get("bot-a", NEXT_AT + 2 * DAY_MS)).toBe(0);
    // Day edges: the last millisecond of a day and the first of the next.
    expect(h.limit.get("bot-a", (DAY + 1) * DAY_MS - 1)).toBe(100);
    expect(h.limit.get("bot-a", (DAY + 1) * DAY_MS)).toBe(7);
    await h.limit.flush();
    expect(stored(h, DAY)).toEqual({ "bot-a": 100 });
    expect(stored(h, DAY + 1)).toEqual({ "bot-a": 7 });
    expect([...h.meta.keys()].sort()).toEqual([dayKey(DAY), dayKey(DAY + 1)]);
    expect(h.started).toHaveLength(1); // both days commit in one transaction
  });

  it("a new day starts from zero even when the previous day is stored", () => {
    const h = harness({ [dayKey(DAY)]: JSON.stringify({ "bot-a": 999 }) });
    expect(h.limit.get("bot-a", AT)).toBe(999);
    expect(h.limit.get("bot-a", NEXT_AT)).toBe(0);
  });

  it("get loads the persisted day from the reader once, and ignores bad entries", () => {
    const h = harness({
      [dayKey(DAY)]: JSON.stringify({ good: 42, neg: -1, str: "9", nan: null, inf: 1e999 }),
      [dayKey(DAY + 1)]: "{not json",
    });
    expect(h.limit.get("good", AT)).toBe(42);
    expect(h.limit.get("neg", AT)).toBe(0);
    expect(h.limit.get("str", AT)).toBe(0);
    expect(h.limit.get("nan", AT)).toBe(0);
    expect(h.limit.get("inf", AT)).toBe(0);
    expect(h.readerCalls).toEqual([dayKey(DAY)]); // cached after the first load
    expect(h.limit.get("good", NEXT_AT)).toBe(0); // malformed meta: empty, no throw
  });

  it("flush overwrites a corrupt stored value with the pending counts", async () => {
    const h = harness({ [dayKey(DAY)]: "{not json" });
    h.limit.add("bot-a", AT, 8);
    await h.limit.flush();
    expect(stored(h)).toEqual({ "bot-a": 8 });
  });

  it("two add+flush in a row write in call order: the second submit waits for the first", async () => {
    const h = harness();
    const first = gate();
    h.hold.set(0, first);

    h.limit.add("bot-a", AT, 10);
    const p1 = h.limit.flush();
    h.limit.add("bot-a", NEXT_AT, 20);
    const p2 = h.limit.flush();

    await drain();
    // The first submit is open and held; the second has not even been called: one queue.
    expect(h.started).toEqual([0]);
    expect(h.written).toEqual([]);

    first.open();
    await Promise.all([p1, p2]);
    expect(h.started).toEqual([0, 1]);
    // The writes landed first-flush-first.
    expect(h.written).toEqual([[dayKey(DAY)], [dayKey(DAY + 1)]]);
    expect(stored(h, DAY)).toEqual({ "bot-a": 10 });
    expect(stored(h, DAY + 1)).toEqual({ "bot-a": 20 });
  });

  it("the first flush promise settles before the second one's submit is even called", async () => {
    const h = harness();
    const first = gate();
    h.hold.set(0, first);
    h.limit.add("bot-a", AT, 1);
    const p1 = h.limit.flush();
    h.limit.add("bot-a", AT, 2);
    const p2 = h.limit.flush();
    const second = gate();
    h.hold.set(1, second);

    first.open();
    await p1;
    await drain();
    // p1 is the queue after the first flush; the second flush's submit is now running but held.
    expect(h.written).toHaveLength(1);
    expect(h.started).toEqual([0, 1]);
    let p2Done = false;
    void p2.then(() => { p2Done = true; });
    await drain();
    expect(p2Done).toBe(false);
    second.open();
    await p2;
    expect(stored(h)).toEqual({ "bot-a": 3 });
  });

  it("a flush with nothing pending returns the queue: it waits for a flush still in flight", async () => {
    const h = harness();
    const open = gate();
    h.hold.set(0, open);
    h.limit.add("bot-a", AT, 10);
    const inFlight = h.limit.flush();
    const idle = h.limit.flush(); // nothing pending: hands back the same queue
    let idleDone = false;
    void idle.then(() => { idleDone = true; });
    await drain();
    expect(idleDone).toBe(false);
    expect(h.meta.size).toBe(0);
    open.open();
    await idle;
    expect(idleDone).toBe(true);
    // By the time the idle flush resolves, the in-flight one has committed (FetchSource.close relies on this).
    expect(stored(h)).toEqual({ "bot-a": 10 });
    await inFlight;
  });

  it("a rejecting submit is swallowed and logged once, and the next flush still runs", async () => {
    const h = harness();
    h.fail.set(0, new Error("disk full"));
    h.limit.add("bot-a", AT, 10);
    await expect(h.limit.flush()).resolves.toBeUndefined();
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toBe("fetch: persisting daily byte counts failed: disk full");
    expect(h.meta.size).toBe(0);

    // The failed batch is dropped from pending (it was cleared at snapshot), new bytes go through the same queue.
    h.limit.add("bot-a", AT, 5);
    await expect(h.limit.flush()).resolves.toBeUndefined();
    expect(h.started).toEqual([0, 1]);
    expect(stored(h)).toEqual({ "bot-a": 5 });
    expect(h.logs).toHaveLength(1); // no second log line for a success
    // And the in-memory count still holds both.
    expect(h.limit.get("bot-a", AT)).toBe(15);
  });

  it("a rejection inside a queued chain does not stop the flushes behind it", async () => {
    const h = harness();
    const open = gate();
    h.hold.set(0, open);
    h.fail.set(0, new Error("boom"));
    h.limit.add("bot-a", AT, 1);
    const p1 = h.limit.flush();
    h.limit.add("bot-b", AT, 2);
    const p2 = h.limit.flush();
    open.open();
    await expect(Promise.all([p1, p2])).resolves.toBeDefined();
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("boom");
    expect(stored(h)).toEqual({ "bot-b": 2 });
  });

  it("a non-Error rejection is logged as its string", async () => {
    const h = harness();
    h.fail.set(0, "plain text" as unknown as Error);
    h.limit.add("bot-a", AT, 1);
    await h.limit.flush();
    expect(h.logs).toEqual(["fetch: persisting daily byte counts failed: plain text"]);
  });
});
