// M7-S60: the thin `Bot`. What moved out of bot.ts in this card, and the one body that stays (`shutdown`), pinned by the order in
// which they call their collaborators:
//   - `shutdown`: the old order of its steps (claim, idle timer, API retry, shuttingDown, the line, the settings hold, the deferred turn,
//     the working turn's stop, the approvals, the tidy, the head's end, the Claude workers, the subagents, the chat);
//   - `Bot.begin` -> `TurnControl.launch` (start, delivered, redrawQueued, clearIdle, turn.started, updated, deliver; a user's turn
//     delivers after the answer, in a setImmediate);
//   - the constructor's worker restore -> `BotWorkers.restoreAtStart` (ledger, stopRunning, Claude workers, redeliver);
//   - `Bot.monitorState` -> `monitorStateOf`, which also runs on a bare object as `this`.
// Written against the code before the move: every expectation is what the old inline bodies did, in their order.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fixture = vi.hoisted(() => {
  const heads: any[] = [];
  class Head {
    running = false; pid = 0; exited = Promise.resolve(); completionDependencies: any[] = []; sent: string[] = [];
    constructor(readonly config: any, readonly handlers: any) { heads.push(this); }
    start() { this.running = true; queueMicrotask(() => this.handlers.onItem({ kind: "init", sessionId: this.config.sessionId })); }
    send(text: string) { this.sent.push(text); }
    interrupt() {}
    item(item: any) { this.handlers.onItem(item); }
    finish() { this.running = false; this.handlers.onExit({ code: 0, signal: null, stderr: "", expected: true, silent: false }); }
    async terminate() { this.finish(); return { killed: [], forced: false }; }
  }
  return { heads, Head };
});
vi.mock("../../src/core/agent/head", async (original) => ({ ...await original<any>(), ClaudeHead: class extends fixture.Head {} }));
import { Bot } from "../../src/core/bot";
import { monitorStateOf } from "../../src/core/bot/head-events";
import { BotWorkers } from "../../src/core/bot/workers";
import { SubagentBook } from "../../src/core/subagents";
import { mainProfile } from "../../src/core/store/workspace";
import { botPrompts } from "../../src/core/prompts";
import { tempDir } from "../helpers";

const bots: Bot[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-16T09:00:00.000Z")); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const b of bots.splice(0)) await b.shutdown({ tidy: false }).catch(() => {});
  fixture.heads.length = 0;
  vi.useRealTimers();
});
const flush = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
async function waitFor(what: string, ok: () => unknown) {
  for (let i = 0; i < 400; i++) { if (ok()) return; await new Promise((r) => setImmediate(r)); }
  throw new Error(`gave up waiting for ${what}`);
}

function make(order: string[] = [], opts: { engine?: "claude" | "codex"; files?: Record<string, string>; quitTidyMs?: number } = {}) {
  const folder = tempDir("bot-thin"), profile = mainProfile(folder); mkdirSync(profile.storeDir, { recursive: true });
  const engine = opts.engine ?? "claude";
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine, model: "m", heads: { engines: [engine], answerWith: engine } }));
  for (const [name, text] of Object.entries(opts.files ?? {})) writeFileSync(join(profile.storeDir, name), text);
  const b = new Bot({ profile, deferStartup: true, ledger: { record() {}, forget() {} } as any,
    headConfig(_p, c) { return { ...c, command: "/never-spawn", cwd: folder, allowedTools: [] }; },
    prompts: (e, heads) => botPrompts({ profile, engine: e, heads }),
    emit(e) { if (e.type === "turn.started") order.push("ev turn.started"); }, log() {}, idleMs: 600000, approvalTimeoutMs: 1000, interruptGraceMs: 10,
    ...(opts.quitTidyMs !== undefined ? { quitTidyMs: opts.quitTidyMs } : {}) });
  bots.push(b);
  return b as any;
}

/** Wraps `target[name]` so each call is recorded as `label` (the call goes on to the original unless `through` is false). */
function wrap(order: string[], target: any, name: string, label: string, through = true, note?: () => string) {
  const original = target[name].bind(target);
  target[name] = (...args: unknown[]) => { order.push(note ? `${label} ${note()}` : label); return through ? original(...args) : undefined; };
}

