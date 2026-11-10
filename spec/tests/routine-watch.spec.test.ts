// Watch routines against spec/models/routines/RoutineWatch.tla: seeded random walks over the reference's enabled
// actions drive a real Bot whose watch's command is a real shell script (through spec/driver/routine-watch-driver.ts
// and its adapter), written both ways (app_routines kind=watch, and a "Name: !command" line in routines.cron); after
// every step the app's view must equal the reference's and the model's properties must hold. A tick is two hours, so
// the model's cooldown of three ticks is the app's 6 hours. The reference explored like TLC breaks the properties only
// with the model's bugs. SPEC_BUG=watch-storm, watch-rearm or watch-orphan turns a bug on: the walks must go red.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routineWatchAdapter } from "../../desktop/spec-adapters/routine-watch-adapter";
import type { RoutineWatchSession } from "../driver/routine-watch-driver";
import { actions, init, step, stepViolations, view, violations, type Action, type Bug, type Config, type State } from "../reference/routine-watch";

const TICK_MS = 2 * 3600_000;
const CFG: Config = { maxTime: 7, rewake: 3, maxCrash: 2 };

function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const label = (a: Action) => (a.type === "Finish" ? `Finish(${a.r})` : a.type);

async function apply(s: RoutineWatchSession, a: Action) {
  switch (a.type) {
    case "Tick": return s.tick();
    case "Due": return s.due();
    case "Finish": return s.finish(a.r);
    case "OrphanEnds": return s.orphanEnds();
    case "Crash": return s.crash();
    case "Boot": return s.boot();
  }
}

function reached(s: State, n: State, a: Action): string[] {
  const out: string[] = [];
  if (a.type === "Due" && s.running) out.push("due while running: skipped");
  if (a.type === "Finish" && a.r === "fail" && n.woken > s.woken && s.last !== "fail") out.push("first failure wakes");
  if (a.type === "Finish" && a.r === "fail" && n.woken === s.woken) out.push("failure in cooldown: quiet");
  if (a.type === "Finish" && a.r === "fail" && n.woken > s.woken && s.last === "fail") out.push("woken again after cooldown");
  if (a.type === "Finish" && a.r === "fail" && s.last === "pass" && s.lastWake !== -1 && s.now - s.lastWake < CFG.rewake) out.push("pass re-arms within cooldown");
  if (a.type === "Crash" && s.running) out.push("crash mid-run");
  if (a.type === "Boot" && s.orphan) out.push("start ends what a crash left");
  if (a.type === "Boot" && s.disk.state === "failing") out.push("restart keeps a failing streak");
  return out;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });

async function walk(form: "scheduled" | "legacy", seed: number, length: number, seen: Set<string>) {
  const next = random(seed);
  const session = await routineWatchAdapter.open({ form, tickMs: TICK_MS, setClock: (ms) => vi.setSystemTime(ms) });
  let state = init(CFG);
  const steps: string[] = [];
  try {
    for (let i = 0; i < length; i++) {
      const choices = actions(state, CFG);
      if (!choices.length) break;
      const kinds = [...new Set(choices.map((a) => a.type))];
      const kind = kinds[Math.floor(next() * kinds.length)]!;
      const of = choices.filter((a) => a.type === kind);
      const a = of[Math.floor(next() * of.length)]!;
      const after = step(state, CFG, a);
      steps.push(label(a));
      const where = `${form}, seed ${seed}, step ${i + 1}: ${steps.join(" → ")}`;
      expect([...violations(after), ...stepViolations(state, after, CFG)], `model properties broken at ${where}`).toEqual([]);
      for (const what of reached(state, after, a)) seen.add(what);
      await apply(session, a);
      state = after;
      expect(session.view(), `the app at ${where}`).toEqual(view(state));
    }
  } finally {
    await session.close();
  }
}

describe.each(["scheduled", "legacy"] as const)("watch routine model: conformance (%s)", (form) => {
  const WALKS = 25;
  it(`${WALKS} random walks of 30 steps: the app's runs, bot.json and wakes equal the model's after every step`, async () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= WALKS; seed++) await walk(form, seed + (form === "legacy" ? 500 : 0), 30, seen);
    expect([...seen].sort()).toEqual(expect.arrayContaining([
      "crash mid-run", "due while running: skipped", "failure in cooldown: quiet", "first failure wakes", "restart keeps a failing streak",
      "start ends what a crash left", "woken again after cooldown",
    ]));
  }, 120_000);
});

describe("watch routine model: TLC's counterexample for RoutineWatch_bug_orphan.cfg", () => {
  it("a run cut off by a crash is ended by the next start, so the next run does not start beside it", async () => {
    const session = await routineWatchAdapter.open({ form: "scheduled", tickMs: TICK_MS, setClock: (ms) => vi.setSystemTime(ms) });
    let state = init(CFG);
    try {
      for (const a of [{ type: "Due" }, { type: "Tick" }, { type: "Crash" }, { type: "Boot" }, { type: "Due" }, { type: "Finish", r: "fail" }] as Action[]) {
        state = step(state, CFG, a);
        await apply(session, a);
        expect(session.view(), label(a)).toEqual(view(state));
      }
      expect(session.view()).toMatchObject({ orphan: false, woken: 1, disk: { state: "failing", wokeAt: 1 } });
    } finally {
      await session.close();
    }
  }, 30_000);
});

describe("watch routine model: the reference explored like TLC", () => {
  /** Every reachable state (breadth first); the first broken property (only `only`, if named) with the path to it. */
  function explore(cfg: Config, only?: string): { states: number; broken: string | null } {
    const key = (s: State) => JSON.stringify(s);
    const seen = new Set([key(init(cfg))]);
    const queue: { s: State; path: string[] }[] = [{ s: init(cfg), path: [] }];
    while (queue.length) {
      const { s, path } = queue.shift()!;
      for (const a of actions(s, cfg)) {
        const n = step(s, cfg, a);
        const broken = [...violations(n), ...stepViolations(s, n, cfg)].filter((p) => !only || p === only);
        if (broken.length) return { states: seen.size, broken: `${broken.join(", ")} after ${[...path, label(a)].join(" → ")}` };
        if (!seen.has(key(n))) { seen.add(key(n)); queue.push({ s: n, path: [...path, label(a)] }); }
      }
    }
    return { states: seen.size, broken: null };
  }

  it("holds every invariant and action property without a bug", () => {
    const result = explore({ ...CFG, bug: "none" });
    expect(result.broken).toBeNull();
    expect(result.states).toBeGreaterThan(5_000);
  });

  it.each([["storm", "QuietInCooldown"], ["rearm", "FirstFailureWakes"], ["orphan", "NoOverlap"]] as [Bug, string][])("with bug %s breaks %s", (bug, property) => {
    expect(explore({ maxTime: 3, rewake: 3, maxCrash: 1, bug }, property).broken).toContain(property);
  });
});
