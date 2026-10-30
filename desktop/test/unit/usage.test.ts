// Phase 5c: what the bots use (1.x's RateLimits, Spending, Workspace+Spending): Claude's cost and tokens from
// its result lines and its limits from rate_limit_event, Codex's tokens per turn (its workers' too) and its
// own limits, kept in 1.x's files; Settings → Usage reads them with usage.view.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import { addSpending, claudeRateLimits, claudeUsage, codexRateLimits, codexTokens, freshSpending, mergeLimits, rolled, today, UsageBook } from "../../src/core/usage";
import { parseLine } from "../../src/core/agent/stream";

const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null) await harness.kill("SIGTERM"); });
const swift = (unix: number) => unix - 978_307_200;

describe("reading the CLIs", () => {
  it("Claude: a result line's running cost and tokens; rate_limit_event's windows (unified, or the one named; rejected is used up)", () => {
    expect(claudeUsage({ type: "result", total_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 } }))
      .toEqual({ totalCost: 0.25, tokens: { input: 10, output: 20, cacheWrite: 30, cacheRead: 40 } });
    expect(claudeUsage({ type: "result" })).toBeNull();
    expect(claudeUsage({ type: "assistant", total_cost_usd: 1 })).toBeNull();
    const unified = claudeRateLimits({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.47, resetsAt: 1_800_000_000 }, seven_day: { utilization: 1.5 } } } }, 7);
    expect(unified).toEqual({ fiveHour: { used: 0.47, resetsAt: swift(1_800_000_000), seen: 7 }, week: { used: 1, seen: 7 } });
    expect(claudeRateLimits({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1_800_000_000 } }, 7))
      .toEqual({ week: { used: 1, resetsAt: swift(1_800_000_000), seen: 7 } });
    expect(claudeRateLimits({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour" } }, 7)).toBeNull();
    // As stream items: usage before the result, limits on their own.
    expect(parseLine(JSON.stringify({ type: "result", subtype: "success", result: "hi", total_cost_usd: 0.1, usage: { input_tokens: 1 } })).map((item) => item.kind)).toEqual(["usage", "result"]);
    expect(parseLine(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.1 } } } }))[0]).toMatchObject({ kind: "rateLimits", engine: "claude" });
  });

  it("Codex: primary/secondary by their length, percent to 0…1; cached input is read from the cache", () => {
    expect(codexRateLimits({ primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 131, windowDurationMins: 10080 } }, 3))
      .toEqual({ fiveHour: { used: 0.07, resetsAt: swift(1_800_000_000), seen: 3 }, week: { used: 1, seen: 3 } });
    expect(codexRateLimits({ secondary: { usedPercent: 5 } }, 3)).toEqual({ fiveHour: { used: 0.05, seen: 3 } });
    expect(codexTokens({ inputTokens: 2000, cachedInputTokens: 1500, outputTokens: 250 })).toEqual({ input: 500, output: 250, cacheWrite: 0, cacheRead: 1500 });
    expect(codexTokens({ inputTokens: 10, cachedInputTokens: 50 })).toEqual({ input: 0, output: 0, cacheWrite: 0, cacheRead: 50 });
  });

  it("limits merge window by window; spending rolls over to a new day and keeps 30 days", () => {
    expect(mergeLimits({ fiveHour: { used: 0.1, seen: 1 }, week: { used: 0.2, seen: 1 } }, { week: { used: 0.3, seen: 2 } })).toEqual({ fiveHour: { used: 0.1, seen: 1 }, week: { used: 0.3, seen: 2 } });
    let spending = freshSpending("2026-10-24");
    spending = addSpending(spending, 0.5, { input: 1, output: 2, cacheWrite: 0, cacheRead: 0 }, "Main bot", new Date(2026, 9, 24, 12));
    spending = addSpending(spending, 0, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, "Shop", new Date(2026, 9, 24, 12));
    expect(spending).toMatchObject({ day: "2026-10-24", spent: 0.5, byBot: { "Main bot": 0.5 }, tokensByBot: { "Main bot": { input: 1, output: 2 } } });
    const next = addSpending(spending, 0.25, { input: 0, output: 5, cacheWrite: 0, cacheRead: 0 }, "Shop", new Date(2026, 9, 25, 9));
    expect(next).toMatchObject({ day: "2026-10-25", spent: 0.25, byBot: { Shop: 0.25 }, history: [{ day: "2026-10-24", spent: 0.5, tokens: { input: 1, output: 2 } }] });
    let long = freshSpending("2026-01-01");
    for (let day = 1; day <= 40; day++) long = rolled({ ...long, spent: 1 }, `2026-02-${String(day).padStart(2, "0")}`);
    expect(long.history).toHaveLength(30);
    expect(today(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("reads 1.x's files (a spending.json from before tokens were counted too)", () => {
    const dir = tempDir("usage-files");
    writeFileSync(join(dir, "spending.json"), JSON.stringify({ day: today(), spent: 1.5, byBot: { "Main bot": 1.5 }, allowance: 10 }));
    writeFileSync(join(dir, "codex-rate-limits.json"), JSON.stringify({ week: { used: 0.3, resetsAt: 900_000_000, seen: 800_000_000 } }));
    const book = new UsageBook(dir);
    expect(book.spending).toEqual({ day: today(), spent: 1.5, byBot: { "Main bot": 1.5 }, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, tokensByBot: {}, history: [] });
    expect(book.codex).toEqual({ week: { used: 0.3, resetsAt: 900_000_000, seen: 800_000_000 } });
    expect(book.claude).toEqual({});
  });
});

describe("Codex's 5-hour window follows the latest snapshot", () => {
  const both = { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 900_000_000 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 900_500_000 } };
  const weekly = { primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 900_500_000 } };
  it("reports 5 hours and Week for a two-window snapshot, only Week for a weekly one", () => {
    expect(Object.keys(codexRateLimits(both)).sort()).toEqual(["fiveHour", "week"]);
    expect(Object.keys(codexRateLimits(weekly))).toEqual(["week"]);
  });
  it("a weekly-only snapshot after a 5h+weekly one drops the 5-hour window; Claude still keeps its old one", () => {
    const book = new UsageBook(tempDir("usage-codex-5h"));
    book.note("codex", codexRateLimits(both));
    expect(book.codex.fiveHour?.used).toBeCloseTo(0.4);
    book.note("codex", codexRateLimits(weekly));
    expect(book.codex.fiveHour).toBeUndefined();
    expect(book.codex.week?.used).toBeCloseTo(0.12);
    expect(JSON.parse(readFileSync(join(book["dir"], "codex-rate-limits.json"), "utf8")).fiveHour).toBeUndefined();
    book.note("claude", { fiveHour: { used: 0.5, seen: 1 }, week: { used: 0.2, seen: 1 } });
    book.note("claude", { week: { used: 0.3, seen: 2 } });
    expect(book.claude.fiveHour?.used).toBe(0.5);
  });
});

