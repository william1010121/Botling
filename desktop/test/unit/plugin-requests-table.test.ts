// M7-S74: a table test over every plugin request. It pins `Plugins.requested` (the switch that answers what a plugin's host asks of the
// core) before M7-S75 moves it: one accepted and one refused call for every `case`, the reply of the accepted one as a golden and the
// words of the refusal. The list of `case` labels is read from the source itself, so a case added, removed or renamed without a row
// here fails the first test below. `requested` is called directly (the wire in front of it, one JSON line each way, is covered in
// plugin-api.test.ts and the rest of the plugin-* tests); the owner argument of a separate host is part of its first lines and is pinned
// too. The world is a fake that records what it was asked.
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { Plugins, type PluginWorld } from "../../src/core/plugins";
import type { HostCommand, HostHandlers } from "../../src/core/plugins/host-client";
import { testSealer } from "../../src/core/plugins/secrets";
import { StudioParams, type StudioWorld } from "../../src/core/plugins/studio-seam";
import { conversation, generation, usage } from "./agy-db-fixture";

// ---------------------------------------------------------------------------------------------
// The case labels of the switch, from the source (index.ts today, requests.ts after M7-S75).

function caseLabels(): string[] {
  const root = join(__dirname, "../../src/core/plugins");
  const start = /\b(?:async\s+)?requested\(\s*(?:this[^,]*,\s*)?method\s*:/;
  for (const file of ["requests.ts", "index.ts"]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const at = text.search(start);
    if (at < 0) continue;
    // `requested` is the last member of its file: everything after its signature is its body.
    return [...new Set([...text.slice(at).matchAll(/case "([a-z]+\.[A-Za-z]+)":/g)].map((match) => match[1]!))].sort();
  }
  throw new Error("The `requested` switch was not found in plugins/requests.ts or plugins/index.ts.");
}

// ---------------------------------------------------------------------------------------------
// The plugins and the world

/** `root` is the folder holding the plugin: `<dir>/builtin` for one shipped with Botling, `<dir>/plugins` for a library plugin. */
function plugin(root: string, name: string, permissions: string[], extra: { web?: boolean; contributes?: unknown; owns?: string[] } = {}) {
  const folder = join(root, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({
    name, displayName: name === "botling.all" ? "All" : `${name[0]!.toUpperCase()}${name.slice(1)}`, version: "1.0.0", engines: { ccb: "^2.0.0" },
    ccb: { host: "dist/host.mjs", ...(extra.web ? { web: "dist/web.js" } : {}), permissions, ...(extra.owns ? { owns: extra.owns } : {}), ...(extra.contributes ? { contributes: extra.contributes } : {}) },
  }));
  writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}");
  if (extra.web) writeFileSync(join(folder, "dist", "web.js"), "export function activate() {}");
}

/** A shipped plugin with every permission and every contribution a request can name. */
const A = "botling.all";
/** A library plugin with no permission and no web part. */
const L = "lib";
/** A library plugin with every permission: what a request meant for shipped plugins only is refused for. */
const F = "libfull";
const ALL_PERMISSIONS = ["bots", "exec", "files", "routines", "sessions", "app", "cards", "messages", "studio"];
const CONTRIBUTES = {
  panels: [{ id: "botling.all.panel", title: "The panel" }],
  views: [
    { id: "botling.all.tab", title: "Tab", where: "mainTab", forRole: "marked" },
    { id: "botling.all.any", title: "Any", where: "mainTab" },
    { id: "botling.all.take", title: "Take", where: "rightPanel.takeover" },
  ],
  commands: [{ id: "botling.all.go", title: "Go" }, { id: "botling.all.other", title: "Other" }],
  settings: { "botling.all.n": { type: "number", title: "N", default: 1 }, "botling.all.token": { type: "string", title: "Token", secret: true } },
};

const known = (botId: string) => { if (botId !== "main") throw new Error("No such bot."); };
const HASH = `sha256:${"ab".repeat(32)}`;
const REF = { owner: "srvaaaaaaaaaaaaaaaaaaaaaaa", id: HASH, entry: { stream: "bot:b1", seq: 1 } };
const BOT = { id: "main", name: "Main bot", role: "main" as const, awake: true };
const INSTALL = (dir: string) => ["/usr/bin/nohup", "/bin/bash", join(dir, "core", "self-update", "install.sh"), "4242", "/Applications/Botling.app", "/dist/Botling.app", "/b.app", "/h", "/r", "90", "/data", "/Applications/Botling.app"];
const CARD_TEXT = '<show name="clock" command="date"></show>';
const CARD_KEY = `note/${createHash("sha256").update("clock\ndate").digest("hex").slice(0, 16)}-1`;
const COMMAND_STATE = { folder: "/home/main", approved: true, status: "idle", data: null, error: null, ranAt: null };

interface Env {
  dir: string;
  plugins: Plugins;
  world: PluginWorld;
  /** What the fake world was asked, in order: [name, ...arguments]. */
  calls: unknown[][];
  /** The answers the next `world.ask` gives, in order. */
  answers: unknown[];
  note: string;
  ask: (method: string, params: unknown, owner?: string) => Promise<unknown>;
}

const running: Plugins[] = [];
afterEach(async () => { for (const plugins of running.splice(0)) await plugins.shutdown(); });

