import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TaskView, SubagentView } from "../../src/contract";
import { readTaskCard, TaskBook, type TaskCard } from "../../src/core/tasks";
import { readSubagent, SubagentBook, type SubagentRecord } from "../../src/core/subagents";
import { relatedTaskAgents, taskAgentIds } from "../../src/core/task-agents";
import { subagentView } from "../../src/core/bot";
import { CodexSession, type CodexOutput } from "../../src/core/agent/codex";
import { CoreHarness, MAIN } from "../core-harness";
import { tempDir, until } from "../helpers";

const card = (extra: Partial<TaskCard> = {}): TaskCard => ({ id: "task-card", name: "Parser", state: "running", createdAt: 0, updatedAt: 0, messageIDs: [], kept: true, ...extra });
const child = (id: string, extra: Partial<SubagentRecord> = {}): SubagentRecord => ({ id, description: "Same title", prompt: "Same prompt", status: "completed", background: true, startedAt: 0, steps: [], ...extra });

describe("authoritative task relationships", () => {
  it("uses ids and parent ids, keeps multiple agents and missing records, and excludes matching unrelated titles", () => {
    const a = child("claude-call");
    const b = child("codex-worker", { type: "codex-worker", status: "running" });
    const nested = child("nested", { parentID: a.id, status: "failed" });
    const sources = [{ engine: "claude" as const, list: [nested, a, child("unrelated")] }, { engine: "codex" as const, list: [b] }];
    const result = relatedTaskAgents(card({ subagentIDs: [a.id, b.id, "pruned"] }), [], sources);
    expect(result.map((agent) => agent.id)).toEqual([b.id, a.id, "pruned", nested.id]);
    expect(result[0]).toMatchObject({ engine: "codex", status: "running", available: true });
    expect(result.find((agent) => agent.id === a.id)).toMatchObject({ engine: "claude", status: "completed" });
    expect(result.find((agent) => agent.id === "pruned")).toMatchObject({ status: null, available: false, engine: null });
    expect(relatedTaskAgents(card({ subagentIDs: [] }), [], sources)).toEqual([]);
  });

  it("recovers only structural Agent steps in the task's own chat lines", () => {
    const message = { id: "reply", role: "bot" as const, text: "Same title", date: 0, steps: [{ id: "call", kind: "subagent" as const, title: "Delegate", failed: false, done: true }] };
    expect(taskAgentIds(card({ messageIDs: [message.id] }), [message], [])).toEqual(["call"]);
    expect(taskAgentIds(card(), [message], [])).toEqual([]);
  });

  it("keeps unknown old metadata distinct from newly recorded empty links, including merges", () => {
    const legacy = readTaskCard(card())!;
    expect(legacy.subagentIDs).toBeUndefined();
    expect(readTaskCard(card({ subagentIDs: "bad" as any }))!.subagentIDs).toBeUndefined();
    const book = new TaskBook([legacy]);
    const id = book.begin("new", "New task", "codex", 1);
    expect(book.task(id)?.subagentIDs).toEqual([]);
    book.link("worker-1", legacy.id);
    book.link("worker-2", legacy.id);
    expect(book.task(legacy.id)).toMatchObject({ subagentIDs: ["worker-1", "worker-2"], agentLinkHistoryIncomplete: true });
    const restored = readTaskCard(JSON.parse(JSON.stringify(legacy)))!;
    expect(restored.subagentIDs).toEqual(["worker-1", "worker-2"]);
    expect(restored.agentLinkHistoryIncomplete).toBe(true);
  });

  it("retains linked historic agents beyond the rail's 40 completed record limit", () => {
    const book = new SubagentBook([], () => new Set(["linked"]));
    book.started({ id: "linked", description: "Old", type: null, prompt: "Old task", background: true }, 0);
    book.ended({ id: "linked", status: "completed", summary: "Old report" }, 1);
    for (let i = 0; i < 45; i++) {
      book.started({ id: `other-${i}`, description: "Other", type: null, prompt: "Other task", background: true }, i + 2);
      book.ended({ id: `other-${i}`, status: "completed", summary: "Done" }, i + 3);
    }
    expect(book.get("linked")?.result).toBe("Old report");
    expect(book.list).toHaveLength(41);
    expect(book.get("other-0")).toBeUndefined();
  });

  it("preserves completed run evidence and actual thread/turn identity across continuation and reload", () => {
    const book = new SubagentBook();
    const execution = { run: 1, ownerSessionId: "owner-session", threadId: "worker-thread", turnId: "turn-1" };
    const start = { id: "worker-task-id", description: "Build", type: "codex-worker", prompt: "First instructions", background: true, execution };
    book.started(start, 1);
    book.text(start.id, "First progress");
    book.ended({ id: start.id, status: "completed", summary: "First report" }, 2);
    book.started({ ...start, prompt: "Follow-up", execution: { ...execution, run: 2, turnId: null } }, 3);
    book.execution(start.id, { ...execution, run: 2, turnId: "turn-2" });
    const saved = readSubagent(JSON.parse(JSON.stringify(book.get(start.id))))!;
    expect(saved.previousRuns).toMatchObject([{ execution, prompt: "First instructions", status: "completed", result: "First report", steps: [{ title: "First progress" }] }]);
    expect(saved).toMatchObject({ status: "running", prompt: "Follow-up", runStartedAt: 3, execution: { run: 2, threadId: "worker-thread", turnId: "turn-2" } });
    expect(saved.result).toBeUndefined();
    const view = SubagentView.parse(subagentView(saved, "Owner", new SubagentBook([saved]), "codex"));
    expect(view.steps.map((step) => step.title).join("\n")).toContain("First report");
    expect(view.steps.map((step) => step.title).join("\n")).toContain("Thread: worker-thread");
    book.started({ ...start, prompt: "Queued follow-up", execution: { ...execution, run: 3, turnId: null }, previousRunEnd: { status: "failed", result: "Run two failed" } }, 4);
    expect(book.get(start.id)?.previousRuns?.at(-1)).toMatchObject({ status: "failed", result: "Run two failed", execution: { run: 2 } });
  });

  it("captures Codex's acknowledged thread and turn ids, then continues the same worker at run 2", () => {
    const session = new CodexSession({ cwd: "/tmp", instructions: "Coordinator", workerInstructions: "Worker", resumeThread: null, model: null, workerModel: null, effort: null, restoredWorkers: [], ownerSession: "owner-session" });
    const book = new SubagentBook();
    const consume = (outputs: CodexOutput[]) => {
      for (const output of outputs) if (output.kind === "item") {
        const item = output.item;
        if (item.kind === "subagentStarted") book.started(item);
        if (item.kind === "subagentExecution") book.execution(item.id, item.execution);
        if (item.kind === "subagentEnded") book.ended(item);
      }
      return outputs;
    };
    const receive = (value: unknown) => consume(session.receive(JSON.stringify(value)));
    session.start();
    receive({ id: 1, result: {} });
    receive({ id: 2, result: { thread: { id: "coordinator-thread" } } });
    session.send("Build");
    receive({ id: 3, result: { turn: { id: "coordinator-turn" } } });
    const call = (id: number, tool: string, args: unknown) => ({ method: "item/tool/call", id, params: { threadId: "coordinator-thread", turnId: "coordinator-turn", tool, arguments: args } });
    const handoff = receive(call(101, "app_handoff", { name: "Parser", instructions: "Build parser" }));
    const workerId = book.list[0].id;
    const requestId = (handoff.find((o) => o.kind === "write" && o.value.method === "thread/start") as any).value.id;
    const start = receive({ id: requestId, result: { thread: { id: "acknowledged-worker-thread" } } });
    const turnRequestId = (start.find((o) => o.kind === "write" && o.value.method === "turn/start") as any).value.id;
    receive({ id: turnRequestId, result: { turn: { id: "acknowledged-turn-1" } } });
    expect(book.get(workerId)?.execution).toEqual({ run: 1, ownerSessionId: "owner-session", threadId: "acknowledged-worker-thread", turnId: "acknowledged-turn-1" });
    receive({ method: "item/completed", params: { threadId: "acknowledged-worker-thread", turnId: "acknowledged-turn-1", item: { type: "agentMessage", text: "First evidence", phase: "final_answer" } } });
    receive({ method: "turn/completed", params: { threadId: "acknowledged-worker-thread", turn: { id: "acknowledged-turn-1", status: "completed" } } });
    const follow = receive(call(102, "app_send_message", { task_id: workerId, message: "Fix the edge case" }));
    expect(book.get(workerId)).toMatchObject({ status: "running", execution: { run: 2, threadId: "acknowledged-worker-thread", turnId: null }, previousRuns: [{ result: "First evidence", status: "completed" }] });
    const nextRequestId = (follow.find((o) => o.kind === "write" && o.value.method === "turn/start") as any).value.id;
    receive({ id: nextRequestId, result: { turn: { id: "acknowledged-turn-2" } } });
    expect(book.get(workerId)?.execution?.turnId).toBe("acknowledged-turn-2");
    expect(session.workerRecords[0]).toMatchObject({ id: workerId, thread: "acknowledged-worker-thread", run: 2, wasActive: true });
    expect(book.list).toHaveLength(1);
  });
});

