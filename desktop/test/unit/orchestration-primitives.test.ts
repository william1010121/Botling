// M7-O03a: the worker primitives a plugin may use (`workers.start`, `workers.send`, `workers.cancel`, the event `workerReport`),
// behind the named permission `orchestrate` and a quota. Three layers, each against its own fakes (no process starts):
//   1. through `Plugins` and a fake host process, as plugin-api.test.ts does: the wire in front of the checks;
//   2. `PluginWorkers` alone, for what the wire cannot reach (the card's timeout, a plugin that changed while the card was open, the book on disk);
//   3. `ClaudeWorkers.startFor` with a fake head: a worker a plugin started has no more rights than the plugin (review F3, F4 of M7-O01).
// Every guard here has a mutation that turns its test red (listed in .bot/artifacts/v3-orch/M7-O03a.md).
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { claudeHarness } from "../claude-workers-fake";
import { Plugins, type AppAnswer, type AppQuestion, type PluginWorld } from "../../src/core/plugins";
import type { HostCommand, HostHandlers } from "../../src/core/plugins/host-client";
import { testSealer } from "../../src/core/plugins/secrets";
import { PluginWorkers, type OrchestrationWorld, type PluginFacts, type WorkerPort } from "../../src/core/orchestration/plugin-workers";

const ALL = ["orchestrate", "exec", "files", "bots"];

/** A plugin on disk: `root` "builtin" is shipped with Botling, "plugins" is the library (nothing installed it from the catalog: a bot wrote it). */
function plugin(dir: string, name: string, permissions: string[], root: "plugins" | "builtin" = "plugins") {
  const folder = join(dir, root, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, displayName: name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", permissions } }));
  writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}");
}

/** The bot's Claude workers as the world lends them: records what was started, sent and stopped. */
function fakeWorkers() {
  const log = { started: [] as Record<string, unknown>[], sent: [] as [string, string][], stopped: [] as string[], failNext: false };
  const port: WorkerPort = {
    id: "main",
    start: async (args) => {
      if (log.failNext) { log.failNext = false; throw new Error("the head is unavailable"); }
      log.started.push(args);
      return { task_id: `T${log.started.length}`, run: 1 };
    },
    send: async (id, text) => { log.sent.push([id, text]); return { ok: true, how: "steered", run: 1 }; },
    stop: async (id) => { log.stopped.push(id); return true; },
  };
  return { log, port };
}

interface Setup { grants: Set<string>; quota: { atOnce?: number; perDay?: number }; specWriters: string[] }
const running: Plugins[] = [];
afterEach(async () => { for (const plugins of running.splice(0)) await plugins.shutdown(); });

