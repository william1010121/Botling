// A Claude worker's process and the words sent to it (spec/models/worker/WorkerProcess.tla) as a pure TypeScript
// state machine: the same variables, the same actions under the same names, the same properties. Tests drive it
// beside the real ClaudeWorkerAdapter (spec/tests/worker-process.spec.test.ts). No app imports.
//
// SPEC_BUG=worker-sleep puts back the app before 95fcab3a (the keep-alive closes the input whatever runs in the
// background; words go into whatever process is there); SPEC_BUG=worker-bg leaves out only the background rule;
// SPEC_BUG=worker-stale lets an earlier process's late tree check take a held run (before ebfa0da4).

export type Proc = "none" | "open" | "closed" | "exited";
export type Run = "idle" | "working" | "held";
export type Bug = "none" | "sleep" | "bg" | "stale";

export interface Config { maxWords: number; maxBg: number; bug?: Bug }

export interface State {
  proc: Proc; tree: boolean; run: Run; keep: boolean; bg: number; checking: boolean; older: number;
  sent: number; read: number; held: number; lost: number; failed: number; stopped: number;
}

export type Action =
  | { type: "Start" } | { type: "Steer" } | { type: "Result" } | { type: "KeepAliveFires" }
  | { type: "BgStart" } | { type: "BgEnd" } | { type: "Age" }
  | { type: "ProcExit"; tree: boolean } | { type: "TreeChecked"; ok: boolean } | { type: "OlderChecked" }
  | { type: "TreeGone" } | { type: "Stop"; tree: boolean };

export const bugFromEnv = (): Bug => {
  const bug = typeof process !== "undefined" ? process.env.SPEC_BUG : undefined;
  return bug === "worker-sleep" ? "sleep" : bug === "worker-bg" ? "bg" : bug === "worker-stale" ? "stale" : "none";
};
const bugOf = (cfg: Config): Bug => cfg.bug ?? bugFromEnv();

export function init(_cfg: Config): State {
  return { proc: "none", tree: false, run: "idle", keep: false, bg: 0, checking: false, older: 0, sent: 0, read: 0, held: 0, lost: 0, failed: 0, stopped: 0 };
}

const live = (s: State) => s.proc === "open" || s.proc === "closed";
/** A new process takes the session: a check still under way is now an earlier process's. */
const spawned = (s: State): State => ({ ...s, proc: "open", bg: 0, checking: false, older: s.older + (s.checking ? 1 : 0) });
/** A held run taken by a late check of an earlier process (bug "stale"): a new process, or its spawn refused (`t`). */
const takeHeld = (s: State, t: boolean): State =>
  (!t ? { ...spawned(s), run: "working", read: s.read + s.held, held: 0 } : { ...s, run: "idle", failed: s.failed + s.held, held: 0 });

export function enabled(s: State, cfg: Config, a: Action): boolean {
  switch (a.type) {
    case "Start": return s.run === "idle" && s.sent < cfg.maxWords;
    case "Steer": return s.run !== "idle" && s.sent < cfg.maxWords;
    case "Result": return s.run === "working" && live(s);
    case "KeepAliveFires": return s.keep;
    case "BgStart": return live(s) && s.bg < cfg.maxBg;
    case "BgEnd": case "Age": return s.bg > 0;
    case "ProcExit": return live(s);
    case "TreeChecked": return s.checking && (a.ok || s.tree);
    case "OlderChecked": return s.older > 0;
    case "TreeGone": return s.tree && !live(s);
    case "Stop": return (s.run !== "idle" || live(s)) && (live(s) || !a.tree);
  }
}

export function step(s: State, cfg: Config, a: Action): State {
  if (!enabled(s, cfg, a)) throw new Error(`${a.type} is not enabled`);
  const bug = bugOf(cfg);
  switch (a.type) {
    case "Start": {
      const n = { ...s, sent: s.sent + 1, keep: false };
      if (s.proc === "open" || (s.proc === "closed" && bug === "sleep")) {
        return s.proc === "open" ? { ...n, run: "working", read: s.read + 1 } : { ...n, run: "working", lost: s.lost + 1 };
      }
      if (s.proc === "closed") return { ...n, run: "held", held: 1 };
      if (!live(s) && !s.tree) return { ...spawned(n), run: "working", read: s.read + 1 };
      return { ...n, failed: s.failed + 1 };
    }
    case "Steer": {
      const n = { ...s, sent: s.sent + 1 };
      if (s.run === "held") return { ...n, held: s.held + 1 };
      return s.proc === "open" ? { ...n, read: s.read + 1 } : { ...n, lost: s.lost + 1 };
    }
    case "Result": return { ...s, run: "idle", keep: true };
    case "KeepAliveFires": {
      const idleOpen = s.proc === "open" && s.run === "idle";
      return {
        ...s, keep: s.bg > 0 && idleOpen && bug !== "sleep" && bug !== "bg",
        proc: idleOpen && (s.bg === 0 || bug === "sleep" || bug === "bg") ? "closed" : s.proc,
      };
    }
    case "BgStart": return { ...s, bg: s.bg + 1 };
    case "BgEnd": return { ...s, bg: s.bg - 1 };
    case "Age": return { ...s, bg: 0 };
    case "ProcExit": return { ...s, proc: "exited", checking: true, bg: 0, keep: false, tree: a.tree, run: s.run === "working" ? "idle" : s.run };
    case "TreeChecked": {
      const t = s.tree && !a.ok;
      const n: State = { ...s, tree: t, checking: false };
      if (s.run === "held" && !t) return { ...n, run: "working", proc: "open", bg: 0, read: s.read + s.held, held: 0 };
      return { ...n, proc: "none", run: s.run === "held" ? "idle" : s.run, failed: s.failed + s.held, held: 0 };
    }
    case "OlderChecked": {
      const n = { ...s, older: s.older - 1 };
      if (bug !== "stale" || s.run !== "held") return n;
      return takeHeld(n, live(s) || s.tree);
    }
    case "TreeGone": return { ...s, tree: false };
    case "Stop": {
      const n: State = { ...s, run: "idle", held: 0, stopped: s.stopped + s.held, keep: false };
      return live(s) ? { ...n, proc: "exited", checking: true, bg: 0, tree: a.tree } : n;
    }
  }
}

export function actions(s: State, cfg: Config): Action[] {
  const all: Action[] = [
    { type: "Start" }, { type: "Steer" }, { type: "Result" }, { type: "KeepAliveFires" }, { type: "BgStart" }, { type: "BgEnd" },
    { type: "Age" }, { type: "OlderChecked" }, { type: "TreeGone" },
  ];
  for (const b of [false, true]) all.push({ type: "ProcExit", tree: b }, { type: "TreeChecked", ok: b }, { type: "Stop", tree: b });
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
  return out;
}

/** The model's action properties that the step from `s` to `n` breaks (empty: none). */
export function stepViolations(s: State, n: State): string[] {
  const out: string[] = [];
  if (s.proc === "open" && n.proc === "closed" && s.bg > 0) out.push("NoSleepWithBackground");
  if (s.run === "held" && n.run === "idle" && n.failed > s.failed && !n.tree) out.push("HeldFailsOnlyForLeftovers");
  return out;
}

/** What the app shows: the process the session is on, the run, the words by where they went, background work. */
export interface View {
  proc: Proc; tree: boolean; run: Run; keep: boolean; bg: number; checking: boolean; older: number;
  sent: number; read: number; held: number; lost: number; failed: number; stopped: number;
}

export const view = (s: State): View => ({ ...s });
