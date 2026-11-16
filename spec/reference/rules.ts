// spec/models/rules/OrchestrationRules.tla in TypeScript: the orchestration rules a plugin gives, and core's own when it
// cannot (M7-O04, desktop/src/core/orchestration/plugin-rules.ts `OrchestrationRulesBook`). Same variables, same steps, same
// bugs; `explore` in spec/tests/rules.spec.test.ts checks it has the model's state space.

export type Src = "good" | "edited" | "throws" | "hangs";
export type Rules = "core" | "plugin" | "edited";
export type Bug = "none" | "nopin" | "keeplast" | "notimeout" | "await" | "noticeeach" | "silent";
export const SRCS: readonly Src[] = ["good", "edited", "throws", "hangs"];

export interface Config { maxTurns: number; maxBreaks: number; start: Src; bug: Bug }

export interface State {
  src: Src; rules: Rules; flight: "none" | Src; say: boolean; told: boolean; said: number;
  last: "none" | "ok" | "failed"; turns: number; waiting: number; used: "none" | Rules; breaks: number;
}

export type Action =
  | { type: "Send"; say: boolean }
  | { type: "Answer" }
  | { type: "Timeout" }
  | { type: "StartWaiting" }
  | { type: "Break"; s: Src };

export const init = (cfg: Config): State => ({
  src: cfg.start, rules: "core", flight: "none", say: false, told: false, said: 0, last: "none", turns: 0, waiting: 0, used: "none", breaks: 0,
});

export function enabled(s: State, cfg: Config, a: Action): boolean {
  switch (a.type) {
    case "Send": return s.turns < cfg.maxTurns;
    case "Answer": return s.flight === "good" || s.flight === "edited" || s.flight === "throws";
    case "Timeout": return s.flight !== "none" && cfg.bug !== "notimeout";
    case "StartWaiting": return s.waiting > 0 && s.flight === "none";
    case "Break": return s.breaks < cfg.maxBreaks && a.s !== s.src;
  }
}

export function actions(s: State, cfg: Config): Action[] {
  const all: Action[] = [{ type: "Send", say: false }, { type: "Send", say: true }, { type: "Answer" }, { type: "Timeout" }, { type: "StartWaiting" },
    ...SRCS.map((src): Action => ({ type: "Break", s: src }))];
  return all.filter((a) => enabled(s, cfg, a));
}

const fail = (s: State, cfg: Config): State => {
  const rules = cfg.bug === "keeplast" ? s.rules : "core";
  if (cfg.bug === "noticeeach") return { ...s, rules, last: "failed", said: s.say ? s.said + 1 : s.said };
  if (!s.told && s.say && cfg.bug !== "silent") return { ...s, rules, last: "failed", told: true, said: s.said + 1 };
  return { ...s, rules, last: "failed" };
};
const take = (s: State, text: Rules): State => ({ ...s, rules: text, last: "ok", said: 0, told: false });
const done = (s: State): State => ({ ...s, flight: "none", say: false });

export function step(s: State, cfg: Config, a: Action): State {
  if (!enabled(s, cfg, a)) throw new Error(`${a.type} is not enabled`);
  switch (a.type) {
    case "Send": {
      const n = { ...s, turns: s.turns + 1, say: s.say || a.say, flight: s.flight === "none" ? s.src : s.flight };
      return cfg.bug === "await" ? { ...n, waiting: s.waiting + 1 } : { ...n, used: s.rules };
    }
    case "Answer":
      return done(s.flight === "good" ? take(s, "plugin") : s.flight === "edited" && cfg.bug === "nopin" ? take(s, "edited") : fail(s, cfg));
    case "Timeout": return done(fail(s, cfg));
    case "StartWaiting": return { ...s, waiting: s.waiting - 1, used: s.rules };
    case "Break": return { ...s, src: a.s, breaks: s.breaks + 1 };
  }
}

/** The invariants that fail in `s`. */
export function violations(s: State): string[] {
  const out: string[] = [];
  if (!(s.rules === "core" || s.rules === "plugin") || s.used === "edited") out.push("OnlyPinned");
  if (s.last === "failed" && s.rules !== "core") out.push("CoreAfterFailure");
  if (s.waiting !== 0) out.push("NeverWaits");
  if (s.said > 1) out.push("ToldOnce");
  return out;
}

/** The action properties a step from `s` to `n` breaks. */
export function stepViolations(s: State, n: State): string[] {
  return s.flight !== "none" && n.flight === "none" && n.last === "failed" && s.say && !s.told && n.said !== s.said + 1 ? ["SaysIt"] : [];
}

/** What the app shows of a state: the set, whether an ask is under way, the notices, the set the last turn took. */
export interface View { rules: Rules; asking: boolean; said: number; used: "none" | Rules }
export const view = (s: State): View => ({ rules: s.rules, asking: s.flight !== "none", said: s.said, used: s.used });
