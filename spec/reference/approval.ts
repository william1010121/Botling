// The approval model (spec/models/approval/Approval.tla) as a pure TypeScript state machine: the same
// variables and actions. `Open` names whether a click was on its way (TLC picks it; a walk picks it here).
// SPEC_BUG=approval-swap or approval-noarm turns on the model's bugs.

export type Slot = string;
export type Cmd = string;
export type Folder = "own" | "other";
export type AskState = "idle" | "sent" | "toSheet" | "onSheet" | "answered";
export type Answer = "allowed" | "notAllowed" | "refused" | null;
export type Bug = "none" | "swap" | "noarm";

export interface Config { slots: Slot[]; cmds: Cmd[]; bug?: Bug }

export interface State {
  st: Record<Slot, AskState>;
  cmd: Record<Slot, Cmd | null>;
  fold: Record<Slot, Folder | null>;
  answer: Record<Slot, Answer>;
  sheet: Slot | null;
  armed: boolean;
  stray: boolean;
  seen: Cmd | null;
  approved: Cmd[];
  intended: Cmd[];
}

export type Action =
  | { type: "Ask"; a: Slot; c: Cmd; f: Folder }
  | { type: "CoreAsk"; a: Slot }
  | { type: "Open"; a: Slot; stray: boolean }
  | { type: "StrayClick" }
  | { type: "Arm" }
  | { type: "Allow" }
  | { type: "Cancel" };

export const bugFromEnv = (): Bug => {
  const bug = typeof process !== "undefined" ? process.env.SPEC_BUG : undefined;
  return bug === "approval-swap" ? "swap" : bug === "approval-noarm" ? "noarm" : "none";
};

const per = <T>(cfg: Config, value: T) => Object.fromEntries(cfg.slots.map((a) => [a, value])) as Record<Slot, T>;
const add = (set: Cmd[], c: Cmd) => (set.includes(c) ? set : [...set, c].sort());

export function init(cfg: Config): State {
  return { st: per(cfg, "idle"), cmd: per(cfg, null), fold: per(cfg, null), answer: per(cfg, null), sheet: null, armed: false, stray: false, seen: null, approved: [], intended: [] };
}

export function enabled(s: State, _cfg: Config, a: Action): boolean {
  switch (a.type) {
    case "Ask": return s.st[a.a] === "idle";
    case "CoreAsk": return s.st[a.a] === "sent";
    case "Open": return s.st[a.a] === "toSheet";
    case "StrayClick": return s.sheet !== null && s.stray;
    case "Arm": return s.sheet !== null && !s.armed && !s.stray;
    case "Allow": return s.sheet !== null && s.armed && s.seen !== null;
    case "Cancel": return s.sheet !== null;
  }
}

const answered = (s: State, a: Slot, v: Exclude<Answer, null>): State => ({ ...s, st: { ...s.st, [a]: "answered" }, answer: { ...s.answer, [a]: v } });
const closed = (s: State): State => ({ ...s, sheet: null, armed: false, stray: false, seen: null });

export function step(s: State, cfg: Config, a: Action): State {
  if (!enabled(s, cfg, a)) throw new Error(`${a.type} is not enabled`);
  const bug = cfg.bug ?? "none";
  switch (a.type) {
    case "Ask": return { ...s, st: { ...s.st, [a.a]: "sent" }, cmd: { ...s.cmd, [a.a]: a.c }, fold: { ...s.fold, [a.a]: a.f } };
    case "CoreAsk":
      if (s.fold[a.a] !== "own") return answered(s, a.a, "refused");
      if (s.approved.includes(s.cmd[a.a]!)) return answered(s, a.a, "allowed");
      return { ...s, st: { ...s.st, [a.a]: "toSheet" } };
    case "Open":
      if (s.sheet === null) return { ...s, st: { ...s.st, [a.a]: "onSheet" }, sheet: a.a, armed: false, stray: a.stray, seen: null };
      if (bug === "swap") return { ...answered(s, s.sheet, "notAllowed"), st: { ...s.st, [s.sheet]: "answered", [a.a]: "onSheet" }, sheet: a.a };
      return answered(s, a.a, "notAllowed");
    case "StrayClick":
      if (s.armed || bug === "noarm") return closed(answered({ ...s, approved: add(s.approved, s.cmd[s.sheet!]!) }, s.sheet!, "allowed"));
      return { ...s, stray: false };
    case "Arm": return { ...s, armed: true, seen: s.cmd[s.sheet!] };
    case "Allow": return closed(answered({ ...s, intended: add(s.intended, s.seen!), approved: add(s.approved, s.cmd[s.sheet!]!) }, s.sheet!, "allowed"));
    case "Cancel": return closed(answered(s, s.sheet!, "notAllowed"));
  }
}

export function actions(s: State, cfg: Config): Action[] {
  const all: Action[] = [{ type: "StrayClick" }, { type: "Arm" }, { type: "Allow" }, { type: "Cancel" }];
  for (const a of cfg.slots) {
    for (const c of cfg.cmds) for (const f of ["own", "other"] as const) all.push({ type: "Ask", a, c, f });
    all.push({ type: "CoreAsk", a }, { type: "Open", a, stray: false }, { type: "Open", a, stray: true });
  }
  return all.filter((a) => enabled(s, cfg, a));
}

/** The model's invariants that fail in `s` (empty: none). */
export function violations(s: State, cfg: Config): string[] {
  const out: string[] = [];
  if (!s.approved.every((c) => s.intended.includes(c))) out.push("OnlyIntended");
  if (!cfg.slots.every((a) => s.answer[a] !== "allowed" || (s.fold[a] === "own" && s.approved.includes(s.cmd[a]!)))) out.push("AnswerTruthful");
  if (s.sheet !== null && !(s.fold[s.sheet] === "own" && s.st[s.sheet] === "onSheet")) out.push("SheetIsCores");
  if (!cfg.slots.every((a) => (s.st[a] === "answered") === (s.answer[a] !== null))) out.push("AnsweredOnce");
  return out;
}

/** What can be seen from outside: the sheet's command and whether its Allow is live, what is allowed, what each ask heard. */
export interface View { sheet: Cmd | null; armed: boolean; approved: Cmd[]; answers: Record<Slot, Answer> }

export function view(s: State): View {
  return { sheet: s.sheet === null ? null : s.cmd[s.sheet]!, armed: s.armed, approved: [...s.approved], answers: { ...s.answer } };
}
