// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";
import type { BotView, TaskView, UsageView, EventEnvelope } from "../../src/contract";
import { SubagentRowView, UsageView as UsageSchema } from "../../src/contract";
import { codexTokens, freshSpending, addSpending, usageView } from "../../src/core/usage";
import { readSubagent, SubagentBook } from "../../src/core/subagents";
import { flowWorkers, flowLedger, flowTotal } from "../../src/renderer/token-flow-model";
import { TokenFlow } from "../../src/renderer/TokenFlow";
import type { Client } from "../../src/renderer/client";

const row = { id: "worker", title: "Review", status: "running" as const, head: "codex" as const, startedAt: 10, endedAt: null, unsettledAt: null, settled: false, prompt: "PRIVATE PROMPT", outputTokens: 0 };
const bot: BotView = { id: "B", name: "Main", role: "main", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 1, problem: null, heads: ["codex"], job: null, subagentRows: [row] };
const usage = (): UsageView => ({ spendingStatus: "available", day: "2026-10-28", spent: 0, tokens: { input: 60, output: 20, cacheRead: 40, cacheWrite: 0 }, byBot: [{ name: "Main", spent: 0, tokens: 120, breakdown: { input: 60, output: 20, cacheRead: 40, cacheWrite: 0 } }], history: [], claude: { fiveHour: null, week: null }, codex: { fiveHour: null, week: null } });
const task = (id: string): TaskView => ({ id, name: id, state: "running", owner: "codex", now: null, next: null, blocked: null, messageIds: [], updatedAt: "", atWork: true, relatedAgents: [{ id: "worker", title: "Review", engine: "codex", status: "running", available: true, run: 1 }] });

describe("Token Flow accounting and identity", () => {
  it("counts normalized cached input once through the real ledger boundary", () => {
    const tokens = codexTokens({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 });
    const date = new Date(2026, 9, 28);
    const spending = addSpending(freshSpending("2026-10-28"), 0, tokens, "Main", date);
    const view = UsageSchema.parse(usageView({ spending, claude: {}, codex: {} }, true));
    expect(flowTotal(flowLedger(bot, [bot], view)!)).toBe(120);
    expect(view.byBot[0].breakdown).toEqual({ input: 60, output: 20, cacheRead: 40, cacheWrite: 0 });
    expect(flowLedger(bot, [bot, { ...bot, id: "other" }], view)).toBeNull();
    expect(flowLedger(bot, [bot], { ...view, spendingStatus: "missing" })).toBeNull();
    expect(flowLedger(bot, [bot], { ...view, byBot: [] })).toBeNull();
  });
  it("deduplicates explicit task links without borrowing task usage or inferring parent edges", () => {
    const missing = { ...task("missing-task"), relatedAgents: [{ ...task("x").relatedAgents![0], id: "missing", status: null, available: false }] };
    const nodes = flowWorkers(bot, [task("first"), task("second"), missing]);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ id: "worker", direct: true, output: 0, tasks: [{ id: "first" }, { id: "second" }] });
    expect(nodes[1]).toMatchObject({ id: "missing", direct: false, output: null, status: "unknown" });
  });
  it("exports only the actual worker counter, preserving unknown and zero", () => {
    const record = readSubagent({ id: "x", description: "Worker", prompt: "private", status: "failed", background: true, startedAt: 0, steps: [] })!;
    const book = new SubagentBook([record]);
    expect(SubagentRowView.parse(book.rows("codex")[0]).outputTokens).toBeNull();
    book.output("x", "thread", 0);
    expect(SubagentRowView.parse(book.rows("codex")[0])).toMatchObject({ status: "failed", outputTokens: 0 });
    book.output("x", "thread", 12); book.output("x", "thread", 8);
    expect(book.rows("codex")[0].outputTokens).toBe(12);
  });
});

it("renders states, selection and failures; coalesces updates and tears down without polling", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  let listener!: (envelope: EventEnvelope) => void;
  const off = vi.fn();
  let currentBot = bot;
  const request = vi.fn(async (cmd: { type: string }) => cmd.type === "usage.view" ? usage() : ({ botId: bot.id, asOf: Date.now(), limited: true, unreadable: false, rows: currentBot.subagentRows.map(row => ({ ...row, parentId: null })), tasks: [{ id: "task-id", name: "task-id", workers: [{ id: "worker", head: "codex" }] }] }));
  const client = { request, onEvent: (fn: typeof listener) => { listener = fn; return off; } } as unknown as Client;
  const render = async (value = bot) => { currentBot = value; await act(async () => root.render(createElement(TokenFlow, { client, bot: value, bots: [value], tasks: [task("task-id")] }))); };
  try {
    await render();
    expect(request).toHaveBeenCalledWith({ type: "usage.view", localOnly: true });
    expect(host.textContent).not.toContain("PRIVATE PROMPT");
    await act(async () => host.querySelector<HTMLButtonElement>(".tf-worker")!.click());
    expect(host.querySelector(".tf-detail")?.textContent).toContain("task-id");
    expect(host.querySelector(".tf-detail svg[role=img]")).not.toBeNull();
    for (const status of ["completed", "failed", "stopped"] as const) {
      await render({ ...bot, subagentRows: [{ ...row, status, outputTokens: null }] });
      await act(async () => { listener({ event: { type: "turn.finished", botId: bot.id } } as EventEnvelope); await vi.advanceTimersByTimeAsync(750); });
      expect(host.querySelector(`.tf-detail [aria-label="State: ${status}"]`)).not.toBeNull();
      expect(host.querySelector(".tf-node-usage")?.textContent).toContain("—");
    }
    await act(async () => { for (let i = 0; i < 30; i++) listener({ event: { type: "turn.finished", botId: bot.id } } as EventEnvelope); await vi.advanceTimersByTimeAsync(750); });
    expect(request).toHaveBeenCalledTimes(10);
    await act(async () => { listener({ event: { type: "turn.finished", botId: "unrelated" } } as EventEnvelope); await vi.advanceTimersByTimeAsync(750); });
    expect(request).toHaveBeenCalledTimes(10);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(request).toHaveBeenCalledTimes(10);
    request.mockRejectedValueOnce(new Error("offline"));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Refresh ledger"]')!.click());
    expect(host.querySelector(".tf-status")?.getAttribute("aria-label")).toContain("Refresh failed · last snapshot");
    await act(async () => root.unmount());
    expect(off).toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(request).toHaveBeenCalledTimes(12);
  } finally { host.remove(); vi.useRealTimers(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
});

it("pauses hidden-page reads and ignores a late response after unmount", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const host = document.createElement("div"); const root = createRoot(host);
  const resolves: ((value: UsageView) => void)[] = [];
  const request = vi.fn(() => new Promise<UsageView>(done => { resolves.push(done); }));
  const off = vi.fn();
  const client = { request, onEvent: () => off } as unknown as Client;
  try {
    await act(async () => root.render(createElement(TokenFlow, { client, bot, bots: [bot], tasks: [] })));
    expect(request).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
    await act(async () => resolves.forEach(resolve => resolve(usage())));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(off).toHaveBeenCalledTimes(1);
  } finally { hidden.mockRestore(); vi.useRealTimers(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
});
