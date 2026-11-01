// Owner routing at the worker host (workers.ts `setWorkerOwner`), the same scenarios against a Codex worker (a thread of its
// coordinator's app-server), an Antigravity worker (an ACP process) and a Claude worker (a claude process): once another bot
// owns a worker, its run reports leave the host as `workerReport` items (never the coordinator's), the coordinator's
// completion checks leave it out while its host still stays up for it, the coordinator's own app tool calls on it are
// refused, a report already waiting for the coordinator goes to the owner, and giving it back restores the coordinator.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSession, codexWorkerHost, type CodexOutput, type WorkerRecord } from "../../src/core/agent/codex";
import { AgyWorkers, agyWorkerHost, type AgyWorkerHead } from "../../src/core/agent/agy-workers";
import type { HeadHandlers } from "../../src/core/agent/head";
import type { WorkerHost } from "../../src/core/agent/workers";
import { claudeHarness } from "../claude-workers-fake";

const OWNER = { botId: "SUB-BOT", name: "API owner", agentId: "ag-0123456789abcdef01234567" };
const tick = () => new Promise((done) => setTimeout(done, 5));

interface Started {
  host: WorkerHost; id: string; engine: string;
  events: () => any[];
  /** Ends the worker's run under way with this report. */
  finish(report: string): Promise<void>;
  /** The coordinator was handed (or holds queued) this worker's report. */
  coordinatorGot(id: string): boolean;
  /** What the coordinator's completion check waits on. */
  dependencies(): string[];
  /** The host must stay up (it runs or owes something). */
  awake(): boolean;
  /** The coordinator's own app tool call on the worker: the error it gets, or null. */
  coordinatorCall(id: string): Promise<string | null>;
  /** The coordinator is busy (its report waits rather than being handed over at once). */
  holdReports(): void;
  close(): Promise<void>;
}

const writes = (out: CodexOutput[]) => out.flatMap((o) => (o.kind === "write" ? [o.value as any] : []));
async function codex(): Promise<Started> {
  const record: WorkerRecord = { id: "task-1", name: "Research", instructions: "Research only.", thread: "worker-thread", run: 1, wasActive: true, reportPending: false, restartSafe: true, restartTurn: "old-turn" };
  const s = new CodexSession({ cwd: "/tmp", instructions: "Coordinator", workerInstructions: "Worker", resumeThread: "owner-thread", model: null, workerModel: null, effort: null, restoredWorkers: [], restartWorkers: [record], ownerSession: "owner-session" });
  const outputs: CodexOutput[] = [];
  const answer = (id: number, result: any) => { const out = s.receive(JSON.stringify({ id, result })); outputs.push(...out); return out; };
  outputs.push(...s.start()); answer(1, {});
  const setup = writes(answer(2, { thread: { id: "owner-thread" } }));
  const read = writes(answer(setup.find((x) => x.method === "thread/inject_items").id, {})).find((x) => x.method === "thread/read");
  const resumed = writes(answer(read.id, { thread: { id: "worker-thread", turns: [{ id: "old-turn", status: "interrupted", items: [] }] } })).find((x) => x.method === "thread/resume");
  const injected = writes(answer(resumed.id, { thread: { id: "worker-thread" } })).find((x) => x.method === "thread/inject_items");
  const started = writes(answer(injected.id, {})).find((x) => x.method === "turn/start");
  answer(started.id, { turn: { id: "new-turn" } });
  const line = (method: string, params: any) => outputs.push(...s.receive(JSON.stringify({ method, params })));
  let runs = 0;
  return {
    host: codexWorkerHost(s, (out) => outputs.push(...out)), id: "task-1", engine: "codex",
    events: () => outputs.flatMap((o) => (o.kind === "item" ? [o.item] : [])),
    async finish(report) {
      // Each run has its own turn (the first is the one restored above).
      const turn = runs++ === 0 ? "new-turn" : `turn-${runs}`;
      line("item/completed", { threadId: "worker-thread", turnId: turn, item: { type: "agentMessage", id: `m-${turn}`, text: report } });
      line("turn/completed", { threadId: "worker-thread", turn: { id: turn, status: "completed" } });
    },
    coordinatorGot: (id) => writes(outputs).some((w) => w.method === "turn/start" && w.params?.toolOutput?.name === "app_task_result" && String(w.params.toolOutput.output).includes(id))
      || s.completionDependencies.some((d) => d.id === id && d.state === "reportQueued"),
    dependencies: () => s.completionDependencies.map((d) => d.id),
    awake: () => s.hasManagedWork,
    async coordinatorCall(id) {
      const out = s.receive(JSON.stringify({ id: 900, method: "item/tool/call", params: { threadId: "owner-thread", turnId: "c1", callId: "call-1", tool: "app_send_message", arguments: { task_id: id, message: "status?" } } }));
      const reply = writes(out).find((w) => w.id === 900);
      return reply?.result?.success === false ? String(reply.result.contentItems?.[0]?.text ?? "") : null;
    },
    holdReports() {
      // A coordinator turn under way: a worker's report waits for it to end.
      outputs.push(...s.send("Hello"));
      const start = writes(outputs).findLast((w) => w.method === "turn/start" && !w.params?.toolOutput);
      if (start) answer(start.id, { turn: { id: "coordinator-turn" } });
    },
    close: async () => {},
  };
}

