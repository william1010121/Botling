// M7-O03b: a worker a plugin started carries the plugin's name and hash, and none is left running with no owner when the plugin goes.
// The owner of every worker is the bot (M7-O03a); the plugin is the one that asked and the one that hears the report. So "handing back"
// ends the plugin's route (its right to send and cancel, its copy of the report) and leaves the worker, and the bot's report, alone.
// Layers, each against its own fakes (no process starts):
//   1. the ledger and the Claude journal: `startedBy` is optional, a ledger without it reads as it always did;
//   2. `ClaudeWorkers` with a fake head: the tag, the name the user sees, the line before a plugin's message, the restart;
//   3. `PluginWorkers` alone: the hand-back, the pickup after a restart, the report owed and told again;
//   4. through `Plugins` and a fake host: disable and replace (the order against the new host), restart, the `registered` hook;
//   5. the one-owner invariant, with the real core: a worker handed back reports to the bot once, and to nobody else.
// Every guard has a mutation that turns a test red (.bot/artifacts/v3-orch/M7-O03b.md).
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { claudeHarness } from "../claude-workers-fake";
import { Plugins, type PluginWorld } from "../../src/core/plugins";
import type { HostCommand, HostHandlers } from "../../src/core/plugins/host-client";
import { testSealer } from "../../src/core/plugins/secrets";
import { PluginWorkers, type PluginFacts, type WorkerPort } from "../../src/core/orchestration/plugin-workers";
import { ClaudeLegacyStore, fromLegacyClaude, readLedgerRecord, toLegacyClaude, WorkerLedger, type WorkerLedgerRecord } from "../../src/core/worker-core";

const ALL = ["orchestrate", "exec", "files", "bots"];
const H1 = "a".repeat(64), H2 = "b".repeat(64);
const BY = { plugin: "needy", hash: "0123456789abcdef".repeat(4) };

// ---- 1. the ledger -------------------------------------------------------------------------------------------------------------------

/** A ledger record as every build before this one wrote it. */
const oldRecord = () => ({
  v: 3, id: "11111111-1111-4111-8111-111111111111", engine: "claude", adapter: "claude-process", name: "Build check", instructions: "Check the build", type: null, ownerSessionId: "s1",
  run: 1, status: "done", report: { state: "acknowledged", text: "All green.", status: "done", attempts: 1 }, conversationId: "22222222-2222-4222-8222-222222222222",
  processes: [], createdAt: 5, runStartedAt: 6, endedAt: 7, engineData: { sessionId: "22222222-2222-4222-8222-222222222222", sessionStarted: true, model: "sonnet" },
});

