// Claude's app-managed workers (claude-workers.ts) with a fake ClaudeHead: a run's start and report, steering a
// running worker, a follow-up in the kept-alive process and after it ended (`--resume` of its own session), cancel,
// a crash, the app quitting (interrupted), restore from claude-workers.json, approvals and agent definitions.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeWorkers, CLAUDE_WORKER_POLICY, loadAgentDefinition } from "../../src/core/agent/claude-workers";
import { claudeHarness } from "../claude-workers-fake";
import { parseLine } from "../../src/core/agent/stream";

const made: ClaudeWorkers[] = [];
afterEach(async () => { for (const w of made.splice(0)) await w.close(); });
const harness = (...args: Parameters<typeof claudeHarness>) => { const h = claudeHarness(...args); made.push(h.workers); return h; };
const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a Claude worker's run", () => {
  it("starts its own claude process in the host folder with the worker policy, its own session and no app tools", async () => {
    const h = harness();
    const r: any = await h.workers.tool("app_handoff", { name: "Research", instructions: "Look up the API" });
    expect(r).toMatchObject({ accepted: true, run: 1 });
    const head = h.heads[0]!;
    expect(head.config).toMatchObject({ cwd: h.cwd, resume: false, model: "sonnet", monitorWorker: true, appMcp: null, persistSession: true });
    expect(head.config.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(head.config.sessionId).not.toBe("coordinator");
    expect(head.config.systemPrompt).toBe(CLAUDE_WORKER_POLICY);
    expect(head.config.agentGuard).toContain("worker");
    expect(head.config.disallowedTools).toEqual(expect.arrayContaining(["WebSearch", "SendMessage", "TaskStop"]));
    expect(head.sent.map((m) => m.text)).toEqual(["Look up the API"]);
    expect(h.items.slice(0, 3)).toEqual([
      expect.objectContaining({ kind: "toolUse", id: r.task_id, tool: "Agent", parent: null }),
      expect.objectContaining({ kind: "subagentStarted", id: r.task_id, type: "claude-worker", background: true, execution: expect.objectContaining({ run: 1, ownerSessionId: "coordinator" }) }),
      expect.objectContaining({ kind: "subagentRuntime", id: r.task_id, runtime: expect.objectContaining({ engine: "claude" }), model: "sonnet" }),
    ]);
    expect(h.workers.listWorkers()).toEqual([expect.objectContaining({ id: r.task_id, engine: "claude", state: "running", run: 1 })]);
  });

  it("follows its steps under its task id and reports to the coordinator when it ends; the process stays for a follow-up", async () => {
    const h = harness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Do it" }) as any;
    const head = h.heads[0]!;
    h.say(head, { kind: "init", sessionId: head.config.sessionId });
    h.say(head, { kind: "toolUse", id: "tu1", tool: "Bash", title: "ls", detail: "ls", parent: null, input: { command: "ls" } });
    h.say(head, { kind: "toolResult", id: "tu1", output: "a", failed: false, parent: null, launch: null });
    h.say(head, { kind: "delta", text: "Working" });
    h.say(head, { kind: "usage", totalCost: 0.5, tokens: { input: 1, output: 40, cacheCreation: 0, cacheRead: 0 } });
    h.result(head, "Done: 3 files changed.");
    expect(h.items).toContainEqual(expect.objectContaining({ kind: "toolUse", id: `${task_id}:1:tu1`, parent: task_id }));
    expect(h.items).toContainEqual(expect.objectContaining({ kind: "toolResult", id: `${task_id}:1:tu1`, parent: task_id }));
    expect(h.items).toContainEqual({ kind: "subagentText", parent: task_id, text: "Working" });
    expect(h.items).toContainEqual(expect.objectContaining({ kind: "subagentOutput", id: task_id, tokens: 40 }));
    expect(h.items).toContainEqual(expect.objectContaining({ kind: "usage", totalCost: 0.5 }));
    expect(h.items.at(-1)).toEqual({ kind: "subagentEnded", id: task_id, status: "completed", summary: "Done: 3 files changed." });
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.text).toContain(`<app_task_result task_id="${task_id}" run="1" engine="claude" status="completed">`);
    expect(h.reports[0]!.text).toContain("Done: 3 files changed.");
    expect(head.running).toBe(true);
    expect(h.workers.listWorkers()[0]!.state).toBe("idle");
    const saved = JSON.parse(readFileSync(join(h.dir, "claude-workers.json"), "utf8"));
    expect(saved.workers[0]).toMatchObject({ id: task_id, run: 1, status: "completed", reportDelivered: true, reportPending: false, sessionStarted: true });
  });

  it("shows each text block of its reply as one paragraph, not one per streamed chunk, and the whole message does not repeat it", async () => {
    const h = harness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Find the data" }) as any;
    const head = h.heads[0]!;
    const line = (message: unknown) => { for (const item of parseLine(JSON.stringify(message))) h.say(head, item); };
    const block = (chunks: string[]) => {
      line({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
      for (const text of chunks) line({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
      line({ type: "assistant", parent_tool_use_id: null, message: { id: "m", role: "assistant", content: [{ type: "text", text: chunks.join("") }] } });
    };
    block(["正", "在定", "位 e", "eg 專", "案與", " bench-correction 子", "bot 的資料位", "置。"]);
    line({ type: "assistant", parent_tool_use_id: null, message: { id: "m2", role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } });
    block(["Found ", "it in ", "data/."]);
    h.result(head, "Found it in data/.");
    expect(h.items.filter((i) => i.kind === "subagentText")).toEqual([
      { kind: "subagentText", parent: task_id, text: "正在定位 eeg 專案與 bench-correction 子bot 的資料位置。" },
      { kind: "subagentText", parent: task_id, text: "Found it in data/." },
    ]);
    const order = h.items.map((i) => i.kind === "toolUse" && i.parent === task_id ? "tool" : i.kind === "subagentText" ? "text" : null).filter(Boolean);
    expect(order).toEqual(["text", "tool", "text"]);
  });

  it("is steered while it works: the words go into the same process and run", async () => {
    const h = harness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Long job" }) as any;
    const sent: any = await h.workers.tool("app_send_message", { task_id, message: "Also check the tests" });
    expect(sent).toMatchObject({ status: "steered", run: 1 });
    expect(h.heads).toHaveLength(1);
    expect(h.heads[0]!.sent.map((m) => m.text)).toEqual(["Long job", "Also check the tests"]);
    // Read into the turn: one result ends the run (after the short wait for a turn of its own).
    h.result(h.heads[0]!, "Both done.");
    expect(h.reports).toHaveLength(0);
    await wait();
    expect(h.reports).toHaveLength(1);
  });

  it("waits for a steered message that got a turn of its own before it reports", async () => {
    const h = harness(undefined, { settleMs: 1_000 });
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Job" }) as any;
    h.workers.sendToWorker(task_id, "Then this");
    const head = h.heads[0]!;
    h.result(head, "First part.");
    h.say(head, { kind: "command", id: head.sent[1]!.uuid, state: "started" });
    expect(h.reports).toHaveLength(0);
    h.result(head, "Second part.");
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.text).toContain("Second part.");
  });

  it("reports when a steered message was read into the turn under way (its turn start came before the one result)", async () => {
    // Real claude 2.1.x: a line read in at the turn's next step still gets command_lifecycle "started" (with no init)
    // before that turn's only result; one of its own gets "started" + init after the result.
    const h = harness(undefined, { settleMs: 1_000 });
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Job" }) as any;
    const head = h.heads[0]!;
    h.say(head, { kind: "init", sessionId: head.config.sessionId });
    expect(h.workers.sendToWorker(task_id, "Also this")).toEqual({ ok: true, how: "steered", run: 1 });
    h.say(head, { kind: "command", id: head.sent[1]!.uuid, state: "queued" });
    h.say(head, { kind: "command", id: head.sent[1]!.uuid, state: "started" });
    h.result(head, "Both done.");
    expect(h.reports.map((r) => r.run)).toEqual([1]);
    expect(h.reports[0]!.text).toContain("Both done.");
    expect(h.workers.listWorkers()[0]).toMatchObject({ state: "idle", run: 1 });
    // The next message is a new run in the kept-alive process, not steering into a run that ended.
    expect(h.workers.sendToWorker(task_id, "Status?")).toEqual({ ok: true, how: "newRun", run: 2 });
    expect(h.heads).toHaveLength(1);
    h.say(head, { kind: "command", id: head.sent[2]!.uuid, state: "started" });
    h.say(head, { kind: "init", sessionId: head.config.sessionId });
    h.result(head, "Status: done.");
    expect(h.reports.map((r) => r.run)).toEqual([1, 2]);
    expect(h.reports[1]!.text).toContain("Status: done.");
    await wait();
    expect(h.reports).toHaveLength(2);
  });

  it("continues in the kept-alive process, then with --resume of its own session once that process is gone", async () => {
    const h = harness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "One" }) as any;
    const first = h.heads[0]!;
    h.say(first, { kind: "init", sessionId: first.config.sessionId });
    h.result(first, "One done.");
    expect(h.workers.sendToWorker(task_id, "Two")).toEqual({ ok: true, how: "newRun", run: 2 });
    expect(h.heads).toHaveLength(1);
    expect(first.sent.map((m) => m.text)).toEqual(["One", "Two"]);
    h.result(first, "Two done.");
    expect(h.reports.map((r) => r.run)).toEqual([1, 2]);
    first.finish(); // its keep-alive ran out
    expect(h.workers.sendToWorker(task_id, "Three")).toEqual({ ok: true, how: "newRun", run: 3 });
    const second = h.heads[1]!;
    expect(second.config).toMatchObject({ resume: true, sessionId: first.config.sessionId, cwd: h.cwd });
    expect(h.items.filter((i) => i.kind === "subagentStarted").map((i) => i.execution.run)).toEqual([1, 2, 3]);
  });

  it("is stopped alone by app_cancel_task: its process ends, no report; a later message starts its next run on its session", async () => {
    const h = harness();
    const a = await h.workers.tool("app_handoff", { instructions: "A" }) as any;
    const b = await h.workers.tool("app_handoff", { instructions: "B" }) as any;
    h.say(h.heads[0]!, { kind: "init", sessionId: h.heads[0]!.config.sessionId });
    expect(await h.workers.tool("app_cancel_task", { task_id: a.task_id })).toMatchObject({ status: "stopped" });
    expect(h.heads[0]!.terminated).toBe(true);
    expect(h.heads[1]!.terminated).toBe(false);
    expect(h.items).toContainEqual(expect.objectContaining({ kind: "subagentEnded", id: a.task_id, status: "stopped" }));
    expect(h.reports).toEqual([]);
    expect(h.workers.running).toEqual([b.task_id]);
    expect(await h.workers.stopWorker(a.task_id)).toBe(false);
    expect(h.workers.sendToWorker(a.task_id, "again")).toMatchObject({ ok: true, how: "newRun", run: 2 });
    expect(h.heads[2]!.config).toMatchObject({ resume: true, sessionId: h.heads[0]!.config.sessionId });
  });

  it("fails and reports when its process crashes before a result", async () => {
    const h = harness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Crash" }) as any;
    h.heads[0]!.exit(3);
    expect(h.items.at(-1)).toMatchObject({ kind: "subagentEnded", id: task_id, status: "failed" });
    expect(h.reports[0]!.text).toContain('status="failed"');
    expect(h.reports[0]!.text).toContain("exit 3");
    expect(h.workers.listWorkers()[0]!.state).toBe("failed");
  });

  it("takes the Agent tool's names for its instructions and name (models carry them over)", async () => {
    const h = harness();
    await h.workers.tool("app_handoff", { task: "Count the files", name: "Counter" });
    await h.workers.tool("app_handoff", { prompt: "Read the README", description: "Reader" });
    expect(h.heads.map((head) => head.sent[0]!.text)).toEqual(["Count the files", "Read the README"]);
    expect(h.workers.listWorkers().map((w) => w.name)).toEqual(["Counter", "Reader"]);
  });

  it("refuses a stale run, an unknown task and empty instructions", async () => {
    const h = harness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "x" }) as any;
    await expect(h.workers.tool("app_send_message", { task_id, run: 7, message: "y" })).rejects.toThrow("Stale run");
    await expect(h.workers.tool("app_send_message", { task_id: "nope", message: "y" })).rejects.toThrow("Unknown task_id");
    await expect(h.workers.tool("app_handoff", { instructions: "  " })).rejects.toThrow("instructions required");
    expect(h.workers.sendToWorker("nope", "x")).toMatchObject({ ok: false });
  });

  it("routes its approvals by worker and run, and cancels open ones when the run ends", async () => {
    const h = harness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "x" }) as any;
    const head = h.heads[0]!;
    h.say(head, { kind: "permission", requestId: "p1", tool: "Bash", summary: "rm", input: { command: "rm x" } });
    const asked = h.items.at(-1);
    expect(asked).toMatchObject({ kind: "permission", requestId: `worker:${task_id}:1:p1`, workerId: task_id });
    expect(h.workers.answer(asked.requestId, true, { command: "rm x" })).toBe(true);
    expect(head.answers).toEqual([["p1", true, { command: "rm x" }, undefined]]);
    expect(h.workers.answer(asked.requestId, true, {})).toBe(false);
    h.say(head, { kind: "permission", requestId: "p2", tool: "Bash", summary: "ls", input: {} });
    h.result(head, "done");
    expect(h.items).toContainEqual({ kind: "permissionCancelled", requestId: `worker:${task_id}:1:p2` });
  });
});

