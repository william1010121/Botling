// The Codex head's protocol (agent/codex.ts), replayed with lines real `codex app-server`
// (codex-cli 0.163.0) wrote — test/fixtures/codex-recordings.json, taken from the Swift app's
// CodexRecordings.swift — and with app-managed worker exchanges built the same way.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexSession, CodexThreads, handbackFallback, MANAGED_TOOL_SIGNATURE, type CodexConfig, type CodexOutput } from "../../src/core/agent/codex";
import { INTERRUPTED_REPORT, NO_REPORT } from "../../src/core/worker-core";
import { desktop, tempDir } from "../helpers";

const recordings: Record<string, string[]> = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "codex-recordings.json"), "utf8"));

const config = (change: Partial<CodexConfig> = {}): CodexConfig => ({
  cwd: "/tmp/bot", instructions: "You are a test bot.", workerInstructions: "You are a worker.", resumeThread: null,
  model: null, workerModel: null, effort: null, restoredWorkers: [], ...change,
});

class Out {
  constructor(readonly all: CodexOutput[]) {}
  get writes() { return this.all.filter((o) => o.kind === "write").map((o) => (o as { value: any }).value); }
  get methods() { return this.writes.map((w) => w.method ?? "(answer)"); }
  params(method: string) { return this.writes.find((w) => w.method === method)?.params; }
  get items() { return this.all.filter((o) => o.kind === "item").map((o) => (o as { item: any }).item); }
  of(kind: string) { return this.items.filter((i) => i.kind === kind); }
  get results() { return this.of("result").map((r) => ({ ok: r.ok, text: r.ok ? r.text : r.error })); }
  get closed() { return this.all.some((o) => o.kind === "close"); }
}

function replay(session: CodexSession, lines: string[]): Out {
  return new Out(lines.flatMap((line) => session.receive(line)));
}

