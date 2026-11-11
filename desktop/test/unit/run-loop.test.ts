// `botling run`'s loop (src/cli/run-loop.ts) against a scripted core: when it counts the task finished, and what it
// answers in a person's place.
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunLoop, type RunTransport } from "../../src/cli/run-loop";

const BOT = "B0B00000-0000-4000-8000-000000000001";

function scriptedCore() {
  const calls: Record<string, any>[] = [];
  let listener: (event: any) => void = () => {};
  const transport: RunTransport = {
    call: async (cmd) => { calls.push(cmd); return cmd.type === "chat.send" ? { messageId: "m-user", turnId: "t1" } : {}; },
    onEvent: (fn) => { listener = fn; },
  };
  const emit = (event: any) => listener(event);
  const bot = (fields: Record<string, unknown> = {}) => emit({ type: "bot.updated", bot: {
    id: BOT, name: "task", role: "manager", avatar: "circle", folder: "/app", phase: "awake", working: false, approvals: 0, unread: 0,
    subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [], ...fields,
  } });
  const message = (fields: Record<string, unknown>) => emit({ type: "message.added", botId: BOT, message: { id: "m1", role: "bot", text: "", time: new Date().toISOString(), ...fields } });
  return { transport, calls, emit, bot, message };
}

const row = (id: string, status: string) => ({ id, title: id, status, head: "claude", startedAt: 0, endedAt: null, unsettledAt: null, settled: false });

