// What botling.whiteboard needs of Botling beyond W1–W4 (plan W5): a command the user allowed is run by the core (state
// and run, under the plugin's name), the component library is readable, a tile's pictures are found by the core, and a
// reply's tag is not lost while its plugin is not loaded (kept on disk, handed over once the plugin loads).
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { parseReply, setPluginTags } from "../../src/core/reply";
import { Plugins, type PluginWorld } from "../../src/core/plugins";
import type { HostCommand, HostHandlers } from "../../src/core/plugins/host-client";
import { PendingTags, HELD_DAYS, HELD_MOST } from "../../src/core/plugins/pending-tags";
import { testSealer } from "../../src/core/plugins/secrets";

afterEach(() => setPluginTags([]));

function plugin(dir: string, name: string, ccb: Record<string, unknown>, root = join(dir, "plugins")) {
  const folder = join(root, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", web: "dist/web.mjs", permissions: ["bots"], ...ccb } }));
  writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}");
  writeFileSync(join(folder, "dist", "web.mjs"), "export function activate() {}");
}

const running: Plugins[] = [];
afterEach(async () => { for (const plugins of running.splice(0)) await plugins.shutdown(); });

interface Options { holdLoad?: boolean; ranOn?: Record<string, unknown>; builtIns?: string | null }
/** Plugins over a fake host process; `holdLoad`: the host answers `load` only when `releaseLoad` is called. */
async function setup(dir: string, options: Options = {}) {
  const asked: unknown[][] = [];
  const world: PluginWorld = {
    bots: () => [{ id: "main", name: "Main bot", role: "main", awake: true }],
    send: () => ({ messageId: "M" }), interrupt: async () => null, notice: () => {}, ask: () => new Promise(() => {}), openPanel: () => {},
    appSettings: () => ({}), shortcutOverrides: () => ({}), createBot: () => { throw new Error("no"); }, addRoutine: () => "added",
    commandApproval: () => null, approveCommand: () => false,
    commandRun: (botId, key, command, run) => {
      asked.push(["commandRun", botId, key, command, run]);
      if (botId !== "B1") return null;
      return { folder: "/p/site", approved: true, status: "done", data: '{"n":1}', error: null, ranAt: 5, started: run !== false };
    },
    component: (botId, name, data, command) => (botId === "B1" ? (asked.push(["component", name, data, command]), name === "gitlog" ? { exists: true, command: command ?? "git log" } : { exists: false, command: null }) : null),
    imageUrls: (botId, data) => (botId === "B1" ? (asked.push(["imageUrls", data]), { "chart.png": "botling-card://image/abc" }) : null),
    changed: () => {}, broken: () => {}, log: () => {},
    workspace: { bots: () => [], memory: () => { throw new Error("not here"); }, tasks: () => [], taskHistory: () => [], results: () => [], waiting: () => ({ items: [], doing: {} }), ignoreWaiting: () => {}, pendingApprovals: () => [], face: () => "" },
    workspaceWatch: () => {},
  };
  const sent: any[] = [];
  let handlers!: HostHandlers;
  let held: any = null;
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
          if (message.method === "load") {
            const answer = () => line({ id: message.id, result: { loaded: message.params.plugins.map((spec: any) => spec.name), failed: [] } });
            if (options.holdLoad) held = answer; else answer();
          }
          if (message.method === "shutdown") line({ id: message.id, result: null });
        },
        terminate: async () => {},
      };
    },
  };
  const plugins = new Plugins({ dataDir: dir, world, node, hostScript: "host.mjs", sealer: testSealer("test-key"), builtIns: options.builtIns ?? null });
  running.push(plugins);
  await plugins.start();
  if (!options.holdLoad) await until(() => plugins.host.running);
  else await until(() => held);
  let nextId = 5000;
  const ask = async (method: string, params: unknown): Promise<any> => {
    const id = nextId++;
    line({ id, method, params });
    await until(() => sent.some((m) => m.id === id && m.method === undefined));
    const answer = sent.find((m) => m.id === id && m.method === undefined);
    if (answer.error) throw new Error(answer.error.message);
    return answer.result;
  };
  return { plugins, sent, ask, asked, releaseLoad: async () => { held(); await until(() => plugins.host.running); } };
}

const TAGS = { contributes: { replyTags: [{ tag: "deploy-status" }] } };
const SITE = { id: "B1", name: "Site", role: "manager" as const, awake: true };
const hearing = (sent: any[]) => sent.filter((m) => m.method === "replyTag").map((m) => [m.params.plugin, m.params.bot.id, m.params.attributes, m.params.body]);