describe("Codex head: one coordinator thread", () => {
  it("starts a thread with the app's own approval, sandbox and coordinator settings, then the first message", () => {
    const session = new CodexSession(config({ effort: "high" }));
    const first = new Out(session.start());
    expect(first.methods).toEqual(["initialize"]);
    expect(new Out(session.send("Reply with the single word: hello")).writes).toEqual([]);
    const out = replay(session, recordings.helloAndApproval!.slice(0, 2));
    expect(out.methods).toEqual(["initialized", "thread/start", "turn/start"]);
    const thread = out.params("thread/start");
    expect(thread).toMatchObject({ cwd: "/tmp/bot", approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write", developerInstructions: "You are a test bot.", environments: [] });
    expect(thread.config).toEqual({ "features.multi_agent": false, "agents.enabled": false, "features.shell_tool": false, web_search: "disabled", "auto_review.extra_policy": expect.any(String) });
    expect(thread.dynamicTools.map((t: { name: string }) => t.name)).toEqual(["app_routines", "app_monitor_start", "app_monitor_status", "app_monitor_cancel", "app_handoff", "app_send_message", "app_task_checkpoint"]);
    expect(out.all.find((o) => o.kind === "thread")).toEqual({ kind: "thread", id: "01a1640c-e2db-7742-998a-553a14d4336f" });
    expect(out.params("turn/start")).toMatchObject({ input: [{ type: "text", text: "Reply with the single word: hello" }], effort: "high" });
  });

  it("its other folders are writable roots of the workspace sandbox, as in 1.x; none adds nothing", () => {
    const session = new CodexSession(config({ writableRoots: ["/tmp/other/.bot", "/tmp/shared"] }));
    session.start();
    session.send("hi");
    const thread = replay(session, recordings.helloAndApproval!.slice(0, 2)).params("thread/start");
    expect(thread).toMatchObject({ sandbox: "workspace-write", config: { "features.shell_tool": false, sandbox_workspace_write: { writable_roots: ["/tmp/other/.bot", "/tmp/shared"] } } });
    const plain = new CodexSession(config());
    plain.start();
    plain.send("hi");
    expect(replay(plain, recordings.helloAndApproval!.slice(0, 2)).params("thread/start").config.sandbox_workspace_write).toBeUndefined();
  });

  it("ends a turn with its final answer; a command that needs approval asks, and the answer goes back", () => {
    const session = new CodexSession(config());
    session.start();
    session.send("Reply with the single word: hello");
    session.send("Run the shell command: echo hi > note.txt");
    const lines = recordings.helloAndApproval!;
    const ask = lines.findIndex((line) => line.includes("requestApproval"));
    const asked = replay(session, lines.slice(0, ask + 1));
    expect(asked.results).toEqual([{ ok: true, text: "hello" }]);
    expect(asked.of("stepText")).toEqual([{ kind: "stepText", text: "I’ll run it with the required approval request." }]);
    expect(asked.of("toolUse")).toMatchObject([{ tool: "Bash", title: "Run echo hi > note.txt", detail: "echo hi > note.txt" }]);
    const [permission] = asked.of("permission");
    expect(permission).toMatchObject({ requestId: expect.stringMatching(/^codex-approval:/), tool: "Bash" });
    expect(permission.summary.startsWith("/bin/zsh -lc 'echo hi > note.txt'\n\nAllow writing hi")).toBe(true);
    const answer = new Out(session.answer(permission.requestId, true));
    expect(answer.writes).toEqual([{ jsonrpc: "2.0", id: 0, result: { decision: "accept" } }]);
    const rest = replay(session, lines.slice(ask + 1));
    expect(rest.of("permissionCancelled")).toEqual([]);
    expect(rest.of("toolResult")).toMatchObject([{ failed: false }]);
    expect(rest.results).toEqual([{ ok: true, text: "Wrote `hi` to `note.txt`." }]);
  });

  it("a question Codex stops waiting for is taken back, and a late answer goes nowhere", () => {
    const session = new CodexSession(config());
    session.start();
    session.send("Reply with the single word: hello");
    session.send("Run it");
    const lines = recordings.helloAndApproval!;
    const ask = lines.findIndex((line) => line.includes("requestApproval"));
    const [permission] = replay(session, lines.slice(0, ask + 1)).of("permission");
    const resolved = replay(session, [lines.find((line) => line.includes("serverRequest/resolved"))!]);
    expect(resolved.of("permissionCancelled")).toEqual([{ kind: "permissionCancelled", requestId: permission.requestId }]);
    expect(new Out(session.answer(permission.requestId, true)).writes).toEqual([]);
  });

  it("a refusal's reason joins the turn as an app note", () => {
    const session = new CodexSession(config());
    session.start();
    session.send("Reply with the single word: hello");
    session.send("Run it");
    const lines = recordings.helloAndApproval!;
    const [permission] = replay(session, lines.slice(0, lines.findIndex((line) => line.includes("requestApproval")) + 1)).of("permission");
    const answer = new Out(session.answer(permission.requestId, false, "The user did not allow it."));
    expect(answer.writes[0]).toEqual({ jsonrpc: "2.0", id: 0, result: { decision: "decline" } });
    expect(answer.params("turn/steer")).toMatchObject({ input: [{ type: "text", text: "(App: The user did not allow it.)" }] });
  });

  it("a patch is a Write step; steering joins the turn; interrupt ends it with a hidden error", () => {
    const session = new CodexSession(config());
    session.start();
    session.send("Create a.txt");
    session.send("first");
    const lines = recordings.editSteerInterrupt!;
    const one = replay(session, lines.slice(0, 29));
    expect(one.of("toolUse")).toMatchObject([{ tool: "Write", title: "Write a.txt", detail: "/tmp/bot/a.txt" }]);
    expect(one.of("toolResult")).toMatchObject([{ output: "x\n", failed: false }]);
    expect(one.results).toEqual([{ ok: true, text: "done" }]);
    expect(one.methods).toEqual(["initialized", "thread/start", "turn/start", "turn/start"]);
    const two = replay(session, lines.slice(29, 45));
    expect(two.results).toEqual([]);
    const steer = session.steer("second");
    expect(steer.joined).toBe(true);
    expect(new Out(steer.out).params("turn/steer")).toMatchObject({ expectedTurnId: "01a1640e-5237-70d3-8f42-e248278ed135" });
    expect(replay(session, lines.slice(45, 60)).results).toEqual([{ ok: true, text: "first second" }]);
    expect(new Out(session.send("sleep 30")).methods).toEqual(["turn/start"]);
    replay(session, lines.slice(60, 76));
    const interrupt = new Out(session.interrupt());
    expect(interrupt.params("turn/interrupt")).toMatchObject({ turnId: "01a1640e-79ed-76f2-8886-2d3a444d1fd6" });
    expect(new Out(session.interrupt()).writes).toEqual([]);
    expect(replay(session, lines.slice(76)).results).toEqual([{ ok: false, text: "" }]);
    expect(session.steer("nothing runs").joined).toBe(false);
  });

  it("an interrupt asked before the turn has an id goes once it has one", () => {
    const session = new CodexSession(config());
    session.start();
    session.send("Reply with the single word: hello");
    replay(session, recordings.helloAndApproval!.slice(0, 2));
    expect(new Out(session.interrupt()).writes).toEqual([]);
    expect(replay(session, recordings.helloAndApproval!.slice(2, 3)).methods).toEqual(["turn/interrupt"]);
  });

  it("finish waits for the turn, then closes; idle, at once", () => {
    const session = new CodexSession(config());
    session.start();
    session.send("Reply with the single word: hello");
    const lines = recordings.helloAndApproval!;
    replay(session, lines.slice(0, 3));
    expect(new Out(session.finish()).closed).toBe(false);
    const end = lines.findIndex((line) => line.includes("turn/completed"));
    const out = replay(session, lines.slice(3, end + 1));
    expect(out.closed).toBe(true);
    expect(out.results).toEqual([{ ok: true, text: "hello" }]);
    const idle = new CodexSession(config());
    idle.start();
    replay(idle, lines.slice(0, 2));
    expect(new Out(idle.finish()).closed).toBe(true);
  });

  it("resuming goes on in the same thread, with the coordinator's instructions appended first", () => {
    const session = new CodexSession(config({ resumeThread: "01a1640e-307d-76b3-ac16-5e7333057ab0" }));
    session.start();
    session.send("What did you write?");
    const lines = recordings.resumed!;
    const out = replay(session, lines.slice(0, 3));
    expect(out.methods).toEqual(["initialized", "thread/resume", "thread/inject_items"]);
    expect(out.params("thread/resume")).toMatchObject({ threadId: "01a1640e-307d-76b3-ac16-5e7333057ab0", excludeTurns: true });
    expect(out.params("thread/resume").dynamicTools).toBeUndefined();
    expect(out.params("thread/inject_items").items[0].content[0].text).toBe("You are a test bot.");
    expect(new Out(session.receive(JSON.stringify({ id: 3, result: {} }))).methods).toEqual(["turn/start"]);
  });

  it("a thread that cannot start fails the head with Codex's words", () => {
    const session = new CodexSession(config());
    session.start();
    session.receive(recordings.helloAndApproval![0]!);
    expect(session.receive(JSON.stringify({ id: 2, error: { code: -1, message: "no rollout found" } }))).toEqual([{ kind: "failed", message: "no rollout found" }]);
  });
});

// ---------------------------------------------------------------------------------------------
// App-managed workers

const COORD = "coord-thread";
const ready = (session: CodexSession) => {
  session.start();
  session.receive(JSON.stringify({ id: 1, result: {} }));
  return session.receive(JSON.stringify({ id: 2, result: { thread: { id: COORD } } }));
};
let serverId = 100;
const toolCall = (tool: string, args: unknown, turn = "t1") => JSON.stringify({ method: "item/tool/call", id: ++serverId, params: { threadId: COORD, turnId: turn, callId: `call-${serverId}`, tool, arguments: args } });
const note = (method: string, params: unknown) => JSON.stringify({ method, params });
const agent = (thread: string, turn: string, text: string, phase = "final_answer") => note("item/completed", { threadId: thread, turnId: turn, item: { type: "agentMessage", id: `m-${text.length}-${phase}`, text, phase } });
const receipt = (out: Out) => JSON.parse(out.writes[0].result.contentItems[0].text);

describe("Codex head: app-managed workers", () => {
  it("app_handoff starts a worker thread; its report wakes the coordinator, which checkpoints and says what came of it", () => {
    const session = new CodexSession(config({ workerModel: "gpt-worker" }));
    ready(session);
    session.send("Build it");
    session.receive(JSON.stringify({ id: 3, result: { turn: { id: "t1" } } }));
    const handed = new Out(session.receive(toolCall("app_handoff", { instructions: "Build the parser\nwith tests", name: "Parser" })));
    // The receipt goes first.
    expect(handed.writes[0].id).toBe(serverId);
    const { task_id: task, status } = receipt(handed);
    expect(status).toBe("accepted");
    expect(handed.of("toolUse")).toMatchObject([{ id: task, tool: "Agent", title: "Delegate Parser", parent: null, input: { description: "Parser", subagent_type: "codex-worker", run_in_background: true } }]);
    expect(handed.of("subagentStarted")).toMatchObject([{ id: task, description: "Parser", type: "codex-worker", background: true }]);
    expect(handed.of("managedPending")).toEqual([{ kind: "managedPending", pending: true }]);
    const workerStart = handed.params("thread/start");
    expect(workerStart).toMatchObject({ cwd: "/tmp/bot", approvalPolicy: "on-request", sandbox: "workspace-write", developerInstructions: expect.stringContaining("You are a worker."), model: "gpt-worker", config: { "features.multi_agent": false, "agents.enabled": false } });
    expect(workerStart.dynamicTools).toBeUndefined();
    expect(session.workerRecords).toMatchObject([{ id: task, name: "Parser", run: 1, wasActive: true, reportPending: false }]);
    // The same request again (a retry) gets the same receipt and starts nothing.
    expect(new Out(session.receive(JSON.stringify({ method: "item/tool/call", id: serverId, params: { threadId: COORD, turnId: "t1", callId: `call-${serverId}`, tool: "app_handoff", arguments: { instructions: "Build the parser\nwith tests", name: "Parser" } } }))).writes[0]).toEqual(handed.writes[0]);
    // The coordinator's turn ends; the worker's thread and turn start.
    expect(replay(session, [agent(COORD, "t1", "A worker has it."), note("turn/completed", { threadId: COORD, turn: { id: "t1", status: "completed" } })]).results).toEqual([{ ok: true, text: "A worker has it." }]);
    const workerTurn = new Out(session.receive(JSON.stringify({ id: 4, result: { thread: { id: "w1" } } })));
    expect(workerTurn.params("turn/start")).toMatchObject({ threadId: "w1", input: [{ type: "text", text: "Build the parser\nwith tests" }] });
    session.receive(JSON.stringify({ id: 5, result: { turn: { id: "wt1" } } }));
    const work = replay(session, [
      note("item/started", { threadId: "w1", turnId: "wt1", item: { type: "commandExecution", id: "c1", command: "npm test", commandActions: [] } }),
      note("item/completed", { threadId: "w1", turnId: "wt1", item: { type: "commandExecution", id: "c1", command: "npm test", status: "completed", exitCode: 0, aggregatedOutput: "ok" } }),
      agent("w1", "wt1", "Parser built; 12 tests pass."),
    ]);
    expect(work.of("toolUse")).toMatchObject([{ parent: task, tool: "Bash" }]);
    expect(work.of("toolResult")).toMatchObject([{ parent: task, output: "ok" }]);
    expect(work.of("subagentText")).toEqual([{ kind: "subagentText", parent: task, text: "Parser built; 12 tests pass." }]);
    const ended = new Out(session.receive(note("turn/completed", { threadId: "w1", turn: { id: "wt1", status: "completed" } })));
    expect(ended.of("subagentEnded")).toEqual([{ kind: "subagentEnded", id: task, status: "completed", summary: "Parser built; 12 tests pass." }]);
    expect(ended.of("backgroundTurn")).toEqual([{ kind: "backgroundTurn", taskId: task }]);
    // As in 1.x, nothing is pending once its report turn has started (that turn keeps the bot awake).
    expect(ended.of("managedPending")).toEqual([{ kind: "managedPending", pending: false }]);
    const report = ended.params("turn/start");
    expect(report.threadId).toBe(COORD);
    expect(report.input).toEqual([]);
    expect(report.toolOutput.name).toBe("app_task_result");
    expect(JSON.parse(report.toolOutput.output)).toMatchObject({ task_id: task, name: "Parser", thread_id: "w1", turn_id: "wt1", run: 1, status: "completed", report: "Parser built; 12 tests pass.", objective_status: "unverified" });
    expect(session.workerRecords).toMatchObject([{ id: task, wasActive: false, reportPending: true, status: "completed" }]);
    session.receive(JSON.stringify({ id: 6, result: { turn: { id: "t2" } } }));
    const checkpoint = new Out(session.receive(toolCall("app_task_checkpoint", { task_id: task, outcome: "complete", evidence: "12 tests pass" }, "t2")));
    expect(receipt(checkpoint)).toEqual({ task_id: task, outcome: "complete", recorded: true });
    expect(checkpoint.of("toolUse")).toMatchObject([{ tool: "app_task_checkpoint", title: "Task checkpoint: complete" }]);
    const done = replay(session, [agent(COORD, "t2", "The parser is built and tested."), note("turn/completed", { threadId: COORD, turn: { id: "t2", status: "completed" } })]);
    expect(done.results).toEqual([{ ok: true, text: "The parser is built and tested." }]);
    expect(session.workerRecords).toMatchObject([{ id: task, wasActive: false, reportPending: false }]);
  });

  it("a report with no checkpoint gets one hidden reconciliation turn, then the evidence as an error", () => {
    const session = new CodexSession(config({ restoredWorkers: [{ id: "task-1", name: "Parser", instructions: "Build", thread: "w1", run: 1, wasActive: false, reportPending: true, report: "built", status: "completed" }] }));
    const start = new Out(ready(session));
    expect(start.of("backgroundTurn")).toEqual([{ kind: "backgroundTurn", taskId: "task-1" }]);
    session.receive(JSON.stringify({ id: 3, result: { turn: { id: "t1" } } }));
    const first = replay(session, [agent(COORD, "t1", "It is built."), note("turn/completed", { threadId: COORD, turn: { id: "t1", status: "completed" } })]);
    expect(first.results).toEqual([{ ok: true, text: "" }]);
    expect(first.of("backgroundTurn")).toHaveLength(1);
    expect(JSON.parse(first.params("turn/start").toolOutput.output).reconciliation_attempt).toBe(1);
    session.receive(JSON.stringify({ id: 4, result: { turn: { id: "t2" } } }));
    const second = replay(session, [agent(COORD, "t2", "Still built."), note("turn/completed", { threadId: COORD, turn: { id: "t2", status: "completed" } })]);
    expect(second.results).toEqual([{ ok: false, text: handbackFallback({ name: "Parser", task: "task-1", status: "completed", report: "built" }, "No acceptance checkpoint or next owner action was recorded after one reconciliation. The user objective remains unverified; no automatic retry is scheduled.") }]);
  });

  it("a worker at work when the app stopped is interrupted (no report turn, as a Claude worker); app_send_message resumes its session", () => {
    const session = new CodexSession(config({ restoredWorkers: [{ id: "task-1", name: "Parser", instructions: "Build", thread: "w1", run: 1, wasActive: true, reportPending: false }] }));
    expect(new Out(ready(session)).of("backgroundTurn")).toEqual([]);
    expect(session.workerInfos).toMatchObject([{ id: "task-1", run: 1, state: "interrupted" }]);
    const again = new Out(session.receive(toolCall("app_send_message", { task_id: "task-1", message: "Carry on" })));
    expect(receipt(again)).toEqual({ task_id: "task-1", status: "accepted" });
    expect(again.params("thread/resume")).toMatchObject({ threadId: "w1", excludeTurns: true });
    expect(again.of("subagentStarted")).toMatchObject([{ id: "task-1", prompt: "Carry on", execution: { run: 2 } }]);
    // The journal keeps the hand-off's task; the follow-up is the run's scope.
    expect(session.workerRecords).toMatchObject([{ id: "task-1", run: 2, wasActive: true, instructions: "Build", ownershipInstructions: "Carry on" }]);
    // A resumed worker's instructions are appended before its turn, which has the follow-up's words only (no replay).
    const injected = new Out(session.receive(JSON.stringify({ id: again.writes.find((w) => w.method === "thread/resume").id, result: { thread: { id: "w1" } } })));
    expect(injected.methods).toEqual(["thread/inject_items"]);
    const turn = new Out(session.receive(JSON.stringify({ id: injected.writes[0].id, result: {} }))).params("turn/start");
    expect(turn).toMatchObject({ threadId: "w1", input: [{ type: "text", text: "Carry on" }] });
  });

  it("stop interrupts workers (no report, resumable); routines need their file, a monitor its owning turn; others' calls are refused", () => {
    const session = new CodexSession(config());
    ready(session);
    session.send("go");
    session.receive(JSON.stringify({ id: 3, result: { turn: { id: "t1" } } }));
    expect(receipt(new Out(session.receive(toolCall("app_routines", { operation: "list" }))))).toEqual({ error: expect.stringContaining("Routine storage is unavailable for this session") });
    const monitor = new Out(session.receive(toolCall("app_monitor_start", { command: "ls" })));
    expect(receipt(monitor)).toMatchObject({ command: "ls", status: "awaitingApproval", wake: "none", cwd: "/tmp/bot" });
    expect(monitor.of("permission")).toMatchObject([{ tool: "Monitored command", requestId: `monitor:${receipt(monitor).monitor_id}` }]);
    expect(receipt(new Out(session.receive(toolCall("app_monitor_start", { command: "ls" }, "not-this-turn"))))).toEqual({ error: "A monitor must be created by the current owning Codex turn." });
    expect(receipt(new Out(session.receive(toolCall("app_handoff", { instructions: "x", role: "component-editor" }))))).toEqual({ error: expect.stringContaining("component-editor") });
    const handed = new Out(session.receive(toolCall("app_handoff", { instructions: "Slow job" })));
    const task = receipt(handed).task_id;
    session.receive(JSON.stringify({ id: 4, result: { thread: { id: "w1" } } }));
    session.receive(JSON.stringify({ id: 5, result: { turn: { id: "wt1" } } }));
    expect(session.runningWorkers).toEqual([task]);
    const foreign = JSON.stringify({ method: "item/tool/call", id: 999, params: { threadId: "w1", tool: "app_handoff", arguments: { instructions: "nested" } } });
    expect(receipt(new Out(session.receive(foreign)))).toEqual({ error: "App handoff tools are available only to the active coordinator." });
    const stopped = new Out(session.stop());
    expect(stopped.params("turn/interrupt")).toEqual({ threadId: "w1", turnId: "wt1" });
    expect(stopped.of("subagentEnded")).toEqual([{ kind: "subagentEnded", id: task, status: "interrupted", summary: INTERRUPTED_REPORT.quit }]);
    expect(session.workerInfos).toMatchObject([{ id: task, state: "interrupted" }]);
    // Its monitors too: the card goes, nothing will run or wake.
    expect(stopped.of("permissionCancelled")).toEqual([{ kind: "permissionCancelled", requestId: `monitor:${receipt(monitor).monitor_id}` }]);
    expect(replay(session, [note("turn/completed", { threadId: "w1", turn: { id: "wt1", status: "interrupted" } })]).all).toEqual([]);
  });

  it("a failed worker turn reports its error; a worker that said nothing reports failed", () => {
    const session = new CodexSession(config());
    ready(session);
    session.send("go");
    session.receive(JSON.stringify({ id: 3, result: { turn: { id: "t1" } } }));
    const task = receipt(new Out(session.receive(toolCall("app_handoff", { instructions: "Job" })))).task_id;
    session.receive(JSON.stringify({ id: 4, result: { thread: { id: "w1" } } }));
    session.receive(JSON.stringify({ id: 5, result: { turn: { id: "wt1" } } }));
    const out = new Out(session.receive(note("turn/completed", { threadId: "w1", turn: { id: "wt1", status: "completed" } })));
    expect(out.of("subagentEnded")).toEqual([{ kind: "subagentEnded", id: task, status: "failed", summary: NO_REPORT }]);
    // A failed worker shows failed, not idle (its report waits for the coordinator meanwhile).
    expect(session.workerInfos).toMatchObject([{ id: task, state: "reportPending" }]);
    // The coordinator's turn still runs: the report waits for it.
    expect(out.of("backgroundTurn")).toEqual([]);
    expect(replay(session, [agent(COORD, "t1", "ok"), note("turn/completed", { threadId: COORD, turn: { id: "t1", status: "completed" } })]).of("backgroundTurn")).toHaveLength(1);
  });
});

describe("codex-threads (1.x's layout)", () => {
  it("keeps each session's thread, the ones before it, the tool stamp and the workers", () => {
    const dir = tempDir("codex-threads");
    const threads = new CodexThreads(join(dir, "codex-threads"));
    const session = "6A0B0000-0000-4000-8000-0000000000AA";
    expect(threads.thread(session)).toBeNull();
    threads.save("thread-1", session);
    threads.save("thread-2", session);
    threads.save("thread-2", session);
    expect(threads.thread(session)).toBe("thread-2");
    expect(readFileSync(join(dir, "codex-threads", session.toLowerCase()), "utf8")).toBe("thread-2");
    expect(readFileSync(join(dir, "codex-threads", `${session.toLowerCase()}.previous-threads`), "utf8")).toBe("thread-1\n");
    expect(threads.isManaged(session, "thread-2")).toBe(false);
    threads.markManaged("thread-2", session);
    expect(threads.isManaged(session, "thread-2")).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "codex-threads", `${session.toLowerCase()}.managed`), "utf8")).tools).toBe(MANAGED_TOOL_SIGNATURE);
    // A stamp from other tools (an older build) is not this coordinator.
    writeFileSync(join(dir, "codex-threads", `${session.toLowerCase()}.managed`), JSON.stringify({ thread: "thread-2", tools: "[]" }));
    expect(threads.isManaged(session, "thread-2")).toBe(false);
    threads.saveWorkers([{ id: "t", name: "n", instructions: "i", run: 1, wasActive: false, reportPending: false }], session);
    expect(threads.workers(session)).toEqual([{ id: "t", name: "n", instructions: "i", run: 1, wasActive: false, reportPending: false }]);
    mkdirSync(join(dir, "x"), { recursive: true });
    writeFileSync(join(dir, "codex-threads", "bad.workers.json"), "{");
    expect(threads.workers("bad")).toEqual([]);
  });
});

