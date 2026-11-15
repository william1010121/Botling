// M7-S83: characterization of the run life-cycle half of WorkerCore (launch, begin, ended, the queued start, the
// slot limit, the report port callbacks). Written on the base commit, before the half moved to worker-core/lives.ts;
// it reads only the shared output (items, saved records, adapter and port calls), so it holds on both sides of the move.
import { describe, expect, it } from "vitest";
import type { CodexItem } from "../../src/core/agent/codex";
import {
  WorkerCore, type CoordinatorPort, type RecoverResult, type RunHandle, type WorkerAdapter, type WorkerAdapterKind, type WorkerCoreOptions, type WorkerEvent,
  type WorkerLedgerRecord, type WorkerReport, type WorkerStore,
} from "../../src/core/worker-core";

const normal = (finalText: string | null = null): WorkerEvent => ({ type: "end", end: { how: "normal", finalText, error: null, detail: "success" } });

class MemoryStore implements WorkerStore {
  records: WorkerLedgerRecord[] = [];
  load() { return structuredClone(this.records); }
  save(records: readonly WorkerLedgerRecord[]) { this.records = structuredClone([...records]); }
  get(id: string) { return this.records.find((r) => r.id === id)!; }
}

class FakeAdapter implements WorkerAdapter {
  handles = new Map<string, RunHandle>();
  started: { id: string; run: number; words: string }[] = [];
  failStart: string | null = null;
  recovery: RecoverResult = { state: "clean" };
  onStart?: (handle: RunHandle, record: Readonly<WorkerLedgerRecord>) => void | Promise<void>;
  constructor(readonly kind: WorkerAdapterKind = "claude-process", readonly engine: "claude" | "codex" | "agy" = "claude", readonly steersRunning = true) {}
  start(record: Readonly<WorkerLedgerRecord>, words: string, run: RunHandle) {
    if (this.failStart) throw new Error(this.failStart);
    this.started.push({ id: record.id, run: run.run, words });
    this.handles.set(record.id, run);
    return this.onStart?.(run, record);
  }
  steer() { return true; }
  async stop() { return { cleaned: true }; }
  answer() {}
  recover() { return this.recovery; }
  async close() {}
  emit(id: string, ...events: WorkerEvent[]) { for (const event of events) this.handles.get(id)!.emit(event); }
}

class FakePort implements CoordinatorPort {
  delivered: { report: WorkerReport; text: string }[] = [];
  answer: "taken" | "queued" | "busy" = "taken";
  constructor(readonly ack: "none" | "checkpoint" = "none") {}
  deliver(report: WorkerReport, text: string) { this.delivered.push({ report, text }); return this.answer; }
}

let n = 0;
function setup(over: Partial<WorkerCoreOptions> & { adapter?: FakeAdapter; port?: FakePort } = {}) {
  const adapter = over.adapter ?? new FakeAdapter();
  const port = over.port ?? new FakePort();
  const store = new MemoryStore();
  const items: CodexItem[] = [];
  const core = new WorkerCore({
    store, port, sink: { item: (item) => items.push(item) }, adapters: [adapter], ownerSessionId: () => "coord-session", log: () => {},
    newId: () => `1000000${n % 10}-0000-4000-8000-${String(++n).padStart(12, "0")}`, now: () => 1000, processStartTime: () => "start-time",
    ...over,
  });
  return { core, adapter, port, store, items };
}
const texts = (items: CodexItem[], parent: string) => items.filter((i) => i.kind === "subagentText" && i.parent === parent).map((i: any) => i.text as string);