async function setup(): Promise<Env> {
  const dir = tempDir("plugin-requests-table");
  plugin(join(dir, "builtin"), A, ALL_PERMISSIONS, { web: true, contributes: CONTRIBUTES, owns: ["note"] });
  plugin(join(dir, "builtin"), "botling.bare", []);
  plugin(join(dir, "plugins"), L, []);
  plugin(join(dir, "plugins"), F, ALL_PERMISSIONS, { web: true });
  const calls: unknown[][] = [];
  const answers: unknown[] = [];
  const note = join(dir, "project", ".bot", "note.md");
  const studio: StudioWorld = {
    chats: () => [{ id: "main", name: "Main", folder: "/p/main", working: false, components: [], own: [] }],
    chat: (id) => (id === "main" || id === "B1" ? { id, name: id, folder: `/p/${id}`, working: false, components: null, own: [] } : null),
    componentBots: () => ["Main", "Site"],
    maintainer: () => ({ id: "M", working: true }),
    line: (bot, query) => { calls.push(["studio.line", bot, query]); return { record: { id: "L1", role: "bot" }, asked: "ask", previews: null, preview: "hi", turn: ["L1"] }; },
    specs: () => ({ main: [{ id: "S1" }] }),
    writeSpecs: (bot, specs) => { calls.push(["studio.writeSpecs", bot, specs]); return true; },
    library: (withInfo) => ({ names: ["a"], entries: { a: { version: 3, command: "ls", detailCommand: null, summary: "A", catalog: "- a: A", ...(withInfo.includes("a") ? { info: null } : {}) } } }),
    working: (name, change) => { calls.push(["studio.working", name, change]); },
    handTo: (text) => { calls.push(["studio.handTo", text]); },
    holder: (name) => (name === "Site" ? { id: "B1", name: "Site", folder: "/p/B1", working: false, components: [], own: ["a"] } : null),
    give: (name, bot) => { calls.push(["studio.give", name, bot]); return true; },
    unlist: (name, bot) => { calls.push(["studio.unlist", name, bot]); return false; },
    note: (bot, text) => { calls.push(["studio.note", bot, text]); },
    notice: (bot, text) => { calls.push(["studio.notice", bot, text]); },
    ask: async (bot, text, waitMs, answerMs) => { calls.push(["studio.ask", bot, text, waitMs, answerMs]); return { kind: "reply", text: "ok" } as never; },
    lineExtras: () => ({}),
    commands: {
      isApproved: (command, folder) => command === "ls" && folder === "/p/main",
      isDetailApproved: (detail) => detail === null,
      run: async (card, command, folder, force) => { calls.push(["studio.run", card, command, folder, force]); },
      state: () => ({ status: "idle", data: null, error: null, ranAt: null }),
      runOf: () => null,
      lastRan: () => 7,
      approve: () => {},
    },
  };
  const world: PluginWorld = {
    bots: () => [BOT],
    send: (botId, text, via) => { known(botId); calls.push(["send", botId, text, via]); return { messageId: `M${calls.length}` }; },
    interrupt: async (botId) => { if (botId !== "main") return null; calls.push(["interrupt", botId]); return true; },
    notice: () => {},
    ask: (question) => { calls.push(["ask", question]); return Promise.resolve(answers.shift() as never); },
    openPanel: (plugin, panel, title) => { calls.push(["openPanel", plugin, panel, title]); },
    openTab: (plugin, view, botId) => { calls.push(["openTab", plugin, view, botId]); },
    botFolder: (botId) => (botId === "main" ? "/home/main" : null),
    botNote: (botId) => (botId === "main" ? note : null),
    imageUrl: (path, type) => `botling-card://image/${type}`,
    appSettings: () => ({}),
    shortcutOverrides: () => ({}),
    commandApproval: (botId, command) => (botId === "main" ? { folder: "/home/main", approved: command === "ls" } : null),
    approveCommand: () => false,
    commandRun: (botId, key, command, run) => { if (botId !== "main") return null; calls.push(["commandRun", key, command, run]); return { ...COMMAND_STATE, started: run !== false } as never; },
    component: (botId, name, data, command) => (botId === "main" ? { exists: name === "known", command: command ?? null } : null),
    imageUrls: () => null,
    createBot: (plugin, title, name, job, avatar, more) => { calls.push(["createBot", plugin, title, name, job, avatar, more]); return { id: "S1", name, role: "bot", awake: false, created: true }; },
    addRoutine: (botId, cron, task) => { if (botId !== "main") return "no-bot"; if (cron === "bad") return "bad-schedule"; calls.push(["addRoutine", cron, task]); return "added"; },
    routinesList: (botId) => { if (botId !== "main") return null; calls.push(["routinesList", botId]); return { routines: [] } as never; },
    routinesChange: (botId, operation, id) => { if (botId !== "main") return null; calls.push(["routinesChange", operation, id]); return { routines: [{ id }] } as never; },
    usageView: async () => ({ day: "2026-11-02", spent: 1.5 }),
    sessionBots: () => [{ id: "B1", name: "Site", role: "manager", parent: null, folder: "/p/site", memoryPath: ".bot/memory.md", storeDir: "/d/bots/B1", problem: null, workRoot: "/work/drive" }],
    botId: (botId) => (botId === "main" ? "MAIN-ID" : botId === "B1" ? "B1" : null),
    decorated: (botId) => { calls.push(["decorated", botId]); },
    dataChanged: (botId, plugin, data) => { calls.push(["dataChanged", botId, plugin, data]); },
    chat: (botId, limit) => (botId === "main" ? { botId: "main", name: "Main bot", unread: 2, messages: [{ id: "L1", role: "bot", text: "hi", date: 1 }].slice(-limit), tasks: [] } : null),
    engineCli: (engine) => (engine === "codex" ? { file: "/bin/codex", args: [], env: {} } : null),
    content: {
      read: async (ref, offset, length) => { calls.push(["content.read", ref, offset, length]); return Uint8Array.from([104, 105]); },
      fetch: async (storageDir, ref) => { calls.push(["content.fetch", ref]); return join(storageDir, "fetched.bin"); },
    },
    cards: {
      library: (botId) => (botId === "main" ? { botId, names: ["a"], offered: [], entries: {}, readOnly: false, folder: "/home/main" } : null),
      shown: (botId) => (botId === "main" ? [] : null),
      states: (botId, cards) => (botId === "main" ? cards.map((card) => ({ card: card.card })) : null),
      run: (botId, card, command, force) => { calls.push(["cards.run", card, command, force]); return botId === "main" ? true : null; },
      ask: (botId, card, command, component) => (botId === "main" ? { command, component } as never : null),
      setNotes: (botId, notes) => { calls.push(["cards.setNotes", botId, notes]); return botId === "main"; },
      legacyPins: (botId) => (botId === "main" ? [{ pin: 1 }] : null),
    },
    noteCards: {
      components: (botId) => (botId === "main" ? { folder: "/home/main", readOnly: false, components: [] } : null),
      states: (botId, cards) => (botId === "main" ? cards.map((card) => ({ key: card.key, name: card.name, exists: true, command: card.command, folder: "/home/main", every: card.refresh, status: "idle", data: card.data, error: null, ranAt: null, images: {}, chatData: null })) : null),
      run: (botId, key, command, force) => { calls.push(["noteCards.run", key, command, force]); return botId === "main" ? { folder: "/home/main", approved: true, started: true } : null; },
    },
    app: {
      state: () => ({ pid: 4242, dataDir: join(dir, "core"), appDataDir: null, bundle: "/Applications/Botling.app", developerMode: true, developer: null }),
      installAndRestart: (command, log) => { calls.push(["installAndRestart", command, log]); },
      captureWindow: async () => "/tmp/shot.png",
      card: async (text, choices, source) => { calls.push(["app.card", text, choices, source]); return choices ? 1 : null; },
      tell: (botId, kind, text, files) => { calls.push(["app.tell", botId, kind, text, files]); return botId === "B1"; },
    },
    studio,
    changed: () => {}, broken: () => {}, log: () => {},
    workspace: {
      bots: () => [{ id: "main", name: "Main bot", role: "main", parent: null, folder: "Main", engine: "claude", busy: false, asleep: false, avatar: "circle", pinned: false, lastActivity: null, job: null, subagents: 0, guest: false, approvals: 0, status: { key: "asleep", text: "Asleep" }, lastReply: null }],
      memory: (botId) => { known(botId); return { currentStatus: ["Up"], inProgress: [], decided: [], waitingOnYou: [] }; },
      tasks: (botId, limit) => { known(botId); return Array.from({ length: limit }, (_, index) => ({ id: `t${index}` }) as never); },
      taskHistory: (botId, days) => { known(botId); return Array.from({ length: days }, (_, index) => ({ day: `d${index}`, done: index, manual: 0 })); },
      results: (botId, limit) => { known(botId); return Array.from({ length: limit }, (_, index) => ({ label: `r${index}`, url: `https://x/${index}` })); },
      waiting: () => ({ items: [], doing: {} }),
      ignoreWaiting: (botId, text) => { known(botId); calls.push(["ignoreWaiting", botId, text]); },
      pendingApprovals: (botId) => { known(botId); return [{ tool: "Bash", text: "ls", at: null }]; },
      face: (botId, look) => { known(botId); return `data:image/svg+xml;base64,${look}`; },
      current: () => ({ botId: "main", engine: "claude", sessionId: "S1", heads: [{ engine: "claude", sessionId: "S1" }], view: "tab", tab: "botling.whiteboard/board" }),
      agyWorkers: (sessionId: string) => sessionId === "agy-s1" ? [{ id: "ag-1", nativeId: "w-1", sessionId: "agy-w1", name: "job", state: "completed", model: null, createdAt: 1, endedAt: 2 }] : [],
    },
    workspaceWatch: () => {},
  };
  const conv = conversation(join(dir, "agy-acp", "profile-1"), "agy-s1");
  conv.add(generation({ usage: usage({ input: 40, output: 9, cacheRead: 100 }), slug: "gemini-3.8-flash-high" }));
  conv.db.close();
  const worker = conversation(join(dir, "agy-acp", "profile-1", "workers", "w-1"), "agy-w1");
  worker.add(generation({ usage: usage({ input: 12, output: 3 }) }));
  worker.db.close();

  const sent: any[] = [];
  let handlers!: HostHandlers;
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
  return { dir, plugins, world, calls, answers, note, ask: (method, params, owner) => plugins["requested"](method, (params && typeof params === "object" && !Array.isArray(params) ? { code: plugins.codeOf(String((params as { plugin?: unknown }).plugin)), ...params } : params), owner) };
}

