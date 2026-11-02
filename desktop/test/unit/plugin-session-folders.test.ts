// `sessions.folder` (plugin-extraction.md §3.2 #2): a built-in plugin decides the folder a bot's session starts in. The
// core answers from memory (and from disk after a restart), so a turn never waits on the plugin host; a change makes an
// awake bot start again once; a plugin that is turned off, or is not shipped with the app, decides nothing.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { Plugins, type PluginWorld } from "../../src/core/plugins";
import type { HostCommand, HostHandlers } from "../../src/core/plugins/host-client";
import { cleanFolder, SessionFolders } from "../../src/core/plugins/session-folders";
import { testSealer } from "../../src/core/plugins/secrets";

function plugin(root: string, name: string, permissions: string[]) {
  const folder = join(root, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", permissions } }));
  writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}");
}

const running: Plugins[] = [];
afterEach(async () => { for (const plugins of running.splice(0)) await plugins.shutdown(); });

/** Plugins over a fake host process; `holdLoad`: the host answers `load` only when `release` is called (a host still starting). */
async function setup(dir: string, options: { holdLoad?: boolean } = {}) {
  const moved: [string, { told: string; shown: string }][] = [];
  const world: PluginWorld = {
    bots: () => [], send: () => ({ messageId: "M" }), interrupt: async () => null, notice: () => {}, ask: () => new Promise(() => {}), openPanel: () => {},
    appSettings: () => ({}), shortcutOverrides: () => ({}), createBot: () => { throw new Error("no"); }, addRoutine: () => "added",
    commandApproval: () => null, approveCommand: () => false, commandRun: () => null, component: () => null, imageUrls: () => null,
    botId: (id) => (id === "main" ? "MAIN-ID" : id.startsWith("B") ? id : null),
    sessionMoved: (botId, reason) => { moved.push([botId, reason]); },
    sessionBots: () => [{ id: "B1", name: "Site", role: "manager", parent: null, folder: "/p/site", memoryPath: ".bot/memory.md", storeDir: "/d/bots/B1", problem: null, workRoot: "/work/drive" }],
    changed: () => {}, broken: () => {}, log: () => {},
    workspace: { bots: () => [], memory: () => { throw new Error("no"); }, tasks: () => [], taskHistory: () => [], results: () => [], waiting: () => ({ items: [], doing: {} }), ignoreWaiting: () => {}, pendingApprovals: () => [], face: () => "" },
    workspaceWatch: () => {},
  };
  const sent: any[] = [];
  let handlers!: HostHandlers;
  let held: (() => void) | null = null;
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
  const plugins = new Plugins({ dataDir: dir, world, node, hostScript: "host.mjs", sealer: testSealer("test-key"), builtIns: join(dir, "builtin") });
  running.push(plugins);
  await plugins.start();
  if (options.holdLoad) await until(() => held); else await until(() => plugins.host.running);
  let nextId = 7000;
  const ask = async (method: string, params: unknown): Promise<any> => {
    const id = nextId++;
    line({ id, method, params });
    await until(() => sent.some((m) => m.id === id && m.method === undefined));
    const answer = sent.find((m) => m.id === id && m.method === undefined);
    if (answer.error) throw new Error(answer.error.message);
    return answer.result;
  };
  return { plugins, ask, moved, release: () => held!() };
}

const TREE = { cwd: "/w/site-fix", addDirs: ["/p/site/.bot"], note: "(App: Worktree. …)" };

