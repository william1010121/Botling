// An option card a called-in bot asks and the user's answer on it (spec/models/callin/RelayedCard.tla) as a pure
// TypeScript state machine: the same variables, the same actions under the same names, the same properties. Tests
// drive it beside the real Core (spec/tests/relayed-card.spec.test.ts). No app imports.
// SPEC_BUG=card-callee (before 505457a0: an answer on a relayed copy goes to the bot that asked), card-open (the
// original stays open when its copy is answered), card-keepcopy (removing the bot leaves its relayed copies open) or
// card-ignoregone (that, and ignoring such a copy is refused: before 3a2d13fa) turns on the model's bug.

export type Bug = "none" | "callee" | "open" | "keepcopy" | "ignoregone";
export type Kind = "guest" | "relayed";
export type Chat = "P" | "S";
export type LineState = "open" | "settled" | "none";

export interface Config { maxCards: number; bug?: Bug }

export interface CardState {
  kind: Kind; line: Record<Chat, LineState>; at: "none" | Chat; answers: number; woke: Record<Chat, number>; told: boolean;
}

export interface State {
  cards: CardState[]; s: "idle" | "own" | "guest"; queued: number; calls: number[]; gone: boolean; refused: boolean;
}

/** Cards are numbered from 1, as in the model. */
export type Action =
  | { type: "Ask"; kind: Kind } | { type: "Answer"; k: number; c: Chat } | { type: "Ignore"; k: number; c: Chat }
  | { type: "Work" } | { type: "EndTurn" } | { type: "Remove" };

export const bugFromEnv = (): Bug => {
  const bug = typeof process !== "undefined" ? process.env.SPEC_BUG : undefined;
  return bug === "card-callee" ? "callee" : bug === "card-open" ? "open" : bug === "card-keepcopy" ? "keepcopy"
    : bug === "card-ignoregone" ? "ignoregone" : "none";
};
const bugOf = (cfg: Config): Bug => cfg.bug ?? bugFromEnv();

export function init(_cfg: Config): State {
  return { cards: [], s: "idle", queued: 0, calls: [], gone: false, refused: false };
}

const card = (s: State, k: number) => s.cards[k - 1];

export function enabled(s: State, cfg: Config, a: Action): boolean {
  switch (a.type) {
    case "Ask": return !s.gone && s.s === "idle" && s.queued === 0 && s.calls.length === 0 && s.cards.length < cfg.maxCards;
    case "Answer": case "Ignore": { const c = card(s, a.k); return !!c && c.line[a.c] === "open" && (a.c === "P" || !s.gone); }
    case "Work": return !s.gone && s.s === "idle" && s.queued === 0 && s.calls.length === 0;
    case "EndTurn": return s.s !== "idle";
    case "Remove": return !s.gone && s.s === "idle" && s.queued === 0 && s.calls.length === 0;
  }
}

/** Card k with `change` applied (a copy of the cards). */
const withCard = (s: State, k: number, change: (c: CardState) => CardState): CardState[] =>
  s.cards.map((c, i) => (i === k - 1 ? change(c) : c));
const settle = (c: CardState, ...chats: Chat[]): CardState => {
  const line = { ...c.line };
  for (const chat of chats) line[chat] = "settled";
  return { ...c, line };
};
const accept = (c: CardState, at: Chat): CardState => ({ ...c, at, answers: c.answers + 1 });
const wake = (c: CardState, b: Chat): CardState => ({ ...c, woke: { ...c.woke, [b]: c.woke[b] + 1 } });

/** The answer as a call-in for S in P's chat: runs now, waits behind the one under way, or gives up. */
function callIn(s: State, k: number, settled: CardState): State {
  if (s.s === "idle") return { ...s, s: "guest", cards: withCard(s, k, () => wake(settled, "S")) };
  if (s.s === "guest") return { ...s, calls: [...s.calls, k], cards: withCard(s, k, () => settled) };
  return { ...s, cards: withCard(s, k, () => ({ ...settled, told: true })) };
}