describe("the ledger's startedBy", () => {
  it("a ledger without startedBy reads as it does today (the record, the v3 file, the Claude journal)", () => {
    const read = readLedgerRecord(oldRecord())!;
    expect(read).toEqual({ ...oldRecord(), processes: [] });
    expect("startedBy" in read).toBe(false);
    // The v3 file.
    const dir = tempDir("orphans-ledger");
    writeFileSync(join(dir, "worker-ledger.json"), JSON.stringify({ version: 3, imported: [], records: [oldRecord()] }));
    const loaded = new WorkerLedger(join(dir, "worker-ledger.json")).load();
    expect(loaded).toHaveLength(1);
    expect("startedBy" in loaded[0]!).toBe(false);
    // The Claude journal: nothing new in the row it writes, nothing new in the engine data it reads.
    const row = toLegacyClaude(read);
    expect(Object.keys(row)).not.toContain("startedBy");
    expect(Object.keys(row)).not.toContain("pluginStarted");
    const back = fromLegacyClaude(row)!;
    expect("startedBy" in back).toBe(false);
    expect(back.engineData).toEqual({ sessionId: read.engineData.sessionId, sessionStarted: true, model: "sonnet" });
  });

  it("keeps startedBy through the v3 file and the Claude journal, with the mark of fewer rights; a shape that is not one is dropped", () => {
    const tagged = { ...oldRecord(), startedBy: { ...BY }, engineData: { ...oldRecord().engineData, pluginStarted: true } };
    const read = readLedgerRecord(tagged)!;
    expect(read.startedBy).toEqual(BY);
    const dir = tempDir("orphans-ledger");
    const ledger = new WorkerLedger(join(dir, "worker-ledger.json"));
    ledger.save([read]);
    expect(new WorkerLedger(join(dir, "worker-ledger.json")).load()[0]!.startedBy).toEqual(BY);
    const store = new ClaudeLegacyStore(join(dir, "claude-workers.json"));
    store.save([read]);
    const again = store.load()[0]!;
    expect(again.startedBy).toEqual(BY);
    expect(again.engineData.pluginStarted).toBe(true);
    for (const bad of [{ plugin: "x" }, { plugin: 1, hash: "abcdef12" }, { plugin: "x", hash: "not hex!" }, { plugin: "x", hash: "abc" }, "needy", ["needy", "abcdef12"], null, { plugin: " \n ", hash: "abcdef12" }]) {
      const record = readLedgerRecord({ ...oldRecord(), startedBy: bad })!;
      expect("startedBy" in record, JSON.stringify(bad)).toBe(false);
    }
    // A name with a line break is one clean line.
    expect(readLedgerRecord({ ...oldRecord(), startedBy: { plugin: "a\nb", hash: "abcdef12" } })!.startedBy).toEqual({ plugin: "a b", hash: "abcdef12" });
  });
});

// ---- 2. the core, with a fake head ---------------------------------------------------------------------------------------------------

describe("a worker a plugin started, in the core", () => {
  const strong = { command: "claude", cwd: "/elsewhere", sessionId: "coordinator", resume: true, allowedTools: ["Read"], disallowedTools: [], model: "opus", effort: "high", bypassPermissions: true, autoMode: true, askPermission: false } as never;

  it("carries the plugin's name and hash on its record and in the name the user sees; a coordinator cannot forge it", async () => {
    const h = claudeHarness();
    try {
      const started = await h.workers.startFor({ instructions: "From a plugin", name: "Build check" }, BY);
      const mine: WorkerLedgerRecord = h.workers.core.get(started.task_id)!;
      expect(mine.startedBy).toEqual(BY);
      expect(mine.name).toBe("Build check");
      const shown = h.workers.listWorkers().find((worker) => worker.id === started.task_id)!.name;
      expect(shown).toBe(`Build check · plugin needy (${BY.hash.slice(0, 8)})`);
      expect(JSON.stringify(h.items.filter((item) => item.kind === "subagentStarted"))).toContain(shown);
      // The bot's own handoff, with a startedBy in its arguments: the arguments are the coordinator's words, not the plugin host's.
      const own = await h.workers.tool("app_handoff", { instructions: "From the bot", name: "Own", startedBy: BY }) as { task_id: string };
      expect(h.workers.core.get(own.task_id)!.startedBy).toBeUndefined();
      expect(h.workers.listWorkers().find((worker) => worker.id === own.task_id)!.name).toBe("Own");
      // A starter that is not a plugin name and a hash starts nothing.
      await expect(h.workers.startFor({ instructions: "x" }, { plugin: "x", hash: "nope" })).rejects.toThrow("Nothing was started");
      expect(h.workers.listWorkers()).toHaveLength(2);
    } finally { await h.workers.close(); }
  });

  it("puts a line with the plugin's name and full hash before each message it sends, and none before anyone else's; the largest legal message stays legal", async () => {
    const h = claudeHarness();
    try {
      const { task_id } = await h.workers.startFor({ instructions: "From a plugin" }, BY);
      const head = h.heads[0]!;
      expect(await h.workers.sendToWorker(task_id, "Now the lint", BY)).toMatchObject({ ok: true });
      const sentText = head.sent.at(-1)!.text;
      expect(sentText).toContain('"needy"');
      expect(sentText).toContain(BY.hash);
      expect(sentText.endsWith("\n\nNow the lint")).toBe(true);
      expect(await h.workers.sendToWorker(task_id, "From the bot")).toMatchObject({ ok: true });
      expect(head.sent.at(-1)!.text).toBe("From the bot");
      expect(await h.workers.sendToWorker(task_id, "x", { plugin: "needy", hash: "zz" })).toMatchObject({ ok: false });
      // 64,000 characters is the most; the line is added after that check.
      const biggest = "字".repeat(64_000);
      expect(await h.workers.sendToWorker(task_id, biggest, BY)).toMatchObject({ ok: true });
      expect(head.sent.at(-1)!.text.endsWith(biggest)).toBe(true);
      expect(await h.workers.sendToWorker(task_id, biggest + "字", BY)).toMatchObject({ ok: false });
    } finally { await h.workers.close(); }
  });

  it("is still the plugin's after the app restarted: the tag and the fewer rights come back with the journal", async () => {
    const first = claudeHarness(undefined, { base: strong, subagentModel: () => "opus", keepAliveMs: 0 });
    let id = "";
    try {
      id = (await first.workers.startFor({ instructions: "From a plugin" }, BY)).task_id;
      first.result(first.heads[0]!, "done");
      first.heads[0]!.finish();
    } finally { await first.workers.close(); }
    const second = claudeHarness(first.dir, { base: strong, subagentModel: () => "opus", keepAliveMs: 0 });
    try {
      expect(second.workers.core.get(id)!.startedBy).toEqual(BY);
      await second.workers.tool("app_send_message", { task_id: id, message: "again" });
      expect(second.heads.at(-1)!.config).toMatchObject({ specGuard: { writers: [] }, bypassPermissions: false, autoMode: false, askPermission: true });
    } finally { await second.workers.close(); }
  });
});

