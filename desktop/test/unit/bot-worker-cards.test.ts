// `<card>` in a bot's reply, through a real Bot on fake heads: the worker starts through the same `app_handoff` a bot's own tool call takes,
// the card says how it went, the worker's ledger moves the card (and a later run updates it), and a plugin's turn or a non-Claude bot starts nothing.
// The reply box of a card sends `agent.message` to the card's task id (its contract shape is checked here; the routing is agent-command-server.test.ts's).
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fixture = vi.hoisted(() => {
  const heads: any[] = [];
  class Head {
    running = false; pid = 0; exited = Promise.resolve(); completionDependencies: any[] = []; sent: string[] = [];
    constructor(readonly config: any, readonly handlers: any) { heads.push(this); }
    start() { this.running = true; queueMicrotask(() => this.handlers.onItem({ kind: "init", sessionId: this.config.sessionId })); }
    send(text: string) { this.sent.push(text); }
    steer(_text: string) { return true; }
    offerInsert() { return false; }
    withdrawInsert() { return true; }
    interrupt() {}
    finish() { this.running = false; this.handlers.onExit({ code: 0, signal: null, stderr: "", expected: true, silent: false }); }
    async terminate() { this.finish(); return { killed: [], forced: false }; }
  }
  return { heads, Head };
});
vi.mock("../../src/core/agent/head", async (original) => ({ ...await original<any>(), ClaudeHead: class extends fixture.Head {} }));
vi.mock("../../src/core/agent/codex", async (original) => ({ ...await original<any>(), CodexHead: class extends fixture.Head {} }));
vi.mock("../../src/core/agent/agy-acp", () => ({ verifyAcpRuntime() {}, AgyAcpHead: class extends fixture.Head {} }));
import { Bot } from "../../src/core/bot";
import { mainProfile } from "../../src/core/store/workspace";
import { botPrompts } from "../../src/core/prompts";
import { CodexThreads } from "../../src/core/agent/codex";
import { Command } from "../../src/contract";
import type { WorkerLedgerRecord } from "../../src/core/worker-core";
import { tempDir } from "../helpers";

const bots: Bot[] = [];
afterEach(async () => {
  for (const b of bots.splice(0)) await b.shutdown({ tidy: false }).catch(() => {});
  fixture.heads.length = 0;
  vi.restoreAllMocks();
});
async function waitFor(what: string, ok: () => unknown) {
  for (let i = 0; i < 400; i++) { if (ok()) return; await new Promise((r) => setImmediate(r)); }
  throw new Error(`gave up waiting for ${what}`);
}

function rig(engine: "claude" | "codex" = "claude", launch?: Record<string, unknown>, onRequests?: (bot: any, requests: any[]) => any[]) {
  const folder = tempDir("bot-worker-cards"), profile = mainProfile(folder); mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine, model: "m", heads: { engines: [engine], answerWith: engine, codexModel: "m" } }));
  const events: any[] = [];
  const b = new Bot({ profile, deferStartup: true, ledger: { record() {}, forget() {} } as any,
    headConfig(_p, c) { return { ...c, command: "/never-spawn", cwd: folder, allowedTools: [] }; },
    codexConfig(_p, c) { return { command: "/never-spawn", cwd: folder, threads: new CodexThreads(join(folder, "threads")), sessionId: c.sessionId, resume: c.resume, model: c.codexModel, effort: c.effort, instructions: c.systemPrompt, workerInstructions: null } as any; },
    prompts: (e, heads) => botPrompts({ profile, engine: e, heads }),
    ...(launch ? { launch: () => ({ subagentHourCache: false, ...launch }) as any } : {}), ...(onRequests ? { onRequests } : {}),
    emit(event) { events.push(event); }, log() {}, idleMs: 600000, approvalTimeoutMs: 1000, interruptGraceMs: 10, tidyTimeoutMs: 30 });
  bots.push(b);
  const peek = b as any;
  // The Claude worker host stands in: it takes the same `tool("app_handoff", …)` call a bot's own tool call makes.
  const handoff = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ task_id: "T1", run: 1 }));
  peek.workers.ensureClaudeWorkers = () => ({ tool: handoff });
  return { b, peek, events, handoff };
}

