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
import { quickStore, type QuickStore } from "./server-log-helpers";

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
  const components = {
    huge: info("h".repeat(200_000)),
    large: info("l".repeat(120_000)),
    mid: info("m".repeat(60_000)),
    small: info("<b>s</b>"),
    tiny: info("t"),
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
    expect(alpha).toEqual(["sa2:running", "sa1:completed"]);
    expect(stored(store, "bot:beta", "subagent.updated")).toHaveLength(1);
  });

  it("events that are not snapshots are never replaced, and keep their order around a snapshot", async () => {
    const { store, scope, tap } = setup();
    const added = (id: string) => ({ type: "message.added", botId: "alpha", message: { id, role: "user", text: id, time: TIME } }) as unknown as ContractEvent;
    tap.event(added("m1"));
    tap.event(botUpdated("alpha", { unread: 1 }));
    tap.event(added("m2"));
    tap.event(botUpdated("alpha", { unread: 2 }));
    await scope.submit(() => undefined);
    const kinds = readEntries(store.db, "bot:alpha", 1, { maxEntries: 100, maxBytes: 1e12 }).entries.map((entry) => entry.kind);
    expect(kinds.filter((kind) => kind === "message.added")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "bot.updated")).toHaveLength(1);
    expect(kinds.indexOf("message.added")).toBeLessThan(kinds.indexOf("bot.updated"));
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