// ---- 3. PluginWorkers alone ----------------------------------------------------------------------------------------------------------

/** What the core knows of the workers, shared by a book and the one that replaces it after a restart. */
function fakeCore() {
  const ledger = new Map<string, { run: number; running: boolean; status: string; report: string }>();
  const log = { started: [] as { args: Record<string, unknown>; by: unknown }[], sent: [] as { id: string; text: string; by: unknown }[], stopped: [] as string[] };
  const state = { available: true, next: 1 };
  const port: WorkerPort = {
    id: "main",
    start: async (args, by) => {
      const id = `T${state.next++}`;
      log.started.push({ args, by });
      ledger.set(id, { run: 1, running: true, status: "", report: "" });
      return { task_id: id, run: 1 };
    },
    send: async (id, text, by) => { log.sent.push({ id, text, by }); return { ok: true, how: "steered", run: 1 }; },
    stop: async (id) => { log.stopped.push(id); return true; },
    look: (id) => ledger.get(id) ?? null,
  };
  return { ledger, log, state, port };
}

/** A book over the core, one plugin "p" whose facts the test changes. */
function book(core = fakeCore(), file: { text: string | null } = { text: null }, init: { present?: boolean; identity?: string; taken?: boolean; quota?: { atOnce?: number; perDay?: number } } = {}) {
  const state = { present: init.present ?? true, identity: init.identity ?? H1, taken: init.taken ?? true, quota: init.quota ?? {} };
  const told: Record<string, unknown>[] = [];
  const workers = new PluginWorkers({
    world: { granted: () => true, workers: () => (core.state.available ? core.port : "No such bot."), quota: () => state.quota },
    facts: (): PluginFacts | null => (state.present ? { name: "p", identity: state.identity, permissions: ALL, botWritten: false } : null),
    ask: async () => ({ index: 0 }),
    tell: (_plugin, _event, data) => { if (!state.taken) return false; told.push(data); },
    file: { read: () => file.text, write: (text) => { file.text = text; } },
  });
  return { workers, core, file, state, told, rows: () => JSON.parse(file.text ?? "[]") as Record<string, unknown>[] };
}
const params = { bot: "main", instructions: "Do it", name: "n" };

