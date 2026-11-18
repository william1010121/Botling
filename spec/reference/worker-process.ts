// A Claude worker's process and the words sent to it (spec/models/worker/WorkerProcess.tla) as a pure TypeScript
// state machine: the same variables, the same actions under the same names, the same properties. Tests drive it
// beside the real ClaudeWorkerAdapter (spec/tests/worker-process.spec.test.ts). No app imports.
//
// SPEC_BUG=worker-sleep puts back the app before 95fcab3a (the keep-alive closes the input whatever runs in the
// background; words go into whatever process is there); SPEC_BUG=worker-bg leaves out only the background rule;
// SPEC_BUG=worker-stale lets an earlier process's late tree check take a held run (before ebfa0da4);
// SPEC_BUG=worker-cutoff lets the timer of a report kept for a Monitor end the run while a wake turn is under way
// (before 0ea2a290); SPEC_BUG=worker-monexit ends a run whose report is kept as "exited" when its process ends;
// SPEC_BUG=worker-droperr lets a failed turn or an API retry take the good words kept before it (before monitor-fix2);
// SPEC_BUG=worker-rehold lets a newer Monitor keep a report again after the oldest one's cap let it go (before
// monitor-fix2).

export type Proc = "none" | "open" | "closed" | "exited";
export type Run = "idle" | "working" | "held";
export type Hold = "none" | "cap" | "grace";
export type Outcome = "none" | "report" | "error" | "exited" | "stopped" | "interrupted";
export type Bug = "none" | "sleep" | "bg" | "stale" | "cutoff" | "monexit" | "droperr" | "rehold";

export interface Config { maxWords: number; maxBg: number; maxWakes: number; bug?: Bug }

export interface State {
  proc: Proc; tree: boolean; run: Run; keep: boolean; bg: number; mon: number; old: number; checking: boolean; older: number;
  sent: number; read: number; held: number; lost: number; failed: number; stopped: number;
  hold: Hold; turn: boolean; wakes: number; capped: boolean; retry: boolean; tried: boolean; kept: number; said: number; told: number; dropped: number;
  runs: number; reports: number; outcome: Outcome; closed: boolean;
}

export type Action =
  | { type: "Start" } | { type: "Steer" } | { type: "Result"; ok: boolean } | { type: "ApiError" } | { type: "RetryFires" }
  | { type: "WakeTurn" } | { type: "KeepAliveFires" }
  | { type: "BgStart" } | { type: "BgEnd" } | { type: "Age" }
  | { type: "MonStart" } | { type: "MonEnd" } | { type: "OldEnd" } | { type: "MonExpire" } | { type: "GraceFires" }
  | { type: "ProcExit"; tree: boolean } | { type: "TreeChecked"; ok: boolean } | { type: "OlderChecked" }
  | { type: "TreeGone" } | { type: "Stop"; tree: boolean } | { type: "AppClose"; tree: boolean };

const BUGS: Record<string, Bug> = { "worker-sleep": "sleep", "worker-bg": "bg", "worker-stale": "stale", "worker-cutoff": "cutoff", "worker-monexit": "monexit",
  "worker-droperr": "droperr", "worker-rehold": "rehold" };
export const bugFromEnv = (): Bug => {
  const bug = typeof process !== "undefined" ? process.env.SPEC_BUG : undefined;
  return bug !== undefined && Object.hasOwn(BUGS, bug) ? BUGS[bug]! : "none";
};
const bugOf = (cfg: Config): Bug => cfg.bug ?? bugFromEnv();

export function init(_cfg: Config): State {
  return {
    proc: "none", tree: false, run: "idle", keep: false, bg: 0, mon: 0, old: 0, checking: false, older: 0,
    sent: 0, read: 0, held: 0, lost: 0, failed: 0, stopped: 0,
    hold: "none", turn: false, wakes: 0, capped: false, retry: false, tried: false, kept: 0, said: 0, told: 0, dropped: 0, runs: 0, reports: 0, outcome: "none", closed: false,
  };
}

