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

function chips(element: HTMLElement): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>(".task-chip")];
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

  it("shows a running chip with its description and time, under the reply", () => {
    const row = messageElement(reply([task()]), {});
    document.body.append(row);
    const [chip] = chips(row);
    expect(chip.textContent).toContain("⏳");
    expect(chip.textContent).toContain("跑測試與建置");
    expect(chip.textContent).toContain("3 分 12 秒");
    expect(chip.title).toContain("swift test");
    // The time goes on.
    tickTaskChips(now + 10_000);
    expect(chip.textContent).toContain("3 分 22 秒");
  });

  it("says how it ended", () => {
    const row = messageElement(reply([
      task({ id: "a", status: "completed", ended: now }),
      task({ id: "b", status: "failed", ended: now }),
      task({ id: "c", status: "interrupted", ended: now }),
      task({ id: "d", status: "stopped", ended: now }),
    ]), {});
    const words = chips(row).map((chip) => chip.textContent ?? "");
    expect(words[0]).toContain("✓ 完成");
    expect(words[1]).toContain("✕ 失敗");
    expect(words[2]).toContain("✕ 已中斷（App 重開）");
    expect(words[3]).toContain("✕ 已中斷");
    expect(chips(row).map((chip) => chip.classList.contains("running"))).toEqual([false, false, false, false]);
  });

  it("opens to the last lines of output, asked of the app", () => {
    const row = messageElement(reply([task()]), {});
    document.body.append(row);
    chips(row)[0].click();
    expect(sent).toContainEqual({ type: "taskOutput", messageID: "m1", taskID: "toolu_B" });
    const panel = row.querySelector<HTMLElement>(".task-output")!;
    expect(panel.hidden).toBe(false);
    taskOutput("m1", "toolu_B", "compiling\nTest run with 3 tests passed");
    expect(panel.textContent).toBe("compiling\nTest run with 3 tests passed");
    // Still open, with its output, when the reply is drawn again.
    const again = messageElement(reply([task({ status: "completed", ended: now })]), {});
    expect(again.querySelector<HTMLElement>(".task-output")!.hidden).toBe(false);
    expect(again.querySelector(".task-output")!.textContent).toBe("compiling\nTest run with 3 tests passed");
    // Closed again.
    chips(again)[0].click();
    expect(again.querySelector<HTMLElement>(".task-output")!.hidden).toBe(true);
  });

  it("draws no strip without background work", () => {
    expect(messageElement(reply([]), {}).querySelector(".task-chips")).toBeNull();
  });
});
