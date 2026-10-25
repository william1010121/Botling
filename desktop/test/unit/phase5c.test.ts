// Phase 5c's strings and values checked against the Swift app's own (test/fixtures/phase5c-golden.json, written
// by Tests/ClaudeCodeBotCoreTests/DesktopPhase5cGoldenExport.swift): the component brief (what the fork is
// asked, what is taken from its answer, how it is started), the engine switch's dividers, and the usage page's
// numbers and words (rate limits, tokens, spending).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { desktop } from "../helpers";
import { BRIEF_DENIED_TOOLS, BRIEF_LIMIT, BRIEF_TIMEOUT_MS, BRIEF_TOOLS, briefConfig, briefFrom, briefRequest } from "../../src/core/component-brief";
import { headArguments } from "../../src/core/agent/head";
import { parseLine } from "../../src/core/agent/stream";
import { addSpending, claudeRateLimits, codexRateLimits, codexTokens, freshSpending, type RateLimits, type RateLimitWindow } from "../../src/core/usage";
import { asOf, countdown, dollars, percent, resetDay, staleSince, tokenCount, type LimitWindow } from "../../src/renderer/usage-text";

const G = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "phase5c-golden.json"), "utf8"));
const swiftToMs = (swift: number) => (swift + 978_307_200) * 1000;
/** Swift's export writes a window with resetsAt null when it has none. */
const limitsOf = (limits: RateLimits) => {
  const window = (value: RateLimitWindow | undefined) => (value ? { used: value.used, resetsAt: value.resetsAt ?? null, seen: value.seen } : null);
  return { fiveHour: window(limits.fiveHour), week: window(limits.week) };
};

describe("the component brief (ComponentBrief.swift)", () => {
  it("asks the fork 1.x's words, with the user's message (clipped at 4,000 characters) when there is one", () => {
    for (const request of G.brief.requests) {
      expect(briefRequest({ when: G.brief.when, preview: G.brief.preview }, request.asked || null, G.brief.folder)).toBe(request.text);
    }
  });

  it("takes what <component-brief> holds (else the whole answer), trimmed, clipped at 8,000; nothing: none", () => {
    for (const { answer, brief } of G.brief.briefs) expect(briefFrom(answer)).toBe(brief);
    expect([BRIEF_TIMEOUT_MS, BRIEF_LIMIT, BRIEF_TOOLS, BRIEF_DENIED_TOOLS]).toEqual([G.brief.timeout * 1000, G.brief.limit, G.brief.tools, G.brief.denied]);
  });

  it("starts the fork as 1.x does: the session resumed as a copy, read-only, nothing kept, asking nothing", () => {
    const args = headArguments(briefConfig({ command: "claude", cwd: G.brief.folder, sessionId: "0b07e11c-0000-4000-8000-0000000000ab", resume: false, model: "sonnet", effort: "high", allowedTools: ["Bash"], systemPrompt: "the bot's own" }));
    // Each flag with its value as Swift gives it (2.0's order differs, and its head also streams partial messages).
    const flags = (list: string[]) => {
      const out: Record<string, string | true> = {};
      for (let i = 0; i < list.length; i++) {
        const flag = list[i]!;
        if (!flag.startsWith("--")) continue;
        const value = list[i + 1];
        if (value !== undefined && !value.startsWith("--")) { out[flag] = value; i++; } else out[flag] = true;
      }
      return out;
    };
    const swift = flags(G.brief.arguments);
    const ours = flags(args);
    delete ours["--include-partial-messages"];
    expect(ours).toEqual(swift);
    expect(args[0]).toBe("-p");
  });
});

describe("switching a head's engine (Bot.switchEngine)", () => {
  it("says 1.x's dividers", () => {
    expect(G.engine).toMatchObject({ handoffCodex: "Handoff → Codex", handoffClaude: "Handoff → Claude", switchedCodex: "Switched to Codex", switchedClaude: "Switched to Claude" });
  });
});

describe("usage (RateLimits.swift, Spending, RateLimitText)", () => {
  it("reads Claude's rate_limit_event lines and result lines as Swift does", () => {
    for (const { line, limits } of G.usage.claudeLimits) {
      const ours = claudeRateLimits(line, G.usage.seen);
      expect(ours ? limitsOf(ours) : null).toEqual(limits);
    }
    for (const { line, usage } of G.usage.claudeUsage) {
      const item = parseLine(line).find((candidate) => candidate.kind === "usage");
      expect(item ? { totalCost: (item as any).totalCost, tokens: (item as any).tokens } : null).toEqual(usage);
    }
  });

  it("reads Codex's limits and token breakdowns as Swift does", () => {
    for (const { snapshot, limits } of G.usage.codexLimits) expect(limitsOf(codexRateLimits(snapshot, G.usage.seen))).toEqual(limits);
    for (const { breakdown, tokens } of G.usage.codexTokens) expect(codexTokens(breakdown)).toEqual(tokens);
  });

  it("adds up spending day by day as Swift's spending.json has it", () => {
    let spending = freshSpending("2026-10-24");
    for (const step of G.usage.spending) {
      spending = addSpending(spending, step.amount, step.tokens, step.bot, new Date(swiftToMs(step.at)));
      expect(spending).toEqual(step.spending);
    }
  });

  it("words the limits as Swift does: percent, countdown, the reset day, as of; and when a reading is stale", () => {
    const now = swiftToMs(G.usage.now);
    const ms = (window: any): LimitWindow => ({ used: window.used, resetsAt: window.resetsAt === null ? null : swiftToMs(window.resetsAt), seen: swiftToMs(window.seen) });
    for (const text of G.usage.texts) {
      const window = ms(text.window);
      expect([text.label, percent(window, now), countdown(window, now), resetDay(window, now, "en-US", "UTC"), asOf(window.seen, now)])
        .toEqual([text.label, text.percent, text.countdown, text.resetDay, text.asOf]);
    }
    for (const { limits, staleSince: since } of G.usage.stale) {
      expect(staleSince({ fiveHour: ms(limits.fiveHour), week: ms(limits.week) }, now)).toBe(since === null ? null : swiftToMs(since));
    }
    for (const { count, text } of G.usage.tokenCount) expect(tokenCount(count)).toBe(text);
    for (const { amount, text } of G.usage.dollars) expect(dollars(amount)).toBe(text);
  });
});
