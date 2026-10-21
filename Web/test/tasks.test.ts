/// <reference types="node" />
import { beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { messageElement } from "../src/messages";
import { bucketOf, countTasks, describeCron, elapsed, nextCronFire, resetTaskChips, setTaskClock, taskOutput, tickTaskChips, until } from "../src/tasks";
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

  it("never goes under your own line, only under the bot's", () => {
    // Your line drawn while the app still had the row on it (or any stray tasks) shows none.
    const row = messageElement(reply([task({ kind: "agent", message: "m0" })], "u1", "user"), {});
    expect(row.querySelector(".task-chips")).toBeNull();
    expect(row.querySelector(".user-column")).toBeNull();
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

  it("counts Monitors and scheduled work as waiting while they wait, done once they end or fire", () => {
    const monitor = task({ id: "m", kind: "monitor", title: "gpu_ft_001 training progress" });
    const wakeup = task({ id: "w", kind: "wakeup", title: "check the deploy", fires: now + 20 * 60_000 });
    const cron = task({ id: "c", kind: "cron", title: "核對訓練進度", schedule: "*/30 * * * *", recurring: true });
    expect([monitor, wakeup, cron].map(bucketOf)).toEqual(["waiting", "waiting", "waiting"]);
    expect(bucketOf({ ...wakeup, status: "completed", ended: now })).toBe("done");
    expect(bucketOf({ ...monitor, status: "completed", ended: now })).toBe("done");
    expect(bucketOf({ ...monitor, status: "failed", ended: now })).toBe("failed");
    // A cron job cut off with its session is an error, like any work that went with its process.
    expect(bucketOf({ ...cron, status: "stopped", ended: now })).toBe("failed");
    expect(countTasks([monitor, wakeup, cron, task({ id: "a", kind: "agent" })])).toEqual({ agent: 1, waiting: 3, done: 0, failed: 0 });
  });

  it("says when something fires, in words", () => {
    expect(until(45_000)).toBe("45 秒後");
    expect(until(20 * 60_000)).toBe("20 分後");
    expect(until(19 * 60_000 + 1_000)).toBe("20 分後");
    expect(until(65 * 60_000)).toBe("1 小時 5 分後");
    expect(until(3 * 3600_000)).toBe("3 小時後");
    expect(until(3 * 24 * 3600_000)).toBe("3 天後");
    expect(until(0)).toBe("即將觸發");
  });

  it("reads a cron line: in words, and when it runs next", () => {
    expect(describeCron("*/30 * * * *")).toBe("每 30 分鐘");
    expect(describeCron("7 * * * *")).toBe("每小時 :07");
    expect(describeCron("0 9 * * *")).toBe("每天 09:00");
    expect(describeCron("0 9 * * 1-5")).toBe("平日 09:00");
    expect(describeCron("30 18 * * 1,4")).toBe("每週一、四 18:30");
    expect(describeCron("0 */2 * * *")).toBe("每 2 小時");
    expect(describeCron("0 9 22 10 *")).toBe("10/22 09:00");
    expect(describeCron("7,37 * * * *")).toBe("7,37 * * * *");
    expect(describeCron("not cron")).toBe("not cron");
    // Local time, as claude's scheduler runs it.
    const local = new Date(2026, 9, 21, 12, 10, 30).getTime();
    expect(nextCronFire("*/30 * * * *", local)).toBe(new Date(2026, 9, 21, 12, 30).getTime());
    expect(nextCronFire("0 9 * * *", local)).toBe(new Date(2026, 9, 22, 9, 0).getTime());
    // 2026-10-21 is a Wednesday: the next Monday 09:00 is the 26th.
    expect(nextCronFire("0 9 * * 1", local)).toBe(new Date(2026, 9, 26, 9, 0).getTime());
    expect(nextCronFire("0 0 1 1 *", local)).toBe(new Date(2027, 0, 1, 0, 0).getTime());
    expect(nextCronFire("0 0 31 2 *", local)).toBeNull();
    expect(nextCronFire("nope", local)).toBeNull();
  });

  it("lists a Monitor and a scheduled wake-up with their own marks and when the wake-up fires", () => {
    const local = new Date(2026, 9, 21, 12, 10, 0).getTime();
    setTaskClock(() => local);
    const row = messageElement(reply([
      task({ id: "m", kind: "monitor", title: "gpu_ft_001 training progress", started: local - 192_000, detail: "tail -F train.log | grep EVAL" }),
      task({ id: "w", kind: "wakeup", title: "check the deploy", started: local - 60_000, fires: local + 20 * 60_000 }),
      task({ id: "c", kind: "cron", title: "核對訓練進度", started: local - 120_000, schedule: "0 9 * * *", recurring: true }),
      task({ id: "o", kind: "wakeup", title: "earlier tick", status: "completed", started: local - 3_600_000, ended: local - 1_800_000, fires: local - 1_800_000 }),
    ]), {});
    document.body.append(row);
    expect(count(row, "waiting")).toBe("3");
    expect(count(row, "done")).toBe("1");
    group(row, "waiting")!.click();
    const lines = items(row);
    const byId = (id: string) => lines.find((line) => line.dataset.task === id)!;
    expect(byId("m").textContent).toContain("3 分 12 秒");
    expect(byId("m").querySelector<HTMLElement>(".task-mark")!.dataset.kind).toBe("monitor");
    expect(byId("m").title).toBe("監看（Monitor）：tail -F train.log | grep EVAL");
    expect(byId("w").textContent).toContain("check the deploy");
    expect(byId("w").textContent).toContain("20 分後");
    expect(byId("w").querySelector<HTMLElement>(".task-mark")!.dataset.kind).toBe("wakeup");
    expect(byId("c").textContent).toContain("每天 09:00 · 20 小時 50 分後");
    expect(byId("c").querySelector<HTMLElement>(".task-mark")!.dataset.kind).toBe("cron");
    // The countdown moves on; the Monitor's time goes up.
    tickTaskChips(local + 5 * 60_000);
    expect(byId("w").textContent).toContain("15 分後");
    expect(byId("m").textContent).toContain("8 分 12 秒");
    // A fired one is done, with the done mark.
    list(row).querySelector<HTMLButtonElement>('.task-filter[data-filter="done"]')!.click();
    const fired = items(row).find((line) => line.dataset.task === "o")!;
    expect(fired.textContent).toContain("已觸發");
    expect(fired.querySelector<HTMLElement>(".task-mark")!.dataset.kind).toBeUndefined();
  });
});
