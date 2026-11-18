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
import { CARD_WORKER } from "../../src/core/agent/claude-workers";
import { ComponentsContext } from "../../src/core/components/service";
import { mainProfile } from "../../src/core/store/workspace";
import { botPrompts } from "../../src/core/prompts";
import { CodexThreads } from "../../src/core/agent/codex";
import { Command } from "../../src/contract";
import type { WorkerLedgerRecord } from "../../src/core/worker-core";
import { ComponentsContext } from "../../src/core/components/service";
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

/** `library`: a component library for the bot (name -> about.md; each gets a template). `realWorkers`: keep the real ClaudeWorkers (on the fake heads) instead of the handoff stand-in. */
function rig(engine: "claude" | "codex" = "claude", launch?: Record<string, unknown>, onRequests?: (bot: any, requests: any[]) => any[], extra: { library?: Record<string, string>; realWorkers?: boolean } = {}) {
  const folder = tempDir("bot-worker-cards"), profile = mainProfile(folder); mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine, model: "m", heads: { engines: [engine], answerWith: engine, codexModel: "m" } }));
  const events: any[] = [];
  const logs: string[] = [];
  let components: ComponentsContext | undefined;
  if (extra.library) {
    const root = join(folder, "lib-components");
    for (const [name, about] of Object.entries(extra.library)) { mkdirSync(join(root, name), { recursive: true }); writeFileSync(join(root, name, "template.html"), "<div></div>"); writeFileSync(join(root, name, "about.md"), about); }
    components = new ComponentsContext(join(folder, "lib-state"), () => [root]);
  }
  const b = new Bot({ profile, deferStartup: true, ...(components ? { components } : {}), ledger: { record() {}, forget() {} } as any,
    headConfig(_p, c) { return { ...c, command: "/never-spawn", cwd: folder, allowedTools: [] }; },
    codexConfig(_p, c) { return { command: "/never-spawn", cwd: folder, threads: new CodexThreads(join(folder, "threads")), sessionId: c.sessionId, resume: c.resume, model: c.codexModel, effort: c.effort, instructions: c.systemPrompt, workerInstructions: null } as any; },
    prompts: (e, heads) => botPrompts({ profile, engine: e, heads }),
    ...(launch ? { launch: () => ({ subagentHourCache: false, ...launch }) as any } : {}), ...(onRequests ? { onRequests } : {}),
    emit(event) { events.push(event); }, log(line: string) { logs.push(line); }, idleMs: 600000, approvalTimeoutMs: 1000, interruptGraceMs: 10, tidyTimeoutMs: 30 });
  bots.push(b);
  const peek = b as any;
  // The Claude worker host stands in: it takes the same `tool("app_handoff", …)` call a bot's own tool call makes.
  // Typed as ClaudeWorkers.tool is (it answers unknown), so a test may answer other tools with {}.
  const handoff = vi.fn(async (_name: string, _args: Record<string, unknown>): Promise<unknown> => ({ task_id: "T1", run: 1 }));
  if (!extra.realWorkers) peek.workers.ensureClaudeWorkers = () => ({ tool: handoff });
  return { b, peek, events, handoff, logs };
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
    expect(args).toMatchObject({ name: "Prices", group: "Prices", model: "haiku", effort: "low" });
    // The symbol (no JSON can carry it) makes it a card worker: lean process, the card rules as its system prompt.
    expect((args as Record<symbol, unknown>)[CARD_WORKER]).toBe(true);
    expect(String(args.instructions)).toContain("Collect the prices of the three plans.");
    // Only the card's own part is the message; the fixed rules are its system prompt (ClaudeWorkers `cardSystem`), not repeated per card.
    expect(String(args.instructions)).not.toContain("You are a card worker");
    expect(record.workerCards![0]).toMatchObject({ title: "Prices", taskId: "T1", status: "running", run: 1, at: "Checking.\n".length });
  });

  it("the worker's first message holds the catalog of the library as it is (a real library context), before the card's own words", async () => {
    const r = rig("claude", undefined, undefined, { library: { "inline-chart": "Inline chart: a chart.\nBuilt-in: yes\nData: {}", status: "Status card: ok.\nData: {}" } });
    const record = await answer(r, '<card title="Prices">Collect the prices of the three plans.</card>');
    await waitFor("the card to be bound to its worker", () => record.workerCards![0]!.taskId);
    const text = String(r.handoff.mock.calls[0]![1].instructions);
    expect(text).toContain("Components you may use");
    expect(text).toContain("- inline-chart (JSON): Inline chart");
    expect(text).toContain("- status (JSON): Status card");
    expect(text.indexOf("Components you may use")).toBeLessThan(text.indexOf("Collect the prices of the three plans."));
  });

  it("the real card worker process: its system prompt is the fixed rules (cardSystem is wired to them), and the catalog is not in it", async () => {
    const r = rig("claude", undefined, undefined, { library: { "inline-chart": "Inline chart: a chart.\nBuilt-in: yes\nData: {}", status: "Status card: ok.\nData: {}" }, realWorkers: true });
    const before = fixture.heads.length;
    await r.peek.workers.ensureClaudeWorkers().tool("app_handoff", { name: "c", instructions: "Show it.", group: "c", model: "haiku", effort: "low", [CARD_WORKER]: true });
    const head = fixture.heads.at(-1);
    expect(fixture.heads.length).toBeGreaterThan(before);
    const system = String(head.config.systemPrompt);
    expect(system).toContain("You are a card worker");
    expect(system).toContain(r.peek.workers.cardSystemNow());
    expect(system).not.toContain("Components you may use");
    expect(system).not.toContain("Inline chart: a chart.");
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

  it("every card of a reply gets a record and starts its worker at once, however many; above the worker limit (3 here) only a warning is logged", async () => {
    const r = rig("claude", { claudeWorkerLimit: 3 });
    let n = 0;
    r.handoff.mockImplementation(async () => ({ task_id: `T${++n}`, run: 1 }));
    const note = vi.spyOn(r.b, "queueNote");
    const record = await answer(r, [1, 2, 3, 4, 5, 6].map((k) => `<card title="c${k}">job ${k}</card>`).join("\n"));
    expect(record.workerCards).toHaveLength(6);
    await waitFor("six handoffs", () => r.handoff.mock.calls.length === 6);
    await waitFor("all bound", () => record.workerCards!.every((card) => card.taskId));
    expect(r.handoff.mock.calls.map((call) => (call[1] as { name: string }).name)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]);
    expect(record.workerCards!.map((card) => card.status)).toEqual(Array(6).fill("running"));
    // Nothing is held back or said to the bot; the warning is a log line with the count and the limit, one for each card above the limit.
    expect(note).not.toHaveBeenCalled();
    const warnings = r.logs.filter((line) => /\] warn: /.test(line));
    expect(warnings).toHaveLength(3);
    expect(warnings.map((line) => /warn: (\d+) card workers.*limit of (\d+)/.exec(line)!.slice(1))).toEqual([["4", "3"], ["5", "3"], ["6", "3"]]);
  });

  it("no warning at or below the worker limit", async () => {
    const r = rig("claude", { claudeWorkerLimit: 3 });
    const record = await answer(r, [1, 2, 3].map((k) => `<card title="c${k}">job ${k}</card>`).join("\n"));
    await waitFor("three handoffs", () => r.handoff.mock.calls.length === 3);
    await waitFor("bound", () => record.workerCards!.every((card) => card.taskId));
    expect(r.logs.filter((line) => /\] warn: /.test(line))).toEqual([]);
  });

  it("a card whose worker fails to start leaves the others alone", async () => {
    const r = rig("claude", { claudeWorkerLimit: 1 });
    r.handoff.mockRejectedValueOnce(new Error("no worker today"));
    const record = await answer(r, [1, 2].map((k) => `<card title="c${k}">job ${k}</card>`).join("\n"));
    await waitFor("both handoffs asked", () => r.handoff.mock.calls.length === 2);
    await waitFor("the second bound", () => record.workerCards![1]!.taskId);
    expect(record.workerCards![0]).toMatchObject({ status: "failed", error: "no worker today" });
    expect(record.workerCards![1]).toMatchObject({ status: "running", taskId: "T1" });
  });

  it("a later reply's card starts at once too, with the limit already reached by earlier cards", async () => {
    const r = rig("claude", { claudeWorkerLimit: 2 });
    let n = 0;
    r.handoff.mockImplementation(async () => ({ task_id: `T${++n}`, run: 1 }));
    await answer(r, [1, 2].map((k) => `<card title="a${k}">job</card>`).join("\n"));
    await waitFor("two handoffs", () => r.handoff.mock.calls.length === 2);
    await waitFor("both bound", () => n === 2 && r.peek.records.every((line: any) => (line.workerCards ?? []).every((card: any) => card.taskId)));
    const later = { id: "later", role: "bot", text: "", date: 0, workerCards: [{ id: "11111111-1111-4111-8111-111111111111", title: "b1", prompt: "job", status: "starting", run: 0 }] };
    r.peek.records.push(later);
    r.peek.workers.startCards(later);
    await waitFor("the third handoff", () => r.handoff.mock.calls.length === 3);
    await waitFor("bound", () => (later.workerCards[0] as { taskId?: string }).taskId);
    expect(later.workerCards[0]).toMatchObject({ status: "running" });
    expect(r.logs.filter((line) => /\] warn: /.test(line))).toHaveLength(1);
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

    r.peek.projectWorker(ledger({ status: "done", run: 1, text: 'Plans: A $5, B $9.\n<show name="inline-chart">{"kind":"bars","items":[{"label":"A","value":5},{"label":"B","value":9}]}</show>' }));
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

  it("restoring the bot (restoreAtStart) starts a card that has no worker, exactly once", async () => {
    const r = rig();
    const record = await answer(r, '<card title="t">go</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    // The stored state at the next start: the card was never given a worker.
    record.workerCards![0]!.status = "starting";
    delete record.workerCards![0]!.taskId;
    r.handoff.mockClear();
    r.peek.workers.restoreAtStart();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await waitFor("the card to start", () => record.workerCards![0]!.taskId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.handoff).toHaveBeenCalledTimes(1);
    expect(record.workerCards![0]).toMatchObject({ status: "running", taskId: "T1" });
  });

  it("a card whose worker never started when the app went away starts at the next start instead of vanishing", async () => {
    const r = rig();
    const record = await answer(r, '<card title="t">go</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    // Simulate the stored state: starting, no worker.
    record.workerCards![0]!.status = "starting";
    delete record.workerCards![0]!.taskId;
    r.handoff.mockClear();
    r.peek.workers.requeueCards();
    expect(record.workerCards![0]).toMatchObject({ status: "starting" });
    await waitFor("the card to start", () => record.workerCards![0]!.taskId);
    expect(r.handoff).toHaveBeenCalledTimes(1);
    expect(record.workerCards![0]).toMatchObject({ status: "running", taskId: "T1" });
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
    expect(record.workerCards![0]).toMatchObject({ wants: { kind: "usage", name: "gpu-gauge" }, asked: true });
    await waitFor("the ask", () => asked.length === 1);
    // A name the worker wrote is a lookup, never a component request: it is its own kind and carries the task id, and Maintainer's plain `component` kind is not used for a card.
    expect(asked[0]).toMatchObject({ kind: "cardUsage", name: "gpu-gauge", card: "T1" });
    expect(asked.some((request) => request.kind === "component")).toBe(false);
    expect(asked[0].request).toContain("A gauge with a 60 s history line");
    expect(asked[0].request).toContain("card worker");
    // Its next run repeats the ask: not passed on again.
    r.peek.projectWorker(ledger({ status: "running", run: 2, text: report }));
    r.peek.projectWorker(ledger({ status: "done", run: 2, text: report }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(asked).toHaveLength(1);
  });

  it("a chart the worker only describes is passed on as a described need (no name, the task id on it); with a named component beside it, only the need is passed on", async () => {
    const asked: any[] = [];
    const r = rig("claude", undefined, (_bot, requests) => { asked.push(...requests); return []; });
    const record = await answer(r, '<card title="Charts">Show the GPU load.</card>');
    await waitFor("bound", () => record.workerCards![0]!.taskId);
    r.peek.projectWorker(ledger({ status: "done", run: 1, text: 'No fit.\n<component name="gpu-gauge">my own name</component><component>A gauge with a history line.</component>' }));
    await waitFor("the ask", () => asked.length === 1);
    expect(asked[0]).toEqual({ kind: "cardNeed", request: expect.stringContaining("A gauge with a history line."), card: "T1" });
    expect(asked[0].request).not.toContain("my own name");
    expect(asked[0]).not.toHaveProperty("name");
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
    r.peek.projectWorker(ledger({ status: "done", run: 2, text: 'Done.\n<show name="inline-chart">{"kind":"bars","items":[{"label":"x","value":1}]}</show>' }));
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
    expect(record.workerCards![0]).toMatchObject({ wants: { kind: "usage", name: "gpu-gauge" }, status: "done" });
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

  describe("a report whose component JSON breaks its usage (a progress value above its max)", () => {
    const over = 'Scenarios.\n<show name="inline-report-block">{"type":"progress","items":[{"label":"p50","value":120,"max":100}]}</show>';
    const good = 'Scenarios.\n<show name="inline-report-block">{"type":"progress","items":[{"label":"p50","value":80,"max":100}]}</show>';
    const MESSAGE = "items[0].value 120 is more than its max 100";
    const told = (r: ReturnType<typeof rig>) => r.handoff.mock.calls.filter(([tool]) => tool === "app_send_message");
    async function bound(r: ReturnType<typeof rig>) {
      const record = await answer(r, '<card title="Perf">Show p50 per scenario.</card>');
      await waitFor("bound", () => record.workerCards![0]!.taskId);
      return record;
    }

    it("is not drawn: the card stays at work, the worker is told the exact errors once, and its corrected report is drawn clean", async () => {
      const r = rig();
      const record = await bound(r);
      r.peek.projectWorker(ledger({ status: "done", run: 1, text: over }));
      const card = record.workerCards![0]!;
      expect(card).toMatchObject({ status: "running", invalidRun: 1, invalidTold: true });
      expect(card.shows).toBeUndefined();
      expect(card.text).toBeUndefined();
      expect(r.peek.messageView(record).workerCards[0]).toMatchObject({ status: "running" });
      await waitFor("the correction told", () => told(r).length === 1);
      expect(told(r)[0]![1]).toMatchObject({ task_id: "T1", message: expect.stringContaining(MESSAGE) });
      expect(String(told(r)[0]![1].message)).toContain("This is your one correction.");
      // The worker's next run ends with a corrected report: drawn, nothing more told.
      r.peek.projectWorker(ledger({ status: "running", run: 2 }));
      r.peek.projectWorker(ledger({ status: "done", run: 2, text: good }));
      expect(card).toMatchObject({ status: "done", text: "Scenarios.", shows: [{ name: "inline-report-block" }] });
      expect(card.invalid).toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));
      expect(told(r)).toHaveLength(1);
    });

    it("a worker whose run ended before app_handoff answered (its ledger is already there) is held and told too", async () => {
      const r = rig();
      r.handoff.mockImplementation(async (tool: string) => {
        if (tool !== "app_handoff") return {};
        r.peek.workers.workerViews.set("T1", ledger({ status: "done", run: 1, text: over }));
        return { task_id: "T1", run: 1 };
      });
      const record = await answer(r, '<card title="Perf">Show p50 per scenario.</card>');
      await waitFor("the correction told", () => told(r).length === 1);
      expect(record.workerCards![0]).toMatchObject({ status: "running", invalidRun: 1, invalidTold: true });
      expect(told(r)[0]![1]).toMatchObject({ task_id: "T1", message: expect.stringContaining(MESSAGE) });
    });

    it("still wrong after the one correction: the card is drawn with the errors stated, and the worker is not told again", async () => {
      const r = rig();
      const record = await bound(r);
      r.peek.projectWorker(ledger({ status: "done", run: 1, text: over }));
      await waitFor("the correction told", () => told(r).length === 1);
      r.peek.projectWorker(ledger({ status: "running", run: 2 }));
      r.peek.projectWorker(ledger({ status: "done", run: 2, text: over }));
      const view = r.peek.messageView(record).workerCards[0];
      expect(view).toMatchObject({ status: "done", text: "Scenarios." });
      expect(view.warning).toContain("still wrong after the one correction");
      expect(view.warning).toContain(MESSAGE);
      expect(record.workerCards![0]!.shows).toHaveLength(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(told(r)).toHaveLength(1);
    });

    it("a report read again at the app's start is drawn as it is (nobody is left to correct it) and is not told", async () => {
      const r = rig();
      const record = await bound(r);
      r.peek.projectWorker(ledger({ status: "done", run: 1, text: over }), true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(record.workerCards![0]).toMatchObject({ status: "done", shows: [{ name: "inline-report-block" }] });
      expect(record.workerCards![0]!.invalid).toBeUndefined();
      expect(told(r)).toHaveLength(0);
    });

    it("a worker that cannot be told gives up the correction: the card is drawn with the errors stated, not left at work for ever", async () => {
      const r = rig();
      const record = await bound(r);
      r.handoff.mockImplementation(async (tool: string) => { if (tool === "app_send_message") throw new Error("worker is gone"); return { task_id: "T1", run: 1 }; });
      r.peek.projectWorker(ledger({ status: "done", run: 1, text: over }));
      await waitFor("the card to be drawn", () => record.workerCards![0]!.status === "done");
      expect(record.workerCards![0]).toMatchObject({ invalidRun: -1, shows: [{ name: "inline-report-block" }] });
      expect(r.peek.messageView(record).workerCards[0].warning).toContain(MESSAGE);
    });

    it("a failure to tell a worker that the card no longer follows (the card was rebound to another worker meanwhile) changes nothing", async () => {
      const r = rig();
      const record = await bound(r);
      r.handoff.mockImplementation(async (tool: string) => {
        if (tool !== "app_send_message") return { task_id: "T1", run: 1 };
        record.workerCards![0]!.taskId = "T9";
        throw new Error("worker is gone");
      });
      r.peek.projectWorker(ledger({ status: "done", run: 1, text: over }));
      await waitFor("the send tried", () => record.workerCards![0]!.taskId === "T9");
      await new Promise((resolve) => setImmediate(resolve));
      expect(record.workerCards![0]).toMatchObject({ status: "running", invalidRun: 1 });
      expect(record.workerCards![0]!.shows).toBeUndefined();
    });
  });

  describe("a report whose <show> names a component that is not in the library (haiku, 2026-11-18: name=\"progress\", drawn as nothing)", () => {
    const progress = 'Done.\n<show name="progress">{"type":"progress","items":[{"label":"a","value":50,"max":100}]}</show>';
    const told = (r: ReturnType<typeof rig>) => r.handoff.mock.calls.filter(([tool]) => tool === "app_send_message");
    // A real library with the two inline components (the bot's `options.components`: the rig has none by default).
    function withLibrary(r: ReturnType<typeof rig>) {
      const root = join(tempDir("card-unknown-lib"), "components");
      for (const name of ["inline-chart", "inline-report-block"]) {
        mkdirSync(join(root, name), { recursive: true });
        writeFileSync(join(root, name, "template.html"), "<div></div>");
        writeFileSync(join(root, name, "about.md"), `${name}: a component.\nData: {}`);
      }
      (r.b as any).options.components = new ComponentsContext(tempDir("card-unknown-ctx"), () => [root]);
    }

    it("is held back like any invalid report: the worker is told the name is not in the library, with the inline-report-block hint, once", async () => {
      const r = rig();
      withLibrary(r);
      const record = await answer(r, '<card title="Progress">Show the progress.</card>');
      await waitFor("bound", () => record.workerCards![0]!.taskId);
      r.peek.projectWorker(ledger({ status: "done", run: 1, text: progress }));
      const card = record.workerCards![0]!;
      expect(card).toMatchObject({ status: "running", invalidRun: 1, invalidTold: true });
      expect(card.shows).toBeUndefined();
      await waitFor("the correction told", () => told(r).length === 1);
      const message = String(told(r)[0]![1].message);
      expect(told(r)[0]![1]).toMatchObject({ task_id: "T1" });
      expect(message).toContain('component "progress"');
      expect(message).toContain("not in the library");
      expect(message).toContain('inline-report-block with type "progress"');
      expect(message).toContain("This is your one correction.");
    });
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
    r.peek.projectWorker(ledger({ status: "done", run: 1, text: 'Plans: A $5.\n<show name="inline-chart">{"kind":"bars","items":[{"label":"A","value":5}]}</show>' }));
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
    // The redo is no card worker: no lean flags, tools or card system prompt of the haiku worker (its rules come in its message).
    expect((args as Record<symbol, unknown>)[CARD_WORKER]).toBeUndefined();
    expect(String(args.instructions)).toContain("Collect the prices.");
    expect(String(args.instructions)).toContain(JSON.stringify("Plans: A $5."));
    expect(String(args.instructions)).toContain(JSON.stringify('{"kind":"bars","items":[{"label":"A","value":5}]}'));
    expect(String(args.instructions)).toContain(JSON.stringify("a bar chart"));
    expect(record.workerCards![0]).toMatchObject({ taskId: "T2", model: "opus", status: "running", run: 1, earlier: ["T1"], text: "Plans: A $5." });
    expect(r.peek.messageView(record).workerCards[0]).toMatchObject({ taskId: "T2", model: "opus", status: "running" });
  });

  const catalog = { components: "- one (JSON): CATALOG-LINE", others: "", scriptsDir: "/p/.bot/card-scripts", usageDir: "/p/.bot/card-usage" };
  const whole = { components: "WHOLE-USAGE-MARKER", others: "", scriptsDir: "/p/.bot/card-scripts" };
  async function redoText(brief: typeof catalog | null) {
    const r = rig();
    r.peek.cards.cardCatalogBrief = () => brief;
    r.peek.cards.cardBrief = () => whole;
    const record = await finished(r);
    r.handoff.mockImplementation(async (tool: string) => (tool === "app_handoff" ? { task_id: "T2", run: 1 } : {}));
    await r.peek.workers.redoCard("T1");
    expect(record.workerCards![0]).toMatchObject({ taskId: "T2" });
    return String(handoffCalls(r)[1]![1].instructions);
  }
  it("the redo is given the catalog brief (usage files) like the first worker", async () => {
    const text = await redoText(catalog);
    expect(text).toContain("CATALOG-LINE");
    expect(text).not.toContain("WHOLE-USAGE-MARKER");
  });
  it("the redo is given the usages up front when the usage files cannot be written", async () => {
    const text = await redoText(null);
    expect(text).toContain("WHOLE-USAGE-MARKER");
    expect(text).not.toContain("CATALOG-LINE");
  });

  it("from then on the card follows the opus worker only, and the user's words on the card go to its task id", async () => {
    const r = rig();
    const record = await finished(r);
    r.handoff.mockImplementation(async (tool: string) => (tool === "app_handoff" ? { task_id: "T2", run: 1 } : {}));
    await r.peek.workers.redoCard("T1");
    r.peek.projectWorker(ledger({ id: "T1", status: "done", run: 2, text: "late words of the first worker" }));
    expect(record.workerCards![0]!.text).toBe("Plans: A $5.");
    r.peek.projectWorker(ledger({ id: "T2", status: "done", run: 1, text: 'Better.\n<show name="inline-chart">{"kind":"bars","items":[{"label":"A","value":5},{"label":"B","value":9}]}</show>' }));
    expect(record.workerCards![0]).toMatchObject({ status: "done", text: "Better.", taskId: "T2" });
    expect(record.workerCards![0]!.shows![0]!.data).toBe('{"kind":"bars","items":[{"label":"A","value":5},{"label":"B","value":9}]}');
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

  it("an opus run that fails with no report keeps the first worker's drawing on the card, shown with the failure", async () => {
    const r = rig();
    const record = await finished(r);
    r.handoff.mockImplementation(async (tool: string) => (tool === "app_handoff" ? { task_id: "T2", run: 1 } : {}));
    await r.peek.workers.redoCard("T1");
    r.peek.projectWorker(ledger({ id: "T2", status: "failed", run: 1 }));
    expect(record.workerCards![0]).toMatchObject({ taskId: "T2", model: "opus", status: "failed", text: "Plans: A $5.", error: expect.stringMatching(/failed without a report.*earlier drawing is kept/) });
    expect(record.workerCards![0]!.shows![0]!.data).toBe('{"kind":"bars","items":[{"label":"A","value":5}]}');
    const view = r.peek.messageView(record).workerCards[0];
    expect(view).toMatchObject({ status: "failed", model: "opus", text: "Plans: A $5.", error: expect.stringMatching(/earlier drawing is kept/) });
  });

  it("while the app is stopping a redo starts nothing and says so", async () => {
    const r = rig();
    const record = await finished(r);
    const before = handoffCalls(r).length;
    r.peek.shuttingDown = true;
    await expect(r.peek.workers.redoCard("T1")).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/app is stopping/) });
    expect(handoffCalls(r)).toHaveLength(before);
    expect(record.workerCards![0]).toMatchObject({ taskId: "T1", status: "done" });
    expect(record.workerCards![0]!.model).toBeUndefined();
  });

  it("a card that changed while the redo was starting is left alone and the new worker is cancelled", async () => {
    const r = rig();
    const record = await finished(r);
    r.handoff.mockImplementation(async (tool: string) => {
      if (tool !== "app_handoff") return {};
      // Another path bound the card elsewhere while the handoff was answered.
      record.workerCards![0]!.taskId = "Z9";
      return { task_id: "T2", run: 1 };
    });
    await expect(r.peek.workers.redoCard("T1")).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/changed while the redo was starting/) });
    expect(record.workerCards![0]).toMatchObject({ taskId: "Z9", status: "done" });
    expect(record.workerCards![0]!.model).toBeUndefined();
    expect(r.handoff.mock.calls.find(([tool]) => tool === "app_cancel_task")![1]).toEqual({ task_id: "T2" });
  });

  it("the card's redo is a contract command: its shape, and nothing else is taken", () => {
    expect(Command.safeParse({ type: "card.redo", botId: "b", taskId: "T1" }).success).toBe(true);
    expect(Command.safeParse({ type: "card.redo", botId: "b", taskId: "T1", note: "again" }).success).toBe(true);
    expect(Command.safeParse({ type: "card.redo", botId: "b", taskId: "../x" }).success).toBe(false);
    expect(Command.safeParse({ type: "card.redo", botId: "b", taskId: "T1", model: "opus" }).success).toBe(false);
  });
});