/** Plugins over a fake host process, with `world.orchestration` made of the fakes above (`withWorld: false`: a world without workers). */
async function setup(dir: string, withWorld = true) {
  const workers = fakeWorkers();
  const options: Setup = { grants: new Set(), quota: {}, specWriters: ["opus"] };
  const questions: { question: AppQuestion; answer: (answer: AppAnswer) => void }[] = [];
  const sentToUser: string[] = [];
  const world = {
    bots: () => [{ id: "main", name: "Main bot", role: "main", awake: true }],
    send: (_bot: string, text: string) => { sentToUser.push(text); return { messageId: "M1" }; },
    ask: (question: AppQuestion) => new Promise<AppAnswer>((resolve) => questions.push({ question, answer: resolve })),
    notice: () => {}, interrupt: async () => null, openPanel: () => {}, appSettings: () => ({}), shortcutOverrides: () => ({}),
    commandApproval: () => null, approveCommand: () => false, commandRun: () => null, component: () => null, imageUrls: () => null,
    createBot: () => { throw new Error("not here"); }, addRoutine: () => "added", changed: () => {}, broken: () => {}, log: () => {},
    workspace: {}, workspaceWatch: () => {},
    ...(withWorld ? {
      orchestration: {
        granted: (name: string) => options.grants.has(name),
        workers: (bot: string) => (bot === "main" ? workers.port : "No such bot."),
        made: () => true,
        quota: () => options.quota,
        specWriters: () => options.specWriters,
      } satisfies OrchestrationWorld,
    } : {}),
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
        pid: 4242,
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
  await plugins.start();
  await until(() => plugins.host.running);
  let nextId = 1000;
  const ask = async (method: string, params: unknown): Promise<any> => {
    const id = nextId++;
    line({ id, method, params: (params && typeof params === "object" && !Array.isArray(params) ? { code: plugins.codeOf(String((params as { plugin?: unknown }).plugin)), ...params } : params) }); // the code, as Web/host stamps it
    await until(() => sent.some((m) => m.id === id && m.method === undefined));
    const answer = sent.find((m) => m.id === id && m.method === undefined);
    if (answer.error) throw new Error(answer.error.message);
    return answer.result;
  };
  const tell = (method: string, params: unknown) => line({ method, params });
  const reports = () => sent.filter((m) => m.method === "event" && m.params.name === "workerReport").map((m) => m.params.data);
  return { plugins, ask, tell, reports, options, questions, sentToUser, ...workers };
}

const start = (name: string, extra: Record<string, unknown> = {}) => ({ plugin: name, bot: "main", instructions: "Check the build", name: "Build check", ...extra });

describe("workers.start needs the permission, and the user's OK", () => {
  it("is refused without orchestrate (declared and granted), and nothing is started or recorded", async () => {
    const dir = tempDir("orch-prim");
    plugin(dir, "plain", ["exec", "files", "bots"], "builtin");
    plugin(dir, "needy", ALL, "builtin");
    plugin(dir, "missing", ["orchestrate", "exec", "files"], "builtin");
    const t = await setup(dir);
    t.options.grants.add("plain");
    t.options.grants.add("missing");
    // Declared but never granted by the user.
    await expect(t.ask("workers.start", start("needy"))).rejects.toThrow("has not been allowed to orchestrate");
    // Granted, but the package.json does not say orchestrate (or lacks bots).
    await expect(t.ask("workers.start", start("plain"))).rejects.toThrow('needs the "orchestrate", "exec", "files", "bots" permissions');
    await expect(t.ask("workers.start", start("missing"))).rejects.toThrow("missing: bots");
    expect(t.log.started).toEqual([]);
    // Send and cancel have nothing to act on either.
    await expect(t.ask("workers.send", { plugin: "needy", taskId: "T1", message: "x" })).rejects.toThrow("No such worker.");
    await expect(t.ask("workers.cancel", { plugin: "needy", taskId: "T1" })).rejects.toThrow("No such worker.");
    expect(t.log.stopped).toEqual([]);
  });

  it("is refused in a world that has no workers", async () => {
    const dir = tempDir("orch-prim");
    plugin(dir, "needy", ALL, "builtin");
    const t = await setup(dir, false);
    await expect(t.ask("workers.start", start("needy"))).rejects.toThrow("Workers are not available here.");
  });

  it("refuses a param that would give the worker more: machine, role, isolated_git, subagent_type, another engine", async () => {
    const dir = tempDir("orch-prim");
    plugin(dir, "needy", ALL, "builtin");
    const t = await setup(dir);
    t.options.grants.add("needy");
    for (const extra of [{ machine: "mac-mini" }, { role: "editor" }, { isolated_git: true }, { subagent_type: "general" }, { engine: "codex" }, { cwd: "/" }]) {
      await expect(t.ask("workers.start", start("needy", extra)), JSON.stringify(extra)).rejects.toThrow("Not a request a plugin can make");
    }
    await expect(t.ask("workers.start", start("needy", { bot: "ghost" }))).rejects.toThrow("No such bot.");
    expect(t.log.started).toEqual([]);
  });
});

describe("a worker a plugin starts", () => {
  it("starts with only the whitelisted args, reports to its plugin once per run, and is cancelled", async () => {
    const dir = tempDir("orch-prim");
    plugin(dir, "needy", ALL, "builtin");
    const t = await setup(dir);
    t.options.grants.add("needy");
    expect(await t.ask("workers.start", start("needy", { group: "build", model: "sonnet", effort: "high" }))).toEqual({ taskId: "T1", run: 1 });
    expect(t.log.started).toEqual([{ instructions: "Check the build", name: "Build check", group: "build", model: "sonnet", effort: "high" }]);
    t.tell("registered", { beforeSend: 0, afterReply: 0, commands: [], exposed: {}, events: ["workerReport"] });
    await until(() => t.plugins.host.events.has("workerReport"));
    t.plugins.workerEnded("T1", 1, "completed", "All green.");
    t.plugins.workerEnded("T1", 1, "completed", "All green.");
    expect(t.reports()).toEqual([{ botId: "main", taskId: "T1", run: 1, status: "completed", report: "All green.", startedBy: "needy" }]);
    // A worker nobody here started is nobody's report.
    t.plugins.workerEnded("T-other", 1, "completed", "x");
    expect(t.reports()).toHaveLength(1);
    expect(await t.ask("workers.send", { plugin: "needy", taskId: "T1", message: "Now the lint" })).toEqual({ run: 1, how: "steered" });
    expect(t.log.sent).toEqual([["T1", "Now the lint"]]);
    expect(await t.ask("workers.cancel", { plugin: "needy", taskId: "T1" })).toEqual({ stopped: true });
    expect(t.log.stopped).toEqual(["T1"]);
  });

  it("is refused past the quota: at once and in a day, never queued, a refused one takes none, a second cancel gives nothing back twice", async () => {
    const dir = tempDir("orch-prim");
    plugin(dir, "needy", ALL, "builtin");
    const t = await setup(dir);
    t.options.grants.add("needy");
    t.options.quota = { atOnce: 3, perDay: 5 };
    // Eight asks at once: exactly three are started (the room is taken before the first await).
    const answers = await Promise.allSettled(Array.from({ length: 8 }, () => t.ask("workers.start", start("needy"))));
    expect(answers.filter((answer) => answer.status === "fulfilled")).toHaveLength(3);
    expect(answers.filter((answer): answer is PromiseRejectedResult => answer.status === "rejected").every((answer) => /3 workers at work/.test(answer.reason.message))).toBe(true);
    expect(t.log.started).toHaveLength(3);
    // One cancelled twice frees one place, not two.
    await t.ask("workers.cancel", { plugin: "needy", taskId: "T1" });
    await t.ask("workers.cancel", { plugin: "needy", taskId: "T1" });
    await t.ask("workers.start", start("needy"));
    await expect(t.ask("workers.start", start("needy"))).rejects.toThrow("3 workers at work");
    // The day's count: T1-T3, the one above and one more make five; then no more, though places are free.
    await t.ask("workers.cancel", { plugin: "needy", taskId: "T2" });
    await t.ask("workers.start", start("needy"));
    await t.ask("workers.cancel", { plugin: "needy", taskId: "T3" });
    await expect(t.ask("workers.start", start("needy"))).rejects.toThrow("5 workers in the last 24 hours");
    expect(t.log.started).toHaveLength(5);
  });

  it("gives its place back when it could not be started", async () => {
    const dir = tempDir("orch-prim");
    plugin(dir, "needy", ALL, "builtin");
    const t = await setup(dir);
    t.options.grants.add("needy");
    t.options.quota = { atOnce: 1, perDay: 1 };
    t.log.failNext = true;
    await expect(t.ask("workers.start", start("needy"))).rejects.toThrow("the head is unavailable");
    expect(await t.ask("workers.start", start("needy"))).toEqual({ taskId: "T1", run: 1 });
  });

  it("is capped by the plugin's grant: a model that may change spec/ is refused, another model goes through", async () => {
    const dir = tempDir("orch-prim");
    plugin(dir, "needy", ALL, "builtin");
    const t = await setup(dir);
    t.options.grants.add("needy");
    for (const model of ["opus", "claude-opus-5-5", "opus[1m]", "OPUS"]) {
      await expect(t.ask("workers.start", start("needy", { model })), model).rejects.toThrow("may not use a model that may change spec/");
    }
    expect(t.log.started).toEqual([]);
    // The list is settings.json `specWriters`: a bot cannot get round it with another family's name.
    t.options.specWriters = ["fable"];
    await expect(t.ask("workers.start", start("needy", { model: "claude-fable-5-2" }))).rejects.toThrow("may not use a model that may change spec/");
    await t.ask("workers.start", start("needy", { model: "opus" }));
    expect(t.log.started).toHaveLength(1);
  });

  it("cannot be cancelled or sent to by a plugin that did not start it (the same answer as for one that does not exist)", async () => {
    const dir = tempDir("orch-prim");
    plugin(dir, "owner", ALL, "builtin");
    plugin(dir, "other", ALL, "builtin");
    const t = await setup(dir);
    t.options.grants.add("owner");
    t.options.grants.add("other");
    await t.ask("workers.start", start("owner"));
    const mine = { plugin: "owner", taskId: "T1" };
    for (const taskId of ["T1", "T99"]) {
      await expect(t.ask("workers.cancel", { plugin: "other", taskId })).rejects.toThrow("No such worker.");
      await expect(t.ask("workers.send", { plugin: "other", taskId, message: "hi" })).rejects.toThrow("No such worker.");
    }
    expect(t.log.stopped).toEqual([]);
    expect(t.log.sent).toEqual([]);
    expect(await t.ask("workers.cancel", mine)).toEqual({ stopped: true });
  });
});

describe("a plugin a bot wrote asks the user for every worker", () => {
  it("shows a card each time; Allow once starts it, Refuse does not; the plugin's own words are not an answer", async () => {
    const dir = tempDir("orch-prim");
    plugin(dir, "botmade", ALL);
    plugin(dir, "shipped", ALL, "builtin");
    const t = await setup(dir);
    t.options.grants.add("botmade");
    t.options.grants.add("shipped");
    const first = t.ask("workers.start", start("botmade", { instructions: "Delete\nthe \"build\" folder" }));
    await until(() => t.questions.length === 1);
    expect(t.log.started).toEqual([]);
    const card = t.questions[0]!.question;
    expect(card.choices.map((choice) => choice.label)).toEqual(["Allow once", "Refuse"]);
    expect(card.typed).toBe(false);
    expect(card.text).toContain("botmade");
    expect(card.text).toContain('"Delete the \\"build\\" folder"');
    // The plugin saying "Allow" to the user's chat is not the answer.
    await t.ask("bots.send", { plugin: "botmade", bot: "main", text: "Allow" });
    expect(t.log.started).toEqual([]);
    t.questions[0]!.answer({ index: 0 });
    expect(await first).toEqual({ taskId: "T1", run: 1 });
    // The next worker is a new card: there is no "always".
    const second = t.ask("workers.start", start("botmade"));
    await until(() => t.questions.length === 2);
    t.questions[1]!.answer({ index: 1 });
    await expect(second).rejects.toThrow("You did not allow this worker");
    // A typed answer, or any index but the first, is a refusal too.
    const third = t.ask("workers.start", start("botmade"));
    await until(() => t.questions.length === 3);
    t.questions[2]!.answer({ text: "yes" });
    await expect(third).rejects.toThrow("You did not allow this worker");
    expect(t.log.started).toHaveLength(1);
    // A plugin shipped with Botling does not ask.
    await t.ask("workers.start", start("shipped"));
    expect(t.questions).toHaveLength(3);
    expect(t.log.started).toHaveLength(2);
  });
});

/** PluginWorkers alone: what the wire cannot reach. */
function book(overrides: { facts?: () => PluginFacts | null; ask?: (question: AppQuestion) => Promise<AppAnswer | null>; granted?: () => boolean; file?: { text: string | null }; cardWaitMs?: number } = {}) {
  const { log, port } = fakeWorkers();
  const told: [string, Record<string, unknown>][] = [];
  const file = overrides.file ?? { text: null };
  const workers = new PluginWorkers({
    world: { granted: overrides.granted ?? (() => true), workers: () => port, made: () => true },
    facts: overrides.facts ?? (() => ({ name: "p", identity: "a".repeat(64), permissions: ALL, botWritten: false })),
    ask: overrides.ask ?? (async () => ({ index: 0 })),
    tell: (_plugin, _event, data) => told.push(["workerReport", data]),
    file: { read: () => file.text, write: (text) => { file.text = text; } },
    ...(overrides.cardWaitMs ? { cardWaitMs: overrides.cardWaitMs } : {}),
  });
  return { workers, log, told, file };
}
const params = { bot: "main", instructions: "Do it", name: "n" };

describe("PluginWorkers, the parts the wire does not reach", () => {
  it("a card nobody answers refuses when its time is out, and takes no place", async () => {
    const t = book({ facts: () => ({ name: "p", identity: "a".repeat(64), permissions: ALL, botWritten: true }), ask: () => new Promise(() => {}), cardWaitMs: 20 });
    await expect(t.workers.start("p", params)).rejects.toThrow("You did not allow this worker");
    expect(t.log.started).toEqual([]);
    expect(t.file.text).toBeNull();
  });

  it("a plugin that changed, or lost its grant, while the card was open starts nothing (the answer is checked where it is used)", async () => {
    for (const change of ["identity", "grant", "gone"] as const) {
      let identity = "a".repeat(64), granted = true, gone = false;
      const t = book({
        facts: () => (gone ? null : { name: "p", identity, permissions: ALL, botWritten: true }), granted: () => granted,
        ask: async () => { if (change === "identity") identity = "b".repeat(64); if (change === "grant") granted = false; if (change === "gone") gone = true; return { index: 0 }; },
      });
      await expect(t.workers.start("p", params), change).rejects.toThrow();
      expect(t.log.started, change).toEqual([]);
    }
  });

  it("a record it cannot read fails closed", async () => {
    const t = book({ file: { text: "{not json" } });
    await expect(t.workers.start("p", params)).rejects.toThrow("could not be read");
    expect(t.log.started).toEqual([]);
  });

  it("keeps its book across a restart: the quota still counts, the report is told once", async () => {
    const first = book();
    await first.workers.start("p", params);
    await first.workers.start("p", params);
    first.workers.ended("T1", 1, "completed", "done");
    expect(first.told).toHaveLength(1);
    expect(JSON.parse(first.file.text!)).toHaveLength(2);
    // The app starts again: a new object over the same file.
    const again = book({ file: first.file });
    again.workers.ended("T1", 1, "completed", "done");
    expect(again.told).toEqual([]);
    again.workers.ended("T2", 1, "completed", "done");
    expect(again.told).toHaveLength(1);
    // A second run of the same worker is a new report.
    again.workers.ended("T2", 2, "completed", "more");
    expect(again.told).toHaveLength(2);
  });

  it("a worker cancelled by its plugin is not reported; a send into an idle one takes a place again", async () => {
    const t = book();
    await t.workers.start("p", params);
    await t.workers.cancel("p", "T1");
    t.workers.ended("T1", 1, "stopped", "");
    expect(t.told).toEqual([]);
    await t.workers.start("p", params);
    t.workers.ended("T2", 1, "completed", "done");
    await t.workers.send("p", "T2", "once more");
    expect(JSON.parse(t.file.text!).find((entry: { task: string }) => entry.task === "T2").open).toBe(true);
  });
});

/** A worker a plugin started, in the Claude adapter: fewer rights than a worker the bot started itself. */
describe("ClaudeWorkers.startFor", () => {
  const strong = { command: "claude", cwd: "/elsewhere", sessionId: "coordinator", resume: true, allowedTools: ["Read", "Bash"], disallowedTools: [], model: "opus", effort: "high", bypassPermissions: true, autoMode: true, askPermission: false } as never;

  it("has no spec/ writers and none of the bot's skip-the-cards modes, whatever the model chain gives (the bot's own worker keeps them)", async () => {
    const h = claudeHarness(undefined, { base: strong, subagentModel: () => "opus" });
    try {
      await h.workers.startFor({ instructions: "From a plugin", model: "opus" });
      await h.workers.tool("app_handoff", { instructions: "From the bot" });
      const [fromPlugin, fromBot] = h.heads.map((head) => head.config);
      expect(fromPlugin).toMatchObject({ model: "opus", specGuard: { writers: [] }, bypassPermissions: false, autoMode: false, askPermission: true });
      expect(fromBot).toMatchObject({ model: "opus", specGuard: { writers: ["opus"] }, bypassPermissions: true, autoMode: true, askPermission: false });
    } finally { await h.workers.close(); }
  });

  it("keeps the mark on a follow-up run after the worker's process ended", async () => {
    const h = claudeHarness(undefined, { base: strong, subagentModel: () => "opus", keepAliveMs: 0 });
    try {
      const { task_id } = await h.workers.startFor({ instructions: "From a plugin" });
      const head = h.heads[0]!;
      h.result(head, "done");
      head.finish();
      await h.workers.tool("app_send_message", { task_id, message: "again" });
      expect(h.heads.at(-1)!.config).toMatchObject({ specGuard: { writers: [] }, bypassPermissions: false, autoMode: false });
    } finally { await h.workers.close(); }
  });
});