const live = (s: State) => s.proc === "open" || s.proc === "closed";
/** Background work that keeps a process awake: started less than 6 hours ago. */
const bgAll = (s: State) => s.bg + s.mon + s.old;
/** A new process takes the session: a check still under way is now an earlier process's. */
const spawned = (s: State): State => ({ ...s, proc: "open", bg: 0, mon: 0, old: 0, checking: false, older: s.older + (s.checking ? 1 : 0) });
/** A held run taken by a late check of an earlier process (bug "stale"): a new process, or its spawn refused (`t`). */
const takeHeld = (s: State, t: boolean): State =>
  (!t ? { ...spawned(s), run: "working", read: s.read + s.held, held: 0 }
    : { ...s, run: "idle", failed: s.failed + s.held, held: 0, reports: s.reports + 1, outcome: "error" });
/** Nothing of the run under way is kept any more (it ended). */
const settled = { hold: "none", turn: false, capped: false, retry: false, tried: false, kept: 0 } as const;
/** The run ends with its report: the turns' words kept and `extra` more. */
const sendKept = (s: State, extra: number): State =>
  ({ ...s, run: "idle", ...settled, told: s.told + s.kept + extra, reports: s.reports + 1, outcome: "report" });
/** The run under way ends without a report of its own (an error, its process's end): the good words it kept go out
 * with it if `tell`, else they are dropped. */
const endWithout = (s: State, how: Outcome, tell: boolean): State => ({
  ...s, run: "idle", ...settled, told: s.told + (tell ? s.kept : 0), dropped: s.dropped + (tell ? 0 : s.kept),
  reports: s.reports + 1, outcome: how,
});
/** What a held report's timer waits for once its Monitors are `m` (monitorChanged); once a cap let it go, nothing
 * changes it (bug "rehold": as before the cap). */
const aim = (s: State, m: number, bug: Bug): Hold =>
  (s.hold === "none" || (s.capped && bug !== "rehold") ? s.hold : m > 0 ? "cap" : "grace");
/** Stop and the app's close: the run under way, its held words and a kept report are dropped, its process killed. */
const cutOff = (s: State, how: Outcome, tree: boolean): State => {
  const n: State = {
    ...s, run: "idle", held: 0, stopped: s.stopped + s.held, keep: false, ...settled, dropped: s.dropped + s.kept,
    reports: s.reports + (s.run !== "idle" ? 1 : 0), outcome: s.run !== "idle" ? how : s.outcome,
  };
  return live(s) ? { ...n, proc: "exited", checking: true, bg: 0, mon: 0, old: 0, tree } : n;
};

export function enabled(s: State, cfg: Config, a: Action): boolean {
  switch (a.type) {
    case "Start": return s.run === "idle" && !s.closed && s.sent < cfg.maxWords;
    case "Steer": return s.run !== "idle" && s.sent < cfg.maxWords;
    case "Result": case "ApiError": return s.run === "working" && live(s) && (s.hold === "none" || s.turn);
    case "RetryFires": return s.retry;
    case "WakeTurn": return s.hold !== "none" && !s.turn && s.wakes < cfg.maxWakes;
    case "KeepAliveFires": return s.keep;
    case "BgStart": return live(s) && bgAll(s) < cfg.maxBg;
    case "BgEnd": return s.bg > 0;
    case "Age": return s.mon === 0 && s.bg + s.old > 0;
    case "MonStart": return live(s) && bgAll(s) < cfg.maxBg && (s.hold === "none" || s.turn);
    case "MonEnd": case "MonExpire": return s.mon > 0;
    case "OldEnd": return s.old > 0;
    case "GraceFires": return s.hold === "grace";
    case "ProcExit": return live(s);
    case "TreeChecked": return s.checking && (a.ok || s.tree);
    case "OlderChecked": return s.older > 0;
    case "TreeGone": return s.tree && !live(s);
    case "Stop": return (s.run !== "idle" || live(s)) && (live(s) || !a.tree);
    case "AppClose": return !s.closed && (live(s) || !a.tree);
  }
}