describe("launch and begin", () => {
  it("a handoff starts run 1 at once: the record is running, the adapter started, the opening items are out", async () => {
    const { core, adapter, store, items } = setup();
    const { task_id, run } = await core.handoff("claude-process", { instructions: "Go", name: "One" });
    expect(run).toBe(1);
    expect(adapter.started).toEqual([{ id: task_id, run: 1, words: "Go" }]);
    expect(store.get(task_id)).toMatchObject({ status: "running", run: 1, report: { state: "none", attempts: 0 } });
    expect(items.map((i) => i.kind)).toEqual(["toolUse", "subagentStarted", "subagentRuntime"]);
    expect(core.running).toEqual([task_id]);
  });

  it("a start the adapter refuses is undone: the new worker is forgotten, a follow-up goes back to its last state", async () => {
    const { core, adapter, store } = setup();
    adapter.failStart = "No start now.";
    await expect(core.handoff("claude-process", { instructions: "x" })).rejects.toThrow("No start now.");
    expect(store.records).toEqual([]);
    adapter.failStart = null;
    const { task_id } = await core.handoff("claude-process", { instructions: "y" });
    adapter.emit(task_id, normal("DONE"));
    const before = structuredClone(store.get(task_id));
    adapter.failStart = "Still no.";
    expect(await core.sendToWorker(task_id, "again")).toMatchObject({ ok: false, reason: "Still no." });
    expect(store.get(task_id)).toEqual(before);
  });

  it("events an asynchronous start emits meanwhile are held until it returns, after the opening items", async () => {
    const adapter = new FakeAdapter();
    let release!: () => void;
    adapter.onStart = (handle) => {
      handle.emit({ type: "textWhole", text: "early", phase: null });
      return new Promise<void>((resolve) => { release = resolve; });
    };
    const { core, items } = setup({ adapter });
    const pending = core.handoff("claude-process", { instructions: "Go" });
    await Promise.resolve();
    expect(items).toEqual([]);
    release();
    const { task_id } = await pending;
    expect(items.map((i) => i.kind)).toEqual(["toolUse", "subagentStarted", "subagentRuntime", "subagentText"]);
    expect(texts(items, task_id)).toEqual(["early"]);
  });

  it("a follow-up after the end is run 2, with the report cleared and the first run's events dropped", async () => {
    const { core, adapter, store } = setup();
    const { task_id } = await core.handoff("claude-process", { instructions: "Go" });
    adapter.emit(task_id, normal("first"));
    expect(store.get(task_id)).toMatchObject({ status: "done", run: 1 });
    expect(await core.sendToWorker(task_id, "next")).toEqual({ ok: true, how: "newRun", run: 2 });
    expect(adapter.started.map((s) => [s.run, s.words])).toEqual([[1, "Go"], [2, "next"]]);
    expect(store.get(task_id)).toMatchObject({ status: "running", run: 2, report: { state: "none", text: null } });
  });
});

describe("ended", () => {
  it("classifies the end once: status, report, subagentEnded, one delivery; later events are dropped", async () => {
    const { core, adapter, port, store, items } = setup();
    const { task_id } = await core.handoff("claude-process", { instructions: "Go" });
    adapter.emit(task_id, { type: "textWhole", text: "All done.", phase: null }, normal());
    adapter.emit(task_id, { type: "textWhole", text: "after the end", phase: null });
    expect(store.get(task_id)).toMatchObject({ status: "done", report: { state: "acknowledged", status: "done", attempts: 1 } });
    expect(items.filter((i) => i.kind === "subagentEnded")).toEqual([{ kind: "subagentEnded", id: task_id, status: "completed", summary: "All done." }]);
    expect(texts(items, task_id)).not.toContain("after the end");
    expect(port.delivered).toHaveLength(1);
    expect(port.delivered[0]!.report).toMatchObject({ id: task_id, run: 1, status: "done", text: "All done." });
  });

  it("an adapter cleanup holds the report back until it has finished", async () => {
    const adapter = new FakeAdapter();
    let finish!: () => void;
    (adapter as WorkerAdapter).cleanup = () => new Promise((resolve) => { finish = () => resolve({ cleaned: true }); });
    const { core, port, store } = setup({ adapter });
    const { task_id } = await core.handoff("claude-process", { instructions: "Go" });
    adapter.emit(task_id, normal("fin"));
    expect(store.get(task_id)).toMatchObject({ status: "done", cleanup: "pending" });
    expect(port.delivered).toEqual([]);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get(task_id).cleanup).toBeUndefined();
    expect(port.delivered).toHaveLength(1);
  });
});

