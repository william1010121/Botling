// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SubagentView } from "../../src/contract";
import { subagentView } from "../../src/core/bot";
import { readSubagent, SubagentBook } from "../../src/core/subagents";
import { chatState, subagentState } from "../../src/renderer/payload";
import type { BotView } from "../../src/contract";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const bot: BotView = { id: "B", name: "eeg", role: "main", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 1, problem: null, heads: ["claude"], job: null, subagentRows: [] };
beforeAll(async () => {
  document.body.innerHTML = '<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>';
  await import("../../../Web/src/main");
});
afterEach(() => { window.ccb.setState(chatState({ ...bot, subagents: 0 }, { botId: "empty", messages: [], running: null, live: [], tasks: [] }).state); });

// An Antigravity worker as the registry stores it; `runtime` may be missing on an old record.
const worker = (type: string, runtime?: Record<string, unknown>) => readSubagent({ id: "w", description: "charts", prompt: "p", type, status: "running", background: true, startedAt: 0, steps: [], ...(runtime ? { runtime } : {}) })!;
const header = (record: ReturnType<typeof worker>, ownerEngine?: "claude" | "codex" | "agy") => {
  const view = SubagentView.parse(subagentView(record, bot.name, new SubagentBook([record]), ownerEngine));
  window.ccb.setState(subagentState(bot, view).state);
  return document.getElementById("subagent-bar")!;
};

describe("an Antigravity worker's read-only view", () => {
  it("names its real engine in the badge, not Claude subagent", () => {
    const bar = header(worker("agy-worker", { engine: "agy", reasoningEffort: "high" }), "agy");
    expect(bar.querySelector(".engine-badge")?.textContent).toBe("Antigravity worker");
  });
  it("does not print the internal type id 'agy-worker' in the meta line", () => {
    const bar = header(worker("agy-worker", { engine: "agy", reasoningEffort: "high" }), "agy");
    expect(bar.querySelector(".meta")?.textContent).not.toContain("agy-worker");
    expect(bar.querySelector(".meta")?.textContent).toContain("Effort: high");
  });
  it("still knows it is Antigravity when the record has no runtime and the owner's first head is Claude", () => {
    const record = worker("agy-worker");
    expect(subagentView(record, bot.name, new SubagentBook([record]), "claude").engine).toBe("agy");
    expect(subagentState(bot, subagentView(record, bot.name, new SubagentBook([record]))).state.subagent?.engine).toBe("agy");
    expect(header(record).querySelector(".engine-badge")?.textContent).toBe("Antigravity worker");
  });
  it("a Claude worker is not labelled with its raw type either", () => {
    const bar = header(worker("claude-worker", { engine: "claude" }), "claude");
    expect(bar.querySelector(".engine-badge")?.textContent).toBe("Claude worker");
    expect(bar.querySelector(".meta")?.textContent).not.toContain("claude-worker");
  });
});