export function step(s: State, cfg: Config, a: Action): State {
  if (!enabled(s, cfg, a)) throw new Error(`${a.type} is not enabled`);
  const bug = bugOf(cfg);
  switch (a.type) {
    case "Start": {
      const n = { ...s, sent: s.sent + 1, runs: s.runs + 1, keep: false };
      if (s.proc === "open" || (s.proc === "closed" && bug === "sleep")) {
        return s.proc === "open" ? { ...n, run: "working", read: s.read + 1 } : { ...n, run: "working", lost: s.lost + 1 };
      }
      if (s.proc === "closed") return { ...n, run: "held", held: 1 };
      if (!live(s) && !s.tree) return { ...spawned(n), run: "working", read: s.read + 1 };
      return { ...n, failed: s.failed + 1, reports: s.reports + 1, outcome: "error" };
    }
    case "Steer": {
      const n = { ...s, sent: s.sent + 1, retry: false };
      if (s.run === "held") return { ...n, held: s.held + 1 };
      return s.proc === "open" ? { ...n, read: s.read + 1 } : { ...n, lost: s.lost + 1 };
    }
    case "Result": {
      const n = { ...s, said: s.said + (a.ok ? 1 : 0) };
      if (a.ok && s.mon > 0 && !(s.capped && bug !== "rehold")) return { ...n, hold: "cap", turn: false, retry: false, tried: false, kept: s.kept + 1 };
      return a.ok ? { ...sendKept(n, 1), keep: true } : { ...endWithout(n, "error", bug !== "droperr"), keep: true };
    }
    case "ApiError": {
      if (s.tried) return { ...endWithout(s, "error", bug !== "droperr"), keep: true };
      const n: State = { ...s, retry: true, tried: true, hold: "none", turn: false };
      return bug === "droperr" ? { ...n, kept: 0, dropped: s.dropped + s.kept } : n;
    }
    case "RetryFires": return { ...s, retry: false };
    case "WakeTurn": return { ...s, turn: true, wakes: s.wakes + 1 };
    case "KeepAliveFires": {
      const idleOpen = s.proc === "open" && s.run === "idle";
      return {
        ...s, keep: bgAll(s) > 0 && idleOpen && bug !== "sleep" && bug !== "bg",
        proc: idleOpen && (bgAll(s) === 0 || bug === "sleep" || bug === "bg") ? "closed" : s.proc,
      };
    }
    case "BgStart": return { ...s, bg: s.bg + 1 };
    case "BgEnd": return { ...s, bg: s.bg - 1 };
    case "Age": return { ...s, bg: 0, old: 0 };
    case "MonStart": return { ...s, mon: s.mon + 1, hold: aim(s, 1, bug) };
    case "MonEnd": return { ...s, mon: s.mon - 1, hold: aim(s, s.mon - 1, bug) };
    case "OldEnd": return { ...s, old: s.old - 1, hold: aim(s, s.mon, bug) };
    case "MonExpire": {
      const n = { ...s, mon: s.mon - 1, old: s.old + 1 };
      if (s.hold === "cap" && !(s.turn && bug !== "cutoff")) return { ...sendKept(n, 0), keep: true };
      return { ...n, hold: s.hold === "cap" ? "grace" : s.hold, capped: s.capped || s.hold === "cap" };
    }
    case "GraceFires": return s.turn && bug !== "cutoff" ? s : { ...sendKept(s, 0), keep: true };
    case "ProcExit": {
      const n: State = { ...s, proc: "exited", checking: true, bg: 0, mon: 0, old: 0, keep: false, tree: a.tree };
      if (s.run === "working" && s.hold !== "none" && bug !== "monexit") return sendKept(n, 0);
      return s.run === "working" ? endWithout(n, "exited", bug !== "monexit" && bug !== "droperr") : n;
    }
    case "TreeChecked": {
      const t = s.tree && !a.ok;
      const n: State = { ...s, tree: t, checking: false };
      if (s.run === "held" && !t) return { ...n, run: "working", proc: "open", bg: 0, read: s.read + s.held, held: 0 };
      const ends = s.run === "held";
      return {
        ...n, proc: "none", run: ends ? "idle" : s.run, failed: s.failed + s.held, held: 0,
        reports: s.reports + (ends ? 1 : 0), outcome: ends ? "error" : s.outcome,
      };
    }
    case "OlderChecked": {
      const n = { ...s, older: s.older - 1 };
      if (bug !== "stale" || s.run !== "held") return n;
      return takeHeld(n, live(s) || s.tree);
    }
    case "TreeGone": return { ...s, tree: false };
    case "Stop": return cutOff(s, "stopped", a.tree);
    case "AppClose": return { ...cutOff(s, "interrupted", a.tree), closed: true };
  }
}

