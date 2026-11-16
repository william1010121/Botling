// M7-O05 items 1-3: the three counterexamples TLC found against plugin-workers.ts at c1b17be2
// (spec/models/orchestration/Orchestration_today_{stopped,send,report}.cfg; .bot/artifacts/v3-orch/M7-O05.md). Each test replays
// the trace of its counterexample and fails on the code as it was; each guard has a mutation that turns a test red.
//   1. a cancel under way when the app goes away leaves `stopped` on an open row: loading the book clears it (PlacesAreReal);
//   2. `workers.send` opens the entry, then awaits the port: nothing closes the entry while that send is in flight (AtOnceHolds);
//   3. `workers.send` does not start the next run while the bot has not taken the last run's report (BotNotSkipped).
import { describe, expect, it } from "vitest";
import { claudeHarness } from "../claude-workers-fake";
import { PluginWorkers, type PluginFacts, type WorkerPort } from "../../src/core/orchestration/plugin-workers";

const ALL = ["orchestrate", "exec", "files", "bots"];
const H1 = "a".repeat(64);
const params = { bot: "main", instructions: "Do it", name: "n" };

type Seen = { run: number; running: boolean; status: string; report: string; botOwed?: boolean };

/** What the core knows of the workers, shared by a book and the one that replaces it after a restart. */
function fakeCore() {
  const ledger = new Map<string, Seen>();
  const log = { sent: [] as string[], stopped: [] as string[] };
  const hooks = {
    send: null as null | (() => Promise<{ ok: true; how: string; run: number } | { ok: false; reason: string }>),
    stop: null as null | (() => Promise<boolean>),
  };
  let next = 1;
  const port: WorkerPort = {
    id: "main",
    start: async () => { const id = `T${next++}`; ledger.set(id, { run: 1, running: true, status: "", report: "" }); return { task_id: id, run: 1 }; },
    send: async (id) => { log.sent.push(id); return hooks.send ? hooks.send() : { ok: true, how: "newRun", run: 2 }; },
    stop: async (id) => { log.stopped.push(id); return hooks.stop ? hooks.stop() : true; },
    look: (id) => ledger.get(id) ?? null,
  };
  return { ledger, log, hooks, port };
}

function book(core = fakeCore(), file: { text: string | null } = { text: null }, quota: { atOnce?: number } = {}) {
  const told: Record<string, unknown>[] = [];
  const workers = new PluginWorkers({
    world: { granted: () => true, workers: () => core.port, quota: () => quota },
    facts: (): PluginFacts => ({ name: "p", identity: H1, permissions: ALL, botWritten: false }),
    ask: async () => ({ index: 0 }),
    tell: (_plugin, _event, data) => { told.push(data); },
    file: { read: () => file.text, write: (text) => { file.text = text; } },
  });
  return { workers, core, told, rows: () => JSON.parse(file.text ?? "[]") as Record<string, unknown>[] };
}

