// Two heads in one bot, checked against what the Swift code itself does (prompts-golden.json's
// `heads`, written by DesktopPromptGoldenExport.swift): the hand-off tag, the notes one head gets
// about the other, and the conductor's budgets (6 hand-offs, 2 reviews, 3 discussion rounds per
// user message), its hand-backs and the card at the limit.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  asNote, Conductor, forOtherNote, handBackNote, handedNote, headsFor, limitReachedNote, makeHeads, parseHeadTags, readHeads, roundsText,
  saidNote, WENT_WITH, wordsNote, type ConductorAction, type Engine, type Heads,
} from "../../src/core/heads";
import { desktop } from "../helpers";

const golden = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "prompts-golden.json"), "utf8")).heads;

describe("hand-off tags (HeadTags.parse)", () => {
  for (const sample of golden.tags) {
    it(`reads ${JSON.stringify(sample.text).slice(0, 50)}`, () => {
      const ours = parseHeadTags(sample.text);
      expect(ours.body).toBe(sample.body);
      if (!sample.handoff) expect(ours.handoff).toBeNull();
      else expect(ours.handoff).toEqual({ to: sample.handoff.to, kind: sample.handoff.kind, task: sample.handoff.task, decisionId: sample.handoff.decision === null ? null : sample.handoff.decision });
    });
  }
});

describe("what one head hears of the other", () => {
  it("words the notes as Swift does", () => {
    const n = golden.notes;
    expect(wordsNote("codex", "I take the tests.")).toBe(n.wordsNote);
    expect(saidNote("claude", "I fixed the parser.", [{ kind: "tool", title: "Edit parser.ts" }, { kind: "text", title: "thinking" }, { kind: "tool", title: "Run npm test" }])).toBe(n.saidNote);
    expect(saidNote("codex", "Nothing to add.")).toBe(n.saidNotePlain);
    expect(forOtherNote("codex", "Only you, please")).toBe(n.forOtherNote);
    expect(handedNote("claude", { kind: "review", task: "Check it" }, 2, 6)).toBe(n.handed);
    expect(handedNote("codex", { kind: "task", task: "Publish it" }, 1, 6)).toBe(n.handedTask);
    expect(handedNote("claude", { kind: "discuss", task: "Which?" }, 3, 6)).toBe(n.handedDiscuss);
    expect(handBackNote("codex", "Looks fine.")).toBe(n.handBack);
    expect(handBackNote("codex", "")).toBe(n.handBackEmpty);
    expect(limitReachedNote("codex")).toBe(n.limitReached);
    expect(WENT_WITH).toBe(n.wentWith);
    expect(asNote("- Do this. ")).toBe(n.asNote);
  });
});

function row(action: ConductorAction): Record<string, unknown> {
  switch (action.type) {
    case "ask": return { ask: action.head, text: action.text, handoff: action.handoffId !== null };
    case "line": return { line: action.text };
    case "card": return { card: action.text, choices: action.choices.map((choice) => choice.label) };
    case "progress": return { progress: action.progress ? { ...action.progress, shown: roundsText(action.progress) } : null };
  }
}

