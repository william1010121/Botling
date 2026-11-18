// Claude's app-managed workers (claude-workers.ts) with a fake ClaudeHead: a run's start and report, steering a
// running worker, a follow-up in the kept-alive process and after it ended (`--resume` of its own session), cancel,
// a crash, the app quitting (interrupted), restore from claude-workers.json, approvals and agent definitions.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeWorkers, CLAUDE_WORKER_POLICY, loadAgentDefinition, type RemoteWorkerHost } from "../../src/core/agent/claude-workers";
import { BACKGROUND_WAIT_CAP_MS } from "../../src/core/agent/background-cap";
import { claudeHarness } from "../claude-workers-fake";
import { parseLine } from "../../src/core/agent/stream";
import { API_RETRY_NOTE } from "../../src/core/api-retry";
import { headArguments, type HeadConfig } from "../../src/core/agent/head";
import { launchSettings, workerExtraDirs } from "../../src/core/settings";

const CLOUDFLARE = "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare";
/** claude 2.1.323's lines for a turn the API turned away: its error message, then a result with is_error and the status. */
function apiError(say: (item: any) => void, status: number, text: string) {
  const lines = [
    { type: "assistant", parent_tool_use_id: null, is_api_error_message: true, api_error_status: status, error: "authentication_failed", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] } },
    { type: "result", subtype: "success", is_error: true, api_error_status: status, result: text, session_id: "s" },
  ];
  for (const line of lines) for (const item of parseLine(JSON.stringify(line))) say(item);
}
const withRetryDelays = async (ms: string, body: () => Promise<void>) => {
  const before = process.env.BOTLING_API_RETRY_MS;
  process.env.BOTLING_API_RETRY_MS = ms;
  try { await body(); } finally { if (before === undefined) delete process.env.BOTLING_API_RETRY_MS; else process.env.BOTLING_API_RETRY_MS = before; }
};

