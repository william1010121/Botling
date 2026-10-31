// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { RightPanel, type RightPanelProps } from "../../src/renderer/RightPanel";
import { taskView } from "../../src/core/bot";
import { TaskBook, readTaskCard } from "../../src/core/tasks";
import type { BotView } from "../../src/contract";

const bot: BotView = { id: "main", name: "Main", role: "main", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };

describe("Mark complete in the production task panel", () => {
  it.each(["pending", "running", "waiting"] as const)("closes a selected %s card immediately and shows manual provenance after reload", async (state) => {
    let book = new TaskBook();
    const id = book.begin("user", "helo", null, 1);
    book.set(id, state, 2);
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const render = () => root.render(createElement(RightPanel, {
      bot, bots: [bot], waiting: { items: [], doing: {} }, look: "original", status: { key: "awake", text: "Idle" }, results: [], watching: null,
      tasks: book.tasks.map((card) => taskView(card, new Set())), messages: [{ id: "user", role: "user", text: "helo", time: new Date().toISOString() }], selectedTask: id, collapsed: false,
      onSelectTask() {}, onJumpToTask() {}, onAskForReport() {}, onCompleteTask: complete, onSelect() {}, onIgnore() {}, onOpenResult() {}, onOpenSubagent() {}, onUnsettle() {}, onSettings() {}, onExpand() {},
    } satisfies RightPanelProps));
    const complete = vi.fn((taskId: string) => { book.complete(taskId, 3); render(); });
    try {
      await act(async () => render());
      if (state === "pending") expect(host.textContent).toContain("Claiming…");
      expect(host.querySelector<HTMLButtonElement>(".task-card-top .task-complete")!.getAttribute("aria-label")).toBe("Mark complete");
      await act(async () => host.querySelector<HTMLButtonElement>(".task-complete")!.click());
      expect(complete).toHaveBeenCalledWith(id);
      const check = () => {
        expect(host.querySelector(".task-card")?.getAttribute("data-state")).toBe("done");
        expect(host.querySelector(".task-complete")).toBeNull();
        expect(host.querySelector('.task-group[data-group="waiting"]')).toBeNull();
        expect(host.querySelector('.task-group[data-group="done"] .task-card .task-name')?.textContent).toBe("helo");
        expect(host.querySelector(".task-card .task-foot span")?.getAttribute("title")).toBe("Marked complete by you");
        expect(host.textContent).not.toContain("background work may still be running");
        expect(host.textContent).not.toContain("Claiming…");
      };
      check();
      book = new TaskBook(JSON.parse(JSON.stringify(book.tasks)).map((raw: unknown) => readTaskCard(raw)!));
      await act(async () => render()); check();
    } finally {
      await act(async () => root.unmount()); host.remove();
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });
});
