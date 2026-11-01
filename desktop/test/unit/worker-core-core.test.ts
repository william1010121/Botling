// WorkerCore (shared-core spec 2.6, 3.3): the one state machine and report delivery, driven through a fake adapter
// and a fake coordinator port, with an in-memory store. Every assertion reads only the shared output: the items the
// core emits, the records it saves and the reports it hands over.
import { describe, expect, it } from "vitest";
import type { CodexItem } from "../../src/core/agent/codex";
import { isWorkerHost } from "../../src/core/agent/workers";
import {
  agentState, chipStatus, CLEANUP_FAILED_NOTE, RunPipeline, INTERRUPTED_REPORT, NO_REPORT, REPORT_TAIL, stepFailed, subagentStatus, UNRESOLVED_REPORT, WorkerCore, workerState,
  type CoordinatorPort, type RecoverResult, type RunHandle, type WorkerAdapter, type WorkerAdapterKind, type WorkerCoreOptions, type WorkerEvent,
  type WorkerLedgerRecord, type WorkerReport, type WorkerStore,
} from "../../src/core/worker-core";

const tokens = (output: number) => ({ input: 1, output, cacheRead: 0, cacheWrite: 0 });
const normal = (finalText: string | null = null): WorkerEvent => ({ type: "end", end: { how: "normal", finalText, error: null, detail: "success" } });

class MemoryStore implements WorkerStore {
  saves = 0;
  constructor(public records: WorkerLedgerRecord[] = []) {}
  load() { return structuredClone(this.records); }
  save(records: readonly WorkerLedgerRecord[]) { this.saves += 1; this.records = structuredClone([...records]); }
  get(id: string) { return this.records.find((r) => r.id === id)!; }
}

class FakeAdapter implements WorkerAdapter {
  handles = new Map<string, RunHandle>();
  started: { id: string; run: number; words: string }[] = [];
  steered: string[] = [];
  stopped: string[] = [];
  answers: { nativeId: string; allow: boolean; input: Record<string, unknown> }[] = [];
  closed = false;
  failStart: string | null = null;
  steers = true;
  recovery: RecoverResult = { state: "clean" };
  onStart?: (handle: RunHandle, record: Readonly<WorkerLedgerRecord>) => void | Promise<void>;
  cleanup?: (record: Readonly<WorkerLedgerRecord>) => Promise<{ cleaned: boolean }>;
  prepare?: WorkerAdapter["prepare"];
  constructor(readonly kind: WorkerAdapterKind = "claude-process", readonly engine: "claude" | "codex" | "agy" = "claude", readonly steersRunning = true) {}
  start(record: Readonly<WorkerLedgerRecord>, words: string, run: RunHandle) {
    if (this.failStart) throw new Error(this.failStart);
    this.started.push({ id: record.id, run: run.run, words });
    this.handles.set(record.id, run);
    return this.onStart?.(run, record);
  }
  steer(_record: Readonly<WorkerLedgerRecord>, words: string) { this.steered.push(words); return this.steers; }
  async stop(record: Readonly<WorkerLedgerRecord>) { this.stopped.push(record.id); return { cleaned: true }; }
  answer(_record: Readonly<WorkerLedgerRecord>, nativeId: string, allow: boolean, input: Record<string, unknown>) { this.answers.push({ nativeId, allow, input }); }
  recover() { return this.recovery; }
  async close() { this.closed = true; }
  emit(id: string, ...events: WorkerEvent[]) { for (const event of events) this.handles.get(id)!.emit(event); }
}

class FakePort implements CoordinatorPort {
  delivered: { report: WorkerReport; text: string }[] = [];
  answer: "taken" | "queued" | "busy" = "taken";
  constructor(readonly ack: "none" | "checkpoint" = "none") {}
  deliver(report: WorkerReport, text: string) { this.delivered.push({ report, text }); return this.answer; }
}

let ids = 0;
function setup(over: Partial<WorkerCoreOptions> & { adapter?: FakeAdapter; port?: FakePort; store?: MemoryStore } = {}) {
  const adapter = over.adapter ?? new FakeAdapter();
  const port = over.port ?? new FakePort();
  const store = over.store ?? new MemoryStore();
  const items: CodexItem[] = [];
  const logs: string[] = [];
  let n = 0;
  const core = new WorkerCore({
    store, port, sink: { item: (item) => items.push(item) }, adapters: [adapter], ownerSessionId: () => "coord-session", log: (line) => logs.push(line),
    newId: () => `0000000${ids % 10}-0000-4000-8000-${String(++n).padStart(12, "0")}`, now: () => 1000, processStartTime: () => "start-time", parentThreadId: () => "coord-thread",
    ...over,
  });
  ids += 1;
  const kinds = (kind: string) => items.filter((item) => item.kind === kind) as any[];
  return { core, adapter, port, store, items, logs, kinds };
}

