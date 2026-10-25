import { describe, expect, it } from "vitest";
import { SubagentView } from "../../src/contract";
import { readSubagent, SubagentBook } from "../../src/core/subagents";
import { subagentView } from "../../src/core/bot";
import { chatState, subagentState } from "../../src/renderer/payload";
import type { BotView } from "../../src/contract";

const bot: BotView = { id: "B", name: "Main", role: "main", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 1, problem: null, heads: ["codex"], job: null, subagentRows: [] };
const child = (extra: Record<string, unknown> = {}) => readSubagent({ id: "review", description: "Review", prompt: "Check the patch", type: "codex", model: "gpt-worker", status: "running", background: true, startedAt: 0, steps: [], runtime: { engine: "codex", reasoningEffort: "high", serviceTier: "priority" }, outputTokenCounters: { "thread:child": 100 }, ...extra })!;

describe("1.x subagent presentation data through the desktop boundary", () => {
  it("preserves the child's own engine, runtime and reported output through the strict contract into its header", () => {
    const record = child();
    const view = SubagentView.parse(subagentView(record, bot.name, new SubagentBook([record])));
    const header = subagentState(bot, view).state.subagent;
    expect(header).toMatchObject({ engine: "codex", model: "gpt-worker", runtime: { reasoningEffort: "high", serviceTier: "priority" }, outputTokens: 100, startedAt: 978307200000 });
  });

  it("keeps missing runtime and malformed counters unknown, without borrowing parent settings", () => {
    for (const counters of [undefined, {}, { child: -1 }, { child: true }, { child: 1.5 }, { child: Infinity }]) {
      const record = child({ runtime: undefined, model: undefined, outputTokenCounters: counters });
      const header = subagentState(bot, subagentView(record, bot.name, new SubagentBook([record]))).state.subagent;
      expect(header?.model).toBeNull();
      expect(header?.runtime).toBeNull();
      expect(header?.outputTokens).toBeNull();
    }
  });

  it.each(["completed", "failed", "stopped"])("preserves %s rather than presenting every ended child as successful", (status) => {
    const record = child({ status, endedAt: 4, result: "Concrete report" });
    const state = subagentState(bot, subagentView(record, bot.name, new SubagentBook([record]))).state;
    expect(state.working).toBe(false);
    expect(state.subagent).toMatchObject({ status, outputTokens: 100, endedAt: 978307204000 });
    expect(state.messages.at(-1)?.role).toBe(status === "completed" ? "bot" : "error");
  });

  it("shows the idle parent's waiting-for-workers state without a thinking animation, clearing it when no child runs", () => {
    const chat = { botId: bot.id, messages: [], running: null, live: [], tasks: [] };
    expect(chatState(bot, chat).state).toMatchObject({ working: false, waitingForWorkers: true });
    expect(chatState({ ...bot, subagents: 0 }, chat).state).toMatchObject({ working: false, waitingForWorkers: false });
  });
});

it("counts only attributable child output, deduplicates absolute snapshots, and preserves the record on reload", async () => {
  const { parseLine } = await import("../../src/core/agent/stream");
  const record = child({ runtime: undefined, model: undefined, outputTokenCounters: undefined });
  const book = new SubagentBook([record]);
  const line = (output: unknown, parent: string | null = "review") => JSON.stringify({ type: "assistant", parent_tool_use_id: parent, message: { id: "message-1", model: "actual-claude", usage: { input_tokens: 900, output_tokens: output }, content: [] } });
  const items = parseLine(line(100));
  expect(items).toMatchObject([{ kind: "subagentRuntime", id: "review", model: "actual-claude" }, { kind: "subagentOutput", id: "review", tokens: 100 }]);
  for (const item of [...items, ...items, ...parseLine(line(80)), ...parseLine(line(120))]) {
    if (item.kind === "subagentRuntime") book.runtime(item.id, item.runtime, item.model);
    if (item.kind === "subagentOutput") book.output(item.id, item.counter, item.tokens);
  }
  expect(parseLine(line(9999, null)).some((item) => item.kind === "subagentOutput")).toBe(false);
  expect(parseLine(line(true)).some((item) => item.kind === "subagentOutput")).toBe(false);
  const reloaded = readSubagent(JSON.parse(JSON.stringify(record)))!;
  const view = SubagentView.parse(subagentView(reloaded, "Main", new SubagentBook([reloaded]), "codex"));
  expect(view).toMatchObject({ status: "running", engine: "claude", model: "actual-claude", outputTokens: 120 });
});

it("settling and restoring a running task changes its list placement without claiming completion", () => {
  const record = child();
  const book = new SubagentBook([record]);
  expect(book.settle(record.id, true, 10)).toBe(true);
  expect(book.rows("codex")[0]).toMatchObject({ settled: true, status: "running", endedAt: null });
  expect(book.settle(record.id, false, 20)).toBe(true);
  expect(book.rows("codex")[0]).toMatchObject({ settled: false, status: "running", endedAt: null });
  expect(SubagentView.parse(subagentView(record, "Main", book)).outputTokens).toBe(100);
});

it.each(["claude", "codex"] as const)("keeps the owning %s avatar identity even with only one head enabled", async (engine) => {
  const { Bot } = await import("../../src/core/bot");
  const { ProcessLedger } = await import("../../src/core/process/ledger");
  const { mainProfile } = await import("../../src/core/store/workspace");
  const { tempDir } = await import("../helpers");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = tempDir("subagent-owner");
  const profile = mainProfile(dir);
  mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine, heads: { engines: [engine], answerWith: engine } }));
  const owner = new Bot({ profile, deferStartup: true, welcome: false, ledger: new ProcessLedger(join(dir, "ledger.json")), headConfig() { throw new Error("No CLI is needed to present a row"); }, prompts() { throw new Error("No turn should run"); }, emit() {}, log() {}, approvalTimeoutMs: 100, idleMs: 100, interruptGraceMs: 100 });
  owner.subagents.list.push(child());
  expect(owner.view().heads).toEqual([engine]);
  expect(owner.view().subagentRows[0]?.head).toBe(engine);
});