export function step(s: State, cfg: Config, a: Action): State {
  if (!enabled(s, cfg, a)) throw new Error(`${a.type} is not enabled`);
  const bug = bugOf(cfg);
  switch (a.type) {
    case "Ask": return {
      ...s, cards: [...s.cards, { kind: a.kind, line: { P: "open", S: a.kind === "relayed" ? "open" : "none" }, at: "none", answers: 0, woke: { P: 0, S: 0 }, told: false }],
    };
    case "Answer": {
      const c = card(s, a.k)!;
      if (a.c === "S") {
        const n = { ...s, cards: withCard(s, a.k, () => wake(accept(settle(c, "S", "P"), "S"), "S")) };
        return s.s === "idle" ? { ...n, s: "own" } : { ...n, queued: s.queued + 1 };
      }
      if (c.kind === "relayed" && bug !== "callee") {
        const settled = bug === "open" || s.gone ? settle(c, "P") : settle(c, "P", "S");
        return { ...s, cards: withCard(s, a.k, () => wake(accept(settled, "P"), "P")) };
      }
      if (s.gone) return { ...s, cards: withCard(s, a.k, () => settle(c, "P")) };
      return callIn(s, a.k, accept(c.kind === "relayed" ? settle(c, "P", "S") : settle(c, "P"), "P"));
    }
    case "Ignore": {
      const c = card(s, a.k)!;
      if (c.kind === "relayed" && a.c === "P" && s.gone && bug === "ignoregone") return { ...s, refused: true };
      return { ...s, cards: withCard(s, a.k, () => (c.kind === "relayed" && !s.gone ? settle(c, "P", "S") : settle(c, a.c))) };
    }
    case "Work": return { ...s, s: "own" };
    case "EndTurn": {
      if (s.queued > 0) {
        return { ...s, s: "own", queued: s.queued - 1, calls: [], cards: s.cards.map((c, i) => (s.calls.includes(i + 1) ? { ...c, told: true } : c)) };
      }
      if (s.calls.length) {
        const [head, ...rest] = s.calls;
        return { ...s, s: "guest", calls: rest, cards: withCard(s, head!, (c) => wake(c, "S")) };
      }
      return { ...s, s: "idle" };
    }
    case "Remove": {
      // Its relayed copies in P's chat are settled ("No longer needed"), unless the bug keeps them.
      if (bug === "keepcopy" || bug === "ignoregone") return { ...s, gone: true };
      return { ...s, gone: true, cards: s.cards.map((c) => (c.kind === "relayed" && c.line.P === "open" ? settle(c, "P") : c)) };
    }
  }
}

export function actions(s: State, cfg: Config): Action[] {
  const all: Action[] = [{ type: "Ask", kind: "guest" }, { type: "Ask", kind: "relayed" }, { type: "Work" }, { type: "EndTurn" }, { type: "Remove" }];
  for (let k = 1; k <= s.cards.length; k++) {
    for (const c of ["P", "S"] as Chat[]) all.push({ type: "Answer", k, c }, { type: "Ignore", k, c });
  }
  return all.filter((a) => enabled(s, cfg, a));
}

/** The bot an answer on the card is for: the one that asked a guest line; on a relayed card, the bot of the chat. */
const forBot = (c: CardState): "none" | Chat => (c.kind === "guest" ? "S" : c.at);

/** The model's invariants that fail in `s` (empty: none). */
export function violations(s: State): string[] {
  const out = new Set<string>();
  for (const c of s.cards) {
    if (c.answers > 1) out.add("AnsweredOnce");
    if (c.woke.P + c.woke.S + (c.told ? 1 : 0) > c.answers) out.add("OneWakePerAnswer");
    for (const b of ["P", "S"] as Chat[]) if (c.woke[b] > 0 && b !== forBot(c)) out.add("WakesItsBot");
    if (c.kind === "relayed" && !s.gone && c.line.P !== c.line.S) out.add("BothShowIt");
    if (c.at !== "none" && c.line[c.at] !== "settled") out.add("AnsweredIsSettled");
  }
  if (s.refused) out.add("IgnoreNeverRefused");
  if (s.gone && s.cards.some((c) => c.kind === "relayed" && c.line.P === "open")) out.add("NoCopyOfGone");
  if (s.calls.length && s.s !== "guest") out.add("CallsWait");
  return [...out];
}

/** What the app shows: each card's lines (S's chat only while it is there), the turns its answer handed each bot, its
 * answer's call-in given up; S's turn, its queue, the call-ins waiting in P's chat; S removed; an ignore refused. */
export interface View {
  cards: { kind: Kind; P: LineState; S: LineState | null; woke: Record<Chat, number> }[];
  s: State["s"]; queued: number; calls: number; told: number; gone: boolean; refused: boolean;
}

export const view = (s: State): View => ({
  cards: s.cards.map((c) => ({ kind: c.kind, P: c.line.P, S: s.gone ? null : c.line.S, woke: { ...c.woke } })),
  s: s.s, queued: s.queued, calls: s.calls.length, told: s.cards.filter((c) => c.told).length, gone: s.gone, refused: s.refused,
});