describe("a run: handoff → events → end → report", () => {
  it("opens the run with the shared items and records it running", async () => {
    const { core, adapter, store, items } = setup();
    const { task_id, run } = await core.handoff("claude-process", { prompt: "Fix the bug.", description: "Fixer" });
    expect(run).toBe(1);
    expect(adapter.started).toEqual([{ id: task_id, run: 1, words: "Fix the bug." }]);
    expect(items.map((item) => item.kind)).toEqual(["toolUse", "subagentStarted", "subagentRuntime"]);
    expect(items[1]).toMatchObject({ id: task_id, description: "Fixer", type: "claude-worker", background: true, execution: { run: 1, ownerSessionId: "coord-session" } });
    expect(store.get(task_id)).toMatchObject({ status: "running", run: 1, name: "Fixer", instructions: "Fix the bug.", ownerSessionId: "coord-session", report: { state: "none" } });
    expect(core.listWorkers()).toEqual([{ id: task_id, engine: "claude", name: "Fixer", run: 1, state: "running", conversationId: null, processes: [], owner: null }]);
    expect(isWorkerHost(core)).toBe(true);
  });

  it("refuses a handoff without instructions, or one the adapter refuses, with nothing recorded or emitted", async () => {
    const { core, adapter, store, items } = setup();
    await expect(core.handoff("claude-process", { name: "x" })).rejects.toThrow(/instructions required/);
    adapter.prepare = () => { throw new Error("No agent definition named \"nope\"."); };
    await expect(core.handoff("claude-process", { instructions: "x", subagent_type: "nope" })).rejects.toThrow(/nope/);
    adapter.prepare = undefined;
    adapter.failStart = "Workers cannot start now.";
    await expect(core.handoff("claude-process", { instructions: "x" })).rejects.toThrow("Workers cannot start now.");
    expect(store.records).toEqual([]);
    expect(items).toEqual([]);
    expect(core.listWorkers()).toEqual([]);
  });

  it("prepare's engine data and engine go on the record", async () => {
    const adapter = new FakeAdapter("agy-acp", "agy", false);
    adapter.prepare = (request) => ({ engine: request.engine === "codex" ? "codex" : undefined, engineData: { model: request.model } });
    const { core, store } = setup({ adapter });
    const { task_id } = await core.handoff("agy-acp", { task: "Go", engine: "codex", model: "gpt" });
    expect(store.get(task_id)).toMatchObject({ engine: "codex", engineData: { model: "gpt" } });
  });

  it("digests the run once: blocks as steps, scoped tool ids, one counter, scoped speed and measurements", async () => {
    const { core, adapter, items } = setup();
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    items.length = 0;
    adapter.emit(id,
      { type: "session", conversationId: "conv-1" },
      { type: "textDelta", text: "Look" }, { type: "textDelta", text: "ing." },
      { type: "toolUse", id: "t1", tool: "Bash", title: "Run git status", detail: "git status", input: { command: "git status" } },
      { type: "toolResult", id: "t1", output: "fatal: not a git repository", failed: true },
      { type: "usage", tokens: tokens(40), cost: 0.2 },
      { type: "request", request: { id: "r1", sample: { tokens: 40, seconds: 2 } } as any },
      { type: "permissionDenied", toolUseId: "t1", tool: "Bash", reason: "no", confirmed: true },
      { type: "connectionLost" },
      { type: "textWhole", text: "DONE — git failed as expected.", phase: null },
      { type: "usage", tokens: tokens(10), cost: 0.05 },
      normal(),
      { type: "textWhole", text: "after the end", phase: null },
    );
    expect(items).toEqual([
      { kind: "subagentText", parent: id, text: "Looking." },
      { kind: "toolUse", id: `${id}:1:t1`, tool: "Bash", title: "Run git status", detail: "git status", parent: id, input: { command: "git status" } },
      { kind: "toolResult", id: `${id}:1:t1`, output: "fatal: not a git repository", failed: true, parent: id, launch: null },
      { kind: "usage", totalCost: 0.2, tokens: tokens(40) },
      { kind: "subagentOutput", id, counter: "thread:conv-1:run1", tokens: 40 },
      { kind: "request", request: { id: "r1", sample: { tokens: 40, seconds: 2 }, scope: id } },
      { kind: "permissionDenied", toolUseId: `${id}:1:t1`, tool: "Bash", reason: "no", confirmed: true },
      { kind: "connectionLost", parent: id },
      { kind: "subagentText", parent: id, text: "DONE — git failed as expected." },
      { kind: "usage", totalCost: 0.05, tokens: tokens(10) },
      { kind: "subagentOutput", id, counter: "thread:conv-1:run1", tokens: 50 },
      { kind: "subagentEnded", id, status: "completed", summary: "DONE — git failed as expected." },
    ]);
  });

  it("a normal end with a reply after a failed tool is done; the report goes to the coordinator (ack none: settled)", async () => {
    const { core, adapter, port, store } = setup();
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    adapter.emit(id, { type: "toolResult", id: "t", output: "x", failed: true }, normal("DONE"));
    expect(store.get(id)).toMatchObject({ status: "done", endedAt: 1000, report: { state: "acknowledged", text: "DONE", status: "done", attempts: 1 } });
    expect(port.delivered).toHaveLength(1);
    expect(port.delivered[0]!.text).toBe(`<app_task_result task_id="${id}" run="1" engine="claude" status="completed">\nDONE\n</app_task_result>\n${REPORT_TAIL.none}`);
    expect(core.listWorkers()[0]!.state).toBe("idle");
  });

  it("an empty reply fails with the missing-report words; a process exit fails with its stderr; an engine cancel is stopped but still reported", async () => {
    const { core, adapter, store, kinds } = setup();
    const a = (await core.handoff("claude-process", { instructions: "a" })).task_id;
    adapter.emit(a, { type: "textDelta", text: "  " }, normal());
    expect(store.get(a)).toMatchObject({ status: "failed", report: { text: NO_REPORT, status: "failed" } });
    const b = (await core.handoff("claude-process", { instructions: "b" })).task_id;
    adapter.emit(b, { type: "end", end: { how: "exited", finalText: null, error: "exit 137\nKilled", detail: "" } });
    expect(store.get(b)).toMatchObject({ status: "failed", report: { text: "exit 137\nKilled", state: "acknowledged" } });
    const c = (await core.handoff("claude-process", { instructions: "c" })).task_id;
    adapter.emit(c, { type: "end", end: { how: "cancelled", finalText: null, error: null, detail: "cancelled" } });
    expect(store.get(c)).toMatchObject({ status: "stopped", report: { text: "Cancelled.", status: "stopped", state: "acknowledged" } });
    expect(kinds("subagentEnded").map((e) => e.status)).toEqual(["failed", "failed", "stopped"]);
  });

  it("saves at state transitions only, not for text or usage", async () => {
    const { core, adapter, store } = setup();
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    const before = store.saves;
    adapter.emit(id, { type: "textDelta", text: "x" }, { type: "usage", tokens: tokens(5), cost: 0 }, { type: "toolUse", id: "t", tool: "Read", title: "", detail: "", input: {} });
    expect(store.saves).toBe(before);
    adapter.emit(id, { type: "session", conversationId: "c" });
    expect(store.saves).toBe(before + 1);
  });

  it("events an adapter emits while starting follow the opening items; its session shows in them", async () => {
    const adapter = new FakeAdapter();
    adapter.onStart = (handle) => {
      handle.emit({ type: "session", conversationId: "sess-1" });
      handle.emit({ type: "process", pid: 77 });
      handle.emit({ type: "textDelta", text: "hi" });
      handle.emit({ type: "textBreak" });
    };
    const { core, items, store } = setup({ adapter });
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    expect(items.map((item) => item.kind)).toEqual(["toolUse", "subagentStarted", "subagentRuntime", "subagentText"]);
    expect(items[1]).toMatchObject({ execution: { threadId: "sess-1" } });
    expect(store.get(id)).toMatchObject({ conversationId: "sess-1", processes: [{ pid: 77, started: "start-time" }] });
  });

  it("an async start holds events until it resolves", async () => {
    const adapter = new FakeAdapter("codex-thread", "codex");
    let release!: () => void;
    adapter.onStart = (handle) => new Promise<void>((resolve) => { handle.emit({ type: "session", conversationId: "thread-9" }); release = resolve; });
    const { core, items } = setup({ adapter });
    const pending = core.handoff("codex-thread", { instructions: "Go" });
    await Promise.resolve();
    expect(items).toEqual([]);
    release();
    const { task_id } = await pending;
    expect(items[1]).toMatchObject({ id: task_id, type: "codex-worker", execution: { threadId: "thread-9" } });
  });

  it("setEngineData persists engine-only data while the run is current", async () => {
    const { core, adapter, store } = setup();
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    adapter.handles.get(id)!.setEngineData({ turn: "turn-1" });
    expect(store.get(id).engineData).toEqual({ turn: "turn-1" });
  });
});

