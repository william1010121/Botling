// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { BotView, TokenFlowHistoryView, UsageView } from "../../src/contract";
import type { Client } from "../../src/renderer/client";
import { TokenFlow } from "../../src/renderer/TokenFlow";

it("defaults to bot-wide saved history, collapses workers into task allocation groups and opens chart-only details", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const now = new Date(2026, 9, 28, 12).getTime(); vi.spyOn(Date, "now").mockReturnValue(now);
  const bot = { id: "B", name: "Main", heads: ["codex"], subagentRows: [], working: false } as unknown as BotView;
  const row = (id: string, tokens: number, ago: number) => ({ id, title: `Individual ${id}`, parentId: null, head: "codex" as const, status: "completed" as const, outputTokens: tokens, attributableOutputTokens: tokens, startedAt: now - ago, endedAt: now - ago + 1 });
  const history: TokenFlowHistoryView = { botId: bot.id, asOf: now, limited: true, unreadable: false, rows: [row("old", 42000, 10 * 86400000), row("new", 12000, 1000)], tasks: [
    { id: "release", name: "Release", workers: [{ id: "old", head: "codex" }] }, { id: "build", name: "Build", workers: [{ id: "new", head: "codex" }] },
  ] };
  const tokens = { input: 100, output: 50, cacheRead: 400, cacheWrite: 0 };
  const usage: UsageView = { spendingStatus: "available", day: "2026-10-28", spent: 0, tokens, byBot: [{ name: "Main", spent: 0, tokens: 550, breakdown: tokens }], history: [], claude: { fiveHour: null, week: null }, codex: { fiveHour: null, week: null } };
  const request = vi.fn(async (cmd: { type: string }) => cmd.type === "tokenFlow.view" ? structuredClone(history) : usage);
  const client = { request, onEvent: () => () => {} } as unknown as Client;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(TokenFlow, { client, bot, bots: [bot], tasks: [] })));
    expect(host.querySelector(".tf-source button[aria-pressed=true]")?.textContent).toContain("Measured");
    expect(host.querySelector('.tf-purpose-summary [data-purpose="execution"]')?.textContent).toContain("—");
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>(".tf-source button")].find(button => button.textContent?.includes("Legacy"))!.click());
    expect(host.querySelector<HTMLSelectElement>('[aria-label="History period"]')!.value).toBe("all");
    expect(host.querySelector('.tf-purpose-summary [data-purpose="unknown"]')?.textContent).toContain("54K");
    expect(host.querySelectorAll('[data-flow-node]')).toHaveLength(7); // root + 2 work groups + 3 purposes
    expect(host.querySelector('.tf-canvas')?.textContent).not.toContain("Individual old");
    const release = [...host.querySelectorAll<HTMLButtonElement>('[data-flow-node]')].find(node => node.textContent?.includes("Release"))!;
    await act(async () => release.click());
    expect(host.querySelector('.tf-detail svg[role="img"]')?.getAttribute('aria-label')).toContain("42K");
    expect(host.querySelector('.tf-detail dl, .tf-detail p, .tf-detail table')).toBeNull();
    expect(host.querySelector('.tf-contributor')?.textContent).toContain("Individual old");
    const period = host.querySelector<HTMLSelectElement>('[aria-label="History period"]')!;
    await act(async () => { period.value = "today"; period.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.querySelector('.tf-purpose-summary [data-purpose="unknown"]')?.textContent).toContain("12K");
    expect([...host.querySelectorAll('[data-flow-node]')].some(node => node.textContent?.includes("Release"))).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Daily usage details"]')!.click());
    expect(host.querySelector('[aria-label="Daily ledger detail"] .tf-stack')).not.toBeNull();
    expect(host.querySelector('.tf-ledger-values')?.textContent).not.toContain("400");
  } finally { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
});
