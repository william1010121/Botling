// `routines.list` and `routines.change` for plugins: a built-in plugin with the "routines" permission shows a bot's routines
// and pauses, resumes or cancels one (the app's own Routines panel did exactly this before it became botling.routines). It
// never creates one, and a library plugin or one without the permission may not touch them.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { Plugins, type PluginWorld } from "../../src/core/plugins";
import type { HostCommand, HostHandlers } from "../../src/core/plugins/host-client";
import { testSealer } from "../../src/core/plugins/secrets";

function plugin(root: string, name: string, permissions: string[]) {
  const folder = join(root, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", permissions } }));
  writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}");
}

const running: Plugins[] = [];
afterEach(async () => { for (const plugins of running.splice(0)) await plugins.shutdown(); });

const LIST = { routines: [{ id: "R1", kind: "recurring" as const, task: "t", title: "t", schedule: "Every day 08:15", cron: "15 8 * * *", timezone: "system_local", status: "pending", next: null }], error: null };

async function setup(dir: string, withRoutines = true) {
  const changes: [string, string, string][] = [];
  const world = {
    bots: () => [], send: () => ({ messageId: "M" }), interrupt: async () => null, notice: () => {}, ask: () => new Promise(() => {}), openPanel: () => {},
    appSettings: () => ({}), shortcutOverrides: () => ({}), createBot: () => { throw new Error("no"); }, addRoutine: () => "added",
    commandApproval: () => null, approveCommand: () => false, commandRun: () => null, component: () => null, imageUrls: () => null,
    ...(withRoutines ? {
      routinesList: (botId: string) => (botId === "B1" ? LIST : null),
      routinesChange: (botId: string, operation: "pause" | "resume" | "cancel", id: string) => {
        if (botId !== "B1") return null;
        if (id === "gone") throw new Error("No such routine.");
        changes.push([botId, operation, id]);
        return { routines: [], error: null };
      },
    } : {}),
    changed: () => {}, broken: () => {}, log: () => {},
    workspace: { bots: () => [], memory: () => { throw new Error("no"); }, tasks: () => [], taskHistory: () => [], results: () => [], waiting: () => ({ items: [], doing: {} }), ignoreWaiting: () => {}, pendingApprovals: () => [], face: () => "" },
    workspaceWatch: () => {},
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
        pid: 4245,
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
  let nextId = 8000;
  const ask = async (method: string, params: unknown): Promise<any> => {
    const id = nextId++;
    line({ id, method, params });
    await until(() => sent.some((m) => m.id === id && m.method === undefined));
    const answer = sent.find((m) => m.id === id && m.method === undefined);
    if (answer.error) throw new Error(answer.error.message);
    return answer.result;
  };
  return { ask, changes };
}

describe("routines.list and routines.change", () => {
  it("list a bot's routines and pass Pause, Resume and Cancel on, answering the list after", async () => {
    const dir = tempDir("plugin-routines");
    plugin(join(dir, "builtin"), "botling.routines", ["routines"]);
    const { ask, changes } = await setup(dir);
    expect(await ask("routines.list", { plugin: "botling.routines", bot: "B1" })).toEqual(LIST);
    for (const operation of ["pause", "resume", "cancel"]) expect(await ask("routines.change", { plugin: "botling.routines", bot: "B1", operation, id: "R1" })).toEqual({ routines: [], error: null });
    expect(changes).toEqual([["B1", "pause", "R1"], ["B1", "resume", "R1"], ["B1", "cancel", "R1"]]);
  });

  it("say which bot or routine is wrong, and refuse an operation that is not pause, resume or cancel (creating one is not for a plugin)", async () => {
    const dir = tempDir("plugin-routines");
    plugin(join(dir, "builtin"), "botling.routines", ["routines"]);
    const { ask, changes } = await setup(dir);
    await expect(ask("routines.list", { plugin: "botling.routines", bot: "ghost" })).rejects.toThrow("No such bot");
    await expect(ask("routines.change", { plugin: "botling.routines", bot: "ghost", operation: "pause", id: "R1" })).rejects.toThrow("No such bot");
    await expect(ask("routines.change", { plugin: "botling.routines", bot: "B1", operation: "pause", id: "gone" })).rejects.toThrow("No such routine.");
    await expect(ask("routines.change", { plugin: "botling.routines", bot: "B1", operation: "create", id: "R1" })).rejects.toThrow("Not a request a plugin can make");
    expect(changes).toEqual([]);
  });

  it("are refused to a plugin that is not shipped with the app or has no \"routines\" permission, and where the world has no routines", async () => {
    const dir = tempDir("plugin-routines");
    plugin(join(dir, "builtin"), "botling.routines", ["routines"]);
    plugin(join(dir, "builtin"), "botling.plain", []);
    plugin(join(dir, "plugins"), "library", ["routines"]);
    const { ask, changes } = await setup(dir);
    await expect(ask("routines.list", { plugin: "library", bot: "B1" })).rejects.toThrow("shipped with Botling");
    await expect(ask("routines.change", { plugin: "library", bot: "B1", operation: "cancel", id: "R1" })).rejects.toThrow("shipped with Botling");
    await expect(ask("routines.list", { plugin: "botling.plain", bot: "B1" })).rejects.toThrow("\"routines\" permission");
    await expect(ask("routines.list", { plugin: "ghost", bot: "B1" })).rejects.toThrow("not running");
    expect(changes).toEqual([]);
    const bare = tempDir("plugin-routines-bare");
    plugin(join(bare, "builtin"), "botling.routines", ["routines"]);
    await expect((await setup(bare, false)).ask("routines.list", { plugin: "botling.routines", bot: "B1" })).rejects.toThrow("not available here");
  });
});
