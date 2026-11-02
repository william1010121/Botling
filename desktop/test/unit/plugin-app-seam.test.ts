// The `app` seam (plugin-extraction.md §3.2 #6, plugins/app-seam.ts): botling.dev installs a build and restarts, photographs the
// window, posts cards and keeps the developer briefing. Privileged: the "app" permission, and only a plugin shipped with the app.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { Plugins, type PluginWorld } from "../../src/core/plugins";
import type { HostCommand, HostHandlers } from "../../src/core/plugins/host-client";
import { installCommandOK } from "../../src/core/plugins/app-seam";
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
  const calls: any[] = [];
  const picks: ((index: number) => void)[] = [];
  const world: PluginWorld = {
    bots: () => [], send: () => ({ messageId: "M" }), interrupt: async () => null, notice: () => {}, ask: () => new Promise(() => {}), openPanel: () => {},
    appSettings: () => ({}), shortcutOverrides: () => ({}), createBot: () => { throw new Error("no"); }, addRoutine: () => "added",
    commandApproval: () => null, approveCommand: () => false, commandRun: () => null, component: () => null, imageUrls: () => null,
    botId: (id) => (id === "main" ? "MAIN-ID" : id.startsWith("B") ? id : null),
    app: {
      state: () => ({ pid: 4242, dataDir: join(dir, "core"), appDataDir: null, bundle: "/Applications/Botling 2.app", developerMode: true, developer: { id: "B1", name: "botling", folder: "/p/botling" } }),
      installAndRestart: (command, log) => { calls.push(["install", command, log]); },
      captureWindow: async () => "/tmp/shot.png",
      card: (text, choices, source) => new Promise((resolve) => { calls.push(["card", text, choices, source]); if (choices) picks.push(resolve); else resolve(null); }),
      tell: (botId, kind, text, files) => { calls.push(["tell", botId, kind, text, files]); return botId === "B1"; },
    },
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
  return { plugins, ask, calls, picks, release: () => held!() };
}


const script = (dir: string) => join(dir, "core", "self-update", "install.sh");
const COMMAND = (dir: string) => ["/usr/bin/nohup", "/bin/bash", script(dir), "4242", "/Applications/Botling 2.app", "/dist/Botling 2.app", "/b.app", "/h", "/r", "90", "/data", "/Applications/Botling 2.app"];

