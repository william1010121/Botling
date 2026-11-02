// The data-folder lock (spec/models/datalock) against the real code, through the adapter only.
// Conformance: random walks of the reference (fixed seeds) drive the real DataDirLock of four cores. Every step the
// real code takes must be the step the model allows that core; between any two steps other cores may act, the core
// may be killed, a dead core's pid reused or the folder swapped; what is on disk must agree after every step.
// Each reported step must be one change on disk: the file system is wrapped, and what is on disk after every change
// between two steps must be what the model shows before or after the step (7be956c7's lock moved aside and put back
// inside one step). The app writes no trace lines for this model: its steps reach the test through the listener.
// SPEC_BUG=datalock turns on 7be956c7's takeover in the reference: these tests must then fail.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataLockDriver, DataLockEvent, DataLockObservation, DataLockOutcome } from "../driver/datalock-driver";
import { init, next, observe, violated, type DataLockAction, type DataLockConsts, type DataLockState, type DataLockStep } from "../reference/datalock";
import { datalockDriver } from "../../desktop/spec-adapters/datalock-adapter";

/** Called after every change to the file system. */
const changed = vi.hoisted(() => ({ fn: null as (() => void) | null }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const names = ["renameSync", "linkSync", "unlinkSync", "rmdirSync", "rmSync", "writeFileSync", "mkdirSync", "cpSync"] as const;
  return {
    ...fs,
    ...Object.fromEntries(names.map((name) => [name, (...args: unknown[]) => {
      try { return (fs[name] as (...a: unknown[]) => unknown)(...args); } finally { changed.fn?.(); }
    }])),
  };
});

const c: DataLockConsts = { cores: ["c1", "c2", "c3", "c4"], maxSwap: 2, bug: process.env.SPEC_BUG === "datalock" ? "restore" : "none" };
const WALKS = 300;
const STEPS = 40;
/** How deep other cores' operations nest inside one core's operation. */
const DEPTH = 3;

const dirs: string[] = [];
const scratch = (name: string) => {
  const base = resolve(__dirname, "../../desktop/.cache/test-data");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, `spec-datalock-${name}-`));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  changed.fn = null;
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

const label = (t: Pick<DataLockStep, "action" | "core" | "copy">) =>
  `${t.action}(${t.core ?? (t.copy ? "copy" : "fresh")})`;
/** The steps a driver call begins (the rest are taken inside a call and reported to the listener). */
const OUTER = new Set<DataLockAction>(["Start", "Retry", "GiveUp", "Check", "Quit", "Leave", "Crash", "Reuse", "Swap"]);

/**
 * Follows a driver through the reference: each step the real code reports must be the one the model allows.
 * After each step `after` runs, or (none) now and then a random call of another core, nested.
 */
