import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CoreHarness, MAIN } from "../core-harness";
import { desktop, tempDir, until } from "../helpers";
import { chatState } from "../../src/renderer/payload";
import { backgroundTask, hasBackgroundWorkRunning } from "../../src/core/background-tasks";
import { scheduleCall, scheduledTask, settleSchedules } from "../../src/core/session-schedules";
import { toSwiftDate } from "../../src/core/store/records";
import type { BotView } from "../../src/contract";

const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const c of harnesses.splice(0)) await c.kill("SIGKILL"); });
const use = (id: string, name: string, input: object, parent: string | null = null) => ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, structured: unknown, failed = false, parent: string | null = null) => ({ type: "user", parent_tool_use_id: parent, tool_use_result: structured, message: { content: [{ type: "tool_result", tool_use_id: id, content: "Words alone do not establish a schedule.", is_error: failed }] } });
async function send(c: CoreHarness, frames: object[]) {
  const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: `SCHEDULE_FRAMES:${Buffer.from(JSON.stringify(frames)).toString("base64")}` });
  const ended = await until(() => c.of("turn.finished").find((e: any) => e.event.turnId === turnId));
  expect(ended.event).toMatchObject({ status: "done", text: "Schedule checked." });
}
function start(probeMonitor = false) {
  const dir = tempDir("schedules");
  const traceFile = join(dir, "schedule-protocol.jsonl");
  const c = new CoreHarness(dir, { BOTLING_FAKE_CLI: join(desktop, "test/fixtures/fake-schedules.mjs"),
    ...(probeMonitor ? { FAKE_SCHEDULES_PROBE_MONITOR: "1", FAKE_SCHEDULES_TRACE: traceFile } : {}) });
  harnesses.push(c);
  const tasks = () => JSON.parse(readFileSync(join(dir, "main/chat.json"), "utf8")).flatMap((r: any) => r.backgroundTasks ?? []);
  return { c, tasks, trace: () => readFileSync(traceFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}

describe("session schedules (1.x ScheduleWakeup / CronCreate)", () => {
  it("registers enforcement before the real schedule owner runs, retaining coordinator eligibility and child denial", async () => {
    const { c, tasks, trace } = start(true);
    await send(c, [use("owner-wake", "ScheduleWakeup", { prompt: "Retry" }), result("owner-wake", { scheduledFor: Date.now() + 3600_000 })]);
    const frames = trace();
    const initialize = frames.findIndex(f => f.direction === "in" && f.subtype === "initialize");
    const acknowledged = frames.findIndex(f => f.direction === "out" && f.type === "control_response" && f.requestId === frames[initialize]?.requestId);
    const user = frames.findIndex(f => f.direction === "in" && f.type === "user");
    expect(initialize).toBeGreaterThanOrEqual(0);
    expect(acknowledged).toBeGreaterThan(initialize);
    expect(user).toBeGreaterThan(acknowledged);
    const reply = (id: string) => frames.find(f => f.direction === "in" && f.type === "control_response" && f.requestId === id);
    // Empty means normal permissions still decide; it must never become an automatic allow.
    expect(reply("schedule-owner-monitor")?.response).toEqual({});
    const child = reply("schedule-child-monitor")?.response;
    expect(child).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    expect(JSON.parse(child.hookSpecificOutput.permissionDecisionReason)).toMatchObject({ code: "coordinator_only_monitor", executed: false,
      handback: { tool: "Monitor", input: { command: "fixture-only; never executed" }, requester_agent_id: "schedule-child" } });
    expect(tasks()).toMatchObject([{ id: "owner-wake", kind: "wakeup", status: "running" }]);
    expect(tasks()).toHaveLength(1); // Protocol probes never launch monitors or create task records.
  });

  it("persists successful schedules and carries their absolute times and cron fields into the reused Web task row", async () => {
    const { c, tasks } = start();
    const fire = Date.now() + 48 * 3600_000;
    await send(c, [use("wake", "ScheduleWakeup", { reason: "Retry tomorrow", prompt: "Check again" }), result("wake", { scheduledFor: fire }),
      use("cron", "CronCreate", { cron: "*/30 * * * *", prompt: "Check logs\nReport problems" }), result("cron", { id: "job-1", nextFireAt: fire })]);
    expect(tasks()).toMatchObject([{ id: "wake", kind: "wakeup", title: "Retry tomorrow", detail: "Check again", status: "running" },
      { id: "cron", kind: "cron", title: "Check logs", schedule: "*/30 * * * *", recurring: true, jobID: "job-1" }]);
    const chat = await c.chat();
    const bot = { id: MAIN, name: "Main", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] } as BotView;
    const { state } = chatState(bot, { ...chat, live: [], tasks: [] });
    // The row also carries the bot's own routines that will still run: the main bot's daily summary from routines.cron.
    expect(state.messages.at(-1)?.tasks).toMatchObject([{ id: "wake", kind: "wakeup", fires: fire }, { id: "cron", schedule: "*/30 * * * *", recurring: true },
      { id: expect.stringMatching(/^routine:cron:/), kind: "cron", title: "Daily summary", schedule: "15 8 * * *", recurring: true }]);
    const origin = chat.messages.find((message: any) => message.backgroundTasks?.length);
    const output = (taskId: string) => c.call({ type: "task.output", botId: MAIN, messageId: origin.id, taskId });
    expect((await output("wake")).text).toMatch(/^Fires .+\n\nCheck again$/);
    expect((await output("cron")).text).toMatch(/^cron \*\/30 \* \* \* \* · Fires .+\n\nCheck logs\nReport problems$/);
    expect(await c.call({ type: "task.output", botId: MAIN, messageId: "another-message", taskId: "cron" })).toEqual({ text: "" });
  });

  it("ignores failed, unstructured and subagent results; cancellation removes only matching pending schedules across turns", async () => {
    const { c, tasks } = start();
    const fire = Date.now() + 3600_000;
    await send(c, [use("wake", "ScheduleWakeup", { prompt: "Retry" }), result("wake", { scheduledFor: fire }),
      use("cron", "CronCreate", { cron: "* * * * *", prompt: "Check" }), result("cron", { id: "job-1" }),
      use("failed", "ScheduleWakeup", {}), result("failed", { scheduledFor: fire }, true),
      use("words", "ScheduleWakeup", {}), result("words", "Scheduled successfully"),
      use("child", "ScheduleWakeup", {}, "agent-parent"), result("child", { scheduledFor: fire }, false, "agent-parent")]);
    expect(tasks().map((t: any) => t.id)).toEqual(["wake", "cron"]);
    await send(c, [use("bad-delete", "CronDelete", { id: "job-1" }), result("bad-delete", { id: "job-1" }, true)]);
    expect(tasks()).toHaveLength(2);
    await send(c, [use("delete", "CronDelete", { id: "job-1" }), result("delete", { id: "job-1" }),
      use("stop", "ScheduleWakeup", { stop: true }), result("stop", { stopped: true, cancelledWakeups: 1 })]);
    expect(tasks()).toEqual([]);
    // Cancellation also reaches work still in this very turn.
    await send(c, [use("new", "ScheduleWakeup", { prompt: "Retry" }), result("new", { scheduledFor: fire }),
      use("stop-new", "ScheduleWakeup", { stop: true }), result("stop-new", { stopped: true })]);
    expect(tasks()).toEqual([]);
  });
  it("settles due one-shot schedules only on agent activity, while recurring jobs remain pending", async () => {
    const { c, tasks } = start();
    const due = Date.now() - 10_000;
    await send(c, [use("wake", "ScheduleWakeup", { prompt: "Retry" }), result("wake", { scheduledFor: due }),
      use("once", "CronCreate", { cron: "* * * * *", prompt: "Once", recurring: false }), result("once", { id: "once-job", nextFireAt: due }),
      use("repeat", "CronCreate", { cron: "* * * * *", prompt: "Repeat" }), result("repeat", { id: "repeat-job", nextFireAt: due })]);
    expect(tasks()).toMatchObject([{ id: "wake", status: "completed", summary: "Fired." }, { id: "once", status: "completed", summary: "Fired." }, { id: "repeat", status: "running" }]);
    const chat = await c.chat();
    const origin = chat.messages.find((message: any) => message.backgroundTasks?.length);
    expect(origin.backgroundTasks.map((task: any) => task.summary)).toEqual(["Fired.", "Fired.", null]);
    expect(await c.call({ type: "task.output", botId: MAIN, messageId: origin.id, taskId: "wake" })).toEqual({ text: "Fired.\n\nRetry" });
    expect(await c.call({ type: "task.output", botId: MAIN, messageId: origin.id, taskId: "once" })).toEqual({ text: "cron * * * * * (once) · Fired.\n\nOnce" });
  });

  it("uses Claude's clock when present, computes older cron results, and applies the 1.x grace/expiry rules", () => {
    const now = Date.now();
    const wake = scheduledTask("wake", scheduleCall("ScheduleWakeup", { reason: "Wait", prompt: "Retry" })!, { stopped: false, fireAt: now + 48 * 3600_000 }, now)!;
    const recurring = scheduledTask("cron", scheduleCall("CronCreate", { cron: "* * * * *", prompt: "Check" })!, { stopped: false, jobID: "j" }, now)!;
    const once = scheduledTask("once", scheduleCall("CronCreate", { cron: "* * * * *", recurring: false })!, { stopped: false, jobID: "o", fireAt: now }, now)!;
    expect(recurring.fireAt).toBe(toSwiftDate(Math.floor(now / 60_000) * 60_000 + 60_000));
    const records = [{ id: "r", role: "bot" as const, text: "", date: toSwiftDate(now), backgroundTasks: [wake, recurring] }];
    expect(hasBackgroundWorkRunning(records, now + 7 * 3600_000)).toBe(true);
    expect(hasBackgroundWorkRunning([{ ...records[0]!, backgroundTasks: [wake] }], now + 48 * 3600_000 + 15 * 60_000)).toBe(false);
    expect(hasBackgroundWorkRunning([{ ...records[0]!, backgroundTasks: [once] }], now + 15 * 60_000 - 1)).toBe(true);
    expect(hasBackgroundWorkRunning([{ ...records[0]!, backgroundTasks: [recurring] }], now + 7 * 24 * 3600_000)).toBe(false);
    expect(settleSchedules([recurring], now + 7 * 24 * 3600_000)).toBe(true);
    expect(recurring).toMatchObject({ status: "completed", summary: "Expired (claude ends a recurring job after 7 days)." });
    expect(settleSchedules([backgroundTask("cmd", "command", "Build", "npm test")], now + 8 * 24 * 3600_000)).toBe(false);
  });
});
