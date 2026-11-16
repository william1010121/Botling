// Slow restart (install of a developer build): botlingd's start and stop name the phases that take long, and the network
// closes of a stop share one budget, so a link that never answers cannot hold the core's stop (an install waits for botlingd).
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Botlingd } from "../../src/server/botlingd";
import { NETWORK_STOP_BUDGET_MS, PhaseClock, SLOW_PHASE_MS, withinBudget } from "../../src/server/phase-clock";
import { botlingdEnv, testRoot } from "../botlingd-harness";
import { desktop } from "../helpers";

afterEach(() => { vi.useRealTimers(); });

describe("PhaseClock", () => {
  it("logs a phase that took the slow limit or more, with its name and length, and passes its value on", async () => {
    let now = 1_000;
    const lines: string[] = [];
    const clock = new PhaseClock((line) => lines.push(line), 500, () => now);
    expect(await clock.time("start", "fast", () => { now += 499; return 1; })).toBe(1);
    expect(await clock.time("start", "slow", async () => { now += 500; return "x"; })).toBe("x");
    expect(await clock.time("stop", "slower", () => { now += 12_345; })).toBeUndefined();
    expect(lines).toEqual(["start: slow took 500 ms", "stop: slower took 12345 ms"]);
  });

  it("logs a slow phase that throws, and rethrows", async () => {
    let now = 0;
    const lines: string[] = [];
    const clock = new PhaseClock((line) => lines.push(line), 500, () => now);
    await expect(clock.time("stop", "peer sessions", () => { now += 900; throw new Error("boom"); })).rejects.toThrow("boom");
    expect(lines).toEqual(["stop: peer sessions took 900 ms"]);
  });

  it("the default limit is 500 ms", () => { expect(SLOW_PHASE_MS).toBe(500); });
});

describe("withinBudget", () => {
  it("a close that never answers is left behind when the budget is used up (the stop goes on)", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const result = withinBudget(Date.now() + 5_000, "sessions", () => new Promise<void>(() => undefined), (line) => lines.push(line));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(false);
    expect(lines).toEqual(["stop: sessions did not finish within the network budget; going on without it"]);
  });

  it("a close that finishes in time is waited for and the budget timer does not stay", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const result = withinBudget(Date.now() + 5_000, "pairing", () => new Promise<void>((resolve) => setTimeout(resolve, 300)), (line) => lines.push(line));
    await vi.advanceTimersByTimeAsync(300);
    expect(await result).toBe(true);
    expect(lines).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a close that throws within the budget throws (it is reported as a failed step)", async () => {
    await expect(withinBudget(Date.now() + 5_000, "listener", () => { throw new Error("no listener"); }, () => undefined)).rejects.toThrow("no listener");
  });

  it("with no budget left the close is still started, not waited for, and a late rejection is not unhandled", async () => {
    const lines: string[] = [];
    let started = false;
    const result = await withinBudget(Date.now() - 1, "peer sessions", async () => { started = true; await Promise.resolve(); throw new Error("late"); }, (line) => lines.push(line));
    expect(result).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toBe(true);
    expect(lines).toEqual(["stop: peer sessions was not waited for (the network budget was used up)"]);
  });

  it("the budget is five seconds", () => { expect(NETWORK_STOP_BUDGET_MS).toBe(5_000); });
});

describe("Botlingd stop with a network close that never answers", () => {
  const roots: string[] = [];
  afterEach(() => { Botlingd.networkStopBudgetMs = NETWORK_STOP_BUDGET_MS; while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

  it("goes on to stop the core and the store once the budget is used, and says which close it left", async () => {
    const root = testRoot("stop-budget");
    roots.push(root);
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const lines: string[] = [];
    const daemon = await Botlingd.start({ env: botlingdEnv(dataDir), outDir: join(desktop, "out"), log: (line) => lines.push(line) });
    // started: carries how long the whole start took
    expect(lines.find((line) => line.startsWith("started:"))).toMatch(/, pid \d+, \d+ ms$/);
    Botlingd.networkStopBudgetMs = 300;
    const sessions = (daemon as unknown as { server: { close: () => Promise<void> } }).server;
    const realClose = sessions.close.bind(sessions);
    sessions.close = () => new Promise<void>(() => undefined);
    const began = Date.now();
    await daemon.stop();
    const took = Date.now() - began;
    await realClose().catch(() => undefined); // the left-behind close, so the test leaves no open socket
    expect(lines).toContain("stop: sessions did not finish within the network budget; going on without it");
    // What came after the stuck close still ran: the core and the store stopped.
    expect(lines.at(-1)).toBe("stopped");
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(15_000);
  }, 60_000);
});
