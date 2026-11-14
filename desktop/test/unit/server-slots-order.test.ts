// D58 at the slot engine (protocol v1 §11.3): within one (origin, originEpoch, target) queue, outcomes commit in slot
// order, whatever order copies arrive in, and the held-ahead buffer (here only 4 deep, so it overflows and drops) never
// lets a later slot commit before an earlier one. The origin computes floor as its smallest unresolved slot, as fe-link
// does (outbox.ts), so without a restore no slot is ever skipped: `cmd.skipped` is only for slots the origin already
// holds an outcome for. A FIFO session (the session core's per-queue chain) never even makes the engine hold a copy.
import { afterAll, describe, expect, it } from "vitest";
import type { CmdBody } from "../../src/protocol";
import { SlotEngine, type ApplyFn, type SlotReply } from "../../src/server/slots";
import type { Db } from "../../src/server/store";
import { entries, FakeLog, memoryStore, react, rng } from "./server-slots-harness";

const dbs: Db[] = [];
afterAll(() => { for (const db of dbs) db.close(); });

const apply: ApplyFn = ({ tx, slot, log }) => { log.appendEntry(tx, slot.target, "test.intent", { n: slot.n }, slot); return { result: { n: slot.n } }; };

function setup(heldLimit: number) {
  const { db, writer } = memoryStore();
  dbs.push(db);
  const engine = new SlotEngine({ submit: (c) => writer.submit(c), log: new FakeLog(), apply, heldLimit });
  return { db, engine };
}

/** The slots of decided outcomes, in log order; and the skipped ranges. */
function decided(db: Db): { order: number[]; skipped: number } {
  const all = entries(db, "bot:b1");
  return {
    order: all.filter((e) => ["cmd.applied", "cmd.cancelled", "cmd.refused"].includes(e.kind)).map((e) => e.slot!.n),
    skipped: all.filter((e) => e.kind === "cmd.skipped").length,
  };
}

describe("D58: outcomes of one queue commit in slot order", () => {
  it("copies reordered, duplicated and dropped across many deliveries, with cancels: slots decide 1, 2, 3… exactly once, none skipped (200 seeds)", async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = rng(seed);
      const { db, engine } = setup(4);
      const total = 3 + Math.floor(random() * 12);
      const resolved = new Set<number>();
      const onReply = (m: SlotReply) => { if (m.t === "cmd.result") resolved.add(m.slot.n); };
      for (let round = 0; resolved.size < total && round < 60; round++) {
        const unresolved = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !resolved.has(n));
        const floor = Math.min(...unresolved);
        const copies: CmdBody[] = [];
        for (const n of unresolved) {
          if (random() < 0.3) continue; // lost on the way
          copies.push(react(n, { floor }));
          if (random() < 0.2) copies.push(react(n, { floor })); // a duplicate
        }
        for (let i = copies.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copies[i], copies[j]] = [copies[j]!, copies[i]!]; }
        const cancels = unresolved.filter(() => random() < 0.05).map((n) => engine.cancel(react(n).slot));
        await Promise.all([...cancels, ...copies.map((body) => engine.receive(body, { scope: "local", reply: onReply }))]);
      }
      const { order, skipped } = decided(db);
      expect(order, `seed ${seed}`).toEqual(Array.from({ length: total }, (_, i) => i + 1));
      expect(skipped, `seed ${seed}`).toBe(0);
      expect(resolved.size, `seed ${seed}`).toBe(total);
    }
  });

  it("a FIFO session (each copy after the one before settled, as the session core sends them): nothing is ever held", async () => {
    const { db, engine } = setup(4);
    for (let n = 1; n <= 20; n++) {
      const status = await engine.receive(react(n, { floor: n }), { scope: "local" });
      expect(status.status).toBe("result");
      expect(engine.heldCount()).toBe(0);
    }
    expect(decided(db).order).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("a held copy waits for the missing slot however long: later slots never commit past it", async () => {
    const { db, engine } = setup(4);
    await engine.receive(react(1), { scope: "local" });
    for (const n of [3, 4, 5, 6, 7]) await engine.receive(react(n, { floor: 2 }), { scope: "local" });
    expect(decided(db).order).toEqual([1]);
    expect(engine.heldCount()).toBe(4); // 7 was dropped: the farthest goes when the buffer is full
    await engine.receive(react(2, { floor: 2 }), { scope: "local" });
    expect(decided(db).order).toEqual([1, 2, 3, 4, 5, 6]);
    await engine.receive(react(7, { floor: 7 }), { scope: "local" });
    expect(decided(db).order).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
