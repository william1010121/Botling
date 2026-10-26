// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SubagentView } from "../../src/contract";
import { subagentView } from "../../src/core/bot";
import { readSubagent, SubagentBook } from "../../src/core/subagents";
import { chatState, subagentState } from "../../src/renderer/payload";
import { sent } from "../../../Web/src/bridge";
import type { BotView, StepView } from "../../src/contract";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const bot: BotView = { id: "B", name: "Main", role: "main", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 1, problem: null, heads: ["claude", "codex"], job: null, subagentRows: [] };
const step = (id: string, kind: StepView["kind"], title: string, extra: Partial<StepView> = {}): StepView => ({ id, kind, title, tool: null, detail: null, output: null, failed: false, done: true, ...extra });
beforeAll(async () => {
  document.body.innerHTML = '<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>';
  await import("../../../Web/src/main");
});
afterEach(() => { window.ccb.setState(chatState({ ...bot, subagents: 0 }, { botId: "empty", messages: [], running: null, live: [], tasks: [] }).state); sent.length = 0; vi.useRealTimers(); });

describe("desktop payload rendered by the production chat page", () => {
  it("renders actual child settings, freezes reported throughput at failure, and returns to the parent", () => {
    vi.useFakeTimers(); vi.setSystemTime(978307204000);
    const child = readSubagent({ id: "review", description: "Review", prompt: "Check patch", type: "codex-worker", model: "actual-child", status: "running", background: true, startedAt: 0, steps: [], runtime: { engine: "codex", reasoningEffort: "high", serviceTier: "priority" }, outputTokenCounters: { "thread:child": 100 } })!;
    const show = () => window.ccb.setState(subagentState(bot, SubagentView.parse(subagentView(child, bot.name, new SubagentBook([child]), "claude"))).state);
    show();
    const header = () => document.getElementById("subagent-bar")!;
    expect(header().querySelector(".engine-badge")?.textContent).toBe("Codex worker");
    expect(header().querySelector(".meta")?.textContent).toContain("actual-child");
    expect(header().querySelector(".meta")?.textContent).toContain("high");
    expect(header().querySelector(".meta")?.textContent).toContain("Fast: on");
    expect(header().querySelector(".subagent-speed")?.textContent).toContain("25.0");
    expect(document.getElementById("composer-slot")?.hidden).toBe(true);
    child.status = "failed"; child.endedAt = 4; child.result = "Tests failed: concrete error";
    show(); vi.advanceTimersByTime(10_000);
    expect(header().className).toBe("failed");
    expect(header().querySelector(".subagent-speed")?.textContent).toContain("25.0");
    expect(document.querySelector(".sub-work.error")?.textContent).toContain("Tests failed");
    header().querySelector<HTMLButtonElement>(".crumb-owner")!.click();
    expect(sent.at(-1)).toEqual({ type: "closeSubagent" });
  });

  it.each(["claude", "codex"])("keeps %s task cards visible through streaming, folding and later history, while the parent waits without thinking", (engine) => {
    const live = [step("note", "text", "I will delegate."), step("child", "subagent", "Review patch", { status: "running", done: false, count: 2 }), ...Array.from({ length: 9 }, (_, index) => step(`call-${index}`, "tool", "Read file"))];
    const chat = { botId: bot.id, messages: [], running: { turnId: "turn", messageId: "reply" }, live, tasks: [] };
    window.ccb.setState(chatState(bot, chat).state);
    const check = (status: string) => {
      const cards = document.querySelectorAll<HTMLButtonElement>("#messages .subagent-card");
      expect(cards).toHaveLength(1);
      expect(cards[0].closest("[hidden], .steps, .steps-run, .steps-body")).toBeNull();
      expect(cards[0].classList.contains(status)).toBe(true);
      cards[0].click(); expect(sent.at(-1)).toEqual({ type: "openSubagent", id: "child" });
    };
    check("running");
    window.ccb.setState(chatState(bot, { ...chat, running: null, live: [], messages: [{ id: "reply", role: "bot", text: "Review delegated.", time: new Date().toISOString(), engine: engine as "claude" | "codex", steps: live }] }).state);
    check("running");
    document.querySelector<HTMLButtonElement>("#messages .steps-toggle")!.click(); check("running");
    expect(document.querySelector(".worker-waiting")?.textContent).toContain("Waiting for workers");
    expect(document.querySelector("#messages > .row.live")).toBeNull();
    const ended = live.map((item) => item.id === "child" ? { ...item, status: "stopped" as const, done: true } : item);
    window.ccb.setState(chatState({ ...bot, subagents: 0 }, { ...chat, running: null, live: [], messages: [{ id: "reply", role: "bot", text: "Stopped.", time: new Date().toISOString(), steps: ended }, { id: "later", role: "user", text: "Next question", time: new Date().toISOString() }] }).state);
    check("stopped");
    expect(document.querySelector(".worker-waiting")).toBeNull();
  });
});

it("restores the parent's avatar beside subagent rows, with an engine badge only in the original look", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { SubagentRows } = await import("../../src/renderer/Rail");
  const parent = { ...bot, subagentRows: [{ id: "child", title: "Review", status: "running" as const, head: "codex" as const, startedAt: Date.now(), endedAt: null, unsettledAt: null, settled: false, prompt: "Check" }] };
  const host = document.createElement("div");
  for (const look of ["original", "cute"] as const) {
    host.innerHTML = renderToStaticMarkup(createElement(SubagentRows, { bot: parent, look, now: Date.now(), watching: null, onOpen() {}, onSettle() {} }));
    const owner = host.querySelector(".subagent-owner")!;
    expect(owner.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(owner.querySelector(".subagent-owner-badge")?.textContent ?? "").toBe(look === "original" ? "X" : "");
    expect(host.querySelector(".subagent-row")?.classList.contains("running")).toBe(true);
  }
});

it.each([false, true])("keeps the restored owner avatar and truthful running status in Settled (folded panel: %s)", async (collapsed) => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RightPanel } = await import("../../src/renderer/RightPanel");
  const parent = { ...bot, subagentRows: [{ id: "child", title: "Review", status: "running" as const, head: "codex" as const, startedAt: Date.now(), endedAt: null, unsettledAt: null, settled: true, prompt: "Check" }] };
  const onOpen = vi.fn(), onRestore = vi.fn();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => root.render(createElement(RightPanel, {
      bot: parent, bots: [parent], waiting: { items: [], doing: {} }, look: "original", status: { key: "awake", text: "Idle" }, results: [], teams: [], watching: null, tasks: [], messages: [], selectedTask: null, collapsed,
      onSelectTask() {}, onJumpToTask() {}, onAskForReport() {}, onCompleteTask() {}, onEditGroup() {}, onSelect() {}, onIgnore() {}, onOpenResult() {}, onOpenSubagent: onOpen, onUnsettle: onRestore, onSettings() {}, onExpand() {},
    })));
    if (collapsed) await act(async () => host.querySelector<HTMLButtonElement>('[data-section="settled"]')!.click());
    expect(host.querySelector(".settled-open")?.getAttribute("aria-label")).toContain("running");
    expect(host.querySelector(".settled-open .subagent-owner img")).not.toBeNull();
    expect(host.querySelector(".settled-mark .done")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(".settled-open")!.click());
    expect(onOpen).toHaveBeenCalledWith(parent.subagentRows[0]);
    await act(async () => host.querySelector<HTMLButtonElement>(".settled-back")!.click());
    expect(onRestore).toHaveBeenCalledWith(parent.subagentRows[0]);
  } finally {
    await act(async () => root.unmount()); host.remove();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  }
});
