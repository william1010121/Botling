// Core hot swap with fake cores and fake bots (docs/core-hot-swap.md): the order of a swap, a failed
// self-check that leaves the running core alone, rollback, draining's wait/timeout/tool boundary, and
// where swaps take a build from. No Electron, no processes.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreSwapper, coreBuild, stageCoreBuild, type HoldMode, type SwapPorts } from "../../src/main/core-swap";
import { drainBots, takeHandover, writeHandover, type Drainable, type SwapEntry } from "../../src/core/hot-swap";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scratch = () => { const root = mkdtempSync(join(tmpdir(), "botling-core-swap-")); roots.push(root); return root; };

function ports(overrides: Partial<SwapPorts> = {}) {
  const calls: string[] = [];
  let script = "/old/core/main.cjs";
  let handover: string | null = null;
  const base: SwapPorts = {
    get script() { return script; },
    probe: async (s) => { calls.push(`probe ${s}`); return null; },
    hold: (mode: HoldMode) => { calls.push(`hold ${mode}`); },
    drain: async () => { calls.push("drain"); handover = "{\"v\":1}"; return { ok: true, entries: 2, interrupted: ["b1"] }; },
    undrain: () => { calls.push("undrain"); },
    stop: async () => { calls.push("stop"); },
    start: async (s) => { calls.push(`start ${s}`); script = s; return null; },
    readHandover: () => handover,
    writeHandover: (text) => { calls.push(`write ${text}`); },
    log: () => {},
  };
  return { calls, ports: { ...base, ...overrides, get script() { return script; } } as SwapPorts };
}

describe("CoreSwapper", () => {
  it("self-checks, drains with requests held, stops the old core, starts the new one, then lets requests go", async () => {
    const { calls, ports: p } = ports();
    const outcome = await new CoreSwapper(p, () => ({ version: 1, epoch: 2 })).swap("/new/core/main.cjs");
    expect(outcome).toMatchObject({ ok: true, entries: 2, interrupted: ["b1"] });
    expect(calls).toEqual(["probe /new/core/main.cjs", "hold drain", "drain", "hold all", "stop", "start /new/core/main.cjs", "hold none"]);
  });

  it("a build that fails its self-check is discarded: the running core is not drained, held or stopped", async () => {
    const { calls, ports: p } = ports({ probe: async () => "it exited (1): SyntaxError" });
    const outcome = await new CoreSwapper(p, () => ({ version: 1, epoch: 2 })).swap("/broken/core/main.cjs");
    expect(outcome).toEqual({ ok: false, stage: "self-check", error: "it exited (1): SyntaxError" });
    expect(calls).toEqual([]);
  });

  it("a probe that throws counts as a failed self-check", async () => {
    const { calls, ports: p } = ports({ probe: async () => { throw new Error("spawn failed"); } });
    expect(await new CoreSwapper(p, () => ({ version: 1, epoch: 2 })).swap("/x")).toMatchObject({ ok: false, stage: "self-check", error: "spawn failed" });
    expect(calls).toEqual([]);
  });

  it("a drain that fails is called off and the held requests go to the running core", async () => {
    const { calls, ports: p } = ports({ drain: async () => ({ ok: false, error: "conflict" }) });
    const outcome = await new CoreSwapper(p, () => ({ version: 1, epoch: 2 })).swap("/new");
    expect(outcome).toMatchObject({ ok: false, stage: "drain" });
    expect(calls).toEqual(["probe /new", "hold drain", "undrain", "hold none"]);
  });

  it("a new core that does not come up is stopped and the previous build starts again with the same handover", async () => {
    let starts = 0;
    const { calls, ports: p } = ports();
    const start = p.start;
    p.start = async (s) => (++starts === 1 ? (calls.push(`start ${s}`), "it exited (1)") : start(s));
    const outcome = await new CoreSwapper(p, () => ({ version: 1, epoch: 2 })).swap("/new/core/main.cjs");
    expect(outcome).toEqual({ ok: false, stage: "start", error: "it exited (1)", rolledBack: true });
    expect(calls).toEqual(["probe /new/core/main.cjs", "hold drain", "drain", "hold all", "stop", "start /new/core/main.cjs", "stop", "write {\"v\":1}", "start /old/core/main.cjs", "hold none"]);
  });

  it("one swap at a time", async () => {
    let release!: () => void;
    const { ports: p } = ports({ probe: () => new Promise((resolve) => { release = () => resolve(null); }) });
    const swapper = new CoreSwapper(p, () => ({ version: 1, epoch: 2 }));
    const first = swapper.swap("/a");
    expect(await swapper.swap("/b")).toMatchObject({ ok: false, stage: "busy" });
    release();
    expect(await first).toMatchObject({ ok: true });
  });
});