describe("RunLoop", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("sends the task and finishes only once the head and its workers have been quiet for the settle time", async () => {
    vi.useFakeTimers();
    const core = scriptedCore();
    const loop = new RunLoop({ transport: core.transport, botId: BOT, settleMs: 1_000 });
    let ended = false;
    void loop.done.then(() => { ended = true; });
    await loop.start("fix the build");
    expect(core.calls[0]).toEqual({ type: "chat.send", botId: BOT, text: "fix the build" });
    core.emit({ type: "turn.started", botId: BOT, turnId: "t1", messageId: "m1" });
    core.bot({ working: true });
    // The head hands off and ends its turn; its worker is still at work.
    core.emit({ type: "turn.finished", botId: BOT, turnId: "t1", messageId: "m1", status: "done", text: "Handed off." });
    core.bot({ working: false, subagents: 1, subagentRows: [row("w1", "running")] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ended).toBe(false);
    // The worker reports: quiet for a moment, then its report wakes the head again before the settle time is up.
    core.bot({ working: false, subagents: 0, subagentRows: [row("w1", "completed")] });
    await vi.advanceTimersByTimeAsync(500);
    core.emit({ type: "turn.started", botId: BOT, turnId: "t2", messageId: "m2" });
    core.bot({ working: true, subagentRows: [row("w1", "completed")] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ended).toBe(false);
    core.emit({ type: "turn.finished", botId: BOT, turnId: "t2", messageId: "m2", status: "done", text: "All tests pass." });
    core.bot({ working: false, subagentRows: [row("w1", "completed")] });
    await vi.advanceTimersByTimeAsync(999);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(loop.done).resolves.toEqual({ status: "completed", finalText: "All tests pass.", lastTurn: "done", error: null });
    expect(loop.stats.turns).toBe(2);
    expect([...loop.stats.workers]).toEqual(["w1"]);
  });

  it("is not finished while background work is running, or another bot answers in its chat", async () => {
    vi.useFakeTimers();
    const core = scriptedCore();
    const loop = new RunLoop({ transport: core.transport, botId: BOT, settleMs: 100 });
    await loop.start("go");
    core.message({ id: "m2", backgroundTasks: [{ id: "bg1", kind: "command", title: "make", status: "running", started: 0, ended: null, detail: null, fires: null, schedule: null, recurring: null }] });
    core.bot({ working: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loop.busy()).toBe(true);
    core.message({ id: "m2", backgroundTasks: [{ id: "bg1", kind: "command", title: "make", status: "completed", started: 0, ended: 1, detail: null, fires: null, schedule: null, recurring: null }] });
    core.bot({ working: false, callIns: [{ id: "OTHER", state: "answering" }] });
    expect(loop.busy()).toBe(true);
    core.bot({ working: false, callIns: [] });
    await vi.advanceTimersByTimeAsync(100);
    await expect(loop.done).resolves.toMatchObject({ status: "completed" });
  });

  it("allows a tool once, takes a card's recommended option, and answers a question group with the recommended picks", async () => {
    const core = scriptedCore();
    const loop = new RunLoop({ transport: core.transport, botId: BOT, settleMs: 10_000 });
    await loop.start("go");
    core.message({ id: "a1", approval: { tool: "Bash", expires: null }, choices: [
      { label: "Deny", detail: null, recommended: false, action: "deny" },
      { label: "Always allow", detail: null, recommended: false, action: "alwaysAllow" },
      { label: "Allow once", detail: null, recommended: true, action: "allowOnce" },
    ] });
    core.message({ id: "c1", choices: [{ label: "Slow", detail: null, recommended: false, action: null }, { label: "Fast", detail: null, recommended: true, action: null }] });
    core.message({ id: "q1", choices: [], questions: [
      { question: "DB?", multiple: false, options: [{ label: "Postgres", detail: null, recommended: false, action: null }, { label: "SQLite", detail: null, recommended: true, action: null }] },
      { question: "Tests?", multiple: true, options: [{ label: "Unit", detail: null, recommended: false, action: null }, { label: "E2E", detail: null, recommended: false, action: null }] },
    ] });
    // An answered card, the user's own line and a repeat update of a card already answered are left alone.
    core.message({ id: "c2", choices: [{ label: "A", detail: null, recommended: true, action: null }, { label: "B", detail: null, recommended: false, action: null }], chosen: 1 });
    core.message({ id: "u1", role: "user", choices: [{ label: "A", detail: null, recommended: true, action: null }, { label: "B", detail: null, recommended: false, action: null }] });
    core.emit({ type: "message.updated", botId: BOT, message: { id: "c1", role: "bot", text: "", time: "", choices: [{ label: "Slow", detail: null, recommended: false, action: null }, { label: "Fast", detail: null, recommended: true, action: null }] } });
    // Another bot's cards are not this run's to answer.
    core.emit({ type: "message.added", botId: "SOMEONE-ELSE", message: { id: "x1", role: "bot", text: "", time: "", choices: [{ label: "A", detail: null, recommended: true, action: null }, { label: "B", detail: null, recommended: false, action: null }] } });
    await new Promise((r) => setImmediate(r));
    expect(core.calls.slice(1)).toEqual([
      { type: "chat.choose", botId: BOT, messageId: "a1", index: 2 },
      { type: "chat.choose", botId: BOT, messageId: "c1", index: 1 },
      { type: "chat.answer", botId: BOT, messageId: "q1", text: "", picks: [{ options: [1] }, { options: [0] }] },
    ]);
    expect(loop.stats).toMatchObject({ approvalsAnswered: 1, choicesAnswered: 2 });
    loop.fail("done here");
  });

  it("reports an error when the last turn failed, the bot has a problem, or the run is cut off", async () => {
    vi.useFakeTimers();
    const failed = scriptedCore();
    const one = new RunLoop({ transport: failed.transport, botId: BOT, settleMs: 10 });
    await one.start("go");
    failed.emit({ type: "turn.finished", botId: BOT, turnId: "t1", messageId: "m1", status: "failed", text: "", error: "API error 529" });
    failed.bot({ working: false });
    await vi.advanceTimersByTimeAsync(10);
    await expect(one.done).resolves.toMatchObject({ status: "error", lastTurn: "failed", error: "API error 529" });

    const broken = scriptedCore();
    const two = new RunLoop({ transport: broken.transport, botId: BOT, settleMs: 10 });
    await two.start("go");
    broken.bot({ problem: "Its folder is gone." });
    await expect(two.done).resolves.toMatchObject({ status: "error", error: "bot problem: Its folder is gone." });

    const slow = scriptedCore();
    const three = new RunLoop({ transport: slow.transport, botId: BOT, settleMs: 10 });
    await three.start("go");
    slow.bot({ working: true });
    three.fail("timed out after 5 s");
    await expect(three.done).resolves.toMatchObject({ status: "error", error: "timed out after 5 s" });
  });
});