describe("Codex head: command monitors after a restart (CommandMonitor.reconcile)", () => {
  const monitor = (change: Record<string, unknown>) => ({ id: "m1", owner: "6A0B0000-0000-4000-8000-0000000000AA", command: "make test", cwd: "/tmp/bot", state: "running", stdout: "", stderr: "", detail: "", wake: "none", createdAt: 1, ...change }) as any;
  const ready = (session: CodexSession) => {
    session.start();
    return replay(session, [JSON.stringify({ id: 1, result: {} }), JSON.stringify({ id: 2, result: { thread: { id: "th-1" } } })]);
  };

  it("a command that was running is reported interrupted, never run again", () => {
    const session = new CodexSession(config({ ownerSession: "6a0b0000-0000-4000-8000-0000000000aa", restoredMonitors: [monitor({})] }));
    expect(session.monitorRecords[0]).toMatchObject({ state: "interrupted", wake: "pending" });
    expect(session.monitorRecords[0].detail).toMatch(/the command was not rerun/);
    const out = ready(session);
    expect(out.methods).not.toContain("command/exec");
    const start = out.params("turn/start");
    expect(start.toolOutput.name).toBe("app_monitor_result");
    expect(JSON.parse(start.toolOutput.output)).toMatchObject({ monitor_id: "m1", status: "interrupted", exit_code: null, wake: "dispatching" });
    expect(out.of("backgroundTurn")).toHaveLength(1);
  });

  it("one awaiting approval is not started; one cancelling is cancelled with its wake suppressed; a wake mid-dispatch becomes uncertain", () => {
    const session = new CodexSession(config({
      ownerSession: "6A0B0000-0000-4000-8000-0000000000AA",
      restoredMonitors: [monitor({ id: "a", state: "awaitingApproval" }), monitor({ id: "b", state: "cancelling" }), monitor({ id: "c", state: "succeeded", exitCode: 0, wake: "dispatching" }), monitor({ id: "d", owner: "someone-else" })],
    }));
    const records = session.monitorRecords;
    expect(records.map((r) => [r.id, r.state, r.wake])).toEqual([["a", "interrupted", "pending"], ["b", "cancelled", "suppressed"], ["c", "succeeded", "uncertain"]]);
    expect(records[0]!.detail).toBe("Restarted while awaiting approval. The command was not started; no rerun was performed.");
    expect(records[2]!.detail).toMatch(/No duplicate wake was sent\.$/);
  });

  it("app_monitor_start outside the owning turn is refused; status and cancel answer for its monitors", () => {
    const session = new CodexSession(config({ ownerSession: "6A0B0000-0000-4000-8000-0000000000AA" }));
    ready(session);
    const call = (tool: string, args: unknown, extra: Record<string, unknown> = {}) =>
      replay(session, [JSON.stringify({ id: 99, method: "item/tool/call", params: { threadId: "th-1", tool, arguments: args, ...extra } })]);
    const refused = call("app_monitor_start", { command: "ls" });
    expect(JSON.parse(refused.writes[0].result.contentItems[0].text)).toEqual({ error: "A monitor must be created by the current owning Codex turn." });
    const status = replay(session, [JSON.stringify({ id: 100, method: "item/tool/call", params: { threadId: "th-1", tool: "app_monitor_status", arguments: {} } })]);
    expect(JSON.parse(status.writes[0].result.contentItems[0].text)).toEqual({ monitors: [] });
  });
});

