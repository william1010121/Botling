// Conformance of the real Core (a called-in bot's option cards and the user's answers on them) with
// spec/models/callin/RelayedCard.tla, through spec/driver/relayed-card-driver.ts and its adapter: seeded random walks
// over the reference's enabled actions (S asks a guest line or a card relayed from its own chat, the user answers or
// ignores either line or takes back an answer waiting for S, S works, its turns end, S is removed); after every step
// the app's view must equal the reference's and the model's properties must hold. TLC's counterexamples are replayed,
// and the reference explored like TLC breaks the properties only with the model's bugs.
// SPEC_BUG=card-callee (before 505457a0), card-open, card-keepcopy (removeBot before it settled relayed copies),
// card-ignoregone (before 3a2d13fa) or card-giveup (an answer on a guest line for S at work given up after a wait,
// shown chosen from the start) turns on the reference's bug: the walks must go red.
import { describe, expect, it } from "vitest";
import { relayedCardDriver } from "../../desktop/spec-adapters/relayed-card-adapter";
import type { RelayedCardSession } from "../driver/relayed-card-driver";
import { actions, init, step, view, violations, type Action, type Bug, type Config, type State } from "../reference/relayed-card";

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

const label = (a: Action) => (a.type === "Ask" ? `Ask(${a.kind})` : a.type === "Drop" ? `Drop(${a.i})`
  : "k" in a ? `${a.type}(${a.k},${a.c})` : a.type);

async function apply(s: RelayedCardSession, a: Action) {
  switch (a.type) {
    case "Ask": return s.ask(a.kind);
    case "Answer": return s.answer(a.k, a.c);
    case "Ignore": return s.ignore(a.k, a.c);
    case "Drop": return s.drop(a.i);
    case "Work": return s.work();
    case "EndTurn": return s.endTurn();
    case "Remove": return s.remove();
  }
}

/** What a step reached that the walks should cover. */
function reached(s: State, n: State, a: Action): string[] {
  const out: string[] = [];
  if (a.type === "Drop") return ["guest answer taken back: the line opens again with a note"];
  if (a.type === "Remove" && s.queue.some((k) => s.cards[k - 1]!.kind === "guest")) return ["S removed with a guest answer waiting"];
  if (a.type === "EndTurn" && s.queue.length && s.cards[s.queue[0]! - 1]!.kind === "guest") return ["queued guest answer reaches S"];
  if (a.type !== "Answer" && a.type !== "Ignore") return out;
  const c = s.cards[a.k - 1]!, after = n.cards[a.k - 1]!;
  const verb = a.type === "Answer" ? "answered" : "ignored";
  const where = c.kind === "guest" ? "guest line" : a.c === "P" ? "relayed copy" : "original";
  out.push(`${where} ${verb}${s.gone ? ", S removed" : ""}`);
  if (a.type === "Answer" && after.told) out.push("call-in gives up: S busy");
  if (a.type === "Answer" && n.calls.length > s.calls.length) out.push("call-in waits behind one under way");
  if (a.type === "Answer" && a.c === "S" && s.s !== "idle") out.push("answer queued behind S's turn");
  if (a.type === "Answer" && after.line.P === "pending") out.push(`guest answer queued: S ${s.s === "own" ? "at work" : "in a call-in"}`);
  if (a.type === "Answer" && c.noted && c.line.P === "open") out.push("guest line answered again after its note");
  return out;
}

async function walk(cfg: Config, seed: number, length: number, seen: Set<string>) {
  const next = random(seed);
  const session = await relayedCardDriver.open();
  let state: State = init(cfg);
  const steps: string[] = [];
  try {
    for (let i = 0; i < length; i++) {
      const choices = actions(state, cfg);
      if (!choices.length) break;
      // Removing S ends the walk's interesting part: it is picked rarely.
      const all = [...new Set(choices.map((a) => a.type))];
      const kinds = all.length > 1 && next() > 0.08 ? all.filter((type) => type !== "Remove") : all;
      const kind = kinds[Math.floor(next() * kinds.length)]!;
      const of = choices.filter((a) => a.type === kind);
      const a = of[Math.floor(next() * of.length)]!;
      const after = step(state, cfg, a);
      steps.push(label(a));
      const where = `seed ${seed}, step ${i + 1}: ${steps.join(" → ")}`;
      expect(violations(after), `model properties broken at ${where}`).toEqual([]);
      for (const what of reached(state, after, a)) seen.add(what);
      await apply(session, a);
      state = after;
      expect(session.view(), `the app at ${where}`).toEqual(view(state));
    }
  } finally {
    await session.close();
  }
}

async function replay(cfg: Config, path: Action[]) {
  const session = await relayedCardDriver.open();
  let state = init(cfg);
  try {
    for (const a of path) {
      state = step(state, cfg, a);
      await apply(session, a);
      expect(session.view(), label(a)).toEqual(view(state));
    }
    return session.view();
  } finally {
    await session.close();
  }
}

