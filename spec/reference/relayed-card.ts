// An option card a called-in bot asks and the user's answer on it (spec/models/callin/RelayedCard.tla) as a pure
// TypeScript state machine: the same variables, the same actions under the same names, the same properties. Tests
// drive it beside the real Core (spec/tests/relayed-card.spec.test.ts). No app imports.
// It is the model's instance Steers = FALSE: the adapter's bots have no agent, so nothing is read into a turn under
// way; an answer for S at work is queued. TLC checks the steered answers (RelayedCard.cfg).
// SPEC_BUG=card-callee (before 505457a0: an answer on a relayed copy goes to the bot that asked), card-open (the
// original stays open when its copy is answered), card-keepcopy (removing the bot leaves its relayed copies open),
// card-ignoregone (that, and ignoring such a copy is refused: before 3a2d13fa) or card-giveup (an answer on a guest
// line is a call-in that gives up when the bot is at work, and the card shows it chosen at once) turns on the bug.

export type Bug = "none" | "callee" | "open" | "keepcopy" | "ignoregone" | "giveup";
export type Kind = "guest" | "relayed";
export type Chat = "P" | "S";
export type LineState = "open" | "pending" | "settled" | "none";

export interface Config { maxCards: number; maxTries?: number; bug?: Bug }

export interface CardState {
  kind: Kind; line: Record<Chat, LineState>; at: "none" | Chat; answers: number; woke: Record<Chat, number>; told: boolean;
  fails: number; noted: boolean; shows: boolean;
}

export interface State {
  cards: CardState[]; s: "idle" | "own" | "guest"; queue: number[]; calls: number[]; gone: boolean; refused: boolean;
}

/** Cards are numbered from 1, as in the model; Drop's `i` is a place in S's queue, from 1. */
export type Action =
  | { type: "Ask"; kind: Kind } | { type: "Answer"; k: number; c: Chat } | { type: "Ignore"; k: number; c: Chat }
  | { type: "Drop"; i: number } | { type: "Work" } | { type: "EndTurn" } | { type: "Remove" };

const BUGS: Record<string, Bug> = {
  "card-callee": "callee", "card-open": "open", "card-keepcopy": "keepcopy", "card-ignoregone": "ignoregone", "card-giveup": "giveup",
};
export const bugFromEnv = (): Bug => {
  const bug = typeof process !== "undefined" ? process.env.SPEC_BUG : undefined;
  return (bug && BUGS[bug]) || "none";
};
const bugOf = (cfg: Config): Bug => cfg.bug ?? bugFromEnv();
const triesOf = (cfg: Config) => cfg.maxTries ?? 2;
/** Before the fix: an answer on a guest line is a call-in that gives up when S is at work. */
const old = (bug: Bug) => bug === "giveup" || bug === "callee";

export function init(_cfg: Config): State {
  return { cards: [], s: "idle", queue: [], calls: [], gone: false, refused: false };
}

const card = (s: State, k: number) => s.cards[k - 1];
const quiet = (s: State) => s.s === "idle" && s.queue.length === 0 && s.calls.length === 0;