describe("approvals.state and approvals.run: Botling runs what the user allowed", () => {
  it("asks the core's runner under the plugin's name; state only reads, run starts one (a plugin cannot reach another's)", async () => {
    const dir = tempDir("wb-w5-run");
    plugin(dir, "alpha", {});
    const { ask, asked } = await setup(dir);
    expect(await ask("approvals.state", { plugin: "alpha", bot: "B1", command: "git log", key: "picture" })).toEqual({ folder: "/p/site", approved: true, status: "done", data: '{"n":1}', error: null, ranAt: 5 });
    expect(await ask("approvals.run", { plugin: "alpha", bot: "B1", command: "git log", key: "picture", minIntervalMs: 30_000 })).toMatchObject({ status: "done", started: true });
    expect(await ask("approvals.run", { plugin: "alpha", bot: "B1", command: "git log", key: "picture" })).toMatchObject({ started: true });
    expect(asked).toEqual([
      ["commandRun", "B1", "alpha/picture", "git log", false],
      ["commandRun", "B1", "alpha/picture", "git log", { minIntervalMs: 30_000 }],
      ["commandRun", "B1", "alpha/picture", "git log", { minIntervalMs: 0 }],
    ]);
  });

  it("refuses a bot that is not there, a key or an interval that makes no sense, and a plugin that is not running", async () => {
    const dir = tempDir("wb-w5-run-refused");
    plugin(dir, "alpha", {});
    const { ask } = await setup(dir);
    await expect(ask("approvals.run", { plugin: "alpha", bot: "B9", command: "git log", key: "picture" })).rejects.toThrow("No such bot.");
    await expect(ask("approvals.run", { plugin: "alpha", bot: "B1", command: "git log", key: "../x" })).rejects.toThrow(/Not a request a plugin can make/);
    await expect(ask("approvals.run", { plugin: "alpha", bot: "B1", command: "git log", key: "a b" })).rejects.toThrow(/Not a request a plugin can make/);
    await expect(ask("approvals.run", { plugin: "alpha", bot: "B1", command: "git log", key: "picture", minIntervalMs: -1 })).rejects.toThrow(/Not a request a plugin can make/);
    await expect(ask("approvals.run", { plugin: "alpha", bot: "B1", command: "", key: "picture" })).rejects.toThrow(/Not a request a plugin can make/);
    await expect(ask("approvals.run", { plugin: "ghost", bot: "B1", command: "git log", key: "picture" })).rejects.toThrow("That plugin is not running.");
    // Still no way to approve.
    await expect(ask("approvals.approve", { plugin: "alpha", bot: "B1", command: "git log" })).rejects.toThrow(/Unknown method/);
  });
});

describe("workspace.component and a tile's pictures", () => {
  it("reads the library: whether a component is there and the command its data comes from", async () => {
    const dir = tempDir("wb-w5-library");
    plugin(dir, "alpha", {});
    const { ask, asked } = await setup(dir);
    expect(await ask("workspace.component", { plugin: "alpha", bot: "B1", name: "gitlog" })).toEqual({ exists: true, command: "git log" });
    expect(await ask("workspace.component", { plugin: "alpha", bot: "B1", name: "gitlog", data: "null", command: "git log -3" })).toEqual({ exists: true, command: "git log -3" });
    expect(await ask("workspace.component", { plugin: "alpha", bot: "B1", name: "nope" })).toEqual({ exists: false, command: null });
    await expect(ask("workspace.component", { plugin: "alpha", bot: "B9", name: "gitlog" })).rejects.toThrow("No such bot.");
    expect(asked[0]).toEqual(["component", "gitlog", undefined, undefined]);
  });

  it("finds the pictures a tile's data names, for a plugin that is on", async () => {
    const dir = tempDir("wb-w5-tile");
    plugin(dir, "alpha", {});
    const { plugins } = await setup(dir);
    expect(plugins.tileImages("alpha", "B1", '{"image":"chart.png"}')).toEqual({ images: { "chart.png": "botling-card://image/abc" } });
    expect(() => plugins.tileImages("alpha", "B9", "{}")).toThrow(/No such bot/);
    expect(() => plugins.tileImages("ghost", "B1", "{}")).toThrow(/No plugin/);
    plugins.setEnabled("alpha", false);
    expect(() => plugins.tileImages("alpha", "B1", "{}")).toThrow(/is not on/);
  });
});

