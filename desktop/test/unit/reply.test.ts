// The reply parser and the task book against what the Swift code did with the same input
// (prompts-golden.json: `replies` and `taskScenario`, written by DesktopPromptGoldenExport.swift).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseReply, saysNoReply, saysNothing } from "../../src/core/reply";
import { botPrompts, desktopPrompts, TASK_STAGE_SENTENCE } from "../../src/core/prompts";
import { taskView } from "../../src/core/bot";
import { readTaskCard } from "../../src/core/tasks";
import { TaskBook, type TaskTurn } from "../../src/core/tasks";
import { desktop } from "../helpers";

const golden = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "prompts-golden.json"), "utf8"));

describe("reply parser: the Swift ReplyParser's results", () => {
  for (const [index, sample] of (golden.replies as any[]).entries()) {
    it(`parses reply ${index}: ${JSON.stringify(sample.reply).slice(0, 50)}`, () => {
      const parsed = parseReply(sample.reply);
      expect(parsed.body).toBe(sample.body);
      expect(parsed.choices).toEqual(sample.choices);
      expect(parsed.tasks).toEqual(sample.tasks);
      expect(parsed.reactions).toEqual(sample.reactions);
      expect(parsed.displays).toEqual(sample.displays);
      expect(parsed.requests).toEqual(sample.requests);
      expect(parsed.completionSignals).toEqual(sample.signals);
      expect(parsed.decisionReference).toBe(sample.decisionReference);
      expect(saysNoReply(sample.reply)).toBe(sample.saysNoReply);
      expect(saysNothing(sample.reply)).toBe(sample.saysNothing);
    });
  }
});

