// @vitest-environment node
// Golden records of the 2.x plugin platform (kernel step 1, brief §4 step 1), recorded before the plugin kernel went under
// it and byte-identical at every later step: the contribution list (contributions.ts, registry.ts), viewSurfaces (views.ts),
// the plugins.list / plugins.web / plugins.panel answers (core/plugins/index.ts), and the plugin host's announce payloads
// and answers (Web/host/src/host.ts, api.ts), for the built-in plugins and two third-party fixtures (test/kernel-goldens.ts).
// The frame broker's replies (frame-broker.ts) are in plugin-kernel-goldens-broker.test.ts. See test/kernel-goldens.ts for
// how a golden is changed on purpose.
import { beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir } from "../helpers";
import { golden, normalized, writeFixturePlugins } from "../kernel-goldens";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore, testSealer } from "../../src/core/plugins/secrets";
import { viewSurfaces } from "../../src/core/plugins/views";
import { Plugins, type PluginWorld } from "../../src/core/plugins";
import { Host, type BotlingApi, type HostPluginSpec } from "../../../Web/host/src/host";

let built = "";
beforeAll(async () => {
  const { buildBuiltinPlugins } = await import(join(desktop, "build-builtin-plugins.mjs"));
  built = realpathSync(await buildBuiltinPlugins({ outdir: join(tempDir("kernel-goldens-build"), "builtin-plugins") }));
}, 60_000);

/** A data folder with the two fixtures in its library. */
function dataDir(): string {
  const dir = realpathSync(tempDir("kernel-goldens"));
  writeFixturePlugins(join(dir, "plugins"));
  return dir;
}

const paths = (dir: string) => ({ [dir]: "<tmp>", [built]: "<builtins>" });

/** Asserts a golden: the same bytes as recorded. */
function same(name: string, value: unknown) {
  const [expected, actual] = golden(name, value);
  expect(actual, `golden ${name}.json`).toBe(expected);
}

describe("the contribution list and viewSurfaces (registry.ts, contributions.ts, views.ts)", () => {
  it("for the built-in plugins and the two fixtures, then with one of each turned off", () => {
    const dir = dataDir();
    const registry = new PluginRegistry(join(dir, "plugins"), join(dir, "plugins.json"), new MemorySecretStore(), built);
    expect(registry.problems).toEqual({});
    const drawn = (name: string) => !!registry.webPart(name);
    const marked = (plugin: string, view: string) => (plugin === "zed.tools" && view === "zed.tools.tab" ? ["B1", "B2"] : []);
    same("registry-plugins", normalized(registry.plugins.map((plugin) => ({ name: plugin.manifest.name, builtIn: plugin.builtIn, enabled: plugin.enabled, folder: plugin.folder, skipped: plugin.skipped ?? [] })), paths(dir)));
    same("contributions", normalized(registry.effectiveContributions(), paths(dir)));
    same("view-surfaces", viewSurfaces(registry.effectiveContributions(), drawn, marked));
    registry.setCommandKey("zed.tools", "zed.tools.run", "cmd+alt+z");
    registry.setCommandKey("zed.tools", "zed.tools.clip", null);
    same("contributions-with-keys", normalized(registry.effectiveContributions(), paths(dir)));
    registry.setEnabled("zed.tools", false);
    registry.setEnabled("botling.note", false);
    same("contributions-after-disable", normalized(registry.effectiveContributions(), paths(dir)));
    same("view-surfaces-after-disable", viewSurfaces(registry.effectiveContributions(), drawn, marked));
    registry.setEnabled("zed.tools", true);
    registry.setEnabled("botling.note", true);
    expect(normalized(registry.effectiveContributions(), paths(dir))).toEqual(JSON.parse(readFileSync(join(desktop, "test", "fixtures", "kernel-goldens", "contributions-with-keys.json"), "utf8")));
  });
});

/** A world with nothing in it: the goldens read only what the library and the registry give. */
function quietWorld(): PluginWorld {
  return {
    bots: () => [], send: () => ({ messageId: "M1" }), interrupt: async () => null, notice: () => {}, ask: () => new Promise(() => {}),
    openPanel: () => {}, appSettings: () => ({ language: "en", botLook: "cute", workerLimit: 4 }), shortcutOverrides: () => ({}),
    commandApproval: () => null, approveCommand: () => false, commandRun: () => null, component: () => null, imageUrls: () => null,
    createBot: () => { throw new Error("not here"); }, addRoutine: () => "no-bot", changed: () => {}, broken: () => {}, log: () => {},
    workspace: {
      bots: () => [], memory: () => ({ currentStatus: [], inProgress: [], decided: [], waitingOnYou: [] }), tasks: () => [], taskHistory: () => [], results: () => [],
      waiting: () => ({ items: [], doing: {} }), ignoreWaiting: () => {}, pendingApprovals: () => [], face: () => "", current: () => null,
    },
    workspaceWatch: () => {},
  } as PluginWorld;
}

