// @vitest-environment jsdom
// The TASKS panel shows only work a head declared with a <task> line: chat replies and follow-ups
// spawn no cards, a card never stays "Claiming…" after its turn ended, empty Now/Next/Blocked rows
// are hidden and a card without a name never shows.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { RightPanel, type RightPanelProps } from "../../src/renderer/RightPanel";
import { taskView } from "../../src/core/bot";
import { TaskBook, readTaskCard, shownTasks, type TaskTurn } from "../../src/core/tasks";
import type { BotView, TaskView } from "../../src/contract";

const turn = (userMessage: string, extra: Partial<TaskTurn> = {}): TaskTurn => ({ head: "claude", userMessage, started: 0, ...extra });
const names = (book: TaskBook) => shownTasks(book.tasks).map((card) => card.name);

describe("1. only declared work makes a task card", () => {
  it("a quick reply and a slow reply without a <task> line leave no card", () => {
    const book = new TaskBook();
    book.begin("m1", "helo", null, 1);
    book.claim("m1", "claude", 2);
    book.replied("r1", turn("m1", { started: 1 }), [], 3);
    book.begin("m2", "什麼意思。我允許", null, 10);
    book.claim("m2", "claude", 11);
    book.working("m2", "什麼意思。我允許", "claude", 12); // it used a tool
    book.replied("r2", turn("m2", { started: 10, usedTools: true }), [], 100);
    expect(names(book)).toEqual([]);
    expect(book.tasks.some((card) => card.state === "pending" || card.state === "running")).toBe(false);
  });

  it("a provisional card is not shown while the head works on it", () => {
    const book = new TaskBook();
    book.begin("m1", "好我覺得你可以繼續開始做了。把該修的都修好", null, 1);
    book.claim("m1", "claude", 2);
    book.working("m1", "好我覺得你可以繼續開始做了。把該修的都修好", "claude", 3);
    expect(names(book)).toEqual([]);
  });

  it("a <task> line names the card and shows it", () => {
    const book = new TaskBook();
    book.begin("m1", "fix the panel", null, 1);
    book.replied("r1", turn("m1", { usedTools: true }), [{ name: "Fix task panel", now: "reading tasks.ts", state: "running" }], 2);
    expect(names(book)).toEqual(["Fix task panel"]);
  });

  it("a follow-up that continues= a task joins it, one with no line adds nothing", () => {
    const book = new TaskBook();
    book.begin("m1", "fix the panel", null, 1);
    book.replied("r1", turn("m1", { usedTools: true }), [{ name: "Fix task panel", state: "running" }], 2);
    book.begin("m2", "什麼意思。我允許", null, 3);
    book.replied("r2", turn("m2", { usedTools: true }), [{ continues: "Fix task panel", now: "editing" }], 4);
    book.begin("m3", "helo", null, 5);
    book.replied("r3", turn("m3", { started: 5 }), [], 6);
    expect(names(book)).toEqual(["Fix task panel"]);
    expect(shownTasks(book.tasks)[0]!.messageIDs).toEqual(expect.arrayContaining(["m1", "r1", "m2", "r2"]));
  });

  it("the same task named again by a new message is one card, not two", () => {
    const book = new TaskBook();
    for (const [message, at] of [["m1", 1], ["m2", 10]] as const) {
      book.begin(message, "好我覺得你可以繼續開始做了。把該修…", null, at);
      book.replied(`r-${message}`, turn(message, { usedTools: true }), [{ name: "Repair panel", now: "step", state: "running" }], at + 1);
    }
    expect(names(book)).toEqual(["Repair panel"]);
  });

  it("cards 1.x saved for plain messages (no <task> line) do not show; declared ones do", () => {
    const legacy = [
      { id: "A", name: "helo", state: "pending", createdAt: 1, updatedAt: 1, messageIDs: ["m1"], kept: false },
      { id: "B", name: "好我覺得你可以繼續開始做了。把該修…", state: "running", createdAt: 2, updatedAt: 2, messageIDs: ["m2"], kept: true },
      { id: "C", name: "Docs", state: "running", now: "writing", createdAt: 3, updatedAt: 3, messageIDs: ["m3"], kept: true },
      { id: "D", name: "Ship", state: "done", stateFromTag: "done", createdAt: 4, updatedAt: 4, messageIDs: ["m4"], kept: true },
    ].map((raw) => readTaskCard(raw)!);
    expect(shownTasks(legacy).map((card) => card.id)).toEqual(["C", "D"]);
  });
});