describe("task book: the Swift TaskBook's cards", () => {
  it("follows the same scenario to the same cards", () => {
    const t0 = 783_000_000;
    const at = (s: number) => t0 + s;
    const m = (n: number) => `33333333-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const turn = (message: number | null, text: string | null, started: number | null, extra: Partial<TaskTurn> = {}): TaskTurn => ({
      head: "claude", userMessage: message === null ? null : m(message), userText: text, started: started === null ? null : at(started), ...extra,
    });
    const book = new TaskBook();
    const results: { op: string; result: unknown; tasks: unknown[] }[] = [];
    const record = (op: string, result: unknown = null) => results.push({ op, result, tasks: structuredClone(book.tasks) });
    const long = "Write the docs for the API, with examples for every endpoint\nand more";
    book.begin(m(1), long, "claude", at(0)); record("begin 1");
    record("claim 1", book.claim(m(1), "claude", at(1)));
    book.working(m(1), long, "claude", at(2)); record("working 1");
    record("replied 101", book.replied(m(101), turn(1, long, 0, { usedTools: true }), [{ name: "Docs", now: "writing", state: "running" }], at(30)).length);
    book.begin(m(2), "thanks", "claude", at(40)); record("begin 2");
    record("replied 102 quick", book.replied(m(102), turn(2, "thanks", 40), [], at(45)).length);
    book.begin(m(3), "\n  A long question  \nwith lines", "claude", at(50)); record("begin 3");
    record("replied 103 slow", book.replied(m(103), turn(3, "\n  A long question  \nwith lines", 50), [], at(100)).length);
    book.begin(m(4), "follow up on docs", "claude", at(200)); record("begin 4");
    record("replied 104 continues", book.replied(m(104), turn(4, "follow up on docs", 200), [{ continues: "docs", now: "", state: "done" }], at(230)).length);
    book.begin(m(5), "Which?", "claude", at(300), m(101)); record("begin 5 replying");
    book.begin(m(6), "part one", "claude", at(400));
    book.begin(m(7), "part two", "claude", at(401));
    book.join(m(6), m(7)); record("join 6 7");
    book.begin(m(8), "decide something", "claude", at(500));
    record("replied 108 asks", book.replied(m(108), turn(8, "decide something", 500, { usedTools: true, asks: true }), [], at(530)).length);
    book.begin(m(9), "research", "claude", at(600));
    book.link("toolu_x", book.containing(m(9))!.id);
    record("link 9");
    record("replied 109 running sub", book.replied(m(109), turn(9, "research", 600, { usedTools: true, runningSubagents: new Set(["toolu_x"]) }), [], at(610)).length);
    record("replied 110 report", book.replied(m(110), turn(null, null, null, { reporting: ["toolu_x"] }), [], at(900)).length);
    book.begin(m(11), "two things", "claude", at(1000));
    record("replied 111 two tags", book.replied(m(111), turn(11, "two things", 1000, { usedTools: true }), [{ name: "One", state: "running" }, { name: "Two", next: "later" }], at(1010)).length);
    record("replied 112 bg new", book.replied(m(112), turn(null, null, null), [{ name: "Background" }], at(1100)).length);

    // Card ids are random on both sides: compare them by order of appearance.
    const normalize = (steps: { op: string; result: unknown; tasks: any[] }[]) => {
      const ids = new Map<string, string>();
      return steps.map((step) => ({
        op: step.op, result: step.result,
        tasks: step.tasks.map((card) => {
          if (!ids.has(card.id)) ids.set(card.id, `card-${ids.size}`);
          // 2.x explicitly records empty agent links; Swift omitted that optional empty array.
          // 2.x also marks cards a <task> line declared (`declared`, what the panel shows) and keeps their
          // timeline (`history`, the panel's hover card); Swift has neither key.
          const { declared: _declared, history: _history, ...rest } = card;
          return Object.fromEntries(Object.entries({ ...rest, subagentIDs: card.subagentIDs ?? [], id: ids.get(card.id) }).sort(([a], [b]) => (a < b ? -1 : 1)));
        }),
      }));
    };
    expect(normalize(results)).toEqual(normalize(golden.taskScenario));
  });
});

describe("<task stage=…> (2.x)", () => {
  it("reads built, reviewed, installed and verified (any case), \"\" to clear, and leaves an unknown stage out", () => {
    expect(parseReply('<task name="Ship" state="done" stage="built"/>').tasks).toEqual([{ name: "Ship", state: "done", stage: "built" }]);
    expect(parseReply('<task name="Ship" stage="Installed"/>').tasks).toEqual([{ name: "Ship", stage: "installed" }]);
    expect(parseReply('<task name="Ship" stage="verified"/>').tasks).toEqual([{ name: "Ship", stage: "verified" }]);
    expect(parseReply('<task name="Ship" stage=""/>').tasks).toEqual([{ name: "Ship", stage: "" }]);
    expect(parseReply('<task name="Ship" stage="shipped"/>').tasks).toEqual([{ name: "Ship" }]);
    expect(parseReply('<task name="Ship" state="running"/>').tasks).toEqual([{ name: "Ship", state: "running" }]);
  });

  it("is kept on the card until changed or cleared, and shown on its view; a saved card with a bad stage drops it", () => {
    const book = new TaskBook();
    const turn: TaskTurn = { head: "claude", userMessage: "m1", started: 0, usedTools: true };
    book.begin("m1", "ship it", null, 1);
    book.replied("r1", turn, [{ name: "Ship", state: "done", stage: "built" }], 2);
    expect(book.named("Ship")!.stage).toBe("built");
    book.replied("r2", { ...turn, userMessage: "m9" }, [{ continues: "Ship", now: "Reviewing" }], 3);
    expect(book.named("Ship")!.stage).toBe("built");
    book.replied("r3", { ...turn, userMessage: "m9" }, [{ continues: "Ship", stage: "installed" }], 4);
    expect(taskView(book.named("Ship")!, new Set()).stage).toBe("installed");
    book.replied("r4", { ...turn, userMessage: "m9" }, [{ continues: "Ship", stage: "" }], 5);
    expect(book.named("Ship")!.stage).toBeUndefined();
    expect("stage" in taskView(book.named("Ship")!, new Set())).toBe(false);
    expect(readTaskCard({ id: "A", name: "X", createdAt: 1, stage: "reviewed" })!.stage).toBe("reviewed");
    expect(readTaskCard({ id: "A", name: "X", createdAt: 1, stage: "bogus" })!.stage).toBeUndefined();
  });

  it("lets you close work said done but not verified; other finished cards stay as they are", () => {
    const book = new TaskBook();
    const turn: TaskTurn = { head: "claude", userMessage: "m1", started: 0, usedTools: true };
    const tags: [string, Parameters<TaskBook["replied"]>[2][number]][] = [
      ["Built", { name: "Built", state: "done", stage: "built" }],
      ["Verified", { name: "Verified", state: "done", stage: "verified" }],
      ["Plain", { name: "Plain", state: "done" }],
      ["Stopped", { name: "Stopped", state: "stopped", stage: "built" }],
    ];
    tags.forEach(([name, tag], index) => { book.begin(`m${index}`, name, null, 1); book.replied(`r${index}`, { ...turn, userMessage: `m${index}` }, [tag], 2); });
    const id = (name: string) => book.named(name)!.id;
    expect(book.complete(id("Built"), 3)).toBe(true);
    expect(book.named("Built")).toMatchObject({ state: "done", manuallyCompletedAt: 3, stage: "built" });
    expect(book.named("Built")!.history!.at(-1)).toEqual({ kind: "complete", at: 3 });
    // Repeated clicks are safe; verified, unstaged and stopped cards are not closed again.
    expect(book.complete(id("Built"), 4)).toBe(false);
    expect(book.named("Built")!.manuallyCompletedAt).toBe(3);
    for (const name of ["Verified", "Plain", "Stopped"]) {
      expect(book.complete(id(name), 5), name).toBe(false);
      expect(book.named(name)!.manuallyCompletedAt, name).toBeUndefined();
    }
  });

  it("is told to every bot in one sentence after the <task> line's states", () => {
    for (const role of ["main", "manager", "bot"] as const) {
      const profile = { name: "P", role, folder: "/tmp/p", memoryPath: role === "main" ? "memory.md" : ".bot/memory.md", job: role === "bot" ? "News" : null };
      const plain = botPrompts({ profile });
      expect(plain.system).not.toContain(TASK_STAGE_SENTENCE);
      expect(desktopPrompts(plain, profile).system).toContain(`done or stopped. ${TASK_STAGE_SENTENCE} Every attribute is optional;`);
    }
  });
});
