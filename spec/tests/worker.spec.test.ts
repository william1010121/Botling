// Conformance of the real WorkerCore with spec/models/worker (through spec/driver/worker-driver.ts and its adapter):
//   (a) seeded random walks over the reference's enabled actions, two workers at once, with the operations that race
//       (stop and cancel while a start, stop or recovery is awaited; a crash mid-operation; report turns) in every
//       order the model allows; after every step the app's record, chip, lock, engine and port must equal the
//       reference's, and the model's properties must hold;
//   (b) the same walks with BOTLING_SPEC_TRACE set: the app's own trace lines replayed through the reference, each an
//       allowed step.
// A run's output is a recorded claude stream (spec/fixtures/worker-streams/claude, copied from the contract suite's
// recordings): "done" is a run with a failed tool and a reply (the false-Failed class), "failed" a SIGKILLed process.
// SPEC_BUG=worker turns on the reference's bug switch (3910341f's race): both parts must go red.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workerDriver } from "../../desktop/spec-adapters/worker-adapter";
import type { WorkerSession, WorkerStreams, WorkerView } from "../driver/worker-driver";
import { chip, enabled, init, maxShows, step, violations, type Ack, type Action, type Config, type Rec, type State } from "../reference/worker";

const recording = (name: string) =>
  readFileSync(join(__dirname, "..", "fixtures", "worker-streams", "claude", `${name}.jsonl`), "utf8").trim().split("\n").slice(1)
    .map((line) => JSON.parse(line) as { d: string; l: string }).filter((line) => line.d === "out").map((line) => line.l);
const streams: WorkerStreams = { done: recording("failed-tool-then-success"), failed: recording("process-exit") };

/** mulberry32: a small seeded generator, so a failing walk can be replayed from its seed. */
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

const label = (a: Action) => `${a.type}${"w" in a ? `(w${a.w}${"ok" in a ? `, ${a.ok}` : ""}${"v" in a ? `, ${a.v}` : ""}${"how" in a ? `, ${a.how}` : ""}${"completed" in a ? `, ${a.completed}` : ""})` : ""}`;

async function apply(s: WorkerSession, a: Action) {
  switch (a.type) {
    case "Handoff": return s.handoff(a.w);
    case "StartDone": return s.startDone(a.w);
    case "Send": return s.send(a.w);
    case "Steer": return s.steer(a.w);
    case "RecoverDone": return s.recoverDone(a.w);
    case "StopWorker": return s.stopWorker(a.w);
    case "Cancel": return s.cancel(a.w);
    case "StopDone": return s.stopDone(a.w, a.ok);
    case "End": return s.end(a.w, a.v);
    case "Exit": return s.exit(a.w);
    case "Deliver": return s.deliver(a.w, a.how);
    case "BeginReport": return s.beginReport(a.w);
    case "FinishReport": return s.finishReport(a.w, a.completed);
    case "RetryUncertain": return s.retryUncertain(a.w);
    case "Checkpoint": return s.checkpoint(a.w);
    case "SetOwner": return s.setOwner(a.w);
    case "Crash": return s.crash();
  }
}

/** What the app must show for a reference record (`shown`: the coordinator's sightings of this run's report). */
const expected = (r: Rec, shown: number): WorkerView => ({
  status: r.status, run: r.run, report: r.rep, attempts: r.tries, cleanup: r.cleanup, recovery: r.recovery, owned: r.owned,
  chip: chip(r), busy: r.op !== "idle", stale: r.stale, shown,
});

interface Walk { seed: number; steps: string[]; queuedOnNewerRun: number; concurrent: number }

