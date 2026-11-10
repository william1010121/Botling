// app_notify_owner: a worker still at work sends its owner (the bot that started it) a note, a report or a question,
// and keeps running. The DAFAWU case (2026-11-08): a worker wrote progress.md but had no way to tell its bot, so the
// user had to ask. Now the owner is woken with <app_worker_note> while the worker's run stays under way, a question is
// answered with app_send_message into that same run, only the owner hears it, and nothing but a worker can send one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { alive, tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import type { CodexItem } from "../../src/core/agent/codex";
import { CodexSession, type CodexConfig, type CodexOutput } from "../../src/core/agent/codex";
import { AgyMcpBridge } from "../../src/core/agent/agy-mcp";
import { CLAUDE_APP_TOOLS, CLAUDE_WORKER_POLICY, CLAUDE_WORKER_TOOLS } from "../../src/core/agent/claude-workers";
import { appTools, workerAppTools } from "../../src/core/app-tools/registry";
import { WORKER_NOTIFY_RULE } from "../../src/core/prompts/delegation";
import { Bot } from "../../src/core/bot";
import type { Core } from "../../src/core/server";
import { fixture, OTHER, PROJECT, stubTurns, W1 } from "../agent-owner-fake";
import {
  WorkerCore, workerNoteText,
  type CoordinatorPort, type RunHandle, type WorkerAdapter, type WorkerLedgerRecord, type WorkerNote, type WorkerStore,
} from "../../src/core/worker-core";

// ---- The shared core: who hears a note, and what the run does meanwhile ----

class MemoryStore implements WorkerStore {
  records: WorkerLedgerRecord[] = [];
  load() { return structuredClone(this.records); }
  save(records: readonly WorkerLedgerRecord[]) { this.records = structuredClone([...records]); }
}

class FakeAdapter implements WorkerAdapter {
  readonly kind = "claude-process" as const;
  readonly engine = "claude" as const;
  readonly steersRunning = true;
  handles = new Map<string, RunHandle>();
  steered: string[] = [];
  start(record: Readonly<WorkerLedgerRecord>, _words: string, run: RunHandle) { this.handles.set(record.id, run); }
  steer(_record: Readonly<WorkerLedgerRecord>, words: string) { this.steered.push(words); return true; }
  async stop() { return { cleaned: true }; }
  answer() {}
  recover() { return { state: "clean" as const }; }
  async close() {}
}

function setup(note: ((n: WorkerNote, text: string) => boolean) | null = () => true) {
  const adapter = new FakeAdapter();
  const reports: string[] = [];
  const port: CoordinatorPort = { ack: "none", deliver: (_r, text) => { reports.push(text); return "taken"; } };
  const items: CodexItem[] = [];
  const notes: { note: WorkerNote; text: string }[] = [];
  let n = 0;
  const core = new WorkerCore({
    store: new MemoryStore(), port, sink: { item: (item) => items.push(item) }, adapters: [adapter], ownerSessionId: () => "coord", log: () => {},
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, now: () => 1000, processStartTime: () => "t",
    ...(note ? { note: (nt: WorkerNote, text: string) => { notes.push({ note: nt, text }); return note(nt, text); } } : {}),
  });
  return { core, adapter, reports, items, notes };
}

