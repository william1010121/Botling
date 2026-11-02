// The restart continuation (spec/models/restart) against the real code, through the adapter only.
// (a) Conformance: random walks of the reference (fixed seeds) drive the real code; recovery runs as the real
//     code orders it and each of its steps must be one the model allows; observations must agree after every step.
// (b) Trace check: the same walks with BOTLING_SPEC_TRACE set; every line the app wrote must be an allowed step.
// SPEC_BUG=restart turns on the design before d678d161 in the reference: these tests must then fail.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RestartDriver, RestartTraceStep } from "../driver/restart-driver";
import { RECOVERY_ACTIONS, init, next, observe, violated, type RestartConsts, type RestartState, type RestartStep } from "../reference/restart";
import { restartDriver, restartTraceStep } from "../../desktop/spec-adapters/restart-adapter";

const c: RestartConsts = { bots: ["b1", "b2", "b3"], plugins: "plugins", maxCrashes: 2, bug: process.env.SPEC_BUG === "restart" };
const WALKS = 300;
const STEPS = 40;

const dirs: string[] = [];
const scratch = (name: string) => {
  const base = resolve(__dirname, "../../desktop/.cache/test-data");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, `spec-restart-${name}-`));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  delete process.env.BOTLING_SPEC_TRACE;
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

const label = (t: Pick<RestartStep, "action" | "bot" | "part" | "ok" | "own">) =>
  `${t.action}(${[t.bot, t.part, t.ok === undefined ? undefined : t.ok ? "ok" : "fail", t.own ? "own" : undefined].filter(Boolean).join(",")})`;

async function apply(driver: RestartDriver, t: RestartStep) {
  switch (t.action) {
    case "Start": return driver.start(t.bot!, t.own!);
    case "Finish": return driver.finish(t.bot!);
    case "Prepare": return driver.prepare();
    case "Cancel": return driver.cancel();
    case "BeginShutdown": return driver.beginShutdown();
    case "Settle": return driver.settle(t.part!, t.ok!);
    case "Ready": return driver.ready();
    case "Crash": return driver.crash();
    case "Expire": return driver.expire();
    default: throw Error(`not a driver step: ${t.action}`);
  }
}

/** One walk: the reference picks the old app's steps, crashes and delivery outcomes; the real code is compared after each
 * (`compare` false: the walk only drives the app, for its trace, and stops where the model cannot follow). */
async function walk(seed: number, driver: RestartDriver, compare = true) {
  const rnd = random(seed);
  const pick = <T>(list: T[]) => list[Math.floor(rnd() * list.length)];
  const seen: string[] = [];
  const where = () => `seed ${seed}: ${seen.join(" ")}`;
  let s: RestartState = init(c);
  const check = () => {
    if (!compare) return;
    expect(driver.observe(), where()).toEqual(observe(s));
    expect(violated(c, s), where()).toEqual([]);
  };
  for (let i = 0; i < STEPS; i++) {
    const steps = next(c, s).filter((t) => !RECOVERY_ACTIONS.includes(t.action));
    if (!steps.length) break;
    const step = pick(steps);
    seen.push(label(step));
    if (step.action !== "Boot") {
      await apply(driver, step);
      s = step.state;
      check();
      continue;
    }
    s = step.state;
    const plan = { fail: c.bots.filter(() => rnd() < 0.3), crashAfter: s.crashes < c.maxCrashes && rnd() < 0.4 ? Math.floor(rnd() * 7) : undefined };
    seen.push(`[fail ${plan.fail.join(",") || "-"}${plan.crashAfter === undefined ? "" : `, crash after ${plan.crashAfter}`}]`);
    const { events, crashed } = driver.boot(plan);
    for (const e of events) {
      seen.push(label(e) + (e.reason ? `:${e.reason}` : ""));
      const allowed = next(c, s).find((t) => t.action === e.action && t.bot === e.bot
        && (e.ok === undefined || t.ok === e.ok) && (e.reason === undefined || t.state.told[e.bot] === e.reason));
      if (!compare && !allowed) return seen;
      expect(allowed, `the model does not allow ${label(e)} here; ${where()}`).toBeDefined();
      s = allowed!.state;
    }
    if (crashed) {
      seen.push("Crash");
      s = next(c, s).find((t) => t.action === "Crash")!.state;
    } else if (compare) {
      // Recovery that ends must leave nothing the model still owes.
      expect(next(c, s).filter((t) => RECOVERY_ACTIONS.includes(t.action)).map(label), where()).toEqual([]);
    }
    check();
  }
  return seen;
}

