// spec/driver/folders-driver.ts against the real code: the core's Plugins (core/plugins/index.ts) with its
// SessionFolders (session-folders.ts) and registry, over a stand-in host process whose lines are the built-in
// plugin's `sessions.folder` / `sessions.folders` requests, held here until the model delivers them. A crash is
// what the host client reports when the host dies with the plugin (onPluginFailure); a failed write of
// plugin-session-folders.json is a data folder that cannot be written for that one delivery.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { FoldersDriver } from "../../spec/driver/folders-driver";
import { P, type FolderMsg, type FoldersView, type PState, type Place } from "../../spec/reference/folders";
import { Plugins, type PluginWorld } from "../src/core/plugins";
import type { HostCommand, HostHandlers } from "../src/core/plugins/host-client";
import type { SessionFolder, SessionFolders } from "../src/core/plugins/session-folders";

const NAME = "botling.folders";
const BOT = "B1";

/** Lets the promise chains the last action started run to their end. */
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

const folderOf = (f: Place): SessionFolder | null => (f === P ? null : { cwd: `/w/${f}`, addDirs: [], note: "" });
const placeOf = (folder: { cwd: string } | null | undefined): Place => (folder ? basename(folder.cwd) : P);

export async function createFoldersDriver({ dataDir }: { dataDir: string }): Promise<FoldersDriver> {
  const folder = join(dataDir, "builtin", NAME);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: NAME, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", permissions: ["sessions"] } }));
  writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}");

  let moves = 0;
  /** The host's side of the plugin (the registry has off and failed). */
  let hostState: "loading" | "running" | "crashed" = "loading";
  /** The user turned it off (plugins.json). */
  let off = false;
  /** The plugin's lines on their way to the core, with what the model calls them. */
  let chan: { line: string; msg: FolderMsg }[] = [];
  let nextId = 9000;
  let handlers!: HostHandlers;
  const world: PluginWorld = {
    bots: () => [], send: () => ({ messageId: "M" }), interrupt: async () => null, notice: () => {}, ask: () => new Promise(() => {}), openPanel: () => {},
    appSettings: () => ({}), shortcutOverrides: () => ({}), createBot: () => { throw new Error("not here"); }, addRoutine: () => "no-bot",
    commandApproval: () => null, approveCommand: () => false, commandRun: () => null, component: () => null, imageUrls: () => null,
    botId: (id) => (id === BOT ? BOT : null),
    // server.ts: the bot restarts before its next message (bot.ts folderMoved, tested in folder-move-restart.test.ts).
    sessionMoved: () => { moves++; },
    sessionBots: () => [],
    changed: () => {}, broken: () => {}, log: () => {},
    workspace: { bots: () => [], memory: () => { throw new Error("not here"); }, tasks: () => [], taskHistory: () => [], results: () => [], waiting: () => ({ items: [], doing: {} }), ignoreWaiting: () => {}, pendingApprovals: () => [], face: () => "" },
    workspaceWatch: () => {},
  };
  const node: HostCommand = {
    command: "",
    launch: (_script, _cwd, _env, given) => {
      handlers = given;
      queueMicrotask(() => handlers.data(JSON.stringify({ method: "ready", params: {} }) + "\n"));
      return {
        pid: 4545,
        write: (text) => {
          const message = JSON.parse(text);
          if (message.method === "load") queueMicrotask(() => handlers.data(JSON.stringify({ id: message.id, result: { loaded: message.params.plugins.map((spec: { name: string }) => spec.name), failed: [] } }) + "\n"));
          if (message.method === "shutdown") queueMicrotask(() => handlers.data(JSON.stringify({ id: message.id, result: null }) + "\n"));
        },
        terminate: async () => {},
      };
    },
  };
  const open = async () => {
    const plugins = new Plugins({ dataDir, world, node, hostScript: "host.mjs", sealer: null, builtIns: join(dataDir, "builtin") });
    await plugins.start();
    await flush();
    return plugins;
  };
  let plugins = await open();
  const send = (method: string, params: unknown, msg: FolderMsg) => { chan.push({ line: JSON.stringify({ id: nextId++, method, params }), msg }); };
  const cache = (): Place => placeOf((plugins as unknown as { folders: SessionFolders }).folders.get(NAME, BOT));
  const disk = (): Place => {
    const file = join(dataDir, "plugin-session-folders.json");
    return existsSync(file) ? placeOf(JSON.parse(readFileSync(file, "utf8"))[NAME]?.[BOT]) : P;
  };
  const pstate = (): PState => (off ? "disabled" : plugins.registry.plugin(NAME)?.failure ? "failed" : hostState);
  let truth: Place = P;

  return {
    use: async (f) => { truth = f; send("sessions.folder", { plugin: NAME, bot: BOT, folder: folderOf(f) }, { m: "set", f }); },
    load: async () => {
      hostState = "running";
      send("sessions.folders", { plugin: NAME, folders: truth === P ? {} : { [BOT]: folderOf(truth) } }, { m: "sync", f: truth });
    },
    crash: async (keep) => {
      chan = chan.slice(0, keep);
      hostState = "crashed";
      plugins.host.onPluginFailure(NAME, "The plugin host crashed while running it (spec)", false);
      await flush();
    },
    hostRestart: async () => { hostState = "loading"; },
    disable: async () => { off = true; plugins.setEnabled(NAME, false); await flush(); },
    enable: async () => { off = false; hostState = "loading"; plugins.setEnabled(NAME, true); await flush(); },
    coreRecv: async (dup, saved) => {
      const next = chan[0];
      if (!next) throw new Error("no line for the core");
      if (!dup) chan.shift();
      if (!saved) chmodSync(dataDir, 0o500);
      try { handlers.data(next.line + "\n"); await flush(); } finally { if (!saved) chmodSync(dataDir, 0o700); }
    },
    appRestart: async () => {
      await plugins.shutdown();
      chan = [];
      hostState = "loading";
      plugins = await open();
    },
    view: (): FoldersView => {
      const state = pstate();
      const resolved = placeOf(plugins.sessionFolder(BOT));
      return { pstate: state, chan: chan.map((entry) => entry.msg), cache: cache(), disk: disk(), resolved, moves };
    },
    close: async () => { await plugins.shutdown(); },
  };
}
