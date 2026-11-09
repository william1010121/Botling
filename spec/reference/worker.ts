// The worker lifecycle and report delivery (spec/models/worker/Worker.tla) as a pure TypeScript state machine: the
// same records, the same actions under the same names, the same invariants. Tests drive it beside the real
// WorkerCore (spec/tests/worker.spec.test.ts) and replay the app's trace lines through it. No app imports.
//
// SPEC_BUG=worker turns on the model's bug switch (StaleQueuedOps, the race 3910341f fixed): a stop or cancel that
// waited for the worker acts on whatever run is current when it gets it. SPEC_BUG=worker-steer: a late steer reply acts
// on whatever run is current (before eae248aa); SPEC_BUG=worker-followup: the coordinator's turn on a report of a
// worker started for another bot's @ is posted back only when it ends with words (before this model's fix).

export type Status = "new" | "running" | "done" | "failed" | "stopped" | "interrupted";
export type Report = "none" | "pending" | "dispatching" | "delivered" | "acknowledged" | "unresolved" | "routed";
export type Op = "idle" | "start" | "stop" | "recoverSend" | "recoverCancel";
export type Ack = "none" | "checkpoint";
export type Chip = "running" | "completed" | "failed" | "killed" | "interrupted";

export interface Rec {
  status: Status; run: number; rep: Report; tries: number; queued: boolean; active: boolean;
  cleanup: "none" | "pending" | "failed"; recovery: boolean; stale: boolean; op: Op;
  pend: { kind: "none" | "stop" | "cancel"; target: number }; owned: boolean;
  /** The run whose steer answer is awaited (0: none). */
  steer: number;
  /** Notes sent (app_notify_owner), and to whom the last went. */
  nsent: number; noted: "none" | "coord" | "other";
  /** The follow-up route of a worker started for another bot's @ (callInWork). */
  link: "none" | "live" | "expired";
  /** The coordinator's turns under way on this worker's reports / notes whose reply goes back to the asking bot. */
  relays: number; nturns: number;
  /** Such turns handed over, and follow-ups posted in the asking bot's chat, in all. */
  handed: number; posted: number;
  /** A run ended whose report the asking bot has not had yet. */
  due: boolean;
}
export interface State { wk: Rec[]; crashes: number }
export type Bug = "none" | "steer" | "followup";
export interface Config {
  workers: number; maxRun: number; maxCrash: number; ack: Ack; staleQueuedOps?: boolean;
  /** Workers may be linked to another bot's @ (default true), and notes per worker (default 1). */
  followUp?: boolean; maxNotes?: number; bug?: Bug;
}

export type Action =
  | { type: "Handoff"; w: number } | { type: "StartDone"; w: number } | { type: "Send"; w: number }
  | { type: "Steer"; w: number } | { type: "RecoverDone"; w: number } | { type: "StopWorker"; w: number }
  | { type: "Cancel"; w: number } | { type: "StopDone"; w: number; ok: boolean } | { type: "End"; w: number; v: "done" | "failed" }
  | { type: "Exit"; w: number } | { type: "Deliver"; w: number; how: "taken" | "queued" } | { type: "BeginReport"; w: number }
  | { type: "FinishReport"; w: number; completed: boolean } | { type: "RetryUncertain"; w: number }
  | { type: "Checkpoint"; w: number } | { type: "SetOwner"; w: number } | { type: "Crash" }
  | { type: "SteerBack"; w: number; missed: boolean } | { type: "Note"; w: number } | { type: "Link"; w: number }
  | { type: "Expire"; w: number } | { type: "TurnEnd"; w: number; kind: "report" | "note"; said: boolean };

const ENV_BUG = typeof process !== "undefined" ? process.env.SPEC_BUG : undefined;
export const SPEC_BUG = ENV_BUG === "worker";
const bugOf = (cfg: Config): Bug => cfg.bug ?? (ENV_BUG === "worker-steer" ? "steer" : ENV_BUG === "worker-followup" ? "followup" : "none");
const ENDED: readonly Status[] = ["done", "failed", "stopped", "interrupted"];
const ended = (s: Status) => ENDED.includes(s);
const NO_PEND: Rec["pend"] = { kind: "none", target: 0 };
export const maxShows = (cfg: Config) => (cfg.ack === "none" ? 1 : 2);

