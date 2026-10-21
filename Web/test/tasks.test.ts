/// <reference types="node" />
import { beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { messageElement } from "../src/messages";
import { elapsed, setTaskClock, taskOutput, tickTaskChips } from "../src/tasks";
import type { MessageView, TaskChipView } from "../src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const now = Date.UTC(2026, 9, 21, 12, 0, 0);

function task(overrides: Partial<TaskChipView> = {}): TaskChipView {
  return { id: "toolu_B", kind: "command", title: "跑測試與建置", status: "running", started: now - 192_000, ended: null, detail: "swift test", ...overrides };
}

function reply(tasks: TaskChipView[]): MessageView {
  return {
    id: "m1", role: "bot", text: "I started the tests.", stamp: null, avatar: null,
    choices: null, chosen: null, answer: null, open: false, displays: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false, tasks,
  };
}

function summary(element: HTMLElement): HTMLButtonElement {
  return element.querySelector<HTMLButtonElement>(".task-summary")!;
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
  });

  it("says how long, in words", () => {
    expect(elapsed(45_000)).toBe("45 秒");
    expect(elapsed(192_000)).toBe("3 分 12 秒");
    expect(elapsed(3_900_000)).toBe("1 小時 5 分");
  });

  function group(element: HTMLElement, tone: string): HTMLElement | null {
    return summary(element).querySelector<HTMLElement>(`.task-group.${tone}`);
  }

  function count(element: HTMLElement, tone: string): string | null | undefined {
    return group(element, tone)?.querySelector(".task-count")?.textContent;
  }

  it("shows a spinner and its count under the reply for one running task, its words in the tooltip", () => {
    const row = messageElement(reply([task()]), {});
    document.body.append(row);
    const button = summary(row);
    expect(group(row, "running")!.querySelector(".task-spin")).not.toBeNull();
    expect(count(row, "running")).toBe("1");
    // Only the kinds there are; no title, no timer under the reply.
    expect(group(row, "done")).toBeNull();
    expect(group(row, "failed")).toBeNull();
    expect(button.textContent?.trim()).toBe("1");
    expect(button.title).toContain("跑測試與建置");
    expect(button.title).toContain("3 分 12 秒");
    expect(list(row).hidden).toBe(true);
  });

  it("shows up to three icons side by side, running then done then failed, each with its count", () => {
    const row = messageElement(reply([
      task({ id: "a" }),
      task({ id: "b", status: "completed", ended: now }),
      task({ id: "c", status: "completed", ended: now }),
      task({ id: "d", status: "completed", ended: now }),
      task({ id: "e", status: "failed", ended: now }),
      task({ id: "f", status: "killed", ended: now }),
      task({ id: "g", status: "interrupted", ended: now }),
    ]), {});
    const groups = [...summary(row).querySelectorAll<HTMLElement>(".task-group")];
    expect(groups.map((g) => g.className)).toEqual(["task-group running", "task-group done", "task-group failed"]);
    expect(count(row, "running")).toBe("1");
    expect(count(row, "done")).toBe("3");
    expect(group(row, "done")!.querySelector(".task-icon")!.textContent).toBe("✓");
    // Failed counts the stopped and interrupted ones too.
    expect(count(row, "failed")).toBe("3");
    expect(group(row, "failed")!.querySelector(".task-icon")!.textContent).toBe("✕");
    // No red dot any more.
    expect(summary(row).querySelector(".task-alert")).toBeNull();
    expect(summary(row).title).toContain("1 執行中");
    expect(summary(row).title).toContain("3 完成");
    expect(summary(row).title).toContain("3 失敗");
  });

  it("shows only ✓ and its count when all are done", () => {
    const row = messageElement(reply([
      task({ id: "a", status: "completed", ended: now }),
      task({ id: "b", status: "completed", ended: now }),
    ]), {});
    expect(group(row, "running")).toBeNull();
    expect(group(row, "failed")).toBeNull();
    expect(count(row, "done")).toBe("2");
    expect(summary(row).querySelector(".task-spin")).toBeNull();
  });

  it("shows only ✕ and its count when all failed", () => {
    const row = messageElement(reply([task({ id: "b", status: "interrupted", ended: now })]), {});
    expect(group(row, "done")).toBeNull();
    expect(count(row, "failed")).toBe("1");
    expect(summary(row).title).toContain("已中斷（App 重開）");
  });

  it("opens a compact list of the tasks with their status and time", () => {
    const row = messageElement(reply([
      task({ id: "a" }),
      task({ id: "b", status: "completed", ended: now - 100_000 }),
      task({ id: "c", status: "stopped", ended: now }),
    ]), {});
    document.body.append(row);
    summary(row).click();
    expect(list(row).hidden).toBe(false);
    expect(summary(row).getAttribute("aria-expanded")).toBe("true");
    const [running, completed, stopped] = items(row);
    expect(running.textContent).toContain("跑測試與建置");
    expect(running.textContent).toContain("3 分 12 秒");
    expect(completed.textContent).toContain("1 分 32 秒");
    expect(completed.querySelector(".task-mark")!.textContent).toBe("✓");
    expect(stopped.textContent).toContain("已中斷");
    // The running one's time goes on.
    tickTaskChips(now + 10_000);
    expect(running.textContent).toContain("3 分 22 秒");
    // Still open after a redraw; closed by a second press.
    const again = messageElement(reply([task({ id: "a" })]), {});
    expect(list(again).hidden).toBe(false);
    summary(again).click();
    expect(list(again).hidden).toBe(true);
  });

  it("opens a task in the list to its last lines of output, asked of the app", () => {
    const row = messageElement(reply([task()]), {});
    document.body.append(row);
    summary(row).click();
    items(row)[0].click();
    expect(sent).toContainEqual({ type: "taskOutput", messageID: "m1", taskID: "toolu_B" });
    const panel = row.querySelector<HTMLElement>(".task-output")!;
    expect(panel.hidden).toBe(false);
    taskOutput("m1", "toolu_B", "compiling\nTest run with 3 tests passed");
    expect(panel.textContent).toBe("compiling\nTest run with 3 tests passed");
    // Read again every 5 seconds while it runs.
    sent.length = 0;
    tickTaskChips(Math.ceil(now / 5000) * 5000);
    expect(sent).toContainEqual({ type: "taskOutput", messageID: "m1", taskID: "toolu_B" });
    // Still open, with its output, when the reply is drawn again.
    const again = messageElement(reply([task({ status: "completed", ended: now })]), {});
    document.body.innerHTML = "";
    document.body.append(again);
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
