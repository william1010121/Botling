// The `studio` seam (plugin-extraction.md §3.2 #4, plugins/studio-seam.ts) and the two seams that come with it: `ui.takeover` (a plugin page in
// the right panel's place) and the approvals a studio frame or web part asks for (any folder, a Detail command). Privileged: the "studio"
// permission, and only a plugin shipped with the app.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { Plugins, type PluginWorld } from "../../src/core/plugins";
import type { HostCommand, HostHandlers } from "../../src/core/plugins/host-client";
import type { StudioWorld } from "../../src/core/plugins/studio-seam";
import { testSealer } from "../../src/core/plugins/secrets";

function plugin(root: string, name: string, permissions: string[], contributes: unknown = undefined) {
  const folder = join(root, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", web: "dist/web.js", permissions, ...(contributes ? { contributes } : {}) } }));
  writeFileSync(join(folder, "dist", "web.js"), "export function activate() {}");
  writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}");
}

const running: Plugins[] = [];
afterEach(async () => { for (const plugins of running.splice(0)) await plugins.shutdown(); });

/** Plugins over a fake host process; `holdLoad`: the host answers `load` only when `release` is called (a host still starting). */
async function setup(dir: string, options: { holdLoad?: boolean } = {}) {
  const calls: any[] = [];
  const picks: ((index: number) => void)[] = [];
  const approved = new Set<string>();
  const studio: StudioWorld = {
    chats: () => [{ id: "main", name: "Main", folder: "/p/main", working: false, components: [], own: [] }],
    chat: (id) => (id === "main" || id === "B1" ? { id, name: id, folder: "/p/" + id, working: false, components: null, own: [] } : null),
    componentBots: () => ["Main", "Site"], maintainer: () => ({ id: "M", working: true }),
    line: (bot, query) => { calls.push(["line", bot, query]); return { record: { id: "L1", role: "bot", text: "hi" }, asked: "ask", previews: null, preview: "hi", turn: ["L1"] }; },
    specs: () => ({ main: [{ id: "S1", name: "n" }] }),
    writeSpecs: (bot, specs) => { calls.push(["writeSpecs", bot, specs]); return true; },
    library: (withInfo) => ({ names: ["a"], entries: { a: { version: 3, command: "ls", detailCommand: null, summary: "A", catalog: "- a: A", ...(withInfo.includes("a") ? { info: null } : {}) } } }),
    working: (name, change) => { calls.push(["working", name, change]); },
    handTo: (text) => { calls.push(["handTo", text]); },
    holder: (name) => (name === "Site" ? { id: "B1", name: "Site", folder: "/p/site", working: false, components: [], own: ["a"] } : null),
    give: (name, bot) => { calls.push(["give", name, bot]); return true; }, unlist: () => false,
    note: (bot, text) => { calls.push(["note", bot, text]); }, notice: (bot, text) => { calls.push(["notice", bot, text]); },
    ask: async () => ({ kind: "reply", text: "ok" } as never),
    commands: {
      isApproved: (command, folder) => approved.has(`${folder}\n${command}`), isDetailApproved: (detail, folder) => detail === null || approved.has(`${folder}\nDetail command: ${detail}`),
      run: async () => {}, state: () => ({ status: "idle", data: null, error: null, ranAt: null }), runOf: () => null, lastRan: () => null,
      approve: (command, folder, detail) => { calls.push(["approve", command, folder, detail]); approved.add(`${folder}\n${command}`); if (detail) approved.add(`${folder}\nDetail command: ${detail}`); },
    },
  };
  const world: PluginWorld = {
    bots: () => [], send: () => ({ messageId: "M" }), interrupt: async () => null, notice: () => {}, ask: () => new Promise(() => {}), openPanel: () => {},
    appSettings: () => ({}), shortcutOverrides: () => ({}), createBot: () => { throw new Error("no"); }, addRoutine: () => "added",
    commandApproval: () => null, approveCommand: () => false, commandRun: () => null, component: () => null, imageUrls: () => null,
    botId: (id) => (id === "main" ? "MAIN-ID" : id.startsWith("B") ? id : null),
    studio,
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
  return { plugins, ask, calls, picks, release: () => held!(), approved };
}



const VIEWS = { views: [{ id: "botling.component-studio.spec", title: "Component spec", where: "rightPanel.takeover" }], menus: { "message/context": [{ command: "botling.component-studio.make", quick: true, icon: "cube", alt: "Add to another bot…", hint: "Maintainer builds it" }], "message/preview": [{ command: "botling.component-studio.make", quick: true, icon: "cube" }] },
  commands: [{ id: "botling.component-studio.make", title: "Make into component" }] };

describe("the studio seam", () => {
  it("answers only a shipped plugin with the \"studio\" permission", async () => {
    const dir = tempDir("studio-seam");
    plugin(join(dir, "builtin"), "botling.component-studio", ["studio"], VIEWS);
    plugin(join(dir, "builtin"), "botling.nostudio", []);
    plugin(join(dir, "plugins"), "library", ["studio"]);
    const { ask, calls } = await setup(dir);
    const me = "botling.component-studio";
    expect(await ask("studio.chats", { plugin: me })).toEqual([expect.objectContaining({ id: "main", folder: "/p/main" })]);
    expect(await ask("studio.componentBots", { plugin: me })).toEqual(["Main", "Site"]);
    expect(await ask("studio.maintainer", { plugin: me })).toEqual({ id: "M", working: true });
    expect(await ask("studio.line", { plugin: me, bot: "main", last: "bot" })).toMatchObject({ asked: "ask", turn: ["L1"] });
    expect(calls.at(-1)).toEqual(["line", "main", { last: "bot" }]);
    await ask("studio.line", { plugin: me, bot: "main", id: "L1" });
    expect(calls.at(-1)).toEqual(["line", "main", { id: "L1" }]);
    expect(await ask("studio.specs", { plugin: me })).toEqual({ main: [{ id: "S1", name: "n" }] });
    expect(await ask("studio.writeSpecs", { plugin: me, bot: "main", specs: [{ id: "S2" }] })).toEqual({ changed: true });
    expect(calls.at(-1)).toEqual(["writeSpecs", "main", [{ id: "S2" }]]);
    expect(await ask("studio.library", { plugin: me, withInfo: ["a"] })).toEqual({ names: ["a"], entries: { a: expect.objectContaining({ version: 3, info: null }) } });
    await ask("studio.working", { plugin: me, name: "a", change: "built from a reply" });
    await ask("studio.handTo", { plugin: me, text: "build it" });
    expect(await ask("studio.holder", { plugin: me, name: "Site" })).toMatchObject({ id: "B1", own: ["a"] });
    expect(await ask("studio.holder", { plugin: me, name: "Nobody" })).toBeNull();
    expect(await ask("studio.give", { plugin: me, name: "a", bot: "B1" })).toBe(true);
    expect(calls.map((call) => call[0])).toEqual(expect.arrayContaining(["working", "handTo", "give"]));
    await expect(ask("studio.writeSpecs", { plugin: me, bot: "ghost", specs: [] })).rejects.toThrow("No such bot");
    await expect(ask("studio.writeSpecs", { plugin: me, bot: "main", specs: "not a list" })).rejects.toThrow("Not a request a plugin can make");
    await expect(ask("studio.chats", { plugin: "library" })).rejects.toThrow("shipped with Botling");
    await expect(ask("studio.chats", { plugin: "botling.nostudio" })).rejects.toThrow("\"studio\" permission");
  });

  it("opens a takeover view for a bot, one at a time, and closes it when asked or when the plugin goes", async () => {
    const dir = tempDir("studio-seam");
    plugin(join(dir, "builtin"), "botling.component-studio", ["studio"], VIEWS);
    const { plugins, ask } = await setup(dir);
    const me = "botling.component-studio";
    expect(plugins.view().takeovers).toEqual([{ plugin: me, id: "botling.component-studio.spec", title: "Component spec" }]);
    expect(plugins.view().takeover).toBeNull();
    await ask("ui.takeover", { plugin: me, view: "botling.component-studio.spec", bot: "B1", wide: true });
    expect(plugins.view().takeover).toEqual({ plugin: me, view: "botling.component-studio.spec", botId: "B1", wide: true });
    await expect(ask("ui.takeover", { plugin: me, view: "nope", bot: "B1" })).rejects.toThrow("no takeover view");
    await expect(ask("ui.takeover", { plugin: me, view: "botling.component-studio.spec", bot: "ghost" })).rejects.toThrow("No such bot");
    await ask("ui.takeover", { plugin: me, view: null });
    expect(plugins.view().takeover).toBeNull();
    await ask("ui.takeover", { plugin: me, view: "botling.component-studio.spec", bot: "main" });
    plugins.setEnabled(me, false);
    expect(plugins.view().takeover).toBeNull();
  });

  it("offers the studio's quick buttons on a reply and on its preview cards, with their icon and words", async () => {
    const dir = tempDir("studio-seam");
    plugin(join(dir, "builtin"), "botling.component-studio", ["studio"], VIEWS);
    const { plugins } = await setup(dir);
    expect(plugins.view().menus).toEqual([
      { menu: "message/context", command: "botling.component-studio.make", plugin: "botling.component-studio", title: "Make into component", icon: "cube", quick: true, alt: "Add to another bot…", hint: "Maintainer builds it" },
      { menu: "message/preview", command: "botling.component-studio.make", plugin: "botling.component-studio", title: "Make into component", icon: "cube", quick: true },
    ]);
  });

  it("asks the user about a command in any folder (and a Detail command) only for the studio, and only from a frame or its web part", async () => {
    const dir = tempDir("studio-seam");
    plugin(join(dir, "builtin"), "botling.component-studio", ["studio"], VIEWS);
    plugin(join(dir, "builtin"), "botling.other", []);
    const { plugins, calls } = await setup(dir);
    const me = "botling.component-studio";
    const asked = plugins.approvalAsk(me, "main", "ls -l", "/elsewhere", "My spec", "cat {x}", "chat");
    expect(asked).toEqual({ needsApproval: { command: "ls -l", folder: "/elsewhere", detail: "cat {x}", card: "My spec" } });
    expect(plugins.approve(me, "main", "ls -l", "/elsewhere", "cat {x}")).toEqual({ accepted: true });
    expect(calls.at(-1)).toEqual(["approve", "ls -l", "/elsewhere", "cat {x}"]);
    expect(plugins.approvalAsk(me, "main", "ls -l", "/elsewhere", "My spec", "cat {x}", "chat")).toEqual({ needsApproval: null });
    expect(() => plugins.approvalAsk(me, "ghost", "ls", "/x")).toThrow("No such bot");
    // Another plugin's web part may not ask from the chat page (one realm), and its frame may only name its bot's own folder.
    expect(() => plugins.approvalAsk("botling.other", "main", "ls", "/x", undefined, undefined, "chat")).toThrow("may not ask for approval in the chat");
    expect(() => plugins.approvalAsk("botling.other", "main", "ls", "/x", undefined, undefined, "frame")).toThrow();
  });
});
