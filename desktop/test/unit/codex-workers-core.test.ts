// Codex's app-managed workers and the Maintainer's component editor on the shared worker core (shared-core spec S3):
// CodexSession keeps the protocol and its coordinator's report turns (its CoordinatorPort); the workers' state, runs,
// reports and approvals are the WorkerCore's. Replayed with built JSON-RPC lines, as test/unit/codex.test.ts does.
import { describe, expect, it } from "vitest";
import { CodexSession, type CodexConfig, type CodexOutput, type WorkerRecord } from "../../src/core/agent/codex";
import { deniedNote, NO_REPORT, STOPPED_REPORT, UNRESOLVED_REPORT } from "../../src/core/worker-core";

const COORD = "coord-thread";
const config = (change: Partial<CodexConfig> = {}): CodexConfig => ({
  cwd: "/tmp/bot", instructions: "Coordinator", workerInstructions: "Worker", resumeThread: null, model: null, workerModel: null, effort: null,
  restoredWorkers: [], ownerSession: "owner-session", ...change,
});

class Out {
  constructor(readonly all: CodexOutput[]) {}
  get writes(): any[] { return this.all.filter((o) => o.kind === "write").map((o) => (o as { value: any }).value); }
  get items(): any[] { return this.all.filter((o) => o.kind === "item").map((o) => (o as { item: any }).item); }
  of(kind: string) { return this.items.filter((i) => i.kind === kind); }
  method(name: string) { return this.writes.find((w) => w.method === name); }
  get actions(): any[] { return this.all.filter((o) => o.kind === "componentEditor").map((o) => (o as { action: any }).action); }
}

let rpc = 500;
const note = (method: string, params: unknown) => JSON.stringify({ method, params });

/** A coordinator ready in COORD, idle unless `turn`. */
function session(change: Partial<CodexConfig> = {}, turn = false) {
  const s = new CodexSession(config(change));
  const all: CodexOutput[] = [];
  const take = (out: CodexOutput[]) => { all.push(...out); return new Out(out); };
  take(s.start());
  take(s.receive(JSON.stringify({ id: 1, result: {} })));
  take(s.receive(JSON.stringify({ id: 2, result: { thread: { id: COORD } } })));
  const answer = (id: number, result: unknown) => take(s.receive(JSON.stringify({ id, result })));
  const line = (method: string, params: unknown) => take(s.receive(note(method, params)));
  const tool = (name: string, args: unknown, turnId = "t1") => take(s.receive(JSON.stringify({ method: "item/tool/call", id: ++rpc, params: { threadId: COORD, turnId, callId: `call-${rpc}`, tool: name, arguments: args } })));
  const receipt = (out: Out) => JSON.parse(out.writes[0].result.contentItems[0].text);
  const writes = () => new Out(all).writes;
  /** Starts a coordinator turn (t1, or `id`). */
  const coordinatorTurn = (text = "go", id = "t1") => {
    const start = take(s.send(text)).method("turn/start") ?? writes().findLast((w) => w.method === "turn/start" && !w.params.toolOutput);
    answer(start.id, { turn: { id } });
  };
  const endCoordinator = (id = "t1", text = "ok") => {
    line("item/completed", { threadId: COORD, turnId: id, item: { type: "agentMessage", id: `m-${id}`, text, phase: "final_answer" } });
    return line("turn/completed", { threadId: COORD, turn: { id, status: "completed" } });
  };
  /** A worker handed off in the coordinator's turn, its thread `thread` and turn `wt` started. */
  const worker = (instructions = "Job", thread = "w1", wt = "wt1") => {
    const handed = tool("app_handoff", { instructions, name: instructions });
    const task = receipt(handed).task_id as string;
    const started = answer(handed.method("thread/start").id, { thread: { id: thread } });
    answer(started.method("turn/start").id, { turn: { id: wt } });
    return task;
  };
  const say = (thread: string, turn: string, text: string, phase = "final_answer") =>
    line("item/completed", { threadId: thread, turnId: turn, item: { type: "agentMessage", id: `m-${turn}-${text.length}`, text, phase } });
  const finish = (thread: string, turn: string, text: string | null, status = "completed") => {
    if (text !== null) say(thread, turn, text);
    return line("turn/completed", { threadId: thread, turn: { id: turn, status } });
  };
  return { s, all, take, answer, line, tool, receipt, writes, coordinatorTurn, endCoordinator, worker, say, finish };
}