const made: ClaudeWorkers[] = [];
afterEach(async () => { for (const w of made.splice(0)) await w.close(); });
const harness = (...args: Parameters<typeof claudeHarness>) => { const h = claudeHarness(...args); made.push(h.workers); return h; };
const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a Claude worker's run", () => {
  it("starts its own claude process in the host folder with the worker policy, its own session and of the app tools app_notify_owner and the browser tools", async () => {
    const h = harness();
    const r: any = await h.workers.tool("app_handoff", { name: "Research", instructions: "Look up the API" });
    expect(r).toMatchObject({ accepted: true, run: 1 });
    const head = h.heads[0]!;
    expect(head.config).toMatchObject({ cwd: h.cwd, resume: false, model: "sonnet", persistSession: true });
    expect(head.config.appMcp?.tools.map((tool: { name: string }) => tool.name)).toEqual(["app_notify_owner", "app_browser_tabs", "app_browser_open", "app_browser_requests", "app_browser_extract", "app_note_outline", "app_note_read", "app_note_search"]);
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

  it("a run into the kept-alive process is shown on the model and effort that process runs, not a setting changed since", async () => {
    let model: string | null = "sonnet";
    const h = harness(undefined, { subagentModel: () => model });
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "One" }) as any;
    const first = h.heads[0]!;
    h.say(first, { kind: "init", sessionId: first.config.sessionId });
    h.result(first, "One done.");
    model = "opus"; // the bot's workers' model changed while the process stays
    expect(h.workers.sendToWorker(task_id, "Two")).toEqual({ ok: true, how: "newRun", run: 2 });
    expect(h.heads).toHaveLength(1);
    const runtimes = h.items.filter((i) => i.kind === "subagentRuntime" && i.id === task_id);
    expect(runtimes.at(-1)).toMatchObject({ model: "sonnet" });
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

  it("forwards its tok/s samples with the worker as scope", async () => {
    const h = harness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Measure" }) as any;
    const head = h.heads[0]!;
    h.say(head, { kind: "request", request: { ...request, scope: null } });
    expect(h.items).toContainEqual({ kind: "request", request: expect.objectContaining({ id: "r1", scope: task_id }) });
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
    h.result(h.heads[0]!, "API Error: 400 prompt is too long", false);
    expect(h.items.at(-1)).toMatchObject({ kind: "subagentEnded", id: task_id, status: "failed", summary: "API Error: 400 prompt is too long" });
    expect(h.reports[0]!.text).toContain('status="failed"');
  });

  it("tries its turn again in the same process after Cloudflare's 403, instead of failing with claude's words", () => withRetryDelays("30,30,30", async () => {
    const h = harness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Draw the flowchart" }) as any;
    const head = h.heads[0]!;
    h.say(head, { kind: "init", sessionId: head.config.sessionId });
    h.say(head, { kind: "toolUse", id: "tu1", tool: "Write", title: "Write a.md", detail: "a.md", parent: null, input: {} });
    h.say(head, { kind: "toolResult", id: "tu1", output: "ok", failed: false, parent: null, launch: null });
    apiError((item) => h.say(head, item), 403, CLOUDFLARE);
    // Not ended, not reported: it waits, and its row says so.
    expect(h.items.some((i) => i.kind === "subagentEnded")).toBe(false);
    expect(h.reports).toHaveLength(0);
    expect(h.items).toContainEqual(expect.objectContaining({ kind: "subagentWaitingOn", id: task_id, on: expect.objectContaining({ kind: "apiRetry", title: "API 暫時擋住，1 秒後重試（1/3）" }) }));
    expect(h.workers.listWorkers()[0]!.state).toBe("running");
    await wait(60);
    // The same process and session go on: told to carry on, not sent the task again (its Write stays done once).
    expect(h.heads).toHaveLength(1);
    expect(head.sent.map((m) => m.text)).toEqual(["Draw the flowchart", API_RETRY_NOTE]);
    expect(h.items).toContainEqual({ kind: "subagentWaitingOn", id: task_id, on: null });
    h.result(head, "Flowchart drawn.");
    expect(h.items.at(-1)).toEqual({ kind: "subagentEnded", id: task_id, status: "completed", summary: "Flowchart drawn." });
    expect(h.items.filter((i) => i.kind === "subagentText").map((i) => i.text).join("")).not.toContain("Cloudflare");
    expect(h.reports[0]!.text).not.toContain("Cloudflare");
  }));

  it("does not try again after a 401 (a real sign-in problem): it fails with claude's words", () => withRetryDelays("10,10,10", async () => {
    const h = harness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Job" }) as any;
    const text = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
    apiError((item) => h.say(h.heads[0]!, item), 401, text);
    expect(h.items.at(-1)).toMatchObject({ kind: "subagentEnded", id: task_id, status: "failed", summary: expect.stringContaining(text) });
    await wait(40);
    expect(h.heads[0]!.sent).toHaveLength(1);
  }));

  it("gives up after its tries and fails in plain words, not claude's raw error", () => withRetryDelays("5,5,5", async () => {
    const h = harness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Job" }) as any;
    const head = h.heads[0]!;
    for (let attempt = 1; attempt <= 3; attempt++) {
      apiError((item) => h.say(head, item), 403, CLOUDFLARE);
      expect(h.items.some((i) => i.kind === "subagentEnded")).toBe(false);
      await wait(30);
      expect(head.sent).toHaveLength(1 + attempt);
    }
    apiError((item) => h.say(head, item), 403, CLOUDFLARE);
    const ended = h.items.at(-1);
    expect(ended).toMatchObject({ kind: "subagentEnded", id: task_id, status: "failed" });
    expect(ended.summary).toMatch(/^Claude 的 API 暫時擋住了這次的請求，重試 3 次後仍然失敗/);
    expect(h.reports[0]!.text).toContain('status="failed"');
    // A next run starts counting again.
    await h.workers.tool("app_send_message", { task_id, message: "Try once more" });
    apiError((item) => h.say(head, item), 403, CLOUDFLARE);
    expect(h.items.filter((i) => i.kind === "subagentEnded")).toHaveLength(1);
  }));

  it("words sent while it waits to try again go on with the turn in place of the retry", () => withRetryDelays("40", async () => {
    const h = harness();
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Job" }) as any;
    const head = h.heads[0]!;
    apiError((item) => h.say(head, item), 529, 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
    expect(await h.workers.tool("app_send_message", { task_id, message: "Also do X" })).toMatchObject({ status: "steered" });
    await wait(80);
    expect(head.sent.map((m) => m.text)).toEqual(["Job", "Also do X"]);
  }));

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
  it("takes any full Claude model id, not only the three aliases, and the refusal names no one model", async () => {
    const h = harness();
    await h.workers.tool("app_handoff", { instructions: "New model", model: "claude-fable-5-2" });
    expect(h.heads[0]!.config.model).toBe("claude-fable-5-2");
    // A definition may name one too.
    mkdirSync(join(h.cwd, ".claude", "agents"), { recursive: true });
    writeFileSync(join(h.cwd, ".claude", "agents", "fresh.md"), "---\nname: fresh\nmodel: claude-haiku-5-5\n---\nBe quick.\n");
    await h.workers.tool("app_handoff", { instructions: "Fresh", subagent_type: "fresh" });
    expect(h.heads[1]!.config.model).toBe("claude-haiku-5-5");
    // Not a Claude model: refused, nothing started, and the message points at the general rule.
    const before = h.heads.length;
    await expect(h.workers.tool("app_handoff", { instructions: "Bad", model: "gpt-6-luna" })).rejects.toThrow(/Unknown model "gpt-6-luna".*full Claude model id/);
    expect(h.heads).toHaveLength(before);
    writeFileSync(join(h.cwd, ".claude", "agents", "odd.md"), "---\nname: odd\nmodel: gpt-6\n---\nx\n");
    await expect(h.workers.tool("app_handoff", { instructions: "Odd", subagent_type: "odd" })).rejects.toThrow(/unknown model "gpt-6"/);
    expect(h.heads).toHaveLength(before);
  });
  it("takes an effort: the handoff's, else the definition's, else the bot's subagent effort, else the coordinator's (`--effort`)", async () => {
    const h = harness(undefined, { subagentEffort: "low" });
    mkdirSync(join(h.cwd, ".claude", "agents"), { recursive: true });
    writeFileSync(join(h.cwd, ".claude", "agents", "deep.md"), "---\nname: deep\neffort: max\n---\nThink hard.\n");
    const first: any = await h.workers.tool("app_handoff", { instructions: "A", effort: "xhigh" });
    expect(first.effort).toBe("xhigh");
    expect(h.heads[0]!.config.effort).toBe("xhigh");
    expect(h.items).toContainEqual(expect.objectContaining({ kind: "subagentRuntime", id: first.task_id, runtime: { engine: "claude", reasoningEffort: "xhigh" } }));
    await h.workers.tool("app_handoff", { instructions: "B", subagent_type: "deep" });
    expect(h.heads[1]!.config.effort).toBe("max");
    await h.workers.tool("app_handoff", { instructions: "C", subagent_type: "deep", effort: "medium" });
    expect(h.heads[2]!.config.effort).toBe("medium");
    await h.workers.tool("app_handoff", { instructions: "D" });
    expect(h.heads[3]!.config.effort).toBe("low");
    const plain = harness();
    await plain.workers.tool("app_handoff", { instructions: "E" });
    expect(plain.heads[0]!.config.effort).toBe("high");
  });
  it("ignores an effort Claude does not take, says so, and runs at the effort it would have had", async () => {
    const h = harness();
    const r: any = await h.workers.tool("app_handoff", { instructions: "A", effort: "turbo" });
    expect(r).toMatchObject({ accepted: true, effort: "high" });
    expect(r.notice).toContain('"turbo"');
    expect(r.notice).toContain("low, medium, high, xhigh, max");
    expect(h.heads[0]!.config.effort).toBe("high");
    mkdirSync(join(h.cwd, ".claude", "agents"), { recursive: true });
    writeFileSync(join(h.cwd, ".claude", "agents", "odd.md"), "---\nname: odd\neffort: ultra\n---\nBody\n");
    expect(loadAgentDefinition("odd", h.cwd, { home: join(h.dir, "home") })).toMatchObject({ effort: null, effortIgnored: "ultra" });
    const odd: any = await h.workers.tool("app_handoff", { instructions: "B", subagent_type: "odd" });
    expect(odd.notice).toContain('"ultra"');
    expect(h.heads[1]!.config.effort).toBe("high");
    const quiet: any = await h.workers.tool("app_handoff", { instructions: "C" });
    expect(quiet.notice).toBeUndefined();
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
  it("refuses a handoff whose process cannot be started: nothing is recorded, nothing is shown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "botling-claude-workers-"));
    const items: unknown[] = [];
    const workers = new ClaudeWorkers({ file: join(dir, "claude-workers.json"), ownerSessionId: () => "coordinator", base: () => ({ command: "claude", cwd: dir, sessionId: "c", resume: false, allowedTools: [] }), cwd: () => dir, subagentModel: () => null },
      (item) => items.push(item), () => true, () => { throw new Error("spawn EACCES"); });
    made.push(workers);
    await expect(workers.tool("app_handoff", { instructions: "x" })).rejects.toThrow("spawn EACCES");
    expect(workers.listWorkers()).toEqual([]);
    expect(items).toEqual([]);
  });
  it("cannot start without the coordinator's config", async () => {
    const h = harness(undefined, { base: null });
    await expect(h.workers.tool("app_handoff", { instructions: "x" })).rejects.toThrow("unavailable");
  });
});

describe("review round 2", () => {
  it("D a stop whose terminate fails is not clean: the worker stays blocked, and a later recovery ends the process first", async () => {
    const h = claudeHarness();
    const started: any = await h.workers.tool("app_handoff", { instructions: "Go." });
    const head = h.heads[0]!;
    let fail = true;
    head.terminate = async function () { if (fail) throw new Error("kill failed"); this.terminated = true; this.exit(null, true); return { killed: [], forced: false }; };
    expect(await h.workers.stopWorker(started.task_id)).toBe(true);
    expect(h.workers.core.get(started.task_id)).toMatchObject({ status: "stopped", cleanup: "failed", recovery: "required" });
    expect(await h.workers.sendToWorker(started.task_id, "Again.")).toMatchObject({ ok: false });
    fail = false;
    expect(await h.workers.sendToWorker(started.task_id, "Again.")).toMatchObject({ ok: true, run: 2 });
    expect(head.terminated).toBe(true);
  });
});

describe("review round 3", () => {
  it("#3 a terminate that resolves with the process tree still alive is not clean: blocked, head kept, ended by recovery first", async () => {
    const h = claudeHarness();
    const started: any = await h.workers.tool("app_handoff", { instructions: "Go." });
    const head = h.heads[0]!;
    let alive = true;
    head.terminate = async function () { if (alive) return { killed: [1], forced: true, alive: true }; this.terminated = true; this.exit(null, true); return { killed: [1], forced: false }; };
    expect(await h.workers.stopWorker(started.task_id)).toBe(true);
    expect(h.workers.core.get(started.task_id)).toMatchObject({ status: "stopped", cleanup: "failed", recovery: "required" });
    expect(await h.workers.sendToWorker(started.task_id, "Again.")).toMatchObject({ ok: false });
    expect(h.heads).toHaveLength(1);
    alive = false;
    expect(await h.workers.sendToWorker(started.task_id, "Again.")).toMatchObject({ ok: true, run: 2 });
    expect(head.terminated).toBe(true);
  });
});

describe("review round 4", () => {
  it("#3 its process's leader exiting does not drop its tree: a recovery still ends and confirms the tree before a next run", async () => {
    const h = claudeHarness();
    const started: any = await h.workers.tool("app_handoff", { instructions: "Go." });
    const head = h.heads[0]!;
    let alive = true;
    head.terminate = async function () { return alive ? { killed: [1], forced: true, alive: true } : { killed: [1], forced: false }; };
    expect(await h.workers.stopWorker(started.task_id)).toBe(true);
    expect(h.workers.core.get(started.task_id)).toMatchObject({ cleanup: "failed" });
    // The leader exits; its group is not confirmed gone.
    head.exit(null, true);
    expect(await h.workers.sendToWorker(started.task_id, "Again.")).toMatchObject({ ok: false });
    expect(h.heads).toHaveLength(1);
    alive = false;
    expect(await h.workers.sendToWorker(started.task_id, "Again.")).toMatchObject({ ok: true, run: 2 });
  });
});

describe("background work its process left running", () => {
  const bg = { kind: "backgroundStarted", id: "bg1", description: "Write deploy record and update TODO", monitor: false };
  const waits = (h: ReturnType<typeof harness>) => h.items.filter((i) => i.kind === "subagentWaitingOn");

  it("keeps its process past the keep-alive while a background command runs, so the next run goes in at once", async () => {
    const h = harness(undefined, { keepAliveMs: 10 });
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Deploy" }) as any;
    const head = h.heads[0]!;
    h.say(head, bg);
    h.result(head, "Deployed.");
    await wait(40);
    expect(head.finished).toBe(false);
    expect(h.workers.sendToWorker(task_id, "Next deploy")).toEqual({ ok: true, how: "newRun", run: 2 });
    expect(head.sent.map((m) => m.text)).toEqual(["Deploy", "Next deploy"]);
    expect(waits(h)).toEqual([]);
    h.result(head, "Next done.");
    // Its background command ends: the keep-alive may end the process again.
    h.say(head, { kind: "subagentEnded", id: "bg1", status: "killed", summary: null });
    await wait(40);
    expect(head.finished).toBe(true);
  });

  it("never sends into a process whose stdin it closed: the run waits, says what for, takes steers, then goes into a resumed process", async () => {
    const h = harness(undefined, { keepAliveMs: 10 });
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Deploy" }) as any;
    const old = h.heads[0]!;
    h.say(old, { kind: "init", sessionId: old.config.sessionId });
    // Its stdin is closed, but claude stays until what it left in the background is done.
    old.finish = function () { this.finished = true; };
    h.result(old, "Deployed.");
    await wait(40);
    expect(old.finished).toBe(true);
    expect(h.workers.sendToWorker(task_id, "Run five")).toEqual({ ok: true, how: "newRun", run: 2 });
    expect(old.sent.map((m) => m.text)).toEqual(["Deploy"]);
    expect(waits(h).at(-1)).toMatchObject({ id: task_id, on: { kind: "process", queued: 1 } });
    expect(h.workers.sendToWorker(task_id, "Faster please")).toEqual({ ok: true, how: "steered", run: 2 });
    expect(waits(h).at(-1)).toMatchObject({ id: task_id, on: { queued: 2 } });
    // The old process's last turn (its background command's notice) is not this run's end.
    h.result(old, "The background command was stopped.");
    await wait(20);
    expect(h.reports.map((r) => r.run)).toEqual([1]);
    old.exit(0, true);
    await wait(20);
    const fresh = h.heads[1]!;
    expect(fresh.config).toMatchObject({ resume: true, sessionId: old.config.sessionId });
    expect(fresh.sent.map((m) => m.text)).toEqual(["Run five\n\nFaster please"]);
    expect(waits(h).at(-1)).toEqual({ kind: "subagentWaitingOn", id: task_id, on: null });
    h.result(fresh, "Run five done.");
    await wait(20);
    expect(h.reports.map((r) => r.run)).toEqual([1, 2]);
  });

  it("names the background command it waits for, and when it started", async () => {
    const h = harness(undefined, { keepAliveMs: 10 });
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Deploy" }) as any;
    const old = h.heads[0]!;
    old.finish = function () { this.finished = true; };
    h.say(old, bg);
    h.result(old, "Deployed.");
    // A stop of the keep-alive for another reason (it already closed stdin) leaves the command running.
    (h.workers as any).adapter.procs.get(task_id).finishing = old;
    const before = Date.now();
    expect(h.workers.sendToWorker(task_id, "Run five")).toMatchObject({ ok: true, run: 2 });
    const on = waits(h).at(-1)!.on;
    expect(on).toMatchObject({ kind: "command", title: "Write deploy record and update TODO", queued: 1 });
    expect(on.since).toBeLessThanOrEqual(before);
  });
});

describe("a Monitor the worker started (2026-11-18: workers may use Monitor; the row says so while it runs)", () => {
  const used = { kind: "toolUse", id: "mon1", tool: "Monitor", title: "Monitor", detail: "tail -f deploy.log", parent: null, input: { command: "tail -f deploy.log" } };
  const started = { kind: "backgroundStarted", id: "mon1", description: "watch the deploy log", monitor: false };
  const ended = { kind: "subagentEnded", id: "mon1", status: "completed", summary: null };
  const waits = (h: ReturnType<typeof harness>) => h.items.filter((i) => i.kind === "subagentWaitingOn");
  const open = async () => {
    const h = harness(undefined, { keepAliveMs: 10 });
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Watch the deploy" }) as any;
    return { h, task_id, head: h.heads[0]! };
  };

  it("keeps the run at work while its Monitor lives, says Monitor running, and reports once the Monitor's wake turn is done", async () => {
    const { h, task_id, head } = await open();
    h.say(head, used); h.say(head, started);
    h.result(head, "Monitor started; waiting for the deploy.");
    await wait(30);
    expect(h.reports).toEqual([]);
    expect(waits(h).at(-1)).toMatchObject({ id: task_id, on: { kind: "monitorRunning", title: "watch the deploy log", queued: 0 } });
    expect(head.finished).toBe(false);
    // The Monitor ends; its wake turn is the run's own and ends it, with both turns' words.
    h.say(head, ended);
    expect(waits(h).at(-1)).toEqual({ kind: "subagentWaitingOn", id: task_id, on: null });
    h.result(head, "The deploy finished: ok.");
    await wait(20);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.text).toContain("Monitor started; waiting for the deploy.");
    expect(h.reports[0]!.text).toContain("The deploy finished: ok.");
  });

  it("a background command that is not a Monitor still ends the run at its first result", async () => {
    const { h, head } = await open();
    h.say(head, { kind: "toolUse", id: "bg1", tool: "Bash", title: "Bash", detail: "sleep 30", parent: null, input: {} });
    h.say(head, { kind: "backgroundStarted", id: "bg1", description: "sleep", monitor: false });
    h.result(head, "Started it in the background.");
    await wait(20);
    expect(h.reports.map((r) => r.run)).toEqual([1]);
    expect(waits(h)).toEqual([]);
  });

  it("a Monitor on a socket or an MCP server (monitor: true) holds the run too", async () => {
    const { h, head } = await open();
    h.say(head, { kind: "backgroundStarted", id: "ws1", description: "watch the socket", monitor: true });
    h.result(head, "Watching.");
    await wait(20);
    expect(h.reports).toEqual([]);
    expect(waits(h).at(-1)).toMatchObject({ on: { kind: "monitorRunning", title: "watch the socket" } });
  });

  it("a failed turn is not held back for its Monitor", async () => {
    const { h, head } = await open();
    h.say(head, used); h.say(head, started);
    h.result(head, "It broke.", false);
    await wait(20);
    expect(h.reports.map((r) => r.run)).toEqual([1]);
  });

  it("a Monitor past the 50-minute cap and a minute no longer holds the report", async () => {
    const { h, task_id, head } = await open();
    h.say(head, used); h.say(head, started);
    const task = (h.workers as any).adapter.procs.get(task_id).background.get("mon1");
    task.since = Date.now() - 52 * 60_000;
    h.result(head, "Monitor started.");
    await wait(20);
    expect(h.reports.map((r) => r.run)).toEqual([1]);
    // Not held for an instant either: its row never said Monitor running.
    expect(waits(h)).toEqual([]);
  });

  it("its process ending while the Monitor lives delivers the held report instead of an error", async () => {
    const { h, head } = await open();
    h.say(head, used); h.say(head, started);
    h.result(head, "Monitor started; the log shows nothing yet.");
    await wait(20);
    expect(h.reports).toEqual([]);
    head.exit(0, true);
    await wait(30);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.text).toContain("Monitor started; the log shows nothing yet.");
  });

  it("the report goes out after the grace when the Monitor's wake turn never starts, once", async () => {
    process.env.BOTLING_MONITOR_GRACE_MS = "40";
    try {
      const { h, head } = await open();
      h.say(head, used); h.say(head, started);
      h.result(head, "Monitor started.");
      h.say(head, ended);
      await wait(10);
      expect(h.reports).toEqual([]);
      await wait(80);
      expect(h.reports.map((r) => r.run)).toEqual([1]);
      expect(h.reports[0]!.text).toContain("Monitor started.");
      // A result that comes after the run ended is nobody's report.
      h.result(head, "Late wake turn.");
      await wait(30);
      expect(h.reports).toHaveLength(1);
    } finally { delete process.env.BOTLING_MONITOR_GRACE_MS; }
  });

  it("a wake turn that outlasts the grace is not cut off: its result ends the run with both turns' words", async () => {
    process.env.BOTLING_MONITOR_GRACE_MS = "40";
    try {
      const { h, head } = await open();
      h.say(head, used); h.say(head, started);
      h.result(head, "Monitor started.");
      h.say(head, ended);
      h.say(head, { kind: "init", sessionId: "00000000-0000-4000-8000-000000000001" });
      h.say(head, { kind: "toolUse", id: "t1", tool: "Bash", title: "Bash", detail: "tail", parent: null, input: {} });
      await wait(150); // several graces, the turn is still at work
      expect(h.reports).toEqual([]);
      h.result(head, "The deploy finished: ok.");
      await wait(30);
      expect(h.reports).toHaveLength(1);
      expect(h.reports[0]!.text).toContain("Monitor started.");
      expect(h.reports[0]!.text).toContain("The deploy finished: ok.");
    } finally { delete process.env.BOTLING_MONITOR_GRACE_MS; }
  });

  // monitor-fix2: a held good report is never lost, and the oldest Monitor's cap decides once (WorkerProcess.tla MonExpire).
  const HOLD_MS = BACKGROUND_WAIT_CAP_MS + 60_000;
  const monitorAgain = { kind: "backgroundStarted", id: "mon2", description: "watch the disk", monitor: true };
  const secondEnded = { kind: "subagentEnded", id: "mon2", status: "completed", summary: null };
  const thirdStarted = { kind: "backgroundStarted", id: "mon3", description: "watch the queue", monitor: true };
  /** Its first Monitor `left` ms short of the cap (the timer on it is armed by the report). */
  const nearCap = (h: ReturnType<typeof harness>, task_id: string, left: number) => {
    (h.workers as any).adapter.procs.get(task_id).background.get("mon1").since = Date.now() - HOLD_MS + left;
  };
  const failedSummary = (h: ReturnType<typeof harness>) => h.items.filter((i) => i.kind === "subagentEnded").at(-1)!;

  it("a failed wake turn delivers the held good report together with the error (not the error alone)", async () => {
    const { h, head } = await open();
    h.say(head, used); h.say(head, started);
    h.result(head, "Monitor started; the deploy is queued.");
    await wait(20);
    expect(h.reports).toEqual([]);
    h.say(head, ended);
    h.result(head, "API Error: 400 prompt is too long", false);
    await wait(20);
    expect(h.reports).toHaveLength(1);
    expect(failedSummary(h)).toMatchObject({ status: "failed", summary: expect.stringContaining("API Error: 400 prompt is too long") });
    expect(failedSummary(h).summary).toContain("Monitor started; the deploy is queued.");
    expect(h.reports[0]!.text).toContain("Monitor started; the deploy is queued.");
  });

  it("a report that went out with a failed wake turn is not kept for the next run: that run's report is its own", async () => {
    const { h, task_id, head } = await open();
    h.say(head, used); h.say(head, started);
    h.result(head, "Monitor started; the deploy is queued.");
    h.say(head, ended);
    h.result(head, "API Error: 400 prompt is too long", false);
    await wait(20);
    expect(h.reports).toHaveLength(1);
    await h.workers.tool("app_send_message", { task_id, message: "Again" });
    // The kept-alive process may have gone to sleep by now: the next run is on the last process either way.
    h.result(h.heads.at(-1)!, "Second run done.");
    await wait(20);
    expect(h.reports).toHaveLength(2);
    expect(h.reports[1]!.text).toContain("Second run done.");
    expect(h.reports[1]!.text).not.toContain("Monitor started; the deploy is queued.");
  });

  it("the held words are in the report once, whether the grace or its process's end lets it go", async () => {
    process.env.BOTLING_MONITOR_GRACE_MS = "40";
    const once = (text: string, part: string) => text.split(part).length - 1;
    try {
      const grace = await open();
      grace.h.say(grace.head, used); grace.h.say(grace.head, started);
      grace.h.result(grace.head, "Monitor started; the deploy is queued.");
      grace.h.say(grace.head, ended);
      await wait(100);
      expect(grace.h.reports).toHaveLength(1);
      expect(once(grace.h.reports[0]!.text, "Monitor started; the deploy is queued.")).toBe(1);
      const exited = await open();
      exited.h.say(exited.head, used); exited.h.say(exited.head, started);
      exited.h.result(exited.head, "Monitor started; the deploy is queued.");
      exited.head.exit(0, true);
      await wait(30);
      expect(exited.h.reports).toHaveLength(1);
      expect(once(exited.h.reports[0]!.text, "Monitor started; the deploy is queued.")).toBe(1);
    } finally { delete process.env.BOTLING_MONITOR_GRACE_MS; }
  });

  it("a wake turn the API turns away and tries again keeps the held report: the retry's report carries both", () => withRetryDelays("20,20,20", async () => {
    const { h, head } = await open();
    h.say(head, used); h.say(head, started);
    h.result(head, "Monitor started; the deploy is queued.");
    h.say(head, ended);
    apiError((item) => h.say(head, item), 403, CLOUDFLARE);
    await wait(60);
    expect(head.sent.map((m) => m.text)).toEqual(["Watch the deploy", API_RETRY_NOTE]);
    expect(h.reports).toEqual([]);
    h.result(head, "The deploy finished: ok.");
    await wait(20);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.text).toContain("Monitor started; the deploy is queued.");
    expect(h.reports[0]!.text).toContain("The deploy finished: ok.");
  }));

  it("every try failing after a held report still hands the held report over with the failure", () => withRetryDelays("15", async () => {
    const { h, head } = await open();
    h.say(head, used); h.say(head, started);
    h.result(head, "Monitor started; the deploy is queued.");
    h.say(head, ended);
    apiError((item) => h.say(head, item), 403, CLOUDFLARE);
    await wait(50);
    apiError((item) => h.say(head, item), 403, CLOUDFLARE);
    await wait(20);
    expect(h.reports).toHaveLength(1);
    expect(failedSummary(h)).toMatchObject({ status: "failed" });
    expect(failedSummary(h).summary).toContain("Monitor started; the deploy is queued.");
  }));

  it("its process ending while an API retry waits hands over the held report with the exit", () => withRetryDelays("500", async () => {
    const { h, head } = await open();
    h.say(head, used); h.say(head, started);
    h.result(head, "Monitor started; the deploy is queued.");
    h.say(head, ended);
    apiError((item) => h.say(head, item), 403, CLOUDFLARE);
    head.exit(0, true);
    await wait(30);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]!.text).toContain("Monitor started; the deploy is queued.");
  }));

  it("a Monitor's wake turn that ends well while an API retry waits is kept for the Monitor, and no try follows it", () => withRetryDelays("60", async () => {
    const { h, head } = await open();
    h.say(head, used); h.say(head, started);
    h.result(head, "Monitor started; the deploy is queued.");
    apiError((item) => h.say(head, item), 403, CLOUDFLARE);
    // The Monitor's next event wakes the model before the try: that turn's report is kept for the live Monitor.
    h.result(head, "Still deploying.");
    await wait(120);
    expect(head.sent.map((m) => m.text)).toEqual(["Watch the deploy"]);
    expect(h.reports).toEqual([]);
    expect(waits(h).at(-1)).toMatchObject({ on: { kind: "monitorRunning", title: "watch the deploy log" } });
  }));

  it("the cap that let the report go still holds after an API retry: a newer Monitor does not keep the retry's report", () => withRetryDelays("20", async () => {
    process.env.BOTLING_MONITOR_GRACE_MS = "30";
    try {
      const { h, task_id, head } = await open();
      h.say(head, used); h.say(head, started);
      nearCap(h, task_id, 40);
      h.say(head, monitorAgain);
      h.result(head, "Monitor started.");
      h.say(head, { kind: "init", sessionId: "00000000-0000-4000-8000-000000000001" });
      await wait(80);
      expect(h.reports).toEqual([]);
      apiError((item) => h.say(head, item), 403, CLOUDFLARE);
      await wait(50);
      expect(head.sent.map((m) => m.text)).toEqual(["Watch the deploy", API_RETRY_NOTE]);
      h.result(head, "The deploy finished: ok.");
      await wait(30);
      expect(h.reports).toHaveLength(1);
      expect(h.reports[0]!.text).toContain("Monitor started.");
      expect(h.reports[0]!.text).toContain("The deploy finished: ok.");
    } finally { delete process.env.BOTLING_MONITOR_GRACE_MS; }
  }));

  it("the oldest Monitor's cap lets the report go once, though a newer Monitor still runs; nothing holds or reports again", async () => {
    const { h, task_id, head } = await open();
    h.say(head, used); h.say(head, started);
    nearCap(h, task_id, 40);
    h.say(head, monitorAgain);
    h.result(head, "Monitor started.");
    await wait(10);
    expect(h.reports).toEqual([]);
    expect(waits(h).at(-1)).toMatchObject({ on: { kind: "monitorRunning", title: "watch the deploy log" } });
    await wait(80);
    expect(h.reports.map((r) => r.run)).toEqual([1]);
    expect(waits(h).at(-1)).toEqual({ kind: "subagentWaitingOn", id: task_id, on: null });
    const rows = waits(h).length;
    // Released: a later Monitor, the other one ending and a late wake turn add neither a row nor a second report.
    h.say(head, thirdStarted); h.say(head, secondEnded);
    h.result(head, "Late wake turn.");
    await wait(30);
    expect(h.reports).toHaveLength(1);
    expect(waits(h)).toHaveLength(rows);
  });

  it("the oldest Monitor's cap passing during a turn: that turn's result ends the run, a newer Monitor does not hold it again", async () => {
    process.env.BOTLING_MONITOR_GRACE_MS = "30";
    try {
      const { h, task_id, head } = await open();
      h.say(head, used); h.say(head, started);
      nearCap(h, task_id, 40);
      h.say(head, monitorAgain);
      h.result(head, "Monitor started.");
      // The wake turn is under way when the cap runs out: the grace, not a cut-off.
      h.say(head, { kind: "init", sessionId: "00000000-0000-4000-8000-000000000001" });
      h.say(head, { kind: "toolUse", id: "t1", tool: "Bash", title: "Bash", detail: "tail", parent: null, input: {} });
      await wait(100);
      expect(h.reports).toEqual([]);
      const rows = waits(h).length;
      // A Monitor that starts now is no reason to hold what the cap has let go: no "Monitor running" row for it.
      h.say(head, thirdStarted);
      expect(waits(h)).toHaveLength(rows);
      h.result(head, "The deploy finished: ok.");
      await wait(30);
      expect(h.reports).toHaveLength(1);
      expect(h.reports[0]!.text).toContain("Monitor started.");
      expect(h.reports[0]!.text).toContain("The deploy finished: ok.");
      expect(waits(h).at(-1)).toEqual({ kind: "subagentWaitingOn", id: task_id, on: null });
      h.result(head, "Another turn.");
      await wait(30);
      expect(h.reports).toHaveLength(1);
    } finally { delete process.env.BOTLING_MONITOR_GRACE_MS; }
  });

  it("a wake turn that outlasts the grace does not let the report go for good: a Monitor it starts still holds it", async () => {
    process.env.BOTLING_MONITOR_GRACE_MS = "30";
    try {
      const { h, head } = await open();
      h.say(head, used); h.say(head, started);
      h.result(head, "Monitor started.");
      h.say(head, ended);
      h.say(head, { kind: "init", sessionId: "00000000-0000-4000-8000-000000000001" });
      h.say(head, { kind: "toolUse", id: "t1", tool: "Bash", title: "Bash", detail: "tail", parent: null, input: {} });
      await wait(100); // the grace ran out under the turn: only the cap lets a report go for good
      expect(h.reports).toEqual([]);
      h.say(head, monitorAgain);
      h.result(head, "Wake turn done; watching the disk too.");
      await wait(30);
      expect(h.reports).toEqual([]);
      expect(waits(h).at(-1)).toMatchObject({ on: { kind: "monitorRunning", title: "watch the disk" } });
    } finally { delete process.env.BOTLING_MONITOR_GRACE_MS; }
  });

  it("a steer while the Monitor runs goes into the run as usual", async () => {
    const { h, task_id, head } = await open();
    h.say(head, used); h.say(head, started);
    h.result(head, "Monitor started.");
    await wait(20);
    expect(h.workers.sendToWorker(task_id, "Also check the disk")).toEqual({ ok: true, how: "steered", run: 1 });
    expect(head.sent.map((m) => m.text)).toEqual(["Watch the deploy", "Also check the disk"]);
  });
});

