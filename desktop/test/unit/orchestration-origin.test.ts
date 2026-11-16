// M7-O05 items 4 and 5 (the properties of spec/models/heard/OrchestrationHeard.tla that did not hold at c1b17be2): the plugin a bot's turn stems
// from belongs to the message (fixed when the turn starts), not to the bot. NoAmplification (P9): a turn of a plugin's message, and the turns
// of its workers' reports, never start a worker with the bot's own rights, whatever the user writes meanwhile. NoOverreach (P8): a plugin's turn
// is checked as that plugin, never as another. UserTurnsFree: a turn of the user's is never checked as a plugin's. And `app_send_message`
// (item 5): under a plugin's mark only that plugin's own worker takes a new run, while the plugin is allowed.
// The real core with a real main bot; no agent runs. `swapHold` keeps every turn in the queue, and `startNext` begins the next one by hand (it is
// what `begin` does to `bot.turn`), so the trace of the model can be driven step by step.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Core as RealCore } from "../../src/core/server";
import type { Core } from "../../src/core/server";
import type { Bot } from "../../src/core/bot";
import type { Turn } from "../../src/core/bot/types";
import { CoreSend } from "../../src/core/server/send";
import { PluginWorkers, type OrchestrationWorld, type PluginFacts, type WorkerPort } from "../../src/core/orchestration/plugin-workers";
import { writeHandover, takeHandover } from "../../src/core/hot-swap";
import { noReport } from "../../src/core/worker-core/lives";
import { tempDir } from "../helpers";

const ALL = ["orchestrate", "exec", "files", "bots"];
const running: Core[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const core of running.splice(0)) await core.shutdown(); });

function plugin(dir: string, name: string, permissions: string[], root: "plugins" | "builtin") {
  const folder = join(dir, root, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, displayName: name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", permissions } }));
  writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}");
}

/** `granted`: the plugins the user allowed `orchestrate`. "shipped" is a plugin shipped with Botling; "pa" and "pb" are not. */
function originCore(granted: string[] = []) {
  const dir = tempDir("o05-origin");
  plugin(dir, "shipped", ALL, "builtin");
  plugin(dir, "pa", ALL, "plugins");
  plugin(dir, "pb", ALL, "plugins");
  const core = new RealCore({
    dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    plugins: { node: null, hostScript: "", sealer: null, builtIns: join(dir, "builtin") },
    // Only `orchestrate`: the "installed" answer (no card, any bot) is the approval of the program part, not what these tests grant.
    pluginCapability: (name, capability) => capability === "orchestrate" && granted.includes(name),
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0,
  });
  running.push(core);
  const bots = (core as unknown as { bots: Map<string, Bot> }).bots;
  const main = [...bots.values()].find((bot) => bot.profile.role === "main") ?? [...bots.values()][0]!;
  main.swapHold = true;
  const ask = (method: string, params: unknown) => (core.plugins as unknown as { requested(m: string, p: unknown): Promise<unknown> }).requested(method, params);
  const send = (name: string, text = "start workers for me") => ask("bots.send", { plugin: name, bot: "main", text });
  const user = (text = "hello") => (core as unknown as { coreSend: CoreSend }).coreSend.sendWith(main, text, { files: [] });
  const startNext = (): Turn => { const turn = main.queue.shift(); if (!turn) throw new Error("no turn waits"); main.turn = turn; return turn; };
  const workers = main.ensureClaudeWorkers();
  // The handoff itself (what `run` is for the admit hook): it counts, and never starts a process.
  const handoffNow = vi.spyOn(workers.core as unknown as { handoffNow(): Promise<unknown> }, "handoffNow").mockResolvedValue({ accepted: true, task_id: "H", run: 1 });
  const handoff = () => workers.core.handoff("claude-process", { instructions: "do it" });
  const records = (workers.core as unknown as { records: Map<string, unknown> }).records;
  /** A worker already in the bot's ledger (`by`: the plugin that started it). */
  const seed = (id: string, by?: string) => records.set(id, {
    v: 3, id, engine: "claude", adapter: "claude-process", name: id, instructions: "work", type: null, ownerSessionId: "s", run: 1, status: "done",
    report: { ...noReport(), state: "acknowledged" }, conversationId: null, processes: [], createdAt: 1, runStartedAt: 1, endedAt: 2, engineData: {},
    ...(by ? { startedBy: { plugin: by, hash: "a".repeat(64) } } : {}),
  });
  const sendToWorker = vi.spyOn(workers.core, "sendToWorker").mockResolvedValue({ ok: true, how: "steered", run: 1 } as never);
  const message = (task_id: string) => workers.tool("app_send_message", { task_id, message: "one more thing" });
  return { dir, core, main, ask, send, user, startNext, workers, handoff, handoffNow, seed, sendToWorker, message, queue: () => main.queue };
}

