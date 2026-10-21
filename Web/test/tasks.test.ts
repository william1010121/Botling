/// <reference types="node" />
import { beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { messageElement } from "../src/messages";
import { bucketOf, countTasks, elapsed, resetTaskChips, setTaskClock, taskOutput, tickTaskChips } from "../src/tasks";
import type { MessageView, TaskChipView } from "../src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const now = Date.UTC(2026, 9, 21, 12, 0, 0);

function task(overrides: Partial<TaskChipView> = {}): TaskChipView {
  return { id: "toolu_B", kind: "command", title: "跑測試與建置", status: "running", started: now - 192_000, ended: null, detail: "swift test", ...overrides };
}

function reply(tasks: TaskChipView[], id = "m1", role: MessageView["role"] = "bot"): MessageView {
  return {
    id, role, text: "I started the tests.", stamp: null, avatar: null,
    choices: null, chosen: null, answer: null, open: false, displays: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false, tasks,
  };
}

function summary(element: HTMLElement): HTMLElement {
  return element.querySelector<HTMLElement>(".task-summary")!;
}

function items(element: HTMLElement): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>(".task-item")];
}

function list(element: HTMLElement): HTMLElement {
  return element.querySelector<HTMLElement>(".task-list")!;
}

describe("background task chips", () => {
  beforeEach(() => {
    sent.length = 0;
    document.body.innerHTML = "";
    setTaskClock(() => now);
    resetTaskChips();
  });

  it("says how long, in words", () => {
    expect(elapsed(45_000)).toBe("45 秒");
    expect(elapsed(192_000)).toBe("3 分 12 秒");
    expect(elapsed(3_900_000)).toBe("1 小時 5 分");
  });

  function group(element: HTMLElement, bucket: string): HTMLButtonElement | null {
    return summary(element).querySelector<HTMLButtonElement>(`.task-group.${bucket}`);
  }

  function count(element: HTMLElement, bucket: string): string | null | undefined {
    return group(element, bucket)?.querySelector(".task-count")?.textContent;
  }

  const mixed = () => [
    task({ id: "a", kind: "agent", title: "Review the diff", message: "m0" }),
    task({ id: "b", kind: "agent", title: "Write the docs", message: "m0", started: now - 5_000 }),
    task({ id: "c", message: "m0" }),
    task({ id: "d", status: "completed", ended: now, message: "m1" }),
    task({ id: "e", kind: "agent", status: "completed", ended: now, message: "m1" }),
    task({ id: "f", status: "failed", ended: now, message: "m1" }),
    task({ id: "g", status: "killed", ended: now, message: "m1" }),
    task({ id: "h", kind: "agent", status: "interrupted", ended: now, message: "m1" }),
  ];

  it("sorts the work into running subagents, other waiting work, done and failed", () => {
    expect(bucketOf(task({ kind: "agent" }))).toBe("agent");
    expect(bucketOf(task())).toBe("waiting");
    expect(bucketOf(task({ kind: "agent", status: "completed" }))).toBe("done");
    expect(bucketOf(task({ status: "completed" }))).toBe("done");
    for (const status of ["failed", "killed", "stopped", "interrupted"] as const) {
      expect(bucketOf(task({ kind: "agent", status }))).toBe("failed");
    }
    expect(countTasks(mixed())).toEqual({ agent: 2, waiting: 1, done: 2, failed: 3 });
    expect(countTasks([])).toEqual({ agent: 0, waiting: 0, done: 0, failed: 0 });
  });

  it("shows four icons side by side, subagent then waiting then done then failed, each with its count", () => {
    const row = messageElement(reply(mixed(), "m2"), {});
    const groups = [...summary(row).querySelectorAll<HTMLElement>(".task-group")];
    expect(groups.map((g) => g.dataset.bucket)).toEqual(["agent", "waiting", "done", "failed"]);
    expect(count(row, "agent")).toBe("2");
    expect(count(row, "waiting")).toBe("1");
    expect(count(row, "done")).toBe("2");
    expect(count(row, "failed")).toBe("3");
    // Each its own glyph.
    const glyphs = groups.map((g) => g.querySelector(".task-icon")!.innerHTML);
    expect(new Set(glyphs).size).toBe(4);
    expect(summary(row).getAttribute("aria-label")).toBe("背景工作：2 subagent 執行中、1 等待中、2 成功、3 錯誤");
    expect(group(row, "agent")!.title).toContain("Review the diff");
    expect(group(row, "agent")!.title).not.toContain("跑測試與建置");
    expect(group(row, "waiting")!.title).toContain("3 分 12 秒");
    expect(list(row).hidden).toBe(true);
  });

  it("shows only the kinds there are", () => {
    const row = messageElement(reply([task({ id: "a", status: "completed", ended: now }), task({ id: "b", status: "completed", ended: now })]), {});
    expect(group(row, "agent")).toBeNull();
    expect(group(row, "waiting")).toBeNull();
    expect(group(row, "failed")).toBeNull();
    expect(count(row, "done")).toBe("2");
    expect(summary(row).textContent?.trim()).toBe("2");
  });

  it("goes under your own line too, when it is the latest message", () => {
    const row = messageElement(reply([task({ kind: "agent", message: "m0" })], "u1", "user"), {});
    expect(row.querySelector(".user-column > .task-chips")).not.toBeNull();
    expect(count(row, "agent")).toBe("1");
    // A message without the chat's work draws no row.
    expect(messageElement(reply([], "u2", "user"), {}).querySelector(".task-chips")).toBeNull();
  });

  it("opens the list grouped by the four, filtered to the icon pressed", () => {
    const row = messageElement(reply(mixed(), "m2"), {});
    document.body.append(row);
    group(row, "failed")!.click();
    expect(list(row).hidden).toBe(false);
    expect(group(row, "failed")!.getAttribute("aria-expanded")).toBe("true");
    expect([...list(row).querySelectorAll<HTMLElement>(".task-section")].map((s) => s.dataset.bucket)).toEqual(["failed"]);
    expect(items(row).map((i) => i.dataset.task)).toEqual(["f", "g", "h"]);
    // All of them, grouped in the row's order.
    list(row).querySelector<HTMLButtonElement>('.task-filter[data-filter="all"]')!.click();
    expect([...list(row).querySelectorAll<HTMLElement>(".task-section")].map((s) => s.dataset.bucket)).toEqual(["agent", "waiting", "done", "failed"]);
    expect(items(row)).toHaveLength(8);
    // Another filter tab.
    list(row).querySelector<HTMLButtonElement>('.task-filter[data-filter="agent"]')!.click();
    expect(items(row).map((i) => i.textContent)).toEqual(["Write the docs5 秒", "Review the diff3 分 12 秒"]);
    // Another icon switches to its kind; the same icon again closes.
    group(row, "waiting")!.click();
    expect(items(row).map((i) => i.dataset.task)).toEqual(["c"]);
    group(row, "waiting")!.click();
    expect(list(row).hidden).toBe(true);
  });

  it("moves to the latest message, the list still open", () => {
    const first = messageElement(reply(mixed(), "m2"), {});
    group(first, "done")!.click();
    // A new message came: the app now sends the work with it, and not with the one before.
    const before = messageElement(reply([], "m2"), {});
    const latest = messageElement(reply([...mixed(), task({ id: "i", status: "completed", ended: now, message: "m2" })], "m3"), {});
    expect(before.querySelector(".task-chips")).toBeNull();
    expect(latest.querySelector<HTMLElement>(".task-chips")!.dataset.message).toBe("m3");
    expect(count(latest, "done")).toBe("3");
    expect(list(latest).hidden).toBe(false);
    expect(items(latest).map((i) => i.dataset.task)).toEqual(["d", "e", "i"]);
  });

  it("lists each task with its status and time", () => {
    const row = messageElement(reply([
      task({ id: "a" }),
      task({ id: "b", status: "completed", ended: now - 100_000 }),
      task({ id: "c", status: "stopped", ended: now }),
    ]), {});
    document.body.append(row);
    group(row, "waiting")!.click();
    list(row).querySelector<HTMLButtonElement>('.task-filter[data-filter="all"]')!.click();
    const [running, completed, stopped] = items(row);
    expect(running.textContent).toContain("跑測試與建置");
    expect(running.textContent).toContain("3 分 12 秒");
    expect(completed.textContent).toContain("1 分 32 秒");
    expect(completed.querySelector(".task-mark svg")).not.toBeNull();
    expect(stopped.textContent).toContain("已中斷");
    // The running one's time goes on.
    tickTaskChips(now + 10_000);
    expect(running.textContent).toContain("3 分 22 秒");
  });

  it("opens a task to its last lines of output, asked of the app by the message that started it", () => {
    const row = messageElement(reply([task({ message: "m0" })], "m5"), {});
    document.body.append(row);
    group(row, "waiting")!.click();
    items(row)[0].click();
    expect(sent).toContainEqual({ type: "taskOutput", messageID: "m0", taskID: "toolu_B" });
    const panel = row.querySelector<HTMLElement>(".task-output")!;
    expect(panel.hidden).toBe(false);
    taskOutput("m0", "toolu_B", "compiling\nTest run with 3 tests passed");
    expect(panel.textContent).toBe("compiling\nTest run with 3 tests passed");
    // Read again every 5 seconds while it runs.
    sent.length = 0;
    tickTaskChips(Math.ceil(now / 5000) * 5000);
    expect(sent).toContainEqual({ type: "taskOutput", messageID: "m0", taskID: "toolu_B" });
    // Still open, with its output, when drawn again (under a newer message; its kind gone, the list shows all).
    const again = messageElement(reply([task({ status: "completed", ended: now, message: "m0" })], "m6"), {});
    document.body.innerHTML = "";
    document.body.append(again);
    expect(list(again).hidden).toBe(false);
    expect(again.querySelector<HTMLElement>(".task-output")!.hidden).toBe(false);
    expect(again.querySelector(".task-output")!.textContent).toBe("compiling\nTest run with 3 tests passed");
    // Closed again.
    items(again)[0].click();
    expect(again.querySelector<HTMLElement>(".task-output")!.hidden).toBe(true);
  });

  it("draws no strip without background work", () => {
    expect(messageElement(reply([]), {}).querySelector(".task-chips")).toBeNull();
  });
});