describe("plugins.list, plugins.web and plugins.panel (core/plugins/index.ts)", () => {
  it("answer as recorded", async () => {
    const dir = dataDir();
    const plugins = new Plugins({ dataDir: dir, world: quietWorld(), node: null, hostScript: "host.mjs", builtIns: built, sealer: testSealer("golden-key") });
    try {
      same("plugins-list", normalized(plugins.view(), paths(dir)));
      const specs = plugins.webSpecs();
      for (const spec of specs) {
        const folder = plugins.registry.plugin(spec.name)!.folder;
        expect(spec.source, spec.name).toBe(readFileSync(join(folder, plugins.registry.plugin(spec.name)!.manifest.ccb!.web!), "utf8"));
      }
      same("plugins-web", normalized(specs.map((spec) => ({ ...spec, source: `<source of ${spec.name}>` })), paths(dir)));
      const asked: unknown[] = [];
      const view = plugins.view();
      const surfaces = Object.values(view).flatMap((value): unknown[] => (Array.isArray(value) ? value : []));
      const ids: string[][] = [
        ...view.plugins.flatMap((plugin) => plugin.panels.map((panel) => [plugin.name, panel.id])),
        ...surfaces.flatMap((entry) => (entry && typeof entry === "object" && "plugin" in entry && "id" in entry && "title" in entry ? [[String(entry.plugin), String(entry.id)]] : [])),
        ["zed.tools", "zed.tools.side"], ["zed.tools", "zed.tools.main"], ["zed.tools", "zed.tools.window"], ["zed.tools", "zed.tools.nowhere"], ["nobody", "x"],
      ];
      for (const [name, id] of ids) {
        try {
          const answer = plugins.panel(name!, id!);
          asked.push({ name, id, title: answer.title, source: `<source of ${name}>`, settings: answer.settings });
        } catch (error) {
          asked.push({ name, id, error: (error as Error).message });
        }
      }
      same("plugins-panel", asked);
    } finally {
      await plugins.shutdown();
    }
  });
});

describe("the plugin host's announce payloads and answers (Web/host/src/host.ts, api.ts)", () => {
  const scratch = realpathSync(tempDir("kernel-goldens-host"));
  const spec = (name: string, overrides: Partial<HostPluginSpec> = {}): HostPluginSpec =>
    ({ name, version: "1.0.0", main: join(scratch, name, "host.mjs"), fingerprint: "1", settings: {}, storageDir: join(scratch, "data", name), ...overrides });

  /** Everything the host wrote, with load timings reduced to the plugins they name (milliseconds vary). */
  const record = (written: any[]) => normalized(written.map((message) => (message.result && typeof message.result === "object" && "timings" in message.result
    ? { ...message, result: { ...message.result, timings: Object.keys(message.result.timings) } } : message)), { [scratch]: "<tmp>" });

  it("a scripted load, calls, reload, unload and shutdown", async () => {
    const written: any[] = [];
    const disposed: string[] = [];
    const plugins: Record<string, (api: BotlingApi) => unknown> = {
      // Like acme-board: commands, an exposed method, hooks, a setting handler, and a dispose it returns.
      "acme-board": (api) => {
        api.commands.register("acme-board.open", () => "opened");
        api.commands.register("acme-board.refresh", () => null);
        api.ui.expose("columns", () => api.settings.get("acme-board.columns"));
        api.hooks.beforeSend((message) => `${message.text} [acme]`);
        api.settings.onChange("acme-board.columns", (value) => disposed.push(`columns=${String(value)}`));
        api.events.on("noteChanged", () => disposed.push("acme heard noteChanged"));
        return () => disposed.push("acme-board");
      },
      // Like zed.tools: an old web.handle, both hooks, reply listeners and tags, workspace changes, and an async activate.
      "zed.tools": async (api) => {
        api.web.handle("search", (params) => ({ found: params }));
        api.hooks.afterReply((message) => ({ ...message, text: message.text.toUpperCase() }));
        api.hooks.beforeSend((message) => (message.text.includes("stop") ? false : undefined));
        api.bots.onReply(() => disposed.push("zed heard a reply"));
        api.replyTags.on("zed-status", (tag) => disposed.push(`zed tag ${tag.body}`));
        await Promise.resolve();
        api.workspace.onChange(() => disposed.push("zed heard the workspace"));
        api.events.on("turnFinished", () => disposed.push("zed heard turnFinished"));
        api.subscriptions.push(() => disposed.push("zed subscription"));
      },
      broken: () => { throw new Error("will not load"); },
    };
    const host = new Host((message) => written.push(message), async (given) => plugins[given.name] as never);
    let id = 1;
    const ask = async (method: string, params: unknown) => { await host.receive({ id: id++, method, params }); await Promise.resolve(); await Promise.resolve(); };
    for (const name of Object.keys(plugins)) mkdirSync(join(scratch, name), { recursive: true });

    await ask("load", { plugins: [spec("acme-board", { settings: { "acme-board.columns": 3 } }), spec("zed.tools"), spec("broken")] });
    await ask("ping", {});
    await ask("beforeSend", { bot: { id: "b" }, text: "hi" });
    await ask("beforeSend", { bot: { id: "b" }, text: "please stop" });
    await ask("afterReply", { bot: { id: "b" }, text: "done" });
    await ask("command", { id: "acme-board.open", args: [] });
    await ask("command", { id: "nobody.cmd", args: [] });
    await ask("web", { plugin: "acme-board", method: "columns", params: null, from: "frame" });
    await ask("web", { plugin: "zed.tools", method: "search", params: "q", from: "chat" });
    await ask("web", { plugin: "zed.tools", method: "hidden", params: null, from: "frame" });
    await ask("event", { name: "noteChanged", data: { botId: "b" } });
    await ask("event", { name: "workspace.changed", data: {} });
    await ask("reply", { bot: { id: "b" }, text: "a reply" });
    await ask("replyTag", { plugin: "zed.tools", bot: "b", tag: "zed-status", attributes: {}, body: "green" });
    // New settings for the same code: told, not reloaded.
    await ask("load", { plugins: [spec("acme-board", { settings: { "acme-board.columns": 4 } }), spec("zed.tools")] });
    // New code for zed.tools: reloaded; acme-board unloaded.
    await ask("load", { plugins: [spec("zed.tools", { fingerprint: "2" })] });
    await ask("command", { id: "acme-board.open", args: [] });
    await ask("shutdown", {});
    await Promise.resolve();
    same("host-session", { written: record(written), disposed });
  });
});