describe("through the shared worker core", () => {
  const request = { id: "r1", sample: { outputTokens: 120, startMs: 0, endMs: 2_000, complete: true } };
  const measurement = { threadId: "t", turnId: "u", workerId: null, parentThreadId: null, run: null, output: 120 };

  it("forwards its tok/s samples with the worker as scope and its measurements with the worker's id", async () => {
    const h = harness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Measure" }) as any;
    const head = h.heads[0]!;
    h.say(head, { kind: "request", request: { ...request, scope: null } });
    h.say(head, { kind: "measurement", provider: "claude", measurement });
    expect(h.items).toContainEqual({ kind: "request", request: expect.objectContaining({ id: "r1", scope: task_id }) });
    expect(h.items).toContainEqual({ kind: "measurement", provider: "claude", measurement: expect.objectContaining({ threadId: "t", workerId: task_id, run: 1, output: 120 }) });
  });

  it("counts a run's output as thread:<session>:run<n> and turns the process's running cost into each run's spend", async () => {
    const h = harness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Count" }) as any;
    const head = h.heads[0]!;
    const session = head.config.sessionId;
    h.say(head, { kind: "init", sessionId: session });
    const usage = (totalCost: number, output: number) => h.say(head, { kind: "usage", totalCost, tokens: { input: 1, output, cacheCreation: 0, cacheRead: 0 } });
    usage(0.25, 30);
    usage(0.5, 20);
    h.result(head, "One.");
    expect(h.workers.sendToWorker(task_id, "Two")).toEqual({ ok: true, how: "newRun", run: 2 });
    usage(0.8, 5);
    h.result(head, "Two.");
    expect(h.items.filter((i) => i.kind === "subagentOutput")).toEqual([
      { kind: "subagentOutput", id: task_id, counter: `thread:${session}:run1`, tokens: 30 },
      { kind: "subagentOutput", id: task_id, counter: `thread:${session}:run1`, tokens: 50 },
      { kind: "subagentOutput", id: task_id, counter: `thread:${session}:run2`, tokens: 5 },
    ]);
    const costs = h.items.filter((i) => i.kind === "usage").map((i) => Math.round(i.totalCost * 100) / 100);
    expect(costs).toEqual([0.25, 0.25, 0.3]);
  });

  it("shows a message's words once when one assistant line carries both text and a tool call", async () => {
    const h = harness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Mixed" }) as any;
    const head = h.heads[0]!;
    const line = (message: unknown) => { for (const item of parseLine(JSON.stringify(message))) h.say(head, item); };
    line({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    for (const text of ["Let me ", "look."]) line({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
    line({ type: "assistant", parent_tool_use_id: null, message: { id: "m", role: "assistant", content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } });
    line({ type: "assistant", parent_tool_use_id: null, message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Plain whole message." }, { type: "tool_use", id: "tu2", name: "Bash", input: { command: "pwd" } }] } });
    h.result(head, "Done.");
    expect(h.items.filter((i) => i.kind === "subagentText" && i.parent === task_id).map((i) => i.text)).toEqual(["Let me look.", "Plain whole message."]);
  });

  it("fails a run that ended normally without any words, and reports the last text block when the result itself is empty", async () => {
    const h = harness();
    const a = await h.workers.tool("app_handoff", { instructions: "Silent" }) as any;
    h.result(h.heads[0]!, "");
    expect(h.items.at(-1)).toMatchObject({ kind: "subagentEnded", id: a.task_id, status: "failed", summary: expect.stringContaining("ended without a report") });
    const b = await h.workers.tool("app_handoff", { instructions: "Wrote first" }) as any;
    h.say(h.heads[1]!, { kind: "assistantText", text: "The answer is 42." });
    h.result(h.heads[1]!, "");
    expect(h.items.at(-1)).toEqual({ kind: "subagentEnded", id: b.task_id, status: "completed", summary: "The answer is 42." });
  });

  it("reports the engine's error for a failed result", async () => {
    const h = harness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Err" }) as any;
    h.result(h.heads[0]!, "API Error: overloaded", false);
    expect(h.items.at(-1)).toMatchObject({ kind: "subagentEnded", id: task_id, status: "failed", summary: "API Error: overloaded" });
    expect(h.reports[0]!.text).toContain('status="failed"');
  });

  it("keeps a kept-alive process's approvals between runs from reaching anyone", async () => {
    const h = harness();
    await h.workers.tool("app_handoff", { instructions: "x" });
    const head = h.heads[0]!;
    h.result(head, "done");
    const before = h.items.length;
    h.say(head, { kind: "permission", requestId: "late", tool: "Bash", summary: "rm", input: {} });
    expect(head.answers).toEqual([["late", false, {}, "Not now: this worker's run has ended."]]);
    expect(h.items.length).toBe(before);
  });

  it("writes every state change to claude-workers.json through the core's ledger record", async () => {
    const h = harness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Ledger" }) as any;
    expect(h.workers.core.get(task_id)).toMatchObject({ status: "running", run: 1, adapter: "claude-process", engine: "claude" });
    h.result(h.heads[0]!, "Done.");
    expect(h.workers.core.get(task_id)).toMatchObject({ status: "done", report: { state: "acknowledged", text: "Done.", status: "done" } });
  });
});

describe("quitting and restoring", () => {
  it("marks a running worker interrupted when the app quits, and restores it from claude-workers.json to resume its session", async () => {
    const h = claudeHarness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Long" }) as any;
    const session = h.heads[0]!.config.sessionId;
    h.say(h.heads[0]!, { kind: "init", sessionId: session });
    await h.workers.close();
    expect(h.heads[0]!.terminated).toBe(true);
    // The event says what the journal says: interrupted (it used to say "stopped").
    expect(h.items.at(-1)).toMatchObject({ kind: "subagentEnded", id: task_id, status: "interrupted" });
    expect(h.reports).toEqual([]);
    expect(JSON.parse(readFileSync(join(h.dir, "claude-workers.json"), "utf8")).workers[0]).toMatchObject({ id: task_id, status: "interrupted", interrupted: true, active: false });
    const again = harness(h.dir);
    expect(again.workers.listWorkers()).toEqual([expect.objectContaining({ id: task_id, state: "interrupted", run: 1, conversationId: session })]);
    expect(again.heads).toEqual([]);
    expect(again.workers.sendToWorker(task_id, "Carry on")).toEqual({ ok: true, how: "newRun", run: 2 });
    expect(again.heads[0]!.config).toMatchObject({ resume: true, sessionId: session });
  });

  it("restores one that was at work when the app crashed as interrupted, without replaying it", async () => {
    const h = claudeHarness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Crash me" }) as any;
    // No close(): the journal still says it is active.
    const again = harness(h.dir);
    expect(again.workers.listWorkers()[0]).toMatchObject({ id: task_id, state: "interrupted" });
    expect(again.heads).toEqual([]);
    expect(JSON.parse(readFileSync(join(h.dir, "claude-workers.json"), "utf8")).workers[0]).toMatchObject({ active: false, interrupted: true });
  });

  it("hands a report the coordinator could not take over again, once", async () => {
    const h = harness();
    h.refuseReports();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "x" }) as any;
    h.result(h.heads[0]!, "Result.");
    expect(h.workers.listWorkers()[0]!.state).toBe("reportPending");
    const again = harness(h.dir);
    again.workers.redeliver();
    expect(again.reports).toEqual([expect.objectContaining({ id: task_id, run: 1 })]);
    again.workers.redeliver();
    expect(again.reports).toHaveLength(1);
  });
});

describe("agent definitions", () => {
  it("takes the prompt, model and tools of .claude/agents/<type>.md", async () => {
    const h = harness();
    mkdirSync(join(h.cwd, ".claude", "agents"), { recursive: true });
    writeFileSync(join(h.cwd, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews code\nmodel: haiku\ntools: Read, Grep\n---\nYou review code carefully.\n");
    await h.workers.tool("app_handoff", { instructions: "Review", subagent_type: "reviewer" });
    expect(h.heads[0]!.config).toMatchObject({ model: "haiku", tools: ["Read", "Grep"] });
    expect(h.heads[0]!.config.systemPrompt).toBe(`${CLAUDE_WORKER_POLICY}\n\nYou review code carefully.`);
    await h.workers.tool("app_handoff", { instructions: "Quick", subagent_type: "reviewer", model: "opus" });
    expect(h.heads[1]!.config.model).toBe("opus");
  });
  it("runs a built-in type as a plain worker and refuses what it cannot reproduce", async () => {
    const h = harness();
    await h.workers.tool("app_handoff", { instructions: "Explore", subagent_type: "Explore" });
    expect(h.heads[0]!.config.systemPrompt).toBe(CLAUDE_WORKER_POLICY);
    await expect(h.workers.tool("app_handoff", { instructions: "x", subagent_type: "missing-agent" })).rejects.toThrow("No agent definition");
    mkdirSync(join(h.cwd, ".claude", "agents"), { recursive: true });
    writeFileSync(join(h.cwd, ".claude", "agents", "hooked.md"), "---\nname: hooked\nhooks: something\n---\nBody\n");
    expect(loadAgentDefinition("hooked", h.cwd, { home: join(h.dir, "home") })).toMatchObject({ error: expect.stringContaining("cannot reproduce") });
    expect(h.heads).toHaveLength(1);
  });
  it("cannot start without the coordinator's config", async () => {
    const h = harness(undefined, { base: null });
    await expect(h.workers.tool("app_handoff", { instructions: "x" })).rejects.toThrow("unavailable");
  });
});
