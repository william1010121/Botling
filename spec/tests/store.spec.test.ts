// server.db durability (spec/models/store) against the real code, through the adapter only.
// Conformance: random walks of the reference (fixed seeds) drive the real store: starts with the boot check, commands
// (an acknowledged one must come back flushed, an engine event must not), clean closes, process crashes and power
// losses (the WAL cut at a commit no earlier than the last flush), and a reader that comes and goes. After every step
// what the real code shows must be the reference's state: the log after a restart is exactly the prefix the power loss
// kept, the flushed part, the logId (rotated only where the model rotates), and what the reader holds. The reader's
// pushes are the model's Push steps (the hub pushes at once; the walk catches the reference up).
// SPEC_BUG=store runs the reference without the boot check ("norotate"): these tests must then fail.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StoreDriver, StoreObservation } from "../driver/store-driver";
import { Ack, Close, Commit, Crash, Disconnect, Flush, init, PowerLoss, Push, Reject, Resend, Start, Sub, violated, type StoreConsts, type StoreState } from "../reference/store";
import { storeDriver } from "../../desktop/spec-adapters/store-adapter";

const c: StoreConsts = { acks: ["a1", "a2"], events: ["e1", "e2", "e3"], maxFault: 3, bug: process.env.SPEC_BUG === "store" ? "norotate" : "none" };
const WALKS = 40;
const STEPS = 30;

const dirs: string[] = [];
const drivers: StoreDriver[] = [];
const scratch = (name: string) => {
  const base = resolve(__dirname, "../../desktop/.cache/test-data");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, `spec-store-${name}-`));
  dirs.push(dir);
  return dir;
};
const open = (name: string) => {
  const driver = storeDriver({ root: scratch(name) });
  drivers.push(driver);
  return driver;
};
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.dispose().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** mulberry32: a small seeded generator, so every walk can be replayed. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Follows the driver through the reference; every step must be allowed and every observation must match. */
function follower(driver: StoreDriver, seed: number) {
  let s: StoreState = init(c);
  const seen: string[] = [];
  const where = () => `seed ${seed}: ${seen.join(" ")}`;
  const take = (label: string, next: StoreState | null) => {
    seen.push(label);
    expect(next, `${where()}: the model does not allow ${label}`).not.toBeNull();
    s = next!;
    expect(violated(c, s), where()).toEqual([]);
  };
  const check = () => {
    const o: StoreObservation = driver.observe();
    // The hub pushed what it had: those are the model's Push steps.
    while (s.rOn && s.rLog.length < o.readerLog.length) take("Push", Push(c, s));
    const want: Partial<StoreObservation> = { up: s.up, synced: s.synced, readerOn: s.rOn, readerLog: [...s.rLog] };
    const got: Partial<StoreObservation> = { up: o.up, synced: o.synced, readerOn: o.readerOn, readerLog: o.readerLog };
    if (s.up) { want.log = [...s.log]; got.log = o.log; want.logId = s.logId; got.logId = o.logId; }
    if (o.readerId >= 0) { want.readerId = s.rId; got.readerId = o.readerId; }
    expect(got, where()).toEqual(want);
  };
  return {
    get state() { return s; },
    where,
    async start() { await driver.start(); take("Start", Start(c, s)); check(); },
    async commit(cmd: string) {
      const ack = c.acks.includes(cmd);
      const { durable, rejected } = await driver.commit(cmd, ack ? "ack" : "event");
      take(`Commit(${cmd})`, Commit(c, s, cmd));
      expect(durable, `${where()}: ${cmd} flushed`).toBe(ack);
      expect(rejected, `${where()}: ${cmd} rejected`).toBe(false);
      // The writer flushes a marked batch before it settles; the acknowledgement goes after.
      if (ack) { if (s.synced < s.log.length) take("Flush", Flush(c, s)); take(`Ack(${cmd})`, Ack(c, s, cmd)); }
      check();
    },
    /** An acknowledged command whose flush fails: committed, rejected, and the writer owes a flush. */
    async commitRejected(cmd: string) {
      const { durable, rejected } = await driver.commit(cmd, "ack", { failFlush: true });
      take(`Commit(${cmd})`, Commit(c, s, cmd));
      expect({ durable, rejected }, `${where()}: ${cmd}'s flush failed`).toEqual({ durable: false, rejected: true });
      take(`Reject(${cmd})`, Reject(c, s, cmd));
      check();
    },
    /** A copy of a committed acknowledged command: answered from its receipt, flushed first only when owed. */
    async resend(cmd: string) {
      const owed = s.debt;
      const { durable, found } = await driver.resend(cmd);
      expect({ durable, found }, `${where()}: re-sent ${cmd}`).toEqual({ durable: owed, found: true });
      take(`Resend(${cmd})`, Resend(c, s, cmd));
      check();
    },
    async close() { await driver.close(); take("Close", Close(c, s)); check(); },
    async crash() { await driver.crash(); take("Crash", Crash(c, s)); check(); },
    async powerLoss(keep: number) { await driver.powerLoss(keep); take(`PowerLoss(${keep})`, PowerLoss(c, s, keep)); check(); },
    async sub() { await driver.subscribe(); take("Sub", Sub(c, s)); check(); },
    disconnect() { driver.disconnect(); take("Disconnect", Disconnect(c, s)); check(); },
  };
}