describe("stop, quit and restart", () => {
  it("stopWorker: stopped, no report, approvals cancelled, adapter stopped, later events dropped", async () => {
    const { core, adapter, port, store, items, kinds } = setup();
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    adapter.emit(id, { type: "permission", nativeId: "p1", tool: "Bash", summary: "rm", input: {} }, { type: "textDelta", text: "half a thought" });
    expect(await core.stopWorker(id)).toBe(true);
    expect(store.get(id)).toMatchObject({ status: "stopped", report: { state: "none", text: "Stopped by the app; its work was not finished.", status: "stopped" } });
    expect(kinds("permissionCancelled")).toEqual([{ kind: "permissionCancelled", requestId: `worker:${id}:1:p1` }]);
    expect(kinds("subagentEnded")).toEqual([{ kind: "subagentEnded", id, status: "stopped", summary: "Stopped by the app; its work was not finished." }]);
    expect(adapter.stopped).toEqual([id]);
    const count = items.length;
    adapter.emit(id, { type: "textWhole", text: "late", phase: null }, normal("late"));
    expect(items.length).toBe(count);
    expect(port.delivered).toEqual([]);
    expect(await core.stopWorker(id)).toBe(false);
  });

  it("close (quit): interrupted with the quit sentence, recovery required, events say interrupted, adapters closed", async () => {
    const { core, adapter, store, kinds } = setup();
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    await core.close();
    expect(store.get(id)).toMatchObject({ status: "interrupted", interruptedBy: "quit", recovery: "required", report: { state: "none", text: INTERRUPTED_REPORT.quit } });
    expect(kinds("subagentEnded")).toEqual([{ kind: "subagentEnded", id, status: "interrupted", summary: INTERRUPTED_REPORT.quit }]);
    expect(adapter.closed).toBe(true);
    expect(await core.sendToWorker(id, "more")).toEqual({ ok: false, reason: "No such worker." });
  });

  it("a record still running at load was interrupted: by a restart if the journal lists it, else a crash", () => {
    const base = (id: string): WorkerLedgerRecord => ({ v: 3, id, engine: "claude", adapter: "claude-process", name: "n", instructions: "i", type: null, ownerSessionId: "s", run: 2, status: "running",
      report: { state: "none", text: null, status: null, attempts: 0 }, conversationId: "c", processes: [], createdAt: 0, runStartedAt: 5, endedAt: null, engineData: {} });
    const store = new MemoryStore([base("a"), base("b")]);
    const { core } = setup({ store, restarted: () => new Set(["a"]) });
    expect(store.get("a")).toMatchObject({ status: "interrupted", interruptedBy: "restart", recovery: "required", report: { text: INTERRUPTED_REPORT.restart } });
    expect(store.get("b")).toMatchObject({ status: "interrupted", interruptedBy: "crash", recovery: "required", report: { text: INTERRUPTED_REPORT.crash } });
    expect(core.listWorkers().map((w) => w.state)).toEqual(["interrupted", "interrupted"]);
  });

  it("a follow-up after an interruption waits for recovery; then the same conversation, no replay of the instructions", async () => {
    const { core, adapter, store } = setup();
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Original task" });
    adapter.emit(id, { type: "session", conversationId: "conv-7" });
    await core.close();
    const reopened = setup({ adapter, store });
    adapter.recovery = { state: "blocked", reason: "Its earlier process is still running." };
    expect(await reopened.core.sendToWorker(id, "Continue")).toEqual({ ok: false, reason: "Its earlier process is still running." });
    adapter.recovery = { state: "clean" };
    expect(await reopened.core.sendToWorker(id, "Continue")).toEqual({ ok: true, how: "newRun", run: 2 });
    expect(adapter.started.at(-1)).toEqual({ id, run: 2, words: "Continue" });
    expect(store.get(id)).toMatchObject({ status: "running", run: 2, conversationId: "conv-7" });
    expect(store.get(id).recovery).toBeUndefined();
    expect(store.get(id).interruptedBy).toBeUndefined();
  });
});

