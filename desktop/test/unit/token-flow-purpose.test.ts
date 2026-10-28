import { expect, it } from "vitest";
import { exclusiveOutputTokens, readSubagent, SubagentBook } from "../../src/core/subagents";
import { flowWorkers, flowPurpose, purposeTotals } from "../../src/renderer/token-flow-model";
import type { BotView } from "../../src/contract";
const record = (id: string, counters?: Record<string, number>, parentID?: string) => readSubagent({ id, parentID, description: id, status: "running", prompt: "private", startedAt: 0, steps: [], outputTokenCounters: counters })!;

it("only sums uniquely owned message/thread output, excluding overlapping nested and legacy counters", () => {
  const parent = record("p", { "message:own": 10, "message:shared": 20 });
  const child = record("c", { "message:shared": 20 }, "p");
  const leaf = record("l", { "thread:independent": 30 }, "c");
  const old = record("old", { undocumented: 999 });
  const zero = record("zero", { "thread:zero": 0 });
  const missing = record("missing");
  const outputs = exclusiveOutputTokens([parent, child, leaf, old, zero, missing]);
  expect([...outputs.values()]).toEqual([null, null, 30, null, 0, null]);
  expect(new SubagentBook([parent, child, leaf]).delegationRows("codex", outputs).map(row => row.attributableOutputTokens)).toEqual([null, null, 30]);
});

it("uses observed delegation roles, keeps semantic purpose estimated, and separates mixed/unknown", () => {
  const book = new SubagentBook([
    record("coordinates-and-executes", { "thread:p": 10 }),
    record("reports-only-title-is-not-evidence", { "thread:c": 20 }, "coordinates-and-executes"),
    record("orphan", { "thread:o": 5 }, "missing-parent"),
    record("missing-usage"),
  ]);
  const bot = { subagentRows: [], delegationRows: book.delegationRows("codex") } as unknown as BotView;
  const initiallyAlone = flowWorkers({ ...bot, delegationRows: bot.delegationRows!.slice(0, 1) }, []);
  expect(purposeTotals(initiallyAlone).execution.known).toBe(10);
  const workers = flowWorkers(bot, []);
  expect(flowPurpose(workers.find(worker => worker.id === "coordinates-and-executes")!, workers)).toBe("mixed");
  expect(flowPurpose(workers.find(worker => worker.id === "reports-only-title-is-not-evidence")!, workers)).toBe("execution");
  const totals = purposeTotals(workers);
  expect(totals).toEqual({ communication: { known: 0, measured: 0, unknown: 1 }, execution: { known: 20, measured: 1, unknown: 0 }, mixed: { known: 15, measured: 2, unknown: 1 } });
  // Separate counters are own output, not inclusive parent+child session totals. No daily ledger enters this function.
  expect(totals.execution.known + totals.mixed.known).toBe(35);
  expect(JSON.stringify(bot.delegationRows)).not.toContain("private");
  expect(JSON.stringify(bot.delegationRows)).not.toContain("thread:");
});
