import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TokenFlowHistoryView, UsageView } from "../../src/contract";
import { today } from "../../src/core/usage";
import { CoreHarness, MAIN } from "../core-harness";
import { tempDir } from "../helpers";

it("serves the local normalized ledger through the strict wire without starting any turn", async () => {
  const dir = tempDir("token-flow-ledger");
  const tokens = { input: 10, output: 2, cacheRead: 30, cacheWrite: 4 };
  writeFileSync(join(dir, "spending.json"), JSON.stringify({ day: today(), spent: 0, byBot: {}, tokens, tokensByBot: { Main: tokens }, history: [] }));
  const saved = join(dir, "main", "partner-codex"); mkdirSync(saved, { recursive: true });
  writeFileSync(join(saved, "subagents.json"), JSON.stringify([{ id: "saved-worker", description: "Prior work", status: "completed", startedAt: 100, endedAt: 200, outputTokenCounters: { "thread:saved": 42 }, prompt: "PRIVATE", steps: [] }]));
  const core = new CoreHarness(dir);
  try {
    const view = UsageView.parse(await core.call({ type: "usage.view", localOnly: true }));
    expect(view.byBot).toEqual([{ name: "Main", spent: 0, tokens: 46, breakdown: tokens }]);
    expect(view.tokens).toEqual(tokens);
    const history = TokenFlowHistoryView.parse(await core.call({ type: "tokenFlow.view", botId: MAIN }));
    expect(history.rows[0]).toMatchObject({ id: "saved-worker", attributableOutputTokens: 42 });
    expect(JSON.stringify(history)).not.toContain("PRIVATE");
    expect(core.of("turn.started")).toHaveLength(0);
  } finally { await core.kill("SIGTERM"); }
});
