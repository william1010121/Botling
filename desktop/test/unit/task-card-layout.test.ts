// @vitest-environment jsdom
// The open task card: "Related subagents" folded by default (it took most of the card), and
// "Mark complete" in the card's top-right corner beside its name.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RightPanel, type RightPanelProps } from "../../src/renderer/RightPanel";
import type { BotView, TaskView } from "../../src/contract";

const bot: BotView = { id: "main", name: "Main", role: "main", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const task = {
  id: "t1", name: "Parser task", state: "running", owner: "claude", now: "Writing the parser", next: null, blocked: null, updatedAt: new Date().toISOString(), messageIds: [],
  agentLinks: "recorded", relatedAgents: [
    { id: "a1", title: "API research", engine: "claude", status: "running", available: true },
    { id: "a2", title: "Build parser", engine: "codex", status: "completed", available: true, run: 2 },
  ],
} as unknown as TaskView;

async function mount() {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(RightPanel, {
    bot, bots: [bot], waiting: { items: [], doing: {} }, look: "original", status: { key: "awake", text: "Idle" }, results: [], teams: [], watching: null,
    tasks: [task], messages: [], selectedTask: "t1", collapsed: false,
    onSelectTask() {}, onJumpToTask() {}, onAskForReport() {}, onCompleteTask() {}, onEditGroup() {}, onSelect() {}, onIgnore() {}, onOpenResult() {}, onOpenSubagent() {}, onUnsettle() {}, onSettings() {}, onExpand() {},
  } satisfies RightPanelProps)));
  return { host, done: async () => { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; } };
}

describe("open task card layout", () => {
  it("folds Related subagents by default and opens it on press", async () => {
    const { host, done } = await mount();
    try {
      const section = host.querySelector<HTMLDetailsElement>(".task-card details.task-agents")!;
      expect(section).not.toBeNull();
      expect(section.open).toBe(false);
      const summary = section.querySelector("summary")!;
      expect(summary.textContent).toContain("Related subagents");
      expect(summary.textContent).toContain("2");
      expect(summary.textContent).toContain("1 active");
      expect(section.querySelectorAll("button.task-agent")).toHaveLength(2);
      await act(async () => summary.click());
      expect(section.open).toBe(true);
    } finally { await done(); }
  });

  it("puts Mark complete in the card's top row, after its name and before the fields", async () => {
    const { host, done } = await mount();
    try {
      const card = host.querySelector(".task-card")!;
      const top = card.firstElementChild!;
      expect(top.classList.contains("task-card-top")).toBe(true);
      expect(top.querySelector(".task-card-head")).not.toBeNull();
      expect(top.lastElementChild?.classList.contains("task-complete")).toBe(true);
      const css = readFileSync(join(__dirname, "../../src/renderer/styles.css"), "utf8");
      expect(css).toMatch(/\.task-card-top\s*\{[^}]*display:\s*flex[^}]*\}/);
      expect(css).toMatch(/\.task-complete\s*\{[^}]*margin-left:\s*auto[^}]*\}/);
    } finally { await done(); }
  });
});
