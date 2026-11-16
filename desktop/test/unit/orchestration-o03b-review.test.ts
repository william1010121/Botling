// M7-O04, the four things the O03b review asked of this card, each with a test that fails without it:
//   (2) a plugin that loses its `orchestrate` grant hands its workers back to core, as disabling or replacing it does;
//   (3) deleting a bot closes the plugin book's entries on it;
//   (4) the instructions of a worker a plugin starts carry the "[Sent by the plugin …, not by the user.]" line, as its messages do;
//   (5) a request names the code that made it (`code`, the fingerprint), so older code a host still runs is refused.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir, until } from "../helpers";
import { claudeHarness } from "../claude-workers-fake";
import { Plugins, type PluginWorld } from "../../src/core/plugins";
import type { HostCommand, HostHandlers } from "../../src/core/plugins/host-client";
import { testSealer } from "../../src/core/plugins/secrets";
import { PluginWorkers, type PluginFacts, type WorkerPort } from "../../src/core/orchestration/plugin-workers";
import { startedByLine } from "../../src/core/worker-core/started-by";

const ALL = ["orchestrate", "exec", "files", "bots"];
const H1 = "a".repeat(64);
const BY = { plugin: "needy", hash: "0123456789abcdef".repeat(4) };

// ---- (4) the line before a plugin's instructions ------------------------------------------------------------------------------------

describe("(4) a worker a plugin starts is told who sent its instructions", () => {
  it("the first run's text starts with the line; the name still comes from the plugin's own words; a bot's own handoff gets none", async () => {
    const h = claudeHarness();
    try {
      const started = await h.workers.startFor({ instructions: "Check the build\nthen the lint" }, BY);
      const first = h.heads[0]!.sent[0]!.text;
      expect(first).toContain(startedByLine(BY));
      expect(first.indexOf(startedByLine(BY))).toBeLessThan(first.indexOf("Check the build"));
      expect(first).toContain("not by the user");
      // The name is made of what the plugin wrote, not of the line before it.
      expect(h.workers.core.get(started.task_id)!.name).toBe("Check the build");
      const own = await h.workers.tool("app_handoff", { instructions: "From the bot" }) as { task_id: string };
      expect(h.heads[1]!.sent[0]!.text).not.toContain("Sent by the plugin");
      expect(h.workers.core.get(own.task_id)!.startedBy).toBeUndefined();
    } finally { await h.workers.close(); }
  });

  it("the line is added after the size check: 64,000 characters stay legal, one more does not", async () => {
    const h = claudeHarness();
    try {
      const biggest = "字".repeat(64_000);
      await expect(h.workers.startFor({ instructions: biggest }, BY)).resolves.toMatchObject({ run: 1 });
      expect(h.heads[0]!.sent[0]!.text).toContain(biggest);
      await expect(h.workers.startFor({ instructions: biggest + "字" }, BY)).rejects.toThrow("maximum 64000");
    } finally { await h.workers.close(); }
  });
});

// ---- (2) and (3): the book alone -----------------------------------------------------------------------------------------------------

function book(state = { granted: true }) {
  const started: string[] = [], stopped: string[] = [], told: Record<string, unknown>[] = [];
  let file: string | null = null;
  const port: WorkerPort = {
    id: "main",
    start: async () => { started.push(`T${started.length + 1}`); return { task_id: `T${started.length}`, run: 1 }; },
    send: async () => ({ ok: true, how: "steered", run: 1 }),
    stop: async (id) => { stopped.push(id); return true; },
  };
  const workers = new PluginWorkers({
    world: { granted: () => state.granted, workers: () => port, quota: () => ({ atOnce: 2 }) },
    facts: (): PluginFacts => ({ name: "p", identity: H1, permissions: ALL, botWritten: false }),
    ask: async () => ({ index: 0 }),
    tell: (_plugin, _event, data) => { told.push(data); },
    file: { read: () => file, write: (text) => { file = text; } },
  });
  return { workers, state, started, stopped, told, rows: () => JSON.parse(file ?? "[]") as Record<string, unknown>[] };
}
const params = { bot: "main", instructions: "Do it", name: "n" };

describe("(2) a plugin that loses its grant hands its workers back", () => {
  it("revoked, then the trigger: each worker goes back to core (none stopped), nothing is owed or told, send and cancel say there is no such worker; the grant given again does not return them", async () => {
    const t = book();
    await t.workers.start("p", params);
    await t.workers.start("p", params);
    t.workers.ended("T1", 1, "completed", "done");
    expect(t.told).toHaveLength(1);
    t.workers.reconcile();
    // Still granted: nothing is handed back (the same hash, the same grant).
    expect(t.rows().map((row) => row.handed)).toEqual([undefined, undefined]);
    t.state.granted = false;
    t.workers.reconcile();
    expect(t.rows().map((row) => row.handed)).toEqual([true, true]);
    expect(t.stopped).toEqual([]);
    t.workers.ended("T2", 1, "completed", "late");
    expect(t.told).toHaveLength(1);
    t.state.granted = true;
    await expect(t.workers.send("p", "T2", "x")).rejects.toThrow("No such worker.");
    await expect(t.workers.cancel("p", "T2")).rejects.toThrow("No such worker.");
    expect(t.stopped).toEqual([]);
  });
});

