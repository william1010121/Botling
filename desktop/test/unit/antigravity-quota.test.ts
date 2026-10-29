import { expect, it } from "vitest";
import { AntigravityQuotaView, UsageView } from "../../src/contract";
import { readAntigravityQuota } from "../../src/core/antigravity-quota";
import { UsageBook, usageView } from "../../src/core/usage";
import { tempDir } from "../helpers";

it("reports the unsupported ACP quota source even when token spending is recorded", async () => {
  const calls: string[] = [];
  const book = new UsageBook(tempDir("agy-quota"), undefined, undefined, async engine => {
    calls.push(engine);
    return { week: { used: .25, seen: 20 } };
  });
  book.record(0, { input: 100, output: 25, cacheWrite: 0, cacheRead: 0 }, "Antigravity");
  await book.refresh();
  const view = UsageView.parse(usageView(book.view()));
  expect(view.antigravity).toEqual({ status: "unavailable", reason: "unsupported_connection", source: "antigravity_acp" });
  expect(calls.sort()).toEqual(["claude", "codex"]);
  expect(view.claude.week?.used).toBe(.25);
  expect(view.codex.week?.used).toBe(.25);
  expect(view.tokens.input).toBe(100);
});

it("rejects fabricated quota numbers and model lists in the unsupported-source contract", () => {
  const quota = readAntigravityQuota();
  expect(AntigravityQuotaView.parse(quota)).toEqual(quota);
  for (const extra of [{ remaining: 100 }, { used: 0 }, { models: ["gemini"] }, { status: "available" }]) {
    expect(AntigravityQuotaView.safeParse({ ...quota, ...extra }).success).toBe(false);
  }
});

it("accepts older usage responses without Antigravity and does not migrate saved settings", () => {
  const view = usageView(new UsageBook(tempDir("agy-quota-old")).view());
  delete view.antigravity;
  expect(UsageView.parse(view).antigravity).toBeUndefined();
});
