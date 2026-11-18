// Conformance of the real ClaudeWorkerAdapter (a Claude worker's process) with spec/models/worker/WorkerProcess.tla,
// through spec/driver/worker-process-driver.ts and its adapter: seeded random walks over the reference's enabled
// actions (runs, steers, results, the keep-alive, background work starting, ending and turning 6 hours old, the
// process exiting with or without leftovers, tree checks answering, late ones of earlier processes too, stops, the
// app's close; Monitors starting, ending and running past their cap, reports kept for them, wake turns, the grace,
// failed turns, API errors that pass and the retry); after every step the app's view must equal the reference's and
// the model's properties must hold. The reference explored like TLC breaks the properties only with the model's bugs.
// SPEC_BUG=worker-sleep (before 95fcab3a), worker-bg (no background rule), worker-stale (before ebfa0da4),
// worker-cutoff (before 0ea2a290), worker-monexit (no report at the process's end), worker-droperr or worker-rehold
// (before monitor-fix2) turns on the reference's bug: the walks must go red.
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
const act = (type: string, arg?: boolean): Action =>
  (arg === undefined ? { type } : type === "Result" || type === "TreeChecked" ? { type, ok: arg } : { type, tree: arg }) as Action;

async function apply(s: WorkerProcessSession, a: Action) {
  switch (a.type) {
    case "Start": return s.start();
    case "Steer": return s.steer();
    case "Result": return s.result(a.ok);
    case "ApiError": return s.apiError();
    case "RetryFires": return s.retryFires();
    case "WakeTurn": return s.wakeTurn();
    case "KeepAliveFires": return s.keepAliveFires();
    case "BgStart": return s.bgStart();
    case "BgEnd": return s.bgEnd();
    case "Age": return s.age();
    case "MonStart": return s.monStart();
    case "MonEnd": return s.monEnd();
    case "OldEnd": return s.oldEnd();
    case "MonExpire": return s.monExpire();
    case "GraceFires": return s.graceFires();
    case "ProcExit": return s.procExit(a.tree);
    case "TreeChecked": return s.treeChecked(a.ok);
    case "OlderChecked": return s.olderChecked();
    case "TreeGone": return s.treeGone();
    case "Stop": return s.stop(a.tree);
    case "AppClose": return s.appClose(a.tree);
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
  if (s.hold === "none" && n.hold !== "none") out.push("report kept for a Monitor");
  if (a.type === "WakeTurn") out.push("wake turn");
  if (a.type === "Result" && a.ok && s.hold !== "none" && n.run === "idle") out.push("wake turn's result: the report of every turn");
  if (a.type === "Result" && !a.ok && s.hold !== "none") out.push("failed turn ends a run whose report is kept: its words with the error");
  if (a.type === "GraceFires" && n.hold === "none") out.push("grace runs out: the kept report goes");
  if (a.type === "MonExpire" && s.hold === "cap" && n.hold === "none") out.push("Monitor past its cap: the kept report goes");
  if (a.type === "MonExpire" && s.hold === "cap" && n.hold === "grace") out.push("Monitor past its cap during a turn: the grace");
  if (a.type === "Result" && a.ok && s.capped && s.mon > 0) out.push("after a cap, the turn's result ends the run though a Monitor lives");
  if (a.type === "ProcExit" && s.hold !== "none") out.push("process end sends the kept report");
  if ((a.type === "Stop" || a.type === "AppClose") && s.hold !== "none") out.push("kept report stopped or cut off");
  if (a.type === "ApiError" && n.retry && s.hold !== "none") out.push("API error under a kept report: its words carried over the retry");
  if (a.type === "ApiError" && n.retry && s.hold === "none") out.push("API error: the run waits to try again");
  if (a.type === "ApiError" && s.tried && s.kept > 0) out.push("every try failed: the words kept go with the error");
  if (a.type === "RetryFires") out.push("the retry's wait is over");
  if (a.type === "Steer" && s.retry) out.push("steer in place of a retry");
  if (a.type === "Result" && s.retry) out.push("a turn's result while a retry waits");
  return out;
}

/** Plays `script` on the app and the reference side by side: the view after every step must equal the reference's. */
async function play(cfg: Config, script: Action[]) {
  const session = await workerProcessDriver.open();
  let state = init(cfg);
  try {
    for (const a of script) {
      const next = step(state, cfg, a);
      expect([...violations(next), ...stepViolations(state, next)], label(a)).toEqual([]);
      await apply(session, a);
      state = next;
      expect(session.view(), label(a)).toEqual(view(state));
    }
    return session.view();
  } finally {
    await session.close();
  }
}

async function walk(cfg: Config, seed: number, length: number, seen: Set<string>) {
  const next = random(seed);
  const session = await workerProcessDriver.open();
  let state: State = init(cfg);
  const steps: string[] = [];
  try {
    for (let i = 0; i < length; i++) {
      // The app's close ends what a walk can do: only as its last step (the cases below close mid-run).
      const choices = actions(state, cfg).filter((a) => a.type !== "AppClose" || i === length - 1);
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
  const cfg: Config = { maxWords: 8, maxBg: 2, maxWakes: 3 };
  const WALKS = 300;

  it(`${WALKS} random walks of 40 steps: the app's process, words and timers equal the model's after every step`, async () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= WALKS; seed++) await walk(cfg, seed, 40, seen);
    expect([...seen].sort()).toEqual([
      "API error under a kept report: its words carried over the retry", "API error: the run waits to try again",
      "Monitor past its cap during a turn: the grace", "Monitor past its cap: the kept report goes",
      "a turn's result while a retry waits", "after a cap, the turn's result ends the run though a Monitor lives",
      "background keeps the process awake", "background turns old", "every try failed: the words kept go with the error",
      "failed turn ends a run whose report is kept: its words with the error",
      "grace runs out: the kept report goes", "held run fails: leftovers", "held run stopped",
      "held words go into a new process", "input closed", "kept report stopped or cut off", "late check of an earlier process, run held",
      "process end sends the kept report", "report kept for a Monitor", "run held for a closing process", "spawn refused: leftovers",
      "steer in place of a retry", "steer joins held words", "the retry's wait is over", "wake turn",
      "wake turn's result: the report of every turn",
    ]);
  }, 120_000);

  it("TLC's counterexample for WorkerProcess_bug_stale.cfg: a late check of an earlier process leaves the held run alone", async () => {
    const end = await play(cfg, [
      act("Start"), act("ProcExit", false), act("Start"), act("Result", true), act("KeepAliveFires"),
      act("Start"), act("OlderChecked"), act("ProcExit", false), act("TreeChecked", true),
    ]);
    expect(end).toMatchObject({ run: "working", read: 3, failed: 0 });
  });

  it("TLC's counterexample for WorkerProcess_bug_cutoff.cfg: the wake turn outlasts the grace, its result ends the run with both turns' words", async () => {
    const script = [act("Start"), act("MonStart"), act("Result", true), act("MonEnd"), act("WakeTurn"), act("GraceFires")];
    const held = await play(cfg, script);
    expect(held).toMatchObject({ run: "working", hold: "grace", turn: true, kept: 1, reports: 0 });
    expect(await play(cfg, [...script, act("Result", true)])).toMatchObject({ run: "idle", hold: "none", outcome: "report", told: 2, dropped: 0, reports: 1 });
  });

  it("TLC's counterexample for WorkerProcess_bug_monexit.cfg: the process's end sends the kept report", async () => {
    expect(await play(cfg, [act("Start"), act("MonStart"), act("Result", true), act("ProcExit", false)]))
      .toMatchObject({ run: "idle", outcome: "report", told: 1, dropped: 0, reports: 1 });
  });

  it("a report kept for a Monitor: the run stays at work; with the Monitor past its cap it goes; a failed turn is not kept", async () => {
    expect(await play(cfg, [act("Start"), act("MonStart"), act("Result", true)])).toMatchObject({ run: "working", hold: "cap", kept: 1, reports: 0 });
    expect(await play(cfg, [act("Start"), act("MonStart"), act("Result", true), act("MonExpire")]))
      .toMatchObject({ run: "idle", hold: "none", outcome: "report", told: 1, mon: 0, old: 1, keep: true });
    expect(await play(cfg, [act("Start"), act("MonStart"), act("MonExpire"), act("Result", true)])).toMatchObject({ run: "idle", outcome: "report", told: 1 });
    expect(await play(cfg, [act("Start"), act("MonStart"), act("Result", false)])).toMatchObject({ run: "idle", hold: "none", outcome: "error", said: 0 });
  });

  it("TLC's counterexample for WorkerProcess_bug_droperr.cfg: a failed wake turn says the kept report with its error", async () => {
    const kept = [act("Start"), act("MonStart"), act("Result", true), act("WakeTurn")];
    expect(await play(cfg, [...kept, act("Result", false)]))
      .toMatchObject({ run: "idle", hold: "none", outcome: "error", said: 1, told: 1, dropped: 0, reports: 1 });
  });

  it("an API error under a kept report: its words carried over the retry, then out with the retry's report, the error or the process's end", async () => {
    const retry = [act("Start"), act("MonStart"), act("Result", true), act("WakeTurn"), act("ApiError")];
    expect(await play(cfg, retry)).toMatchObject({ run: "working", hold: "none", retry: true, tried: true, kept: 1, told: 0, reports: 0 });
    expect(await play(cfg, [...retry, act("RetryFires"), act("MonEnd"), act("Result", true)]))
      .toMatchObject({ run: "idle", outcome: "report", retry: false, tried: false, told: 2, dropped: 0, reports: 1 });
    expect(await play(cfg, [...retry, act("RetryFires"), act("ApiError")])).toMatchObject({ run: "idle", outcome: "error", told: 1, dropped: 0 });
    expect(await play(cfg, [...retry, act("ProcExit", false)])).toMatchObject({ run: "idle", outcome: "exited", told: 1, dropped: 0 });
    // A Monitor's wake turn ends well before the try: it is kept again, and no try follows it.
    expect(await play(cfg, [...retry, act("Result", true)])).toMatchObject({ run: "working", hold: "cap", retry: false, tried: false, kept: 2 });
    expect(await play(cfg, [...retry, act("Stop", false)])).toMatchObject({ run: "idle", outcome: "stopped", told: 0, dropped: 1 });
  });

  it("TLC's counterexample for WorkerProcess_bug_rehold.cfg: after the oldest Monitor's cap, a newer Monitor keeps nothing", async () => {
    const capped = [act("Start"), act("MonStart"), act("Result", true), act("WakeTurn"), act("MonExpire"), act("MonStart")];
    expect(await play(cfg, capped)).toMatchObject({ run: "working", hold: "grace", capped: true, turn: true, mon: 1, kept: 1 });
    expect(await play(cfg, [...capped, act("Result", true)])).toMatchObject({ run: "idle", hold: "none", outcome: "report", told: 2, reports: 1 });
    // Two Monitors from the start: the older one's cap during the wake turn lets the report go, the newer one lives on.
    const two = [act("Start"), act("MonStart"), act("MonStart"), act("Result", true), act("WakeTurn"), act("MonExpire")];
    expect(await play(cfg, two)).toMatchObject({ run: "working", hold: "grace", capped: true, mon: 1, old: 1 });
    expect(await play(cfg, [...two, act("Result", true)])).toMatchObject({ run: "idle", outcome: "report", told: 2, mon: 1 });
    // Not after an API retry either.
    expect(await play(cfg, [...two, act("ApiError"), act("RetryFires"), act("Result", true)]))
      .toMatchObject({ run: "idle", outcome: "report", told: 2, capped: false, mon: 1 });
  });

  it("the app's close with a report kept: the run is interrupted, the report is not sent", async () => {
    expect(await play(cfg, [act("Start"), act("MonStart"), act("Result", true), act("AppClose", false)]))
      .toMatchObject({ run: "idle", hold: "none", outcome: "interrupted", told: 0, dropped: 1, reports: 1, closed: true });
  });
});