it("reports worker session metadata and attributable absolute output without using coordinator usage", () => {
  const session = new CodexSession(config({ model: "coordinator", effort: "low", workerEffort: "high" }));
  ready(session);
  session.send("Review");
  session.receive(JSON.stringify({ id: 3, result: { turn: { id: "t1" } } }));
  const handed = new Out(session.receive(toolCall("app_handoff", { instructions: "Review the patch", name: "Review" })));
  const task = receipt(handed).task_id;
  const request = handed.writes.find((write) => write.method === "thread/start");
  const started = new Out(session.receive(JSON.stringify({ id: request.id, result: { thread: { id: "worker-thread" }, model: "actual-worker", reasoningEffort: "medium", serviceTier: "priority" } })));
  expect(started.of("subagentRuntime")).toMatchObject([{ id: task, model: "actual-worker", runtime: { engine: "codex", reasoningEffort: "medium", serviceTier: "priority" } }]);
  const turn = started.writes.find((write) => write.method === "turn/start");
  const accepted = new Out(session.receive(JSON.stringify({ id: turn.id, result: { turn: { id: "worker-turn" } } })));
  expect(accepted.of("subagentRuntime")).toMatchObject([{ id: task, runtime: { reasoningEffort: "high", serviceTier: "priority" } }]);
  const usage = new Out(session.receive(note("thread/tokenUsage/updated", { threadId: "worker-thread", tokenUsage: { total: { inputTokens: 900, outputTokens: 100 } } })));
  // The run's own output (one counter per run of the thread).
  expect(usage.of("subagentOutput")).toEqual([{ kind: "subagentOutput", id: task, counter: "thread:worker-thread:run1", tokens: 100 }]);
  expect(new Out(session.receive(note("thread/tokenUsage/updated", { threadId: COORD, tokenUsage: { total: { outputTokens: 9000 } } }))).of("subagentOutput")).toEqual([]);
  expect(new Out(session.receive(note("thread/tokenUsage/updated", { threadId: "worker-thread", tokenUsage: { total: { outputTokens: true } } }))).of("subagentOutput")).toEqual([]);
});

