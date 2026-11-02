// spec/models/restart/Restart.tla as a TypeScript state machine: the same variables and actions under
// the same names. Pure: no app imports, no I/O. `next` lists every successor, as TLC would.
import type { RestartBlocked, RestartEntryState, RestartObservation, RestartPhase, RestartReason } from "../driver/restart-driver";

export type RestartMode = "running" | "prepared" | "stopping" | "down" | "recovering";
export type RestartStop = "idle" | "running" | "ok" | "failed";
export type RestartTry = "none" | "sent" | "failed";
export type RestartAction = "Start" | "Finish" | "Prepare" | "Cancel" | "BeginShutdown" | "Settle" | "Ready"
  | "Crash" | "Expire" | "Boot" | "Notice" | "Block" | "Claim" | "Deliver" | "Dispatch";
export const RECOVERY_ACTIONS: readonly RestartAction[] = ["Notice", "Block", "Claim", "Deliver", "Dispatch"];

export interface RestartConsts {
  bots: readonly string[];
  plugins: string;
  maxCrashes: number;
  /** The design before d678d161: one failed shutdown leaves the journal preparing. */
  bug: boolean;
}

type By<T> = Readonly<Record<string, T>>;
export interface RestartState {
  mode: RestartMode;
  busy: By<boolean>; own: By<boolean>;
  stop: By<RestartStop>;
  phase: RestartPhase;
  entry: By<RestartEntryState>;
  blk: By<RestartBlocked>;
  stale: boolean;
  mine: By<boolean>; try: By<RestartTry>; noted: By<boolean>;
  sent: By<number>; told: By<RestartReason | "none">;
  crashes: number; oldCrashed: boolean;
}

export interface RestartStep {
  action: RestartAction;
  bot?: string;
  part?: string;
  ok?: boolean;
  own?: boolean;
  state: RestartState;
}

const each = <T>(keys: readonly string[], value: (key: string) => T): By<T> => Object.fromEntries(keys.map((k) => [k, value(k)]));
const put = <T>(record: By<T>, key: string, value: T): By<T> => ({ ...record, [key]: value });
const parts = (c: RestartConsts) => [...c.bots, c.plugins];

export function init(c: RestartConsts): RestartState {
  return {
    mode: "running", busy: each(c.bots, () => false), own: each(c.bots, () => false),
    stop: each(parts(c), () => "idle"),
    phase: "none", entry: each(c.bots, () => "absent"), blk: each(c.bots, () => "none"), stale: false,
    mine: each(c.bots, () => false), try: each(c.bots, () => "none"), noted: each(c.bots, () => false),
    sent: each(c.bots, () => 0), told: each(c.bots, () => "none"),
    crashes: 0, oldCrashed: false,
  };
}

/** The journal's entries are the bots with work in flight now, each with its own blocker if any. */
const snapshot = (c: RestartConsts, s: RestartState) => ({
  entry: each(c.bots, (b): RestartEntryState => (s.busy[b] ? "pending" : "absent")),
  blk: each(c.bots, (b): RestartBlocked => (s.busy[b] && s.own[b] ? "own" : "none")),
});

const open = (s: RestartState, b: string) => s.entry[b] === "pending" || s.entry[b] === "claimed";

/** Why this entry must not be continued ("none": it may). */
export function reason(s: RestartState, b: string): RestartReason | "none" {
  if (s.try[b] === "failed") return "deliver";
  if (s.blk[b] !== "none") return s.blk[b] as RestartReason;
  if (s.stale) return "stale";
  if (s.phase !== "ready") return "unconfirmed";
  if (s.entry[b] === "claimed" && !s.mine[b]) return "uncertain";
  return "none";
}