describe("WorkerCore.notifyOwner", () => {
  it("a report reaches the coordinator as <app_worker_note> while the run stays under way", async () => {
    const { core, notes, reports } = setup();
    const { task_id } = await core.handoff("claude-process", { instructions: "Plan the DAFAWU import", name: "DAFAWU plan" });
    const sent = core.notifyOwner(task_id, { kind: "report", message: "Plan ready", files: ["/work/progress.md"] });
    expect(sent).toEqual({ task_id, run: 1, kind: "report", delivered: true, to: "owner" });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe(workerNoteText({ id: task_id, run: 1, kind: "report", name: "DAFAWU plan", message: "Plan ready", files: ["/work/progress.md"] }));
    expect(notes[0]!.text).toMatch(new RegExp(`^<app_worker_note task_id="${task_id}" run="1" kind="report" name="DAFAWU plan">\\nPlan ready\\nFiles: /work/progress.md\\n</app_worker_note>\\n`));
    expect(notes[0]!.text).toContain("not its final report");
    // The run goes on: still at work, no report handed over.
    expect(core.get(task_id)).toMatchObject({ status: "running", run: 1, report: { state: "none" } });
    expect(reports).toEqual([]);
  });

  it("a question: the coordinator's app_send_message joins that same run", async () => {
    const { core, adapter, notes } = setup();
    const { task_id } = await core.handoff("claude-process", { instructions: "Import", name: "Importer" });
    core.notifyOwner(task_id, { kind: "question", message: "SQLite or Postgres?" });
    expect(notes[0]!.text).toContain('kind="question"');
    expect(notes[0]!.text).toContain("app_send_message");
    const answered = await core.message({ task_id, message: "SQLite" });
    expect(answered).toMatchObject({ task_id, run: 1, status: "steered" });
    expect(adapter.steered.join("\n")).toContain("SQLite");
    expect(core.get(task_id)).toMatchObject({ status: "running", run: 1 });
  });

  it("a worker another bot owns: the note goes to the app for that owner, never to the coordinator", async () => {
    const { core, notes, items } = setup();
    const { task_id } = await core.handoff("claude-process", { instructions: "Import", name: "Importer" });
    expect(core.setWorkerOwner(task_id, { botId: "sub-bot", name: "DAFAWU", agentId: "agent-1" })).toMatchObject({ ok: true });
    core.notifyOwner(task_id, { kind: "report", message: "Half done" });
    expect(notes).toEqual([]);
    expect(items.filter((item) => item.kind === "workerNote")).toEqual([
      { kind: "workerNote", id: task_id, run: 1, engine: "claude", noteKind: "report", name: "Importer", message: "Half done", files: [] },
    ]);
  });

  it("refuses anything but a worker at work, and malformed notes; nothing is sent", async () => {
    const { core, adapter, notes } = setup();
    expect(() => core.notifyOwner("not-a-worker", { kind: "report", message: "hi" })).toThrow(/Only an app-managed worker/);
    const { task_id } = await core.handoff("claude-process", { instructions: "Import", name: "Importer" });
    expect(() => core.notifyOwner(task_id, { kind: "chatter", message: "hi" })).toThrow(/kind must be/);
    expect(() => core.notifyOwner(task_id, { kind: "report", message: "  " })).toThrow(/message required/);
    expect(() => core.notifyOwner(task_id, { kind: "report", message: "hi", files: "progress.md" })).toThrow(/files must be/);
    adapter.handles.get(task_id)!.emit({ type: "end", end: { how: "normal", finalText: "Done.", error: null, detail: "success" } });
    await until(() => core.get(task_id)?.status === "done", { what: "the run's end" });
    expect(() => core.notifyOwner(task_id, { kind: "report", message: "late" })).toThrow(/not under way/);
    expect(notes).toEqual([]);
  });

  it("an owner that cannot take it now: the worker is told, nothing is kept", async () => {
    const { core } = setup(() => false);
    const { task_id } = await core.handoff("claude-process", { instructions: "Import", name: "Importer" });
    expect(() => core.notifyOwner(task_id, { kind: "report", message: "hi" })).toThrow(/cannot take a note/);
    const none = setup(null);
    const other = await none.core.handoff("claude-process", { instructions: "Import" });
    expect(() => none.core.notifyOwner(other.task_id, { kind: "report", message: "hi" })).toThrow(/cannot take a note/);
  });
});

// ---- Only workers have the tool ----

describe("app_notify_owner is a worker's tool only", () => {
  it("no coordinator lists it; every engine's worker gets it (and the browser tools)", () => {
    for (const provider of ["claude", "agy", "codex"] as const) {
      expect(appTools(provider).map((tool) => tool.name)).not.toContain("app_notify_owner");
      const [tool, ...rest] = workerAppTools(provider);
      expect(rest.map((each) => each.name)).toEqual(["app_browser_tabs", "app_browser_open", "app_browser_requests", "app_browser_extract"]);
      expect(tool).toMatchObject({ name: "app_notify_owner", inputSchema: { required: ["kind", "message"], properties: { kind: { enum: ["report", "question"] }, files: { type: "array" } } } });
      expect(tool!.description).toMatch(/app_send_message|joins this run/);
      expect(tool!.description).toContain("never the user or another bot");
    }
    expect(CLAUDE_APP_TOOLS.map((tool) => tool.name)).not.toContain("app_notify_owner");
    expect(CLAUDE_WORKER_TOOLS.map((tool) => tool.name)).toEqual(["app_notify_owner", "app_browser_tabs", "app_browser_open", "app_browser_requests", "app_browser_extract"]);
    expect(CLAUDE_WORKER_POLICY).toContain(WORKER_NOTIFY_RULE);
  });

  it("an Antigravity worker's bridge lists it and calls it without a card; a coordinator's or a plain bridge has none", async () => {
    const dir = tempDir("agy-notify"), home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const calls: Record<string, unknown>[] = [];
    const worker = new AgyMcpBridge(dir, home, undefined, undefined, undefined, undefined, undefined, [], () => false, (args) => { calls.push(args); return { delivered: true }; });
    expect(worker.tools.map((tool) => tool.name)).toContain("app_notify_owner");
    await expect(worker.invoke("app_notify_owner", { kind: "question", message: "Which DB?" })).resolves.toEqual({ delivered: true });
    expect(calls).toEqual([{ kind: "question", message: "Which DB?" }]);
    const plain = new AgyMcpBridge(dir, home);
    expect(plain.tools.map((tool) => tool.name)).not.toContain("app_notify_owner");
    await expect(plain.invoke("app_notify_owner", { kind: "report", message: "x" })).rejects.toThrow();
    await Promise.all([worker.close(), plain.close()]);
  });
});

