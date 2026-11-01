// The engine side of the sub-bot hand-off: a Codex worker at work can be asked to wrap up (and never gets a new run from it),
// and one app-managed Antigravity worker can be stopped alone.
import { afterEach, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSession, type CodexConfig, type CodexOutput, type WorkerRecord } from "../../src/core/agent/codex";
import { AgyWorkers, type AgyWorkerHead } from "../../src/core/agent/agy-workers";

const writes = (out: CodexOutput[]) => out.flatMap((o) => (o.kind === "write" ? [o.value as any] : []));
const items = (out: CodexOutput[]) => out.flatMap((o) => (o.kind === "item" ? [o.item] : []));
const record: WorkerRecord = { id: "task-1", name: "Research", instructions: "Research only.", thread: "worker-thread", run: 2, wasActive: true, reportPending: false, restartSafe: true, restartTurn: "old-turn" };

function bootWithActiveWorker(options: Partial<CodexConfig> = {}) {
  const s = new CodexSession({ cwd: "/tmp", instructions: "Coordinator", workerInstructions: "Worker", resumeThread: "owner-thread", model: null, workerModel: null, effort: null, restoredWorkers: [], restartWorkers: [record], ownerSession: "owner-session", ...options });
  const answer = (id: number, result: any) => s.receive(JSON.stringify({ id, result }));
  s.start(); answer(1, {});
  const setup = writes(answer(2, { thread: { id: "owner-thread" } }));
  const read = writes(answer(setup.find((x) => x.method === "thread/inject_items").id, {})).find((x) => x.method === "thread/read");
  const resumed = writes(answer(read.id, { thread: { id: "worker-thread", turns: [{ id: "old-turn", status: "interrupted", items: [] }] } })).find((x) => x.method === "thread/resume");
  const injected = writes(answer(resumed.id, { thread: { id: "worker-thread" } })).find((x) => x.method === "thread/inject_items");
  const started = writes(answer(injected.id, {})).find((x) => x.method === "turn/start");
  answer(started.id, { turn: { id: "new-turn" } });
  return { s, answer };
}

it("a Codex worker at work takes the wrap-up request into its run; one not at work gets nothing and no new run", () => {
  const { s } = bootWithActiveWorker();
  expect(s.runningWorkers).toEqual(["task-1"]);
  const before = s.workerRecords[0]!.run;
  const out = s.wrapUpWorker("task-1", "(App: write handoff.md)");
  expect(writes(out)).toContainEqual(expect.objectContaining({ method: "turn/steer", params: expect.objectContaining({ threadId: "worker-thread", expectedTurnId: "new-turn" }) }));
  expect(JSON.stringify(out)).toContain("write handoff.md");
  expect(s.workerRecords[0]!.run).toBe(before);
  expect(s.wrapUpWorker("nobody", "x")).toEqual([]);
  const cancelled = s.cancelWorkers(new Set(["task-1"]));
  expect(items(cancelled)).toContainEqual(expect.objectContaining({ kind: "subagentEnded", id: "task-1", status: "killed" }));
  const runBefore = s.workerRecords[0]!.run;
  expect(s.wrapUpWorker("task-1", "again")).toEqual([]);
  expect(s.workerRecords[0]!.run).toBe(runBefore);
});

const managers: AgyWorkers[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.close(); });
function agy() {
  const home = mkdtempSync(join(tmpdir(), "botling-sub-bot-agy-"));
  const events: any[] = [], stopped: boolean[] = [];
  const m = new AgyWorkers({ command: "not-executed", cwd: home, acpHome: home, sessionId: "owner", resume: false, systemPrompt: "c", workerInstructions: "w" } as any, (i) => events.push(i), () => {}, () => {
    const index = stopped.push(false) - 1;
    const head: AgyWorkerHead = { start() {}, send() {}, answer() {}, async terminate() { stopped[index] = true; return { killed: [], forced: false }; } };
    return head;
  });
  managers.push(m);
  return { m, events, stopped };
}

it("one Antigravity worker is stopped alone: it ends stopped, the other keeps working, and a finished one is not 'stopped' again", async () => {
  const h = agy();
  const a = await h.m.tool("app_handoff", { instructions: "task a", name: "a" });
  const b = await h.m.tool("app_handoff", { instructions: "task b", name: "b" });
  expect(h.m.running.sort()).toEqual([a.task_id, b.task_id].sort());
  expect(await h.m.cancelTask(a.task_id)).toBe(true);
  expect(h.m.running).toEqual([b.task_id]);
  expect(h.stopped).toEqual([true, false]);
  expect(h.events).toContainEqual(expect.objectContaining({ kind: "subagentEnded", id: a.task_id, status: "stopped" }));
  expect(await h.m.cancelTask(a.task_id)).toBe(false);
  expect(await h.m.cancelTask("unknown")).toBe(false);
});