describe("worker process model: the reference explored like TLC", () => {
  /** TLC's distinct states for WorkerProcess.tla with MaxWords = 3, MaxBg = 2, MaxWakes = 1 (2026-11-18, monitor-fix2). */
  const STATES_3_2_1 = 22_383;

  /** Every reachable state (breadth first); the first broken property with the path to it, or null. */
  function explore(cfg: Config): { states: number; broken: string | null } {
    const key = (s: State) => JSON.stringify(s);
    const from = new Map<string, { parent: string; a: Action } | null>([[key(init(cfg)), null]]);
    const path = (k: string, last: Action) => {
      const out = [label(last)];
      for (let at = from.get(k); at; at = from.get(at.parent)) out.unshift(label(at.a));
      return out.join(" → ");
    };
    const queue: State[] = [init(cfg)];
    for (let i = 0; i < queue.length; i++) {
      const s = queue[i]!;
      const k = key(s);
      for (const a of actions(s, cfg)) {
        const n = step(s, cfg, a);
        const broken = [...violations(n), ...stepViolations(s, n)];
        if (broken.length) return { states: from.size, broken: `${broken.join(", ")} after ${path(k, a)}` };
        const nk = key(n);
        if (!from.has(nk)) { from.set(nk, { parent: k, a }); queue.push(n); }
      }
    }
    return { states: from.size, broken: null };
  }

  it("holds every invariant and action property without a bug (as many states as TLC finds with these bounds)", () => {
    const result = explore({ maxWords: 3, maxBg: 2, maxWakes: 1, bug: "none" });
    expect(result.broken).toBeNull();
    expect(result.states).toBe(STATES_3_2_1);
  });

  it.each([
    ["sleep", "NoWordLost", 0], ["bg", "NoSleepWithBackground", 1], ["stale", "HeldFailsOnlyForLeftovers", 1],
    ["cutoff", "TurnNotCutOff", 1], ["monexit", "KeptIsReported", 1], ["droperr", "DroppedOnlyCutOff", 1], ["rehold", "CapLetsGoOnce", 2],
  ] as [Bug, string, number][])(
    "with bug %s breaks %s", (bug, property, maxBg) => {
      expect(explore({ maxWords: 3, maxBg, maxWakes: 1, bug }).broken).toContain(property);
    });
});
