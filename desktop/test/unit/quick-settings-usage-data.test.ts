import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { UsageView } from "../../src/contract";
import { CoreHarness, MAIN } from "../core-harness";
import { writeSwiftFixture } from "../fixtures/swift-data";
import { tempDir, until } from "../helpers";

it("serves imported quota/reset readings on the first boot, then persists fresh CLI windows without replacing other engines", async () => {
  const { source } = writeSwiftFixture(tempDir("quick-quota-source"));
  const claude = { fiveHour: { used: .47, seen: 800000000, resetsAt: 900000000 }, week: { used: .22, seen: 800000000, resetsAt: 901000000 } };
  const codex = { week: { used: .05, seen: 800000000, resetsAt: 902000000 } };
  writeFileSync(join(source, "rate-limits.json"), JSON.stringify(claude));
  writeFileSync(join(source, "codex-rate-limits.json"), JSON.stringify(codex));
  const target = tempDir("quick-quota-core");
  const core = new CoreHarness(target, { BOTLING_IMPORT_FROM: source, FAKE_CLAUDE_USAGE: "1" });
  try {
    const view = UsageView.parse(await core.call({ type: "usage.view" }));
    expect(view.claude.fiveHour).toEqual({ used: .47, seen: (800000000 + 978307200) * 1000, resetsAt: (900000000 + 978307200) * 1000 });
    expect(view.claude.week?.used).toBe(.22);
    expect(view.codex).toEqual({ fiveHour: null, week: { used: .05, seen: (800000000 + 978307200) * 1000, resetsAt: (902000000 + 978307200) * 1000 } });
    const sent = await core.call({ type: "chat.send", botId: MAIN, text: "hello" });
    await until(() => core.of("turn.finished").some((event: any) => event.event.turnId === sent.turnId));
    const next = UsageView.parse(await core.call({ type: "usage.view" }));
    expect(next.claude.fiveHour?.used).toBe(.42);
    expect(next.claude.fiveHour!.seen).toBeGreaterThan(Date.now() - 60_000);
    expect(next.claude.fiveHour!.resetsAt).toBeGreaterThan(Date.now());
    expect(next.codex).toEqual(view.codex);
    expect(JSON.parse(readFileSync(join(target, "rate-limits.json"), "utf8")).fiveHour.used).toBe(.42);
    expect(JSON.parse(readFileSync(join(source, "rate-limits.json"), "utf8"))).toEqual(claude);
    expect(JSON.parse(readFileSync(join(source, "codex-rate-limits.json"), "utf8"))).toEqual(codex);
  } finally { await core.kill("SIGTERM"); }
});