describe("a held run and the tree checks of earlier processes (spec/models/worker/WorkerProcess.tla)", () => {
  it("an earlier process's tree check answering late leaves a run held for the closing process alone", async () => {
    const h = harness(undefined, { keepAliveMs: 10 });
    const { task_id } = await h.workers.tool("app_handoff", { instructions: "Run one" }) as any;
    const first = h.heads[0]!;
    h.say(first, { kind: "init", sessionId: first.config.sessionId });
    // Its tree check (endTree) does not answer until the test says so.
    let answer!: (result: { killed: number[]; forced: boolean }) => void;
    first.terminate = () => new Promise((resolve) => { answer = resolve; });
    first.exit(1);
    await wait();
    expect(await h.workers.sendToWorker(task_id, "Run two")).toMatchObject({ ok: true, run: 2 });
    const second = h.heads[1]!;
    second.gone = function () { return !this.running; };
    // Its input is closed, but it lives on for a while (background work).
    second.finish = function () { this.finished = true; };
    h.result(second, "Two done.");
    await wait(40);
    expect(second.finished).toBe(true);
    expect(await h.workers.sendToWorker(task_id, "Run three")).toMatchObject({ ok: true, run: 3 });
    // The first process's check answers now: run 3 waits for the second process, not for it.
    answer({ killed: [], forced: false });
    await wait();
    expect(h.heads).toHaveLength(2);
    expect(h.workers.core.get(task_id)).toMatchObject({ status: "running", run: 3 });
    second.exit(0, true);
    await wait();
    expect(h.heads).toHaveLength(3);
    expect(h.heads[2]!.sent.map((m) => m.text)).toEqual(["Run three"]);
    expect(h.heads[2]!.config).toMatchObject({ resume: true, sessionId: first.config.sessionId });
  });
});

