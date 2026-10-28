import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { UsageView } from "../../src/contract";
import { today } from "../../src/core/usage";
import { CoreHarness } from "../core-harness";
import { tempDir } from "../helpers";

it("serves the local normalized ledger through the strict wire without starting any turn", async () => {
  const dir = tempDir("token-flow-ledger");
  const tokens = { input: 10, output: 2, cacheRead: 30, cacheWrite: 4 };
  writeFileSync(join(dir, "spending.json"), JSON.stringify({ day: today(), spent: 0, byBot: {}, tokens, tokensByBot: { Main: tokens }, history: [] }));
  const core = new CoreHarness(dir);
  try {
    const view = UsageView.parse(await core.call({ type: "usage.view", localOnly: true }));
    expect(view.byBot).toEqual([{ name: "Main", spent: 0, tokens: 46, breakdown: tokens }]);
    expect(view.tokens).toEqual(tokens);
    expect(core.of("turn.started")).toHaveLength(0);
  } finally { await core.kill("SIGTERM"); }
});