async function agy(): Promise<Started> {
  const home = mkdtempSync(join(tmpdir(), "botling-owner-agy-"));
  const events: any[] = [], reports: string[] = [];
  const heads: HeadHandlers[] = [];
  const m = new AgyWorkers({ command: "not-executed", cwd: home, acpHome: home, sessionId: "owner", resume: false, systemPrompt: "c", workerInstructions: "w" } as any, (i) => events.push(i), (id) => reports.push(id), (_config, handlers) => {
    heads.push(handlers);
    const head: AgyWorkerHead = { start() {}, send() {}, answer() {}, async terminate() { return { killed: [], forced: false }; } };
    return head;
  });
  const r: any = await m.tool("app_handoff", { instructions: "Research only.", name: "Research" });
  return {
    host: agyWorkerHost(() => m), id: r.task_id, engine: "agy", events: () => events,
    async finish(report) { heads.at(-1)!.onItem({ kind: "result", ok: true, text: report, error: "", subtype: "success" } as any); for (let i = 0; i < 4; i++) await tick(); },
    coordinatorGot: (id) => reports.includes(id),
    dependencies: () => m.completionDependencies.map((d) => d.id),
    awake: () => m.hostedLive.length > 0,
    async coordinatorCall(id) { try { await m.tool("app_send_message", { task_id: id, run: 1, message: "status?" }); return null; } catch (error) { return (error as Error).message; } },
    holdReports() { /* its report callback only queues: the head hands it over later */ },
    close: () => m.close(),
  };
}

async function claude(): Promise<Started> {
  const h = claudeHarness();
  const r: any = await h.workers.tool("app_handoff", { instructions: "Research only.", name: "Research" });
  return {
    host: h.workers, id: r.task_id, engine: "claude", events: () => h.items,
    async finish(report) { h.result(h.heads.at(-1)!, report); },
    coordinatorGot: (id) => h.reports.some((report) => report.id === id),
    dependencies: () => [],
    awake: () => true,
    async coordinatorCall(id) { try { await h.workers.tool("app_send_message", { task_id: id, message: "status?" }); return null; } catch (error) { return (error as Error).message; } },
    holdReports() { h.refuseReports(); },
    close: () => h.workers.close(),
  };
}

const opened: Started[] = [];
afterEach(async () => { for (const w of opened.splice(0)) await w.close(); });

describe.each([["Codex", codex], ["Antigravity", agy], ["Claude", claude]] as const)("a %s worker given to another bot", (_name, start) => {
  const open = async () => { const w = await start(); opened.push(w); return w; };

  it("reports to the app for its owner, never to its coordinator, which no longer waits on it or acts on it", async () => {
    const w = await open();
    expect(w.host.setWorkerOwner(w.id, OWNER)).toEqual({ ok: true });
    expect(w.host.listWorkers()[0]!.owner).toEqual(OWNER);
    // Still at work on its host: the host stays up for it, but its coordinator's completion check leaves it out.
    expect(w.host.listWorkers()[0]!.state).toBe("running");
    expect(w.awake()).toBe(true);
    expect(w.dependencies()).not.toContain(w.id);
    expect(await w.coordinatorCall(w.id)).toMatch(/now belongs to \\?"API owner/);
    await w.finish("Found 3 endpoints.");
    expect(w.events()).toContainEqual(expect.objectContaining({ kind: "subagentEnded", id: w.id }));
    expect(w.events().filter((e) => e.kind === "workerReport")).toEqual([expect.objectContaining({ id: w.id, engine: w.engine, status: "completed", report: expect.stringContaining("Found 3 endpoints.") })]);
    expect(w.coordinatorGot(w.id)).toBe(false);
  });

  it("hands a report already waiting for its coordinator to the owner instead", async () => {
    const w = await open();
    w.holdReports();
    await w.finish("Done waiting.");
    expect(w.events().some((e) => e.kind === "workerReport")).toBe(false);
    expect(w.host.setWorkerOwner(w.id, OWNER)).toEqual({ ok: true });
    expect(w.events().filter((e) => e.kind === "workerReport")).toEqual([expect.objectContaining({ id: w.id, report: expect.stringContaining("Done waiting.") })]);
    expect(w.dependencies()).not.toContain(w.id);
  });

  it("given back (owner null), its next run reports to its coordinator again", async () => {
    const w = await open();
    w.host.setWorkerOwner(w.id, OWNER);
    await w.finish("First.");
    expect(w.host.setWorkerOwner(w.id, null)).toEqual({ ok: true });
    expect(w.host.listWorkers()[0]!.owner ?? null).toBeNull();
    expect(await w.coordinatorCall(w.id)).toBeNull();
    await w.finish("Second.");
    expect(w.events().filter((e) => e.kind === "workerReport")).toHaveLength(1);
    expect(w.coordinatorGot(w.id)).toBe(true);
  });

  it("refuses an unknown worker", async () => {
    const w = await open();
    expect(w.host.setWorkerOwner("no-such-task", OWNER)).toMatchObject({ ok: false });
  });
});