describe("a plugin that goes hands its workers back to core", () => {
  it("disabled or removed with live workers: each is handed back, none cancelled, and the plugin hears nothing of them and can no longer send or cancel", async () => {
    const t = book();
    await t.workers.start("p", params);
    await t.workers.start("p", params);
    t.core.ledger.get("T2")!.running = false;
    t.workers.ended("T2", 1, "completed", "done");
    expect(t.told).toHaveLength(1);
    t.state.present = false;
    t.workers.reconcile();
    // Nobody stopped a worker: the bot owns them and they run on.
    expect(t.core.log.stopped).toEqual([]);
    expect(t.rows().map((row) => row.handed)).toEqual([true, true]);
    t.workers.ended("T1", 1, "completed", "late");
    expect(t.told).toHaveLength(1);
    // The plugin comes back (the same hash): the workers it handed back are not its again.
    t.state.present = true;
    await expect(t.workers.send("p", "T1", "x")).rejects.toThrow("No such worker.");
    await expect(t.workers.cancel("p", "T1")).rejects.toThrow("No such worker.");
    expect(t.core.log.sent).toEqual([]);
    expect(t.core.log.stopped).toEqual([]);
  });

  it("replaced (another hash): the old version's workers are handed back, the new one cannot touch them or hear them, and it starts its own", async () => {
    const t = book();
    await t.workers.start("p", params);
    t.state.identity = H2;
    // Before the hook has run (the core looks at the library every second or so), the new hash is already not the owner of the right to send.
    await expect(t.workers.send("p", "T1", "x")).rejects.toThrow("No such worker.");
    await expect(t.workers.cancel("p", "T1")).rejects.toThrow("No such worker.");
    t.workers.reconcile();
    await expect(t.workers.send("p", "T1", "x")).rejects.toThrow("No such worker.");
    await expect(t.workers.cancel("p", "T1")).rejects.toThrow("No such worker.");
    t.workers.ended("T1", 1, "completed", "from the old one's worker");
    expect(t.told).toEqual([]);
    await t.workers.start("p", params);
    expect(t.core.log.started[1]!.by).toEqual({ plugin: "p", hash: H2 });
    t.workers.ended("T2", 1, "completed", "mine");
    expect(t.told).toEqual([expect.objectContaining({ taskId: "T2", report: "mine" })]);
    expect(await t.workers.send("p", "T2", "more")).toEqual({ run: 1, how: "steered" });
  });

  it("a worker the old version has handed back still counts at work for the plugin's name until it ends: a new hash does not get the room again", async () => {
    const t = book(undefined, undefined, { quota: { atOnce: 2 } });
    await t.workers.start("p", params);
    await t.workers.start("p", params);
    t.state.identity = H2;
    t.workers.reconcile();
    await expect(t.workers.start("p", params)).rejects.toThrow("2 workers at work");
    t.core.ledger.get("T1")!.running = false;
    t.workers.ended("T1", 1, "completed", "done");
    expect(t.told).toEqual([]);
    await t.workers.start("p", params);
    await expect(t.workers.start("p", params)).rejects.toThrow("2 workers at work");
  });

  it("a book older than this one (no hash on its rows) is handed back, not guessed to be the plugin's", async () => {
    const file = { text: JSON.stringify([{ plugin: "p", bot: "main", task: "T1", at: Date.now(), open: true, reported: 0, stopped: false }]) };
    const t = book(undefined, file);
    await expect(t.workers.send("p", "T1", "x")).rejects.toThrow("No such worker.");
    t.workers.reconcile();
    expect(t.rows()[0]!.handed).toBe(true);
  });

  it("what the plugin was owed when it went is not told to the next one", () => {
    const t = book(undefined, undefined, { taken: false });
    return (async () => {
      await t.workers.start("p", params);
      t.workers.ended("T1", 1, "completed", "owed");
      expect(t.rows()[0]!.owed).toHaveLength(1);
      t.state.identity = H2;
      t.workers.reconcile();
      expect(t.rows()[0]!.owed).toBeUndefined();
      t.state.taken = true;
      t.workers.redeliver();
      expect(t.told).toEqual([]);
    })();
  });
});