describe("follow-ups and steering", () => {
  it("a running worker of a steering engine takes words into its run: same run, one end", async () => {
    const { core, adapter, kinds } = setup();
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    expect(await core.sendToWorker(id, "Also check docs")).toEqual({ ok: true, how: "steered", run: 1 });
    expect(adapter.steered).toEqual(["Also check docs"]);
    adapter.steers = false;
    expect(await core.sendToWorker(id, "again")).toMatchObject({ ok: false, busy: true });
    adapter.emit(id, normal("DONE"), normal("again"));
    expect(kinds("subagentEnded")).toHaveLength(1);
  });

  it("a running ACP worker takes no words until it reports", async () => {
    const adapter = new FakeAdapter("agy-acp", "agy", false);
    const { core } = setup({ adapter });
    const { task_id: id } = await core.handoff("agy-acp", { instructions: "Go" });
    expect(await core.sendToWorker(id, "more")).toEqual({ ok: false, busy: true, reason: "This Antigravity worker is at work and takes no messages until it reports." });
  });

  it("an ended worker's follow-up is its next run", async () => {
    const { core, adapter, store } = setup();
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    adapter.emit(id, normal("DONE"));
    expect(await core.sendToWorker(id, "Next")).toEqual({ ok: true, how: "newRun", run: 2 });
    expect(store.get(id)).toMatchObject({ status: "running", run: 2, report: { state: "none", text: null } });
    adapter.failStart = "cannot start";
    adapter.emit(id, normal("DONE 2"));
    expect(await core.sendToWorker(id, "Third")).toEqual({ ok: false, reason: "cannot start" });
    expect(store.get(id)).toMatchObject({ status: "done", run: 2, report: { text: "DONE 2" } });
  });

  it("app_send_message and app_cancel_task through the core", async () => {
    const { core, adapter, store } = setup();
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    await expect(core.message({ task_id: id, message: "more" })).resolves.toEqual({ task_id: id, run: 1, status: "steered" });
    await expect(core.message({ task_id: id, run: 3, message: "x" })).rejects.toThrow("Stale run: this worker is on run 1.");
    await expect(core.message({ task_id: "nope", message: "x" })).rejects.toThrow(/Unknown task_id/);
    await expect(core.cancel(id)).resolves.toEqual({ status: "stopped" });
    expect(store.get(id).status).toBe("stopped");
    await expect(core.message({ task_id: id, message: "again" })).resolves.toEqual({ task_id: id, run: 2, status: "accepted" });
    adapter.emit(id, normal("DONE"));
    await expect(core.cancel(id)).resolves.toEqual({ status: "done" });
    expect(adapter.stopped).toEqual([id, id]);
  });
});