export function enabled(s: State, cfg: Config, a: Action): boolean {
  switch (a.type) {
    case "Ask": return !s.gone && quiet(s) && s.cards.length < cfg.maxCards;
    case "Answer": { const c = card(s, a.k); return !!c && c.line[a.c] === "open" && (a.c === "P" || !s.gone) && c.answers < triesOf(cfg); }
    case "Ignore": { const c = card(s, a.k); return !!c && c.line[a.c] === "open" && (a.c === "P" || !s.gone); }
    case "Drop": { const k = s.queue[a.i - 1]; return k !== undefined && card(s, k)!.kind === "guest"; }
    case "Work": return !s.gone && quiet(s);
    case "EndTurn": return s.s !== "idle";
    case "Remove": return !s.gone && s.s !== "guest" && s.calls.length === 0;
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
/** A guest line whose answer reached S: settled, shown as chosen. */
const reached = (c: CardState): CardState => ({ ...wake(settle(c, "P"), "S"), shows: true });
/** An answer that never reached S: a guest line opens again and says so. */
const failed = (c: CardState): CardState =>
  (c.kind === "guest" ? { ...c, fails: c.fails + 1, line: { ...c.line, P: "open" }, noted: true } : { ...c, fails: c.fails + 1 });

/** Before the fix: the answer as a call-in for S in P's chat: runs now, waits behind the one under way, or gives up. */
function oldCallIn(s: State, k: number, settled: CardState): State {
  if (s.s === "idle") return { ...s, s: "guest", cards: withCard(s, k, () => wake(settled, "S")) };
  if (s.s === "guest") return { ...s, calls: [...s.calls, k], cards: withCard(s, k, () => settled) };
  return { ...s, cards: withCard(s, k, () => ({ ...settled, told: true })) };
}

/** A message for S in its own chat carrying card k's answer (`c`, already accepted): a turn now, or queued. */
function toS(s: State, k: number, c: CardState, onReach: (c: CardState) => CardState, onQueue: (c: CardState) => CardState): State {
  if (s.s === "idle") return { ...s, s: "own", cards: withCard(s, k, () => onReach(c)) };
  return { ...s, queue: [...s.queue, k], cards: withCard(s, k, () => onQueue(c)) };
}

export function step(s: State, cfg: Config, a: Action): State {
  if (!enabled(s, cfg, a)) throw new Error(`${a.type} is not enabled`);
  const bug = bugOf(cfg);
  switch (a.type) {
    case "Ask": return {
      ...s,
      cards: [...s.cards, {
        kind: a.kind, line: { P: "open", S: a.kind === "relayed" ? "open" : "none" }, at: "none", answers: 0, woke: { P: 0, S: 0 },
        told: false, fails: 0, noted: false, shows: false,
      }],
    };
    case "Answer": {
      const c = card(s, a.k)!;
      if (a.c === "S") return toS(s, a.k, accept(settle(c, "S", "P"), "S"), (n) => wake(n, "S"), (n) => n);
      if (c.kind === "relayed" && bug !== "callee") {
        const settled = bug === "open" || s.gone ? settle(c, "P") : settle(c, "P", "S");
        return { ...s, cards: withCard(s, a.k, () => wake(accept(settled, "P"), "P")) };
      }
      if (s.gone) return { ...s, cards: withCard(s, a.k, () => settle(c, "P")) };
      if (old(bug)) {
        const settled = accept(c.kind === "relayed" ? settle(c, "P", "S") : settle(c, "P"), "P");
        return oldCallIn(s, a.k, { ...settled, shows: c.kind === "guest" });
      }
      // answerGuestLine: free, a call-in that begins now; at work, a message in its own chat, queued.
      const given = { ...accept(c, "P"), noted: false };
      if (quiet(s)) return { ...s, s: "guest", cards: withCard(s, a.k, () => reached(given)) };
      return toS(s, a.k, given, reached, (n) => ({ ...n, line: { ...n.line, P: "pending" } }));
    }
    case "Ignore": {
      const c = card(s, a.k)!;
      if (c.kind === "relayed" && a.c === "P" && s.gone && bug === "ignoregone") return { ...s, refused: true };
      return { ...s, cards: withCard(s, a.k, () => (c.kind === "relayed" && !s.gone ? settle(c, "P", "S") : settle(c, a.c))) };
    }
    case "Drop": {
      const k = s.queue[a.i - 1]!;
      return { ...s, queue: s.queue.filter((_, i) => i !== a.i - 1), cards: withCard(s, k, failed) };
    }
    case "Work": return { ...s, s: "own" };
    case "EndTurn": {
      if (s.queue.length) {
        const [k, ...rest] = s.queue;
        const cards = s.cards.map((c, i) => (s.calls.includes(i + 1) ? { ...c, told: true } : c));
        const next = { ...s, cards };
        return { ...s, s: "own", queue: rest, calls: [], cards: withCard(next, k!, (c) => (c.kind === "guest" ? reached(c) : wake(c, "S"))) };
      }
      if (s.calls.length) {
        const [head, ...rest] = s.calls;
        return { ...s, s: "guest", calls: rest, cards: withCard(s, head!, (c) => wake(c, "S")) };
      }
      return { ...s, s: "idle" };
    }
    case "Remove": {
      // Its turn stops and its queue is dropped: those answers never reach it. Its relayed copies in P's chat are
      // settled ("No longer needed"), unless the bug keeps them.
      const keeps = bug === "keepcopy" || bug === "ignoregone";
      const cards = s.cards.map((c, i) => {
        let n = c;
        for (const k of s.queue) if (k === i + 1) n = failed(n);
        return !keeps && n.kind === "relayed" && n.line.P === "open" ? settle(n, "P") : n;
      });
      return { ...s, gone: true, s: "idle", queue: [], cards };
    }
  }
}

export function actions(s: State, cfg: Config): Action[] {
  const all: Action[] = [{ type: "Ask", kind: "guest" }, { type: "Ask", kind: "relayed" }, { type: "Work" }, { type: "EndTurn" }, { type: "Remove" }];
  for (let k = 1; k <= s.cards.length; k++) {
    for (const c of ["P", "S"] as Chat[]) all.push({ type: "Answer", k, c }, { type: "Ignore", k, c });
  }
  for (let i = 1; i <= s.queue.length; i++) all.push({ type: "Drop", i });
  return all.filter((a) => enabled(s, cfg, a));
}

/** The bot an answer on the card is for: the one that asked a guest line; on a relayed card, the bot of the chat. */
const forBot = (c: CardState): "none" | Chat => (c.kind === "guest" ? "S" : c.at);
const waiting = (s: State, k: number) => s.queue.filter((j) => j === k).length + s.calls.filter((j) => j === k).length;

/** The model's invariants that fail in `s` (empty: none). */
export function violations(s: State): string[] {
  const out = new Set<string>();
  s.cards.forEach((c, i) => {
    const k = i + 1;
    if (c.answers > 1 + c.fails) out.add("AnsweredOnce");
    if (c.woke.P + c.woke.S > 1) out.add("DeliveredOnce");
    if (c.answers !== c.woke.P + c.woke.S + waiting(s, k) + (c.told ? 1 : 0) + c.fails) out.add("Accounted");
    for (const b of ["P", "S"] as Chat[]) if (c.woke[b] > 0 && b !== forBot(c)) out.add("WakesItsBot");
    if (c.kind === "guest" && c.shows !== (c.woke.S === 1)) out.add("ChosenIsDelivered");
    if ((c.line.P === "pending") !== (c.kind === "guest" && waiting(s, k) === 1)) out.add("PendingIsQueued");
    if (c.kind === "relayed" && !s.gone && c.line.P !== c.line.S) out.add("BothShowIt");
    if (c.answers > c.fails && (c.at === "none" || !["pending", "settled"].includes(c.line[c.at]))) out.add("AnsweredIsSettled");
  });
  if (s.refused) out.add("IgnoreNeverRefused");
  if (s.gone && s.cards.some((c) => c.kind === "relayed" && c.line.P === "open")) out.add("NoCopyOfGone");
  if (s.calls.length && s.s !== "guest") out.add("CallsWait");
  if (s.queue.length && s.s === "idle") out.add("QueueWaits");
  return [...out];
}

/** What the app shows: each card's lines (S's chat only while it is there), the turns its answer handed each bot,
 * whether its guest line shows the answer as chosen and, while open, says the last answer did not arrive; S's turn,
 * the answers waiting in its queue, the call-ins waiting in P's chat, the call-ins given up; S removed; an ignore
 * refused. */
export interface View {
  cards: { kind: Kind; P: LineState; S: LineState | null; woke: Record<Chat, number>; shows: boolean; noted: boolean }[];
  s: State["s"]; queue: number[]; calls: number; told: number; gone: boolean; refused: boolean;
}

export const view = (s: State): View => ({
  cards: s.cards.map((c) => ({
    kind: c.kind, P: c.line.P, S: s.gone ? null : c.line.S, woke: { ...c.woke }, shows: c.shows, noted: c.noted && c.line.P === "open",
  })),
  s: s.s, queue: [...s.queue], calls: s.calls.length, told: s.cards.filter((c) => c.told).length, gone: s.gone, refused: s.refused,
});