describe("after a restart a plugin's workers are picked up, once", () => {
  it("a run that ended while nobody was told is told once, however often the pickup runs and across another restart; a running one stays; a gone one frees its place", async () => {
    const core = fakeCore(), file = { text: null as string | null };
    const first = book(core, file);
    await first.workers.start("p", params);
    await first.workers.start("p", params);
    await first.workers.start("p", params);
    // The app stops. T1 ended (interrupted, as the core marks a worker the stop cut off), T2 goes on, T3 left the core's ledger.
    core.ledger.set("T1", { run: 1, running: false, status: "interrupted", report: "cut off" });
    core.ledger.delete("T3");
    const again = book(core, file);
    expect(again.told).toEqual([]);
    again.workers.pickUp();
    again.workers.pickUp();
    expect(again.told).toEqual([{ botId: "main", taskId: "T1", run: 1, status: "interrupted", report: "cut off", startedBy: "p" }]);
    expect(again.rows().map((row) => [row.task, row.open])).toEqual([["T1", false], ["T2", true], ["T3", false]]);
    // The core's own end event for it arrives too (the replay of the ledger): not a second report.
    again.workers.ended("T1", 1, "interrupted", "cut off");
    expect(again.told).toHaveLength(1);
    // Another restart: nothing is owed, nothing is told again; the one running still is picked up when it ends, once.
    const third = book(core, file);
    third.workers.pickUp();
    expect(third.told).toEqual([]);
    core.ledger.set("T2", { run: 1, running: false, status: "completed", report: "done" });
    third.workers.pickUp();
    third.workers.ended("T2", 1, "completed", "done");
    third.workers.pickUp();
    expect(third.told).toEqual([expect.objectContaining({ taskId: "T2", run: 1 })]);
    // Room: T1 and T3 are closed, T2 too; the plugin has all of it again.
    for (let n = 0; n < 4; n++) await third.workers.start("p", params);
  });

  it("a worker the pickup cannot ask about (its bot is not there yet) is left as it was and picked up later", async () => {
    const core = fakeCore(), file = { text: null as string | null };
    await book(core, file).workers.start("p", params);
    core.ledger.set("T1", { run: 1, running: false, status: "completed", report: "done" });
    core.state.available = false;
    const again = book(core, file);
    again.workers.pickUp();
    expect(again.told).toEqual([]);
    expect(again.rows()[0]!.open).toBe(true);
    core.state.available = true;
    again.workers.pickUp();
    expect(again.told).toHaveLength(1);
  });

  it("a worker that was handed back and ended meanwhile is closed, and told to nobody", async () => {
    const core = fakeCore(), file = { text: null as string | null };
    const first = book(core, file);
    await first.workers.start("p", params);
    first.state.identity = H2;
    first.workers.reconcile();
    core.ledger.set("T1", { run: 1, running: false, status: "completed", report: "done" });
    const again = book(core, file, { identity: H2 });
    again.workers.pickUp();
    expect(again.told).toEqual([]);
    expect(again.rows()[0]!.open).toBe(false);
  });

  it("a start the last stop cut off (no task id) is not counted at work any more, but still counts for the day", async () => {
    const file = { text: JSON.stringify([{ plugin: "p", bot: "main", task: null, at: Date.now(), open: true, reported: 0, stopped: false, hash: H1 }]) };
    const t = book(undefined, file, { quota: { atOnce: 1, perDay: 2 } });
    await t.workers.start("p", params);
    await expect(t.workers.start("p", params)).rejects.toThrow("1 workers at work");
  });
});

