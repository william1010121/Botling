// The words around a subscription's limits and the usage page's numbers, checked against the Swift app's own
// (test/fixtures/phase5c-golden.json, written by DesktopPhase5cGoldenExport.swift).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { desktop } from "../../../test/helpers";
import { asOf, countdown, dollars, percent, resetDay, staleSince, tokenCount, type LimitWindow } from "../src/usage-text";

const G = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "phase5c-golden.json"), "utf8"));
const swiftToMs = (swift: number) => (swift + 978_307_200) * 1000;

describe("usage words (RateLimitText, Workspace.dollars / tokenCount)", () => {
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