function follower(driver: DataLockDriver, { seed = 0, after }: { seed?: number; after?: (event: DataLockEvent) => void } = {}) {
  const rnd = random(seed);
  const pick = <T>(list: T[]) => list[Math.floor(rnd() * list.length)]!;
  const seen: string[] = [];
  const stack: string[] = [];
  let s: DataLockState = init(c);
  let depth = 0;
  let nested = 0;
  /** What was on disk after each change since the last step (the driver's own swaps are not counted). */
  const between: DataLockObservation[] = [];
  let quiet = false;
  changed.fn = () => { if (!quiet) between.push(driver.observe()); };
  const where = () => `seed ${seed}: ${seen.join(" ")}`;
  const check = () => {
    expect(between, `changes on disk no step reported; ${where()}`).toEqual([]);
    expect(driver.observe(), where()).toEqual(observe(s));
    expect(violated(c, s), where()).toEqual([]);
  };
  const take = (action: DataLockAction, core?: string, copy?: boolean) => {
    const step = next(c, s).find((t) => t.action === action && t.core === core && (copy === undefined || t.copy === copy));
    seen.push(label({ action, core, copy }));
    expect(step, `the model does not allow ${label({ action, core, copy })} here; ${where()}`).toBeDefined();
    const shown = [observe(s), observe(step!.state)];
    for (const disk of between.splice(0)) expect(shown, `on disk in the middle of ${label({ action, core, copy })}; ${where()}`).toContainEqual(disk);
    s = step!.state;
  };
  const outcome = (core: string, out: DataLockOutcome) => expect(out, `${core} after its call; ${where()}`).toBe(s.pc[core]);
  const call = (core: string, run: () => DataLockOutcome) => {
    stack.push(core);
    try { outcome(core, run()); } finally { stack.pop(); }
  };

  /** One driver call, as the model's action `t` begins it. */
  const begin = (t: DataLockStep) => {
    const core = t.core!;
    switch (t.action) {
      case "Start": take("Start", core); return call(core, () => driver.start(core));
      case "Retry": take("Retry", core); return call(core, () => driver.retry(core));
      case "Check": return call(core, () => driver.check(core));
      case "Leave": stack.push(core); try { driver.leave(core); } finally { stack.pop(); } return;
      case "GiveUp": case "Quit": take(t.action, core); break;
      case "Crash": take("Crash", core); driver.crash(core); break;
      case "Reuse": take("Reuse", core); driver.reuse(core); break;
      case "Swap": take("Swap", undefined, t.copy); quiet = true; try { driver.swap(t.copy!); } finally { quiet = false; } break;
      default: throw Error(`not a driver call: ${t.action}`);
    }
    check();
  };
  /** Picks one of the calls the model allows now (a core in the middle of a call can only be killed). */
  const act = () => {
    const steps = next(c, s).filter((t) => OUTER.has(t.action) && (t.action === "Crash" || t.core === undefined || !stack.includes(t.core)));
    if (!steps.length) return false;
    begin(pick(steps));
    return true;
  };

  driver.onStep((event) => {
    take(event.step, event.core);
    check();
    if (after) after(event);
    else if (depth < DEPTH && rnd() < 0.35) {
      depth++;
      nested++;
      try { act(); } finally { depth--; }
    }
  });
  return { act, take, call, check, state: () => s, nested: () => nested, seen };
}

describe("data-folder lock model: the real DataDirLock follows the reference", () => {
  it("random walks with other cores, kills, pid reuse and swaps between any two steps", () => {
    let nested = 0;
    let writers = 0;
    for (let seed = 1; seed <= WALKS; seed++) {
      const walk = follower(datalockDriver({ cores: c.cores, maxSwap: c.maxSwap, root: scratch("walk") }), { seed });
      for (let i = 0; i < STEPS && walk.act(); i++) if (c.cores.some((core) => walk.state().pc[core] === "writing")) writers++;
      nested += walk.nested();
      changed.fn = null;
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    }
    // The walks do reach other cores acting in the middle of a claim, and cores that write.
    expect(nested).toBeGreaterThan(1_000);
    expect(writers).toBeGreaterThan(1_000);
  }, 120_000);
});

describe("data-folder lock model: the interleaving 7be956c7 got wrong (TLC's counterexample for DataLock_bug_restore.cfg)", () => {
  it("a core breaking a lock that is no longer there leaves the new holder alone, and a fourth core waits", () => {
    const driver = datalockDriver({ cores: c.cores, maxSwap: c.maxSwap, root: scratch("restore") });
    const outcomes: Record<string, DataLockOutcome> = {};
    const run = (core: string, how: () => DataLockOutcome) => walk.call(core, () => (outcomes[core] = how()));
    // c2 is refused (c1 holds); c1 exits; c2 reads no holder; c3 takes the folder; c2 breaks what it judged; c4 claims.
    const plan: Record<string, () => void> = {
      Try: () => driver.leave("c1"),
      Look: () => { walk.take("Start", "c3"); run("c3", () => driver.start("c3")); },
      Break: () => { walk.take("Start", "c4"); run("c4", () => driver.start("c4")); },
    };
    const walk = follower(driver, {
      after(event) {
        const step = event.core === "c2" ? plan[event.step] : undefined;
        if (!step) return;
        delete plan[event.step];
        step();
      },
    });
    walk.take("Start", "c1");
    run("c1", () => driver.start("c1"));
    walk.take("Quit", "c1");
    walk.take("Start", "c2");
    run("c2", () => driver.start("c2"));
    expect(Object.keys(plan)).toEqual([]);
    expect(outcomes).toEqual({ c1: "writing", c2: "wait", c3: "writing", c4: "wait" });
    expect(driver.observe().lock[0]).toBe("c3");
  });
});
