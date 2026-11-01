// One worker model for every engine (workers.ts): the same scenarios run against a Codex worker (a thread of its
// coordinator's app-server), an Antigravity worker (an ACP process) and a Claude worker (a claude process), each through
// the WorkerHost the bot, the registry, the Rail and moves use. Nothing below is engine-specific except how a worker
// is first started, which is each engine's own app tool path.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSession, codexWorkerHost, type CodexOutput, type WorkerRecord } from "../../src/core/agent/codex";
import { AgyWorkers, agyWorkerHost, type AgyWorkerHead } from "../../src/core/agent/agy-workers";
import { isWorkerHost, type WorkerHost } from "../../src/core/agent/workers";
import { claudeHarness } from "../claude-workers-fake";

interface Started { host: WorkerHost; id: string; engine: string; events: () => any[]; close(): Promise<void> }

const writes = (out: CodexOutput[]) => out.flatMap((o) => (o.kind === "write" ? [o.value as any] : []));
async function codex(): Promise<Started> {
  const record: WorkerRecord = { id: "task-1", name: "Research", instructions: "Research only.", thread: "worker-thread", run: 1, wasActive: true, reportPending: false, restartSafe: true, restartTurn: "old-turn" };
  const s = new CodexSession({ cwd: "/tmp", instructions: "Coordinator", workerInstructions: "Worker", resumeThread: "owner-thread", model: null, workerModel: null, effort: null, restoredWorkers: [], restartWorkers: [record], ownerSession: "owner-session" });
  const answer = (id: number, result: any) => s.receive(JSON.stringify({ id, result }));
  s.start(); answer(1, {});
  const setup = writes(answer(2, { thread: { id: "owner-thread" } }));
  const read = writes(answer(setup.find((x) => x.method === "thread/inject_items").id, {})).find((x) => x.method === "thread/read");
  const resumed = writes(answer(read.id, { thread: { id: "worker-thread", turns: [{ id: "old-turn", status: "interrupted", items: [] }] } })).find((x) => x.method === "thread/resume");
  const injected = writes(answer(resumed.id, { thread: { id: "worker-thread" } })).find((x) => x.method === "thread/inject_items");
  const started = writes(answer(injected.id, {})).find((x) => x.method === "turn/start");
  answer(started.id, { turn: { id: "new-turn" } });
  const outputs: CodexOutput[] = [];
  return { host: codexWorkerHost(s, (out) => outputs.push(...out)), id: "task-1", engine: "codex", events: () => outputs.flatMap((o) => (o.kind === "item" ? [o.item] : [])), close: async () => {} };
}

async function agy(): Promise<Started> {
  const home = mkdtempSync(join(tmpdir(), "botling-contract-agy-"));
  const events: any[] = [];
  const m = new AgyWorkers({ command: "not-executed", cwd: home, acpHome: home, sessionId: "owner", resume: false, systemPrompt: "c", workerInstructions: "w" } as any, (i) => events.push(i), () => {}, () => {
    const head: AgyWorkerHead = { start() {}, send() {}, answer() {}, async terminate() { return { killed: [], forced: false }; } };
    return head;
  });
  const r: any = await m.tool("app_handoff", { instructions: "Research only.", name: "Research" });
  return { host: agyWorkerHost(() => m), id: r.task_id, engine: "agy", events: () => events, close: () => m.close() };
}

async function claude(): Promise<Started> {
  const h = claudeHarness();
  const r: any = await h.workers.tool("app_handoff", { instructions: "Research only.", name: "Research" });
  return { host: h.workers, id: r.task_id, engine: "claude", events: () => h.items, close: () => h.workers.close() };
}

const opened: Started[] = [];
afterEach(async () => { for (const w of opened.splice(0)) await w.close(); });

describe.each([["Codex", codex], ["Antigravity", agy], ["Claude", claude]] as const)("a %s worker through WorkerHost", (_name, start) => {
  const open = async () => { const w = await start(); opened.push(w); return w; };

  it("is a WorkerHost and lists its running worker with its engine and run", async () => {
    const w = await open();
    expect(isWorkerHost(w.host)).toBe(true);
    expect(w.host.listWorkers()).toEqual([expect.objectContaining({ id: w.id, engine: w.engine, state: "running", name: "Research" })]);
  });

  it("takes a follow-up into the run under way where the engine steers, and says it is busy where it cannot", async () => {
    const w = await open();
    const run = w.host.listWorkers()[0]!.run;
    const sent = await w.host.sendToWorker(w.id, "Also note the version.");
    if (w.host.steersRunning) expect(sent).toEqual({ ok: true, how: "steered", run });
    else expect(sent).toMatchObject({ ok: false, busy: true });
    expect(w.host.listWorkers()[0]!.run).toBe(run);
  });

  it("stops one worker alone, without a report, and a later follow-up starts its next run", async () => {
    const w = await open();
    const run = w.host.listWorkers()[0]!.run;
    expect(await w.host.stopWorker(w.id)).toBe(true);
    expect(w.events()).toContainEqual(expect.objectContaining({ kind: "subagentEnded", id: w.id }));
    expect(w.host.listWorkers()[0]!.state).toBe("stopped");
    expect(await w.host.stopWorker(w.id)).toBe(false);
    expect(await w.host.sendToWorker(w.id, "Carry on.")).toEqual({ ok: true, how: "newRun", run: run + 1 });
    expect(w.host.listWorkers()[0]).toMatchObject({ state: "running", run: run + 1 });
    expect(w.events().filter((e) => e.kind === "subagentStarted" && e.id === w.id).at(-1)).toMatchObject({ background: true });
  });

  it("refuses an unknown worker", async () => {
    const w = await open();
    expect(await w.host.sendToWorker("no-such-task", "x")).toMatchObject({ ok: false });
    expect(await w.host.stopWorker("no-such-task")).toBe(false);
  });
});