describe("usage in the core", () => {
  it("Claude's turns: the difference of the running cost, the tokens, the limits; usage.view and 1.x's files", async () => {
    const dir = tempDir("usage-claude");
    const c = new CoreHarness(dir, { FAKE_CLAUDE_USAGE: "1" });
    harnesses.push(c);
    for (const text of ["one", "two"]) {
      const sent = await c.call({ type: "chat.send", botId: MAIN, text });
      await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId));
    }
    const view = await c.call({ type: "usage.view" });
    expect(view.day).toBe(today());
    expect(view.spent).toBeCloseTo(0.02, 10);
    expect(view.tokens).toEqual({ input: 2400, output: 600, cacheWrite: 1000, cacheRead: 8000 });
    expect(view.byBot).toEqual([{ name: "Main bot", spent: expect.closeTo(0.02, 10), tokens: 12000 }]);
    expect(view.claude.fiveHour.used).toBe(0.42);
    expect(view.claude.week.used).toBe(0.18);
    expect(view.claude.fiveHour.resetsAt).toBeGreaterThan(Date.now() + 2 * 3600_000);
    expect(view.codex).toEqual({ fiveHour: null, week: null });
    const spending = JSON.parse(readFileSync(join(dir, "spending.json"), "utf8"));
    expect(Object.keys(spending).sort()).toEqual(["byBot", "day", "history", "spent", "tokens", "tokensByBot"]);
    expect(spending.tokensByBot["Main bot"]).toEqual({ input: 2400, output: 600, cacheWrite: 1000, cacheRead: 8000 });
    const limits = JSON.parse(readFileSync(join(dir, "rate-limits.json"), "utf8"));
    expect(limits.fiveHour.seen).toBeGreaterThan(swift(Date.now() / 1000) - 60);
  });

  it("Codex's turns and its workers' runs: their tokens, its own limits apart from Claude's", async () => {
    const dir = tempDir("usage-codex");
    mkdirSync(join(dir, "main"), { recursive: true });
    writeFileSync(join(dir, "main", "bot.json"), JSON.stringify({ engine: "codex", heads: { engines: ["codex"], answerWith: "codex" } }));
    const c = new CoreHarness(dir, { FAKE_CODEX_USAGE: "1", FAKE_CODEX_WORKER_MS: "30" });
    harnesses.push(c);
    const sent = await c.call({ type: "chat.send", botId: MAIN, text: "hello" });
    await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId));
    let view = await c.call({ type: "usage.view" });
    expect(view.tokens).toEqual({ input: 500, output: 250, cacheWrite: 0, cacheRead: 1500 });
    expect(view.spent).toBe(0);
    expect(view.codex.fiveHour.used).toBe(0.07);
    expect(view.codex.week.used).toBe(0.31);
    expect(view.claude).toEqual({ fiveHour: null, week: null });
    // A worker: its run's tokens count too (the coordinator's turns as well).
    await c.call({ type: "chat.send", botId: MAIN, text: "/worker count the files" });
    await until(async () => (await c.call({ type: "usage.view" })).tokens.output >= 4 * 250, { timeout: 15_000, what: "the worker's and the report turn's tokens" });
    view = await c.call({ type: "usage.view" });
    expect(view.byBot).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "codex-rate-limits.json"), "utf8")).week.used).toBe(0.31);
  });
});
