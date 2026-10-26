import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bot } from "../../src/core/bot";
import { CodexHead, CodexThreads, type CodexOutput } from "../../src/core/agent/codex";
import { ProcessLedger } from "../../src/core/process/ledger";
import { mainProfile } from "../../src/core/store/workspace";
import { botPrompts } from "../../src/core/prompts";
import { tempDir, until } from "../helpers";

// Replay the real session's outputs through Bot's head callback. Only stdio is replaced:
// permission cards, choose(), coordinator cleanup and the session's RPC decisions are real.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function harness(approvalTimeoutMs = 60_000) {
  const dir = tempDir("approval-lifecycle");
  const profile = mainProfile(dir);
  mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine: "codex", heads: { engines: ["codex"], answerWith: "codex" } }));
  const events: any[] = [];
  const bot = new Bot({ profile, deferStartup: true, welcome: false,
    ledger: new ProcessLedger(join(dir, "ledger.json")),
    headConfig() { throw new Error("No CLI needed for protocol replay"); },
    prompts: () => botPrompts({ profile, engine: "codex" }),
    emit: (event) => events.push(event), log() {},
    approvalTimeoutMs, idleMs: 60_000, interruptGraceMs: 10,
  });
  const head = new CodexHead({ command: process.execPath, cwd: dir, sessionId: "test", resume: false,
    threads: new CodexThreads(join(dir, "threads")), instructions: "Coordinator", workerInstructions: "Worker" },
  { onItem() {}, onExit() {} });
  (bot as any).head = head;
  head.running = true;
  const writes: any[] = [];
  const deliver = (outputs: CodexOutput[]) => {
    for (const output of outputs) {
      if (output.kind === "write") writes.push(output.value);
      if (output.kind === "item") (bot as any).onItem(head, output.item);
    }
    return outputs;
  };
  vi.spyOn(head, "answer").mockImplementation((id, allow, _input, why) => { deliver(head.session.answer(id, allow, why)); });
  const receive = (value: unknown) => deliver(head.session.receive(JSON.stringify(value)));
  const note = (method: string, params: unknown) => receive({ method, params });
  const tool = (name: string, args: unknown, id = 100) => receive({ id, method: "item/tool/call", params: { threadId: "coord", turnId: "ct1", tool: name, arguments: args } });
  const respond = (method: string, result: unknown) => {
    const call = writes.findLast((write) => write.method === method);
    return receive({ id: call.id, result });
  };
  deliver(head.session.start()); respond("initialize", {}); respond("thread/start", { thread: { id: "coord" } });
  deliver(head.session.send("Delegate")); respond("turn/start", { turn: { id: "ct1" } });
  tool("app_handoff", { instructions: "Do the authorized work", name: "Worker" });
  const task = head.session.workerRecords[0]!.id;
  respond("thread/start", { thread: { id: "worker" } }); respond("turn/start", { turn: { id: "wt1" } });
  const ask = (id: string | number = 700, thread = "worker", turn = "wt1") => receive({ id, method: "item/commandExecution/requestApproval", params: { threadId: thread, turnId: turn, command: "git worktree add repair", reason: "Required protected.git approval" } });
  const card = () => events.findLast((e) => ["message.added", "message.updated"].includes(e.type) && e.message.approval)?.message;
  const endCoordinator = () => note("turn/completed", { threadId: "coord", turn: { id: "ct1", status: "completed" } });
  cleanups.push(async () => { deliver(head.session.stop()); head.running = false; await bot.shutdown({ tidy: false }); });
  return { bot, head, writes, events, deliver, receive, respond, note, tool, ask, card, task, endCoordinator };
}