describe("approvals", () => {
  it("worker:<task>:<run>:<native> ids; the answer reaches the adapter once; a denial notes the report but does not fail it (D2)", async () => {
    const { core, adapter, store, kinds } = setup();
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    adapter.emit(id, { type: "permission", nativeId: "req-1", tool: "Bash", summary: "rm -rf build", input: { command: "rm -rf build" }, safetyCheck: "danger" });
    expect(kinds("permission")).toEqual([{ kind: "permission", requestId: `worker:${id}:1:req-1`, tool: "Bash", summary: "rm -rf build", input: { command: "rm -rf build" }, workerId: id, safetyCheck: "danger" }]);
    expect(core.answer(`worker:${id}:1:req-1`, false, { command: "rm -rf build" }, "No")).toBe(true);
    expect(core.answer(`worker:${id}:1:req-1`, true, {})).toBe(false);
    expect(core.answer(`worker:${id}:2:req-1`, true, {})).toBe(false);
    expect(adapter.answers).toEqual([{ nativeId: "req-1", allow: false, input: { command: "rm -rf build" } }]);
    adapter.emit(id, normal("Done without deleting."));
    expect(store.get(id)).toMatchObject({ status: "done", report: { text: "(1 approval was denied during this run.)\nDone without deleting." } });
  });

  it("an engine's cancel of an open approval closes its card; open ones close at the end", async () => {
    const { core, adapter, kinds } = setup();
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    adapter.emit(id, { type: "permission", nativeId: "a", tool: "T", summary: "", input: {} }, { type: "permission", nativeId: "b", tool: "T", summary: "", input: {} }, { type: "permissionCancelled", nativeId: "a" }, { type: "permissionCancelled", nativeId: "zzz" });
    expect(kinds("permissionCancelled").map((c) => c.requestId)).toEqual([`worker:${id}:1:a`]);
    adapter.emit(id, normal("ok"));
    expect(kinds("permissionCancelled").map((c) => c.requestId)).toEqual([`worker:${id}:1:a`, `worker:${id}:1:b`]);
    expect(core.answer(`worker:${id}:1:b`, true, {})).toBe(false);
  });
});

describe("owners", () => {
  it("a report of a worker another bot owns is routed (workerReport), never the coordinator's; its tools are refused", async () => {
    const { core, adapter, port, store, kinds } = setup();
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    expect(core.setWorkerOwner(id, { botId: "b2", name: "Sub", agentId: "ag" })).toEqual({ ok: true });
    adapter.emit(id, normal("DONE"));
    expect(port.delivered).toEqual([]);
    expect(kinds("workerReport")).toEqual([{ kind: "workerReport", id, run: 1, engine: "claude", status: "completed", report: "DONE" }]);
    expect(store.get(id)).toMatchObject({ owner: { botId: "b2" }, report: { state: "routed" } });
    await expect(core.message({ task_id: id, message: "x" })).rejects.toThrow(/now belongs to "Sub"/);
    expect([workerState(store.get(id)), subagentStatus(store.get(id)), agentState(store.get(id)), chipStatus(store.get(id))]).toEqual(["idle", "completed", "idle", "completed"]);
  });

  it("a report already waiting goes to the new owner; giving it back makes later reports the coordinator's", async () => {
    const port = new FakePort();
    port.answer = "busy";
    const { core, adapter, kinds } = setup({ port });
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    adapter.emit(id, normal("DONE"));
    core.setWorkerOwner(id, { botId: "b2", name: "Sub", agentId: "ag" });
    expect(kinds("workerReport")).toHaveLength(1);
    core.setWorkerOwner(id, null);
    port.answer = "taken";
    await core.sendToWorker(id, "next");
    adapter.emit(id, normal("DONE 2"));
    expect(port.delivered.at(-1)!.report).toMatchObject({ id, run: 2, text: "DONE 2" });
  });
});

