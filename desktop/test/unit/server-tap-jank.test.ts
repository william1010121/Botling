// UI jank, core events (branch bot/jank-core-events): a `subagent.updated` or `components.updated` over one frame is cut, not
// dropped (the rail row froze until a resync), and a burst of `bot.updated` / `subagent.updated` of one object waiting in the
// event tap is written once, the latest. Over the real in-memory server.db, the real log and the real tap.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Event as ContractEvent } from "../../src/contract";
import { canonicalJson, type StreamId } from "../../src/protocol";
import { BODY_BYTES_LIMIT, fitBody } from "../../src/server/effects/fit";
import { TxScope } from "../../src/server/effects/scope";
import { EventTap, type EventTapOptions } from "../../src/server/effects/tap";
import { readEntries, verifyStream } from "../../src/server/log";
import { effectCheckpointSink } from "../../src/server/effects";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { quickStore, type QuickStore } from "./server-log-helpers";
import { memoryStore } from "./server-slots-harness";

const TIME = "2026-11-18T00:00:00.000Z";
const bytes = (value: unknown) => Buffer.byteLength(canonicalJson(value));

const step = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `s${i}`, kind: "tool", tool: "Bash", title: `step ${i}`, detail: null, output: "o".repeat(9_000), failed: false, done: true, ...extra,
});
const subagent = (steps: unknown[], overrides: Record<string, unknown> = {}) => ({
  id: "sa1", title: "Reviewer", owner: "alpha", status: "running", type: null, model: null, prompt: "go", steps, result: null,
  startedAt: TIME, endedAt: null, ...overrides,
});
const info = (template: string, extra: Record<string, unknown> = {}) => ({ template, version: 1, updated: false, sizes: ["s"], icon: null, title: null, ...extra });

describe("fitBody: a sub-agent view over one frame loses its oldest steps, never the whole update", () => {
  const big = Array.from({ length: 500 }, (_, i) => step(i)); // about 4.5 MB
  const body = { botId: "alpha", subagent: subagent(big, { result: "the result", prompt: "the task" }) };

  it("is not dropped, fits, keeps the newest steps, the result and the prompt", () => {
    expect(bytes(body)).toBeGreaterThan(BODY_BYTES_LIMIT * 10);
    const fitted = fitBody("subagent.updated", body);
    expect(fitted.dropped).toBe(false);
    expect(bytes(fitted.body)).toBeLessThanOrEqual(BODY_BYTES_LIMIT);
    const kept = (fitted.body.subagent as { steps: Array<{ id: string }>; result: string; prompt: string });
    expect(kept.steps.length).toBeGreaterThan(10);
    expect(kept.steps.length).toBeLessThan(500);
    expect(kept.steps.at(-1)!.id).toBe("s499");
    expect(kept.steps[0].id).toBe(`s${500 - kept.steps.length}`); // one unbroken newest run
    expect(kept.result).toBe("the result");
    expect(kept.prompt).toBe("the task");
    expect(fitted.full).toBeNull();
  });

  it("keeps as many newest steps as fit: one more would not", () => {
    const fitted = fitBody("subagent.updated", body);
    const kept = (fitted.body.subagent as { steps: unknown[] }).steps.length;
    const oneMore = { ...body, subagent: { ...body.subagent, steps: big.slice(500 - kept - 1) } };
    expect(bytes(oneMore)).toBeGreaterThan(BODY_BYTES_LIMIT);
  });

  it("does not change the caller's view", () => {
    const before = canonicalJson(body);
    fitBody("subagent.updated", body);
    expect(canonicalJson(body)).toBe(before);
  });

  it("a view that already fits comes back as it is", () => {
    const small = { botId: "alpha", subagent: subagent([step(1)]) };
    expect(fitBody("subagent.updated", small).body).toBe(small);
  });

  it("a result or a prompt that is over a frame by itself is cut with a note, and the update still fits", () => {
    const huge = { botId: "alpha", subagent: subagent([step(1), step(2)], { result: "R".repeat(300_000), prompt: "go" }) };
    const fittedResult = fitBody("subagent.updated", huge);
    expect(fittedResult.dropped).toBe(false);
    expect(bytes(fittedResult.body)).toBeLessThanOrEqual(BODY_BYTES_LIMIT);
    expect((fittedResult.body.subagent as { result: string }).result).toContain("more characters are not shown");
    expect((fittedResult.body.subagent as { prompt: string }).prompt).toBe("go");
    const hugePrompt = { botId: "alpha", subagent: subagent([step(1)], { result: "done", prompt: "P".repeat(300_000) }) };
    const fittedPrompt = fitBody("subagent.updated", hugePrompt);
    expect(fittedPrompt.dropped).toBe(false);
    expect(bytes(fittedPrompt.body)).toBeLessThanOrEqual(BODY_BYTES_LIMIT);
    expect((fittedPrompt.body.subagent as { prompt: string }).prompt).toContain("more characters are not shown");
    expect((fittedPrompt.body.subagent as { result: string }).result).toBe("done");
  });

  it("steps with big pictures and a result near its limit still fit", () => {
    const images = Array.from({ length: 20 }, (_, i) => ({ url: "u".repeat(20_000), name: `n${i}` }));
    const heavy = Array.from({ length: 40 }, (_, i) => step(i, { images }));
    const view = { botId: "alpha", subagent: subagent(heavy, { result: "r".repeat(20_000), prompt: "p".repeat(20_000) }) };
    const fitted = fitBody("subagent.updated", view);
    expect(fitted.dropped).toBe(false);
    expect(bytes(fitted.body)).toBeLessThanOrEqual(BODY_BYTES_LIMIT);
  });
});