describe("workerExtraDirs: a worktree folder outside the project stays a working folder (so its Bash cd sticks)", () => {
  it("adds an existing folder from settings.json to the worker's --add-dir, keeps the head's own, and skips a missing one", async () => {
    const work = mkdtempSync(join(tmpdir(), "botling-work-dir-"));
    const missing = join(work, "not-mounted"), file = join(work, "a-file");
    writeFileSync(file, "x");
    const h = harness(undefined, { base: { command: "claude", cwd: "/elsewhere", sessionId: "coordinator", resume: true, allowedTools: ["Read"], addDirs: ["/bot/inbox"], model: "opus", effort: "high" }, extraDirs: () => [work, missing, file, work] });
    await h.workers.tool("app_handoff", { name: "Build", instructions: "go" });
    const config = h.heads[0]!.config;
    expect(config.addDirs).toEqual(["/bot/inbox", work]);
    const args = headArguments(config);
    expect(args.slice(args.indexOf("--add-dir"))).toEqual(expect.arrayContaining(["--add-dir", work]));
    expect(args).not.toContain(missing);
    expect(args).not.toContain(file);
  });

  it("reads the folders again for each new process, so a settings.json change reaches the next worker", async () => {
    const one = mkdtempSync(join(tmpdir(), "botling-work-dir-")), two = mkdtempSync(join(tmpdir(), "botling-work-dir-"));
    let now = [one];
    const h = harness(undefined, { extraDirs: () => now });
    await h.workers.tool("app_handoff", { name: "A", instructions: "go" });
    now = [two];
    await h.workers.tool("app_handoff", { name: "B", instructions: "go" });
    expect(h.heads.map((head) => head.config.addDirs)).toEqual([[one], [two]]);
  });

  it("gives a worker on another machine none (the folder is a path on this one)", async () => {
    const work = mkdtempSync(join(tmpdir(), "botling-work-dir-"));
    const configs: HeadConfig[] = [];
    const remote: RemoteWorkerHost = {
      resolve: (name) => ({ id: "m1", name }),
      head: (_machine, _worker, _cwd, config) => { configs.push(config); return { pid: -1, running: false, start() {}, send() {}, answer() {}, finish() {}, terminate: async () => ({ killed: [], forced: false }) }; },
    };
    const h = harness(undefined, { extraDirs: () => [work], remote: () => remote });
    await h.workers.tool("app_handoff", { name: "Far", instructions: "go", machine: "box" });
    expect(configs).toHaveLength(1);
    expect(configs[0]!.addDirs).toBeUndefined();
    await h.workers.tool("app_handoff", { name: "Near", instructions: "go" });
    expect(h.heads[0]!.config.addDirs).toEqual([work]);
  });

  it("adds nothing when no folder is set, and the head's folders stay as they were", async () => {
    const h = harness();
    await h.workers.tool("app_handoff", { name: "Plain", instructions: "go" });
    expect(h.heads[0]!.config.addDirs).toBeUndefined();
  });

  it("reads settings.json's workerExtraDirs: absolute folders only, deduplicated, default none; launchSettings carries it", () => {
    expect(workerExtraDirs({})).toEqual([]);
    expect(workerExtraDirs({ workerExtraDirs: "/x" } as any)).toEqual([]);
    expect(workerExtraDirs({ workerExtraDirs: ["/Volumes/My-SSD/botling-work/", "relative/dir", 3, "", "/Volumes/My-SSD/botling-work", "/a\nb"] } as any)).toEqual(["/Volumes/My-SSD/botling-work"]);
    expect(workerExtraDirs({ workerExtraDirs: Array.from({ length: 25 }, (_, i) => `/d${i}`) } as any)).toHaveLength(20);
    expect(launchSettings({ workerExtraDirs: ["/w"] } as any).workerExtraDirs).toEqual(["/w"]);
    expect(launchSettings({}).workerExtraDirs).toEqual([]);
  });
});