// ---- Codex: a worker thread has the tool; the coordinator's thread is refused ----

describe("Codex workers' app_notify_owner", () => {
  const COORD = "coord-thread";
  let rpc = 900;
  function session(notes: string[]) {
    const config: CodexConfig = {
      cwd: "/tmp/bot", instructions: "Coordinator", workerInstructions: "Worker", resumeThread: null, model: null, workerModel: null, effort: null, restoredWorkers: [], ownerSession: "owner-session",
      workerCore: (options) => new WorkerCore({ ...options, note: (_n, text) => { notes.push(text); return true; } }),
    };
    const s = new CodexSession(config);
    const take = (out: CodexOutput[]) => out;
    take(s.start());
    take(s.receive(JSON.stringify({ id: 1, result: {} })));
    take(s.receive(JSON.stringify({ id: 2, result: { thread: { id: COORD } } })));
    const writes = (out: CodexOutput[]) => out.filter((o) => o.kind === "write").map((o) => (o as { value: any }).value);
    const call = (threadId: string, turnId: string, tool: string, args: unknown) => writes(s.receive(JSON.stringify({ method: "item/tool/call", id: ++rpc, params: { threadId, turnId, callId: `c-${rpc}`, tool, arguments: args } })));
    const answer = (id: number, result: unknown) => writes(s.receive(JSON.stringify({ id, result })));
    const turn = writes(s.send("go")).find((w) => w.method === "turn/start");
    answer(turn.id, { turn: { id: "t1" } });
    return { s, call, answer };
  }
  const payload = (w: any) => ({ success: w.result.success, ...JSON.parse(w.result.contentItems[0].text) });

  it("a worker thread starts with it, its note reaches the coordinator, and its run goes on", () => {
    const notes: string[] = [];
    const h = session(notes);
    const handed = h.call(COORD, "t1", "app_handoff", { instructions: "Import DAFAWU", name: "Importer" });
    const task = JSON.parse(handed[0].result.contentItems[0].text).task_id as string;
    const start = handed.find((w) => w.method === "thread/start");
    expect(start.params.dynamicTools.map((tool: { name: string }) => tool.name)).toEqual(["app_notify_owner", "app_browser_tabs", "app_browser_open", "app_browser_requests", "app_browser_extract"]);
    const started = h.answer(start.id, { thread: { id: "w1" } });
    h.answer(started.find((w) => w.method === "turn/start").id, { turn: { id: "wt1" } });
    const [sent] = h.call("w1", "wt1", "app_notify_owner", { kind: "report", message: "Plan ready", files: ["/tmp/bot/progress.md"] });
    expect(payload(sent)).toMatchObject({ success: true, task_id: task, run: 1, delivered: true });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`<app_worker_note task_id="${task}" run="1" kind="report" name="Importer">`);
    expect(h.s.workerInfos).toMatchObject([{ id: task, state: "running" }]);
  });

  it("the coordinator's own call is refused", () => {
    const notes: string[] = [];
    const h = session(notes);
    const [refused] = h.call(COORD, "t1", "app_notify_owner", { kind: "report", message: "hi" });
    expect(payload(refused)).toMatchObject({ success: false, error: expect.stringMatching(/Only an app-managed worker/) });
    expect(notes).toEqual([]);
  });
});

// ---- End to end (the built core, the fake CLI): the DAFAWU case ----

const harnesses: CoreHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});
const core = (dataDir: string) => {
  const harness = new CoreHarness(dataDir, { FAKE_CLAUDE_LOG: join(dataDir, "starts.log") });
  harnesses.push(harness);
  return harness;
};
const starts = (dir: string): { pid: number; args: string[]; session: string }[] =>
  existsSync(join(dir, "starts.log")) ? readFileSync(join(dir, "starts.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const finished = (c: CoreHarness) => c.of("turn.finished").map((e) => e.event as { turnId: string; text: string; status: string });
const subagentUpdates = (c: CoreHarness) => c.of("subagent.updated").map((e) => (e.event as { subagent: any }).subagent);
async function handOff(c: CoreHarness, text: string) {
  const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text });
  const event = await until(() => finished(c).find((e) => e.turnId === turnId), { what: `the end of "${text}"` });
  const taskId = /^Handed off: ([0-9a-f-]{36})$/.exec(event.text)?.[1];
  expect(taskId, event.text).toBeTruthy();
  return taskId!;
}