/** One walk: `length` steps chosen from the reference's enabled actions, the app checked after each (unless `check` is false). */
async function walk(cfg: Config, seed: number, length: number, check = true): Promise<Walk> {
  const next = random(seed);
  const session = await workerDriver.open({ ack: cfg.ack, streams });
  const result: Walk = { seed, steps: [], queuedOnNewerRun: 0, concurrent: 0 };
  let state: State = init(cfg);
  const shown = state.wk.map(() => ({ run: 0, n: 0 }));
  try {
    for (let i = 0; i < length; i++) {
      const choices = enabled(state, cfg);
      if (!choices.length) break;
      const a = choices[Math.floor(next() * choices.length)]!;
      const after = step(state, a, cfg)!;
      result.steps.push(label(a));
      const where = `seed ${seed}, step ${i + 1}: ${result.steps.join(" → ")}`;
      if (check) expect(violations(state, after, cfg), `model properties broken at ${where}`).toEqual([]);
      if ("w" in a) {
        const r = state.wk[a.w]!;
        if (r.pend.kind !== "none" && after.wk[a.w]!.pend.kind === "none" && after.crashes === state.crashes && r.pend.target !== after.wk[a.w]!.run) result.queuedOnNewerRun += 1;
        if ((a.type === "StopWorker" || a.type === "Cancel") && r.op !== "idle") result.concurrent += 1;
        if ((a.type === "Deliver" && a.how === "taken") || a.type === "BeginReport") {
          if (shown[a.w]!.run !== r.run) shown[a.w] = { run: r.run, n: 0 };
          shown[a.w]!.n += 1;
        }
      }
      state = after;
      await apply(session, a);
      if (check) state.wk.forEach((r, w) => {
        const view = session.view(w);
        if (r.status === "new") { expect(view, `worker ${w} exists before its handoff at ${where}`).toBeNull(); return; }
        expect(view, `worker ${w} at ${where}`).toEqual(expected(r, shown[w]!.run === r.run ? shown[w]!.n : 0));
        // The properties, read off the app itself.
        expect(view!.shown).toBeLessThanOrEqual(maxShows(cfg));
        if (view!.status === "done" && view!.chip !== "completed") expect(view!.cleanup === "failed" || view!.report === "unresolved", `false Failed at ${where}`).toBe(true);
        if (view!.status === "running") expect(view!.stale, `a run started beside a live process at ${where}`).toBe(false);
      });
    }
  } finally {
    await session.close();
  }
  return result;
}

const WALKS = 120;
const LENGTH = 40;

describe.each(["none", "checkpoint"] as Ack[])("worker model, coordinator ack %s", (ack) => {
  const cfg: Config = { workers: 2, maxRun: 3, maxCrash: 1, ack };

  it(`conformance: ${WALKS} random walks of ${LENGTH} steps, two workers, operations racing`, async () => {
    let queuedOnNewerRun = 0;
    let concurrent = 0;
    for (let seed = 1; seed <= WALKS; seed++) {
      const result = await walk(cfg, seed + (ack === "checkpoint" ? 10_000 : 0), LENGTH);
      queuedOnNewerRun += result.queuedOnNewerRun;
      concurrent += result.concurrent;
    }
    // The walks reach the interleavings the contract suite never played: a stop or cancel asked while an operation
    // holds the worker, and one that gets the worker only after a newer run started.
    expect(concurrent).toBeGreaterThan(20);
    expect(queuedOnNewerRun).toBeGreaterThan(0);
  }, 120_000);
});

