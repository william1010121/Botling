// @vitest-environment jsdom
// A worker whose run's words wait for its process to finish background work: the page header says what for and how
// long, the undelivered messages are marked "Not delivered yet", the live row says so instead of typing dots, and the
// left column's row says it too.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SubagentView, type BotView, type SubagentRowView, type WaitingOnView } from "../../src/contract";
import { subagentView } from "../../src/core/bot";
import { readSubagent, SubagentBook } from "../../src/core/subagents";
import { chatState, subagentState } from "../../src/renderer/payload";
import { railStateWord, railWorkerItems, railWorkerTime } from "../../src/renderer/rail-workers";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const bot: BotView = { id: "B", name: "board", role: "main", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 1, problem: null, heads: ["claude"], job: null, subagentRows: [] };
beforeAll(async () => {
  document.body.innerHTML = '<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>';
  await import("../../../Web/src/main");
});
afterEach(() => { window.ccb.setState(chatState({ ...bot, subagents: 0 }, { botId: "empty", messages: [], running: null, live: [] }).state); });

const NOW = Date.now();
const record = () => readSubagent({ id: "w", description: "board-zero-downtime", prompt: "Run five", type: "claude-worker", status: "running", background: true, startedAt: 0, steps: [
  { id: "m1", kind: "message", title: "Faster please", from: "coordinator", time: 0 },
] })!;
const waiting: WaitingOnView = { kind: "command", title: "Write deploy record and update TODO", since: NOW - 25 * 60_000, queued: 2 };

function render(on: WaitingOnView | null) {
  const r = record();
  const book = new SubagentBook([r]);
  if (on) book.waitingOn("w", on);
  const view = SubagentView.parse(subagentView(r, bot.name, book));
  window.ccb.setState(subagentState(bot, view).state);
  return { view, book, r };
}

describe("a worker whose words wait for its background work", () => {
  it("says in the header what it waits for and for how long, instead of Running", () => {
    const { view } = render(waiting);
    expect(view.waitingOn).toEqual(waiting);
    const meta = document.querySelector("#subagent-bar .meta")!.textContent!;
    expect(meta).not.toContain("Running");
    const wait = document.querySelector("#subagent-bar .waiting-on")!;
    expect(wait.textContent).toBe("Waiting for background command: Write deploy record and update TODO · 25 min");
  });

  it("marks the messages not delivered yet, and the live row says what they wait for instead of typing dots", () => {
    render(waiting);
    const badges = [...document.querySelectorAll("#messages .sub-from .queued-badge")];
    expect(badges).toHaveLength(2);
    expect(badges[0]!.textContent).toBe("Not delivered yet");
    expect((badges[0] as HTMLElement).title).toContain("Write deploy record and update TODO");
    expect(document.querySelector("#messages .sub-dots")).toBeNull();
    expect(document.querySelector("#messages .sub-waiting")?.textContent).toContain("Not delivered yet — waiting for background command: Write deploy record and update TODO");
  });

  it("shows nothing of it once delivered", () => {
    render(null);
    expect(document.querySelector("#subagent-bar .waiting-on")).toBeNull();
    expect(document.querySelector("#subagent-bar .meta")!.textContent).toContain("Running");
    expect(document.querySelectorAll("#messages .queued-badge")).toHaveLength(0);
    expect(document.querySelector("#messages .sub-dots")).not.toBeNull();
  });

  it("waiting for its earlier process to end, with no background work it knows of", () => {
    render({ kind: "process", title: "", since: NOW - 3 * 60_000, queued: 1 });
    expect(document.querySelector("#subagent-bar .waiting-on")!.textContent).toBe("Waiting for its earlier process to end · 3 min");
    expect(document.querySelectorAll("#messages .queued-badge")).toHaveLength(1);
  });

  it("is only shown while it runs", () => {
    const r = record();
    const book = new SubagentBook([r]);
    book.waitingOn("w", waiting);
    r.status = "completed";
    expect(subagentView(r, bot.name, book).waitingOn).toBeNull();
    expect(book.rows("claude")[0]!.waitingOn).toBeUndefined();
  });

  it("its left-column row says what it waits for and for how long", () => {
    const row: SubagentRowView = { id: "w", title: "board-zero-downtime", status: "running", head: "claude", startedAt: NOW - 40 * 60_000, endedAt: null, unsettledAt: null, settled: false, prompt: "Run five", waitingOn: waiting };
    const item = railWorkerItems({ ...bot, subagentRows: [row] }, NOW, { viewed: new Set(), since: 0, watching: null, folded: new Set(), all: new Set() })[0]!;
    expect(railStateWord(item, "en")).toBe("Waiting for background command: Write deploy record and update TODO");
    expect(railWorkerTime(item, NOW, "en")).toBe("25m");
    expect(railStateWord(item, "zh-Hant")).toBe("等背景指令：Write deploy record and update TODO");
  });
});