describe("delivery: policy none", () => {
  it("busy → stays pending; redeliver hands it over once", async () => {
    const port = new FakePort();
    port.answer = "busy";
    const { core, adapter, store } = setup({ port });
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    adapter.emit(id, normal("DONE"));
    expect(store.get(id).report.state).toBe("pending");
    expect(core.listWorkers()[0]!.state).toBe("reportPending");
    expect(core.hostedLive).toEqual([id]);
    expect(core.completionDependencies).toEqual([{ id, run: 1, task: "Go", state: "reportQueued", callback: "app_task_result", outcome: "completed", taskTruncated: false }]);
    port.answer = "taken";
    core.redeliver();
    core.redeliver();
    expect(port.delivered).toHaveLength(2);
    expect(store.get(id).report.state).toBe("acknowledged");
    expect(core.hostedLive).toEqual([]);
  });
});

describe("delivery: policy checkpoint", () => {
  async function ended(port = new FakePort("checkpoint")) {
    port.answer = "queued";
    const env = setup({ port, adapter: new FakeAdapter("agy-acp", "agy", false) });
    const { task_id: id } = await env.core.handoff("agy-acp", { instructions: "Go" });
    env.adapter.emit(id, normal("DONE"));
    return { ...env, id };
  }

  it("queued → dispatching in the report turn → shown twice without a decision → unresolved, failed in every projection", async () => {
    const { core, port, store, id, kinds } = await ended();
    expect(port.delivered).toHaveLength(1);
    expect(port.delivered[0]!.text.endsWith(REPORT_TAIL.checkpoint)).toBe(true);
    core.redeliver();
    expect(port.delivered).toHaveLength(1); // queued at the port: not handed over again
    expect(core.beginReport(id, 1)).toBe(true);
    expect(store.get(id).report.state).toBe("dispatching");
    expect(core.setWorkerOwner(id, { botId: "b", name: "B", agentId: "a" })).toMatchObject({ ok: false });
    core.finishReport(id, 1, true);
    expect(store.get(id).report).toMatchObject({ state: "pending", attempts: 1 });
    expect(port.delivered).toHaveLength(2);
    expect(core.beginReport(id, 1)).toBe(true);
    core.finishReport(id, 1, true);
    const r = store.get(id);
    expect(r.report).toMatchObject({ state: "unresolved", attempts: 2 });
    expect([workerState(r), subagentStatus(r), agentState(r), chipStatus(r), stepFailed(r)]).toEqual(["failed", "failed", "failed", "failed", true]);
    expect(kinds("subagentEnded").at(-1)).toEqual({ kind: "subagentEnded", id, status: "failed", summary: UNRESOLVED_REPORT });
    expect(core.beginReport(id, 1)).toBe(false);
    // An explicit decision still settles it.
    expect(core.checkpoint({ task_id: id, run: 1, outcome: "complete", evidence: "Checked the diff." })).toEqual({ task_id: id, run: 1, outcome: "complete", evidence: "Checked the diff." });
    expect(store.get(id).report.state).toBe("acknowledged");
  });

  it("a checkpoint in the report turn settles it; the turn's end changes nothing more", async () => {
    const { core, port, store, id } = await ended();
    expect(() => core.checkpoint({ task_id: id, run: 1, outcome: "complete", evidence: "x" })).toThrow(/No delivered report/);
    core.beginReport(id, 1);
    expect(() => core.checkpoint({ task_id: id, run: 1, outcome: "maybe", evidence: "x" })).toThrow(/outcome and concrete evidence/);
    expect(() => core.checkpoint({ task_id: id, run: 1, outcome: "waiting_dependency", evidence: "x", dependency_task_id: id })).toThrow(/another actively running/);
    expect(core.checkpoint({ task_id: id, run: 1, outcome: "blocked", evidence: "Needs a key.", dependency_task_id: "" })).toMatchObject({ outcome: "blocked" });
    core.finishReport(id, 1, true);
    expect(store.get(id).report).toMatchObject({ state: "acknowledged", attempts: 0, checkpoint: { outcome: "blocked", evidence: "Needs a key." } });
    expect(port.delivered).toHaveLength(1);
    expect(core.hostedLive).toEqual([]);
  });

  it("an uncertain hand-over stays uncertain until reconciled; a follow-up before the report was shown is refused", async () => {
    const { core, port, store, id } = await ended();
    await expect(core.message({ task_id: id, run: 1, message: "more" })).rejects.toThrow(/must be acknowledged/);
    core.beginReport(id, 1);
    core.finishReport(id, 1, false);
    expect(store.get(id).report.state).toBe("dispatching");
    core.redeliver();
    expect(port.delivered).toHaveLength(1);
    await expect(core.message({ task_id: id, run: 1, message: "more" })).rejects.toThrow(/must be acknowledged/);
    expect(() => core.reconcile({ task_id: id, run: 1, action: "maybe" })).toThrow(/Explicit/);
    expect(core.reconcile({ task_id: id, run: 1, action: "retry" })).toEqual({ task_id: id, run: 1, action: "retry", taskReplayed: false });
    expect(port.delivered).toHaveLength(2);
    expect(() => core.reconcile({ task_id: id, run: 1, action: "acknowledge" })).toThrow(/No uncertain report/);
    core.beginReport(id, 1);
    core.finishReport(id, 1, false);
    expect(core.reconcile({ task_id: id, run: 1, action: "acknowledge" })).toMatchObject({ action: "acknowledge" });
    expect(store.get(id).report.state).toBe("acknowledged");
  });

  it("a same-task follow-up in the report turn settles the report and starts the next run", async () => {
    const { core, store, id } = await ended();
    core.beginReport(id, 1);
    await expect(core.message({ task_id: id, run: 1, message: "Now the tests." })).resolves.toEqual({ task_id: id, run: 2, status: "accepted" });
    core.finishReport(id, 1, true);
    expect(store.get(id)).toMatchObject({ status: "running", run: 2, report: { state: "none" } });
  });

  it("dispatching survives a restart and still needs reconciling", async () => {
    const { core, store, id, adapter } = await ended();
    core.beginReport(id, 1);
    const reopened = setup({ store, adapter, port: new FakePort("checkpoint") });
    expect(store.get(id).report.state).toBe("dispatching");
    reopened.core.redeliver();
    expect(reopened.port.delivered).toEqual([]);
    expect(reopened.core.reconcile({ task_id: id, run: 1, action: "acknowledge" })).toMatchObject({ taskReplayed: false });
    void core;
  });
});