export function init(cfg: Config): State {
  const fresh = (): Rec => ({
    status: "new", run: 0, rep: "none", tries: 0, queued: false, active: false, cleanup: "none", recovery: false, stale: false, op: "idle", pend: { ...NO_PEND }, owned: false,
    steer: 0, nsent: 0, noted: "none", link: "none", relays: 0, nturns: 0, handed: 0, posted: 0, due: false,
  });
  return { wk: Array.from({ length: cfg.workers }, fresh), crashes: 0 };
}

export function chip(r: Rec): Chip {
  if (r.cleanup === "failed" || (r.rep === "unresolved" && (r.status === "done" || r.status === "failed"))) return "failed";
  switch (r.status) {
    case "running": return "running";
    case "done": return "completed";
    case "failed": return "failed";
    case "interrupted": return "interrupted";
    default: return "killed";
  }
}

// What a step does to one record (Worker.tla's operators of the same names).
const launch = (r: Rec): Rec => ({ ...r, run: r.run + 1, status: "running", rep: "none", tries: 0, queued: false, active: false, op: "start", due: false });
const doStop = (r: Rec): Rec => ({ ...r, status: "stopped", rep: "none", tries: 0, cleanup: "pending", stale: true, op: "stop", steer: 0 });
const cancelClean = (r: Rec): Rec => ({
  ...r, rep: r.rep === "pending" || r.rep === "delivered" ? "none" : r.rep, queued: false, active: false, cleanup: "pending", op: "stop", steer: 0,
  due: r.rep === "pending" ? false : r.due,
});
function body(r: Rec, kind: "stop" | "cancel", target: number, cfg: Config): Rec {
  if (!(cfg.staleQueuedOps ?? SPEC_BUG) && (r.run !== target || (kind === "cancel" && r.owned))) return r;
  if (r.status === "running") return doStop(r);
  if (kind === "stop") return r;
  if (r.recovery) return { ...r, op: "recoverCancel" };
  return cancelClean(r);
}
const free = (r: Rec, cfg: Config): Rec =>
  r.pend.kind === "none" ? { ...r, op: "idle" } : body({ ...r, op: "idle", pend: { ...NO_PEND } }, r.pend.kind, r.pend.target, cfg);
const offer = (r: Rec): Rec => (r.owned && r.rep === "pending" ? { ...r, rep: "routed" } : r);
const relay = (r: Rec): Rec => (r.link === "live" ? { ...r, relays: r.relays + 1, handed: r.handed + 1, due: false } : r);
const undecided = (r: Rec): Rec => ({ ...r, tries: r.tries + 1, rep: r.tries < 1 ? "pending" : "unresolved" });
function load(r: Rec): Rec {
  const b: Rec = { ...r, op: "idle", pend: { ...NO_PEND }, queued: false, active: false, steer: 0, relays: 0, nturns: 0 };
  if (r.status === "running") return { ...b, status: "interrupted", recovery: true, stale: true, rep: "none", tries: 0 };
  if (r.cleanup === "pending") return { ...b, cleanup: "none", recovery: true };
  return b;
}

