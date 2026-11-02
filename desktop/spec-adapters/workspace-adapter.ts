// spec/driver/workspace-driver.ts against the real code: the plugin host (Web/host/src/host.ts, in this
// process) and the core's Plugins (core/plugins) talking over the host client's line protocol, with the
// lines held here until the model delivers them. The world is a version; its digest is that version.
// What the server does when Plugins says someone listens (watchWorkspace, checkWorkspace) is the two
// lines in `world.workspaceWatch` and `check`, with the real WorkspaceWatch.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceDriver } from "../../spec/driver/workspace-driver";
import type { ToCore, ToHost, WorkspaceView } from "../../spec/reference/workspace";
import { Host, type BotlingApi } from "../../Web/host/src/host";
import { Plugins, type PluginWorld } from "../src/core/plugins";
import type { HostCommand, HostHandlers } from "../src/core/plugins/host-client";
import { WorkspaceWatch, WORKSPACE_EVENT } from "../src/core/workspace";

/** Lets the promise chains the last action started run to their end. */
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

interface PluginSide { api: BotlingApi | null; off: (() => void) | null; known: number | null; reading: boolean; dirty: boolean }

export async function createWorkspaceDriver({ dataDir, plugins: names }: { dataDir: string; plugins: string[] }): Promise<WorkspaceDriver> {
  for (const name of names) {
    const folder = join(dataDir, "plugins", name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { host: "host.mjs" } }));
    writeFileSync(join(folder, "host.mjs"), "export function activate() {}");
  }
  let ver = 0;
  const side: Record<string, PluginSide> = Object.fromEntries(names.map((name) => [name, { api: null, off: null, known: null, reading: false, dirty: false }]));
  // Lines on their way: host -> core and core -> host.
  const toCore: string[] = [];
  const toHost: string[] = [];
  const readFor = new Map<number, string>();
  const watch = new WorkspaceWatch("e");
  const digest = () => ({ main: { bots: String(ver) } });
  let plugins!: Plugins;

  const host = new Host((message) => toCore.push(JSON.stringify(message)), async (spec) => (api: BotlingApi) => { side[spec.name]!.api = api; });
  let handlers!: HostHandlers;
  const node: HostCommand = {
    command: "",
    launch: (_script, _cwd, _env, given) => {
      handlers = given;
      toCore.push(JSON.stringify({ method: "ready", params: {} }));
      return { pid: 4343, write: (line) => { toHost.push(line.trim()); }, terminate: async () => {} };
    },
  };
  const world: PluginWorld = {
    bots: () => [], send: () => { throw new Error("not here"); }, interrupt: async () => null, notice: () => {},
    ask: () => new Promise(() => {}), openPanel: () => {}, appSettings: () => ({}), shortcutOverrides: () => ({}),
    createBot: () => { throw new Error("not here"); }, addRoutine: () => "no-bot", changed: () => {}, broken: () => {}, log: () => {},
    commandApproval: () => null, approveCommand: () => false,
    workspace: {
      bots: () => [{ id: "main", name: String(ver), role: "main", parent: null, folder: "Main", engine: "claude", busy: false, asleep: false, avatar: "circle", pinned: false }],
      memory: () => { throw new Error("not here"); }, tasks: () => [], taskHistory: () => [], results: () => [], waiting: () => ({ items: [], doing: {} }),
      ignoreWaiting: () => {}, pendingApprovals: () => [], face: () => "",
    },
    // server.ts watchWorkspace.
    workspaceWatch: (on) => { if (on) watch.start(digest()); else watch.stop(); },
  };
  plugins = new Plugins({ dataDir, world, node, hostScript: "host.mjs", sealer: null });

  const coreRecv = async () => { const line = toCore.shift(); if (line === undefined) throw new Error("no line for the core"); handlers.data(line + "\n"); await flush(); };
  const hostRecv = async () => { const line = toHost.shift(); if (line === undefined) throw new Error("no line for the host"); await host.receive(JSON.parse(line)); await flush(); };
  // Start up: the host loads both plugins (nobody listens yet), every line delivered.
  await plugins.start();
  for (let rounds = 0; rounds < 100 && (toCore.length || toHost.length || !plugins.host.running); rounds++) {
    if (toCore.length) await coreRecv();
    else if (toHost.length) await hostRecv();
    else await flush();
  }
  if (!plugins.host.running || names.some((name) => !side[name]!.api)) throw new Error("the plugins did not load");

  const read = (name: string) => {
    const plugin = side[name]!;
    plugin.reading = true;
    plugin.dirty = false;
    void plugin.api!.workspace.bots().then((bots) => { plugin.known = Number(bots[0]!.name); plugin.reading = false; });
  };
  const abstractToCore = (line: string): ToCore => {
    const message = JSON.parse(line);
    if (message.method === "registered") return { m: "reg", on: (message.params.events as string[]).includes(WORKSPACE_EVENT) };
    if (message.method === "workspace.bots") { readFor.set(message.id, message.params.plugin); return { m: "read", p: message.params.plugin }; }
    throw new Error(`an unexpected line for the core: ${line.slice(0, 200)}`);
  };
  const abstractToHost = (line: string): ToHost => {
    const message = JSON.parse(line);
    if (message.method === "event" && message.params.name === WORKSPACE_EVENT) return { m: "change" };
    const p = readFor.get(message.id);
    if (p && message.method === undefined) return { m: "answer", p, v: Number(message.result[0].name) };
    throw new Error(`an unexpected line for the host: ${line.slice(0, 200)}`);
  };

  return {
    plugins: names,
    change: async () => { ver++; },
    listen: async (name) => {
      const plugin = side[name]!;
      plugin.off = plugin.api!.workspace.onChange(() => { plugin.dirty = true; });
      read(name);
      await flush();
    },
    unlisten: async (name) => {
      const plugin = side[name]!;
      plugin.off!();
      plugin.off = null;
      plugin.dirty = false;
      await flush();
    },
    read: async (name) => { read(name); await flush(); },
    hostRecv,
    coreRecv,
    // server.ts checkWorkspace.
    check: async () => { const change = watch.check(digest()); if (change) plugins.workspaceChanged(change); await flush(); },
    view: (): WorkspaceView => ({
      ver,
      plugins: Object.fromEntries(names.map((name) => [name, { sub: side[name]!.off !== null, known: side[name]!.known, reading: side[name]!.reading, dirty: side[name]!.dirty }])),
      toCore: toCore.map(abstractToCore), toHost: toHost.map(abstractToHost),
      watching: plugins.watchingWorkspace, told: Number(watch.stamp.split(":")[1]),
    }),
    close: async () => { await host.receive({ id: 1, method: "shutdown" }).catch(() => {}); plugins.host.stop(); },
  };
}