describe("a report the plugin is owed is not lost when its host is not there", () => {
  it("is kept until the host takes it, told once and then not again, in order, and survives a restart", async () => {
    const core = fakeCore(), file = { text: null as string | null };
    const first = book(core, file, { taken: false });
    await first.workers.start("p", params);
    first.workers.ended("T1", 1, "completed", "one");
    first.workers.ended("T1", 1, "completed", "one");
    first.workers.ended("T1", 2, "completed", "two");
    expect(first.told).toEqual([]);
    // The app restarts before the host listens.
    const again = book(core, file, { taken: false });
    again.workers.redeliver();
    expect(again.told).toEqual([]);
    again.state.taken = true;
    again.workers.redeliver();
    again.workers.redeliver();
    expect(again.told.map((data) => data.run)).toEqual([1, 2]);
    // And after a third start: nothing is owed.
    const third = book(core, file);
    third.workers.redeliver();
    third.workers.pickUp();
    expect(third.told).toEqual([]);
  });

  it("a host that takes the first report and not the second keeps only the second owed", async () => {
    const t = book();
    await t.workers.start("p", params);
    t.state.taken = false;
    t.workers.ended("T1", 1, "completed", "one");
    t.workers.ended("T1", 2, "completed", "two");
    let calls = 0;
    const deps = (t.workers as unknown as { deps: { tell: (...args: unknown[]) => boolean | void } }).deps;
    deps.tell = (_plugin, _event, data) => { calls++; if (calls === 2) return false; t.told.push(data as Record<string, unknown>); };
    t.workers.redeliver();
    expect(t.told.map((data) => data.run)).toEqual([1]);
    expect((t.rows()[0]!.owed as { run: number }[]).map((owed) => owed.run)).toEqual([2]);
  });
});

// ---- 4. through Plugins and a fake host ----------------------------------------------------------------------------------------------

function plugin(dir: string, name: string, version = "1.0.0") {
  const folder = join(dir, "builtin", name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, displayName: name, version, engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", permissions: ALL } }));
  writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}");
}

const running: Plugins[] = [];
afterEach(async () => { for (const plugins of running.splice(0)) await plugins.shutdown(); });

/** Plugins over a fake host process and the fake core; `dir` may hold a book from an earlier run of the app. */
async function stack(dir: string, core = fakeCore()) {
  const world = {
    bots: () => [{ id: "main", name: "Main bot", role: "main", awake: true }], send: () => ({ messageId: "M1" }), ask: () => new Promise(() => {}),
    notice: () => {}, interrupt: async () => null, openPanel: () => {}, appSettings: () => ({}), shortcutOverrides: () => ({}),
    commandApproval: () => null, approveCommand: () => false, commandRun: () => null, component: () => null, imageUrls: () => null,
    createBot: () => { throw new Error("not here"); }, addRoutine: () => "added", changed: () => {}, broken: () => {}, log: () => {},
    workspace: {}, workspaceWatch: () => {},
    orchestration: { granted: () => true, workers: () => core.port },
  } as unknown as PluginWorld;
  const sent: any[] = [];
  let handlers!: HostHandlers;
  const line = (message: unknown) => handlers.data(JSON.stringify(message) + "\n");
  const node: HostCommand = {
    command: "",
    launch: (_script, _cwd, _env, given) => {
      handlers = given;
      queueMicrotask(() => line({ method: "ready", params: {} }));
      return {
        pid: 4243,
        write: (text) => {
          const message = JSON.parse(text);
          sent.push(message);
          if (message.method === "load") line({ id: message.id, result: { loaded: message.params.plugins.map((spec: any) => spec.name), failed: [] } });
          if (message.method === "shutdown" || message.method === "command") line({ id: message.id, result: null });
        },
        terminate: async () => {},
      };
    },
  };
  const plugins = new Plugins({ dataDir: dir, world, node, hostScript: "host.mjs", sealer: testSealer("test-key"), builtIns: join(dir, "builtin") });
  running.push(plugins);
  // What the book on disk says each time the core is about to start a (new version of a) plugin's host.
  const bookAtHostStart: Record<string, unknown>[][] = [];
  const readBook = () => { try { return JSON.parse(readFileSync(join(dir, "plugin-workers.json"), "utf8")) as Record<string, unknown>[]; } catch { return []; } };
  for (const method of ["update", "replace"] as const) {
    const original = plugins.host[method].bind(plugins.host);
    plugins.host[method] = (specs: any) => { bookAtHostStart.push(readBook()); original(specs); };
  }
  await plugins.start();
  await until(() => plugins.host.running);
  let nextId = 2000;
  const ask = async (method: string, params: unknown): Promise<any> => {
    const id = nextId++;
    line({ id, method, params });
    await until(() => sent.some((m) => m.id === id && m.method === undefined));
    const answer = sent.find((m) => m.id === id && m.method === undefined);
    if (answer.error) throw new Error(answer.error.message);
    return answer.result;
  };
  const listen = async () => {
    const before = plugins.host.events.has("workerReport");
    line({ method: "registered", params: { beforeSend: 0, afterReply: 0, commands: [], exposed: {}, events: ["workerReport"] } });
    await until(() => plugins.host.events.has("workerReport") || before);
  };
  const reports = () => sent.filter((m) => m.method === "event" && m.params.name === "workerReport").map((m) => m.params.data);
  return { plugins, ask, listen, reports, readBook, bookAtHostStart, core, sent };
}