/** The record after action `a` on its worker, or null when `a` is not enabled. */
function next(r: Rec, a: Exclude<Action, { type: "Crash" }>, cfg: Config): Rec | null {
  switch (a.type) {
    case "Handoff": return r.status === "new" ? launch(r) : null;
    case "StartDone": return r.op === "start" ? free(r, cfg) : null;
    case "Send":
      if (!ended(r.status) || r.op !== "idle" || r.cleanup === "pending" || r.run >= cfg.maxRun) return null;
      return r.recovery ? { ...r, op: "recoverSend" } : launch(r);
    case "Steer": return r.status === "running" && r.op === "idle" && r.steer === 0 ? { ...r, steer: r.run } : null;
    case "SteerBack": {
      if (r.steer === 0) return null;
      const c: Rec = { ...r, steer: 0 };
      const acts = a.missed && (bugOf(cfg) === "steer" || r.steer === r.run) && ended(r.status) && r.op === "idle" && r.cleanup !== "pending";
      if (!acts) return c;
      if (r.run >= cfg.maxRun) return null;
      return r.recovery ? { ...c, op: "recoverSend" } : launch(c);
    }
    case "Note": {
      if (r.status !== "running" || r.nsent >= (cfg.maxNotes ?? 1)) return null;
      const n: Rec = { ...r, nsent: r.nsent + 1, noted: r.owned ? "other" : "coord" };
      return !r.owned && r.link === "live" ? { ...n, nturns: n.nturns + 1, handed: n.handed + 1 } : n;
    }
    case "Link": return (cfg.followUp ?? true) && r.status === "running" && !r.owned && r.link !== "live" ? { ...r, link: "live" } : null;
    case "Expire": return r.link === "live" ? { ...r, link: "expired", due: false, relays: 0, nturns: 0 } : null;
    case "TurnEnd": {
      if (a.kind === "report" ? r.relays === 0 : r.nturns === 0) return null;
      const post = a.said || (a.kind === "report" && bugOf(cfg) !== "followup");
      const t: Rec = a.kind === "report" ? { ...r, relays: r.relays - 1 } : { ...r, nturns: r.nturns - 1 };
      return post ? { ...t, posted: t.posted + 1 } : t;
    }
    case "RecoverDone": {
      if (r.op !== "recoverSend" && r.op !== "recoverCancel") return null;
      if (r.stale) return free(r, cfg);
      const c: Rec = { ...r, recovery: false, cleanup: "none" };
      return r.op === "recoverSend" ? launch(c) : cancelClean(c);
    }
    case "StopWorker": case "Cancel": {
      if (a.type === "Cancel" && r.owned) return null;
      if (r.status === "new" || r.pend.kind !== "none") return null;
      const kind = a.type === "Cancel" ? "cancel" : "stop";
      return r.op === "idle" ? body(r, kind, r.run, cfg) : { ...r, pend: { kind, target: r.run } };
    }
    case "StopDone":
      if (r.op !== "stop" || !(a.ok || r.stale)) return null;
      return free(a.ok ? { ...r, cleanup: "none", stale: false } : { ...r, cleanup: "failed", recovery: true }, cfg);
    case "End":
      if (r.status !== "running" || r.op !== "idle") return null;
      return offer({ ...r, status: a.v, rep: "pending", tries: 0, due: r.link === "live" && !r.owned });
    case "Exit": return r.stale ? { ...r, stale: false } : null;
    case "Deliver":
      if (a.how === "queued" && cfg.ack !== "checkpoint") return null;
      if (r.rep !== "pending" || r.owned || r.queued || r.cleanup === "pending") return null;
      return a.how === "queued" ? { ...r, queued: true } : relay({ ...r, tries: r.tries + 1, rep: cfg.ack === "none" ? "acknowledged" : "delivered" });
    case "BeginReport":
      if (!r.queued || r.rep !== "pending" || r.owned || r.tries >= 2 || r.cleanup === "pending") return null;
      return relay({ ...r, queued: false, rep: "dispatching", active: true });
    case "FinishReport": {
      if (!r.active) return null;
      const done: Rec = { ...r, active: false };
      return a.completed && done.rep === "dispatching" ? undecided(done) : done;
    }
    case "RetryUncertain": return r.rep === "dispatching" && !r.active ? undecided(r) : null;
    case "Checkpoint":
      if (r.owned || !ended(r.status) || r.cleanup === "pending") return null;
      if (!(r.active || r.rep === "delivered" || r.rep === "unresolved" || (r.rep === "pending" && r.tries > 0))) return null;
      return { ...r, rep: "acknowledged", active: false, queued: false };
    case "SetOwner": {
      if (r.owned || r.status === "new" || r.rep === "dispatching" || r.active) return null;
      const moves = r.status !== "running" && r.cleanup !== "pending" && (r.rep === "pending" || r.rep === "delivered" || r.rep === "unresolved");
      return offer({ ...r, owned: true, rep: moves ? "pending" : r.rep, queued: moves ? false : r.queued, due: false });
    }
  }
}

/** The state after `a`, or null when it is not enabled in `s`. */
export function step(s: State, a: Action, cfg: Config): State | null {
  if (a.type === "Crash") return s.crashes < cfg.maxCrash ? { wk: s.wk.map(load), crashes: s.crashes + 1 } : null;
  const r = s.wk[a.w];
  const after = r && next(r, a, cfg);
  return after ? { ...s, wk: s.wk.map((x, i) => (i === a.w ? after : x)) } : null;
}

/** Every action of the model, enabled or not, for `cfg`'s workers. */
export function actions(cfg: Config): Action[] {
  const all: Action[] = [{ type: "Crash" }];
  for (let w = 0; w < cfg.workers; w++) {
    for (const type of ["Handoff", "StartDone", "Send", "Steer", "RecoverDone", "StopWorker", "Cancel", "Exit", "BeginReport", "RetryUncertain", "Checkpoint", "SetOwner", "Note", "Link", "Expire"] as const) all.push({ type, w });
    all.push({ type: "SteerBack", w, missed: false }, { type: "SteerBack", w, missed: true });
    for (const kind of ["report", "note"] as const) all.push({ type: "TurnEnd", w, kind, said: true }, { type: "TurnEnd", w, kind, said: false });
    all.push({ type: "StopDone", w, ok: true }, { type: "StopDone", w, ok: false }, { type: "End", w, v: "done" }, { type: "End", w, v: "failed" });
    all.push({ type: "Deliver", w, how: "taken" }, { type: "Deliver", w, how: "queued" }, { type: "FinishReport", w, completed: true }, { type: "FinishReport", w, completed: false });
  }
  return all;
}