describe("2. no card stays Claiming… after its turn ended", () => {
  it("a failed or stopped turn removes its provisional card", () => {
    for (const status of ["failed", "stopped"] as const) {
      const book = new TaskBook();
      book.begin("m1", "helo", null, 1);
      book.claim("m1", "claude", 2);
      expect(book.unanswered("m1", "claude", status, 3)).toBe(true);
      expect(book.tasks).toEqual([]);
    }
  });

  it("a never-claimed card goes when its turn ends", () => {
    const book = new TaskBook();
    book.begin("m1", "helo", null, 1);
    book.unanswered("m1", "claude", "failed", 2);
    expect(book.tasks).toEqual([]);
  });

  it("a declared task still waiting for a head is stopped by a failed turn; a running one keeps running", () => {
    const book = new TaskBook();
    book.begin("m1", "fix", null, 1);
    book.replied("r1", turn("m1", { usedTools: true }), [{ name: "Fix", state: "running" }], 2);
    book.begin("m2", "go on", null, 3, "r1"); // a reply to its line carries it on
    book.unanswered("m2", "claude", "failed", 4);
    expect(shownTasks(book.tasks).map((card) => [card.name, card.state])).toEqual([["Fix", "running"]]);
    book.replied("r3", turn("m9", { usedTools: true }), [{ name: "Queue", state: "pending" }], 5);
    const queued = book.named("Queue")!;
    queued.messageIDs.push("m5");
    book.unanswered("m5", "claude", "stopped", 6);
    expect(book.named("Queue")!.state).toBe("stopped");
  });

  it("another head's card is not touched", () => {
    const book = new TaskBook();
    book.begin("m1", "helo", null, 1);
    book.claim("m1", "codex", 2);
    expect(book.unanswered("m1", "claude", "failed", 3)).toBe(false);
    expect(book.tasks).toHaveLength(1);
  });
});

const bot: BotView = { id: "main", name: "Main", role: "main", avatar: "square", folder: "/w", phase: "awake", working: true, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };

async function panel(tasks: TaskView[], selectedTask: string | null, status = { key: "working", text: "Writing…" }) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(RightPanel, {
    bot, bots: [bot], waiting: { items: [], doing: {} }, look: "original", status, results: [], watching: null,
    tasks, messages: [], selectedTask, collapsed: false,
    onSelectTask() {}, onJumpToTask() {}, onAskForReport() {}, onCompleteTask() {}, onSelect() {}, onIgnore() {}, onOpenResult() {}, onOpenSubagent() {}, onUnsettle() {}, onSettings() {}, onExpand() {},
  } satisfies RightPanelProps)));
  return { host, done: async () => { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; } };
}

const view = (fields: Record<string, unknown>) => taskView({ id: "T", name: "Docs", state: "running", createdAt: 1, updatedAt: 1, messageIDs: ["m"], kept: true, ...fields }, new Set());

describe("3. an open card hides its empty rows", () => {
  it("shows Now when there is one and no Next or Blocked rows", async () => {
    const { host, done } = await panel([view({ now: "writing the intro" })], "T");
    try {
      const labels = [...host.querySelectorAll(".task-card .task-field .task-field-label")].map((label) => label.textContent);
      expect(labels).toEqual(["Now"]);
      expect(host.querySelector(".task-card")!.textContent).not.toContain("—");
    } finally { await done(); }
  });

  it("a card with nothing to say has no field rows at all", async () => {
    const { host, done } = await panel([view({ state: "pending" })], "T");
    try { expect(host.querySelectorAll(".task-card .task-field")).toHaveLength(0); }
    finally { await done(); }
  });
});

describe("4. no bare card without a name", () => {
  it("a task with no name does not show", async () => {
    const { host, done } = await panel([view({ name: "  " })], "T");
    try {
      expect(host.querySelector(".task-card")).toBeNull();
      expect(host.querySelector(".task-row")).toBeNull();
    } finally { await done(); }
  });

  it("while a named task runs, the panel shows it rather than a bare \"Writing…\" card", async () => {
    const { host, done } = await panel([{ ...view({ now: "writing" }), atWork: true }], null);
    try {
      expect(host.querySelector(".now-card")).toBeNull();
      expect(host.querySelector('.task-group[data-group="running"] .task-row .task-row-name')!.textContent).toBe("Docs");
    } finally { await done(); }
  });

  it("with nothing declared yet, the status says Writing… without a contradicting \"Nothing under way\"", async () => {
    const { host, done } = await panel([], null);
    try {
      expect(host.querySelector(".now-line")!.textContent).toBe("Writing…");
      expect(host.querySelector(".task-none")).toBeNull();
    } finally { await done(); }
  });
});