describe("worker model: the interleaving 3910341f fixed (TLC's counterexample for Worker_bug.cfg)", () => {
  it("a cancel that waited for a recovery which started the next run leaves that run alone", async () => {
    const cfg: Config = { workers: 1, maxRun: 2, maxCrash: 1, ack: "none" };
    const session = await workerDriver.open({ ack: "none", streams });
    let state = init(cfg);
    try {
      for (const a of [
        { type: "Handoff", w: 0 }, { type: "Crash" }, { type: "Send", w: 0 }, { type: "Cancel", w: 0 }, { type: "Exit", w: 0 },
        { type: "RecoverDone", w: 0 }, { type: "StartDone", w: 0 },
      ] as Action[]) {
        state = step(state, a, cfg)!;
        await apply(session, a);
      }
      expect(session.view(0)).toMatchObject({ status: "running", run: 2, busy: false });
      expect(session.view(0)).toEqual(expected(state.wk[0]!, 0));
    } finally {
      await session.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------
// (b) Trace check

interface TraceLine { action: string; state: Record<string, unknown> & { id?: string; workers?: Record<string, unknown>[] } }
const FOLDED = new Set(["RunQueued", "Route"]);
const FIELDS = ["status", "run", "report", "attempts", "cleanup", "recovery", "owned"] as const;
const fieldsOf = (r: Rec) => ({ status: r.status, run: r.run, report: r.rep, attempts: r.tries, cleanup: r.cleanup, recovery: r.recovery, owned: r.owned });
const pick = (state: Record<string, unknown>) => Object.fromEntries(FIELDS.map((key) => [key, state[key]]));

/** The model action a trace line names (null: not one of the model's). */
function actionOf(line: TraceLine, w: number): Action | null {
  const s = line.state;
  switch (line.action) {
    case "Handoff": case "StartDone": case "Send": case "Steer": case "RecoverDone": case "StopWorker": case "Cancel":
    case "BeginReport": case "RetryUncertain": case "Checkpoint": case "SetOwner":
      return { type: line.action, w };
    case "StopDone": return { type: "StopDone", w, ok: s.ok === true };
    case "End": return s.v === "done" || s.v === "failed" ? { type: "End", w, v: s.v } : null;
    case "Deliver": return s.how === "taken" || s.how === "queued" ? { type: "Deliver", w, how: s.how } : null;
    case "FinishReport": return { type: "FinishReport", w, completed: s.completed === true };
    default: return null;
  }
}

/**
 * Replays the app's trace through the reference. A step and the lines its synchronous chain wrote after it
 * (RunQueued, Route: one step in the model) are checked as one; a process exit the core never sees (Exit) may come
 * before any step. Returns the first line that is not an allowed step, or null.
 */
function checkTrace(lines: TraceLine[], cfg: Config): string | null {
  const slots = new Map<string, number>();
  let state = init(cfg);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.action === "Crash") {
      const crashed = step(state, { type: "Crash" }, cfg);
      if (!crashed) return `line ${i + 1}: Crash not allowed`;
      state = crashed;
      for (const view of line.state.workers ?? []) {
        const w = slots.get(view.id as string);
        if (w === undefined || JSON.stringify(fieldsOf(state.wk[w]!)) !== JSON.stringify(pick(view))) return `line ${i + 1}: Crash leaves ${JSON.stringify(view)}, the model ${w === undefined ? "has no such worker" : JSON.stringify(fieldsOf(state.wk[w]!))}`;
      }
      continue;
    }
    const id = line.state.id!;
    if (!slots.has(id)) slots.set(id, slots.size);
    const w = slots.get(id)!;
    let last = line;
    while (i + 1 < lines.length && FOLDED.has(lines[i + 1]!.action) && lines[i + 1]!.state.id === id) last = lines[++i]!;
    const a = actionOf(line, w);
    if (!a) return `line ${i + 1}: ${line.action} is not an action of the model`;
    const want = JSON.stringify(pick(last.state));
    const direct = step(state, a, cfg);
    const exited = step(state, { type: "Exit", w }, cfg);
    const afterExit = exited && step(exited, a, cfg);
    const fits = [direct, afterExit].find((t) => t && JSON.stringify(fieldsOf(t.wk[w]!)) === want);
    if (!fits) return `line ${i + 1}: ${label(a)} gives ${want}; the model ${direct ? JSON.stringify(fieldsOf(direct.wk[w]!)) : "does not allow it"}`;
    const broken = violations(state, fits, cfg);
    if (broken.length) return `line ${i + 1}: ${label(a)} breaks ${broken.join(", ")}`;
    state = fits;
  }
  return null;
}

describe("worker model: trace check", () => {
  const dirs: string[] = [];
  afterEach(() => {
    delete process.env.BOTLING_SPEC_TRACE;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.each(["none", "checkpoint"] as Ack[])("the app's own trace lines (ack %s) are each an allowed step of the model", async (ack) => {
    const cfg: Config = { workers: 2, maxRun: 3, maxCrash: 1, ack };
    let lines = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const dir = mkdtempSync(join(tmpdir(), "spec-worker-trace-"));
      dirs.push(dir);
      process.env.BOTLING_SPEC_TRACE = dir;
      // Only the trace judges here: the app's lines against the model, without the driver's views.
      await walk(cfg, seed + 20_000, LENGTH, false);
      delete process.env.BOTLING_SPEC_TRACE;
      const trace = readFileSync(join(dir, "worker.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as TraceLine);
      lines += trace.length;
      // The trace's own model allows a crash per app start (the first is the app's first start).
      expect(checkTrace(trace, { ...cfg, maxCrash: Infinity }), `seed ${seed + 20_000}`).toBeNull();
    }
    expect(lines).toBeGreaterThan(300);
  }, 120_000);
});
