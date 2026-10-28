// @vitest-environment jsdom
// 1.x ChatPayload.shownBackgroundTasks/backgroundRowIndex → the unchanged Web/src/tasks UI.
import { beforeEach, expect, it } from "vitest";
import type { BotView, ChatSnapshot } from "../../src/contract";
import { EventEnvelope } from "../../src/contract";
import { messageView } from "../../src/core/bot";
import type { BackgroundTask } from "../../src/core/background-tasks";
import { toSwiftDate, type ChatRecord } from "../../src/core/store/records";
import { chatState } from "../../src/renderer/payload";
import { sent } from "../../../Web/src/bridge";
import { resetTaskChips, taskChips, taskOutput } from "../../../Web/src/tasks";

const now = Date.UTC(2026, 9, 26, 9);
const bot: BotView = { id: "B", name: "Main", role: "main", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const task = (id: string, over: Partial<BackgroundTask> = {}): BackgroundTask => ({ id, kind: "command", title: id, status: "running", startedAt: toSwiftDate(now - 60_000), ...over });
const line = (id: string, role: ChatRecord["role"], at: number, tasks: BackgroundTask[] = []): ChatRecord => ({ id, role, text: id, date: toSwiftDate(at), backgroundTasks: tasks });
function draw(records: ChatRecord[], extra: Partial<ChatSnapshot> = {}) {
  // Validate the same message envelope the renderer receives (including updates after completion).
  const messages = records.map((record) => EventEnvelope.parse({ v: 10, epoch: "e", seq: 1,
    event: { type: "message.updated", botId: "6A0B0000-0000-4000-8000-000000000002", message: messageView(record) } }).event)
    .map((event) => (event as Extract<typeof event, { type: "message.updated" }>).message);
  return chatState(bot, { botId: bot.id, messages, running: null, live: [], tasks: [], runs: [], heads: null, catchUp: null, intervalSummaries: [], pins: [], floating: [], pinChoices: [], ...extra }).state.messages;
}
beforeEach(() => { resetTaskChips(); sent.length = 0; document.body.innerHTML = ""; });

it("puts one row on the latest bot/notice, retaining running work and only recently finished work", () => {
  const records = [line("old", "bot", now - 120_000, [task("running"), task("cleared", { status: "completed", endedAt: toSwiftDate(now) }),
    task("recent", { status: "failed", endedAt: toSwiftDate(now + 1) }), task("no-end", { status: "stopped" })]),
    line("you", "user", now), line("reply", "bot", now + 1000, [task("new-done", { status: "completed" })]), line("notice", "notice", now + 2000)];
  const messages = draw(records);
  expect(messages.filter((message) => message.tasks?.length).map((message) => message.id)).toEqual(["notice"]);
  expect(messages.at(-1)!.tasks).toEqual([
    expect.objectContaining({ id: "running", message: "old", started: now - 60_000, ended: null }),
    expect.objectContaining({ id: "recent", message: "old", ended: now + 1 }),
    expect.objectContaining({ id: "new-done", message: "reply" }),
  ]);
  // Your next line clears finished items, but the row stays on the bot's latest line.
  const next = draw([...records, line("next", "user", now + 3000)]);
  expect(next.find((m) => m.id === "notice")!.tasks?.map((t) => t.id)).toEqual(["running"]);
  expect(next.at(-1)!.tasks).toBeNull();
});

it("has no row with no work or no bot/notice; ignores a hidden empty streaming reply", () => {
  expect(draw([line("you", "user", now, [task("orphan")])]).some((m) => m.tasks?.length)).toBe(false);
  expect(draw([line("empty", "bot", now)]).some((m) => m.tasks?.length)).toBe(false);
  const messages = draw([line("old", "bot", now, [task("running")]), { ...line("stream", "bot", now), text: "" }],
    { running: { turnId: "t", messageId: "stream" } });
  expect(messages.map((m) => m.id)).toEqual(["old"]);
  expect(messages[0].tasks?.map((t) => t.id)).toEqual(["running"]);
});

it("passes scheduled metadata and all four buckets to Web's list; requests output from the originating reply", () => {
  const messages = draw([line("origin", "bot", now, [task("agent", { kind: "agent" }), task("wake", { kind: "wakeup", fireAt: toSwiftDate(now + 60_000) }),
    task("cron", { kind: "cron", schedule: "*/5 * * * *", recurring: false }), task("done", { status: "completed" }), task("failed", { status: "interrupted" })]), line("latest", "notice", now + 1000)]);
  expect(messages[1].tasks?.find((t) => t.id === "wake")).toMatchObject({ fires: now + 60_000 });
  expect(messages[1].tasks?.find((t) => t.id === "cron")).toMatchObject({ schedule: "*/5 * * * *", recurring: false });
  const row = taskChips("latest", messages[1].tasks ?? []);
  document.body.append(row);
  expect([...row.querySelectorAll(".task-group")].map((e) => e.getAttribute("data-bucket"))).toEqual(["agent", "waiting", "done", "failed"]);
  row.querySelector<HTMLButtonElement>(".task-group.agent")!.click();
  row.querySelector<HTMLButtonElement>(".task-item")!.click();
  expect(sent.at(-1)).toEqual({ type: "taskOutput", messageID: "origin", taskID: "agent" });
  taskOutput("origin", "agent", "Found 3 things.");
  expect(row.textContent).toContain("Found 3 things.");
});

it("keeps completed coordinator execution visible until its callback is resolved, without reviving it", () => {
  const monitor = { ownerSession: "owner", threadId: "th", turnId: "turn", execution: "succeeded", callback: "pending" };
  const records = [line("origin", "bot", now - 120_000, [task("monitor", { kind: "monitor", title: "Coordinator monitor: echo ok", status: "completed", endedAt: toSwiftDate(now - 60_000), monitor })]), line("next", "user", now), line("reply", "bot", now + 1000)];
  const shown = draw(records).at(-1)!.tasks!;
  expect(shown).toMatchObject([{ status: "completed", message: "origin", monitor: { callback: "pending" } }]);
  const row = taskChips("reply", shown);
  row.querySelector<HTMLButtonElement>(".task-group.done")!.click();
  expect(row.textContent).toContain("succeeded · callback: pending");
  monitor.callback = "delivered";
  expect(draw(records).at(-1)!.tasks?.length ?? 0).toBe(0);
});