/** The bot answers `reply` to a message; its bubble's record. */
async function answer(r: ReturnType<typeof rig>, reply: string, plugin?: string) {
  r.b.send("go");
  await waitFor("the message to reach the head", () => fixture.heads[0]?.sent.length === 1);
  r.peek.turn.reply.text = reply;
  if (plugin) r.peek.turn.plugin = plugin;
  const turn = r.peek.turn;
  r.peek.finishTurn(turn, "done");
  return turn.record as { id: string; text: string; workerCards?: Array<Record<string, any>> };
}

function ledger(over: Partial<WorkerLedgerRecord> & { text?: string | null } = {}): WorkerLedgerRecord {
  const { text, ...rest } = over;
  return { v: 3, id: "T1", engine: "claude", adapter: "claude-process", name: "n", instructions: "i", type: null, ownerSessionId: "s", run: 1, status: "running",
    report: { state: "none", text: text ?? null, status: null, attempts: 0 }, conversationId: null, processes: [], createdAt: 1, runStartedAt: 1, endedAt: null, engineData: {}, ...rest } as WorkerLedgerRecord;
}

describe("a reply with <card>: the worker starts", () => {
  it("draws the card in place of the tag and starts a worker with the prompt through app_handoff (name and group are the title)", async () => {
    const r = rig();
    const record = await answer(r, 'Checking.\n<card title="Prices">Collect the prices of the three plans.</card>\nWill report.');
    expect(record.text).toBe("Checking.\n\nWill report.");
    expect(record.workerCards).toHaveLength(1);
    await waitFor("the card to be bound to its worker", () => record.workerCards![0]!.taskId);
    expect(r.handoff).toHaveBeenCalledTimes(1);
    const [tool, args] = r.handoff.mock.calls[0]!;
    expect(tool).toBe("app_handoff");
    expect(args).toMatchObject({ name: "Prices", group: "Prices", model: "haiku" });
    expect(String(args.instructions)).toContain("Collect the prices of the three plans.");
    expect(record.workerCards![0]).toMatchObject({ title: "Prices", taskId: "T1", status: "running", run: 1, at: "Checking.\n".length });
  });

  it("the card's view reaches the chat (messageView): title, status and the task id its reply box sends to", async () => {
    const r = rig();
    const record = await answer(r, '<card title="Prices">Go.</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    const view = r.peek.messageView(record);
    expect(view.workerCards).toMatchObject([{ title: "Prices", status: "running", taskId: "T1", run: 1 }]);
    // Each reply goes to the card's worker as `agent.message`, in the shape the contract takes.
    expect(Command.safeParse({ type: "agent.message", botId: "b", subagentId: view.workerCards[0].taskId, text: "and the yearly price?" }).success).toBe(true);
  });

  it("a card-only reply keeps its bubble, and the worker's failure to start shows on the card (the bot is not left waiting for it)", async () => {
    const r = rig();
    r.handoff.mockRejectedValueOnce(new Error("Too many workers are running."));
    const record = await answer(r, '<card title="Prices">Go.</card>');
    await waitFor("the card to fail", () => record.workerCards![0]!.status === "failed");
    expect(record.workerCards![0]).toMatchObject({ status: "failed", error: "Too many workers are running." });
    expect(record.workerCards![0]!.taskId).toBeUndefined();
    expect(r.peek.records.some((line: any) => line.id === record.id)).toBe(true);
  });

  it("only three cards of one reply start a worker; the bot is told about the rest", async () => {
    const r = rig();
    const note = vi.spyOn(r.b, "queueNote");
    const record = await answer(r, [1, 2, 3, 4, 5].map((n) => `<card title="c${n}">job ${n}</card>`).join("\n"));
    await waitFor("three handoffs", () => r.handoff.mock.calls.length === 3);
    expect(record.workerCards).toHaveLength(3);
    expect(r.handoff).toHaveBeenCalledTimes(3);
    expect(note).toHaveBeenCalledWith(expect.stringMatching(/Only 3 of the 5 cards.*other 2 were not started/));
  });

  it("a card in a code fence starts nothing", async () => {
    const r = rig();
    const record = await answer(r, "Write it like:\n```\n<card title=\"t\">go</card>\n```");
    expect(record.workerCards).toBeUndefined();
    expect(r.handoff).not.toHaveBeenCalled();
  });

  it("a turn that began with a plugin's message starts no worker: the card says why", async () => {
    const r = rig();
    const record = await answer(r, '<card title="t">go</card>', "some-plugin");
    expect(record.workerCards![0]).toMatchObject({ status: "failed" });
    expect(record.workerCards![0]!.error).toMatch(/plugin/);
    await new Promise((resolve) => setImmediate(resolve));
    expect(r.handoff).not.toHaveBeenCalled();
  });

  it("a bot that is not a Claude bot starts no worker: the card says so", async () => {
    const r = rig("codex");
    const record = await answer(r, '<card title="t">go</card>');
    await waitFor("the card to fail", () => record.workerCards![0]!.status === "failed");
    expect(record.workerCards![0]!.error).toMatch(/Claude bot/);
    expect(r.handoff).not.toHaveBeenCalled();
  });
});

describe("a card starts one worker, whatever calls it", () => {
  it("startCards called again for the same reply while the first handoff is still being answered starts no second worker", async () => {
    const r = rig();
    let release!: () => void;
    r.handoff.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ task_id: "T1", run: 1 }); }));
    const record = await answer(r, '<card title="t">go</card>');
    await waitFor("the first handoff to be asked", () => r.handoff.mock.calls.length === 1);
    r.peek.workers.startCards(record);
    r.peek.workers.startCards(record);
    release();
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    expect(r.handoff).toHaveBeenCalledTimes(1);
  });

  it("drawing the cards of a reply that has them already (a second finish of the line) keeps them, bound as they are, and draws none new", async () => {
    const r = rig();
    const record = await answer(r, '<card title="t">go</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    const first = record.workerCards![0]!;
    r.peek.headEvents.drawCards(record, [{ title: "again", prompt: "again" }], { plugin: undefined });
    expect(record.workerCards).toHaveLength(1);
    expect(record.workerCards![0]).toBe(first);
    r.peek.workers.startCards(record);
    expect(r.handoff).toHaveBeenCalledTimes(1);
  });
});

