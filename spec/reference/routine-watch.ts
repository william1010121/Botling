// A watch routine (spec/models/routines/RoutineWatch.tla) as a pure TypeScript state machine: the same variables,
// the same actions under the same names, the same properties. Tests drive it beside a real Bot
// (spec/tests/routine-watch.spec.test.ts). No app imports.
// SPEC_BUG=watch-storm (no storm rule), watch-rearm (a pass does not re-arm) or watch-orphan (a watch's command not in
// the process ledger, before 5c701311) turns on the model's bug.

export type Bug = "none" | "storm" | "rearm" | "orphan";
export type Result = "pass" | "fail";
export const NONE = -1;

export interface Config { maxTime: number; rewake: number; maxCrash: number; bug?: Bug }
export interface Kept { state: "never" | "ok" | "failing"; wokeAt: number }

export interface State {
  now: number; up: boolean; crashes: number; running: boolean; orphan: boolean; ranAt: number;
  disk: Kept; mem: Kept;
  /** History: the last result the app took, how many it took, wakes, the last wake's time. */
  last: "none" | Result; nres: number; woken: number; lastWake: number;
}

export type Action =
  | { type: "Tick" } | { type: "Due" } | { type: "Finish"; r: Result } | { type: "OrphanEnds" } | { type: "Crash" } | { type: "Boot" };

export const bugFromEnv = (): Bug => {
  const bug = typeof process !== "undefined" ? process.env.SPEC_BUG : undefined;
  return bug === "watch-storm" ? "storm" : bug === "watch-rearm" ? "rearm" : bug === "watch-orphan" ? "orphan" : "none";
};
const bugOf = (cfg: Config): Bug => cfg.bug ?? bugFromEnv();
const NEVER: Kept = { state: "never", wokeAt: NONE };

export function init(_cfg: Config): State {
  return { now: 0, up: true, crashes: 0, running: false, orphan: false, ranAt: NONE, disk: NEVER, mem: NEVER, last: "none", nres: 0, woken: 0, lastWake: NONE };
}

export function enabled(s: State, cfg: Config, a: Action): boolean {
  switch (a.type) {
    case "Tick": return s.now < cfg.maxTime;
    case "Due": return s.up && s.ranAt !== s.now;
    case "Finish": return s.up && s.running;
    case "OrphanEnds": return s.orphan;
    case "Crash": return s.up && s.crashes < cfg.maxCrash;
    case "Boot": return !s.up;
  }
}

export function step(s: State, cfg: Config, a: Action): State {
  if (!enabled(s, cfg, a)) throw new Error(`${a.type} is not enabled`);
  const bug = bugOf(cfg);
  switch (a.type) {
    case "Tick": return { ...s, now: s.now + 1 };
    case "Due": return { ...s, ranAt: s.now, running: true };
    case "Finish": {
      const streak = s.mem.state === "failing";
      const before = streak || bug === "rearm" ? s.mem.wokeAt : NONE;
      const wake = a.r === "fail" && (before === NONE || s.now - before >= cfg.rewake || bug === "storm");
      const kept: Kept = a.r === "pass" ? { state: "ok", wokeAt: bug === "rearm" ? s.mem.wokeAt : NONE } : { state: "failing", wokeAt: wake ? s.now : before };
      return { ...s, running: false, mem: kept, disk: kept, woken: s.woken + (wake ? 1 : 0), lastWake: wake ? s.now : s.lastWake, last: a.r, nres: s.nres + 1 };
    }
    case "OrphanEnds": return { ...s, orphan: false };
    case "Crash": return { ...s, crashes: s.crashes + 1, up: false, running: false, orphan: s.orphan || s.running };
    case "Boot": return { ...s, up: true, mem: s.disk, orphan: s.orphan && bug === "orphan" };
  }
}

export function actions(s: State, cfg: Config): Action[] {
  const all: Action[] = [{ type: "Tick" }, { type: "Due" }, { type: "Finish", r: "pass" }, { type: "Finish", r: "fail" }, { type: "OrphanEnds" }, { type: "Crash" }, { type: "Boot" }];
  return all.filter((a) => enabled(s, cfg, a));
}

const same = (a: Kept, b: Kept) => a.state === b.state && a.wokeAt === b.wokeAt;

/** The model's invariants that fail in `s` (empty: none). */
export function violations(s: State): string[] {
  const out: string[] = [];
  if (s.running && s.orphan) out.push("NoOverlap");
  if (s.up && !same(s.mem, s.disk)) out.push("MemIsDisk");
  const failing = s.disk.state === "failing";
  if (failing !== (s.last === "fail") || (failing && s.disk.wokeAt !== s.lastWake) || (!failing && s.disk.wokeAt !== NONE)) out.push("KeptIsHistory");
  return out;
}

/** The model's action properties that the step from `s` to `n` breaks (empty: none). */
export function stepViolations(s: State, n: State, cfg: Config): string[] {
  const out: string[] = [];
  const took = n.nres === s.nres + 1 ? n.last : null;
  const woke = n.woken === s.woken + 1;
  if (took === "fail" && s.last !== "fail" && !woke) out.push("FirstFailureWakes");
  if (took === "fail" && s.last === "fail" && s.now - s.lastWake < cfg.rewake && woke) out.push("QuietInCooldown");
  if (took === "fail" && s.last === "fail" && s.now - s.lastWake >= cfg.rewake && !woke) out.push("RewakeAfterCooldown");
  if (took === "pass" && woke) out.push("PassWakesNobody");
  if (woke && n.nres !== s.nres + 1) out.push("WakeOnlyOnResult");
  return out;
}

/** What can be seen of the app: the clock, whether it runs, the watch's command (the app's run, one left behind), what
 * bot.json keeps of it, what the app shows of it (when up), and the bot's wakes. */
export interface View { now: number; up: boolean; running: boolean; orphan: boolean; disk: Kept; shown: Kept["state"] | null; woken: number }

export const view = (s: State): View => ({ now: s.now, up: s.up, running: s.running, orphan: s.orphan, disk: { ...s.disk }, shown: s.up ? s.mem.state : null, woken: s.woken });