describe("shutdown calls the collaborators in the old order", () => {
  /** A bot with a turn at work, a waiting message, a settings hold and an approval: everything shutdown has a step for. */
  async function busy(order: string[]) {
    const peek = make(order);
    const note = () => `shuttingDown=${peek.shuttingDown} hold=${peek.settingsHold ? "set" : "null"} deferred=${peek.deferred ? "set" : "null"} approvals=${peek.approvals.size}`;
    peek.send("hi");
    await waitFor("the head to have the message", () => fixture.heads[0]?.sent.length >= 1);
    peek.queue.push({ id: "w", open: true, resolve: (s: string) => order.push(`waiting resolved ${s} ${note()}`) });
    peek.settingsHold = { noticeId: "none", timer: setInterval(() => {}, 1_000_000) };
    peek.deferred = { id: "d", open: true, resolve: (s: string) => order.push(`deferred resolved ${s} ${note()}`) };
    peek.approvals.set("a1", {});
    wrap(order, peek, "clearIdle", "clearIdle", true, note);
    wrap(order, peek, "clearApiRetry", "clearApiRetry", true, note);
    wrap(order, peek.turns, "dequeueAll", "dequeueAll", true, note);
    wrap(order, peek.turns, "takeBack", "takeBack", true, note);
    peek.stop = async (id: string, o: unknown) => { order.push(`stop ${id === peek.shownTurn?.id ? "working" : id} ${JSON.stringify(o)} ${note()}`); };
    wrap(order, peek, "settle", "settle", false, note);
    wrap(order, peek, "sleep", "sleep", false, note);
    wrap(order, peek, "flushSubagents", "flushSubagents", false, note);
    wrap(order, peek, "persist", "persist", true, note);
    // The head's end is only recorded: its onExit would fail the turn the faked stop left open, and that is not what is pinned here.
    const head = fixture.heads[0];
    head.finish = () => { order.push(`head.finish ${note()}`); head.running = false; };
    return { peek, note };
  }

  it("with a turn at work: clearIdle, clearApiRetry, the line, the settings hold, the deferred turn, stop(quitting), the approvals, the subagents, the chat", async () => {
    const order: string[] = [];
    const { peek } = await busy(order);
    order.length = 0;
    await peek.shutdown({ tidy: false });
    expect(order).toEqual([
      "clearIdle shuttingDown=false hold=set deferred=set approvals=1",
      "clearApiRetry shuttingDown=false hold=set deferred=set approvals=1",
      "dequeueAll shuttingDown=true hold=set deferred=set approvals=1",
      "waiting resolved stopped shuttingDown=true hold=set deferred=set approvals=1",
      "deferred resolved stopped shuttingDown=true hold=null deferred=set approvals=1",
      "takeBack shuttingDown=true hold=null deferred=set approvals=1",
      "stop working {\"quitting\":true} shuttingDown=true hold=null deferred=null approvals=1",
      "settle shuttingDown=true hold=null deferred=null approvals=1",
      "head.finish shuttingDown=true hold=null deferred=null approvals=1",
      "flushSubagents shuttingDown=true hold=null deferred=null approvals=1",
      "persist shuttingDown=true hold=null deferred=null approvals=1",
    ]);
  });

  it("the deferred turn is resolved as stopped before it is taken back, and a working turn means no tidy", async () => {
    const order: string[] = [];
    const { peek } = await busy(order);
    order.length = 0;
    await peek.shutdown({ tidy: true });
    expect(order.some((line) => line.startsWith("deferred resolved stopped"))).toBe(true);
    expect(order.findIndex((line) => line.startsWith("deferred resolved"))).toBeLessThan(order.findIndex((line) => line.startsWith("takeBack")));
    expect(order.some((line) => line.startsWith("sleep"))).toBe(false);
  });

  it("an idle awake bot: stop is not called, the tidy comes after the approvals and before the head's end, the Claude workers close after it", async () => {
    const order: string[] = [];
    const peek = make(order, { quitTidyMs: 5 });
    peek.send("hi");
    await waitFor("the head to have the message", () => fixture.heads[0]?.sent.length >= 1);
    fixture.heads[0].item({ kind: "result", ok: true, text: "hello", subtype: "success" });
    await waitFor("the turn to end", () => !peek.turn);
    expect(fixture.heads[0].running).toBe(true);
    peek.approvals.set("a1", {});
    order.length = 0;
    wrap(order, peek, "stop", "stop", false);
    wrap(order, peek, "settle", "settle", false);
    wrap(order, peek, "sleep", "sleep", false, () => JSON.stringify(peek.shuttingDown));
    const head = fixture.heads[0];
    head.finish = () => { order.push("head.finish"); head.running = false; };
    peek.claudeWorkerHost = { close: async () => { order.push("workers.close"); } };
    wrap(order, peek, "flushSubagents", "flushSubagents", false);
    wrap(order, peek, "persist", "persist", false);
    await peek.shutdown();
    expect(order).toEqual(["settle", "sleep true", "head.finish", "workers.close", "flushSubagents", "persist"]);
  });

  it("with tidy: false the head is ended without a tidy; a head that ignores the polite end is terminated", async () => {
    const order: string[] = [];
    const peek = make(order);
    peek.send("hi");
    await waitFor("the head to have the message", () => fixture.heads[0]?.sent.length >= 1);
    fixture.heads[0].item({ kind: "result", ok: true, text: "hello", subtype: "success" });
    await waitFor("the turn to end", () => !peek.turn);
    order.length = 0;
    wrap(order, peek, "sleep", "sleep", false);
    const head = fixture.heads[0];
    head.finish = () => { order.push("head.finish (ignored)"); };
    head.exited = new Promise(() => {});
    head.terminate = async () => { order.push("head.terminate"); head.running = false; return { killed: [], forced: false }; };
    // The 1 s race against the head's exit runs on the real clock: only Date is faked here.
    await peek.shutdown({ tidy: false });
    expect(order).toEqual(["head.finish (ignored)", "head.terminate"]);
  });
});