export function next(c: RestartConsts, s: RestartState): RestartStep[] {
  const out: RestartStep[] = [];
  const go = (action: RestartAction, change: Partial<RestartState>, args: Omit<RestartStep, "action" | "state"> = {}) =>
    out.push({ action, ...args, state: { ...s, ...change } });
  // The old app.
  for (const b of c.bots) {
    if (s.mode === "running" && !s.busy[b]) for (const own of [false, true]) go("Start", { busy: put(s.busy, b, true), own: put(s.own, b, own) }, { bot: b, own });
    if ((s.mode === "running" || s.mode === "prepared") && s.busy[b]) go("Finish", { busy: put(s.busy, b, false), own: put(s.own, b, false) }, { bot: b });
  }
  if (s.mode === "running") go("Prepare", { mode: "prepared", phase: "preparing", ...snapshot(c, s) });
  if (s.mode === "prepared") {
    go("Cancel", { mode: "running", phase: "none", entry: each(c.bots, () => "absent"), blk: each(c.bots, () => "none") });
    go("BeginShutdown", { mode: "stopping", ...snapshot(c, s), stop: each(parts(c), () => "running") });
  }
  if (s.mode === "stopping") {
    for (const p of parts(c)) if (s.stop[p] === "running") for (const ok of [true, false]) go("Settle", { stop: put(s.stop, p, ok ? "ok" : "failed") }, { part: p, ok });
    if (parts(c).every((p) => s.stop[p] === "ok" || s.stop[p] === "failed")) {
      go("Ready", c.bug
        ? { mode: "down", phase: parts(c).every((p) => s.stop[p] === "ok") ? "ready" : "preparing" }
        : { mode: "down", phase: "ready", blk: each(c.bots, (b) => (s.entry[b] !== "absent" && s.stop[b] === "failed" && s.blk[b] === "none" ? "shutdown" : s.blk[b])) });
    }
  }
  // Between the two processes, and the new one.
  if (s.mode !== "down" && s.crashes < c.maxCrashes) {
    go("Crash", { mode: "down", crashes: s.crashes + 1, oldCrashed: s.oldCrashed || s.mode === "prepared" || s.mode === "stopping",
      mine: each(c.bots, () => false), try: each(c.bots, () => "none"), noted: each(c.bots, () => false) });
  }
  if (s.mode === "down" && s.phase !== "none" && !s.stale) go("Expire", { stale: true });
  if (s.mode === "down") go("Boot", { mode: "recovering" });
  if (s.mode === "recovering") {
    for (const b of c.bots) {
      const why = reason(s, b);
      if (open(s, b) && !s.noted[b] && why !== "none") go("Notice", { told: put(s.told, b, why), noted: put(s.noted, b, true) }, { bot: b });
      if (open(s, b) && s.noted[b]) go("Block", { entry: put(s.entry, b, "blocked"), blk: put(s.blk, b, s.try[b] === "failed" ? "deliver" : s.blk[b]) }, { bot: b });
      if (s.entry[b] === "pending" && why === "none") go("Claim", { entry: put(s.entry, b, "claimed"), mine: put(s.mine, b, true) }, { bot: b });
      if (s.entry[b] === "claimed" && s.mine[b] && s.try[b] === "none") {
        for (const ok of [true, false]) go("Deliver", { try: put(s.try, b, ok ? "sent" : "failed"), sent: put(s.sent, b, s.sent[b] + (ok ? 1 : 0)) }, { bot: b, ok });
      }
      if (s.entry[b] === "claimed" && s.try[b] === "sent") go("Dispatch", { entry: put(s.entry, b, "dispatched") }, { bot: b });
    }
  }
  return out;
}

/** The invariants of the model that `s` breaks (none: an empty list). */
export function violated(c: RestartConsts, s: RestartState): string[] {
  const cause = (b: string, r: RestartReason) => ({
    own: s.blk[b] === "own", shutdown: s.stop[b] === "failed", unconfirmed: s.oldCrashed,
    stale: s.stale, uncertain: s.crashes > 0, deliver: true,
  })[r];
  const checks: Record<string, (b: string) => boolean> = {
    AtMostOnce: (b) => s.sent[b] <= 1,
    OnlyRealWork: (b) => s.sent[b] === 0 || (s.busy[b] && !s.own[b] && s.stop[b] === "ok"),
    ConfirmedOnly: (b) => !(s.entry[b] === "claimed" || s.entry[b] === "dispatched") || s.phase === "ready",
    OthersNeverBlock: (b) => s.told[b] === "none" || cause(b, s.told[b] as RestartReason),
    BlockedIsTold: (b) => s.entry[b] !== "blocked" || s.told[b] !== "none",
  };
  return Object.keys(checks).filter((name) => !c.bots.every(checks[name]));
}

/** What the driver can see of `s`. */
export function observe(s: RestartState): RestartObservation {
  return { phase: s.phase, entry: { ...s.entry }, blk: { ...s.blk }, sent: { ...s.sent }, told: { ...s.told } };
}
