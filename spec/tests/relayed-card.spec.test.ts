// Conformance of the real Core (a called-in bot's option cards and the user's answers on them) with
// spec/models/callin/RelayedCard.tla, through spec/driver/relayed-card-driver.ts and its adapter: seeded random walks
// over the reference's enabled actions (S asks a guest line or a card relayed from its own chat, the user answers or
// ignores either line, S works, its turns end, S is removed); after every step the app's view must equal the
// reference's and the model's properties must hold. TLC's counterexamples are replayed, and the reference explored
// like TLC breaks the properties only with the model's bugs.
// SPEC_BUG=card-callee (before 505457a0), card-open or card-ignoregone (before this model's fix) turns on the
// reference's bug: the walks must go red.
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

const label = (a: Action) => (a.type === "Ask" ? `Ask(${a.kind})` : "k" in a ? `${a.type}(${a.k},${a.c})` : a.type);

async function apply(s: RelayedCardSession, a: Action) {
  switch (a.type) {
    case "Ask": return s.ask(a.kind);
    case "Answer": return s.answer(a.k, a.c);
    case "Ignore": return s.ignore(a.k, a.c);
    case "Work": return s.work();
    case "EndTurn": return s.endTurn();
    case "Remove": return s.remove();
  }
}

/** What a step reached that the walks should cover. */
function reached(s: State, n: State, a: Action): string[] {
  const out: string[] = [];
  if (a.type !== "Answer" && a.type !== "Ignore") return out;
  const c = s.cards[a.k - 1]!, after = n.cards[a.k - 1]!;
  const verb = a.type === "Answer" ? "answered" : "ignored";
  const where = c.kind === "guest" ? "guest line" : a.c === "P" ? "relayed copy" : "original";
  out.push(`${where} ${verb}${s.gone ? ", S removed" : ""}`);
  if (a.type === "Answer" && after.told) out.push("call-in gives up: S busy");
  if (a.type === "Answer" && n.calls.length > s.calls.length) out.push("call-in waits behind one under way");
  if (a.type === "Answer" && a.c === "S" && s.s !== "idle") out.push("answer queued behind S's turn");
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
      const kinds = [...new Set(choices.map((a) => a.type))];
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
      "answer queued behind S's turn", "call-in gives up: S busy",
      "guest line answered", "guest line answered, S removed", "guest line ignored", "original answered", "original ignored",
      "relayed copy answered", "relayed copy answered, S removed", "relayed copy ignored",
    ]));
  }, 300_000);

  it("a call-in waits behind the one under way; S's own queued turn goes first and the waiting call-in gives up", async () => {
    const shown = await replay(cfg, [
      { type: "Ask", kind: "guest" }, { type: "Ask", kind: "guest" }, { type: "Ask", kind: "relayed" },
      { type: "Answer", k: 1, c: "P" }, { type: "Answer", k: 2, c: "P" }, { type: "Answer", k: 3, c: "S" },
      { type: "EndTurn" }, { type: "EndTurn" },
    ]);
    expect(shown).toMatchObject({ s: "idle", calls: 0, told: 1 });
    expect(shown.cards.map((c) => c.woke)).toEqual([{ P: 0, S: 1 }, { P: 0, S: 0 }, { P: 0, S: 1 }]);
  });

  it("two call-ins in a row: the second begins when the first ends", async () => {
    const shown = await replay(cfg, [
      { type: "Ask", kind: "guest" }, { type: "Ask", kind: "guest" },
      { type: "Answer", k: 1, c: "P" }, { type: "Answer", k: 2, c: "P" }, { type: "EndTurn" }, { type: "EndTurn" },
    ]);
    expect(shown.cards.map((c) => c.woke)).toEqual([{ P: 0, S: 1 }, { P: 0, S: 1 }]);
  });

  it("TLC's counterexample for RelayedCard_bug.cfg: an answer on the relayed copy goes to P, the bot of the chat, not S", async () => {
    const shown = await replay(cfg, [{ type: "Ask", kind: "relayed" }, { type: "Answer", k: 1, c: "P" }]);
    expect(shown.cards[0]).toMatchObject({ P: "settled", S: "settled", woke: { P: 1, S: 0 } });
  });

  it("TLC's counterexample for RelayedCard_bug_ignoregone.cfg: a relayed copy of a removed bot can be ignored", async () => {
    const shown = await replay(cfg, [{ type: "Ask", kind: "relayed" }, { type: "Remove" }, { type: "Ignore", k: 1, c: "P" }]);
    expect(shown).toMatchObject({ refused: false, cards: [{ P: "settled" }] });
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

  it.each([["callee", "WakesItsBot"], ["open", "AnsweredOnce"], ["ignoregone", "IgnoreNeverRefused"]] as [Bug, string][])(
    "with bug %s breaks %s", (bug, property) => {
      expect(explore({ maxCards: 2, bug }, property).broken).toContain(property);
    });
});
