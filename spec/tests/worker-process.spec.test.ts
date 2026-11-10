// Conformance of the real ClaudeWorkerAdapter (a Claude worker's process) with spec/models/worker/WorkerProcess.tla,
// through spec/driver/worker-process-driver.ts and its adapter: seeded random walks over the reference's enabled
// actions (runs, steers, results, the keep-alive, background work starting, ending and turning 6 hours old, the
// process exiting with or without leftovers, tree checks answering, late ones of earlier processes too, stops); after
// every step the app's view must equal the reference's and the model's properties must hold. The reference explored
// like TLC breaks the properties only with the model's bugs.
// SPEC_BUG=worker-sleep (before 95fcab3a), worker-bg (no background rule) or worker-stale (before ebfa0da4) turns on
// the reference's bug: the walks must go red.
import { describe, expect, it } from "vitest";
import { workerProcessDriver } from "../../desktop/spec-adapters/worker-process-adapter";
import type { WorkerProcessSession } from "../driver/worker-process-driver";
import { actions, init, step, stepViolations, view, violations, type Action, type Bug, type Config, type State } from "../reference/worker-process";

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

const label = (a: Action) => `${a.type}${"ok" in a ? `(${a.ok})` : "tree" in a ? `(${a.tree})` : ""}`;

async function apply(s: WorkerProcessSession, a: Action) {
  switch (a.type) {
    case "Start": return s.start();
    case "Steer": return s.steer();
    case "Result": return s.result();
    case "KeepAliveFires": return s.keepAliveFires();
    case "BgStart": return s.bgStart();
    case "BgEnd": return s.bgEnd();
    case "Age": return s.age();
    case "ProcExit": return s.procExit(a.tree);
    case "TreeChecked": return s.treeChecked(a.ok);
    case "OlderChecked": return s.olderChecked();
    case "TreeGone": return s.treeGone();
    case "Stop": return s.stop(a.tree);
  }
}

/** What a step reached that a walk should cover. */
function reached(s: State, n: State, a: Action): string[] {
  const out: string[] = [];
  if (s.run !== "held" && n.run === "held") out.push("run held for a closing process");
  if (a.type === "Steer" && s.run === "held") out.push("steer joins held words");
  if (s.run === "held" && n.run === "working") out.push("held words go into a new process");
  if (s.run === "held" && n.run === "idle" && n.failed > s.failed) out.push("held run fails: leftovers");
  if (a.type === "Start" && n.failed > s.failed) out.push("spawn refused: leftovers");
  if (a.type === "KeepAliveFires" && n.keep) out.push("background keeps the process awake");
  if (a.type === "KeepAliveFires" && n.proc === "closed" && s.proc === "open") out.push("input closed");
  if (a.type === "Age") out.push("background turns old");
  if (a.type === "OlderChecked" && s.run === "held") out.push("late check of an earlier process, run held");
  if (a.type === "Stop" && s.run === "held") out.push("held run stopped");
  return out;
}

async function walk(cfg: Config, seed: number, length: number, seen: Set<string>) {
  const next = random(seed);
  const session = await workerProcessDriver.open();
  let state: State = init(cfg);
  const steps: string[] = [];
  try {
    for (let i = 0; i < length; i++) {
      const choices = actions(state, cfg);
      if (!choices.length) break;
      // A kind of action first (each as likely), then one of its variants.
      const kinds = [...new Set(choices.map((a) => a.type))];
      const kind = kinds[Math.floor(next() * kinds.length)]!;
      const of = choices.filter((a) => a.type === kind);
      const a = of[Math.floor(next() * of.length)]!;
      const after = step(state, cfg, a);
      steps.push(label(a));
      const where = `seed ${seed}, step ${i + 1}: ${steps.join(" → ")}`;
      expect([...violations(after), ...stepViolations(state, after)], `model properties broken at ${where}`).toEqual([]);
      for (const what of reached(state, after, a)) seen.add(what);
      await apply(session, a);
      state = after;
      expect(session.view(), `the app at ${where}`).toEqual(view(state));
    }
  } finally {
    await session.close();
  }
}

describe("worker process model: conformance", () => {
  const cfg: Config = { maxWords: 8, maxBg: 2 };
  const WALKS = 300;

  it(`${WALKS} random walks of 40 steps: the app's process, words and timers equal the model's after every step`, async () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= WALKS; seed++) await walk(cfg, seed, 40, seen);
    expect([...seen].sort()).toEqual([
      "background keeps the process awake", "background turns old", "held run fails: leftovers", "held run stopped",
      "held words go into a new process", "input closed", "late check of an earlier process, run held",
      "run held for a closing process", "spawn refused: leftovers", "steer joins held words",
    ]);
  }, 120_000);

  it("TLC's counterexample for WorkerProcess_bug_stale.cfg: a late check of an earlier process leaves the held run alone", async () => {
    const session = await workerProcessDriver.open();
    let state = init(cfg);
    try {
      for (const a of [
        { type: "Start" }, { type: "ProcExit", tree: false }, { type: "Start" }, { type: "Result" }, { type: "KeepAliveFires" },
        { type: "Start" }, { type: "OlderChecked" }, { type: "ProcExit", tree: false }, { type: "TreeChecked", ok: true },
      ] as Action[]) {
        state = step(state, cfg, a);
        await apply(session, a);
        expect(session.view(), label(a)).toEqual(view(state));
      }
      expect(session.view()).toMatchObject({ run: "working", read: 3, failed: 0 });
    } finally {
      await session.close();
    }
  });
});

describe("worker process model: the reference explored like TLC", () => {
  /** Every reachable state (breadth first); the first broken property with the path to it, or null. */
  function explore(cfg: Config): { states: number; broken: string | null } {
    const key = (s: State) => JSON.stringify(s);
    const seen = new Set([key(init(cfg))]);
    const queue: { s: State; path: string[] }[] = [{ s: init(cfg), path: [] }];
    while (queue.length) {
      const { s, path } = queue.shift()!;
      for (const a of actions(s, cfg)) {
        const n = step(s, cfg, a);
        const broken = [...violations(n), ...stepViolations(s, n)];
        if (broken.length) return { states: seen.size, broken: `${broken.join(", ")} after ${[...path, label(a)].join(" → ")}` };
        if (!seen.has(key(n))) { seen.add(key(n)); queue.push({ s: n, path: [...path, label(a)] }); }
      }
    }
    return { states: seen.size, broken: null };
  }

  it("holds every invariant and action property without a bug", () => {
    const result = explore({ maxWords: 5, maxBg: 2, bug: "none" });
    expect(result.broken).toBeNull();
    expect(result.states).toBeGreaterThan(500);
  });

  it.each([["sleep", "NoWordLost"], ["bg", "NoSleepWithBackground"], ["stale", "HeldFailsOnlyForLeftovers"]] as [Bug, string][])(
    "with bug %s breaks %s", (bug, property) => {
      expect(explore({ maxWords: 3, maxBg: 1, bug }).broken).toContain(property);
    });
});
