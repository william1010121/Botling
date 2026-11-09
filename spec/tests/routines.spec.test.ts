// Routines scheduling against spec/models/routines: (a) seeded random walks of the model's actions drive the
// real code through the adapter and compare it with spec/reference after every step; (b) the app's own
// trace (BOTLING_SPEC_TRACE) of those walks replays through the reference, every line an allowed step;
// (c) scripted runs of what a walk cannot reach: a script's append inside an app rewrite of routines.cron.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routinesAdapter } from "../../desktop/spec-adapters/routines-adapter";
import type { RoutinesSession } from "../driver/routines-driver";
import { actions, init, logView, NONE, step, stepViolations, view, violations, type Action, type Bot, type Config, type JobState, type State } from "../reference/routines";

const CFG: Config = { jobs: ["J1", "J2"], bots: ["p", "s"], requests: ["r1", "r2"], maxTime: 5, cron: [1, 2, 4], lines: ["L1", "L2", "L3"] };
/** An app rewrite of routines.cron cannot be held open mid-walk (the real one is one synchronous call): scripted below. */
const WINDOW = new Set(["TakeRead", "EditRead", "Rewrite"]);

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

/** The clock looks often and time passes; every other action is as likely as the next. */
const WEIGHT: Record<string, number> = { Check: 4, Tick: 3, Create: 3, Append: 2 };

/** An action type by weight, then one of its enabled variants; `skip` leaves some types out. */
function pick(s: State, rnd: () => number, skip: Set<string>): Action {
  const enabled = actions(s, CFG).filter((a) => !skip.has(a.type));
  const types = [...new Set(enabled.map((a) => a.type))].flatMap((type) => Array(WEIGHT[type] ?? 1).fill(type) as string[]);
  const type = types[Math.floor(rnd() * types.length)];
  const variants = enabled.filter((a) => a.type === type);
  return variants[Math.floor(rnd() * variants.length)]!;
}

function apply(session: RoutinesSession, a: Action) {
  switch (a.type) {
    case "Tick": return session.tick();
    case "Crash": return session.crash();
    case "Boot": return session.boot();
    case "Break": return session.break(a.bot);
    case "Mend": return session.mend(a.bot);
    case "View": return session.view(a.bot);
    case "Check": return session.check(a.bot);
    case "ClaimThenCrash": return session.claimThenCrash(a.job);
    case "Create": return session.create(a.job, a);
    case "AddLegacy": return session.addLegacy(a.job, a.bot);
    case "Pause": return session.pause(a.job);
    case "Resume": return session.resume(a.job);
    case "Cancel": return session.cancel(a.job);
    case "Append": return session.append(a.line, a.bot, a.paused);
    case "TakeRead": return session.takeRead(a.bot, a.line);
    case "EditRead": return session.editRead(a.bot);
    case "Rewrite": return session.rewrite(a.bot);
    case "TakeThenCrash": return session.takeThenCrash(a.bot, a.line);
  }
}

/** Many walks, each step real file I/O: seconds alone, longer beside other test files. */
const WALKS_TIMEOUT = 180_000;

const sessions: RoutinesSession[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  vi.useRealTimers();
});

function open(): RoutinesSession {
  const session = routinesAdapter.open({ bots: CFG.bots, cron: CFG.cron, lines: CFG.lines, setClock: (ms) => vi.setSystemTime(ms) });
  sessions.push(session);
  return session;
}

/** One walk: each step the app and the reference must show the same, and the reference keeps the model's properties. */
async function walk(seed: number, steps: number, skip = WINDOW): Promise<{ session: RoutinesSession; done: Action[]; end: State }> {
  const rnd = random(seed);
  const session = open();
  let s = init(CFG);
  const done: Action[] = [];
  for (let i = 0; i < steps; i++) {
    const a = pick(s, rnd, skip);
    const n = step(s, CFG, a);
    apply(session, a);
    done.push(a);
    expect([...violations(n, CFG), ...stepViolations(s, n, CFG)], `seed ${seed}`).toEqual([]);
    expect(session.observe(), `seed ${seed}, after ${JSON.stringify(done)}`).toEqual(view(n));
    s = n;
  }
  return { session, done, end: s };
}

