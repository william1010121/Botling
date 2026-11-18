// @vitest-environment jsdom
// The words a routine is put into, one way everywhere: the shared English module (Routines panel, sub bot menu) says a cron line
// as the chat page's background-work row does, and that row draws a routine's chip with the same next-run format, a dot for how it
// stands and, in its tooltip, the last run.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../../Web/src/i18n";
import { messageElement } from "../../../Web/src/messages";
import { cadence, clock, cronWords, distance, lastLine } from "../../../Web/src/routine-words";
import { agoWords, awayWords, dayWords, describeCron, resetTaskChips, setTaskClock, tickTaskChips } from "../../../Web/src/tasks";
import type { MessageView, TaskChipView } from "../../../Web/src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

describe("cron in words", () => {
  const lines = ["*/30 * * * *", "* * * * *", "7 * * * *", "0 9 * * *", "0 9 * * 1-5", "0 9 * * 6,0", "30 18 * * 1,4", "0 */2 * * *", "0 9 22 10 *", "0 9 3 * *", "7,37 * * * *", "not cron", "0 9 * * 7"];
  it("says each line as the background-work row does in English", () => {
    setLanguage("en");
    for (const line of lines) expect(cronWords(line), line).toBe(describeCron(line));
  });
  it("prefers the cron fields over the app's own phrase, and says a one-time routine as such", () => {
    expect(cadence({ kind: "recurring", schedule: "Every day 08:15", cron: "15 8 * * *" })).toBe("Daily 08:15");
    expect(cadence({ kind: "legacy", schedule: "*/10 * * * *", cron: null })).toBe("Every 10 min");
    expect(cadence({ kind: "legacy", schedule: "Once, at the next check", cron: "@once" })).toBe("Once, at the next check");
    expect(cadence({ kind: "once", schedule: "2026-11-20T06:30:00.000Z", cron: null })).toBe("One time");
  });
});

describe("time words", () => {
  const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
  it("the panel and the chat page say a time alike", () => {
    setLanguage("en");
    const now = at(8, 12);
    for (const when of [at(8, 18), at(9, 9), at(12, 10, 30), at(10, 7)]) expect(dayWords(when, now)).toBe(clock(when, now).replace(/^Nov (\d+), /, "11/$1 "));
    expect(distance(now + 21 * 3_600_000, now)).toBe("in 21 h");
    // How far off a routine's next run is: the chip rounds as the panel does ("in 21 h", never "in 20 h 30 min"; "in 2 d", not "in 2 days")
    for (const gap of [30_000, 6 * 60_000, 20.5 * 3_600_000, 47 * 3_600_000, 52 * 3_600_000, 5 * 86_400_000]) expect(awayWords(gap), String(gap)).toBe(distance(now + gap, now));
    expect(agoWords(4 * 60_000)).toBe("4 min ago");
    expect(agoWords(30 * 3_600_000)).toBe("30 h ago");
  });
  it("the last-result line is there for every kind: sent, a watch's own run, or not yet", () => {
    const now = at(8, 12);
    const base = { kind: "recurring" as const, schedule: "Daily 09:00", cron: "0 9 * * *", timezone: "system_local", status: "pending", next: null };
    expect(lastLine(base, now)).toEqual({ word: "Not run yet", detail: "", tone: "off" });
    expect(lastLine({ ...base, lastRun: new Date(now - 3 * 3_600_000).toISOString(), lastResult: "sent" }, now)).toEqual({ word: "Last run sent to the bot", detail: "3 h ago", tone: "done" });
    expect(lastLine({ ...base, status: "delivery_uncertain" }, now)).toBeNull();
    const watch = { command: "./c.sh", state: "failing" as const, lastRun: new Date(now - 4 * 60_000).toISOString(), exit: 3, timedOut: false };
    expect(lastLine({ ...base, watch }, now)).toEqual({ word: "Last run failed", detail: "exit 3 · 4 min ago", tone: "bad" });
  });
});

describe("a routine's chip", () => {
  const now = new Date(2026, 9, 21, 12, 0).getTime();
  const routine = (over: Partial<TaskChipView> = {}): TaskChipView => ({
    id: "routine:R1", kind: "cron", title: "Morning digest", status: "running", started: Number.MAX_SAFE_INTEGER, ended: null, detail: "Collect the news",
    fires: new Date(2026, 9, 22, 9, 0).getTime(), schedule: "0 9 * * *", recurring: true, routine: { state: "scheduled", last: { at: now - 3 * 3_600_000, result: "sent" } }, ...over,
  });
  const reply = (tasks: TaskChipView[]): MessageView => ({
    id: "m1", role: "bot", text: "ok", stamp: null, avatar: null, choices: null, chosen: null, answer: null, open: false, displays: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false, tasks,
  });
  afterEach(() => setLanguage("en"));
  beforeEach(() => { document.body.innerHTML = ""; setTaskClock(() => now); resetTaskChips(); setLanguage("en"); });
  const line = (tasks: TaskChipView[]) => {
    const row = messageElement(reply(tasks), {});
    document.body.append(row);
    row.querySelector<HTMLElement>(".task-group.waiting")!.click();
    return row.querySelector<HTMLElement>(".task-item")!;
  };

  it("says its cadence beside the name, how it stands in a dot, and its next run in the panel's format", () => {
    const item = line([routine()]);
    expect(item.querySelector(".task-cadence")!.textContent).toBe("Daily 09:00");
    expect(item.querySelector<HTMLElement>(".task-dot")!.dataset.tone).toBe("ok");
    expect(item.querySelector(".task-time")!.textContent).toBe("Tomorrow 09:00 · in 21 h");
    expect(item.title).toBe("Routine: Collect the news\nLast run sent to the bot · 3 h ago");
  });
  it("a failing watch is red, a one-time routine says Once, one never run says so, and the next run moves on with the clock", () => {
    expect(line([routine({ routine: { state: "failing", last: { at: now - 60_000, result: "failed" } } })]).querySelector<HTMLElement>(".task-dot")!.dataset.tone).toBe("bad");
    document.body.innerHTML = ""; resetTaskChips();
    const once = line([routine({ recurring: false, schedule: null, routine: { state: "scheduled", last: null } })]);
    expect(once.querySelector(".task-cadence")!.textContent).toBe("Once");
    expect(once.title).toContain("Not run yet");
    setTaskClock(() => now + 24 * 3_600_000);
    tickTaskChips(now + 24 * 3_600_000);
    expect(once.querySelector(".task-time")!.textContent).toBe("due now");
  });
  it("a task its head started keeps its own line: no cadence, no dot", () => {
    const item = line([routine({ routine: null })]);
    expect(item.querySelector(".task-cadence")).toBeNull();
    expect(item.querySelector(".task-dot")).toBeNull();
  });
  it("in the app's Traditional Chinese too", () => {
    setLanguage("zh-Hant");
    const item = line([routine()]);
    expect(item.querySelector(".task-cadence")!.textContent).toBe("每天 09:00");
    expect(item.querySelector(".task-time")!.textContent).toBe("明天 09:00 · 21 小時後");
    expect(item.title).toContain("上次執行：已交給 bot · 3 小時前");
  });
});
