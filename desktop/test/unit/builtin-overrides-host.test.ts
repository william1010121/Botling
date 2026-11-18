// A built-in plugin pushed into the running app reaches every part of it with no restart (overrides.ts): the plugin host is told to
// load the new program part (the same `load` a library plugin's edit causes), the chat page is handed the new web part, the plugin
// list moves its version, and the next scan after a stale build drops the push. Over a fake host process, as plugin-frame-events.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { Plugins, type PluginWorld } from "../../src/core/plugins";
import type { HostCommand, HostHandlers } from "../../src/core/plugins/host-client";
import { testSealer } from "../../src/core/plugins/secrets";
import { placeOverride } from "../../scripts/push-builtin-plugin.mjs";

function plugin(root: string, name: string, version: string, marker: string) {
  const folder = join(root, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version, engines: { ccb: "^2.0.0" }, ccb: { web: "dist/web.js", host: "dist/host.mjs" } }));
  writeFileSync(join(folder, "dist", "web.js"), `export function activate() {} // ${marker}`);
  writeFileSync(join(folder, "dist", "host.mjs"), `export function activate() {} // ${marker}`);
  return folder;
}

const running: Plugins[] = [];
afterEach(async () => { for (const plugins of running.splice(0)) await plugins.shutdown(); });

async function setup(developerMode: (() => boolean) | null = () => true) {
  const dir = tempDir("builtin-overrides-host");
  const shipped = join(dir, "builtin");
  plugin(shipped, "botling.catchup", "1.2.0", "shipped");
  const logs: string[] = [];
  const sent: { method?: string; id?: number; params?: { plugins?: { name: string; main: string; version: string; fingerprint: string }[] } }[] = [];
  const world = {
    bots: () => [], send: () => ({ messageId: "M" }), interrupt: async () => null, notice: () => {}, ask: () => new Promise(() => {}), openPanel: () => {},
    appSettings: () => ({}), shortcutOverrides: () => ({}), createBot: () => { throw new Error("no"); }, addRoutine: () => "added",
    commandApproval: () => null, approveCommand: () => false, commandRun: () => null, component: () => null, imageUrls: () => null,
    botId: () => null, changed: () => {}, broken: () => {}, log: (line: string) => { logs.push(line); },
    workspace: { bots: () => [], memory: () => { throw new Error("no"); }, tasks: () => [], taskHistory: () => [], results: () => [], waiting: () => ({ items: [], doing: {} }), ignoreWaiting: () => {}, pendingApprovals: () => [], face: () => "" },
    workspaceWatch: () => {},
  } as unknown as PluginWorld;
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
          if (message.method === "load") line({ id: message.id, result: { loaded: message.params.plugins.map((spec: { name: string }) => spec.name), failed: [] } });
          if (message.method === "shutdown") line({ id: message.id, result: null });
        },
        terminate: async () => {},
      };
    },
  };
  const plugins = new Plugins({ dataDir: dir, world, node, hostScript: "host.mjs", sealer: testSealer("test-key"), builtIns: join(dir, "builtin"), ...(developerMode ? { developerMode } : {}) });
  running.push(plugins);
  await plugins.start();
  await until(() => plugins.host.running);
  const loads = () => sent.filter((message) => message.method === "load");
  const push = (version: string, marker: string, now = Date.now() + 2_000) => {
    const built = plugin(join(dir, `built-${marker}`), "botling.catchup", version, marker);
    return placeOverride({ built, name: "botling.catchup", root: join(dir, "builtin-overrides"), now });
  };
  return { dir, shipped, plugins, loads, logs, push };
}

describe("a pushed built-in plugin in the running app", () => {
  it("the plugin host is told to load the new program part, from the pushed folder, and the chat page gets the new web part", async () => {
    const { dir, plugins, loads, push } = await setup();
    expect(loads()).toHaveLength(1);
    expect(loads()[0]!.params!.plugins![0]!.main).toBe(join(dir, "builtin", "botling.catchup", "dist", "host.mjs"));
    const made = push("1.2.0", "pushed");
    plugins.scan();
    await until(() => loads().length === 2);
    const spec = loads()[1]!.params!.plugins![0]!;
    expect(spec.name).toBe("botling.catchup");
    expect(spec.main).toBe(join(dir, "builtin-overrides", made.dir, "dist", "host.mjs"));
    expect(spec.version).toMatch(/^1\.2\.0\+push\.[0-9a-f]{8}$/);
    const web = plugins.webSpecs().find((entry) => entry.name === "botling.catchup")!;
    expect(web.source).toContain("pushed");
    expect(web.builtIn).toBe(true);
    // the plugin list says what runs: the pushed version, still built in
    const row = plugins.view().plugins.find((entry) => entry.name === "botling.catchup")!;
    expect(row.version).toMatch(/\+push\./);
    expect(row.builtIn).toBe(true);
  });

  it("a plugin that is not pushed is left alone: a push of one plugin does not reload the host for the others", async () => {
    const { dir, shipped, plugins, loads, push } = await setup();
    plugin(shipped, "botling.other", "1.0.0", "other");
    plugins.scan();
    await until(() => loads().length === 2);
    const before = loads().length;
    push("1.2.0", "pushed");
    plugins.scan();
    await until(() => loads().length === before + 1);
    const names = loads()[before]!.params!.plugins!.map((spec) => spec.name).sort();
    expect(names).toEqual(["botling.catchup", "botling.other"]);
    const other = loads()[before]!.params!.plugins!.find((spec) => spec.name === "botling.other")!;
    const otherBefore = loads()[before - 1]!.params!.plugins!.find((spec) => spec.name === "botling.other")!;
    expect(other.fingerprint).toBe(otherBefore.fingerprint);
    expect(other.main).toBe(join(dir, "builtin", "botling.other", "dist", "host.mjs"));
  });

  it("a stale push (made for an older build of the app) is dropped at the next scan: the shipped copy loads again and the log says so", async () => {
    const { dir, plugins, loads, logs, push } = await setup();
    push("1.2.0", "stale", Date.now() - 60_000);
    plugins.scan();
    // the stale stamp was refused at once: nothing but the shipped copy was ever loaded
    expect(loads().every((load) => !load.params!.plugins![0]!.main.startsWith(join(dir, "builtin-overrides")))).toBe(true);
    expect(existsSync(join(dir, "builtin-overrides", "botling.catchup.push.json"))).toBe(false);
    expect(readdirSync(join(dir, "builtin-overrides")).filter((entry) => entry.startsWith("botling.catchup@"))).toEqual([]);
    expect(logs.some((text) => text.includes("older than this build"))).toBe(true);
  });

  it("developer mode off: the push is never loaded, and turning it on later swaps the plugin in once", async () => {
    let on = false;
    const { dir, plugins, loads, logs, push } = await setup(() => on);
    push("1.2.0", "pushed");
    plugins.scan();
    plugins.scan();
    expect(loads()).toHaveLength(1);
    expect(logs.filter((text) => text.includes("developer mode is off"))).toHaveLength(1);
    on = true;
    plugins.scan();
    await until(() => loads().length === 2);
    expect(loads()[1]!.params!.plugins![0]!.main.startsWith(join(dir, "builtin-overrides"))).toBe(true);
    plugins.scan();
    expect(loads()).toHaveLength(2);
  });

  it("a core that gives no developer mode runs no pushed copy at all", async () => {
    const { plugins, loads, push } = await setup(null);
    push("1.2.0", "pushed");
    plugins.scan();
    expect(loads()).toHaveLength(1);
    expect(plugins.view().plugins.find((entry) => entry.name === "botling.catchup")!.version).toBe("1.2.0");
  });
});