describe("the conductor (budgets per user message)", () => {
  for (const scenario of golden.conductor) {
    it(`runs ${scenario.name} as Swift does`, () => {
      const settings: Heads = makeHeads(["claude", "codex"], "both", {
        limits: { discussion: scenario.settings.discussion, review: scenario.settings.review, handoffs: scenario.settings.handoffs, atLimit: scenario.settings.atLimit },
        handoffs: scenario.name !== "handoffs-off",
      });
      const conductor = new Conductor(settings);
      conductor.userMessage("Make the parser faster\nplease");
      const pending: Partial<Record<Engine, string[]>> = {};
      for (const call of scenario.calls) {
        const head = call.head as Engine;
        const id = call.handed ? pending[head]?.pop() ?? null : null;
        // The Swift run parsed the same text and tag: the tag is in the golden only as its effect.
        const tag = call.actions.find((a: any) => a.ask && a.text.includes("this bot's other head"));
        const kind = tag ? (/asks you to review/.test(tag.text) ? "review" : /wants your view/.test(tag.text) ? "discuss" : "task") : null;
        const task = tag ? /\):\n([\s\S]*?)\n\nDo it/.exec(tag.text)![1]! : null;
        const card = call.actions.find((a: any) => a.card || (a.line && a.line.startsWith("Hand-off limit")));
        // At a limit the hand-off was asked for but not made: name it from the scenario's pattern.
        const asked = kind ? { to: (head === "claude" ? "codex" : "claude") as Engine, kind: kind as "task" | "review" | "discuss", task: task!, decisionId: null }
          : card ? { to: (head === "claude" ? "codex" : "claude") as Engine, kind: scenario.name.startsWith("review") ? "review" as const : scenario.name.startsWith("discuss") ? "discuss" as const : "task" as const, task: "x", decisionId: null }
          : scenario.name === "handoffs-off" ? { to: "codex" as Engine, kind: "review" as const, task: "Review it", decisionId: null } : null;
        const actions = conductor.replied(head, call.text, asked, call.handed, id);
        for (const action of actions) if (action.type === "ask" && action.handoffId) (pending[action.head] ??= []).push(action.handoffId);
        expect(actions.map(row), `${scenario.name}: ${head} "${call.text}"`).toEqual(call.actions);
        expect(conductor.records.map((r) => ({ from: r.from, to: r.to, kind: r.kind, round: r.round, limit: r.limit, state: r.state, lines: r.lines.length }))).toEqual(call.records);
      }
    });
  }

  it("a pick on the limit card goes on with one head, or allows one more round", () => {
    const conductor = new Conductor(makeHeads(["claude", "codex"], "both", { limits: { discussion: 3, review: 1, handoffs: 6, atLimit: "ask" } }));
    conductor.userMessage("go");
    const review = { to: "codex" as Engine, kind: "review" as const, task: "Review", decisionId: null };
    const first = conductor.replied("claude", "v1", review, false);
    const id = (first.find((a) => a.type === "ask") as { handoffId: string }).handoffId;
    const back = conductor.replied("codex", "nit", { ...review, to: "claude" }, true, id);
    expect(back.some((a) => a.type === "card")).toBe(true);
    const more = conductor.picked({ oneMoreRound: true });
    expect(more.map(row)[1]).toEqual({ progress: { kind: "review", round: 2, limit: 2, shown: "Review round 2 of 2" } });
    expect(conductor.picked({ goWith: "codex" }).map(row)).toEqual([{ progress: null }, { line: "You went with Codex's" }, { ask: "codex", text: WENT_WITH, handoff: false }]);
  });

  it("Stop stops a hand-off's chain, and a stale reply does nothing", () => {
    const conductor = new Conductor(makeHeads(["claude", "codex"]));
    conductor.userMessage("go");
    const out = conductor.replied("claude", "v1", { to: "codex", kind: "task", task: "Part 2", decisionId: null }, false);
    const id = (out.find((a) => a.type === "ask") as { handoffId: string }).handoffId;
    expect(conductor.stop(id).map(row)).toEqual([{ progress: null }, { line: "Stopped by you" }]);
    expect(conductor.records[0]!.state).toBe("stopped");
    expect(conductor.replied("codex", "late", null, true, id)).toEqual([]);
  });
});

describe("heads in bot.json (1.x's format)", () => {
  it("reads 1.x's heads, keeping what it does not know readable", () => {
    expect(readHeads({ engines: ["claude", "codex", "gemini"], answerWith: "codex", limits: { review: 40, atLimit: "useDoers" }, codexModel: "gpt-x" }, "claude"))
      .toEqual({ engines: ["claude", "codex"], answerWith: "codex", limits: { discussion: 3, review: 10, handoffs: 6, atLimit: "useDoers" }, handoffs: true, codexModel: "gpt-x" });
    expect(readHeads(undefined, "codex")).toMatchObject({ engines: ["codex"], answerWith: "codex" });
    expect(readHeads({ engines: [], answerWith: "both" }, undefined)).toMatchObject({ engines: ["claude"], answerWith: "claude" });
    const two = makeHeads(["codex", "claude"]);
    expect(two.engines).toEqual(["claude", "codex"]);
    expect(headsFor(two, "both")).toEqual(["claude", "codex"]);
    expect(headsFor(two, "codex")).toEqual(["codex"]);
    expect(headsFor(makeHeads(["claude"]), "codex")).toEqual(["claude"]);
  });
});