describe("item 4: the plugin a turn stems from is fixed when the turn starts", () => {
  it("NoAmplification: the user writing while a plugin's message waits does not clear the mark of that message's turn", async () => {
    const t = originCore();
    await t.send("pa");
    await t.user("hello");
    expect(t.queue()).toHaveLength(2);
    t.startNext();
    await expect(t.handoff()).rejects.toThrow(/permission/);
    expect(t.handoffNow).not.toHaveBeenCalled();
  });

  it("the user's own turn, queued behind it, starts workers as it always did", async () => {
    const t = originCore();
    await t.send("pa");
    await t.user("hello");
    t.startNext();
    await expect(t.handoff()).rejects.toThrow(/permission/);
    t.main.turn = null;
    t.startNext();
    await expect(t.handoff()).resolves.toBeTruthy();
    expect(t.handoffNow).toHaveBeenCalledTimes(1);
  });

  it("UserTurnsFree: a plugin's message that comes in while the user's turn runs does not mark the user's turn", async () => {
    const t = originCore();
    await t.user("hello");
    t.startNext();
    await t.send("pa");
    await expect(t.handoff()).resolves.toBeTruthy();
    expect(t.handoffNow).toHaveBeenCalledTimes(1);
  });

  it("a plugin shipped with Botling is a deputy: its message marks nothing", async () => {
    const t = originCore();
    await t.send("shipped");
    t.startNext();
    await expect(t.handoff()).resolves.toBeTruthy();
    expect(t.handoffNow).toHaveBeenCalledTimes(1);
  });

  it("NoOverreach: a plugin's turn is checked as that plugin, not as the one that wrote after it", async () => {
    const t = originCore(["pb"]);
    await t.send("pa");
    await t.send("pb");
    // pa has no grant: refused as pa. pb has the grant: checked as pb (the next refusal is about bots it did not make, not about the grant).
    t.startNext();
    await expect(t.handoff()).rejects.toThrow(/permission/);
    t.main.turn = null;
    t.startNext();
    await expect(t.handoff()).rejects.toThrow(/made itself/);
    expect(t.handoffNow).not.toHaveBeenCalled();
  });

  it("the report of a worker a plugin started is a turn of that plugin's: it inherits the mark from the run (and the bot's own worker's report does not)", async () => {
    const t = originCore();
    t.seed("W1", "pa");
    t.seed("W2");
    expect(t.main.workers.workerReport("<app_task_result task_id=\"W1\">done</app_task_result>", "W1")).toBe(true);
    expect(t.main.workers.workerReport("<app_task_result task_id=\"W2\">done</app_task_result>", "W2")).toBe(true);
    expect(t.queue()).toHaveLength(2);
    t.startNext();
    await expect(t.handoff()).rejects.toThrow(/permission/);
    t.main.turn = null;
    t.startNext();
    await expect(t.handoff()).resolves.toBeTruthy();
    expect(t.handoffNow).toHaveBeenCalledTimes(1);
  });

  it("a plugin's message is never read into the turn under way (it would carry the plugin's words into a turn checked as the user's)", async () => {
    const t = originCore();
    await t.user("hello");
    const current = t.startNext();
    await t.send("pa");
    const waiting = t.queue()[0]!;
    const canSteer = (next: Turn) => (t.main.turns as unknown as { canSteer(current: Turn, next: Turn): boolean }).canSteer(current, next);
    // The turn under way is one a user's message would be read into: a head that runs it, nothing waiting behind it.
    const head = { running: true };
    vi.spyOn(t.main, "head", "get").mockReturnValue(head as never);
    Object.assign(current, { open: true, sent: true, head, conducted: false });
    t.main.queue.length = 0;
    expect(canSteer({ ...waiting, plugin: undefined } as Turn)).toBe(true);
    expect(canSteer(waiting)).toBe(false);
  });

  it("the plugin of a waiting turn survives a hot swap (the hand-over carries it, and the new core's turn is the plugin's)", async () => {
    const t = originCore();
    await t.send("pa");
    const entries = t.main.swapEntries(false);
    expect(entries.flatMap((entry) => entry.queued).map((queued) => (queued as { plugin?: string }).plugin)).toEqual(["pa"]);
    t.main.queue.length = 0;
    t.main.adoptSwap(entries);
    expect(t.queue().map((turn) => (turn as { plugin?: string }).plugin)).toEqual(["pa"]);
  });

  it("the plugin of a waiting turn survives the swap file (the hand-over written and read back)", async () => {
    const t = originCore();
    await t.send("pa");
    writeHandover(t.dir, t.main.swapEntries(false));
    expect(takeHandover(t.dir)!.entries.flatMap((entry) => entry.queued).map((queued) => (queued as { plugin?: string }).plugin)).toEqual(["pa"]);
  });

  it("the plugin of a waiting turn survives a restart (the journal's entry carries it, and the turn made from it is the plugin's)", async () => {
    const t = originCore();
    await t.send("pa");
    const entries = t.main.restartEntries();
    expect(entries.flatMap((entry) => entry.queued).map((queued) => (queued as { plugin?: string }).plugin)).toEqual(["pa"]);
    t.main.queue.length = 0;
    t.main.adoptRestart({ ...entries[0]!, state: "pending" });
    expect(t.queue().map((turn) => turn.plugin)).toEqual(["pa"]);
  });
});