const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) await harness.kill("SIGKILL"); });
const core = (dir: string, env: Record<string, string> = {}) => { const c = new CoreHarness(dir, env); harnesses.push(c); return c; };
const turn = async (c: CoreHarness, text: string, extra: Record<string, unknown> = {}) => {
  const sent = await c.call({ type: "chat.send", botId: MAIN, text, ...extra });
  await until(() => c.of("turn.finished").find((e) => (e.event as any).turnId === sent.turnId));
  return sent;
};

it("persists multiple Codex workers on the correct task; real detail requests, updates and refetch show their own state", async () => {
  const dir = tempDir("task-agents-codex");
  mkdirSync(join(dir, "main"), { recursive: true });
  writeFileSync(join(dir, "main", "bot.json"), JSON.stringify({ engine: "codex", heads: { engines: ["codex"], answerWith: "codex" } }));
  const gate = join(dir, "worker-gate");
  const c = core(dir, { FAKE_CODEX_WORKER_GATE: gate });
  const first = await turn(c, "/worker First parser worker");
  await turn(c, "/worker Second parser worker", { replyTo: first.messageId });
  await turn(c, "/worker Unrelated worker");
  const chat = await c.chat();
  expect(chat.tasks).toHaveLength(2);
  const task = TaskView.parse(chat.tasks.find((task: any) => task.relatedAgents.length === 2));
  const other = TaskView.parse(chat.tasks.find((candidate: any) => candidate.id !== task.id));
  expect(task).toMatchObject({ agentLinks: "recorded", atWork: true });
  expect(task.relatedAgents!.map((agent) => agent.title)).toEqual(["First parser worker", "Second parser worker"]);
  expect(other.relatedAgents![0].title).toBe("Unrelated worker");
  const ids = task.relatedAgents!.map((agent) => agent.id);
  expect(ids).not.toContain(task.id);
  const saved = JSON.parse(readFileSync(join(dir, "main", "tasks.json"), "utf8")).find((card: any) => card.id === task.id);
  expect(saved.subagentIDs).toEqual(ids);
  for (const agent of task.relatedAgents!) {
    const detail = SubagentView.parse((await c.call({ type: "subagent.view", botId: MAIN, subagentId: agent.id })).subagent);
    expect(detail).toMatchObject({ id: agent.id, engine: "codex", status: "running", execution: { run: 1, threadId: expect.any(String), turnId: expect.any(String), ownerSessionId: expect.any(String) } });
    expect(detail.prompt).toBe(agent.title);
    const registry = JSON.parse(readFileSync(join(dir, "codex-threads", `${detail.execution!.ownerSessionId!.toLowerCase()}.workers.json`), "utf8"));
    expect(registry.find((record: any) => record.id === agent.id)).toMatchObject({ id: agent.id, thread: detail.execution!.threadId, run: detail.execution!.run, wasActive: true });
  }
  writeFileSync(gate, "go");
  await until(() => c.of("tasks.updated").findLast((e) => (e.event as any).tasks.some((candidate: any) => candidate.id === task.id && candidate.relatedAgents.length === 2 && candidate.relatedAgents.every((agent: any) => agent.status === "completed"))));
  // The card stays at work until the coordinator's own turn has ended, which follows the last worker.
  let quiet = 0; // at work flickers between the last worker's report and the coordinator's follow-up turn: require it to stay off
  await until(async () => { quiet = (await c.chat()).tasks.find((candidate: any) => candidate.id === task.id)?.atWork ? 0 : quiet + 1; return quiet >= 8; }, { every: 100, what: "the task to leave work" });
  const refreshed = (await c.chat()).tasks.find((candidate: any) => candidate.id === task.id);
  expect(refreshed.atWork).toBe(false);
  expect(refreshed.relatedAgents.map((agent: any) => agent.id)).toEqual(ids);
  const detail = await c.call({ type: "subagent.view", botId: MAIN, subagentId: ids[0] });
  expect(detail.subagent.result).toContain("First parser worker");
  expect(detail.subagent.status).toBe("completed");
  await c.kill("SIGKILL");
  const reopened = core(dir);
  const restored = (await reopened.chat()).tasks.find((candidate: any) => candidate.id === task.id);
  expect(restored.relatedAgents.map((agent: any) => agent.id)).toEqual(ids);
  expect(restored.relatedAgents.every((agent: any) => agent.status === "completed")).toBe(true);
  expect((await reopened.call({ type: "subagent.view", botId: MAIN, subagentId: ids[0] })).subagent.result).toBe(detail.subagent.result);
});

