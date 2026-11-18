// The server.db writer never waits on a timer (protocol v1 D41): a lone command commits at once, commands submitted
// together share one transaction (≤ 64), and commands arriving while a commit runs form the next one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openServerStore, type BatchInfo, type Db, type ServerStore } from "../../src/server/store";

const dirs: string[] = [];
const stores: ServerStore[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function open(options: Parameters<typeof openServerStore>[1] = {}): Promise<ServerStore> {
  const dir = mkdtempSync(join(tmpdir(), "botling-writer-"));
  dirs.push(dir);
  const store = await openServerStore(dir, options);
  stores.push(store);
  return store;
}
let seq = 0;
const insert = (db: Db) => db.prepare("INSERT INTO entries (stream, seq, hlc, kind, body, slot, hash) VALUES ('w', ?, '0', 't', 'b', NULL, 'h')").run(++seq);

describe("group commit without a timer (D41)", () => {
  it("commits a lone command at once: no setTimeout or setInterval, and resolves with fake timers frozen", async () => {
    const batches: BatchInfo[] = [];
    const store = await open({ onBatch: (info) => batches.push(info) });
    // Frozen clock: a writer that waited for a window (even 0 ms) on a timer would never resolve here.
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const result = await store.submit((db, ctx) => { insert(db); return ctx; });
    expect(result).toEqual({ batch: 1, index: 0, durable: expect.any(Function) }); // D75: the writer's own flush mark
    expect(batches).toMatchObject([{ batch: 1, size: 1, committed: true }]);
    // A second lone command later also commits on its own, without waiting.
    await store.submit(insert);
    expect(batches.map((b) => b.size)).toEqual([1, 1]);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("puts commands that arrive during a commit into the next transaction", async () => {
    const batches: BatchInfo[] = [];
    const store = await open({
      onBatch: (info) => batches.push(info),
      beforeCommit: (batch) => {
        // Arrivals while batch 1 is committing (here: right before its COMMIT, on the same thread).
        if (batch === 1) for (let i = 0; i < 5; i++) late.push(store.submit((db, ctx) => { insert(db); return ctx.batch; }));
      },
    });
    const late: Promise<number>[] = [];
    // An arrival from inside a running command goes to the next transaction too.
    const first = store.submit((db, ctx) => {
      insert(db);
      late.push(store.submit((d, c) => { insert(d); return c.batch; }));
      return ctx.batch;
    });
    expect(await first).toBe(1);
    expect(await Promise.all(late)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(batches.map((b) => [b.batch, b.size])).toEqual([[1, 1], [2, 6]]);
  });

  it("takes everything waiting, up to 64 per transaction, and never splits fewer", async () => {
    const batches: BatchInfo[] = [];
    const store = await open({ onBatch: (info) => batches.push(info) });
    const all = Array.from({ length: 150 }, () => store.submit(insert));
    await Promise.all(all);
    expect(batches.map((b) => b.size)).toEqual([64, 64, 22]);
    await Promise.all(Array.from({ length: 10 }, () => store.submit(insert)));
    expect(batches.map((b) => b.size)).toEqual([64, 64, 22, 10]);
  });

  it("resolves a command only after its transaction committed", async () => {
    let committedBatches = 0;
    const store = await open({ onBatch: (info) => { if (info.committed) committedBatches++; } });
    const ack = store.submit(insert).then(() => committedBatches);
    expect(await ack).toBe(1);
    // A fresh reader connection sees the row as soon as the promise resolved.
    const reader = store.openReader();
    try { expect(Number(reader.prepare("SELECT count(*) AS n FROM entries").get()!.n)).toBe(1); } finally { reader.close(); }
  });

  it("refuses new commands after close and settles those already queued", async () => {
    const store = await open();
    const queued = store.submit(insert);
    const closing = store.writer.close();
    await expect(store.submit(insert)).rejects.toThrow(/closed/);
    await expect(queued).resolves.toBeDefined();
    await closing;
  });
});