describe("fitBody: components over one frame lose the biggest templates first", () => {
  // smallest first: a cut that walks the record in its own order would lose these before the big ones
  const components = {
    tiny: info("t"),
    small: info("<b>s</b>"),
    mid: info("m".repeat(60_000)),
    large: info("l".repeat(120_000)),
    huge: info("h".repeat(200_000)),
  };

  it("is not dropped, fits, and the small components are still there", () => {
    const body = { components };
    expect(bytes(body)).toBeGreaterThan(BODY_BYTES_LIMIT);
    const fitted = fitBody("components.updated", body);
    expect(fitted.dropped).toBe(false);
    expect(bytes(fitted.body)).toBeLessThanOrEqual(BODY_BYTES_LIMIT);
    const left = fitted.body.components as Record<string, unknown>;
    expect(Object.keys(left)).toEqual(expect.arrayContaining(["small", "tiny", "mid"]));
    expect(left).not.toHaveProperty("huge");
    expect(left.small).toEqual(components.small);
    expect(Object.keys(components)).toHaveLength(5); // the caller's record is untouched
  });

  it("a record with many mid-size templates loses just enough of them, never more", () => {
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`c${String(i).padStart(2, "0")}`, info("x".repeat(30_000))]));
    const fitted = fitBody("components.updated", { components: many });
    expect(fitted.dropped).toBe(false);
    const left = Object.keys(fitted.body.components as object);
    expect(left.length).toBeGreaterThan(0);
    expect(left.length).toBeLessThan(12);
    const withOneMore = { components: Object.fromEntries(Object.entries(many).slice(0, left.length + 1)) };
    expect(bytes(withOneMore)).toBeGreaterThan(BODY_BYTES_LIMIT); // one fewer removed would not have fitted
  });

  it("removes only what it must: when dropping the biggest is enough, the next ones stay", () => {
    const fitted = fitBody("components.updated", { components });
    expect(fitted.body.components).toHaveProperty("large");
  });
});