export const enabled = (s: State, cfg: Config): Action[] => actions(cfg).filter((a) => step(s, a, cfg) !== null);

// ------------------------------------------------------------------------------------------------
// Properties (Worker.tla's, by name)

export const invariants: Record<string, (s: State, cfg: Config) => boolean> = {
  OneLiveRun: (s) => s.wk.every((r) => r.status !== "running" || !r.stale),
  StaleIsGuarded: (s) => s.wk.every((r) => !r.stale || r.recovery || r.cleanup === "pending"),
  OwedOnlyEnded: (s) => s.wk.every((r) => !["pending", "dispatching", "delivered"].includes(r.rep) || r.status === "done" || r.status === "failed"),
  NoFalseFailed: (s) => s.wk.every((r) => r.status !== "done" || chip(r) === "completed" || r.cleanup === "failed" || r.rep === "unresolved"),
  DueIsPending: (s) => s.wk.every((r) => !r.due || (r.rep === "pending" && r.link === "live" && !r.owned)),
  TurnsOnLiveRoute: (s) => s.wk.every((r) => r.relays + r.nturns === 0 || r.link === "live"),
  FollowUpOnce: (s) => s.wk.every((r) => r.posted + r.relays + r.nturns <= r.handed),
};
const owed = (r: Rec) => r.link === "live" && (r.due || r.relays > 0);

const shown = (r: Rec, r2: Rec) => r.rep === "pending" && (r2.rep === "delivered" || r2.rep === "acknowledged" || r2.rep === "dispatching");

export const actionProperties: Record<string, (s: State, t: State, cfg: Config) => boolean> = {
  OneTerminal: (s, t) => s.wk.every((r, i) => !ended(r.status) || t.wk[i]!.run !== r.run || t.wk[i]!.status === r.status),
  NoStaleOp: (s, t) => s.wk.every((r, i) => {
    const r2 = t.wk[i]!;
    const consumed = r.pend.kind !== "none" && r2.pend.kind === "none" && t.crashes === s.crashes && r.pend.target !== r2.run;
    return !consumed || (r2.status === r.status && r2.rep === r.rep);
  }),
  ReportAtMostOnce: (s, t, cfg) => s.wk.every((r, i) => !shown(r, t.wk[i]!) || (r.tries < maxShows(cfg) && !r.owned && t.wk[i]!.run === r.run)),
  // Read off the step: a steer answer (the awaited steer cleared without a stop, cancel or crash) of an earlier run.
  NoStaleSteer: (s, t) => s.wk.every((r, i) => {
    const r2 = t.wk[i]!;
    const answered = r.steer !== 0 && r2.steer === 0 && t.crashes === s.crashes && r.steer !== r.run && r2.cleanup !== "pending";
    return !answered || (r2.run === r.run && r2.rep === r.rep);
  }),
  NoteToOwner: (s, t) => s.wk.every((r, i) => t.wk[i]!.nsent <= r.nsent || (r.status === "running" && t.wk[i]!.noted === (r.owned ? "other" : "coord"))),
  PostOncePerTurn: (s, t) => s.wk.every((r, i) => {
    const r2 = t.wk[i]!;
    return r2.posted === r.posted || (r2.posted === r.posted + 1 && r.link === "live" && r2.relays + r2.nturns === r.relays + r.nturns - 1);
  }),
  OwedEndsByPost: (s, t) => s.wk.every((r, i) => {
    const r2 = t.wk[i]!;
    return !owed(r) || owed(r2) || r2.posted > r.posted || r2.link !== "live" || r2.owned || t.crashes > s.crashes || (r.rep === "pending" && r2.rep === "none");
  }),
};

/** The names of the properties `s` → `t` breaks (empty: none). */
export function violations(s: State, t: State, cfg: Config): string[] {
  return [
    ...Object.entries(invariants).filter(([, holds]) => !holds(t, cfg)).map(([name]) => name),
    ...Object.entries(actionProperties).filter(([, holds]) => !holds(s, t, cfg)).map(([name]) => name),
  ];
}