it("Claude Agent calls expose their actual call id and result through the same task detail path", async () => {
  const c = core(tempDir("task-agents-claude"), { FAKE_CLAUDE_MODE: "agent" });
  await turn(c, "Research the API");
  const task = TaskView.parse((await c.chat()).tasks[0]);
  expect(task.relatedAgents).toHaveLength(1);
  const agent = task.relatedAgents![0];
  expect(agent).toMatchObject({ engine: "claude", status: "completed", available: true });
  const detail = (await c.call({ type: "subagent.view", botId: MAIN, subagentId: agent.id })).subagent;
  expect(detail.id).toBe(agent.id);
  expect(detail.prompt).toBe("Look up the API and report");
  expect(detail.steps.length).toBeGreaterThan(0);
  expect(detail.result).toBeTruthy();
});

it("links a partner Codex worker to the originating Claude task through the actual handoff id", async () => {
  const c = core(tempDir("task-agents-partner"));
  await c.call({ type: "heads.set", botId: MAIN, engines: ["claude", "codex"] });
  await c.call({ type: "heads.answerWith", botId: MAIN, to: "claude" });
  await c.call({ type: "chat.send", botId: MAIN, text: '/say Handing it over. <task name="Parser" state="running"/><handoff to="codex">/worker build the parser</handoff>' });
  const task = await until(async () => (await c.chat()).tasks.find((task: any) => task.relatedAgents.some((agent: any) => agent.engine === "codex" && agent.status === "completed")));
  expect(task.owner).toBe("claude");
  expect(task.relatedAgents).toHaveLength(1);
  const agent = task.relatedAgents[0];
  const detail = (await c.call({ type: "subagent.view", botId: MAIN, subagentId: agent.id })).subagent;
  expect(detail).toMatchObject({ id: agent.id, engine: "codex", prompt: "build the parser", result: "Worker did: build the parser" });
  // A completed worker may still have its owner processing the report.
  const settled = await until(async () => {
    const current = (await c.chat()).tasks.find((candidate: any) => candidate.id === task.id);
    return current && !current.atWork ? current : undefined;
  });
  expect(settled.atWork).toBe(false);
});