describe("slots (maxRunning)", () => {
  it("a run over the limit waits, listed at work; words sent meanwhile join it; it starts when a slot frees", async () => {
    const { core, adapter, items } = setup({ maxRunning: () => 1 });
    const a = (await core.handoff("claude-process", { instructions: "A" })).task_id;
    const b = (await core.handoff("claude-process", { instructions: "B" })).task_id;
    expect(adapter.started.map((s) => s.id)).toEqual([a]);
    expect(items.filter((i) => i.kind === "subagentText").at(-1)).toEqual({ kind: "subagentText", parent: b, text: "Waiting for a free worker slot (1 at work at once); it starts when another worker finishes." });
    expect(core.listWorkers().map((w) => w.state)).toEqual(["running", "running"]);
    expect(await core.sendToWorker(b, "Also C")).toEqual({ ok: true, how: "steered", run: 1 });
    adapter.emit(a, normal("A done"));
    expect(adapter.started.at(-1)).toEqual({ id: b, run: 1, words: "B\n\nAlso C" });
    // The opening items came once, when it was first listed.
    expect(items.filter((i) => i.kind === "subagentStarted" && (i as any).id === b)).toHaveLength(1);
  });

  it("a waiting run that cannot start fails like any run", async () => {
    const { core, adapter, store } = setup({ maxRunning: () => 1 });
    const a = (await core.handoff("claude-process", { instructions: "A" })).task_id;
    const b = (await core.handoff("claude-process", { instructions: "B" })).task_id;
    adapter.failStart = "no head";
    adapter.emit(a, normal("A done"));
    expect(store.get(b)).toMatchObject({ status: "failed", report: { text: "The worker could not start: no head" } });
  });

  it("stopping a waiting run frees nothing it never took", async () => {
    const { core, adapter } = setup({ maxRunning: () => 1 });
    await core.handoff("claude-process", { instructions: "A" });
    const b = (await core.handoff("claude-process", { instructions: "B" })).task_id;
    expect(await core.stopWorker(b)).toBe(true);
    expect(adapter.started).toHaveLength(1);
  });
});

