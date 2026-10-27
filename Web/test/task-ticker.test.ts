// The task list's once-a-second tick (tasks.ts) runs only while a running task's line is on the page and
// the page is shown: an idle chat has no timer. Shown again, every time is brought up to date at once
// from the wall clock (each line's start), not from counted ticks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLanguage } from "../src/i18n";
import { messageElement } from "../src/messages";
import { resetTaskChips, setTaskClock, startTaskTicks, syncTaskTicks, taskTicking } from "../src/tasks";
import type { MessageView, TaskChipView } from "../src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const start = Date.UTC(2026, 9, 21, 12, 0, 0);
let now = start;
const task = (overrides: Partial<TaskChipView> = {}): TaskChipView => ({ id: "toolu_B", kind: "command", title: "Tests", status: "running", started: start - 60_000, ended: null, detail: "npm test", ...overrides });
const reply = (tasks: TaskChipView[]): MessageView => ({
  id: "m1", role: "bot", text: "Started.", stamp: null, avatar: null, choices: null, chosen: null, answer: null, open: false, displays: null,
  attachments: null, replyTo: null, replyPreview: null, openable: false, tasks,
});
let visibility: DocumentVisibilityState = "visible";
const setVisibility = (state: DocumentVisibilityState) => { visibility = state; document.dispatchEvent(new Event("visibilitychange")); };
const open = (tasks: TaskChipView[]) => {
  const row = messageElement(reply(tasks), {});
  document.body.replaceChildren(row);
  row.querySelector<HTMLButtonElement>(".task-summary .task-group")!.click();
  return row;
};
const time = () => document.querySelector(".task-item.running .task-time")?.textContent;

describe("task tick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setLanguage("en");
    now = start;
    setTaskClock(() => now);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    visibility = "visible";
    document.body.innerHTML = "";
    resetTaskChips();
    startTaskTicks();
    syncTaskTicks();
  });
  afterEach(() => {
    document.body.innerHTML = "";
    syncTaskTicks();
    vi.useRealTimers();
  });

  it("does not run with no running task on the page", () => {
    expect(taskTicking()).toBe(false);
    open([task({ status: "completed", ended: start })]);
    expect(taskTicking()).toBe(false);
  });

  it("runs while a running line is shown, and stops once none is left", () => {
    open([task()]);
    expect(taskTicking()).toBe(true);
    expect(time()).toBe("1 min 0 sec");
    now += 5_000;
    vi.advanceTimersByTime(1_000);
    expect(time()).toBe("1 min 5 sec");
    // The task finished: the list is drawn again without a running line, and the next tick ends the timer.
    open([task({ status: "completed", ended: now })]);
    vi.advanceTimersByTime(1_000);
    expect(taskTicking()).toBe(false);
  });

  it("stops while the page is hidden and, shown again, catches up from the wall clock at once", () => {
    open([task()]);
    setVisibility("hidden");
    expect(taskTicking()).toBe(false);
    now += 10 * 60_000;
    vi.advanceTimersByTime(10 * 60_000);
    expect(time()).toBe("1 min 0 sec");
    setVisibility("visible");
    expect(time()).toBe("11 min 0 sec");
    expect(taskTicking()).toBe(true);
  });

  it("a running line drawn while the page is hidden waits for it to be shown", () => {
    setVisibility("hidden");
    open([task()]);
    expect(taskTicking()).toBe(false);
    setVisibility("visible");
    expect(taskTicking()).toBe(true);
  });
});