describe("the app seam", () => {
  it("answers the app's state, a window picture, cards and tells only to a shipped plugin with the \"app\" permission", async () => {
    const dir = tempDir("app-seam");
    plugin(join(dir, "builtin"), "botling.dev", ["app"]);
    plugin(join(dir, "builtin"), "botling.noapp", []);
    plugin(join(dir, "plugins"), "library", ["app"]);
    const { ask, calls, picks } = await setup(dir);
    expect(await ask("app.state", { plugin: "botling.dev" })).toMatchObject({ pid: 4242, bundle: "/Applications/Botling 2.app", developer: { id: "B1" } });
    expect(await ask("app.captureWindow", { plugin: "botling.dev" })).toBe("/tmp/shot.png");
    const card = ask("app.card", { plugin: "botling.dev", text: "Install?", choices: [{ label: "Yes", recommended: true }, { label: "No" }], source: "B1" });
    await until(() => picks.length === 1);
    picks[0]!(1);
    expect(await card).toEqual({ index: 1 });
    expect(calls.at(-1)).toEqual(["card", "Install?", [{ label: "Yes", recommended: true }, { label: "No" }], "B1"]);
    expect(await ask("app.card", { plugin: "botling.dev", text: "Done." })).toBeNull();
    await ask("app.tell", { plugin: "botling.dev", bot: "B1", kind: "relay", text: "(App) hi", files: ["/tmp/a.png"] });
    expect(calls.at(-1)).toEqual(["tell", "B1", "relay", "(App) hi", ["/tmp/a.png"]]);
    await expect(ask("app.tell", { plugin: "botling.dev", bot: "ghost", kind: "note", text: "x" })).rejects.toThrow("No such bot");
    for (const method of ["app.state", "app.captureWindow"]) {
      await expect(ask(method, { plugin: "library" })).rejects.toThrow("shipped with Botling");
      await expect(ask(method, { plugin: "botling.noapp" })).rejects.toThrow("\"app\" permission");
    }
    await expect(ask("app.installAndRestart", { plugin: "library", command: COMMAND(dir), log: "/l" })).rejects.toThrow("shipped with Botling");
  });

  it("restarts only through the install script in the core's own self-update folder", async () => {
    const dir = tempDir("app-seam");
    plugin(join(dir, "builtin"), "botling.dev", ["app"]);
    const { ask, calls } = await setup(dir);
    await ask("app.installAndRestart", { plugin: "botling.dev", command: COMMAND(dir), log: "/l/install.log" });
    expect(calls.at(-1)).toEqual(["install", COMMAND(dir), "/l/install.log"]);
    calls.length = 0;
    const other = COMMAND(dir); other[2] = "/tmp/evil.sh";
    await expect(ask("app.installAndRestart", { plugin: "botling.dev", command: other, log: "/l" })).rejects.toThrow("not the install script");
    const shell = COMMAND(dir); shell[1] = "/bin/zsh";
    await expect(ask("app.installAndRestart", { plugin: "botling.dev", command: shell, log: "/l" })).rejects.toThrow("not the install script");
    await expect(ask("app.installAndRestart", { plugin: "botling.dev", command: COMMAND(dir).slice(0, 5), log: "/l" })).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(installCommandOK(COMMAND(dir), join(dir, "core"))).toBe(true);
    expect(installCommandOK(COMMAND(dir), join(dir, "elsewhere"))).toBe(false);
  });

  it("keeps the developer briefing for exactly that bot, across a restart, and drops it when the plugin is off", async () => {
    const dir = tempDir("app-seam");
    plugin(join(dir, "builtin"), "botling.dev", ["app"]);
    const first = await setup(dir);
    expect(first.plugins.devBriefing("B1", false)).toBe("");
    await first.ask("app.briefing", { plugin: "botling.dev", briefing: { bot: "B1", plain: "(App: plain)", worktree: "(App: worktree)" } });
    expect(first.plugins.devBriefing("B1", false)).toBe("(App: plain)");
    expect(first.plugins.devBriefing("B1", true)).toBe("(App: worktree)");
    expect(first.plugins.devBriefing("B2", false)).toBe("");
    first.plugins.setEnabled("botling.dev", false);
    expect(first.plugins.devBriefing("B1", false)).toBe("");
    first.plugins.setEnabled("botling.dev", true);
    await first.plugins.shutdown();
    running.length = 0;
    const second = await setup(dir, { holdLoad: true });
    expect(second.plugins.devBriefing("B1", true)).toBe("(App: worktree)");
    second.release();
    await until(() => second.plugins.host.running);
    await second.ask("app.briefing", { plugin: "botling.dev", briefing: null });
    expect(second.plugins.devBriefing("B1", false)).toBe("");
  });

  it("<install-build> and <app-screenshot/> go to botling.dev only when it ships with the app", async () => {
    const dir = tempDir("app-seam");
    const manifest = (name: string) => ({ name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", permissions: ["app"], contributes: { replyTags: [{ tag: "install-build" }, { tag: "app-screenshot" }] } } });
    const write = (root: string, name: string) => {
      mkdirSync(join(root, name, "dist"), { recursive: true });
      writeFileSync(join(root, name, "package.json"), JSON.stringify(manifest(name)));
      writeFileSync(join(root, name, "dist", "host.mjs"), "export function activate() {}");
    };
    write(join(dir, "builtin"), "botling.dev");
    write(join(dir, "plugins"), "someone-else");
    const { plugins } = await setup(dir);
    expect([...plugins.replyTagOwners()].sort()).toEqual([["app-screenshot", "botling.dev"], ["install-build", "botling.dev"]]);
  });
});