describe("the event tap writes a burst of snapshots of one object once", () => {
  const stores: QuickStore[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const store of stores.splice(0)) await store.close();
  });

  function setup(options: Partial<EventTapOptions> = {}) {
    const store = quickStore();
    stores.push(store);
    const scope = new TxScope(store);
    const tap = new EventTap({ scope, serverEvents: "all", mirrorBotUpdates: true, ...options });
    return { store, scope, tap };
  }
  const botView = (id: string, overrides: Record<string, unknown> = {}) => ({
    id, name: `Bot ${id}`, role: "manager", avatar: "circle", folder: `/work/${id}`, phase: "awake", working: false,
    approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [], ...overrides,
  });
  const botUpdated = (id: string, overrides?: Record<string, unknown>) => ({ type: "bot.updated", bot: botView(id, overrides) }) as unknown as ContractEvent;
  const subagentUpdated = (botId: string, id: string, overrides: Record<string, unknown> = {}) =>
    ({ type: "subagent.updated", botId, subagent: subagent([], { id, ...overrides }) }) as unknown as ContractEvent;
  const stored = (store: QuickStore, stream: string, kind: string) =>
    readEntries(store.db, stream, 1, { maxEntries: 100_000, maxBytes: 1e12 }).entries.filter((entry) => entry.kind === kind);
  const srvStream = (store: QuickStore) => `srv:${String(store.db.prepare("SELECT value FROM meta WHERE key = 'serverId'").get()!.value)}`;
  const settleOnce = () => new Promise<void>((resolve) => setImmediate(resolve));
  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !check(); i += 1) await settleOnce();
  }

  it("bot.updated: three views of one bot before the write become one entry, the latest, in both streams", async () => {
    const { store, scope, tap } = setup();
    tap.event(botUpdated("alpha", { unread: 1 }));
    tap.event(botUpdated("beta", { unread: 7 }));
    tap.event(botUpdated("alpha", { unread: 2 }));
    tap.event(botUpdated("alpha", { unread: 3, working: true }));
    expect(tap.waiting).toBe(2);
    await scope.submit(() => undefined);
    const alpha = stored(store, "bot:alpha", "bot.updated");
    expect(alpha).toHaveLength(1);
    expect((alpha[0].body.bot as { unread: number; working: boolean })).toMatchObject({ unread: 3, working: true });
    expect(stored(store, "bot:beta", "bot.updated")).toHaveLength(1);
    expect(stored(store, srvStream(store), "bot.updated")).toHaveLength(2);
    expect(store.db.prepare("SELECT unread FROM bots WHERE botId = 'alpha'").get()!.unread).toBe(3);
    expect(verifyStream(store.db, "bot:alpha" as StreamId)).toMatchObject({ ok: true });
  });

  it("subagent.updated: the latest state of one sub-agent wins; another sub-agent, and another bot's, are kept", async () => {
    const { store, scope, tap } = setup();
    tap.event(subagentUpdated("alpha", "sa1", { status: "running" }));
    tap.event(subagentUpdated("alpha", "sa2", { status: "running" }));
    tap.event(subagentUpdated("beta", "sa1", { status: "running" }));
    tap.event(subagentUpdated("alpha", "sa1", { status: "completed" }));
    await scope.submit(() => undefined);
    const alpha = stored(store, "bot:alpha", "subagent.updated").map((entry) => {
      const view = entry.body.subagent as { id: string; status: string };
      return `${view.id}:${view.status}`;
    });
    // the newer state of sa1 takes the older one's place in the queue; sa2 keeps its own
    expect(alpha).toEqual(["sa1:completed", "sa2:running"]);
    expect(stored(store, "bot:beta", "subagent.updated")).toHaveLength(1);
  });

  it("events that are not snapshots are never replaced, and a snapshot is never written before an event that came earlier", async () => {
    const { store, scope, tap } = setup();
    const added = (id: string) => ({ type: "message.added", botId: "alpha", message: { id, role: "user", text: id, time: TIME } }) as unknown as ContractEvent;
    tap.event(added("m1"));
    tap.event(botUpdated("alpha", { unread: 1 }));
    tap.event(added("m2"));
    tap.event(botUpdated("alpha", { unread: 2 }));
    tap.event(botUpdated("alpha", { unread: 3 })); // only a snapshot of the same bot lies after the unread 2 one: it takes its place
    await scope.submit(() => undefined);
    const rows = readEntries(store.db, "bot:alpha", 1, { maxEntries: 100, maxBytes: 1e12 }).entries;
    const order = rows.map((entry) => entry.kind === "message.added" ? (entry.body.message as { id: string }).id : `bot${(entry.body.bot as { unread: number }).unread}`);
    expect(order).toEqual(["m1", "bot1", "m2", "bot3"]);
  });

  it("a snapshot that follows an event of another kind queues behind it, not into the older snapshot's place", async () => {
    const { store, scope, tap } = setup();
    tap.event(botUpdated("alpha", { unread: 1 }));
    tap.event({ type: "turn.started", botId: "alpha", turnId: "t1", messageId: "r1" } as unknown as ContractEvent);
    tap.event(botUpdated("alpha", { unread: 2, working: true }));
    expect(tap.waiting).toBe(3);
    await scope.submit(() => undefined);
    const rows = readEntries(store.db, "bot:alpha", 1, { maxEntries: 100, maxBytes: 1e12 }).entries.map((entry) => entry.kind);
    expect(rows).toEqual(["bot.updated", "turn.started", "bot.updated"]);
  });

  it("an oversized sub-agent update is stored cut instead of lost", async () => {
    const { store, scope, tap } = setup();
    const steps = Array.from({ length: 100 }, (_, i) => step(i));
    tap.event({ type: "subagent.updated", botId: "alpha", subagent: subagent(steps) } as unknown as ContractEvent);
    await scope.submit(() => undefined);
    const rows = stored(store, "bot:alpha", "subagent.updated");
    expect(rows).toHaveLength(1);
    const kept = (rows[0].body.subagent as { steps: Array<{ id: string }> }).steps;
    expect(kept.length).toBeLessThan(100);
    expect(kept.at(-1)!.id).toBe("s99");
  });

  describe("with a coalescing window", () => {
    it("snapshots wait alone for the window, then one entry with the latest state is written", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { store, tap } = setup({ coalesceMs: 200 });
      tap.event(botUpdated("alpha", { unread: 1 }));
      await vi.advanceTimersByTimeAsync(150);
      tap.event(botUpdated("alpha", { unread: 2 }));
      await vi.advanceTimersByTimeAsync(40);
      for (let i = 0; i < 20; i += 1) await settleOnce();
      expect(stored(store, "bot:alpha", "bot.updated")).toHaveLength(0);
      expect(tap.waiting).toBe(1);
      await vi.advanceTimersByTimeAsync(20);
      await until(() => stored(store, "bot:alpha", "bot.updated").length > 0);
      const rows = stored(store, "bot:alpha", "bot.updated");
      expect(rows).toHaveLength(1);
      expect((rows[0].body.bot as { unread: number }).unread).toBe(2);
      expect(tap.waiting).toBe(0);
    });

    it("an event that is not a snapshot writes everything at once, the waiting snapshot too", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { store, tap } = setup({ coalesceMs: 60_000 });
      tap.event(botUpdated("alpha", { unread: 4 }));
      expect(vi.getTimerCount()).toBe(1);
      tap.event({ type: "message.added", botId: "alpha", message: { id: "m1", role: "user", text: "hi", time: TIME } } as unknown as ContractEvent);
      expect(vi.getTimerCount()).toBe(0);
      await until(() => tap.waiting === 0 && stored(store, "bot:alpha", "message.added").length > 0);
      expect(stored(store, "bot:alpha", "message.added")).toHaveLength(1);
      expect((stored(store, "bot:alpha", "bot.updated")[0].body.bot as { unread: number }).unread).toBe(4);
    });

    it("a command that runs meanwhile writes the waiting snapshots at once and the timer is gone", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { store, scope, tap } = setup({ coalesceMs: 60_000 });
      tap.event(botUpdated("alpha", { unread: 5 }));
      expect(vi.getTimerCount()).toBe(1);
      await scope.submit(() => undefined);
      expect(stored(store, "bot:alpha", "bot.updated")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      // a later snapshot starts a new window
      tap.event(botUpdated("alpha", { unread: 6 }));
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await until(() => stored(store, "bot:alpha", "bot.updated").length === 2);
      expect(stored(store, "bot:alpha", "bot.updated")).toHaveLength(2);
    });

    it("after an urgent write a later snapshot waits for its own window again", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { store, tap } = setup({ coalesceMs: 60_000 });
      tap.event({ type: "message.added", botId: "alpha", message: { id: "m1", role: "user", text: "hi", time: TIME } } as unknown as ContractEvent);
      await until(() => tap.waiting === 0 && stored(store, "bot:alpha", "message.added").length > 0);
      tap.event(botUpdated("alpha", { unread: 9 }));
      expect(vi.getTimerCount()).toBe(1);
      for (let i = 0; i < 20; i += 1) await settleOnce();
      expect(stored(store, "bot:alpha", "bot.updated")).toHaveLength(0);
      expect(tap.waiting).toBe(1);
    });

    it("an urgent event after a waiting snapshot writes both at once, in order, and the timer is gone", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { store, tap } = setup({ coalesceMs: 60_000 });
      tap.event(botUpdated("alpha", { unread: 1 }));
      tap.event({ type: "turn.started", botId: "alpha", turnId: "t1", messageId: "r1" } as unknown as ContractEvent);
      await until(() => tap.waiting === 0);
      const kinds = readEntries(store.db, "bot:alpha", 1, { maxEntries: 100, maxBytes: 1e12 }).entries.map((entry) => entry.kind);
      expect(kinds).toEqual(["bot.updated", "turn.started"]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("IntentRuntime passes coalesceMs to its tap", async () => {
      const { writer } = memoryStore();
      const live = new LiveChannel({ sink: effectCheckpointSink(writer), checkpointIntervalMs: 5 });
      const engine = new FakeTurnEngine();
      const runtime = new IntentRuntime({ store: writer, engine, live, log: () => undefined, coalesceMs: 60_000 });
      try {
        // no start(): its worker would run commands of its own, and a command writes what waits
        runtime.tap.event(botUpdated("alpha", { unread: 1 }));
        for (let i = 0; i < 20; i += 1) await settleOnce();
        expect(runtime.tap.waiting).toBe(1); // still inside its window
        await runtime.scope.submit(() => undefined);
        expect(runtime.tap.waiting).toBe(0);
      } finally {
        runtime.close();
        engine.close();
        live.close();
      }
    });

    it("a held tap keeps the snapshot until released, then the window applies", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { store, tap } = setup({ coalesceMs: 100 });
      const release = tap.hold();
      tap.event(botUpdated("alpha", { unread: 1 }));
      expect(vi.getTimerCount()).toBe(0);
      release();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      await until(() => stored(store, "bot:alpha", "bot.updated").length === 1);
      expect(stored(store, "bot:alpha", "bot.updated")).toHaveLength(1);
    });
  });
});