/** How much of the protocol a set of walks went through. */
function coverage(walks: { done: Action[]; end: State }[]) {
  const count = (type: string) => walks.reduce((sum, w) => sum + w.done.filter((a) => a.type === type).length, 0);
  const runs = walks.flatMap((w) => w.end.log.filter((d) => d.job in w.end.jobs).map((d) => ({ ...d, kind: w.end.jobs[d.job]!.kind, owner: w.end.jobs[d.job]!.owner })));
  const lines = (st: string) => walks.reduce((sum, w) => sum + Object.values(w.end.ln).filter((v) => v === st).length, 0);
  return {
    oneShot: lines("run"),
    oneShotPaused: lines("paused"),
    oneShotTakenUnrun: lines("taken"),
    once: runs.filter((d) => d.kind === "once").length,
    recurring: runs.filter((d) => d.kind === "recurring").length,
    legacy: runs.filter((d) => d.kind === "legacy").length,
    subBot: runs.filter((d) => d.chat === "s").length,
    caughtUp: runs.filter((d) => d.kind !== "once" && !CFG.cron.includes(d.at)).length,
    uncertain: walks.filter((w) => Object.values(w.end.jobs).some((v) => v.st === "claimed")).length,
    notices: walks.reduce((sum, w) => sum + Object.values(w.end.notices).reduce((a, b) => a + b, 0), 0),
    restarts: count("Boot"),
  };
}