describe("store: server.db durability (spec/models/store)", () => {
  it("random walks: the real store, crashes and power losses follow the model", async () => {
    for (let seed = 1; seed <= WALKS; seed++) {
      const driver = open(`walk${seed}`);
      const rnd = random(seed);
      const f = follower(driver, seed);
      for (let step = 0; step < STEPS; step++) {
        const s = f.state;
        const moves: Array<[number, () => Promise<void> | void]> = [];
        if (!s.up) moves.push([4, () => f.start()]);
        if (s.up) for (const cmd of [...c.acks, ...c.events]) if (!s.log.includes(cmd)) moves.push([2, () => f.commit(cmd)]);
        if (s.up) for (const cmd of c.acks) if (!s.log.includes(cmd)) moves.push([1, () => f.commitRejected(cmd)]);
        if (s.up) for (const cmd of c.acks) if (s.log.includes(cmd) && !s.owed.includes(cmd)) moves.push([1, () => f.resend(cmd)]);
        if (s.up && !s.owed.length) moves.push([1, () => f.close()]);
        if (s.up && s.faults < c.maxFault) moves.push([1, () => f.crash()]);
        if (s.faults < c.maxFault) {
          const keep = s.synced + Math.floor(rnd() * (s.log.length - s.synced + 1));
          moves.push([2, () => f.powerLoss(keep)]);
        }
        if (s.up && !s.rOn) moves.push([3, () => f.sub()]);
        if (s.rOn) moves.push([1, () => f.disconnect()]);
        if (!moves.length) break;
        const total = moves.reduce((sum, [w]) => sum + w, 0);
        let pick = rnd() * total;
        const move = moves.find(([w]) => (pick -= w) < 0) ?? moves[moves.length - 1]!;
        await move[1]();
      }
      await driver.dispose();
      drivers.splice(drivers.indexOf(driver), 1);
    }
  }, 240_000);

  it("a power loss takes events a reader saw; the next run resets the reader instead of letting it follow (NoFork)", async () => {
    const f = follower(open("fork"), 0);
    await f.start();
    await f.sub();
    await f.commit("e1");
    await f.commit("e2");
    expect(f.state.rLog).toEqual(["e1", "e2"]);
    await f.powerLoss(f.state.synced); // both events were never flushed
    await f.start();
    expect(f.state.logId, f.where()).toBe(1);
    await f.commit("e3");
    await f.sub(); // its cursor (old logId, 2) must not be followed into ["e3"]
    expect(f.state.rLog, f.where()).toEqual(["e3"]);
    expect(f.state.rId, f.where()).toBe(1);
  });

  it("an acknowledged command survives the earliest power loss; events after it may not (AckedKept)", async () => {
    const f = follower(open("acked"), 0);
    await f.start();
    await f.commit("e1");
    await f.commit("a1");
    await f.commit("e2");
    expect(f.state.synced).toBe(2); // a1's flush covers e1 too
    await f.powerLoss(2);
    await f.start();
    expect(f.state.log, f.where()).toEqual(["e1", "a1"]);
  });

  it("a re-send after a failed flush is answered only once the commit is flushed; a power loss keeps it (AckedKept)", async () => {
    const f = follower(open("debt"), 0);
    await f.start();
    await f.commit("e1");
    await f.commitRejected("a1");
    expect(f.state.debt).toBe(true);
    expect(f.state.synced).toBe(0);
    await f.resend("a1"); // the writer owes a flush: this batch is flushed before the answer
    expect(f.state.synced, f.where()).toBe(2);
    expect(f.state.acked, f.where()).toEqual(["a1"]);
    await f.resend("a1"); // paid: no flush again
    await f.powerLoss(2);
    await f.start();
    expect(f.state.log, f.where()).toEqual(["e1", "a1"]);
  });

  it("a crash of the process alone loses nothing and keeps the logId; a clean close then a new boot neither", async () => {
    const f = follower(open("crash"), 0);
    await f.start();
    await f.sub();
    await f.commit("e1");
    await f.crash();
    await f.start();
    expect(f.state.log, f.where()).toEqual(["e1"]);
    expect(f.state.logId, f.where()).toBe(0);
    await f.sub();
    await f.commit("e2");
    await f.close();
    await f.powerLoss(2);
    await f.start();
    expect(f.state.logId, f.where()).toBe(0);
    expect(f.state.log, f.where()).toEqual(["e1", "e2"]);
  });
});
