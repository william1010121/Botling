// The switch to the member's worker ledger (shared-core spec 3.5, 3.6, slice S4b): a bot's existing workers in the old
// journals are imported once into <member store>/worker-ledger.json and show as they did; the old files are kept,
// unchanged, for a downgrade. And the one worker entry: a worker's speed, measurements and usage reach the app.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { Bot } from "../../src/core/bot";
import { CodexSession, CodexThreads, type WorkerRecord } from "../../src/core/agent/codex";
import { mainProfile } from "../../src/core/store/workspace";
import { ProcessLedger } from "../../src/core/process/ledger";
import { toSwiftDate } from "../../src/core/store/records";
import { WorkerCore, WorkerLedger } from "../../src/core/worker-core";

const roots: string[] = [], bots: Bot[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.shutdown({ tidy: false });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DONE = "11111111-1111-4111-8111-111111111111";
const CUT = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";

function bot(root: string, usage = vi.fn()) {
  const made = new Bot({ profile: mainProfile(root), engine: "claude", deferStartup: true, welcome: false,
    headConfig() { throw Error("No CLI in migration tests"); }, prompts() { throw Error("No turn"); },
    ledger: new ProcessLedger(join(root, "ledger.json")), emit: () => undefined, log: vi.fn(), usage,
    approvalTimeoutMs: 100, idleMs: 100, interruptGraceMs: 100 });
  bots.push(made);
  return made;
}
const row = (id: string, status: string) => ({ id, description: id === DONE ? "Done one" : "Cut one", type: "claude-worker", prompt: "Work", status, background: true, startedAt: toSwiftDate() - 60, steps: [] });

describe("migration into the member's worker ledger", () => {
  it("Claude: claude-workers.json is imported once, shows as it did, and is kept unchanged", async () => {
    const root = tempDir("ledger-migration"); roots.push(root);
    const store = mainProfile(root).storeDir;
    mkdirSync(store, { recursive: true });
    const journal = JSON.stringify({ version: 1, workers: [
      { id: DONE, name: "Done one", type: null, instructions: "Work", sessionId: SESSION, sessionStarted: true, run: 1, status: "completed", active: false, reportPending: false, reportDelivered: true, report: "All done.", model: null, processes: [], interrupted: false, createdAt: 1 },
      { id: CUT, name: "Cut one", type: null, instructions: "Work", sessionId: SESSION.replace("3333-4", "3334-4"), sessionStarted: true, run: 2, status: "running", active: true, reportPending: false, reportDelivered: false, model: null, processes: [], interrupted: false, createdAt: 2 },
    ] });
    writeFileSync(join(store, "claude-workers.json"), journal);
    writeFileSync(join(store, "subagents.json"), JSON.stringify({ format: "botling-subagents-v2", subagents: [{ ...row(DONE, "completed"), result: "All done." }, row(CUT, "running")] }));
    const first = bot(root);
    await new Promise((resolve) => setImmediate(resolve));
    const ledger = JSON.parse(readFileSync(join(store, "worker-ledger.json"), "utf8"));
    expect(ledger.records.map((r: any) => [r.id, r.status, r.report.state])).toEqual([[DONE, "done", "acknowledged"], [CUT, "interrupted", "none"]]);
    expect(ledger.imported.map((i: any) => i.file)).toEqual([join(store, "claude-workers.json")]);
    // Shown as before: the done one completed with its report; the one cut off by the crash stopped (interrupted).
    expect(first.subagents.get(DONE)).toMatchObject({ status: "completed", result: "All done." });
    expect(first.subagents.get(CUT)).toMatchObject({ status: "stopped" });
    expect(first.workerHost!.listWorkers().map((w) => [w.id, w.state])).toEqual([[DONE, "idle"], [CUT, "interrupted"]]);
    await first.shutdown({ tidy: false }); bots.length = 0;
    // The old journal is never written again (a downgrade still finds it as it was), and it is not imported twice.
    expect(readFileSync(join(store, "claude-workers.json"), "utf8")).toBe(journal);
    writeFileSync(join(store, "claude-workers.json"), journal.replace("All done.", "Changed after the import."));
    const again = bot(root);
    await new Promise((resolve) => setImmediate(resolve));
    expect(again.subagents.get(DONE)).toMatchObject({ status: "completed", result: "All done." });
  });

  it("Codex: codex-threads/<session>.workers.json is imported once into the member's ledger and kept unchanged", () => {
    const root = tempDir("ledger-migration-codex"); roots.push(root);
    const threads = new CodexThreads(join(root, "codex-threads"));
    const old: WorkerRecord[] = [{ id: "codex-task-1", name: "Parser", instructions: "Build it", run: 1, wasActive: false, reportPending: true, report: "Built.", status: "completed", thread: "thread-1" }];
    threads.saveWorkers(old, SESSION);
    const journal = readFileSync(join(root, "codex-threads", `${SESSION}.workers.json`), "utf8");
    const file = join(root, "worker-ledger.json");
    const s = new CodexSession({ cwd: root, instructions: "Coordinator", workerInstructions: "Worker", resumeThread: null, model: null, workerModel: null, effort: null,
      restoredWorkers: [], ownerSession: SESSION, workerCore: (options) => new WorkerCore({ ...options, store: new WorkerLedger(file, { codex: { threads, session: SESSION } }) }) });
    expect(s.workerInfos).toMatchObject([{ id: "codex-task-1", state: "reportPending", conversationId: "thread-1" }]);
    expect(new WorkerLedger(file).load()).toMatchObject([{ id: "codex-task-1", adapter: "codex-thread", status: "done", report: { state: "pending", text: "Built." }, ownerSessionId: SESSION }]);
    expect(readFileSync(join(root, "codex-threads", `${SESSION}.workers.json`), "utf8")).toBe(journal);
  });
});

describe("the one worker entry", () => {
  it("a worker's speed, its token-flow measurement and its spend reach the app (Claude workers' were dropped)", async () => {
    const root = tempDir("worker-entry"); roots.push(root);
    const usage = vi.fn();
    const b = bot(root, usage);
    const entry = (item: unknown) => (b as any).onWorkerOutput(item);
    entry({ kind: "subagentStarted", id: DONE, description: "Worker", type: "claude-worker", prompt: "Work", background: true, execution: { run: 1, ownerSessionId: null, threadId: null, turnId: null } });
    entry({ kind: "request", request: { scope: DONE, id: "r1", sample: { outputTokens: 40, startMs: 0, endMs: 1_000, complete: true } } });
    expect(b.subagents.get(DONE)!.speed).toMatchObject({ timed: 1 });
    entry({ kind: "usage", totalCost: 0.25, tokens: { input: 1, output: 40, cacheRead: 0, cacheWrite: 0 } });
    entry({ kind: "usage", totalCost: 0.25, tokens: { input: 1, output: 10, cacheRead: 0, cacheWrite: 0 } });
    // Each usage is its own spend (never read as a running total).
    expect(usage.mock.calls.map((call) => call[1])).toEqual([0.25, 0.25]);
    const recorded = vi.spyOn(b as any, "recordMeasurement");
    entry({ kind: "measurement", provider: "claude", measurement: { workerId: DONE, run: 1 } });
    expect(recorded).toHaveBeenCalledWith({ workerId: DONE, run: 1 }, "claude");
  });
});