/** Replays trace lines through the reference; the steps no line records (Start, Finish, Crash, Expire) may fall between. */
function replay(lines: RestartTraceStep[]) {
  const hidden = new Set(["Start", "Finish", "Crash", "Expire"]);
  const close = (from: RestartState[]) => {
    const found = new Map(from.map((s) => [JSON.stringify(s), s]));
    for (const s of found.values()) {
      for (const t of next(c, s)) if (hidden.has(t.action) && !found.has(JSON.stringify(t.state))) found.set(JSON.stringify(t.state), t.state);
    }
    return [...found.values()];
  };
  const fits = (t: RestartStep, line: RestartTraceStep) => t.action === line.action
    && (line.bot === undefined || t.bot === line.bot) && (line.part === undefined || t.part === line.part)
    && (line.ok === undefined || t.ok === line.ok) && (line.reason === undefined || t.state.told[line.bot!] === line.reason)
    && (!line.journal || (t.state.phase === line.journal.phase
      && c.bots.every((b) => t.state.entry[b] === (line.journal!.entry[b] ?? "absent") && t.state.blk[b] === (line.journal!.blk[b] ?? "none"))));
  let now = close([init(c)]);
  lines.forEach((line, i) => {
    const after = now.flatMap((s) => next(c, s).filter((t) => fits(t, line)).map((t) => t.state));
    expect(after.length, `trace line ${i + 1} (${line.action} ${JSON.stringify(line)}) is not a step the model allows`).toBeGreaterThan(0);
    now = close(after);
  });
}

// Real bug: recover() marks an entry blocked on disk before it calls notice(), so a crash in between leaves the
// bot held back and never told (nor its session identity retained); the model tells first. Until it is fixed:
const fixed = it.fails;

describe("restart continuation", () => {
  fixed(`conforms to the model along ${WALKS} random walks`, async () => {
    const counts = new Map<string, number>();
    for (let seed = 1; seed <= WALKS; seed++) {
      const seen = await walk(seed, restartDriver({ bots: c.bots, plugins: c.plugins, dataDir: scratch("walk") }));
      for (const step of seen) { const name = step.replace(/[(:[].*/, ""); counts.set(name, (counts.get(name) ?? 0) + 1); }
    }
    // The walks reach every action of the model, crashes in each part included.
    for (const action of ["Start", "Finish", "Prepare", "Cancel", "BeginShutdown", "Settle", "Ready", "Crash", "Expire", "Boot", "Notice", "Block", "Claim", "Deliver", "Dispatch"]) {
      expect(counts.get(action) ?? 0, action).toBeGreaterThan(0);
    }
  });

  fixed("every step the app traces is one the model allows", async () => {
    let lines = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const dir = scratch("trace");
      process.env.BOTLING_SPEC_TRACE = join(dir, "trace");
      await walk(seed, restartDriver({ bots: c.bots, plugins: c.plugins, dataDir: dir }), false);
      delete process.env.BOTLING_SPEC_TRACE;
      let raw = "";
      try { raw = readFileSync(join(dir, "trace", "restart.jsonl"), "utf8"); } catch { continue; }
      const steps = raw.trim().split("\n").map((line) => restartTraceStep(JSON.parse(line)));
      lines += steps.length;
      replay(steps);
    }
    expect(lines).toBeGreaterThan(100);
  });

  it("another participant's failed shutdown does not hold a clean bot back (d678d161)", async () => {
    const driver = restartDriver({ bots: c.bots, plugins: c.plugins, dataDir: scratch("d678d161") });
    driver.start("b1", false);
    driver.prepare();
    driver.beginShutdown();
    driver.settle("b1", true); driver.settle("b2", false); driver.settle("b3", true); driver.settle("plugins", false);
    await driver.ready();
    driver.boot({ fail: [] });
    expect(driver.observe()).toMatchObject({ phase: "ready", entry: { b1: "dispatched" }, sent: { b1: 1 }, told: { b1: "none" } });
  });

  fixed("a crash right after recovery holds a bot back still leaves it told why", async () => {
    const driver = restartDriver({ bots: c.bots, plugins: c.plugins, dataDir: scratch("told") });
    driver.start("b1", true);
    driver.prepare();
    driver.beginShutdown();
    for (const part of [...c.bots, c.plugins]) driver.settle(part, true);
    await driver.ready();
    driver.boot({ fail: [], crashAfter: 1 });
    driver.boot({ fail: [] });
    expect(driver.observe()).toMatchObject({ entry: { b1: "blocked" }, told: { b1: "own" } });
  });
});