describe("(3) a bot that is deleted closes the entries on it", () => {
  it("its place is free, nothing is owed, the plugin cannot send or cancel, and an entry on another bot is untouched", async () => {
    const t = book();
    await t.workers.start("p", params);
    await t.workers.start("p", params);
    await expect(t.workers.start("p", params)).rejects.toThrow(/at once/);
    t.workers.botGone(["other"]);
    expect(t.rows().map((row) => row.handed)).toEqual([undefined, undefined]);
    t.workers.botGone(["main"]);
    expect(t.rows().map((row) => [row.handed, row.open])).toEqual([[true, false], [true, false]]);
    await expect(t.workers.send("p", "T1", "x")).rejects.toThrow("No such worker.");
    await expect(t.workers.cancel("p", "T2")).rejects.toThrow("No such worker.");
    t.workers.ended("T1", 1, "completed", "after the bot went");
    expect(t.told).toEqual([]);
    // The two places it held are free again.
    await expect(t.workers.start("p", params)).resolves.toMatchObject({ run: 1 });
  });
});

// ---- (2), (3) and (5) through Plugins ------------------------------------------------------------------------------------------------

function plugin(dir: string, name: string) {
  const folder = join(dir, "builtin", name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, displayName: name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", permissions: ALL } }));
  writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}");
}

const running: Plugins[] = [];
afterEach(async () => { for (const plugins of running.splice(0)) await plugins.shutdown(); });

async function stack(dir: string, state = { granted: true }) {
  const started: string[] = [];
  const port: WorkerPort = {
    id: "main",
    start: async () => { started.push("x"); return { task_id: `T${started.length}`, run: 1 }; },
    send: async () => ({ ok: true, how: "steered", run: 1 }),
    stop: async () => true,
  };
  const world = {
    bots: () => [{ id: "main", name: "Main bot", role: "main", awake: true }], send: () => ({ messageId: "M1" }), ask: () => new Promise(() => {}),
    notice: () => {}, interrupt: async () => null, openPanel: () => {}, appSettings: () => ({}), shortcutOverrides: () => ({}),
    commandApproval: () => null, approveCommand: () => false, commandRun: () => null, component: () => null, imageUrls: () => null,
    createBot: () => { throw new Error("not here"); }, addRoutine: () => "added", changed: () => {}, broken: () => {}, log: () => {},
    workspace: {}, workspaceWatch: () => {},
    orchestration: { granted: () => state.granted, workers: () => port },
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
        pid: 4244,
        write: (text) => {
          const message = JSON.parse(text);
          sent.push(message);
          if (message.method === "load") line({ id: message.id, result: { loaded: message.params.plugins.map((spec: any) => spec.name), failed: [] } });
          if (message.method === "shutdown") line({ id: message.id, result: null });
        },
        terminate: async () => {},
      };
    },
  };
  const plugins = new Plugins({ dataDir: dir, world, node, hostScript: "host.mjs", sealer: testSealer("test-key"), builtIns: join(dir, "builtin") });
  running.push(plugins);
  await plugins.start();
  await until(() => plugins.host.running);
  let nextId = 3000;
  const ask = async (method: string, params: unknown): Promise<any> => {
    const id = nextId++;
    line({ id, method, params });
    await until(() => sent.some((m) => m.id === id && m.method === undefined));
    const answer = sent.find((m) => m.id === id && m.method === undefined);
    if (answer.error) throw new Error(answer.error.message);
    return answer.result;
  };
  const readBook = () => { try { return JSON.parse(readFileSync(join(dir, "plugin-workers.json"), "utf8")) as Record<string, unknown>[]; } catch { return []; } };
  return { plugins, ask, readBook, started };
}
const start = { plugin: "needy", bot: "main", instructions: "Check", name: "Check" };

describe("through Plugins", () => {
  it("(2) grantChanged: a plugin whose grant was taken back is handed back at once, and not before the trigger", async () => {
    const dir = tempDir("o03b-review");
    plugin(dir, "needy");
    const state = { granted: true };
    const t = await stack(dir, state);
    await t.ask("workers.start", start);
    state.granted = false;
    expect(t.readBook()[0]!.handed).toBeUndefined();
    t.plugins.grantChanged();
    expect(t.readBook()[0]!.handed).toBe(true);
  });

  it("(3) the botRemoved event closes the book's entries on that bot", async () => {
    const dir = tempDir("o03b-review");
    plugin(dir, "needy");
    const t = await stack(dir);
    await t.ask("workers.start", start);
    t.plugins.origins.set("main", "needy");
    t.plugins.origins.set("other", "needy");
    t.plugins.event("botRemoved", { botId: "elsewhere" });
    expect(t.readBook()[0]!.open).toBe(true);
    t.plugins.event("botRemoved", { botId: "main" });
    expect(t.readBook()[0]).toMatchObject({ open: false, handed: true });
    // No plugin's message is remembered as having reached the removed bot (another bot's mark stays).
    expect([...t.plugins.origins.keys()]).toEqual(["other"]);
  });

  it("(5) a request from older code than the plugin runs now is refused before any method sees it; the current code's is answered, and no method sees the field", async () => {
    const dir = tempDir("o03b-review");
    plugin(dir, "needy");
    const t = await stack(dir);
    const code = t.plugins.codeOf("needy");
    expect(code).toEqual(expect.any(String));
    await expect(t.ask("workers.start", { ...start, code: `${code}-old` })).rejects.toThrow("older code");
    expect(t.started).toEqual([]);
    expect(t.readBook()).toEqual([]);
    // The strict params of workers.start do not see the field.
    await expect(t.ask("workers.start", { ...start, code })).resolves.toMatchObject({ run: 1 });
    expect(t.started).toHaveLength(1);
    // Every method is covered, not only the worker ones.
    await expect(t.ask("bots.list", { plugin: "needy", code: "stale" })).rejects.toThrow("older code");
    await expect(t.ask("bots.list", { plugin: "needy", code })).resolves.toEqual([expect.objectContaining({ id: "main" })]);
  });
});
