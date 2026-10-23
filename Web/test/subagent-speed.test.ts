import { afterEach, describe, expect, it, vi } from "vitest";
import { subagentSpeedElement, subagentTokenSpeed } from "../src/subagent-speed";
import { fillSubagentBar } from "../src/subagent";
import type { SubagentHeaderView } from "../src/types";
const header = (extra: Partial<SubagentHeaderView> = {}): SubagentHeaderView => ({
  id: "child", title: "Review", owner: "Main", status: "running", type: null,
  outputTokens: 100, startedAt: 1_000_000, ...extra,
});
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });
describe("subagent output throughput", () => {
  it("converts epoch milliseconds to seconds using reported output", () => {
    expect(subagentTokenSpeed(header(), 1_004_000)).toBe(25);
    expect(subagentTokenSpeed(header({ outputTokens: 150 }), 1_006_000)).toBe(25);
  });
  it("freezes ended values including failures and stopped runs", () => {
    for (const status of ["completed", "failed", "stopped"]) {
      expect(subagentTokenSpeed(header({ status, endedAt: 1_004_000 }), 9_000_000)).toBe(25);
    }
  });
  it("rejects missing, zero, reversed and nonfinite data", () => {
    for (const outputTokens of [undefined, null, 0, -1, NaN, Infinity]) {
      expect(subagentTokenSpeed(header({ outputTokens }), 1_004_000)).toBeNull();
    }
    for (const startedAt of [undefined, null, NaN, Infinity, 1_004_000, 1_005_000]) {
      expect(subagentTokenSpeed(header({ startedAt }), 1_004_000)).toBeNull();
    }
    expect(subagentTokenSpeed(header({ status: "completed" }), 1_004_000)).toBeNull();
    expect(subagentTokenSpeed(header(), Infinity)).toBeNull();
  });
  it("ticks while watching, accepts newer usage and freezes final state for both engines", () => {
    vi.useFakeTimers(); vi.setSystemTime(1_004_000);
    const bar = document.createElement("div"); document.body.append(bar);
    for (const engine of ["claude", "codex"]) {
      fillSubagentBar(bar, header({ engine }));
      expect(bar.querySelector(".subagent-speed")?.textContent).toBe("≈ 25.0 tok/s · avg");
      vi.advanceTimersByTime(1000);
      expect(bar.querySelector(".subagent-speed")?.textContent).toContain("20.0");
      fillSubagentBar(bar, header({ engine, outputTokens: 200 }));
      expect(bar.querySelector(".subagent-speed")?.textContent).toContain("40.0");
      fillSubagentBar(bar, header({ engine, outputTokens: 200, status: "completed", endedAt: 1_005_000 }));
      vi.advanceTimersByTime(10_000);
      expect(bar.querySelector(".subagent-speed")?.textContent).toContain("40.0");
      expect(vi.getTimerCount()).toBe(0);
      vi.setSystemTime(1_004_000);
    }
  });
  it("shows a neutral placeholder and explains timing and reporting limits", () => {
    const label = subagentSpeedElement(header({ status: "completed", outputTokens: null }));
    expect(label.textContent).toBe("≈ — tok/s · avg");
    expect(label.title).toContain("including tools, waiting");
    expect(label.title).toContain("not model decoding speed");
    expect(label.getAttribute("aria-label")).toContain(label.title);
    expect(subagentSpeedElement(header({ status: "completed", outputTokens: 0.01, endedAt: 1_004_000 })).textContent).toContain("<0.1");
  });
  it("cleans up after leaving the subagent screen", () => {
    vi.useFakeTimers();
    const label = subagentSpeedElement(header()); document.body.append(label); label.remove();
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