describe("queued start and the limit", () => {
  it("at the limit a second worker waits (shown at work with a line saying so) and starts when the first ends", async () => {
    const { core, adapter, store, items } = setup({ maxRunning: () => 1 });
    const { task_id: a } = await core.handoff("claude-process", { instructions: "A" });
    const { task_id: b } = await core.handoff("claude-process", { instructions: "B" });
    expect(adapter.started.map((s) => s.id)).toEqual([a]);
    expect(store.get(b)).toMatchObject({ status: "running", run: 1 });
    expect(texts(items, b)).toEqual(["Waiting for a free worker slot (1 at work at once); it starts when another worker finishes."]);
    expect(core.running).toEqual([a, b]);
    adapter.emit(a, normal("a done"));
    expect(adapter.started.map((s) => [s.id, s.words])).toEqual([[a, "A"], [b, "B"]]);
  });

  it("words sent to a waiting worker join the run it starts with", async () => {
    const { core, adapter } = setup({ maxRunning: () => 1 });
    const { task_id: a } = await core.handoff("claude-process", { instructions: "A" });
    const { task_id: b } = await core.handoff("claude-process", { instructions: "B" });
    expect(await core.sendToWorker(b, "and more")).toEqual({ ok: true, how: "steered", run: 1 });
    adapter.emit(a, normal());
    expect(adapter.started.at(-1)).toEqual({ id: b, run: 1, words: "B\n\nand more" });
  });

  it("raising the limit (slotsChanged) starts the waiting ones in order; a bad limit means no limit", async () => {
    let limit = 1;
    const { core, adapter } = setup({ maxRunning: () => limit });
    await core.handoff("claude-process", { instructions: "A" });
    const { task_id: b } = await core.handoff("claude-process", { instructions: "B" });
    const { task_id: c } = await core.handoff("claude-process", { instructions: "C" });
    expect(adapter.started).toHaveLength(1);
    limit = 2;
    core.slotsChanged();
    expect(adapter.started.map((s) => s.id).slice(1)).toEqual([b]);
    limit = Number.NaN;
    core.slotsChanged();
    expect(adapter.started.map((s) => s.id).slice(2)).toEqual([c]);
  });

  it("stopping a waiting worker never starts it", async () => {
    const { core, adapter, store } = setup({ maxRunning: () => 1 });
    const { task_id: a } = await core.handoff("claude-process", { instructions: "A" });
    const { task_id: b } = await core.handoff("claude-process", { instructions: "B" });
    expect(await core.stopWorker(b)).toBe(true);
    expect(store.get(b).status).toBe("stopped");
    adapter.emit(a, normal());
    expect(adapter.started.map((s) => s.id)).toEqual([a]);
  });
});

describe("report port callbacks", () => {
  it("a queued report is not handed over again by redeliver until its turn begins; two turns without a decision leave it unresolved", async () => {
    const port = new FakePort("checkpoint");
    port.answer = "queued";
    const { core, adapter, store, items } = setup({ port });
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    adapter.emit(id, normal("fin"));
    expect(port.delivered).toHaveLength(1);
    core.redeliver();
    expect(port.delivered).toHaveLength(1);
    expect(core.hostedLive).toEqual([id]);
    expect(core.beginReport(id, 1)).toBe(true);
    expect(store.get(id).report.state).toBe("dispatching");
    expect(core.beginReport(id, 1)).toBe(false);
    port.answer = "busy";
    core.finishReport(id, 1, true);
    expect(store.get(id).report).toMatchObject({ state: "pending", attempts: 1 });
    expect(core.beginReport(id, 1)).toBe(true);
    core.finishReport(id, 1, true);
    expect(store.get(id).report).toMatchObject({ state: "unresolved", attempts: 2 });
    expect(items.filter((i) => i.kind === "subagentEnded").at(-1)).toMatchObject({ id, status: "failed" });
    expect(core.hostedLive).toEqual([]);
  });

  it("a report turn that did not complete leaves the hand-over uncertain; retryUncertain counts it as an attempt", async () => {
    const port = new FakePort("checkpoint");
    port.answer = "queued";
    const { core, adapter, store } = setup({ port });
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    adapter.emit(id, normal("fin"));
    expect(core.beginReport(id, 1)).toBe(true);
    core.finishReport(id, 1, false);
    expect(store.get(id).report).toMatchObject({ state: "dispatching", attempts: 0 });
    expect(core.retryUncertain(id, 1)).toBe(true);
    expect(store.get(id).report).toMatchObject({ state: "pending", attempts: 1 });
    expect(core.retryUncertain(id, 1)).toBe(false);
  });

  it("completionDependencies lists a run under way and a report not yet shown, nothing once it is decided", async () => {
    const port = new FakePort("checkpoint");
    port.answer = "queued";
    const { core, adapter } = setup({ port });
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    expect(core.completionDependencies).toMatchObject([{ id, run: 1, state: "running" }]);
    adapter.emit(id, normal("fin"));
    expect(core.completionDependencies).toMatchObject([{ id, run: 1, state: "reportQueued", outcome: "completed" }]);
    core.beginReport(id, 1);
    core.checkpoint({ task_id: id, run: 1, outcome: "complete", evidence: "seen" });
    expect(core.completionDependencies).toEqual([]);
  });
});