describe("sessions.folder", () => {
  it("is answered from memory at once; a change restarts the bot once, the same folder again does nothing", async () => {
    const dir = tempDir("session-folders");
    plugin(join(dir, "builtin"), "botling.git", ["sessions"]);
    const { plugins, ask, moved } = await setup(dir);
    expect(plugins.sessionFolder("B1")).toBeNull();
    await ask("sessions.folder", { plugin: "botling.git", bot: "B1", folder: TREE, reason: { told: "you now work in a worktree", shown: "Made a worktree." } });
    expect(plugins.sessionFolder("B1")).toEqual({ ...TREE, plugin: "botling.git" });
    expect(moved).toEqual([["B1", { told: "you now work in a worktree", shown: "Made a worktree." }]]);
    await ask("sessions.folder", { plugin: "botling.git", bot: "B1", folder: TREE });
    expect(moved).toHaveLength(1);
    await ask("sessions.folder", { plugin: "botling.git", bot: "B1", folder: null });
    expect(plugins.sessionFolder("B1")).toBeNull();
    expect(moved.at(-1)![0]).toBe("B1");
    expect(moved).toHaveLength(2);
  });

  it("is refused to a plugin that is not shipped with the app, has no \"sessions\" permission, names no bot or sends no absolute folder", async () => {
    const dir = tempDir("session-folders");
    plugin(join(dir, "builtin"), "botling.git", ["sessions"]);
    plugin(join(dir, "builtin"), "botling.nosessions", []);
    plugin(join(dir, "plugins"), "library", ["sessions"]);
    const { plugins, ask } = await setup(dir);
    await expect(ask("sessions.folder", { plugin: "library", bot: "B1", folder: TREE })).rejects.toThrow("shipped with Botling");
    await expect(ask("sessions.folder", { plugin: "botling.nosessions", bot: "B1", folder: TREE })).rejects.toThrow("\"sessions\" permission");
    await expect(ask("sessions.folder", { plugin: "botling.git", bot: "ghost", folder: TREE })).rejects.toThrow("No such bot");
    await expect(ask("sessions.folder", { plugin: "botling.git", bot: "B1", folder: { cwd: "relative/path" } })).rejects.toThrow("absolute");
    expect(plugins.sessionFolder("B1")).toBeNull();
  });

  it("survives a restart: the folder is there before the plugin host has loaded the plugin, and nobody is restarted for it", async () => {
    const dir = tempDir("session-folders");
    plugin(join(dir, "builtin"), "botling.git", ["sessions"]);
    const first = await setup(dir);
    await first.ask("sessions.folder", { plugin: "botling.git", bot: "B1", folder: TREE });
    await first.plugins.shutdown();
    running.length = 0;
    const second = await setup(dir, { holdLoad: true });
    expect(second.plugins.host.running).toBe(false);
    expect(second.plugins.sessionFolder("B1")).toEqual({ ...TREE, plugin: "botling.git" });
    expect(second.moved).toEqual([]);
    second.release();
    await until(() => second.plugins.host.running);
    // The plugin says what it holds (the same): still nothing moved. Without B1 in it, B1 goes back to its own folder.
    await second.ask("sessions.folders", { plugin: "botling.git", folders: { B1: TREE } });
    expect(second.moved).toEqual([]);
    await second.ask("sessions.folders", { plugin: "botling.git", folders: {} });
    expect(second.plugins.sessionFolder("B1")).toBeNull();
    expect(second.moved.map(([id]) => id)).toEqual(["B1"]);
  });

  it("is dropped when the plugin is turned off and comes back when it is turned on; a plugin removed from disk decides nothing", async () => {
    const dir = tempDir("session-folders");
    plugin(join(dir, "builtin"), "botling.git", ["sessions"]);
    const { plugins, ask, moved } = await setup(dir);
    await ask("sessions.folder", { plugin: "botling.git", bot: "B1", folder: TREE });
    moved.length = 0;
    plugins.setEnabled("botling.git", false);
    expect(plugins.sessionFolder("B1")).toBeNull();
    expect(moved.map(([id, reason]) => [id, reason.told])).toEqual([["B1", "your working folder is the project folder again"]]);
    plugins.setEnabled("botling.git", true);
    expect(plugins.sessionFolder("B1")?.cwd).toBe("/w/site-fix");
    expect(moved).toHaveLength(2);
  });

  it("lists the bots a plugin may place (as the world has them) and keeps the folders file readable", async () => {
    const dir = tempDir("session-folders");
    plugin(join(dir, "builtin"), "botling.git", ["sessions"]);
    plugin(join(dir, "builtin"), "botling.nosessions", []);
    const { ask } = await setup(dir);
    expect(await ask("sessions.bots", { plugin: "botling.git" })).toEqual([expect.objectContaining({ id: "B1", folder: "/p/site", storeDir: "/d/bots/B1", workRoot: "/work/drive" })]);
    await expect(ask("sessions.bots", { plugin: "botling.nosessions" })).rejects.toThrow("\"sessions\" permission");
    await ask("sessions.folder", { plugin: "botling.git", bot: "B1", folder: TREE });
    expect(JSON.parse(readFileSync(join(dir, "plugin-session-folders.json"), "utf8"))).toEqual({ "botling.git": { B1: TREE } });
  });
});

describe("SessionFolders", () => {
  it("cleans what a plugin sent and ignores an unreadable file", () => {
    expect(cleanFolder({ cwd: "/a", addDirs: ["/b", "rel", 3], note: "n" })).toEqual({ cwd: "/a", addDirs: ["/b"], note: "n" });
    expect(cleanFolder({ cwd: "a" })).toBeNull();
    expect(cleanFolder(null)).toBeNull();
    const dir = tempDir("session-folders");
    writeFileSync(join(dir, "f.json"), "{ not json");
    expect(new SessionFolders(join(dir, "f.json")).plugins()).toEqual([]);
  });
});