class FakeBot implements Drainable {
  held = false;
  busyFor: number;
  toolUntil = 0;
  interrupted = false;
  flushed = false;
  started = Date.now();
  constructor(readonly id: string, busyMs: number, private queued: string[] = []) { this.busyFor = busyMs; }
  holdForSwap(hold: boolean) { this.held = hold; }
  get swapBusy() { return !this.interrupted && Date.now() - this.started < this.busyFor; }
  get swapToolInFlight() { return Date.now() < this.toolUntil; }
  async swapInterrupt() { this.interrupted = true; }
  swapEntries(cutOff: boolean): SwapEntry[] {
    return [{ botId: this.id, engine: "claude", sessionId: `s-${this.id}`, continue: cutOff, queued: this.queued.map((words) => ({ words, userId: null, origin: "user" })) }];
  }
  flushForSwap() { this.flushed = true; }
}

describe("drainBots", () => {
  it("holds every bot and waits for turns under way to finish on their own", async () => {
    const quick = new FakeBot("quick", 80);
    const idle = new FakeBot("idle", 0, ["waiting message"]);
    const result = await drainBots([quick, idle], { timeoutMs: 2_000, boundaryMs: 500, pollMs: 10 });
    expect(result.interrupted).toEqual([]);
    expect(quick.interrupted).toBe(false);
    expect([quick.held, idle.held, quick.flushed, idle.flushed]).toEqual([true, true, true, true]);
    expect(result.entries.find((entry) => entry.botId === "idle")!.queued).toEqual([{ words: "waiting message", userId: null, origin: "user" }]);
  });

  it("stops a bot still busy at the timeout, after its tool call returns, and marks it to carry on", async () => {
    const late = new FakeBot("late", 60_000);
    late.toolUntil = Date.now() + 250;
    const start = Date.now();
    const result = await drainBots([late, new FakeBot("idle", 0)], { timeoutMs: 100, boundaryMs: 2_000, pollMs: 10 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(240);
    expect(result.interrupted).toEqual(["late"]);
    expect(result.entries).toEqual([
      expect.objectContaining({ botId: "late", continue: true }),
      expect.objectContaining({ botId: "idle", continue: false }),
    ]);
  });

  it("does not wait past the boundary limit for a tool call that never returns", async () => {
    const stuck = new FakeBot("stuck", 60_000);
    stuck.toolUntil = Date.now() + 60_000;
    const start = Date.now();
    const result = await drainBots([stuck], { timeoutMs: 50, boundaryMs: 150, pollMs: 10 });
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(result.interrupted).toEqual(["stuck"]);
  });
});

describe("the handover file", () => {
  it("is read once, and a stale or malformed one is ignored", () => {
    const dir = scratch();
    const entry: SwapEntry = { botId: "b", engine: "codex", sessionId: "0b7c-11", continue: true, queued: [{ words: "hi", userId: "u1", origin: "user" }] };
    writeHandover(dir, [entry], 1_000);
    expect(takeHandover(dir, 2_000)).toEqual({ v: 1, at: 1_000, entries: [entry] });
    expect(takeHandover(dir, 2_000)).toBeNull();
    writeHandover(dir, [entry], 1_000);
    expect(takeHandover(dir, 1_000 + 16 * 60_000)).toBeNull();
    writeHandover(dir, [{ ...entry, engine: "other" as "codex", sessionId: "../../etc" }], 1_000);
    expect(takeHandover(dir, 2_000)).toEqual({ v: 1, at: 1_000, entries: [] });
  });
});

describe("where swaps take the core from", () => {
  function build(root: string) {
    for (const name of ["core/main.cjs", "host/host.mjs", "host/check-plugin.cjs", "web-extractors/a.js"]) {
      mkdirSync(join(root, name, ".."), { recursive: true });
      writeFileSync(join(root, name), name);
    }
  }
  it("ordinary packaged builds use their own core, even with the flag; source and dev-trial runs honour it", () => {
    const root = scratch();
    const flag = ["--botling-core-dir=/abs/out"];
    expect(coreBuild(root, true, false, flag)).toEqual({ directory: join(root, "out"), script: join(root, "out/core/main.cjs"), development: false });
    expect(coreBuild(root, true, true, flag)).toEqual({ directory: "/abs/out", script: "/abs/out/core/main.cjs", development: true });
    expect(coreBuild(root, false, false, flag).development).toBe(true);
    expect(coreBuild(root, false, false, []).directory).toBe(join(root, "out"));
    expect(() => coreBuild(root, false, false, ["--botling-core-dir=relative"])).toThrow("absolute");
  });
  it("copies a build aside (so rebuilds never change a running core) and keeps only the running and new copies", () => {
    const source = scratch();
    const staging = join(scratch(), "builds");
    build(source);
    const first = stageCoreBuild(source, staging, null, "1");
    expect(first).toBe(join(staging, "1", "core", "main.cjs"));
    expect(existsSync(join(staging, "1", "web-extractors", "a.js"))).toBe(true);
    stageCoreBuild(source, staging, first, "2");
    const third = stageCoreBuild(source, staging, join(staging, "2", "core", "main.cjs"), "3");
    expect(readdirSync(staging).sort()).toEqual(["2", "3"]);
    expect(third).toBe(join(staging, "3", "core", "main.cjs"));
    rmSync(join(source, "host", "check-plugin.cjs"));
    expect(() => stageCoreBuild(source, staging, null, "4")).toThrow("npm run core:build");
  });
});