describe("a reply's tag is not lost while its plugin is not loaded", () => {
  it("is kept on disk, the last one for each bot, and handed over once the host has loaded the plugin", async () => {
    const dir = tempDir("wb-w5-held");
    plugin(dir, "alpha", TAGS);
    const { plugins, sent, releaseLoad } = await setup(dir, { holdLoad: true });
    expect(plugins.host.running).toBe(false);
    const first = parseReply('Hi <deploy-status name="status" size="2x1">{"n":1}</deploy-status>', ["deploy-status"]).pluginTags!;
    const second = parseReply('<deploy-status name="status">{"n":2}</deploy-status>', ["deploy-status"]).pluginTags!;
    const other = parseReply('<deploy-status name="gitlog"/>', ["deploy-status"]).pluginTags!;
    plugins.replyTags(SITE, first);
    plugins.replyTags(SITE, second);
    plugins.replyTags({ ...SITE, id: "B2", name: "News" }, other);
    expect(hearing(sent)).toEqual([]);
    // On disk, so a restart does not lose it either.
    expect(JSON.parse(readFileSync(join(dir, "plugin-pending-tags.json"), "utf8")).alpha).toHaveLength(2);
    await releaseLoad();
    await until(() => hearing(sent).length === 2);
    expect(hearing(sent)).toEqual([["alpha", "B1", { name: "status" }, '{"n":2}'], ["alpha", "B2", { name: "gitlog" }, ""]]);
    // Handed over once.
    expect(existsSync(join(dir, "plugin-pending-tags.json")) ? JSON.parse(readFileSync(join(dir, "plugin-pending-tags.json"), "utf8")) : {}).toEqual({});
    plugins.replyTags(SITE, first);
    expect(hearing(sent)).toHaveLength(3);
  });

  it("survives a restart of Botling: a new Plugins over the same folder hands it over when it loads", async () => {
    const dir = tempDir("wb-w5-held-restart");
    plugin(dir, "alpha", TAGS);
    const before = await setup(dir, { holdLoad: true });
    before.plugins.replyTags(SITE, parseReply('<deploy-status name="status">{"n":3}</deploy-status>', ["deploy-status"]).pluginTags!);
    await before.plugins.shutdown();
    const after = await setup(dir);
    await until(() => hearing(after.sent).length === 1);
    expect(hearing(after.sent)).toEqual([["alpha", "B1", { name: "status" }, '{"n":3}']]);
  });

  it("goes straight to a plugin that runs, after what is held for it; a tag nobody declared is not kept", async () => {
    const dir = tempDir("wb-w5-held-order");
    plugin(dir, "alpha", TAGS);
    const { plugins, sent } = await setup(dir);
    plugins.replyTags(SITE, parseReply('<deploy-status name="status">{"n":1}</deploy-status>', ["deploy-status"]).pluginTags!);
    expect(hearing(sent)).toEqual([["alpha", "B1", { name: "status" }, '{"n":1}']]);
    plugins.replyTags(SITE, [{ tag: "other-tag", attributes: {}, body: "" }]);
    expect(existsSync(join(dir, "plugin-pending-tags.json"))).toBe(false);
    // Turned off: its tag is text again, and nothing is held for it.
    plugins.setEnabled("alpha", false);
    plugins.replyTags(SITE, [{ tag: "deploy-status", attributes: {}, body: "" }]);
    expect(existsSync(join(dir, "plugin-pending-tags.json"))).toBe(false);
  });
});

describe("PendingTags", () => {
  const tag = (name: string, body = "") => ({ tag: "deploy-status", attributes: { name }, body });

  it("holds the last tag for each plugin, tag and bot; takes them out oldest first, once", () => {
    const dir = tempDir("wb-w5-pending");
    const file = join(dir, "held.json");
    let now = Date.parse("2026-11-02T10:00:00Z");
    const held = new PendingTags(file, () => now);
    held.hold("alpha", SITE, tag("a", "1"));
    now += 1_000;
    held.hold("alpha", { ...SITE, id: "B2" }, tag("b"));
    now += 1_000;
    held.hold("alpha", SITE, tag("c", "3"));
    held.hold("beta", SITE, tag("z"));
    expect(held.has("alpha")).toBe(true);
    expect(new PendingTags(file, () => now).take("alpha").map((entry) => [entry.bot.id, entry.attributes.name, entry.body])).toEqual([["B2", "b", ""], ["B1", "c", "3"]]);
    expect(held.take("alpha").map((entry) => entry.attributes.name)).toEqual(["b", "c"]);
    expect(held.has("alpha")).toBe(false);
    expect(held.take("alpha")).toEqual([]);
    expect(new PendingTags(file, () => now).has("alpha")).toBe(false);
    expect(new PendingTags(file, () => now).take("beta")).toHaveLength(1);
  });

  it("drops what waited longer than a month, caps what one plugin may have held, and reads a damaged file as none", () => {
    const dir = tempDir("wb-w5-pending-limits");
    const file = join(dir, "held.json");
    let now = Date.parse("2026-11-02T10:00:00Z");
    const held = new PendingTags(file, () => now);
    held.hold("alpha", SITE, tag("old"));
    now += (HELD_DAYS + 1) * 86_400_000;
    held.hold("alpha", { ...SITE, id: "B2" }, tag("new"));
    expect(held.take("alpha").map((entry) => entry.attributes.name)).toEqual(["new"]);
    for (let n = 0; n < HELD_MOST + 20; n++) held.hold("beta", { ...SITE, id: `X${n}` }, tag(`t${n}`));
    expect(held.take("beta")).toHaveLength(HELD_MOST);
    for (const text of ["", "{", "[]", '{"alpha":"x"}', '{"alpha":[{"bot":1}]}']) {
      writeFileSync(file, text);
      expect(new PendingTags(file, () => now).has("alpha")).toBe(false);
    }
  });
});