describe("through Plugins", () => {
  it("disabled: its worker is handed back at once (not cancelled), and the plugin's report is not told", async () => {
    const dir = tempDir("orphans-plugins");
    plugin(dir, "needy");
    const t = await stack(dir);
    await t.listen();
    await t.ask("workers.start", { plugin: "needy", bot: "main", instructions: "Check", name: "Check" });
    expect(t.core.log.started[0]!.by).toMatchObject({ plugin: "needy" });
    expect(t.readBook()[0]!.handed).toBeUndefined();
    t.plugins.setEnabled("needy", false);
    expect(t.readBook()[0]!.handed).toBe(true);
    expect(t.core.log.stopped).toEqual([]);
    t.plugins.workerEnded("T1", 1, "completed", "done");
    expect(t.reports()).toEqual([]);
  });

  it("replaced (its code changed, so its hash did): the old hash's workers are handed back before the new version's host starts", async () => {
    const dir = tempDir("orphans-plugins");
    plugin(dir, "needy");
    const t = await stack(dir);
    await t.listen();
    await t.ask("workers.start", { plugin: "needy", bot: "main", instructions: "Check", name: "Check" });
    const before = t.bookAtHostStart.length;
    plugin(dir, "needy", "1.1.0");
    t.plugins.scan();
    expect(t.bookAtHostStart.length).toBeGreaterThan(before);
    // The first time the host is told about the new version, the old one's worker is already handed back.
    expect(t.bookAtHostStart[before]![0]!.handed).toBe(true);
    t.plugins.workerEnded("T1", 1, "completed", "done");
    expect(t.reports()).toEqual([]);
  });

  it("restart: the same plugin picks its worker up again, once: an end that came while it was away is told when its host listens", async () => {
    const dir = tempDir("orphans-plugins");
    plugin(dir, "needy");
    const first = await stack(dir);
    await first.listen();
    await first.ask("workers.start", { plugin: "needy", bot: "main", instructions: "Check", name: "Check" });
    await first.plugins.shutdown();
    running.splice(running.indexOf(first.plugins), 1);
    // The worker ended while the app was down.
    first.core.ledger.set("T1", { run: 1, running: false, status: "interrupted", report: "cut off by the stop" });
    const second = await stack(dir, first.core);
    // Same files, same hash: it is still the plugin's, not handed back.
    expect(second.readBook()[0]!.handed).toBeUndefined();
    // Its host does not listen yet: nothing is told, nothing is lost.
    expect(second.reports()).toEqual([]);
    await second.listen();
    await until(() => second.reports().length > 0);
    await second.listen();
    second.plugins.workerEnded("T1", 1, "interrupted", "cut off by the stop");
    expect(second.reports()).toEqual([{ botId: "main", taskId: "T1", run: 1, status: "interrupted", report: "cut off by the stop", startedBy: "needy" }]);
    // A restart again: nothing is owed.
    await second.plugins.shutdown();
    running.splice(running.indexOf(second.plugins), 1);
    const third = await stack(dir, first.core);
    await third.listen();
    expect(third.reports()).toEqual([]);
  });
});

