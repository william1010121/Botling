// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { chatState } from "../../src/renderer/payload";
import { messageView } from "../../src/core/bot";
import { toSwiftDate } from "../../src/core/store/records";
import { setLanguage } from "../../../Web/src/i18n";
import { taskChips, resetTaskChips, setTaskClock, taskOutput } from "../../../Web/src/tasks";
import { backgroundTaskOutput } from "../../src/core/background-work";
import type { BackgroundTask } from "../../src/core/background-tasks";
import type { ShellMessage } from "../../src/renderer/chat-frame/protocol";
import { editorMessageAllowed } from "../../src/editor-host-wire";
import type { BotView } from "../../src/contract";

const bot = { id: "B", name: "Main", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] } as BotView;
afterEach(() => { document.body.replaceChildren(); resetTaskChips(); setTaskClock(() => Date.now()); });
it("draws wake-up and cron countdowns in the existing task list, then clears completed rows at the next user message", async () => {
  setLanguage("en");
  const now = Date.UTC(2026, 9, 26, 8);
  setTaskClock(() => now);
  const date = toSwiftDate(now);
  const base = { status: "running" as const, startedAt: date, detail: "Check the service", fireAt: toSwiftDate(now + 20 * 60_000) };
  const backgroundTasks: BackgroundTask[] = [
    { ...base, id: "wake", kind: "wakeup", title: "Retry" }, { ...base, id: "cron", kind: "cron", title: "Logs", schedule: "*/30 * * * *", recurring: true },
  ];
  const messages = [messageView({ id: "r1", role: "bot", text: "Scheduled.", date, backgroundTasks }), messageView({ id: "r2", role: "bot", text: "More news.", date })];
  const { state } = chatState(bot, { botId: "B", messages, running: null, live: [], tasks: [] }, new Date(now));
  expect(state.messages[0]!.tasks).toBeNull();
  const tasks = state.messages[1]!.tasks!;
  expect(tasks.map((task) => task.message)).toEqual(["r1", "r1"]);
  const strip = taskChips("r2", tasks);
  document.body.append(strip);
  strip.querySelector<HTMLButtonElement>('[data-bucket="waiting"]')!.click();
  expect(strip.querySelector('[data-task="wake"] .task-time')?.textContent).toBe("in 20 min");
  expect(strip.querySelector('[data-task="cron"] .task-time')?.textContent).toContain("Every 30 min");
  expect(strip.querySelector('[data-task="wake"]')?.getAttribute("title")).toContain("ScheduleWakeup");
  expect(strip.querySelector('[data-task="cron"]')?.getAttribute("title")).toContain("CronCreate");
  strip.querySelector<HTMLButtonElement>('[data-task="cron"]')!.click();
  const reply: ShellMessage = { botling: "taskOutput", botID: bot.id, messageID: "r1", taskID: "cron", text: await backgroundTaskOutput(backgroundTasks[1]!) };
  expect(reply).toMatchObject({ botling: "taskOutput", messageID: "r1", taskID: "cron" });
  expect(editorMessageAllowed("down", reply)).toBe(true);
  expect(reply.text).toContain("cron */30 * * * * · Fires ");
  expect(reply.text).toContain("Check the service");
  taskOutput(reply.messageID, reply.taskID, reply.text);
  expect(strip.querySelector(".task-output")?.textContent).toBe(reply.text);
  for (const message of messages) for (const task of message.backgroundTasks ?? []) { task.status = "completed"; task.ended = now; }
  messages.push(messageView({ id: "u", role: "user", text: "Next task", date: toSwiftDate(now + 1) }));
  expect(chatState(bot, { botId: "B", messages, running: null, live: [], tasks: [] }).state.messages.flatMap((message) => message.tasks ?? [])).toEqual([]);
});