// ---------------------------------------------------------------------------------------------
// The table: one accepted and one refused call for every case

interface Call {
  params: Record<string, unknown> | null | ((env: Env) => Record<string, unknown>);
  /** Runs before the call (a note written, a world answer changed). */
  arrange?: (env: Env) => void | Promise<void>;
  /** The host's owner argument (a separate host): the request must be this plugin's. */
  owner?: string;
}
interface Row {
  method: string;
  ok: Call & {
    /** The golden of the reply (compared with toEqual, so asymmetric matchers work). */
    reply: unknown;
    /** What the fake world was asked, when the call has an effect on it. */
    calls?: unknown[][];
    /** What else the call changed. */
    after?: (env: Env) => void | Promise<void>;
  };
  refuse: Call & { error: string | RegExp };
}

const resolve = (params: Call["params"], env: Env) => (typeof params === "function" ? params(env) : params);
const noteWith = (text: string) => (env: Env) => { mkdirSync(join(env.note, ".."), { recursive: true }); writeFileSync(env.note, text); };
const withoutIds = (text: string) => text.replace(/^<!-- cell: [A-Za-z0-9_-]+ -->\n/, "").replace(/^<!-- cell: [A-Za-z0-9_-]+ -->$/gm, "<!-- cell -->");
/** The words of a refusal, all of them (a prefix or a half-sentence would pass a changed message). */
const exactly = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const NO_BOT = "No such bot.";
const NOT_REQUEST = /^Not a request a plugin can make/;
const NOT_RUNNING = "That plugin is not running.";
const SHIPPED_ONLY = (what: string) => `Only a plugin shipped with Botling may ${what}.`;
const needs = (what: string, permission: string) => `${what} needs the "${permission}" permission in package.json.`;