describe("O05 item 1: a cancel under way when the app goes away leaves no place held for ever", () => {
  it("the restart clears `stopped` on an open row: pickUp tells the run that ended and frees the place", async () => {
    const core = fakeCore(), file = { text: null as string | null };
    const first = book(core, file, { atOnce: 2 });
    await first.workers.start("p", params);
    // The stop is asked and never answers (the app goes away). Another write meanwhile (a second start) saves the mark.
    core.hooks.stop = () => new Promise<boolean>(() => {});
    void first.workers.cancel("p", "T1");
    await Promise.resolve();
    await first.workers.start("p", params);
    expect(first.rows()[0]).toMatchObject({ task: "T1", open: true, stopped: true });
    // After the restart the core's ledger says the run ended.
    core.hooks.stop = null;
    core.ledger.set("T1", { run: 1, running: false, status: "interrupted", report: "cut off" });
    const again = book(core, file, { atOnce: 2 });
    again.workers.pickUp();
    expect(again.told).toEqual([expect.objectContaining({ taskId: "T1", run: 1, status: "interrupted", report: "cut off" })]);
    expect(again.rows()[0]).toMatchObject({ open: false, stopped: false });
    // T2 still runs; T1's place is free: a third worker starts, a fourth does not.
    await expect(again.workers.start("p", params)).resolves.toMatchObject({ taskId: "T3" });
    await expect(again.workers.start("p", params)).rejects.toThrow("2 workers at work");
  });

  it("the end event of a run is told after the restart too (ended() no longer skips the row)", async () => {
    const core = fakeCore(), file = { text: null as string | null };
    const first = book(core, file);
    await first.workers.start("p", params);
    core.hooks.stop = () => new Promise<boolean>(() => {});
    void first.workers.cancel("p", "T1");
    await Promise.resolve();
    await first.workers.start("p", params);
    const again = book(core, file);
    again.workers.ended("T1", 1, "completed", "done");
    expect(again.told).toEqual([expect.objectContaining({ taskId: "T1", report: "done" })]);
  });

  it("a worker the plugin cancelled (closed) stays closed and silent after a restart: only open rows are cleared", async () => {
    const core = fakeCore(), file = { text: null as string | null };
    const first = book(core, file);
    await first.workers.start("p", params);
    await first.workers.cancel("p", "T1");
    expect(first.rows()[0]).toMatchObject({ open: false, stopped: true });
    const again = book(core, file);
    again.workers.ended("T1", 1, "stopped", "stopped");
    expect(again.told).toEqual([]);
    expect(again.rows()[0]).toMatchObject({ open: false, stopped: true });
  });
});

describe("O05 item 2: a send in flight keeps its place", () => {
  /** T1 ran and ended (told, place free); the plugin sends it on and the core has not answered yet. */
  async function sending() {
    const core = fakeCore();
    const t = book(core, undefined, { atOnce: 1 });
    await t.workers.start("p", params);
    core.ledger.set("T1", { run: 1, running: false, status: "completed", report: "done" });
    t.workers.ended("T1", 1, "completed", "done");
    expect(t.rows()[0]).toMatchObject({ open: false, reported: 1 });
    let answer!: (value: { ok: true; how: string; run: number } | { ok: false; reason: string }) => void;
    core.hooks.send = () => new Promise((resolve) => { answer = resolve; });
    const sent = t.workers.send("p", "T1", "again");
    await Promise.resolve();
    expect(core.log.sent).toEqual(["T1"]);
    return { t, core, sent, answer: (value: Parameters<typeof answer>[0]) => answer(value) };
  }

  it("another start's gate (its pickUp) does not close the entry: the new run holds its place and the second start is refused", async () => {
    const { t, core, sent, answer } = await sending();
    await expect(t.workers.start("p", params)).rejects.toThrow("1 workers at work");
    expect(core.log.sent).toEqual(["T1"]);
    answer({ ok: true, how: "newRun", run: 2 });
    await sent;
    // Still held after the send returns; the core now runs T1 again.
    core.ledger.set("T1", { run: 2, running: true, status: "", report: "" });
    expect(t.rows()[0]).toMatchObject({ open: true });
    await expect(t.workers.start("p", params)).rejects.toThrow("1 workers at work");
    // The new run ends: told once, the place is free.
    core.ledger.set("T1", { run: 2, running: false, status: "completed", report: "second" });
    t.workers.ended("T1", 2, "completed", "second");
    expect(t.told.map((data) => [data.run, data.report])).toEqual([[1, "done"], [2, "second"]]);
    expect(t.rows()[0]).toMatchObject({ open: false });
    await expect(t.workers.start("p", params)).resolves.toMatchObject({ taskId: "T2" });
  });

  it("a host registering (a pickUp) does not close it either", async () => {
    const { t, answer, sent } = await sending();
    t.workers.pickUp();
    t.workers.pickUp();
    await expect(t.workers.start("p", params)).rejects.toThrow("1 workers at work");
    answer({ ok: true, how: "newRun", run: 2 });
    await sent;
    expect(t.rows()[0]).toMatchObject({ open: true });
  });

  it("a send the core refuses, or one that throws, gives the place back as it was; the guard is not left on", async () => {
    const { t, core, sent, answer } = await sending();
    answer({ ok: false, reason: "busy" });
    await expect(sent).rejects.toThrow("busy");
    expect(t.rows()[0]).toMatchObject({ open: false });
    // Nothing is in flight now: a pickUp closes as usual, and the place is really free.
    await expect(t.workers.start("p", params)).resolves.toMatchObject({ taskId: "T2" });
    core.hooks.send = async () => { throw new Error("gone"); };
    core.ledger.set("T2", { run: 1, running: false, status: "completed", report: "x" });
    t.workers.ended("T2", 1, "completed", "x");
    await expect(t.workers.send("p", "T2", "more")).rejects.toThrow("gone");
    expect(t.rows()[1]).toMatchObject({ open: false });
    await expect(t.workers.start("p", params)).resolves.toMatchObject({ taskId: "T3" });
  });
});