describe("a card's worker reports to its card, never to the head", () => {
  it("its report (done or failed) is taken without a message to the head; another worker's report still is delivered", async () => {
    const r = rig();
    const record = await answer(r, '<card title="Prices">Go.</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    const sent = () => fixture.heads.reduce((n, head) => n + head.sent.length, 0);
    const before = sent();
    expect(r.peek.workers.workerReport("<app_task_result>Plans: A $5</app_task_result>", "T1")).toBe(true);
    expect(r.peek.workers.workerReport("<app_task_result>The worker failed</app_task_result>", "T1")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent()).toBe(before);
    // A control: the same call for a worker that no card started reaches the head.
    expect(r.peek.workers.workerReport("<app_task_result>other</app_task_result>", "OTHER")).toBe(true);
    await waitFor("the other report to reach the head", () => sent() > before);
  });

  it("a card far back in the chat is still its worker's card (its follow-up report stays off the head)", async () => {
    const r = rig();
    const record = await answer(r, '<card title="Prices">Go.</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    for (let i = 0; i < 450; i++) r.peek.records.push({ id: `x${i}`, role: "user", text: "later", date: 0 });
    const before = fixture.heads.reduce((n, head) => n + head.sent.length, 0);
    r.peek.workers.workerReport("<app_task_result>again</app_task_result>", "T1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.heads.reduce((n, head) => n + head.sent.length, 0)).toBe(before);
  });
});

describe("a card's worker's notes", () => {
  it("an interim note (kind report) of a card's worker neither draws a relay line nor wakes the head; its question still does, and another worker's note is unchanged", async () => {
    const r = rig();
    const record = await answer(r, '<card title="Prices">Go.</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    const sent = () => fixture.heads.reduce((n, head) => n + head.sent.length, 0);
    const relays = () => r.peek.records.filter((line: any) => line.role === "relay").length;
    const before = sent(), relaysBefore = relays();
    const note = (id: string, kind: "report" | "question") => r.peek.workers.workerNote({ id, kind, name: "Prices", message: "halfway", files: [] }, `<app_worker_note task_id="${id}" run="1" kind="${kind}">\nhalfway\n</app_worker_note>`);
    expect(note("T1", "report")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent()).toBe(before);
    expect(relays()).toBe(relaysBefore);
    // Controls: the card worker's question, and another worker's report note, reach the head as before.
    expect(note("T1", "question")).toBe(true);
    await waitFor("the question to reach the head", () => sent() > before);
    expect(relays()).toBe(relaysBefore + 1);
    const afterQuestion = sent();
    expect(note("OTHER", "report")).toBe(true);
    await waitFor("the other note to reach the head", () => sent() > afterQuestion || relays() === relaysBefore + 2);
    expect(relays()).toBe(relaysBefore + 2);
  });
});

describe("a card follows its worker", () => {
  it("a card bound to a worker the ledger does not have at the next start shows as interrupted, not at work for ever", async () => {
    const r = rig();
    const record = await answer(r, '<card title="t">go</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    expect(record.workerCards![0]!.status).toBe("running");
    r.peek.workers.projectLedgerAtStart();
    expect(record.workerCards![0]).toMatchObject({ status: "interrupted", taskId: "T1" });
    expect(record.workerCards![0]!.error).toMatch(/app went away/);
  });

  it("the worker's ledger moves the card: running, then its report (words and components), then a reply's next run replaces it", async () => {
    const r = rig();
    const record = await answer(r, '<card title="Prices">Go.</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    const changed = vi.spyOn(r.b as any, "changed");

    r.peek.projectWorker(ledger({ status: "done", run: 1, text: 'Plans: A $5, B $9.\n<show name="inline-chart">{"series":[5,9]}</show>' }));
    expect(record.workerCards![0]).toMatchObject({ status: "done", run: 1, text: "Plans: A $5, B $9." });
    expect(record.workerCards![0]!.shows).toHaveLength(1);
    expect(changed).toHaveBeenCalledWith(record);
    expect(r.peek.messageView(record).workerCards[0]).toMatchObject({ status: "done", text: "Plans: A $5, B $9." });

    // The user replied on the card: run 2 starts (the old words stay), its report replaces them.
    r.peek.projectWorker(ledger({ status: "running", run: 2, text: "Plans: A $5, B $9." }));
    expect(record.workerCards![0]).toMatchObject({ status: "running", run: 2, text: expect.stringContaining("Plans: A $5") });
    r.peek.projectWorker(ledger({ status: "done", run: 2, text: "Yearly: A $50, B $90." }));
    expect(record.workerCards![0]).toMatchObject({ status: "done", run: 2, text: "Yearly: A $50, B $90." });
    expect(record.workerCards![0]!.shows).toBeUndefined();
  });

  it("another worker's ledger change does not touch the card", async () => {
    const r = rig();
    const record = await answer(r, '<card title="Prices">Go.</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    r.peek.projectWorker(ledger({ id: "OTHER", status: "done", text: "not mine" }));
    expect(record.workerCards![0]).toMatchObject({ status: "running", run: 1 });
    expect(record.workerCards![0]!.text).toBeUndefined();
  });

  it("a card whose worker never started when the app went away says so at the next start, and starts nothing", async () => {
    const r = rig();
    const record = await answer(r, '<card title="t">go</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    // Simulate the stale state: starting, no worker.
    record.workerCards![0]!.status = "starting";
    delete record.workerCards![0]!.taskId;
    r.handoff.mockClear();
    r.peek.workers.endStaleCards();
    expect(record.workerCards![0]).toMatchObject({ status: "failed", error: expect.stringMatching(/app went away/) });
    expect(r.handoff).not.toHaveBeenCalled();
  });
});

describe("a card's worker is a small-model worker that Maintainer can be asked through", () => {
  it("runs on haiku", async () => {
    const plain = rig();
    await answer(plain, '<card title="t">go</card>');
    await waitFor("handoff", () => plain.handoff.mock.calls.length === 1);
    expect(plain.handoff.mock.calls[0]![1]).toMatchObject({ model: "haiku" });
  });

  it("a launch setting `cardWorkerModel` is the model it is started on", async () => {
    const r = rig("claude", { cardWorkerModel: "sonnet" });
    await answer(r, '<card title="t">go</card>');
    await waitFor("handoff", () => r.handoff.mock.calls.length === 1);
    expect(r.handoff.mock.calls[0]![1]).toMatchObject({ model: "sonnet" });
  });

  it("a report that asks for a component passes the ask to Maintainer once, with the worker's task id; the same ask again is not passed on", async () => {
    const asked: any[] = [];
    const r = rig("claude", undefined, (_bot, requests) => { asked.push(...requests); return []; });
    const record = await answer(r, '<card title="Charts">Show the GPU load.</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    const report = 'No component fits a gauge with history.\n<component name="gpu-gauge">A gauge with a 60 s history line; data {"load": 0-100}.</component>';
    r.peek.projectWorker(ledger({ status: "done", run: 1, text: report }));
    expect(record.workerCards![0]).toMatchObject({ wants: { name: "gpu-gauge" }, asked: true });
    await waitFor("the ask", () => asked.length === 1);
    expect(asked[0]).toMatchObject({ kind: "component", name: "gpu-gauge", card: "T1" });
    expect(asked[0].request).toContain("A gauge with a 60 s history line");
    expect(asked[0].request).toContain("card worker");
    // Its next run repeats the ask: not passed on again.
    r.peek.projectWorker(ledger({ status: "running", run: 2, text: report }));
    r.peek.projectWorker(ledger({ status: "done", run: 2, text: report }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(asked).toHaveLength(1);
  });

  it("the card's view says it waits for the component its worker asked for, and the worker's folded words and warning come apart", async () => {
    const r = rig("claude", undefined, () => []);
    const record = await answer(r, '<card title="Charts">go</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    r.peek.projectWorker(ledger({ status: "done", run: 1, text: 'Words.\n<component name="gpu-gauge">a gauge</component>' }));
    await waitFor("asked", () => record.workerCards![0]!.askedAt);
    expect(r.peek.messageView(record).workerCards[0]).toMatchObject({ waiting: "component", text: "Words." });
    record.workerCards![0]!.askedAt = Date.now() - 31 * 60_000;
    expect(r.peek.messageView(record).workerCards[0]).toMatchObject({ waiting: "late" });
    // The component came and the worker filled the card: no longer waiting.
    r.peek.projectWorker(ledger({ status: "done", run: 2, text: 'Done.\n<show name="inline-chart">{"x":1}</show>' }));
    expect(r.peek.messageView(record).workerCards[0].waiting).toBeUndefined();
    // A rejected command: the warning is its own field, not in the words.
    r.peek.projectWorker(ledger({ status: "done", run: 3, text: 'Words.\n<show name="git-log" command="python3 /elsewhere/g.py"></show>' }));
    const view = r.peek.messageView(record).workerCards[0];
    expect(view.warning).toMatch(/^⚠ the command/);
    expect(view.text).toBe("Words.");
  });

  it("a report read again at the app's start is shown on the card but its ask is not passed on (it was, or the app went away first)", async () => {
    const asked: any[] = [];
    const r = rig("claude", undefined, (_bot, requests) => { asked.push(...requests); return []; });
    const record = await answer(r, '<card title="Charts">go</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    r.peek.projectWorker(ledger({ status: "done", run: 1, text: 'x <component name="gpu-gauge">a gauge</component>' }), true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(record.workerCards![0]).toMatchObject({ wants: { name: "gpu-gauge" }, status: "done" });
    expect(asked).toHaveLength(0);
  });

  it("a report whose script command was not kept goes back to its worker once; a report read at the app's start, or the same bad command again, is not told", async () => {
    const r = rig();
    const record = await answer(r, '<card title="Git">Last 6 commits.</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    const told = () => r.handoff.mock.calls.filter(([tool]) => tool === "app_send_message");
    const bad = 'Last 6 commits.\n<show name="git-log" command="python3 /elsewhere/git-log.py 6"></show>';
    r.peek.projectWorker(ledger({ status: "done", run: 1, text: bad }));
    expect(record.workerCards![0]!.text).toContain("⚠");
    await waitFor("the rejection told", () => told().length === 1);
    expect(told()[0]![1]).toMatchObject({ task_id: "T1", message: expect.stringContaining("/elsewhere/git-log.py") });
    expect(told()[0]![1]!.message).toMatch(/^\(App: .*card-scripts/);
    // Its redo says the same again: shown, not told again.
    r.peek.projectWorker(ledger({ status: "running", run: 2, text: bad }));
    r.peek.projectWorker(ledger({ status: "done", run: 2, text: `${bad} ` }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(told()).toHaveLength(1);
  });

  it("a rejection read again at the app's start is shown on the card but not told to the worker", async () => {
    const r = rig();
    const record = await answer(r, '<card title="Git">go</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    r.peek.projectWorker(ledger({ status: "done", run: 1, text: 'x <show name="git-log" command="python3 /elsewhere/g.py"></show>' }), true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(record.workerCards![0]!.rejected).toBeDefined();
    expect(r.handoff.mock.calls.filter(([tool]) => tool === "app_send_message")).toHaveLength(0);
  });

  it("tellCardWorker sends the words to the worker as app_send_message", async () => {
    const r = rig();
    r.peek.workers.tellCardWorker("T1", "gpu-gauge is ready.");
    await waitFor("the message", () => r.handoff.mock.calls.some(([tool]) => tool === "app_send_message"));
    expect(r.handoff.mock.calls.find(([tool]) => tool === "app_send_message")![1]).toEqual({ task_id: "T1", message: "gpu-gauge is ready." });
  });
});

describe("redo with Opus: a new Opus worker takes over the card", () => {
  async function finished(r: ReturnType<typeof rig>) {
    const record = await answer(r, '<card title="Prices">Collect the prices.</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    r.peek.projectWorker(ledger({ status: "done", run: 1, text: 'Plans: A $5.\n<show name="inline-chart">{"series":[5]}</show>' }));
    expect(record.workerCards![0]).toMatchObject({ status: "done" });
    return record;
  }
  const handoffCalls = (r: ReturnType<typeof rig>) => r.handoff.mock.calls.filter(([tool]) => tool === "app_handoff");

  it("starts an opus worker at medium effort (not the haiku card's), given the request and what the first worker left, and binds the card to it", async () => {
    const r = rig();
    const record = await finished(r);
    r.handoff.mockImplementation(async (tool: string) => (tool === "app_handoff" ? { task_id: "T2", run: 1 } : {}));
    const done = await r.peek.workers.redoCard("T1", "a bar chart");
    expect(done).toEqual({ taskId: "T2", run: 1 });
    const [, args] = handoffCalls(r)[1]!;
    expect(args).toMatchObject({ model: "opus", effort: "medium", group: "Prices" });
    expect(String(args.instructions)).toContain("Collect the prices.");
    expect(String(args.instructions)).toContain(JSON.stringify("Plans: A $5."));
    expect(String(args.instructions)).toContain(JSON.stringify('{"series":[5]}'));
    expect(String(args.instructions)).toContain(JSON.stringify("a bar chart"));
    expect(record.workerCards![0]).toMatchObject({ taskId: "T2", model: "opus", status: "running", run: 1, earlier: ["T1"], text: "Plans: A $5." });
    expect(r.peek.messageView(record).workerCards[0]).toMatchObject({ taskId: "T2", model: "opus", status: "running" });
  });

  it("from then on the card follows the opus worker only, and the user's words on the card go to its task id", async () => {
    const r = rig();
    const record = await finished(r);
    r.handoff.mockImplementation(async (tool: string) => (tool === "app_handoff" ? { task_id: "T2", run: 1 } : {}));
    await r.peek.workers.redoCard("T1");
    r.peek.projectWorker(ledger({ id: "T1", status: "done", run: 2, text: "late words of the first worker" }));
    expect(record.workerCards![0]!.text).toBe("Plans: A $5.");
    r.peek.projectWorker(ledger({ id: "T2", status: "done", run: 1, text: 'Better.\n<show name="inline-chart">{"series":[5,9]}</show>' }));
    expect(record.workerCards![0]).toMatchObject({ status: "done", text: "Better.", taskId: "T2" });
    expect(record.workerCards![0]!.shows![0]!.data).toBe('{"series":[5,9]}');
    // The reply box sends to the card's task id: the opus worker's.
    const view = r.peek.messageView(record).workerCards[0];
    expect(Command.safeParse({ type: "agent.message", botId: "b", subagentId: view.taskId, text: "and yearly?" }).success).toBe(true);
    expect(view.taskId).toBe("T2");
  });

  it("neither worker's report wakes the head (the first worker's late one included); a stranger's still does", async () => {
    const r = rig();
    const record = await finished(r);
    r.handoff.mockImplementation(async (tool: string) => (tool === "app_handoff" ? { task_id: "T2", run: 1 } : {}));
    await r.peek.workers.redoCard("T1");
    const sent = () => fixture.heads.reduce((n, head) => n + head.sent.length, 0);
    const before = sent();
    expect(r.peek.workers.workerReport("<app_task_result>opus</app_task_result>", "T2")).toBe(true);
    expect(r.peek.workers.workerReport("<app_task_result>late first</app_task_result>", "T1")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent()).toBe(before);
    expect(record.workerCards).toHaveLength(1);
    expect(r.peek.workers.workerReport("<app_task_result>other</app_task_result>", "OTHER")).toBe(true);
    await waitFor("the other report to reach the head", () => sent() > before);
  });

  it("refuses while the card's worker is at work, when the card is already on Opus, for an unknown worker and for a non-Claude bot; nothing changes", async () => {
    const r = rig();
    const record = await answer(r, '<card title="Prices">Go.</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    const calls = () => handoffCalls(r).length;
    await expect(r.peek.workers.redoCard("T1")).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/still at work/) });
    r.peek.projectWorker(ledger({ status: "done", run: 1, text: "x" }));
    await expect(r.peek.workers.redoCard("NOPE")).rejects.toMatchObject({ code: "not_found" });
    expect(calls()).toBe(1);
    r.handoff.mockImplementation(async (tool: string) => (tool === "app_handoff" ? { task_id: "T2", run: 1 } : {}));
    await r.peek.workers.redoCard("T1");
    r.peek.projectWorker(ledger({ id: "T2", status: "done", run: 1, text: "y" }));
    await expect(r.peek.workers.redoCard("T2")).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/already redone/) });
    expect(calls()).toBe(2);
    expect(record.workerCards![0]).toMatchObject({ taskId: "T2", earlier: ["T1"] });
    const other = rig("codex");
    other.peek.records.push({ id: "m", role: "bot", text: "", date: 0, workerCards: [{ id: "11111111-2222-3333-4444-555555555555", title: "t", prompt: "p", status: "done", run: 1, taskId: "C1" }] });
    await expect(other.peek.workers.redoCard("C1")).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/Claude bot/) });
    expect(other.handoff).not.toHaveBeenCalled();
  });

  it("a double tap starts one worker; a handoff that fails leaves the card as it was and says why", async () => {
    const r = rig();
    const record = await finished(r);
    let release!: () => void;
    r.handoff.mockImplementation((tool: string) => (tool === "app_handoff" ? new Promise((resolve) => { release = () => resolve({ task_id: "T2", run: 1 }); }) : Promise.resolve({})));
    const first = r.peek.workers.redoCard("T1");
    await expect(r.peek.workers.redoCard("T1")).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/already being started/) });
    release();
    await first;
    expect(handoffCalls(r)).toHaveLength(2);

    const again = rig();
    const second = await finished(again);
    again.handoff.mockImplementation(async (tool: string) => { if (tool === "app_handoff") throw new Error("Too many workers are running."); return {}; });
    await expect(again.peek.workers.redoCard("T1")).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("Too many workers are running.") });
    expect(second.workerCards![0]).toMatchObject({ taskId: "T1", status: "done", text: "Plans: A $5." });
    expect(second.workerCards![0]!.model).toBeUndefined();
    // The failure released the guard: a second try starts.
    again.handoff.mockImplementation(async (tool: string) => (tool === "app_handoff" ? { task_id: "T3", run: 1 } : {}));
    await expect(again.peek.workers.redoCard("T1")).resolves.toMatchObject({ taskId: "T3" });
    void record;
  });

  it("the card's redo is a contract command: its shape, and nothing else is taken", () => {
    expect(Command.safeParse({ type: "card.redo", botId: "b", taskId: "T1" }).success).toBe(true);
    expect(Command.safeParse({ type: "card.redo", botId: "b", taskId: "T1", note: "again" }).success).toBe(true);
    expect(Command.safeParse({ type: "card.redo", botId: "b", taskId: "../x" }).success).toBe(false);
    expect(Command.safeParse({ type: "card.redo", botId: "b", taskId: "T1", model: "opus" }).success).toBe(false);
  });
});