describe("Codex workers on the shared core", () => {
  it("a worker's approval is a worker-scoped card; the answer reaches its exact request; a denial is noted in a done report", () => {
    const h = session();
    h.coordinatorTurn();
    const task = h.worker();
    const asked = h.take(h.s.receive(JSON.stringify({ method: "item/commandExecution/requestApproval", id: 700, params: { threadId: "w1", turnId: "wt1", command: "rm -rf build", environmentId: "local" } })));
    const [card] = asked.of("permission");
    expect(card).toMatchObject({ tool: "Bash", summary: "rm -rf build", workerId: task, requestId: expect.stringMatching(new RegExp(`^worker:${task}:1:`)) });
    const denied = h.take(h.s.answer(card.requestId, false, "Not this one."));
    expect(denied.writes).toContainEqual({ jsonrpc: "2.0", id: 700, result: { decision: "decline" } });
    expect(denied.method("turn/steer").params).toMatchObject({ threadId: "w1", expectedTurnId: "wt1", input: [{ type: "text", text: "(App: Not this one.)" }] });
    // A second click on the same card goes nowhere.
    expect(h.s.answer(card.requestId, true)).toEqual([]);
    const ended = h.finish("w1", "wt1", "Left build alone.");
    expect(ended.of("subagentEnded")).toEqual([{ kind: "subagentEnded", id: task, status: "completed", summary: `${deniedNote(1)}\nLeft build alone.` }]);
  });

  it("a card left open when its turn ends is withdrawn and a late click writes nothing", () => {
    const h = session();
    h.coordinatorTurn();
    const task = h.worker();
    const [card] = h.take(h.s.receive(JSON.stringify({ method: "item/fileChange/requestApproval", id: 701, params: { threadId: "w1", turnId: "wt1", itemId: "p1" } }))).of("permission");
    const ended = h.finish("w1", "wt1", "Done.");
    expect(ended.of("permissionCancelled")).toEqual([{ kind: "permissionCancelled", requestId: card.requestId }]);
    expect(h.s.answer(card.requestId, true)).toEqual([]);
    expect(h.writes().filter((w) => w.id === 701)).toEqual([]);
    expect(h.s.workerInfos[0]).toMatchObject({ id: task, state: "reportPending" });
  });

  it("a failed worker shows failed, not idle, once its report is settled", () => {
    const h = session();
    const task = h.worker("Job");
    const ended = h.finish("w1", "wt1", null, "failed");
    expect(ended.of("subagentEnded")).toMatchObject([{ id: task, status: "failed", summary: "Worker failed." }]);
    // The coordinator was free: its report turn shows it now.
    const report = ended.method("turn/start");
    expect(JSON.parse(report.params.toolOutput.output)).toMatchObject({ task_id: task, status: "failed", report: "Worker failed.", reconciliation_attempt: 0 });
    h.answer(report.id, { turn: { id: "r1" } });
    h.tool("app_task_checkpoint", { task_id: task, outcome: "blocked", evidence: "It failed." }, "r1");
    h.endCoordinator("r1", "It failed; I will look.");
    expect(h.s.workerInfos).toMatchObject([{ id: task, state: "failed" }]);
    expect(h.s.workerRecords[0]).toMatchObject({ id: task, reportPending: false });
  });

  it("stopping a worker: stopped (never killed), its turn interrupted, no report; a follow-up starts its next run", () => {
    const h = session({}, true);
    h.coordinatorTurn();
    const task = h.worker();
    const stopped = h.take(h.s.cancelWorkers(new Set([task])));
    expect(stopped.method("turn/interrupt").params).toEqual({ threadId: "w1", turnId: "wt1" });
    expect(stopped.of("subagentEnded")).toEqual([{ kind: "subagentEnded", id: task, status: "stopped", summary: STOPPED_REPORT }]);
    expect(JSON.stringify(h.all)).not.toContain("killed");
    expect(h.finish("w1", "wt1", "late", "interrupted").items).toEqual([]);
    expect(h.s.workerInfos[0]).toMatchObject({ state: "stopped" });
    // Its stop (a turn interrupt) is done at once: nothing holds the next run back.
    expect(h.s.core.get(task)!.cleanup).toBeUndefined();
    const again = h.tool("app_send_message", { task_id: task, message: "Try once more" });
    expect(h.receipt(again)).toEqual({ task_id: task, status: "accepted" });
    expect(again.method("turn/start").params).toMatchObject({ threadId: "w1", input: [{ type: "text", text: "Try once more" }] });
    expect(again.of("subagentStarted")).toMatchObject([{ id: task, execution: { run: 2 } }]);
  });

  it("A a stop before its turn is known holds the next run until that turn is interrupted; the old turn's words never reach run 2", async () => {
    const h = session({}, true);
    h.coordinatorTurn();
    const handed = h.tool("app_handoff", { instructions: "Old job", name: "Old job" });
    const task = h.receipt(handed).task_id as string;
    const start = h.answer(handed.method("thread/start").id, { thread: { id: "w1" } }).method("turn/start");
    // Stopped while its turn/start has no answer yet: no turn id to interrupt.
    h.take(h.s.cancelWorkers(new Set([task])));
    expect(h.s.core.get(task)).toMatchObject({ status: "stopped", cleanup: "pending" });
    const early = h.tool("app_send_message", { task_id: task, message: "New job" });
    expect(h.receipt(early)).toMatchObject({ error: expect.stringContaining("try again") });
    // Its turn comes: interrupted at once, and only then is the worker free.
    const late = h.answer(start.id, { turn: { id: "old-t" } });
    expect(late.method("turn/interrupt").params).toEqual({ threadId: "w1", turnId: "old-t" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.s.core.get(task)!.cleanup).toBeUndefined();
    const again = h.tool("app_send_message", { task_id: task, message: "New job" });
    expect(h.receipt(again)).toEqual({ task_id: task, status: "accepted" });
    // The old turn's late words and end belong to nobody.
    h.say("w1", "old-t", "OLD RUN OUTPUT");
    h.line("turn/completed", { threadId: "w1", turn: { id: "old-t", status: "interrupted" } });
    expect(h.s.core.get(task)).toMatchObject({ run: 2, status: "running" });
    const second = again.method("turn/start");
    h.answer(second.id, { turn: { id: "new-t" } });
    h.finish("w1", "new-t", "New answer.");
    expect(h.s.core.get(task)!.report).toMatchObject({ status: "done", text: "New answer." });
  });

  it("a report waits for the coordinator's turn; a report with no decision is shown once more, then unresolved", () => {
    const h = session();
    h.coordinatorTurn();
    const task = h.worker();
    const ended = h.finish("w1", "wt1", "Built.");
    expect(ended.of("backgroundTurn")).toEqual([]);
    expect(h.s.completionDependencies).toMatchObject([{ id: task, state: "reportQueued", outcome: "completed" }]);
    expect(h.s.hasManagedWork).toBe(true);
    const first = h.endCoordinator();
    expect(first.of("backgroundTurn")).toEqual([{ kind: "backgroundTurn", taskId: task }]);
    // While it is shown it is no queued dependency (the turn keeps the bot awake).
    expect(h.s.completionDependencies).toEqual([]);
    h.answer(first.method("turn/start").id, { turn: { id: "r1" } });
    const second = h.endCoordinator("r1", "It is built.");
    expect(second.of("result")).toEqual([{ kind: "result", ok: true, text: "", error: "", subtype: "success", how: "normal" }]);
    expect(JSON.parse(second.method("turn/start").params.toolOutput.output).reconciliation_attempt).toBe(1);
    h.answer(second.method("turn/start").id, { turn: { id: "r2" } });
    const third = h.endCoordinator("r2", "Still built.");
    expect(third.of("result")[0]).toMatchObject({ ok: false, error: expect.stringContaining("No acceptance checkpoint") });
    expect(third.of("subagentEnded")).toEqual([{ kind: "subagentEnded", id: task, status: "failed", summary: UNRESOLVED_REPORT }]);
    expect(h.s.workerInfos[0]).toMatchObject({ state: "failed" });
    expect(h.s.hasManagedWork).toBe(false);
    expect(h.s.completionDependencies).toEqual([]);
  });

  it("#2 a report turn cut short shows its evidence and counts as an attempt without a decision: shown once more, then unresolved", () => {
    const h = session();
    const task = h.worker();
    const ended = h.finish("w1", "wt1", "Built.");
    h.answer(ended.method("turn/start").id, { turn: { id: "r1" } });
    const cut = h.line("turn/completed", { threadId: COORD, turn: { id: "r1", status: "failed", error: { message: "boom" } } });
    expect(cut.of("result")[0]).toMatchObject({ ok: false, error: expect.stringContaining("Built.") });
    const again = cut.method("turn/start");
    expect(JSON.parse(again.params.toolOutput.output)).toMatchObject({ task_id: task, reconciliation_attempt: 1 });
    h.answer(again.id, { turn: { id: "r2" } });
    const last = h.line("turn/completed", { threadId: COORD, turn: { id: "r2", status: "interrupted" } });
    expect(last.method("turn/start")).toBeUndefined();
    expect(h.s.core.get(task)!.report.state).toBe("unresolved");
    expect(h.s.hasManagedWork).toBe(false);
  });

  it("a follow-up drops a report the coordinator was not shown yet (as before)", () => {
    const h = session();
    h.coordinatorTurn();
    const task = h.worker();
    h.finish("w1", "wt1", "First answer.");
    const again = h.tool("app_send_message", { task_id: task, message: "Go on" });
    expect(h.receipt(again)).toEqual({ task_id: task, status: "accepted" });
    const ended = h.endCoordinator();
    expect(ended.of("backgroundTurn")).toEqual([]);
    expect(h.s.runningWorkers).toEqual([task]);
  });

  it("words a turn refused as it ended go into a new turn of the same run (one end)", () => {
    const h = session();
    h.coordinatorTurn();
    const task = h.worker();
    const steer = h.tool("app_send_message", { task_id: task, message: "Also the docs" }).method("turn/steer");
    expect(steer.params).toMatchObject({ expectedTurnId: "wt1" });
    h.say("w1", "wt1", "Code done.");
    const refused = h.take(h.s.receive(JSON.stringify({ id: steer.id, error: { message: "no active turn" } })));
    expect(refused.items).toEqual([]);
    const next = h.line("turn/completed", { threadId: "w1", turn: { id: "wt1", status: "completed" } });
    expect(next.of("subagentEnded")).toEqual([]);
    expect(next.method("turn/start").params).toMatchObject({ threadId: "w1", input: [{ type: "text", text: "Also the docs" }] });
    h.answer(next.method("turn/start").id, { turn: { id: "wt2" } });
    const ended = h.finish("w1", "wt2", "Docs done too.");
    expect(ended.of("subagentEnded")).toEqual([{ kind: "subagentEnded", id: task, status: "completed", summary: "Docs done too." }]);
    expect(h.s.workerInfos[0]).toMatchObject({ run: 1 });
  });

  it("usage is the thread's differences, the output counter the run's own; requests are scoped to the worker", () => {
    const h = session();
    h.coordinatorTurn();
    const task = h.worker();
    h.line("turn/started", { threadId: "w1", turn: { id: "wt1" } });
    const first = h.line("thread/tokenUsage/updated", { threadId: "w1", turnId: "wt1", tokenUsage: { total: { inputTokens: 100, outputTokens: 10 }, last: { inputTokens: 100, outputTokens: 10 } } });
    const second = h.line("thread/tokenUsage/updated", { threadId: "w1", turnId: "wt1", tokenUsage: { total: { inputTokens: 250, outputTokens: 30 }, last: { inputTokens: 150, outputTokens: 20 } } });
    expect([...first.of("usage"), ...second.of("usage")].map((u) => u.tokens)).toEqual([{ input: 100, output: 10, cacheWrite: 0, cacheRead: 0 }, { input: 150, output: 20, cacheWrite: 0, cacheRead: 0 }]);
    expect([...first.of("subagentOutput"), ...second.of("subagentOutput")]).toEqual([
      { kind: "subagentOutput", id: task, counter: "thread:w1:run1", tokens: 10 }, { kind: "subagentOutput", id: task, counter: "thread:w1:run1", tokens: 30 },
    ]);
    expect([...first.of("request"), ...second.of("request")].map((r) => r.request.scope)).toEqual([task, task]);
    expect([...first.of("measurement"), ...second.of("measurement")].every((m) => m.measurement.workerId === task && m.measurement.run === 1)).toBe(true);
  });

  it("the app-server going away fails its workers' runs; their reports wait in the journal for the next head", () => {
    const h = session();
    h.coordinatorTurn();
    const task = h.worker();
    const gone = h.take(h.s.exited("killed by signal SIGKILL"));
    expect(gone.of("subagentEnded")).toEqual([{ kind: "subagentEnded", id: task, status: "failed", summary: "killed by signal SIGKILL" }]);
    expect(gone.method("turn/start")).toBeUndefined();
    const saved = h.s.workerRecords;
    expect(saved).toMatchObject([{ id: task, wasActive: false, reportPending: true, status: "failed", report: "killed by signal SIGKILL" }]);
    const next = session({ restoredWorkers: saved });
    expect(next.all.filter((o) => o.kind === "item" && o.item.kind === "backgroundTurn")).toEqual([{ kind: "item", item: { kind: "backgroundTurn", taskId: task } }]);
  });

  it("an explicit restart adopts a worker turn that completed meanwhile: one report turn, nothing sent to the worker", () => {
    const record: WorkerRecord = { id: "11111111-2222-4333-8444-555555555555", name: "Research", instructions: "Research only.", thread: "w9", run: 3, wasActive: true, reportPending: false, restartSafe: true, restartTurn: "old" };
    const s = new CodexSession(config({ resumeThread: COORD, restartWorkers: [record] }));
    s.start(); s.receive(JSON.stringify({ id: 1, result: {} }));
    const inject = new Out(s.receive(JSON.stringify({ id: 2, result: { thread: { id: COORD } } }))).method("thread/inject_items");
    const read = new Out(s.receive(JSON.stringify({ id: inject.id, result: {} }))).method("thread/read");
    expect(s.workerInfos).toMatchObject([{ id: record.id, state: "interrupted" }]);
    // Until its thread is read, a follow-up waits (it would race the recovery).
    expect(s.sendToWorker(record.id, "status?").result).toMatchObject({ ok: false, reason: expect.stringContaining("Restart recovery") });
    const out = new Out(s.receive(JSON.stringify({ id: read.id, result: { thread: { id: "w9", turns: [{ id: "old", status: "completed", items: [{ type: "agentMessage", text: "Found it.", phase: "final_answer" }] }] } } })));
    expect(out.writes.filter((w) => w.params?.threadId === "w9")).toEqual([]);
    expect(out.of("subagentEnded")).toEqual([{ kind: "subagentEnded", id: record.id, status: "completed", summary: "Found it." }]);
    expect(out.of("backgroundTurn")).toEqual([{ kind: "backgroundTurn", taskId: record.id }]);
    expect(JSON.parse(out.method("turn/start").params.toolOutput.output)).toMatchObject({ task_id: record.id, run: 4, turn_id: "old", report: "Found it." });
  });

  it("#2 an uncertain report from before the restart is never taken as handed over: shown once more as a reconciliation attempt", () => {
    const s = new CodexSession(config({ restoredWorkers: [{ id: "task-1", name: "R", instructions: "x", thread: "w1", run: 1, wasActive: false, reportPending: true, reportDispatching: true, report: "sent?", status: "completed" }] }));
    expect(s.core.get("task-1")!.report).toMatchObject({ state: "pending", attempts: 1 });
    s.start(); s.receive(JSON.stringify({ id: 1, result: {} }));
    const ready = new Out(s.receive(JSON.stringify({ id: 2, result: { thread: { id: COORD } } })));
    expect(ready.of("backgroundTurn")).toEqual([{ kind: "backgroundTurn", taskId: "task-1" }]);
    expect(JSON.parse(ready.method("turn/start").params.toolOutput.output)).toMatchObject({ task_id: "task-1", run: 1, report: "sent?", reconciliation_attempt: 1 });
  });

  it("#2 a report turn that never started is not taken as handed over: shown again, then unresolved (never lost)", () => {
    const h = session();
    h.coordinatorTurn();
    const task = h.worker();
    h.endCoordinator();
    const first = h.finish("w1", "wt1", "Found it.").method("turn/start");
    expect(JSON.parse(first.params.toolOutput.output)).toMatchObject({ task_id: task, reconciliation_attempt: 0 });
    const again = h.take(h.s.receive(JSON.stringify({ id: first.id, error: { message: "turn/start failed" } }))).method("turn/start");
    expect(h.s.core.get(task)!.report.state).toBe("dispatching");
    expect(JSON.parse(again.params.toolOutput.output)).toMatchObject({ task_id: task, reconciliation_attempt: 1 });
    const last = h.take(h.s.receive(JSON.stringify({ id: again.id, error: { message: "turn/start failed" } })));
    expect(last.method("turn/start")).toBeUndefined();
    expect(h.s.core.get(task)!.report.state).toBe("unresolved");
  });
});

describe("the coordinator's turn end (for classifyRun)", () => {
  it("says how the turn ended: completed normal, failed error, interrupted cancelled", () => {
    const h = session();
    const ends: unknown[] = [];
    for (const [status, id] of [["completed", "t1"], ["failed", "t2"], ["interrupted", "t3"]] as const) {
      h.coordinatorTurn("go", id);
      if (status === "completed") h.say(COORD, id, "Done.");
      ends.push(...h.line("turn/completed", { threadId: COORD, turn: { id, status, ...(status === "failed" ? { error: { message: "boom" } } : {}) } }).of("result").map((r) => [r.ok, r.how]));
    }
    expect(ends).toEqual([[true, "normal"], [false, "error"], [false, "cancelled"]]);
  });
});

describe("the component editor on the shared core", () => {
  const route = { launch: { command: "claude", cwd: "/library", sessionId: "unused", resume: false, model: "haiku", allowedTools: ["Read"], tools: ["Read"], effort: "low" } };
  function editor() {
    const h = session({ componentEditor: route });
    h.coordinatorTurn();
    const handed = h.tool("app_handoff", { role: "component-editor", instructions: "Edit it", name: "Editor" });
    const task = h.receipt(handed).task_id as string;
    return { ...h, task, handed };
  }

  it("#6 a message whose words were streamed and that also carries a tool call shows its words once (the Claude workers' rule)", async () => {
    const { s, task } = editor();
    const { parseLine } = await import("../../src/core/agent/stream");
    const texts: string[] = [];
    const feed = (line: unknown) => { for (const item of parseLine(JSON.stringify(line))) texts.push(...new Out(s.componentEditorItem(task, 1, item)).of("subagentText").map((i) => i.text)); };
    feed({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    feed({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me look." } } });
    feed({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x" } }] } });
    feed({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false }] } });
    feed({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Edited it." }] } });
    feed({ type: "result", subtype: "success", is_error: false, result: "Edited it.", session_id: "s", total_cost_usd: 0 });
    expect(texts).toEqual(["Let me look.", "Edited it."]);
  });

  it("is listed as the Maintainer's editor (not a Claude worker), with its model", () => {
    const { handed, task } = editor();
    expect(handed.of("toolUse")).toMatchObject([{ id: task, tool: "Agent", input: { subagent_type: "ccb-core:component-editor" } }]);
    expect(handed.of("subagentStarted")).toMatchObject([{ id: task, type: "ccb-core:component-editor", execution: { run: 1, ownerSessionId: "owner-session" } }]);
    expect(handed.of("subagentRuntime")[0]).toMatchObject({ id: task, runtime: { engine: "claude", reasoningEffort: "low" }, model: "haiku" });
  });

  it("joins its streamed chunks into one step (not dropped), forwards its requests, and reports the joined text", () => {
    const { s, task } = editor();
    const item = (i: Parameters<typeof s.componentEditorItem>[2]) => new Out(s.componentEditorItem(task, 1, i));
    const chunks = ["Edited `05B44", "DD6-73BB.md`", " and checked."];
    expect(chunks.flatMap((text) => item({ kind: "delta", text }).of("subagentText"))).toEqual([]);
    const request = item({ kind: "request", request: { scope: null, id: "r1", sample: { outputTokens: 12, startMs: 0, endMs: 10, complete: true } } });
    expect(request.of("request")).toEqual([{ kind: "request", request: { scope: task, id: "r1", sample: { outputTokens: 12, startMs: 0, endMs: 10, complete: true } } }]);
    const ended = item({ kind: "result", ok: true, text: "", error: "", subtype: "success", how: "normal" });
    expect(ended.of("subagentText")).toEqual([{ kind: "subagentText", parent: task, text: chunks.join("") }]);
    expect(ended.of("subagentEnded")).toEqual([{ kind: "subagentEnded", id: task, status: "completed", summary: chunks.join("") }]);
  });

  it("its costs reach the bot as each usage's spend (the worker entry adds them up); an empty result fails with the one wording", () => {
    const { s, task } = editor();
    const usage = (total: number) => new Out(s.componentEditorItem(task, 1, { kind: "usage", totalCost: total, tokens: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 } })).of("usage")[0].totalCost;
    expect([usage(0.25), usage(0.5)]).toEqual([0.25, 0.25]);
    const ended = new Out(s.componentEditorItem(task, 1, { kind: "result", ok: true, text: " ", error: "", subtype: "success", how: "normal" }));
    expect(ended.of("subagentEnded")).toEqual([{ kind: "subagentEnded", id: task, status: "failed", summary: NO_REPORT }]);
  });
});