describe("a Claude worker's note to its bot (DAFAWU)", () => {
  it("report: the bot is woken with the note while the worker keeps running; the chat shows it as a relay line", async () => {
    const dir = tempDir("worker-notify-report");
    const c = core(dir);
    const taskId = await handOff(c, "/worker /notify:report Plan ready in progress.md");
    const woken = await until(() => finished(c).find((e) => e.text.startsWith("Got the worker's note:")), { what: "the bot woken by the note" });
    expect(woken.text).toContain("Plan ready in progress.md");
    expect(woken.text).toContain("progress.md");
    // The worker is still at work: its process lives and its row says running.
    const worker = starts(dir)[1]!;
    expect(alive(worker.pid)).toBe(true);
    expect(subagentUpdates(c).filter((s) => s.id === taskId).at(-1)?.status).toBe("running");
    // Its process has the botling server with only app_notify_owner (no coordinator tools).
    expect(JSON.parse(flag(worker.args, "--mcp-config")!)).toEqual({ mcpServers: { botling: { type: "sdk", name: "botling" } } });
    const allowed = flag(worker.args, "--allowedTools")!.split(",");
    expect(allowed).toContain("mcp__botling__app_notify_owner");
    expect(allowed.filter((tool) => tool.startsWith("mcp__botling__"))).toEqual(["mcp__botling__app_notify_owner", "mcp__botling__app_browser_tabs", "mcp__botling__app_browser_open", "mcp__botling__app_browser_requests", "mcp__botling__app_browser_extract"]);
    // The owner's chat: the note as a relay line (not the user's), no second user line.
    const messages = (await c.chat()).messages as { role: string; text: string }[];
    expect(messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["/worker /notify:report Plan ready in progress.md"]);
    expect(messages.filter((m) => m.role === "relay").map((m) => m.text)).toEqual([expect.stringMatching(/^Note from worker "Research": Plan ready in progress\.md\n.*progress\.md$/)]);
  });

  it("question: the bot answers with app_send_message and the answer joins the same run, whose report then comes back", async () => {
    const dir = tempDir("worker-notify-question");
    const c = core(dir);
    const taskId = await handOff(c, "/worker /notify:question SQLite or Postgres?");
    await until(() => finished(c).find((e) => e.text === "Answered the worker."), { what: "the bot's answer to the question" });
    const report = await until(() => finished(c).find((e) => e.text.includes("app_task_result")), { what: "the worker's report" });
    expect(report.text).toContain(`task_id="${taskId}" run="1"`);
    expect(report.text).toContain("Answer: use SQLite");
    // One run, one worker process: the answer was read into the run under way.
    expect(starts(dir)).toHaveLength(2);
    const ledger = JSON.parse(readFileSync(join(dir, "main", "worker-ledger.json"), "utf8"));
    expect(ledger.records[0]).toMatchObject({ id: taskId, run: 1, status: "done" });
  });

  it("the bot itself cannot send one: its own call is refused", async () => {
    const dir = tempDir("worker-notify-head");
    const c = core(dir);
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "/notify:report I am not a worker" });
    const event = await until(() => finished(c).find((e) => e.turnId === turnId), { what: "the bot's turn" });
    expect(event.text).toMatch(/^Note failed: Unknown app tool app_notify_owner/);
    expect(((await c.chat()).messages as { role: string }[]).filter((m) => m.role === "relay")).toEqual([]);
  });
});

// ---- A worker moved to another bot: the note goes to that owner only ----

describe.each(["codex", "agy", "claude"] as const)("a note from a worker a %s bot hosts for another bot", (engine) => {
  const opened: Core[] = [];
  afterEach(async () => { vi.restoreAllMocks(); for (const c of opened.splice(0)) await c.shutdown(); });

  it("reaches the owner (answered with the agent tags), never the host", async () => {
    stubTurns();
    const notes: { id: string; line: string; text: string }[] = [];
    vi.spyOn(Bot.prototype, "workerNote").mockImplementation(function (this: Bot, note, text) { notes.push({ id: this.id, line: note.message, text }); return true; });
    const f = fixture(engine);
    opened.push(f.core);
    const moved = await f.core.moveAgent(PROJECT, W1, { kind: "bot", botId: OTHER });
    (f.bots.get(PROJECT) as any).workerNoted({ kind: "workerNote", id: W1, run: 2, engine, noteKind: "question", name: "Importer", message: "Which DB?", files: [] });
    expect(notes.map((n) => n.id)).toEqual([OTHER]);
    expect(notes[0]!.text).toMatch(new RegExp(`^<app_worker_note task_id="${moved.agentId}" run="2" kind="question" name="[^"]+">\nWhich DB[?]\n</app_worker_note>\n`));
    expect(notes[0]!.text).toContain(`<agent-message to="${moved.agentId}">`);
  });
});