describe("relayed card model: conformance", () => {
  const cfg: Config = { maxCards: 4 };
  const WALKS = 40;

  it(`${WALKS} random walks of 25 steps: the app's cards, the turns their answers hand out and S's turns equal the model's after every step`, async () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= WALKS; seed++) await walk(cfg, seed, 25, seen);
    expect([...seen].sort()).toEqual(expect.arrayContaining([
      "S removed with a guest answer waiting", "answer queued behind S's turn",
      "guest answer queued: S at work", "guest answer queued: S in a call-in", "guest answer taken back: the line opens again with a note",
      "guest line answered", "guest line answered again after its note", "guest line answered, S removed", "guest line ignored",
      "original answered", "original ignored", "queued guest answer reaches S", "relayed copy answered", "relayed copy ignored",
    ]));
  }, 300_000);

  it("TLC's counterexample for RelayedCard_bug_giveup.cfg: an answer behind S's call-in waits, queued, and shows chosen only once S has it", async () => {
    const path: Action[] = [{ type: "Ask", kind: "guest" }, { type: "Ask", kind: "guest" }, { type: "Answer", k: 1, c: "P" }, { type: "Answer", k: 2, c: "P" }];
    const waiting = await replay(cfg, path);
    expect(waiting).toMatchObject({ s: "guest", queue: [2], calls: 0, told: 0 });
    expect(waiting.cards[1]).toMatchObject({ P: "pending", shows: false, woke: { P: 0, S: 0 } });
    const shown = await replay(cfg, [...path, { type: "EndTurn" }, { type: "EndTurn" }]);
    expect(shown).toMatchObject({ s: "idle", queue: [], told: 0 });
    expect(shown.cards.map((c) => [c.P, c.shows, c.woke.S])).toEqual([["settled", true, 1], ["settled", true, 1]]);
  });

  it("S at work: the answer waits in its own chat, behind its turn, with the original's answer", async () => {
    const shown = await replay(cfg, [
      { type: "Ask", kind: "guest" }, { type: "Ask", kind: "relayed" }, { type: "Work" },
      { type: "Answer", k: 2, c: "S" }, { type: "Answer", k: 1, c: "P" }, { type: "EndTurn" }, { type: "EndTurn" },
    ]);
    expect(shown).toMatchObject({ s: "own", queue: [], told: 0 });
    expect(shown.cards.map((c) => c.woke)).toEqual([{ P: 0, S: 1 }, { P: 0, S: 1 }]);
  });

  it("an answer taken back opens the card again with a note; answered again, it reaches S", async () => {
    const taken = await replay(cfg, [{ type: "Ask", kind: "guest" }, { type: "Work" }, { type: "Answer", k: 1, c: "P" }, { type: "Drop", i: 1 }]);
    expect(taken.cards[0]).toMatchObject({ P: "open", noted: true, shows: false, woke: { S: 0 } });
    const again = await replay(cfg, [
      { type: "Ask", kind: "guest" }, { type: "Work" }, { type: "Answer", k: 1, c: "P" }, { type: "Drop", i: 1 },
      { type: "Answer", k: 1, c: "P" }, { type: "EndTurn" },
    ]);
    expect(again.cards[0]).toMatchObject({ P: "settled", noted: false, shows: true, woke: { S: 1 } });
  });

  it("S removed with an answer waiting: the card opens again with a note; answered then, it is no longer needed", async () => {
    const path: Action[] = [{ type: "Ask", kind: "guest" }, { type: "Work" }, { type: "Answer", k: 1, c: "P" }, { type: "Remove" }];
    const removed = await replay(cfg, path);
    expect(removed).toMatchObject({ gone: true, cards: [{ P: "open", noted: true, woke: { S: 0 } }] });
    const after = await replay(cfg, [...path, { type: "Answer", k: 1, c: "P" }]);
    expect(after.cards[0]).toMatchObject({ P: "settled", shows: false, noted: false, woke: { S: 0 } });
  });

  it("TLC's counterexample for RelayedCard_bug.cfg: an answer on the relayed copy goes to P, the bot of the chat, not S", async () => {
    const shown = await replay(cfg, [{ type: "Ask", kind: "relayed" }, { type: "Answer", k: 1, c: "P" }]);
    expect(shown.cards[0]).toMatchObject({ P: "settled", S: "settled", woke: { P: 1, S: 0 } });
  });

  it("TLC's counterexample for RelayedCard_bug_keepcopy.cfg: removing S settles its relayed copy in P's chat", async () => {
    const shown = await replay(cfg, [{ type: "Ask", kind: "relayed" }, { type: "Ask", kind: "guest" }, { type: "Remove" }]);
    expect(shown).toMatchObject({ gone: true, cards: [{ kind: "relayed", P: "settled" }, { kind: "guest", P: "open" }] });
  });
});

describe("relayed card model: the reference explored like TLC", () => {
  /** Every reachable state (breadth first); the first broken property with the path to it, or null. */
  function explore(cfg: Config, only?: string): { states: number; broken: string | null } {
    const key = (s: State) => JSON.stringify(s);
    const seen = new Set([key(init(cfg))]);
    const queue: { s: State; path: string[] }[] = [{ s: init(cfg), path: [] }];
    while (queue.length) {
      const { s, path } = queue.shift()!;
      for (const a of actions(s, cfg)) {
        const n = step(s, cfg, a);
        const broken = violations(n).filter((v) => !only || v === only);
        if (broken.length) return { states: seen.size, broken: `${broken.join(", ")} after ${[...path, label(a)].join(" → ")}` };
        if (!seen.has(key(n))) { seen.add(key(n)); queue.push({ s: n, path: [...path, label(a)] }); }
      }
    }
    return { states: seen.size, broken: null };
  }

  it("holds every invariant without a bug", () => {
    const result = explore({ maxCards: 3, bug: "none" });
    expect(result.broken).toBeNull();
    expect(result.states).toBeGreaterThan(1_000);
  });

  it.each([
    ["callee", "WakesItsBot"], ["open", "AnsweredOnce"], ["keepcopy", "NoCopyOfGone"], ["ignoregone", "IgnoreNeverRefused"],
    ["giveup", "ChosenIsDelivered"],
  ] as [Bug, string][])(
    "with bug %s breaks %s", (bug, property) => {
      expect(explore({ maxCards: 2, bug }, property).broken).toContain(property);
    });
});