const ROWS: Row[] = [
  // bots
  { method: "bots.list",
    ok: { params: { plugin: A }, reply: [BOT] },
    refuse: { params: { plugin: L }, owner: A, error: `This host may only act for "${A}".` } },
  { method: "bots.send",
    ok: { params: { plugin: L, bot: "main", text: "hi" }, reply: { messageId: "M1" }, calls: [["send", "main", "hi", "Lib"]] },
    refuse: { params: { plugin: L, bot: "main", text: "x", as: "user" }, error: needs("Sending as the user", "bots") } },
  { method: "bots.wake",
    ok: { params: { plugin: L, bot: "main", prompt: "wake up" }, reply: null, calls: [["send", "main", "wake up", "Lib"]] },
    refuse: { params: { plugin: L, bot: "main" }, error: "bots.wake needs a prompt for now (a bot wakes when it gets a message)." } },
  { method: "bots.interrupt",
    ok: { params: { plugin: A, bot: "main" }, reply: { stopped: true }, calls: [["interrupt", "main"]] },
    refuse: { params: { plugin: L, bot: "main" }, error: needs("Stopping bots", "bots") } },
  { method: "bots.folder",
    ok: { params: { plugin: A, bot: "main" }, reply: "/home/main" },
    refuse: { params: { plugin: L, bot: "main" }, error: needs("Reading a bot's folder", "exec") } },
  { method: "bots.create",
    ok: { params: { plugin: A, name: "Reader", job: "Read with me", parent: "P1", delegation: "onRequest" }, reply: { id: "S1", name: "Reader", role: "bot", awake: false, created: true },
      calls: [["createBot", A, "All", "Reader", "Read with me", undefined, { parent: "P1", delegation: "onRequest" }]] },
    refuse: { params: { plugin: L, name: "R", job: "j" }, error: 'Creating bots needs the "bots" permission in package.json.' } },

  // a bot's note
  { method: "notes.read",
    ok: { params: { plugin: A, bot: "main" }, arrange: noteWith("hello\n"), reply: { path: expect.stringMatching(/note\.md$/), text: "hello\n", mtime: expect.any(Number) } },
    refuse: { params: { plugin: L, bot: "main" }, error: needs("Reading a bot's note", "files") } },
  { method: "notes.write",
    ok: { params: { plugin: A, bot: "main", text: "# Ideas\n" }, reply: { saved: true, mtime: expect.any(Number) },
      after: (env) => { expect(withoutIds(readFileSync(env.note, "utf8"))).toBe("# Ideas\n"); } },
    refuse: { params: { plugin: L, bot: "main", text: "x" }, error: needs("Changing a bot's note", "files") } },
  { method: "notes.importAsset",
    ok: { params: { plugin: A, bot: "main", data: Buffer.from("pasted").toString("base64"), name: "image.png" }, arrange: noteWith("# Plot\n"),
      reply: { ref: expect.stringMatching(/^note-assets\/[0-9a-f]{32}\.png$/), url: "botling-card://image/image/png" } },
    refuse: { params: { plugin: A, bot: "main", path: "/nowhere/figs/private.png" }, arrange: noteWith("# Plot\n"), error: "Only a picture the note links can be copied into it." } },
  { method: "notes.assetUrls",
    ok: { params: { plugin: A, bot: "main", refs: ["note-assets/none.png", "../note.md"] }, reply: { "note-assets/none.png": null, "../note.md": null } },
    refuse: { params: { plugin: L, bot: "main", refs: [] }, error: needs("Showing a bot's note's pictures", "files") } },
  { method: "notes.localizeImages",
    ok: { params: { plugin: A, bot: "main" }, arrange: noteWith("# Plot\n"), reply: { saved: true, text: "# Plot\n", mtime: expect.any(Number), copied: [], missing: [], failed: [] } },
    refuse: { params: { plugin: L, bot: "main" }, error: needs("Changing a bot's note", "files") } },
  { method: "notes.parse",
    ok: { params: { plugin: A, text: "hello\n" },
      reply: { forks: [], cards: [], routes: [{}], problems: [], cells: [{ above: -1, aboveCell: false, below: 2, belowCell: false, empty: false, end: 1, first: 0, id: null, last: 0, softAbove: false, softBelow: false, start: 0, type: "markdown" }], branches: [] } },
    refuse: { params: { plugin: L, text: "hello\n" }, error: needs("Reading a bot's note", "files") } },
  { method: "notes.outline",
    ok: { params: { plugin: A, bot: "main", text: "hello\n" }, arrange: noteWith("hello\n"), reply: { mode: "db", reason: null, rev: 1, mtime: expect.any(Number), forks: [], cells: [{ id: expect.any(String), label: expect.stringMatching(/^Note #/), kind: "text", type: "markdown", path: [], rev: 1, start: 0, end: 1 }] } },
    refuse: { params: { plugin: A, bot: "B9" }, error: NO_BOT } },
  { method: "notes.mode",
    ok: { params: { plugin: A, bot: "main" }, arrange: noteWith("hello\n"), reply: { mode: "db", reason: null } },
    refuse: { params: { plugin: L, bot: "main", mode: "file" }, error: needs("Changing a bot's note", "files") } },
  { method: "notes.components",
    ok: { params: { plugin: A, bot: "main" }, reply: { folder: "/home/main", readOnly: false, components: [] } },
    refuse: { params: { plugin: A, bot: "B9" }, error: NO_BOT } },
  { method: "notes.cards",
    ok: { params: { plugin: A, bot: "main", text: CARD_TEXT },
      reply: [{ key: CARD_KEY, name: "clock", exists: true, command: "date", folder: "/home/main", every: null, status: "idle", data: "null", error: null, ranAt: null, images: {}, chatData: null }] },
    refuse: { params: { plugin: A, bot: "B9", text: CARD_TEXT }, error: NO_BOT } },
  { method: "notes.runCard",
    ok: { params: { plugin: A, bot: "main", text: CARD_TEXT, key: CARD_KEY }, reply: { started: true, needsApproval: null }, calls: [["noteCards.run", CARD_KEY, "date", false]] },
    refuse: { params: { plugin: A, bot: "main", text: CARD_TEXT, key: "note/0000000000000000-1" }, error: "No such card in the note." } },

  // the chat
  { method: "ui.quickPick",
    ok: { params: { plugin: L, title: "Which?", items: [{ id: "a", label: "A" }, { id: "b", label: "B", detail: "second" }] }, arrange: (env) => { env.answers.push({ index: 1 }); }, reply: "b",
      calls: [["ask", { text: "Lib: Which?", choices: [{ label: "A" }, { label: "B", detail: "second" }, { label: "Cancel" }], typed: false }]] },
    refuse: { params: { plugin: L, items: [] }, error: NOT_REQUEST } },
  { method: "ui.input",
    ok: { params: { plugin: L, title: "Name?", placeholder: "v1" }, arrange: (env) => { env.answers.push({ text: "Autumn" }); }, reply: "Autumn",
      calls: [["ask", { text: "Lib: Name? (v1)", choices: [{ label: "Cancel" }], typed: true }]] },
    refuse: { params: { plugin: L, title: "Token?", secret: true }, error: "A secret cannot be asked for in the chat yet; declare a secret setting instead." } },
  { method: "ui.openView",
    ok: { params: { plugin: A, id: "botling.all.panel" }, reply: null, calls: [["openPanel", A, "botling.all.panel", "The panel"]] },
    refuse: { params: { plugin: A, id: "botling.all.nothing" }, error: `Plugin "${A}" has no view "botling.all.nothing".` } },
  { method: "ui.showTab",
    ok: { params: { plugin: A, bot: "main", view: "botling.all.tab", on: true, open: true }, reply: null, calls: [["openTab", A, "botling.all.tab", "MAIN-ID"]],
      after: (env) => { expect(env.plugins.view().mainTabs!.find((tab) => tab.id === "botling.all.tab")).toMatchObject({ bots: ["MAIN-ID"] }); } },
    refuse: { params: { plugin: A, bot: "main", view: "botling.all.any", on: true }, error: 'The view "botling.all.any" is not forRole "marked": it shows for its role\'s bots already.' } },
  { method: "ui.takeover",
    ok: { params: { plugin: A, view: "botling.all.take", bot: "main", wide: true }, reply: null,
      after: (env) => { expect(env.plugins.view().takeover).toEqual({ plugin: A, view: "botling.all.take", botId: "MAIN-ID", wide: true }); } },
    refuse: { params: { plugin: A, view: "botling.all.nothing", bot: "main" }, error: `Plugin "${A}" has no takeover view "botling.all.nothing".` } },
  { method: "chat.messages",
    ok: { params: { plugin: A, bot: "main", limit: 5 }, reply: { botId: "main", name: "Main bot", unread: 2, messages: [{ id: "L1", role: "bot", text: "hi", date: 1 }], tasks: [] } },
    refuse: { params: { plugin: L, bot: "main" }, error: needs("Reading a chat", "messages") } },
  { method: "chat.decorate",
    ok: { params: { plugin: A, bot: "main", decorations: [{ key: "a", fold: ["L1", "L2"], data: { state: "loading" } }, { key: "b", after: "L3" }] }, reply: null, calls: [["decorated", "MAIN-ID"]],
      after: (env) => { expect(env.plugins.decorations("MAIN-ID")).toEqual([{ plugin: A, key: "a", fold: ["L1", "L2"], data: { state: "loading" } }, { plugin: A, key: "b", after: "L3" }]); } },
    refuse: { params: { plugin: L, bot: "main", decorations: [] }, error: "Message decorations are drawn by the plugin's web part: it needs one (ccb.web)." } },
  { method: "chat.setData",
    ok: { params: { plugin: A, bot: "main", data: { pins: [1] } }, reply: null, calls: [["dataChanged", "MAIN-ID", A, { pins: [1] }]] },
    refuse: { params: { plugin: L, bot: "main", data: {} }, error: needs("Reading and running a chat's cards", "cards") } },

  // the plugin's own settings, secrets and keys
  { method: "settings.update",
    ok: { params: { plugin: A, key: "botling.all.n", value: 9 }, reply: null, after: (env) => { expect(env.plugins.registry.setting(A, "botling.all.n")).toBe(9); } },
    refuse: { params: { plugin: A, key: "botling.all.token", value: "x" }, error: "A secret setting is set with secrets.set." } },
  { method: "secrets.get",
    ok: { params: { plugin: L, key: "oauth" }, reply: null },
    refuse: { params: { plugin: L, key: "../x" }, error: NOT_REQUEST } },
  { method: "secrets.set",
    ok: { params: { plugin: L, key: "oauth", value: "tok-1" }, reply: null,
      after: async (env) => { expect(await env.ask("secrets.get", { plugin: L, key: "oauth" })).toBe("tok-1"); expect(readFileSync(join(env.dir, "plugin-secrets.json"), "utf8")).not.toContain("tok-1"); } },
    refuse: { params: { plugin: L, key: "", value: "x" }, error: NOT_REQUEST } },
  { method: "keybindings.list",
    ok: { params: { plugin: A }, reply: expect.arrayContaining([{ command: "search", key: "Mod+K", source: "default" }]) },
    refuse: { params: { plugin: "ghost" }, error: NOT_RUNNING } },
  { method: "keybindings.set",
    ok: { params: { plugin: A, command: "botling.all.go", key: "Ctrl+Alt+O" }, reply: { ok: true },
      after: (env) => { expect(env.plugins.view().keybindings!.filter((binding) => binding.plugin === A).map((binding) => [binding.command, binding.key])).toEqual([["botling.all.go", "Ctrl+Alt+O"]]); } },
    refuse: { params: { plugin: A, command: "botling.all.go", key: "shift+l" }, error: '"shift+l" is not a key (like "Mod+Shift+L": Mod, Ctrl, Cmd or Alt, and one key).' } },

  // commands and approvals
  { method: "approvals.check",
    ok: { params: { plugin: L, bot: "main", command: "ls" }, reply: { folder: "/home/main", approved: true } },
    refuse: { params: { plugin: L, bot: "B9", command: "ls" }, error: NO_BOT } },
  { method: "approvals.state",
    ok: { params: { plugin: L, bot: "main", command: "ls", key: "k" }, reply: COMMAND_STATE, calls: [["commandRun", "lib/k", "ls", false]] },
    refuse: { params: { plugin: L, bot: "B9", command: "ls", key: "k" }, error: NO_BOT } },
  { method: "approvals.run",
    ok: { params: { plugin: L, bot: "main", command: "ls", key: "k", minIntervalMs: 5 }, reply: { ...COMMAND_STATE, started: true }, calls: [["commandRun", "lib/k", "ls", { minIntervalMs: 5 }]] },
    refuse: { params: { plugin: L, bot: "B9", command: "ls", key: "k" }, error: NO_BOT } },
  { method: "workspace.component",
    ok: { params: { plugin: L, bot: "main", name: "known", command: "ls" }, reply: { exists: true, command: "ls" } },
    refuse: { params: { plugin: L, bot: "B9", name: "known" }, error: NO_BOT } },
  { method: "routines.add",
    ok: { params: { plugin: A, bot: "main", cron: "0 9 * * *", task: "Check" }, reply: null, calls: [["addRoutine", "0 9 * * *", "Check"]] },
    refuse: { params: { plugin: A, bot: "main", cron: "bad", task: "Check" }, error: "Invalid schedule (it must be the 5 crontab fields)." } },
  { method: "routines.list",
    ok: { params: { plugin: A, bot: "main" }, reply: { routines: [] }, calls: [["routinesList", "main"]] },
    refuse: { params: { plugin: F, bot: "main" }, error: SHIPPED_ONLY("read or change routines") } },
  { method: "routines.change",
    ok: { params: { plugin: A, bot: "main", operation: "pause", id: "r1" }, reply: { routines: [{ id: "r1" }] }, calls: [["routinesChange", "pause", "r1"]] },
    refuse: { params: { plugin: L, bot: "main", operation: "pause", id: "r1" }, error: needs("Reading or changing routines", "routines") } },
  { method: "usage.view",
    ok: { params: { plugin: L }, reply: { day: "2026-11-02", spent: 1.5 } },
    refuse: { params: { plugin: L }, arrange: (env) => { env.world.usageView = undefined; }, error: "Usage is not available here." } },

  // where a bot's session starts
  { method: "sessions.folder",
    ok: { params: { plugin: A, bot: "main", folder: { cwd: "/work/tree", note: "in a tree" } }, reply: null },
    refuse: { params: { plugin: F, bot: "main", folder: { cwd: "/work/tree" } }, error: SHIPPED_ONLY("decide a session's folder") } },
  { method: "sessions.folders",
    ok: { params: { plugin: A, folders: { main: { cwd: "/work/tree" }, ghost: { cwd: "/work/other" } } }, reply: null },
    refuse: { params: { plugin: F, folders: {} }, error: SHIPPED_ONLY("decide a session's folder") } },
  { method: "sessions.bots",
    ok: { params: { plugin: A }, reply: [{ id: "B1", name: "Site", role: "manager", parent: null, folder: "/p/site", memoryPath: ".bot/memory.md", storeDir: "/d/bots/B1", problem: null, workRoot: "/work/drive" }] },
    refuse: { params: { plugin: L }, error: needs("Reading the bots' folders", "sessions") } },

  // the app seam
  { method: "app.state",
    ok: { params: { plugin: A }, reply: expect.objectContaining({ pid: 4242, bundle: "/Applications/Botling.app", developerMode: true }) },
    refuse: { params: { plugin: F }, error: "Only a plugin shipped with Botling may ask the app." } },
  { method: "app.captureWindow",
    ok: { params: { plugin: A }, reply: "/tmp/shot.png" },
    refuse: { params: { plugin: L }, error: needs("Asking the app", "app") } },
  { method: "app.installAndRestart",
    ok: { params: (env) => ({ plugin: A, command: INSTALL(env.dir), log: "/l" }), reply: null, calls: [["installAndRestart", expect.any(Array), "/l"]],
      after: (env) => { expect((env.calls[0]![1] as string[])[2]).toBe(join(env.dir, "core", "self-update", "install.sh")); } },
    refuse: { params: { plugin: A, command: Array.from({ length: 12 }, () => "x"), log: "/l" }, error: "That is not the install script of this Botling." } },
  { method: "app.card",
    ok: { params: { plugin: A, text: "Install?", choices: [{ label: "Yes", recommended: true }, { label: "No" }], source: "B1" }, reply: { index: 1 }, calls: [["app.card", "Install?", [{ label: "Yes", recommended: true }, { label: "No" }], "B1"]] },
    refuse: { params: { plugin: L, text: "x" }, error: needs("Asking the app", "app") } },
  { method: "app.tell",
    ok: { params: { plugin: A, bot: "B1", kind: "relay", text: "hi", files: ["/tmp/a.png"] }, reply: null, calls: [["app.tell", "B1", "relay", "hi", ["/tmp/a.png"]]] },
    refuse: { params: { plugin: A, bot: "ghost", kind: "note", text: "x" }, error: NO_BOT } },
  { method: "app.briefing",
    ok: { params: { plugin: A, briefing: { bot: "B1", plain: "plain words", worktree: "tree words" } }, reply: null,
      after: (env) => { expect(env.plugins.devBriefing("B1", false)).toBe("plain words"); expect(env.plugins.devBriefing("B1", true)).toBe("tree words"); } },
    refuse: { params: { plugin: L, briefing: null }, error: needs("Asking the app", "app") } },

  // the workspace
  { method: "workspace.bots",
    ok: { params: { plugin: L }, reply: [expect.objectContaining({ id: "main", folder: "Main", engine: "claude" })] },
    refuse: { params: { plugin: "ghost" }, error: NOT_RUNNING } },
  { method: "workspace.memory",
    ok: { params: { plugin: L, bot: "main" }, reply: { currentStatus: ["Up"], inProgress: [], decided: [], waitingOnYou: [] } },
    refuse: { params: { plugin: L, bot: "B9" }, error: NO_BOT } },
  { method: "workspace.tasks",
    ok: { params: { plugin: L, bot: "main", limit: 2 }, reply: [{ id: "t0" }, { id: "t1" }] },
    refuse: { params: { plugin: L, bot: "B9" }, error: NO_BOT } },
  { method: "workspace.taskHistory",
    ok: { params: { plugin: L, bot: "main", days: 99 }, reply: expect.arrayContaining([{ day: "d13", done: 13, manual: 0 }]) },
    refuse: { params: { plugin: L, bot: "B9" }, error: NO_BOT } },
  { method: "workspace.results",
    ok: { params: { plugin: L, bot: "main", limit: 2 }, reply: [{ label: "r0", url: "https://x/0" }, { label: "r1", url: "https://x/1" }] },
    refuse: { params: { plugin: L, bot: "B9" }, error: NO_BOT } },
  { method: "workspace.waiting",
    ok: { params: { plugin: L }, reply: { items: [], doing: {} } },
    refuse: { params: { plugin: "ghost" }, error: NOT_RUNNING } },
  { method: "workspace.ignoreWaiting",
    ok: { params: { plugin: L, bot: "main", text: "Pick a domain" }, reply: null, calls: [["ignoreWaiting", "main", "Pick a domain"]] },
    refuse: { params: { plugin: L, bot: "main", text: "" }, error: NOT_REQUEST } },
  { method: "workspace.pendingApprovals",
    ok: { params: { plugin: L, bot: "main" }, reply: [{ tool: "Bash", text: "ls", at: null }] },
    refuse: { params: { plugin: L, bot: "B9" }, error: NO_BOT } },
  { method: "workspace.current",
    ok: { params: { plugin: L }, reply: { botId: "main", engine: "claude", sessionId: "S1", heads: [{ engine: "claude", sessionId: "S1" }], view: "tab", tab: "botling.whiteboard/board" } },
    refuse: { params: { plugin: "ghost" }, error: NOT_RUNNING } },
  { method: "workspace.agyUsage",
    ok: { params: { plugin: L, sessionId: "agy-s1" }, reply: expect.objectContaining({ sessionId: "agy-s1", retries: 0, models: ["gemini-3.8-flash-high"], total: { input: 40, output: 9, cacheRead: 100, cacheWrite: 0, reasoning: 0 } }) },
    refuse: { params: { plugin: L }, error: NOT_REQUEST } },
  { method: "workspace.agyWorkers",
    ok: { params: { plugin: L, sessionId: "agy-s1" }, reply: [{ id: "ag-1", nativeId: "w-1", sessionId: "agy-w1", name: "job", state: "completed", model: null, createdAt: 1, endedAt: 2 }] },
    refuse: { params: { plugin: L }, error: NOT_REQUEST } },
  { method: "workspace.agyWorkerUsage",
    ok: { params: { plugin: L, workerId: "w-1" }, reply: expect.objectContaining({ sessionId: "agy-w1", total: expect.objectContaining({ input: 12, output: 3 }) }) },
    refuse: { params: { plugin: L }, error: NOT_REQUEST } },
  { method: "workspace.agyQuota",
    ok: { params: { plugin: L }, reply: { status: "unavailable", reason: "unsupported_connection", source: "antigravity_acp" } },
    refuse: { params: { plugin: "ghost" }, error: NOT_RUNNING } },
  { method: "workspace.face",
    ok: { params: { plugin: L, bot: "main", look: "cute" }, reply: "data:image/svg+xml;base64,cute" },
    refuse: { params: { plugin: L, bot: "main", look: "scary" }, error: NOT_REQUEST } },

  // Botling 3 content
  { method: "content.read",
    ok: { params: { plugin: L, ref: REF, offset: 0, length: 2 }, reply: { data: Buffer.from("hi").toString("base64") }, calls: [["content.read", REF, 0, 2]] },
    refuse: { params: { plugin: L, ref: REF, offset: 0, length: 2 }, arrange: (env) => { env.world.content = undefined; }, error: "Reading content needs Botling 3." } },
  { method: "content.fetch",
    ok: { params: { plugin: L, ref: REF }, reply: { path: expect.stringMatching(/lib[/\\]fetched\.bin$/) }, calls: [["content.fetch", REF]] },
    refuse: { params: { plugin: L, ref: REF }, arrange: (env) => { env.world.content = undefined; }, error: "Fetching content needs Botling 3." } },

  // cards of the chat (shipped plugins with "cards")
  { method: "cards.library",
    ok: { params: { plugin: A, bot: "main" }, reply: { botId: "main", names: ["a"], offered: [], entries: {}, readOnly: false, folder: "/home/main" } },
    refuse: { params: { plugin: F, bot: "main" }, error: "Only a plugin shipped with Botling may use a chat's cards." } },
  { method: "cards.shown",
    ok: { params: { plugin: A, bot: "main" }, reply: [] },
    refuse: { params: { plugin: A, bot: "main" }, arrange: (env) => { env.world.cards = undefined; }, error: "Cards are not available here." } },
  { method: "cards.states",
    ok: { params: { plugin: A, bot: "main", cards: [{ card: "pin/x", command: "ls", name: "x" }] }, reply: [{ card: "pin/x" }] },
    refuse: { params: { plugin: L, bot: "main", cards: [] }, error: needs("Reading and running a chat's cards", "cards") } },
  { method: "cards.run",
    ok: { params: { plugin: A, bot: "main", card: "pin/x", command: "ls", force: true }, reply: true, calls: [["cards.run", "pin/x", "ls", true]] },
    refuse: { params: { plugin: A, bot: "main", card: "nope", command: "ls", force: true }, error: NOT_REQUEST } },
  { method: "cards.ask",
    ok: { params: { plugin: A, bot: "main", card: "pin/x", command: "ls", name: "x" }, reply: { command: "ls", component: "x" } },
    refuse: { params: { plugin: F, bot: "main", card: "pin/x", command: "ls", name: "x" }, error: "Only a plugin shipped with Botling may use a chat's cards." } },
  { method: "cards.setNotes",
    ok: { params: { plugin: A, bot: "main", notes: [{ date: 1, line: "a line" }] }, reply: null, calls: [["cards.setNotes", "main", [{ date: 1, line: "a line" }]]] },
    refuse: { params: { plugin: A, bot: "B9", notes: [] }, error: NO_BOT } },
  { method: "cards.legacyPins",
    ok: { params: { plugin: A, bot: "main" }, reply: [{ pin: 1 }] },
    refuse: { params: { plugin: L, bot: "main" }, error: needs("Reading and running a chat's cards", "cards") } },

  { method: "engines.cli",
    ok: { params: { plugin: L, engine: "codex" }, reply: { file: "/bin/codex", args: [], env: {} } },
    refuse: { params: { plugin: L, engine: "agy" }, error: NOT_REQUEST } },
];

// ---------------------------------------------------------------------------------------------
// The studio seam: the `default` arm of the switch

const SHIPPED_STUDIO = "Only a plugin shipped with Botling may use the studio seam.";
const STUDIO: { method: string; params: Record<string, unknown>; reply: unknown; calls?: unknown[][] }[] = [
  { method: "studio.chats", params: {}, reply: [expect.objectContaining({ id: "main", folder: "/p/main" })] },
  { method: "studio.chat", params: { bot: "B1" }, reply: expect.objectContaining({ id: "B1", folder: "/p/B1" }) },
  { method: "studio.componentBots", params: {}, reply: ["Main", "Site"] },
  { method: "studio.maintainer", params: {}, reply: { id: "M", working: true } },
  { method: "studio.line", params: { bot: "main", last: "bot" }, reply: expect.objectContaining({ asked: "ask", turn: ["L1"] }), calls: [["studio.line", "main", { last: "bot" }]] },
  { method: "studio.specs", params: {}, reply: { main: [{ id: "S1" }] } },
  { method: "studio.writeSpecs", params: { bot: "main", specs: [{ id: "S2" }] }, reply: { changed: true }, calls: [["studio.writeSpecs", "main", [{ id: "S2" }]]] },
  { method: "studio.library", params: { withInfo: ["a"] }, reply: expect.objectContaining({ names: ["a"] }) },
  { method: "studio.working", params: { name: "a", change: "editing" }, reply: null, calls: [["studio.working", "a", "editing"]] },
  { method: "studio.handTo", params: { text: "build it" }, reply: null, calls: [["studio.handTo", "build it"]] },
  { method: "studio.holder", params: { name: "Site" }, reply: expect.objectContaining({ id: "B1", own: ["a"] }) },
  { method: "studio.give", params: { name: "a", bot: "B1" }, reply: true, calls: [["studio.give", "a", "B1"]] },
  { method: "studio.unlist", params: { name: "a", bot: "B1" }, reply: false, calls: [["studio.unlist", "a", "B1"]] },
  { method: "studio.note", params: { bot: "main", text: "a note" }, reply: null, calls: [["studio.note", "main", "a note"]] },
  { method: "studio.notice", params: { bot: "main", text: "a line" }, reply: null, calls: [["studio.notice", "main", "a line"]] },
  { method: "studio.ask", params: { bot: "main", text: "question", waitMs: 10, answerMs: 20 }, reply: { kind: "reply", text: "ok" }, calls: [["studio.ask", "main", "question", 10, 20]] },
  { method: "studio.isApproved", params: { command: "ls", folder: "/p/main" }, reply: true },
  { method: "studio.isDetailApproved", params: { detail: null, folder: "/p/main" }, reply: true },
  { method: "studio.run", params: { card: "c", command: "ls", folder: "/p/main", force: false }, reply: null, calls: [["studio.run", "c", "ls", "/p/main", false]] },
  { method: "studio.commandState", params: { card: "c", command: "ls", detail: null, folder: "/p/main" }, reply: { status: "idle", data: null, error: null, ranAt: null } },
  { method: "studio.runOf", params: { card: "c", command: "ls", folder: "/p/main" }, reply: null },
  { method: "studio.lastRan", params: { card: "c" }, reply: 7 },
];

// ---------------------------------------------------------------------------------------------

describe("the table covers the switch", () => {
  it("has a row for every `case` of `requested`, and no row for a case that is gone", () => {
    const labels = caseLabels();
    expect(labels.length).toBeGreaterThanOrEqual(60);
    expect(ROWS.map((row) => row.method).sort()).toEqual(labels);
    expect(new Set(ROWS.map((row) => row.method)).size).toBe(ROWS.length);
  });

  it("has a row for every studio method, which the `default` arm answers", () => {
    expect(STUDIO.map((row) => row.method).sort()).toEqual(Object.keys(StudioParams).sort());
  });
});

describe("every plugin request: one accepted call and one refused call", () => {
  it.each(ROWS.map((row) => [row.method, row] as const))("%s accepts a good call and answers its golden", async (_method, row) => {
    const env = await setup();
    await row.ok.arrange?.(env);
    const reply = await env.ask(row.method, resolve(row.ok.params, env), row.ok.owner);
    expect(reply).toEqual(row.ok.reply);
    if (row.ok.calls) expect(env.calls).toEqual(row.ok.calls);
    await row.ok.after?.(env);
  });

  it.each(ROWS.map((row) => [row.method, row] as const))("%s refuses a bad call, with its words, and changes nothing", async (_method, row) => {
    const env = await setup();
    await row.refuse.arrange?.(env);
    const before = env.calls.length;
    await expect(env.ask(row.method, resolve(row.refuse.params, env), row.refuse.owner)).rejects.toThrow(row.refuse.error instanceof RegExp ? row.refuse.error : exactly(row.refuse.error));
    // A refused call reached the world only up to the check that refused it: nothing a plugin may not do was done.
    expect(env.calls.slice(before).filter((call) => ["send", "interrupt", "createBot", "addRoutine", "routinesChange", "installAndRestart", "cards.run", "dataChanged", "decorated", "noteCards.run"].includes(call[0] as string))).toEqual([]);
  });
});

// A case with more than one guard: each guard has a refused call of its own (a guard taken out must fail a test, L-010).
const BIG = "x".repeat(1_100_000);
const EXTRA_REFUSALS: [string, string, Record<string, unknown>, string | RegExp][] = [
  ["chat.decorate", "an unknown bot", { plugin: A, bot: "B9", decorations: [] }, NO_BOT],
  ["chat.decorate", "two decorations with one key", { plugin: A, bot: "main", decorations: [{ key: "a" }, { key: "a" }] }, "Each decoration needs a key of its own."],
  ["chat.decorate", "more than a chat may hold", { plugin: A, bot: "main", decorations: [{ key: "a", data: BIG }] }, "Too much to draw in one chat (1 MB at most)."],
  ["chat.setData", "an unknown bot", { plugin: A, bot: "B9", data: {} }, NO_BOT],
  ["chat.setData", "more than a chat's page may hold", { plugin: A, bot: "main", data: BIG }, "Too much for one chat's page (1 MB at most)."],
  ["ui.showTab", "a view the plugin does not have", { plugin: A, bot: "main", view: "nope", on: true }, `Plugin "${A}" has no mainTab view "nope".`],
  ["ui.showTab", "an unknown bot", { plugin: A, bot: "B9", view: "botling.all.tab", on: true }, NO_BOT],
  ["ui.takeover", "an unknown bot", { plugin: A, view: "botling.all.take", bot: "B9" }, NO_BOT],
  ["ui.takeover", "no bot at all", { plugin: A, view: "botling.all.take" }, NO_BOT],
  ["keybindings.set", "a command of another plugin", { plugin: A, command: "other.cmd", key: "Mod+J" }, `"other.cmd" is not a command of "${A}" (a plugin binds keys to the commands its package.json lists).`],
  ["settings.update", "a setting the plugin does not have", { plugin: A, key: "other.key", value: 1 }, /no setting "other\.key"/],
  ["bots.create", "a delegation that is not one", { plugin: A, name: "R", job: "j", delegation: "never" }, 'delegation is "default" or "onRequest".'],
  ["bots.create", "instructions past the limit", { plugin: A, name: "R", job: "j", instructions: "y".repeat(200_001) }, "A bot's instructions are at most 200000 characters."],
  ["notes.importAsset", "bytes that are not a picture's name", { plugin: A, bot: "main", data: "aGk=", name: "page.html" }, /^Only png/],
  ["notes.write", "text that is not text", { plugin: A, bot: "main", text: 7 }, NOT_REQUEST],
  ["sessions.folder", "a folder with no absolute cwd", { plugin: A, bot: "main", folder: { cwd: "relative/dir" } }, "A folder needs an absolute `cwd`."],
  ["sessions.folder", "an unknown bot", { plugin: A, bot: "B9", folder: { cwd: "/work" } }, NO_BOT],
  ["sessions.folders", "a plugin without the permission", { plugin: "botling.bare", folders: {} }, needs("Deciding a session's folder", "sessions")],
  ["routines.add", "a plugin that is not running", { plugin: "ghost", bot: "main", cron: "0 9 * * *", task: "t" }, NO_BOT],
  ["routines.add", "an unknown bot", { plugin: A, bot: "B9", cron: "0 9 * * *", task: "t" }, NO_BOT],
  ["approvals.run", "a negative interval", { plugin: L, bot: "main", command: "ls", key: "k", minIntervalMs: -1 }, NOT_REQUEST],
  ["content.read", "more than one read may take", { plugin: L, ref: REF, offset: 0, length: 5 * 1024 * 1024 }, NOT_REQUEST],
  ["content.read", "a ref that is not a ref", { plugin: L, ref: { owner: "x" }, offset: 0, length: 1 }, NOT_REQUEST],
  ["app.installAndRestart", "a command one word short", { plugin: A, command: ["/usr/bin/nohup", "/bin/bash"], log: "/l" }, NOT_REQUEST],
  ["app.tell", "a plugin without the app permission", { plugin: "botling.bare", bot: "B1", kind: "relay", text: "x" }, needs("Asking the app", "app")],
  ["cards.run", "a plugin that is not shipped", { plugin: F, bot: "main", card: "pin/x", command: "ls", force: false }, "Only a plugin shipped with Botling may use a chat's cards."],
  ["routines.change", "a plugin that is not shipped", { plugin: F, bot: "main", operation: "pause", id: "r1" }, SHIPPED_ONLY("read or change routines")],
  ["bots.send", "a bot that is not there", { plugin: L, bot: "B9", text: "x" }, NO_BOT],
  ["bots.interrupt", "a bot that is not there", { plugin: A, bot: "B9" }, NO_BOT],
];

describe("a case with more than one guard: each guard has its own refused call", () => {
  it.each(EXTRA_REFUSALS.map((row) => [`${row[0]}: ${row[1]}`, row] as const))("%s", async (_name, [method, , params, error]) => {
    const env = await setup();
    await expect(env.ask(method, params)).rejects.toThrow(error instanceof RegExp ? error : exactly(error));
    // Nothing reached the world for what was refused, and nothing was drawn or kept.
    expect(env.calls).toEqual([]);
    expect(env.plugins.decorations("MAIN-ID")).toEqual([]);
    expect(env.plugins.view().takeover ?? null).toBeNull();
  });

  it("covers a method of the table only (a typo here would test nothing)", () => {
    const methods = new Set(ROWS.map((row) => row.method));
    for (const [method] of EXTRA_REFUSALS) expect(methods.has(method), method).toBe(true);
  });
});

describe("the studio seam in the switch's default arm", () => {
  it.each(STUDIO.map((row) => [row.method, row] as const))("%s answers a shipped plugin with the studio permission", async (_method, row) => {
    const env = await setup();
    expect(await env.ask(row.method, { plugin: A, ...row.params })).toEqual(row.reply);
    if (row.calls) expect(env.calls).toEqual(row.calls);
  });

  it.each(STUDIO.map((row) => [row.method, row] as const))("%s is refused for a library plugin, and for one without the permission", async (_method, row) => {
    const env = await setup();
    await expect(env.ask(row.method, { plugin: F, ...row.params })).rejects.toThrow(SHIPPED_STUDIO);
    await expect(env.ask(row.method, { plugin: "botling.bare", ...row.params })).rejects.toThrow('Asking the component studio\'s seam needs the "studio" permission in package.json.');
    expect(env.calls).toEqual([]);
  });

  it("is refused when the world has no studio, and for a method that is not one", async () => {
    const env = await setup();
    env.world.studio = undefined;
    await expect(env.ask("studio.chats", { plugin: A })).rejects.toThrow("There is no component studio here.");
    await expect(env.ask("studio.nothing", { plugin: A })).rejects.toThrow('Unknown method "studio.nothing".');
    await expect(env.ask("studio.chat", { plugin: A })).rejects.toThrow(NOT_REQUEST);
  });
});

describe("what holds for every request", () => {
  it("a method that is not in the switch is refused, whatever it looks like", async () => {
    const env = await setup();
    await expect(env.ask("nothing.here", { plugin: A })).rejects.toThrow('Unknown method "nothing.here".');
    await expect(env.ask("constructor", { plugin: A })).rejects.toThrow('Unknown method "constructor".');
    await expect(env.ask("__proto__", { plugin: A })).rejects.toThrow('Unknown method "__proto__".');
    await expect(env.ask("toString", { plugin: A })).rejects.toThrow('Unknown method "toString".');
    await expect(env.ask("x".repeat(500), { plugin: A })).rejects.toThrow(`Unknown method "${"x".repeat(80)}".`);
  });

  it("a request with no params is refused by every case but bots.list, which takes none", async () => {
    const env = await setup();
    for (const method of caseLabels()) {
      if (method === "bots.list") { expect(await env.ask(method, null)).toEqual([BOT]); continue; }
      await expect(env.ask(method, null), method).rejects.toThrow();
    }
  });

  it("a plugin that is not loaded gets nothing from any case that names one", async () => {
    const env = await setup();
    for (const method of caseLabels()) {
      if (method === "bots.list") continue;
      await expect(env.ask(method, { plugin: "ghost" }), method).rejects.toThrow();
    }
    // The ones that need nothing but the plugin's name say so in the words of `asked`.
    for (const method of ["usage.view", "workspace.bots", "workspace.waiting", "workspace.current", "workspace.agyQuota", "keybindings.list"]) {
      await expect(env.ask(method, { plugin: "ghost" }), method).rejects.toThrow(NOT_RUNNING);
    }
  });

  it("a host that belongs to one plugin refuses a request in another's name before anything else, for every case", async () => {
    const env = await setup();
    for (const method of caseLabels()) {
      await expect(env.ask(method, { plugin: L }, A), method).rejects.toThrow(`This host may only act for "${A}".`);
    }
    // Its own name passes the check (bots.list answers; the others are not this test's business).
    expect(await env.ask("bots.list", { plugin: A }, A)).toEqual([BOT]);
    expect(env.calls).toEqual([]);
  });

  it("the grant checks come before the world is touched: a plugin without the permission changes nothing", async () => {
    const env = await setup();
    const refused: [string, Record<string, unknown>][] = [
      ["bots.send", { plugin: L, bot: "main", text: "x", as: "user" }],
      ["bots.interrupt", { plugin: L, bot: "main" }],
      ["bots.create", { plugin: L, name: "N", job: "j" }],
      ["notes.write", { plugin: L, bot: "main", text: "x" }],
      ["chat.setData", { plugin: L, bot: "main", data: {} }],
      ["cards.run", { plugin: L, bot: "main", card: "pin/x", command: "ls", force: true }],
      ["routines.change", { plugin: L, bot: "main", operation: "cancel", id: "r1" }],
      ["sessions.folder", { plugin: F, bot: "main", folder: { cwd: "/work" } }],
      ["app.installAndRestart", { plugin: L, command: INSTALL(env.dir), log: "/l" }],
      ["app.tell", { plugin: L, bot: "B1", kind: "relay", text: "x" }],
    ];
    for (const [method, params] of refused) await expect(env.ask(method, params), method).rejects.toThrow();
    expect(env.calls).toEqual([]);
    expect(existsSync(env.note)).toBe(false);
  });
});