describe("item 5: app_send_message under a plugin's mark", () => {
  it("NoAmplification: a plugin's turn gives the bot's own worker no new run; the user's turn does", async () => {
    const t = originCore();
    t.seed("OWN");
    await t.send("pa");
    await t.user("hello");
    t.startNext();
    await expect(t.message("OWN")).rejects.toThrow(/plugin/);
    expect(t.sendToWorker).not.toHaveBeenCalled();
    t.main.turn = null;
    t.startNext();
    await expect(t.message("OWN")).resolves.toBeTruthy();
    expect(t.sendToWorker).toHaveBeenCalledTimes(1);
  });

  it("what the gate sent is the answer, and the message is not sent a second time", async () => {
    const t = originCore();
    t.seed("MINE", "pa");
    const admitted = vi.spyOn(t.core.plugins.workers(), "admitMessage").mockResolvedValue({ run: 2, how: "newRun" });
    await t.send("pa");
    t.startNext();
    await expect(t.message("MINE")).resolves.toMatchObject({ task_id: "MINE", run: 2, status: "accepted" });
    expect(admitted).toHaveBeenCalledWith("pa", "MINE", "one more thing");
    expect(t.sendToWorker).not.toHaveBeenCalled();
  });

  it("a plugin's turn gives another plugin's worker no new run either", async () => {
    const t = originCore();
    t.seed("OTHERS", "pb");
    await t.send("pa");
    t.startNext();
    await expect(t.message("OTHERS")).rejects.toThrow(/plugin/);
    expect(t.sendToWorker).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// PluginWorkers.admitMessage: only that plugin's own worker, while the plugin is allowed.
function book(options: { granted?: boolean } = {}) {
  const log = { sent: [] as string[] };
  const port: WorkerPort = {
    id: "b1",
    start: async () => ({ task_id: "T1", run: 1 }),
    send: async (_id, text) => { log.sent.push(text); return { ok: true, how: "steered", run: 1 }; },
    stop: async () => true,
  };
  const state = { granted: options.granted ?? true };
  const world: OrchestrationWorld = { granted: () => state.granted, workers: (bot) => (bot === "b1" ? port : "No such bot."), quota: () => ({ atOnce: 4 }), specWriters: () => ["opus"] };
  const facts = (name: string): PluginFacts => ({ name, identity: "a".repeat(64), permissions: ALL, botWritten: false });
  const workers = new PluginWorkers({ world, facts, ask: async () => ({ index: 0 }), tell: () => {} });
  return { workers, log, state };
}

describe("item 5: PluginWorkers.admitMessage", () => {
  it("sends to a worker the plugin started (the book's own send: the same checks as workers.send)", async () => {
    const { workers, log } = book();
    const { taskId } = await workers.start("p", { bot: "b1", instructions: "first" });
    await expect(workers.admitMessage("p", taskId, "more")).resolves.toMatchObject({ run: 1 });
    expect(log.sent).toEqual(["more"]);
  });

  it("refuses a worker the plugin did not start (the bot's own, or another plugin's), and sends nothing", async () => {
    const { workers, log } = book();
    const { taskId } = await workers.start("p", { bot: "b1", instructions: "first" });
    await expect(workers.admitMessage("q", taskId, "more")).rejects.toThrow(/plugin/);
    await expect(workers.admitMessage("p", "the-bots-own", "more")).rejects.toThrow(/plugin/);
    expect(log.sent).toEqual([]);
  });

  it("refuses once the user took the grant away", async () => {
    const t = book();
    const { taskId } = await t.workers.start("p", { bot: "b1", instructions: "first" });
    t.state.granted = false;
    await expect(t.workers.admitMessage("p", taskId, "more")).rejects.toThrow(/plugin/);
    expect(t.log.sent).toEqual([]);
  });
});