describe("Bot.begin is TurnControl.launch", () => {
  function spied() {
    const order: string[] = [];
    const peek = make(order);
    wrap(order, peek.turns, "start", "start");
    wrap(order, peek, "delivered", "delivered");
    wrap(order, peek, "redrawQueued", "redrawQueued");
    wrap(order, peek, "clearIdle", "clearIdle");
    wrap(order, peek, "updated", "updated");
    peek.deliver = (turn: { origin: string }, head: unknown) => { order.push(`deliver ${turn.origin} ${head === undefined ? "-" : "head"}`); };
    return { order, peek };
  }

  it("an app turn: start, delivered, redrawQueued, clearIdle, turn.started, updated, then deliver at once", () => {
    const { order, peek } = spied();
    const turn = peek.newTurn("app", "a note", null);
    order.length = 0;
    peek.begin(turn);
    expect(order).toEqual(["start", "delivered", "redrawQueued", "clearIdle", "ev turn.started", "updated", "deliver app -"]);
    expect(peek.turn).toBe(turn);
  });

  it("a user's turn is delivered after the call returns (chat.send answers first), with the head it was given", async () => {
    const { order, peek } = spied();
    const turn = peek.newTurn("user", "words", "u1");
    order.length = 0;
    const given = {};
    peek.begin(turn, given);
    expect(order).toEqual(["start", "delivered", "redrawQueued", "clearIdle", "ev turn.started", "updated"]);
    await flush(1);
    expect(order.at(-1)).toBe("deliver user head");
  });

  it("the tidy turn announces nothing and redraws nothing, unless it is a call-in", () => {
    const { order, peek } = spied();
    const tidy = peek.newTurn("tidy", "tidy", null);
    order.length = 0;
    peek.begin(tidy);
    expect(order).toEqual(["start", "delivered", "redrawQueued", "clearIdle", "deliver tidy -"]);
    const callIn = peek.newTurn("tidy", "tidy", null); callIn.callIn = "asked";
    order.length = 0;
    peek.begin(callIn);
    expect(order).toEqual(["start", "delivered", "redrawQueued", "clearIdle", "updated", "deliver tidy -"]);
  });
});