describe("O05 item 3: a send does not start a run that drops the report the bot is still owed", () => {
  it("refused while the core says the bot has not taken the last report; nothing is sent and the entry is not reopened", async () => {
    const core = fakeCore();
    const t = book(core);
    await t.workers.start("p", params);
    core.ledger.set("T1", { run: 1, running: false, status: "completed", report: "done", botOwed: true });
    t.workers.ended("T1", 1, "completed", "done");
    await expect(t.workers.send("p", "T1", "again")).rejects.toThrow(/report/);
    expect(core.log.sent).toEqual([]);
    expect(t.rows()[0]).toMatchObject({ open: false });
    // The bot takes it: the send goes through.
    core.ledger.set("T1", { run: 1, running: false, status: "completed", report: "done", botOwed: false });
    await expect(t.workers.send("p", "T1", "again")).resolves.toEqual({ run: 2, how: "newRun" });
    expect(core.log.sent).toEqual(["T1"]);
  });

  it("a core that cannot say refuses (fail closed); a port without look sends as before", async () => {
    const core = fakeCore();
    const t = book(core);
    await t.workers.start("p", params);
    core.ledger.set("T1", { run: 1, running: false, status: "completed", report: "done" });
    t.workers.ended("T1", 1, "completed", "done");
    core.port.look = () => { throw new Error("no ledger"); };
    await expect(t.workers.send("p", "T1", "again")).rejects.toThrow(/report/);
    expect(core.log.sent).toEqual([]);
    delete core.port.look;
    await expect(t.workers.send("p", "T1", "again")).resolves.toMatchObject({ how: "newRun" });
  });

  it("with the real core: a report the bot's head did not take (it is refusing) stops the send; once it is taken the send starts the next run", async () => {
    const h = claudeHarness();
    try {
      const told: Record<string, unknown>[] = [];
      const port: WorkerPort = {
        id: "main",
        start: (args, by) => h.workers.startFor(args, by),
        send: async (id, text, by) => h.workers.sendToWorker(id, text, by),
        stop: (id) => h.workers.stopWorker(id),
        look: (id) => h.workers.look(id),
      };
      const workers = new PluginWorkers({
        world: { granted: () => true, workers: () => port },
        facts: () => ({ name: "p", identity: H1, permissions: ALL, botWritten: false }),
        ask: async () => ({ index: 0 }),
        tell: (_plugin, _event, data) => { told.push(data); },
      });
      const { taskId } = await workers.start("p", params);
      h.refuseReports();
      h.result(h.heads.at(-1)!, "All green.");
      workers.ended(taskId, 1, "completed", "All green.");
      expect(h.reports).toEqual([]);
      expect(h.workers.look(taskId)).toMatchObject({ run: 1, running: false, botOwed: true });
      await expect(workers.send("p", taskId, "again")).rejects.toThrow(/report/);
      expect(h.workers.core.get(taskId)!.run).toBe(1);
      expect(h.workers.core.get(taskId)!.report.state).toBe("pending");
      // The head takes the report; then the next run may start.
      h.acceptReports();
      h.workers.redeliver();
      expect(h.reports).toEqual([expect.objectContaining({ id: taskId })]);
      expect(h.workers.look(taskId)).toMatchObject({ botOwed: false });
      await expect(workers.send("p", taskId, "again")).resolves.toMatchObject({ run: 2, how: "newRun" });
    } finally { await h.workers.close(); }
  });
});
