import { expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bot } from "../../src/core/bot";
import { ProcessLedger } from "../../src/core/process/ledger";
import { mainProfile } from "../../src/core/store/workspace";
import { tokenFlowHistory } from "../../src/core/token-flow-history";
import { readSubagent } from "../../src/core/subagents";
import { TokenFlowHistoryView, type BotView } from "../../src/contract";
import { historicalAllocation, historyWorkers } from "../../src/renderer/token-flow-history-model";
import { tempDir } from "../helpers";

it("reads completed historical workers from an inactive head without launching it, preserving tasks and excluding content", async () => {
  const dir = tempDir("token-flow-history"); const profile = mainProfile(dir);
  const partner = join(profile.storeDir, "partner-claude"); mkdirSync(partner, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine: "codex", heads: { engines: ["codex"], answerWith: "codex" } }));
  const old = { id: "old", description: "Previous release", startedAt: 100, endedAt: 200, status: "completed", outputTokenCounters: { "message:past": 80 }, prompt: "PRIVATE PROMPT", result: "PRIVATE RESULT", steps: [] };
  writeFileSync(join(partner, "subagents.json"), JSON.stringify([old]));
  const bot = new Bot({ profile, engine: "codex", deferStartup: true, welcome: false, ledger: new ProcessLedger(join(dir, "ledger.json")),
    headConfig() { throw new Error("No CLI authorized"); }, prompts() { throw new Error("No turn"); }, emit() {}, log() {}, approvalTimeoutMs: 100, idleMs: 100, interruptGraceMs: 100 });
  bot.subagents.list.push(readSubagent({ ...old, id: "current", outputTokenCounters: { "thread:current": 20 } })!);
  bot.tasks.tasks.push({ id: "saved-task", name: "Release", state: "done", kept: true, createdAt: 100, updatedAt: 200, messageIDs: [], subagentIDs: ["current"], history: [{ kind: "subagent", at: 100, text: "old" }] });
  try {
    expect(bot.partner).toBeNull();
    const view = TokenFlowHistoryView.parse(await tokenFlowHistory(bot));
    expect(view.rows.map(row => [row.id, row.head, row.attributableOutputTokens])).toEqual([["current", "codex", 20], ["old", "claude", 80]]);
    expect(view.tasks[0].workers.map(worker => worker.id)).toEqual(["current", "old"]);
    expect(JSON.stringify(view)).not.toContain("PRIVATE");
    expect(JSON.stringify(view)).not.toContain("message:past");
    expect(bot.partner).toBeNull();
    writeFileSync(join(partner, "subagents.json"), "bad saved file");
    const failed = await tokenFlowHistory(bot);
    expect(failed.unreadable).toBe(true);
    expect(failed.tasks[0].workers).toContainEqual({ id: "old", head: null });
  } finally { await bot.shutdown({ tidy: false }); }
});

it("aggregates all saved history, partitions shared tasks once, and refuses to prorate cross-period counters", () => {
  const now = new Date(2026, 9, 28, 12).getTime(), day = 86400000;
  const row = (id: string, value: number, age: number, endedAge = age) => ({ id, title: id, parentId: null, head: "codex" as const, status: "completed" as const, startedAt: now - age * day, endedAt: now - endedAge * day, outputTokens: value, attributableOutputTokens: value });
  const history: TokenFlowHistoryView = { botId: "B", asOf: now, limited: true, unreadable: false,
    rows: [row("today", 10, .1), row("past", 30, 3), row("older", 50, 10), row("spans", 100, 20, 0)],
    tasks: [{ id: "a", name: "First", workers: [{ id: "today", head: "codex" }, { id: "past", head: "codex" }] }, { id: "b", name: "Second", workers: [{ id: "past", head: "codex" }] }],
  };
  const bot = { id: "B", subagentRows: [] } as unknown as BotView;
  const workers = historyWorkers(bot, history, []);
  const all = historicalAllocation(workers, "all", now);
  expect(all.known).toBe(190);
  expect(all.groups.find(group => group.id === "shared-tasks")?.known).toBe(30);
  expect(all.groups.flatMap(group => group.workers).map(worker => worker.id).sort()).toEqual(["older", "past", "spans", "today"]);
  expect(all.edges.filter(edge => edge.target === "purpose:execution").reduce((sum, edge) => sum + (edge.value ?? 0), 0)).toBe(190);
  expect(historicalAllocation(workers, "7d", now).known).toBe(40);
  const today = historicalAllocation(workers, "today", now);
  expect(today.known).toBe(10);
  expect(today.workers.find(worker => worker.id === "spans")?.attributableOutput).toBeNull();
  expect(today.unknown).toBe(2); // Spanning record plus unmeasured coordinator.
  expect(today.nodes.every(node => node.aggregate)).toBe(true);
});

it("collapses many historical tasks into five groups without changing totals", () => {
  const now = Date.now();
  const rows = Array.from({ length: 20 }, (_, index) => ({ id: `w${index}`, title: `Worker ${index}`, parentId: null, head: "codex" as const, status: "completed" as const, startedAt: 1, endedAt: 2, outputTokens: index, attributableOutputTokens: index }));
  const history: TokenFlowHistoryView = { botId: "B", asOf: now, limited: true, unreadable: false, rows,
    tasks: rows.map(row => ({ id: row.id, name: row.title, workers: [{ id: row.id, head: row.head }] })) };
  const flow = historicalAllocation(historyWorkers({ subagentRows: [] } as unknown as BotView, history, []), "all", now);
  expect(flow.groups).toHaveLength(5);
  expect(flow.known).toBe(190);
  expect(flow.groups.reduce((sum, group) => sum + group.known, 0)).toBe(190);
  expect(flow.nodes).toHaveLength(8); // Five work groups + three purpose buckets, no call-log nodes.
});