describe("monitor owner authorization", () => {
  it("rejects worker start/status/cancel with intent, without approval, command or coordinator wake", () => {
    const s = new CodexSession(config()); ready(s); s.send("authorized work");
    s.receive(JSON.stringify({ id: 3, result: { turn: { id: "t1" } } }));
    for (const tool of ["app_monitor_start", "app_monitor_status", "app_monitor_cancel"]) {
      const call = JSON.parse(toolCall(tool, { command: "echo child", monitor_id: "other" }));
      call.params.threadId = "child-thread";
      const out = new Out(s.receive(JSON.stringify(call)));
      expect(out.writes[0].result.success).toBe(false);
      expect(receipt(out)).toMatchObject({ code: "coordinator_only_monitor", handback: { tool, input: { command: "echo child" }, owner_session_id: null, requester_thread_id: "child-thread" } });
      expect(out.items).toEqual([]);
      expect(out.methods).toEqual(["(answer)"]);
    }
    expect(s.monitorRecords).toEqual([]);
  });
});

it.each([false, true])("coordinator monitor still requires Allow once with bypass=%s and cannot expand command sandbox", bypassPermissions => {
  const s = new CodexSession(config({ bypassPermissions, autoMode: true, ownerSession: "OWNER", writableRoots: ["/tmp/authorized"] }));
  ready(s); s.send("already authorized command");
  s.receive(JSON.stringify({ id: 3, result: { turn: { id: "t1" } } }));
  const started = new Out(s.receive(toolCall("app_monitor_start", { command: "echo ok", cwd: "/outside", networkAccess: true })));
  const m = receipt(started);
  expect(started.params("command/exec")).toBeUndefined();
  expect(started.of("permission")).toHaveLength(1);
  expect(m).toMatchObject({ status: "awaitingApproval", owner_role: "coordinator", owner_session_id: "owner", owner_thread_id: COORD, owner_turn_id: "t1", cwd: "/tmp/bot" });
  const allowed = new Out(s.answer(`monitor:${m.monitor_id}`, true));
  expect(allowed.params("command/exec")).toMatchObject({ cwd: "/tmp/bot", sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/tmp/authorized", "/tmp/bot"], networkAccess: false } });
  expect(new Out(s.answer(`monitor:${m.monitor_id}`, true)).writes).toEqual([]);
});

it("authorizes before monitor replay and binds retries to owner, turn and intent", () => {
  const s = new CodexSession(config({ ownerSession: "owner" })); ready(s); s.send("authorized");
  s.receive(JSON.stringify({ id: 3, result: { turn: { id: "t1" } } }));
  const original = JSON.parse(toolCall("app_monitor_start", { command: "echo original" }));
  const accepted = new Out(s.receive(JSON.stringify(original)));
  const child = { ...original, params: { ...original.params, threadId: "child", arguments: { command: "echo other" } } };
  const denied = new Out(s.receive(JSON.stringify(child)));
  expect(denied.writes[0].result.success).toBe(false);
  expect(receipt(denied)).toMatchObject({ code: "coordinator_only_monitor", handback: { input: { command: "echo other" } } });
  expect(receipt(denied)).not.toHaveProperty("monitor_id");
  const retry = new Out(s.receive(JSON.stringify(original)));
  expect(retry.writes).toEqual(accepted.writes);
  expect(retry.items).toEqual([]);
  for (const params of [{ ...original.params, arguments: { command: "echo changed" } }, { ...original.params, callId: "different-call" }, { ...original.params, turnId: "stale" }]) {
    const out = new Out(s.receive(JSON.stringify({ ...original, params })));
    expect(out.writes[0].result.success).toBe(false);
    expect(out.items).toEqual([]);
  }
  expect(s.monitorRecords).toHaveLength(1);
  expect(s.monitorRecords[0].state).toBe("awaitingApproval");
});