export function actions(s: State, cfg: Config): Action[] {
  const all: Action[] = [
    { type: "Start" }, { type: "Steer" }, { type: "ApiError" }, { type: "RetryFires" }, { type: "WakeTurn" }, { type: "KeepAliveFires" }, { type: "BgStart" }, { type: "BgEnd" },
    { type: "Age" }, { type: "MonStart" }, { type: "MonEnd" }, { type: "OldEnd" }, { type: "MonExpire" }, { type: "GraceFires" },
    { type: "OlderChecked" }, { type: "TreeGone" },
  ];
  for (const b of [false, true]) {
    all.push({ type: "Result", ok: b }, { type: "ProcExit", tree: b }, { type: "TreeChecked", ok: b }, { type: "Stop", tree: b }, { type: "AppClose", tree: b });
  }
  return all.filter((a) => enabled(s, cfg, a));
}

/** The model's invariants that fail in `s` (empty: none). */
export function violations(s: State): string[] {
  const out: string[] = [];
  if (s.sent !== s.read + s.held + s.lost + s.failed + s.stopped) out.push("WordsAccounted");
  if (s.lost !== 0) out.push("NoWordLost");
  if ((s.run === "held") !== (s.held > 0)) out.push("HeldHasWords");
  if (s.run === "held" && s.proc !== "closed" && s.proc !== "exited") out.push("HeldOnlyWhileEnding");
  if ((s.proc === "exited") !== s.checking) out.push("ExitedIsChecked");
  if (s.run === "working" && s.proc !== "open") out.push("WorkingIsOpen");
  if (s.proc === "open" && s.run === "idle" && !s.keep) out.push("IdleHasTimer");
  if (live(s) && s.tree) out.push("OneProcess");
  if (!live(s) && bgAll(s) !== 0) out.push("BackgroundIsLive");
  if (s.runs !== s.reports + (s.run === "idle" ? 0 : 1)) out.push("OneReportPerRun");
  if (s.said !== s.told + s.kept + s.dropped) out.push("TextsAccounted");
  if (((s.kept > 0 || s.hold !== "none" || s.capped || s.tried) && !(s.run === "working" && s.proc === "open"))
    || (s.hold !== "none" && !(s.kept > 0 && !s.tried))) out.push("KeptIsAtWork");
  if ((s.hold === "none" && s.turn) || (s.hold === "none" && !s.tried && s.kept !== 0)) out.push("NothingKept");
  if (s.retry && !s.tried) out.push("RetryIsTried");
  if ((s.hold === "cap" && s.mon === 0) || (s.hold === "grace" && !s.capped && s.mon !== 0)
    || (s.capped && (s.hold === "cap" || (s.hold !== "none" && !s.turn)))) out.push("CapIsLive");
  if (s.closed && (s.run !== "idle" || live(s))) out.push("ClosedIsQuiet");
  return out;
}

/** The model's action properties that the step from `s` to `n` breaks (empty: none). */
export function stepViolations(s: State, n: State): string[] {
  const out: string[] = [];
  if (s.proc === "open" && n.proc === "closed" && bgAll(s) > 0) out.push("NoSleepWithBackground");
  if (s.run === "held" && n.run === "idle" && n.failed > s.failed && !n.tree) out.push("HeldFailsOnlyForLeftovers");
  if (s.hold === "none" && n.hold !== "none" && !(s.mon > 0 && n.said === s.said + 1)) out.push("HoldOnlyForMonitor");
  if (s.hold !== "none" && s.turn && n.run === "idle" && n.proc === "open" && !n.closed && !(n.said > s.said || n.outcome === "error")) out.push("TurnNotCutOff");
  if (s.kept > 0 && n.run === "idle"
    && !((n.outcome === "report" && n.told === s.told + s.kept + (n.said - s.said))
      || (s.hold === "none" && (n.outcome === "error" || n.outcome === "exited") && n.told === s.told + s.kept)
      || (s.hold !== "none" && n.outcome === "error" && n.told === s.told + s.kept)
      || n.outcome === "stopped" || n.outcome === "interrupted")) out.push("KeptIsReported");
  if (n.dropped > s.dropped && !((n.outcome === "stopped" || n.outcome === "interrupted") && n.reports === s.reports + 1)) out.push("DroppedOnlyCutOff");
  if (s.capped && n.hold === "cap") out.push("CapLetsGoOnce");
  return out;
}

/** What the app shows: the process the session is on, the run, the words by where they went, background work, the
 * report kept for a Monitor and how runs ended. */
export type View = State;

export const view = (s: State): View => ({ ...s });