describe("Codex approval lifecycle across coordinator and worker turns", () => {
  it("keeps an active worker approval through same-task steering and coordinator completion", () => {
    const h = harness(); h.ask(); const question = h.card();
    h.tool("app_send_message", { task_id: h.task, message: "Use the manual-completion commit as context" }, 101);
    expect(h.writes.findLast((w) => w.method === "turn/steer").params.expectedTurnId).toBe("wt1");
    h.endCoordinator();
    expect(h.writes.filter((w) => w.id === 700 || JSON.stringify(w).includes("No longer needed"))).toEqual([]);
    expect(h.card()).toMatchObject({ id: question.id, chosen: null, answer: null });
    expect(h.bot.choose(question.id, 0)).toEqual({ accepted: true });
    expect(h.writes.filter((w) => w.id === 700)).toEqual([{ jsonrpc: "2.0", id: 700, result: { decision: "accept" } }]);
    expect(h.writes.some((w) => JSON.stringify(w).includes("No longer needed"))).toBe(false);
  });

  it("preserves an accepted one-shot decision through delayed resolution and turn cleanup", () => {
    const h = harness(); h.ask(); const question = h.card();
    expect(h.bot.choose(question.id, 0).accepted).toBe(true);
    h.note("serverRequest/resolved", { threadId: "worker", requestId: 700 });
    h.endCoordinator();
    expect(h.card()).toMatchObject({ id: question.id, chosen: 0, answer: null });
    expect(h.bot.choose(question.id, 1).accepted).toBe(false);
    expect(h.writes.filter((w) => w.id === 700)).toHaveLength(1);
  });

  it("honors actual denial, without a second decision during cleanup", () => {
    const h = harness(); h.ask(); const question = h.card();
    expect(h.bot.choose(question.id, 1).accepted).toBe(true);
    h.endCoordinator();
    expect(h.writes.filter((w) => w.id === 700)).toEqual([{ jsonrpc: "2.0", id: 700, result: { decision: "decline" } }]);
    expect(h.writes.findLast((w) => w.method === "turn/steer").params).toMatchObject({ threadId: "worker", expectedTurnId: "wt1", input: [{ type: "text", text: "(App: The user did not allow it.)" }] });
  });

  it("cancels only approvals belonging to the resolved thread and keeps numeric/string RPC ids apart", () => {
    const h = harness(); h.ask(700); const first = h.card(); h.ask("700", "coord", "ct1"); const second = h.card();
    h.note("serverRequest/resolved", { threadId: "coord", requestId: 700 });
    expect(h.bot.choose(first.id, 0).accepted).toBe(true);
    expect(h.bot.choose(second.id, 0).accepted).toBe(true);
    expect(h.writes.filter((w) => w.result?.decision === "accept").map((w) => w.id)).toEqual([700, "700"]);
  });

  it("delivers both accepted decisions when concurrent RPC ids have the same text", () => {
    const h = harness(); h.ask(700); const first = h.card(); h.ask("700", "coord", "ct1"); const second = h.card();
    expect(h.bot.choose(first.id, 0).accepted).toBe(true);
    expect(h.bot.choose(second.id, 0).accepted).toBe(true);
    expect(h.writes.filter((w) => w.result?.decision === "accept")).toEqual([
      { jsonrpc: "2.0", id: 700, result: { decision: "accept" } },
      { jsonrpc: "2.0", id: "700", result: { decision: "accept" } },
    ]);
  });

  it("withdraws on real server cancellation and rejects stale clicks after an RPC id is reused", () => {
    const h = harness();
    const first = h.ask().find((o) => o.kind === "item" && o.item.kind === "permission") as any;
    const old = h.card();
    h.note("serverRequest/resolved", { threadId: "worker", requestId: 700 });
    expect(h.card()).toMatchObject({ id: old.id, answer: "No longer needed" });
    h.ask(); const current = h.card();
    expect(h.head.session.answer(first.item.requestId, true)).toEqual([]);
    expect(h.bot.choose(old.id, 0).accepted).toBe(false);
    expect(h.bot.choose(current.id, 0).accepted).toBe(true);
    expect(h.writes.filter((w) => w.id === 700)).toEqual([{ jsonrpc: "2.0", id: 700, result: { decision: "accept" } }]);
  });

  it.each(["complete", "cancel"])("withdraws unanswered approvals when their worker actually %ss", (ending) => {
    const h = harness();
    const asked = h.ask().find((o) => o.kind === "item" && o.item.kind === "permission") as any;
    const question = h.card();
    if (ending === "cancel") {
      h.deliver(h.head.session.cancelWorkers(new Set([h.task])));
    } else h.note("turn/completed", { threadId: "worker", turn: { id: "wt1", status: "completed" } });
    expect(h.card()).toMatchObject({ id: question.id, answer: "No longer needed" });
    expect(h.bot.choose(question.id, 0).accepted).toBe(false);
    expect(h.head.session.answer(asked.item.requestId, true)).toEqual([]);
    expect(h.writes.some((w) => w.result?.decision === "accept")).toBe(false);
  });

  it("does not invent a coordinator turn for a worker approval received while its coordinator is idle", () => {
    const h = harness(); h.endCoordinator();
    const before = h.events.filter((e) => e.type === "turn.started").length;
    h.ask();
    expect(h.events.filter((e) => e.type === "turn.started")).toHaveLength(before);
    expect(h.bot.choose(h.card().id, 0).accepted).toBe(true);
    expect(h.writes.findLast((w) => w.id === 700).result).toEqual({ decision: "accept" });
  });

  it("ignores a stale turn's resolution and coalesces duplicate pending server requests", () => {
    const h = harness(); h.ask(); const question = h.card();
    h.note("serverRequest/resolved", { threadId: "worker", turnId: "old-worker-turn", requestId: 700 });
    h.ask();
    expect(h.events.filter((e) => e.type === "message.added" && e.message.approval)).toHaveLength(1);
    expect(h.bot.choose(question.id, 0).accepted).toBe(true);
    expect(h.writes.filter((w) => w.id === 700)).toHaveLength(1);
  });

  it("refuses stale worker-turn requests without offering a card", () => {
    const h = harness(); h.ask(700, "worker", "old-worker-turn");
    expect(h.card()).toBeUndefined();
    expect(h.writes.findLast((w) => w.id === 700).result).toEqual({ decision: "decline" });
  });

  it("does not let a delayed completed coordinator turn withdraw the next turn's approval before start is acknowledged", () => {
    const h = harness(); h.endCoordinator(); h.deliver(h.head.session.send("Next authorized instruction"));
    h.ask(701, "coord", "ct2"); const current = h.card();
    h.note("turn/started", { threadId: "coord", turn: { id: "ct1" } });
    h.endCoordinator(); // A duplicate completion from the previous turn.
    h.respond("turn/start", { turn: { id: "ct2" } });
    expect(h.bot.choose(current.id, 0).accepted).toBe(true);
    expect(h.writes.filter((w) => w.id === 701)).toEqual([{ jsonrpc: "2.0", id: 701, result: { decision: "accept" } }]);
  });

  it("cancels coordinator approvals on Stop while an independent worker approval remains live", async () => {
    const h = harness(); h.ask(); const worker = h.card(); h.ask(701, "coord", "ct1"); const coordinator = h.card();
    const turn = h.events.find((e) => e.type === "turn.started");
    vi.spyOn(h.head, "interrupt").mockImplementation(() => {
      h.deliver(h.head.session.interrupt());
      h.note("turn/completed", { threadId: "coord", turn: { id: "ct1", status: "interrupted" } });
      return "";
    });
    await h.bot.stop(turn.turnId);
    expect(h.bot.choose(coordinator.id, 0).accepted).toBe(false);
    expect(h.writes.findLast((w) => w.id === 701).result).toEqual({ decision: "decline" });
    expect(h.bot.choose(worker.id, 0).accepted).toBe(true);
    expect(h.writes.findLast((w) => w.id === 700).result).toEqual({ decision: "accept" });
  });

  it("isolates cancellation by worker task even while another worker also needs approval", () => {
    const h = harness(); h.ask(); const first = h.card();
    h.tool("app_handoff", { instructions: "A separate authorized task", name: "Worker 2" }, 102);
    h.respond("thread/start", { thread: { id: "worker2" } }); h.respond("turn/start", { turn: { id: "w2t1" } });
    h.ask(701, "worker2", "w2t1"); const second = h.card();
    h.endCoordinator(); h.deliver(h.head.session.cancelWorkers(new Set([h.task])));
    expect(h.bot.choose(first.id, 0).accepted).toBe(false);
    expect(h.bot.choose(second.id, 0).accepted).toBe(true);
    expect(h.writes.filter((w) => [700, 701].includes(w.id))).toEqual([
      { jsonrpc: "2.0", id: 700, result: { decision: "decline" } },
      { jsonrpc: "2.0", id: 701, result: { decision: "accept" } },
    ]);
  });

  it("isolates a resumed worker run from its old request, stale turn and delayed resolution", () => {
    const h = harness(); const outputs = h.ask(); const old = h.card();
    const request = outputs.find((o) => o.kind === "item" && o.item.kind === "permission") as any;
    h.note("turn/completed", { threadId: "worker", turn: { id: "wt1", status: "completed" } });
    h.tool("app_send_message", { task_id: h.task, message: "Continue this task" }, 103);
    h.ask(701, "worker", "wt1"); // Old request arrives before the new turn/start response.
    expect(h.writes.findLast((w) => w.id === 701).result).toEqual({ decision: "decline" });
    h.respond("turn/start", { turn: { id: "wt2" } });
    h.ask(700, "worker", "wt2"); const current = h.card();
    h.note("serverRequest/resolved", { threadId: "worker", turnId: "wt1", requestId: 700 });
    expect(h.head.session.answer(request.item.requestId, true)).toEqual([]);
    expect(h.bot.choose(old.id, 0).accepted).toBe(false);
    expect(h.bot.choose(current.id, 0).accepted).toBe(true);
    expect(h.writes.filter((w) => w.id === 700)).toEqual([{ jsonrpc: "2.0", id: 700, result: { decision: "accept" } }]);
  });

  it("does not overwrite an accepted decision when its worker is cancelled asynchronously", () => {
    const h = harness(); h.ask(); const question = h.card();
    h.bot.choose(question.id, 0); h.deliver(h.head.session.cancelWorkers(new Set([h.task])));
    expect(h.card()).toMatchObject({ id: question.id, chosen: 0, answer: null });
    expect(h.writes.filter((w) => w.id === 700)).toEqual([{ jsonrpc: "2.0", id: 700, result: { decision: "accept" } }]);
  });

  it("rejects a cancelled run's delayed request and ignores its failed steering response after resume", () => {
    const h = harness();
    h.tool("app_send_message", { task_id: h.task, message: "Old context" }, 104);
    const steer = h.writes.findLast((w) => w.method === "turn/steer");
    h.deliver(h.head.session.cancelWorkers(new Set([h.task])));
    h.tool("app_send_message", { task_id: h.task, message: "Resume with fresh context" }, 105);
    h.ask(700, "worker", "wt1");
    expect(h.card()).toBeUndefined();
    expect(h.writes.findLast((w) => w.id === 700).result).toEqual({ decision: "decline" });
    h.receive({ id: steer.id, error: { message: "Old turn no longer active" } });
    h.respond("turn/start", { turn: { id: "wt2" } });
    h.note("item/completed", { threadId: "worker", turnId: "wt2", item: { type: "agentMessage", text: "Fresh result", phase: "final_answer" } });
    const starts = h.writes.filter((w) => w.method === "turn/start").length;
    h.note("turn/completed", { threadId: "worker", turn: { id: "wt2", status: "completed" } });
    // A failed old steer must not queue its context and silently start another worker run.
    expect(h.writes.filter((w) => w.method === "turn/start")).toHaveLength(starts);
    expect(h.head.session.workerRecords[0]).toMatchObject({ wasActive: false, run: 2, report: "Fresh result" });
  });

  it("still declines an unanswered worker approval on timeout", async () => {
    const h = harness(30); h.ask(); const question = h.card(); h.endCoordinator();
    await until(() => h.card()?.answer === "No answer in time", { timeout: 1_000 });
    expect(h.bot.choose(question.id, 0).accepted).toBe(false);
    expect(h.writes.filter((w) => w.id === 700)).toEqual([{ jsonrpc: "2.0", id: 700, result: { decision: "decline" } }]);
  });

  it.each(["fileChange", "permissions"])("keeps %s approval scoped to its worker", (kind) => {
    const h = harness();
    h.receive({ id: 700, method: `item/${kind}/requestApproval`, params: { threadId: "worker", turnId: "wt1", grantRoot: "/tmp/test", permissions: { network: { enabled: true } } } });
    const question = h.card(); h.endCoordinator();
    expect(h.bot.choose(question.id, 0).accepted).toBe(true);
    expect(h.writes.findLast((w) => w.id === 700).result).toEqual(kind === "fileChange" ? { decision: "accept" } : { permissions: { network: { enabled: true } }, scope: "turn" });
  });
});
