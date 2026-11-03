// `ui.emit` (a plugin's program part pushes to its frames), `bots.folder` (a bot's working folder, for a plugin with "exec") and
// the seams botling.terminal needs, each generic.
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
  const pushed: { plugin: string; name: string; botId: string | undefined; data: unknown }[] = [];
  const world: PluginWorld = {
    bots: () => [], send: () => ({ messageId: "M" }), interrupt: async () => null, notice: () => {}, ask: () => new Promise(() => {}), openPanel: () => {},
    appSettings: () => ({}), shortcutOverrides: () => ({}), createBot: () => { throw new Error("no"); }, addRoutine: () => "added",
    commandApproval: () => null, approveCommand: () => false, commandRun: () => null, component: () => null, imageUrls: () => null,
    botId: (id) => (id === "main" ? "MAIN-ID" : id.startsWith("B") ? id : null),
    sessionMoved: (botId, reason) => { moved.push([botId, reason]); },
    frameEvent: (plugin, name, botId, data) => { pushed.push({ plugin, name, botId, data }); },
    botFolder: (botId) => (botId === "main" ? "/p/main" : botId === "B1" ? "/p/site" : null),
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
  return { plugins, ask, moved, pushed, line, sent, release: () => held!() };
}


describe("ui.emit", () => {
  it("goes to the app page for the plugin that sent it, with the bot it names; a push that is too big or from a plugin that is not running goes nowhere", async () => {
    const dir = tempDir("frame-events");
    plugin(join(dir, "plugins"), "pushy", []);
    const { line, pushed } = await setup(dir);
    const emit = (params: Record<string, unknown>) => line({ method: "ui.emit", params });
    emit({ plugin: "pushy", name: "terminal", botId: "B1", data: { type: "data", data: "ls" } });
    emit({ plugin: "pushy", name: "all", data: [1, 2] });
    emit({ plugin: "pushy", name: "big", data: "x".repeat(1_000_001) });
    emit({ plugin: "ghost", name: "terminal", data: 1 });
    emit({ plugin: "pushy", name: "", data: 1 });
    await until(() => pushed.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pushed).toEqual([
      { plugin: "pushy", name: "terminal", botId: "B1", data: { type: "data", data: "ls" } },
      { plugin: "pushy", name: "all", botId: undefined, data: [1, 2] },
    ]);
  });
});

describe("bots.folder", () => {
  it("gives a bot's working folder (the main bot's too) to a plugin with the \"exec\" permission, and nothing to one without", async () => {
    const dir = tempDir("bot-folder");
    plugin(join(dir, "plugins"), "runner", ["exec"]);
    plugin(join(dir, "plugins"), "reader", []);
    const { ask } = await setup(dir);
    expect(await ask("bots.folder", { plugin: "runner", bot: "B1" })).toBe("/p/site");
    expect(await ask("bots.folder", { plugin: "runner", bot: "main" })).toBe("/p/main");
    expect(await ask("bots.folder", { plugin: "runner", bot: "ghost" })).toBeNull();
    await expect(ask("bots.folder", { plugin: "reader", bot: "B1" })).rejects.toThrow("\"exec\" permission");
  });
});