describe("routines conformance", () => {
  it("random walks follow the model", async () => {
    const walks = [];
    // Without one-shot lines (as before they existed), then with them: each kind of run is seen often.
    const scheduledOnly = new Set([...WINDOW, "Append", "TakeThenCrash"]);
    for (let seed = 1; seed <= 60; seed++) walks.push(await walk(seed, 30, scheduledOnly));
    for (let seed = 101; seed <= 130; seed++) walks.push(await walk(seed, 30));
    const seen = coverage(walks);
    for (const [what, n] of Object.entries(seen)) expect(n, `${what} in ${JSON.stringify(seen)}`).toBeGreaterThan(2);
  }, WALKS_TIMEOUT);

  it("a look at the routines between a file breaking and the clock's next look keeps the notice", async () => {
    const session = open();
    session.boot();
    session.break("p");
    session.view("p");
    session.check("p");
    expect(session.observe().notices.p).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------
// One-shot lines inside an app rewrite of routines.cron: the app and the reference step by step.

function scripted(actions: Action[]): State {
  const session = open();
  let s = init(CFG);
  for (const [i, a] of actions.entries()) {
    const n = step(s, CFG, a);
    apply(session, a);
    expect([...violations(n, CFG), ...stepViolations(s, n, CFG)]).toEqual([]);
    expect(session.observe(), `after ${JSON.stringify(actions.slice(0, i + 1))}`).toEqual(view(n));
    s = n;
  }
  return s;
}

describe("routines one-shot lines", () => {
  it("a line appended inside a check's takeOnce window is lost: the allowed loss (LostOnlyInRewrite)", () => {
    const end = scripted([
      { type: "Boot" },
      { type: "Append", line: "L1", bot: "p", paused: false },
      { type: "Append", line: "L2", bot: "p", paused: true },
      { type: "TakeRead", bot: "p", line: "L1" },
      { type: "Append", line: "L3", bot: "p", paused: false },
      { type: "Rewrite", bot: "p" },
      { type: "Check", bot: "p" },
    ]);
    expect(end.ln).toEqual({ L1: "run", L2: "paused", L3: "lost" });
    expect(end.log.map((d) => d.job)).toEqual(["L1"]);
  });

  it("any other app rewrite of routines.cron (app_routines pause) loses an append in its window too", () => {
    const end = scripted([
      { type: "Boot" },
      { type: "Append", line: "L1", bot: "p", paused: true },
      { type: "EditRead", bot: "p" },
      { type: "Append", line: "L2", bot: "p", paused: false },
      { type: "Rewrite", bot: "p" },
      { type: "Check", bot: "p" },
    ]);
    expect(end.ln).toEqual({ L1: "paused", L2: "lost", L3: "none" });
    expect(end.log).toEqual([]);
  });

  it("a line taken by a check that dies before dispatching never runs; the same words appended again run once", () => {
    const end = scripted([
      { type: "Boot" },
      { type: "Append", line: "L1", bot: "s", paused: false },
      { type: "TakeThenCrash", bot: "s", line: "L1" },
      { type: "Boot" },
      { type: "Check", bot: "s" },
      { type: "Append", line: "L2", bot: "s", paused: false },
      { type: "Check", bot: "s" },
      { type: "Check", bot: "s" },
    ]);
    expect(end.ln).toEqual({ L1: "taken", L2: "run", L3: "none" });
    expect(end.log.map((d) => `${d.job}:${d.chat}`)).toEqual(["L2:s"]);
  });

  it("checks every 15 s (four a minute) run a five-field job once per matching minute", () => {
    const four: Action[] = Array(4).fill({ type: "Check", bot: "p" });
    const end = scripted([
      { type: "Boot" }, { type: "AddLegacy", job: "J1", bot: "p" }, ...four,
      { type: "Tick" }, ...four, { type: "Tick" }, ...four, { type: "Tick" }, ...four,
    ]);
    expect(logView(end.log)).toEqual(["J1@1:p", "J1@2:p"]);
  });
});

// ------------------------------------------------------------------------------------------------
// Trace check: the app's own lines (bot.ts setUpRoutines/checkRoutines/changeRoutine/addRoutine).

interface SpecJobs {
  legacy: { id: string; task: string; enabled: boolean; run: number | null }[];
  scheduled: { id: string; task: string; kind: "once" | "recurring"; state: JobState; at?: number; baseline: number; lastClaim?: number; requestID: string }[] | null;
}
interface TraceLine { at: number; action: string; state: { bot: string; now?: number; noticed?: boolean; args?: Record<string, any>; cron?: string; task?: string; before?: SpecJobs; after: SpecJobs } }

const SWIFT_EPOCH = Date.UTC(2001, 0, 1);
/** A one-shot "@once" line of routines.cron (written by scripts: untraced). */
const isOnce = (job: { id: string }) => job.id.startsWith("@once ");
const slot = (task: string) => task.split(":")[0]!;

/** The reference state one bot's files stand for (the other bots' jobs left out). */
function botState(session: RoutinesSession, bot: Bot, jobs: SpecJobs, now: number, told: boolean): State {
  const minute = (swift: number) => session.minute(SWIFT_EPOCH + swift * 1000);
  const s = init(CFG);
  s.up = true;
  s.now = now;
  s.told[bot] = told;
  s.file[bot] = jobs.scheduled === null ? "broken" : "ok";
  for (const job of jobs.legacy.filter(isOnce)) { s.ln[slot(job.task)] = job.enabled ? "in" : "paused"; s.lowner[slot(job.task)] = bot; }
  for (const job of jobs.legacy.filter((job) => !isOnce(job))) s.jobs[slot(job.task)] = { st: job.enabled ? "pending" : "paused", kind: "legacy", owner: bot, at: NONE, since: job.run === null ? NONE : minute(job.run), last: NONE, req: "none" };
  for (const job of jobs.scheduled ?? []) {
    s.jobs[slot(job.task)] = { st: job.state, kind: job.kind, owner: bot, at: job.at === undefined ? NONE : minute(job.at), since: minute(job.baseline), last: job.lastClaim === undefined ? NONE : minute(job.lastClaim), req: job.requestID };
  }
  return s;
}

/** The model action a traced change stands for. */
function traced(session: RoutinesSession, line: TraceLine, bot: Bot): Action {
  const { args, before, task } = line.state;
  if (line.action === "Check") return { type: "Check", bot };
  if (line.action === "AddLegacy") return { type: "AddLegacy", job: slot(task!), bot };
  if (line.action === "Create") return { type: "Create", job: slot(args!.task), req: args!.request_id, kind: args!.kind, bot, at: args!.at ? session.minute(Date.parse(args!.at)) : NONE };
  const id = String(args!.id);
  const job = id.startsWith("cron:") ? before!.legacy.find((j) => `cron:${j.id}` === id)! : before!.scheduled!.find((j) => j.id === id)!;
  return { type: line.action as "Pause" | "Resume" | "Cancel", job: slot(job.task) };
}

/** routines.cron cancels a job by removing its line: a cancelled legacy job is not in the file. */
const kept = (jobs: ReturnType<typeof view>["jobs"]) => Object.fromEntries(Object.entries(jobs).filter(([, v]) => !(v.kind === "legacy" && v.st === "cancelled")));
/** The one-shot lines a file holds (one out of it is not in the next line's file either). */
const inFile = (lines: ReturnType<typeof view>["lines"]) => Object.fromEntries(Object.entries(lines).filter(([, v]) => v.st !== "out"));

/** Every line must be an allowed step of the reference from the state the line before it left. */
function replay(session: RoutinesSession, lines: TraceLine[]) {
  const told: Record<Bot, boolean> = {};
  const last: Record<Bot, SpecJobs | null> = {};
  // Scripts append one-shot lines and TakeThenCrash takes one outside any trace line: those are left out here.
  const legacy = (jobs: SpecJobs) => JSON.stringify(jobs.legacy.filter((job) => !isOnce(job)));
  const same = (a: SpecJobs, b: SpecJobs) => legacy(a) === legacy(b) && (a.scheduled === null || b.scheduled === null || JSON.stringify(a.scheduled) === JSON.stringify(b.scheduled));
  for (const [i, line] of lines.entries()) {
    const where = `trace line ${i + 1}: ${JSON.stringify(line)}`;
    const bot = botOf(session, line.state.bot);
    const now = line.state.now !== undefined ? session.minute(line.state.now) : session.minute(line.at);
    if (line.action === "Boot") {
      const down = botState(session, bot, line.state.after, now, false);
      down.up = false;
      told[bot] = step(down, CFG, { type: "Boot" }).told[bot]!;
      last[bot] = line.state.after;
      continue;
    }
    const before = line.state.before!;
    // Nothing the app did between two of its lines went untraced (a broken file only hides its jobs).
    if (last[bot]) expect(same(last[bot]!, before), `${where}\nfollows ${JSON.stringify(last[bot])}`).toBe(true);
    const s = botState(session, bot, before, now, told[bot] ?? false);
    const n = step(s, CFG, traced(session, line, bot));
    const after = botState(session, bot, line.state.after, now, n.told[bot]!);
    expect(kept(view(after).jobs), where).toEqual(kept(view(n).jobs));
    expect(inFile(view(after).lines), where).toEqual(inFile(view(n).lines));
    if (line.action === "Check") expect(line.state.noticed, where).toBe(n.notices[bot]! > s.notices[bot]!);
    told[bot] = n.told[bot]!;
    last[bot] = line.state.after;
  }
}

/** The trace's bot ids are the app's: the session names its bots in the order the world gave them. */
const ids = new Map<RoutinesSession, Map<string, Bot>>();
function botOf(session: RoutinesSession, id: string): Bot {
  const known = ids.get(session) ?? new Map<string, Bot>();
  ids.set(session, known);
  if (!known.has(id)) known.set(id, CFG.bots[known.size]!);
  return known.get(id)!;
}

describe("routines trace", () => {
  const dirs: string[] = [];
  afterEach(() => {
    delete process.env.BOTLING_SPEC_TRACE;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("the app's trace of random walks replays through the reference", async () => {
    let lines = 0;
    for (let seed = 201; seed <= 220; seed++) {
      const dir = mkdtempSync(join(tmpdir(), "spec-routines-trace-"));
      dirs.push(dir);
      process.env.BOTLING_SPEC_TRACE = dir;
      const { session } = await walk(seed, 30);
      delete process.env.BOTLING_SPEC_TRACE;
      let text = "";
      try { text = readFileSync(join(dir, "routines.jsonl"), "utf8"); } catch { /* a walk that never booted */ }
      const trace = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as TraceLine);
      replay(session, trace);
      lines += trace.length;
    }
    expect(lines).toBeGreaterThan(200);
  }, WALKS_TIMEOUT);
});