describe("cleanup after a run (Antigravity's process groups)", () => {
  it("the report waits for the cleanup; meanwhile the worker is still hosted", async () => {
    const adapter = new FakeAdapter("agy-acp", "agy", false);
    let finish!: (cleaned: boolean) => void;
    adapter.cleanup = () => new Promise((resolve) => { finish = (cleaned) => resolve({ cleaned }); });
    const { core, port, store, kinds } = setup({ adapter });
    const { task_id: id } = await core.handoff("agy-acp", { instructions: "Go" });
    adapter.emit(id, normal("DONE"));
    expect(store.get(id)).toMatchObject({ status: "done", cleanup: "pending", report: { state: "pending" } });
    expect(port.delivered).toEqual([]);
    expect(kinds("subagentEnded")).toEqual([]);
    expect(core.hostedLive).toEqual([id]);
    expect(await core.sendToWorker(id, "more")).toMatchObject({ ok: false, busy: true });
    finish(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get(id).cleanup).toBeUndefined();
    expect(port.delivered).toHaveLength(1);
    expect(kinds("subagentEnded")).toEqual([{ kind: "subagentEnded", id, status: "completed", summary: "DONE" }]);
  });

  it("a failed cleanup shows failed everywhere and blocks follow-ups until recovery is confirmed", async () => {
    const adapter = new FakeAdapter("agy-acp", "agy", false);
    adapter.cleanup = async () => ({ cleaned: false });
    const { core, port, store } = setup({ adapter });
    const { task_id: id } = await core.handoff("agy-acp", { instructions: "Go" });
    adapter.emit(id, normal("DONE"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const r = store.get(id);
    expect(r).toMatchObject({ status: "done", cleanup: "failed", recovery: "required", report: { status: "failed", text: `${CLEANUP_FAILED_NOTE}\nDONE` } });
    expect([workerState(r), subagentStatus(r), agentState(r), chipStatus(r), stepFailed(r)]).toEqual(["failed", "failed", "failed", "failed", true]);
    expect(port.delivered[0]!.report.status).toBe("failed");
    adapter.recovery = { state: "blocked", reason: "Worker process group still exists." };
    expect(await core.sendToWorker(id, "more")).toEqual({ ok: false, reason: "Worker process group still exists." });
    adapter.recovery = { state: "clean" };
    expect(await core.sendToWorker(id, "more")).toEqual({ ok: true, how: "newRun", run: 2 });
  });
});

describe("conversation scope", () => {
  it("a session-scoped core lists and takes commands for its own conversation's workers only", async () => {
    let session = "conv-a";
    const { core } = setup({ sessionScoped: true, ownerSessionId: () => session });
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    session = "conv-b";
    expect(core.listWorkers()).toEqual([]);
    expect(await core.sendToWorker(id, "x")).toEqual({ ok: false, reason: "No such worker." });
    await expect(core.cancel(id)).rejects.toThrow(/Unknown task_id/);
    expect(core.get(id)).toMatchObject({ id, ownerSessionId: "conv-a" });
  });

  it("emits managedPending when whether anything is hosted changes (pendingSignal)", async () => {
    const { core, adapter, kinds } = setup({ pendingSignal: true });
    const { task_id: id } = await core.handoff("claude-process", { instructions: "Go" });
    adapter.emit(id, normal("DONE"));
    expect(kinds("managedPending").map((i) => i.pending)).toEqual([true, false]);
  });
});

describe("RunPipeline facts", () => {
  const pipeline = () => {
    const out: CodexItem[] = [];
    const ends: unknown[] = [];
    const p = new RunPipeline({ workerId: "w", run: 1, engine: "agy", conversationId: () => null, parentThreadId: () => null }, (item) => out.push(item), { control: () => undefined, ended: (end) => ends.push(end) });
    return { p, out, ends };
  };

  it("the engine's own final answer wins; a blank one falls back to the last text block (D1)", () => {
    const a = pipeline();
    a.p.feed({ type: "textDelta", text: "Thinking aloud" });
    a.p.feed({ type: "toolResult", id: "t", output: "", failed: true });
    a.p.feed({ type: "textDelta", text: "Final words" });
    a.p.feed({ type: "end", end: { how: "normal", finalText: "  ", error: null, detail: "end_turn" } });
    expect(a.p.facts({ stoppedByApp: false, interruptedBy: null, requireReply: true })).toMatchObject({ reply: "Final words", failedTools: 1, engine: "agy", end: { how: "normal" } });
    expect(a.ends).toHaveLength(1);
    const b = pipeline();
    b.p.feed({ type: "textWhole", text: "block", phase: null });
    b.p.feed({ type: "end", end: { how: "normal", finalText: "result text", error: null, detail: "" } });
    expect(b.p.facts({ stoppedByApp: false, interruptedBy: null, requireReply: true }).reply).toBe("result text");
  });

  it("takes nothing after the end", () => {
    const { p, out, ends } = pipeline();
    p.feed({ type: "end", end: { how: "normal", finalText: "x", error: null, detail: "" } });
    p.feed({ type: "textWhole", text: "late", phase: null });
    p.feed({ type: "end", end: { how: "error", finalText: null, error: "e", detail: "" } });
    expect(out).toEqual([]);
    expect(ends).toHaveLength(1);
    expect(p.ended).toBe(true);
  });
});

describe("a port that begins the report turn at once", () => {
  it("still gets the second hand-over", async () => {
    const adapter = new FakeAdapter("codex-thread", "codex");
    let core!: WorkerCore;
    const port: CoordinatorPort & { shown: number } = {
      ack: "checkpoint", shown: 0,
      deliver(report) { this.shown += 1; core.beginReport(report.id, report.run); return "queued"; },
    };
    const env = setup({ adapter, port: port as unknown as FakePort });
    core = env.core;
    const { task_id: id } = await core.handoff("codex-thread", { instructions: "Go" });
    adapter.emit(id, normal("DONE"));
    expect(env.store.get(id).report.state).toBe("dispatching");
    core.finishReport(id, 1, true);
    expect(port.shown).toBe(2);
    core.finishReport(id, 1, true);
    expect(env.store.get(id).report.state).toBe("unresolved");
  });
});