describe("the constructor's worker restore is BotWorkers.restoreAtStart", () => {
  function watch(order: string[]) {
    const original = BotWorkers.prototype.restoreAtStart;
    vi.spyOn(BotWorkers.prototype, "restoreAtStart").mockImplementation(function (this: BotWorkers) { order.push("restoreAtStart"); return original.call(this); });
  }
  it("is called once from the constructor, and `Bot.activateStartup` does not repeat it", () => {
    const order: string[] = [];
    watch(order);
    const peek = make(order);
    peek.activateStartup();
    expect(order).toEqual(["restoreAtStart"]);
  });

  it("claude with a ledger file: projectLedgerAtStart, stopRunning, ensureClaudeWorkers, and the report is handed over again after the constructor", async () => {
    const order: string[] = [];
    vi.spyOn(BotWorkers.prototype, "projectLedgerAtStart").mockImplementation(() => { order.push("projectLedgerAtStart"); });
    vi.spyOn(SubagentBook.prototype, "stopRunning").mockImplementation(() => { order.push("stopRunning"); return false; });
    vi.spyOn(BotWorkers.prototype, "ensureClaudeWorkers").mockImplementation((() => { order.push("ensureClaudeWorkers"); return { redeliver: () => order.push("redeliver") }; }) as any);
    make(order, { files: { "worker-ledger.json": "[]" } });
    expect(order).toEqual(["projectLedgerAtStart", "stopRunning", "ensureClaudeWorkers"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["projectLedgerAtStart", "stopRunning", "ensureClaudeWorkers", "redeliver"]);
  });

  it("claude with only claude-workers.json counts the same; with neither file no Claude workers are made", () => {
    const order: string[] = [];
    vi.spyOn(BotWorkers.prototype, "projectLedgerAtStart").mockImplementation(() => { order.push("projectLedgerAtStart"); });
    vi.spyOn(BotWorkers.prototype, "ensureClaudeWorkers").mockImplementation((() => { order.push("ensureClaudeWorkers"); return { redeliver() {} }; }) as any);
    make(order, { files: { "claude-workers.json": "{}" } });
    expect(order).toEqual(["projectLedgerAtStart", "ensureClaudeWorkers"]);
    order.length = 0;
    make(order);
    expect(order).toEqual(["projectLedgerAtStart"]);
  });

  it("a codex bot never makes Claude workers, whatever files it has", () => {
    const order: string[] = [];
    vi.spyOn(BotWorkers.prototype, "projectLedgerAtStart").mockImplementation(() => { order.push("projectLedgerAtStart"); });
    vi.spyOn(BotWorkers.prototype, "ensureClaudeWorkers").mockImplementation((() => { order.push("ensureClaudeWorkers"); return { redeliver() {} }; }) as any);
    make(order, { engine: "codex", files: { "worker-ledger.json": "[]", "claude-workers.json": "{}" } });
    expect(order).toEqual(["projectLedgerAtStart"]);
  });

  it("a running subagent its ledger does not list is stopped, one it lists is left to the ledger", () => {
    const order: string[] = [];
    const calls: boolean[] = [];
    vi.spyOn(SubagentBook.prototype, "stopRunning").mockImplementation(((_id: unknown, keep: (s: { id: string }) => boolean) => { calls.push(keep({ id: "unknown" })); return false; }) as any);
    make(order);
    expect(calls).toEqual([false]);
  });
});

describe("monitorStateOf", () => {
  const record: any = { id: "m", owner: "OWNER", ownerRole: "coordinator", command: "echo ok", cwd: "/tmp", state: "running", wake: "none", stdout: "", stderr: "", detail: "", createdAt: 1 };
  it("is what Bot.prototype.monitorState runs, on a bare object as this; the delegate returns nothing", () => {
    const original = { engine: "codex", steps: [{ id: "m", tool: "Monitor" }] };
    const changed: unknown[] = [];
    const target = { session: { sessionId: "owner" }, records: [original], turn: null, changed: (r: unknown) => changed.push(r) };
    expect((Bot.prototype as any).monitorState.call(target, record)).toBeUndefined();
    expect(changed).toEqual([original]);
    expect((original as any).backgroundTasks).toHaveLength(1);
    changed.length = 0;
    monitorStateOf(target as any, { ...record, state: "done" });
    expect(changed).toEqual([original]);
    expect((original as any).backgroundTasks).toHaveLength(1);
  });

  it("the turn under way that has the monitor's step takes the chip and redraws its steps, never the records", () => {
    const turn: any = { steps: [{ id: "m", tool: "Monitor" }] };
    const drawn: unknown[] = [], changed: unknown[] = [];
    const target = { session: { sessionId: "OWNER" }, records: [{ engine: "codex", steps: [{ id: "m", tool: "Monitor" }] }], turn, emitSteps: (t: unknown) => drawn.push(t), changed: (r: unknown) => changed.push(r) };
    monitorStateOf(target as any, record);
    expect(drawn).toEqual([turn]); expect(changed).toEqual([]); expect(turn.tasks).toHaveLength(1);
  });

  it("another owner's monitor, or one with no task, changes nothing", () => {
    const changed: unknown[] = [];
    const target = { session: { sessionId: "owner" }, records: [{ engine: "codex", steps: [{ id: "m", tool: "Monitor" }] }], turn: null, changed: (r: unknown) => changed.push(r) };
    monitorStateOf(target as any, { ...record, owner: "foreign" });
    monitorStateOf(target as any, { ...record, ownerRole: undefined });
    expect(changed).toEqual([]);
  });
});