// ---- 5. one owner, a report neither lost nor doubled ---------------------------------------------------------------------------------

describe("a worker has one owner and a report is neither lost nor doubled, handed back or not", () => {
  /** A book over the real Claude workers (the fake head): what the bot is handed, and what the plugin is told. */
  function wired(h: ReturnType<typeof claudeHarness>, file: { text: string | null } = { text: null }) {
    const state = { present: true, taken: true };
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
      facts: () => (state.present ? { name: "needy", identity: H1, permissions: ALL, botWritten: false } : null),
      ask: async () => ({ index: 0 }),
      tell: (_plugin, _event, data) => { if (!state.taken) return false; told.push(data); },
      file: { read: () => file.text, write: (text) => { file.text = text; } },
    });
    return { workers, told, state, file };
  }
  /** The run ends; the bot's event stream tells the book (more than once: views are copied). */
  const end = (h: ReturnType<typeof claudeHarness>, w: ReturnType<typeof wired>, id: string, text: string) => {
    h.result(h.heads.at(-1)!, text);
    const r = h.workers.core.get(id)!;
    for (let n = 0; n < 2; n++) w.workers.ended(id, r.run, "completed", r.report.text ?? text);
  };

  it("not handed back: the bot gets the report once and the plugin once", async () => {
    const h = claudeHarness();
    try {
      const w = wired(h);
      const { taskId } = await w.workers.start("needy", params);
      end(h, w, taskId, "All green.");
      expect(h.reports).toEqual([expect.objectContaining({ id: taskId, text: expect.stringContaining("All green.") })]);
      expect(w.told).toHaveLength(1);
    } finally { await h.workers.close(); }
  });

  it("handed back while it works: the plugin hears nothing, the bot still gets the report, once, and the worker was not stopped", async () => {
    const h = claudeHarness();
    try {
      const w = wired(h);
      const { taskId } = await w.workers.start("needy", params);
      w.state.present = false;
      w.workers.reconcile();
      expect(h.heads[0]!.terminated).toBe(false);
      expect(h.workers.core.get(taskId)!.status).toBe("running");
      expect(h.workers.core.get(taskId)!.startedBy).toMatchObject({ plugin: "needy" });
      end(h, w, taskId, "All green.");
      // Nothing more arrives for it, from either path.
      h.workers.redeliver();
      w.workers.pickUp();
      w.workers.redeliver();
      expect(h.reports).toHaveLength(1);
      expect(w.told).toEqual([]);
    } finally { await h.workers.close(); }
  });

  it("handed back after its report was owed to the plugin: the bot's copy is the one report; the plugin's is dropped, never told later", async () => {
    const h = claudeHarness();
    try {
      const w = wired(h);
      w.state.taken = false;
      const { taskId } = await w.workers.start("needy", params);
      end(h, w, taskId, "All green.");
      expect(h.reports).toHaveLength(1);
      w.state.present = false;
      w.workers.reconcile();
      w.state.taken = true;
      w.workers.redeliver();
      w.workers.pickUp();
      expect(w.told).toEqual([]);
      expect(h.reports).toHaveLength(1);
    } finally { await h.workers.close(); }
  });

  it("after a restart that cut the run off: the plugin's pickup hears the interrupted run once, from the real ledger", async () => {
    const first = claudeHarness();
    const file = { text: null as string | null };
    let taskId = "";
    try {
      taskId = (await wired(first, file).workers.start("needy", params)).taskId;
    } finally { await first.workers.close(); }
    const second = claudeHarness(first.dir);
    try {
      const w = wired(second, file);
      w.workers.pickUp();
      w.workers.pickUp();
      expect(w.told).toHaveLength(1);
      expect(w.told[0]).toMatchObject({ taskId, run: 1, status: "interrupted", startedBy: "needy" });
      // And the core's own end event for it, when it replays: not a second one.
      w.workers.ended(taskId, 1, "interrupted", "again");
      expect(w.told).toHaveLength(1);
    } finally { await second.workers.close(); }
  });
});
