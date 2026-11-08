// Host API v3 in the core (plan M5): what the plugin host may ask of Plugins and what each ask does,
// against a fake world (no bots, no app page) and a fake host process (the `launch` hook: lines in,
// lines out, no Node child). The real host and the real core are in plugin-host.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { Plugins, type AppQuestion, type AppAnswer, type PluginWorld } from "../../src/core/plugins";
import type { HostCommand, HostHandlers } from "../../src/core/plugins/host-client";
import { testSealer } from "../../src/core/plugins/secrets";
import { conversation, generation, usage } from "./agy-db-fixture";

function plugin(dir: string, name: string, ccb: Record<string, unknown> = {}) {
  const folder = join(dir, "plugins", name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, displayName: `${name[0]!.toUpperCase()}${name.slice(1)}`, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", ...ccb } }));
  writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}");
  if (ccb.web) writeFileSync(join(folder, "dist", "web.js"), "export function activate() {}");
}

const known = (botId: string) => { if (botId !== "main") throw new Error("No such bot."); };

/** A world that records what it was asked, with answers the test sets. */
function fakeWorld() {
  const log = {
    sent: [] as { botId: string; text: string; via: string | null }[],
    notices: [] as { text: string; actions?: { label: string; run: () => void }[] }[],
    questions: [] as { question: AppQuestion; answer: (answer: AppAnswer) => void }[],
    panels: [] as string[][],
    stopped: [] as string[],
    ignored: [] as string[][],
    watching: [] as boolean[],
    approved: [] as string[],
    decorated: [] as string[],
    usageReads: 0,
  };
  const settings = { language: "en", botLook: "cute", workerLimit: 4 };
  const overrides: Record<string, string> = { settings: "Mod+Shift+P" };
  const world: PluginWorld = {
    bots: () => [{ id: "main", name: "Main bot", role: "main", awake: true }],
    send: (botId, text, via) => {
      if (botId !== "main") throw new Error("No such bot.");
      log.sent.push({ botId, text, via });
      return { messageId: `M${log.sent.length}` };
    },
    interrupt: async (botId) => { if (botId !== "main") return null; log.stopped.push(botId); return true; },
    notice: (text, actions) => { log.notices.push({ text, ...(actions ? { actions } : {}) }); },
    ask: (question) => new Promise((resolve) => log.questions.push({ question, answer: resolve })),
    openPanel: (plugin, panel, title) => { log.panels.push([plugin, panel, title]); },
    appSettings: () => ({ ...settings }),
    shortcutOverrides: () => ({ ...overrides }),
    commandApproval: (botId, command) => (botId === "main" ? { folder: "/home/me", approved: log.approved.includes(command) } : null),
    approveCommand: (botId, command) => botId === "main" && !!log.approved.push(command),
    commandRun: () => null, component: () => null, imageUrls: () => null,
    createBot: () => { throw new Error("not here"); },
    addRoutine: () => "added",
    chat: (botId, limit) => (botId === "main" ? { botId: "main", name: "Main bot", unread: 2, messages: [{ id: "L1", role: "bot", text: "hi", date: 1 }].slice(-limit), tasks: [] } : null),
    botId: (botId) => (botId === "main" ? "MAIN-ID" : null),
    decorated: (botId) => { log.decorated.push(botId); },
    usageView: async () => { log.usageReads += 1; return { day: "2026-11-02", spent: 1.5 } as never; },
    engineCli: (engine) => (engine === "codex" ? { file: "/bin/codex", args: [], env: {} } : null),
    changed: () => {},
    broken: () => {},
    log: () => {},
    workspace: {
      bots: () => [{ id: "main", name: "Main bot", role: "main", parent: null, folder: "Main", engine: "claude", busy: false, asleep: false, avatar: "circle", pinned: false, lastActivity: null, job: null, subagents: 0, guest: false, approvals: 0, status: { key: "asleep", text: "Asleep" }, lastReply: null }],
      memory: (botId) => { known(botId); return { currentStatus: ["Up"], inProgress: [], decided: [], waitingOnYou: [] }; },
      tasks: (botId, limit) => { known(botId); return Array.from({ length: limit }, (_, index) => ({ id: `t${index}` }) as never); },
      taskHistory: (botId, days) => { known(botId); return Array.from({ length: days }, (_, index) => ({ day: `d${index}`, done: index, manual: 0 })); },
      results: (botId, limit) => { known(botId); return Array.from({ length: limit }, (_, index) => ({ label: `r${index}`, url: `https://x/${index}` })); },
      waiting: () => ({ items: [], doing: {} }),
      ignoreWaiting: (botId, text) => { known(botId); log.ignored.push([botId, text]); },
      pendingApprovals: (botId) => { known(botId); return [{ tool: "Bash", text: "ls", at: null }]; },
      face: (botId, look) => { known(botId); return `data:image/svg+xml;base64,${look}`; },
      current: () => ({ botId: "main", engine: "claude", sessionId: "S1", heads: [{ engine: "claude", sessionId: "S1" }], view: "tab", tab: "botling.whiteboard/board" }),
      agyWorkers: (sessionId: string) => sessionId === "agy-s1" ? [{ id: "ag-1", nativeId: "w-1", sessionId: "agy-w1", name: "job", state: "completed", model: null, createdAt: 1, endedAt: 2 }] : [],
    },
    workspaceWatch: (on) => { log.watching.push(on); },
  };
  return { world, log, settings, overrides };
}

const running: Plugins[] = [];
afterEach(async () => { for (const plugins of running.splice(0)) await plugins.shutdown(); });

/** Plugins over a fake host; `ask` and `tell` speak as the host would. */
async function setup(dir: string) {
  const fake = fakeWorld();
  const sent: any[] = [];
  let handlers!: HostHandlers;
  const line = (message: unknown) => handlers.data(JSON.stringify(message) + "\n");
  const node: HostCommand = {
    command: "",
    launch: (_script, _cwd, _env, given) => {
      handlers = given;
      queueMicrotask(() => line({ method: "ready", params: {} }));
      return {
        pid: 4242,
        write: (text) => {
          const message = JSON.parse(text);
          sent.push(message);
          if (message.method === "load") line({ id: message.id, result: { loaded: message.params.plugins.map((spec: any) => spec.name), failed: [] } });
          if (message.method === "shutdown" || message.method === "command") line({ id: message.id, result: null });
        },
        terminate: async () => {},
      };
    },
  };
  const plugins = new Plugins({ dataDir: dir, world: fake.world, node, hostScript: "host.mjs", sealer: testSealer("test-key") });
  running.push(plugins);
  await plugins.start();
  await until(() => plugins.host.running);
  let nextId = 1000;
  const ask = async (method: string, params: unknown): Promise<any> => {
    const id = nextId++;
    line({ id, method, params });
    await until(() => sent.some((m) => m.id === id && m.method === undefined));
    const answer = sent.find((m) => m.id === id && m.method === undefined);
    if (answer.error) throw new Error(answer.error.message);
    return answer.result;
  };
  const tell = (method: string, params: unknown) => line({ method, params });
  return { plugins, sent, ask, tell, ...fake };
}

describe("Host API v3 in the core (plan M5)", () => {
  it("bots.send shows as the plugin's; sending as the user needs the bots permission", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "uptime");
    plugin(dir, "teams", { permissions: ["bots"] });
    const { ask, log } = await setup(dir);
    expect(await ask("bots.send", { plugin: "uptime", bot: "main", text: "site is down" })).toEqual({ messageId: "M1" });
    await expect(ask("bots.send", { plugin: "uptime", bot: "main", text: "x", as: "user" })).rejects.toThrow('Sending as the user needs the "bots" permission');
    expect(await ask("bots.send", { plugin: "teams", bot: "main", text: "as me", as: "user" })).toEqual({ messageId: "M2" });
    await expect(ask("bots.send", { plugin: "uptime", bot: "B9", text: "x" })).rejects.toThrow("No such bot.");
    await expect(ask("bots.send", { plugin: "ghost", bot: "main", text: "x" })).rejects.toThrow("not running");
    expect(log.sent).toEqual([{ botId: "main", text: "site is down", via: "Uptime" }, { botId: "main", text: "as me", via: null }]);
  });

  it("bots.wake sends its prompt as the plugin's; without one it is refused for now", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "uptime");
    const { ask, log } = await setup(dir);
    expect(await ask("bots.wake", { plugin: "uptime", bot: "main", prompt: "Check the site" })).toBeNull();
    await expect(ask("bots.wake", { plugin: "uptime", bot: "main" })).rejects.toThrow(/needs a prompt/);
    expect(log.sent).toEqual([{ botId: "main", text: "Check the site", via: "Uptime" }]);
  });

  it("bots.interrupt needs the bots permission", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "uptime");
    plugin(dir, "teams", { permissions: ["bots"] });
    const { ask, log } = await setup(dir);
    await expect(ask("bots.interrupt", { plugin: "uptime", bot: "main" })).rejects.toThrow('Stopping bots needs the "bots" permission');
    expect(await ask("bots.interrupt", { plugin: "teams", bot: "main" })).toEqual({ stopped: true });
    await expect(ask("bots.interrupt", { plugin: "teams", bot: "B9" })).rejects.toThrow("No such bot.");
    expect(log.stopped).toEqual(["main"]);
  });

  it("ui.notify: a level in the words, and actions that run only the plugin's own commands", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "deploy");
    const { tell, log, sent } = await setup(dir);
    tell("notify", { plugin: "deploy", text: "Deploy failed", level: "error", actions: [{ title: "Retry", command: "deploy.retry" }, { title: "Sneak", command: "other.run" }] });
    tell("notify", { plugin: "deploy", text: "Deployed" });
    await until(() => log.notices.length === 2);
    expect(log.notices.map((notice) => [notice.text, notice.actions?.map((action) => action.label)])).toEqual([["Deploy (error): Deploy failed", ["Retry"]], ["Deploy: Deployed", undefined]]);
    // The command must be registered for it to run.
    tell("registered", { beforeSend: 0, afterReply: 0, commands: ["deploy.retry"], exposed: {} });
    log.notices[0]!.actions![0]!.run();
    await until(() => sent.some((m) => m.method === "command" && m.params.id === "deploy.retry"));
  });

  it("ui.quickPick and ui.input ask in the chat; Cancel answers null; a secret is not asked for there", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "deploy");
    const { ask, log } = await setup(dir);
    const picked = ask("ui.quickPick", { plugin: "deploy", title: "Which site?", items: [{ id: "prod", label: "Production" }, { id: "dev", label: "Dev", detail: "dev.example" }] });
    await until(() => log.questions.length === 1);
    expect(log.questions[0]!.question).toEqual({ text: "Deploy: Which site?", choices: [{ label: "Production" }, { label: "Dev", detail: "dev.example" }, { label: "Cancel" }], typed: false });
    log.questions[0]!.answer({ index: 1 });
    expect(await picked).toBe("dev");
    const cancelled = ask("ui.quickPick", { plugin: "deploy", items: [{ id: "prod", label: "Production" }] });
    await until(() => log.questions.length === 2);
    log.questions[1]!.answer({ index: 1 });
    expect(await cancelled).toBeNull();
    const typed = ask("ui.input", { plugin: "deploy", title: "Release name?", placeholder: "v1.2" });
    await until(() => log.questions.length === 3);
    expect(log.questions[2]!.question).toEqual({ text: "Deploy: Release name? (v1.2)", choices: [{ label: "Cancel" }], typed: true });
    log.questions[2]!.answer({ text: "Autumn" });
    expect(await typed).toBe("Autumn");
    await expect(ask("ui.input", { plugin: "deploy", title: "Token?", secret: true })).rejects.toThrow(/secret setting/);
    await expect(ask("ui.quickPick", { plugin: "deploy", items: [] })).rejects.toThrow(/Not a request/);
  });

  it("ui.openView opens one of the plugin's own panels", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "board", { web: "dist/web.js", contributes: { panels: [{ id: "board.main", title: "The board" }] } });
    const { ask, log } = await setup(dir);
    expect(await ask("ui.openView", { plugin: "board", id: "board.main", args: { tab: 1 } })).toBeNull();
    await expect(ask("ui.openView", { plugin: "board", id: "board.other" })).rejects.toThrow('Plugin "board" has no view "board.other".');
    expect(log.panels).toEqual([["board", "board.main", "The board"]]);
  });

  it("ui.setStatus shows in the plugin's view until it is cleared or the plugin is turned off", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "build");
    const { plugins, tell } = await setup(dir);
    const status = () => plugins.view().plugins.find((p) => p.name === "build")?.status;
    tell("ui.setStatus", { plugin: "build", id: "run", item: { text: "Building", tooltip: "since 10:02", command: "build.show" } });
    tell("ui.setStatus", { plugin: "build", id: "other", item: { text: "x", command: "someone.else" } });
    await until(() => status()?.length === 2);
    expect(status()).toEqual([
      { id: "run", text: "Building", icon: null, tooltip: "since 10:02", command: "build.show" },
      { id: "other", text: "x", icon: null, tooltip: null, command: null },
    ]);
    tell("ui.setStatus", { plugin: "build", id: "other", item: null });
    await until(() => status()?.length === 1);
    plugins.setEnabled("build", false);
    expect(status()).toBeUndefined();
  });

  it("settings.update changes only the plugin's own, non-secret settings, with the right type", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "news", { contributes: { settings: { "news.hour": { type: "number", title: "Hour", default: 8 }, token: { type: "string", title: "Token", secret: true } } } });
    const { plugins, ask } = await setup(dir);
    expect(await ask("settings.update", { plugin: "news", key: "news.hour", value: 9 })).toBeNull();
    expect(plugins.registry.setting("news", "news.hour")).toBe(9);
    await expect(ask("settings.update", { plugin: "news", key: "news.hour", value: "nine" })).rejects.toThrow(/not a number/);
    await expect(ask("settings.update", { plugin: "news", key: "token", value: "x" })).rejects.toThrow(/secrets\.set/);
    await expect(ask("settings.update", { plugin: "news", key: "other.key", value: 1 })).rejects.toThrow(/no setting "other.key"/);
  });

  it("settings.app: Botling's settings go to the host with each plugin, and again when they change", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "news");
    const { plugins, sent, settings } = await setup(dir);
    const lastApp = () => sent.filter((m) => m.method === "load").at(-1).params.plugins[0].app;
    expect(lastApp()).toEqual({ language: "en", botLook: "cute", workerLimit: 4 });
    settings.language = "zh-Hant";
    plugins.appSettingsChanged();
    await until(() => lastApp().language === "zh-Hant");
  });

  it("secrets.get and secrets.set: sealed on disk, each plugin only its own", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "news");
    plugin(dir, "other");
    const { ask } = await setup(dir);
    expect(await ask("secrets.set", { plugin: "news", key: "oauth", value: "tok-secret-1" })).toBeNull();
    expect(await ask("secrets.get", { plugin: "news", key: "oauth" })).toBe("tok-secret-1");
    expect(await ask("secrets.get", { plugin: "other", key: "oauth" })).toBeNull();
    expect(readFileSync(join(dir, "plugin-secrets.json"), "utf8")).not.toContain("tok-secret-1");
    expect(await ask("secrets.set", { plugin: "news", key: "oauth", value: null })).toBeNull();
    expect(await ask("secrets.get", { plugin: "news", key: "oauth" })).toBeNull();
    await expect(ask("secrets.get", { plugin: "news", key: "../x" })).rejects.toThrow(/Not a request/);
  });

  it("keybindings: list what is in effect; a plugin binds only its own commands, never a taken key, and the user's key wins", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "latex", { web: "dist/web.js", contributes: { commands: [{ id: "latex.insert", title: "Insert", key: "cmd+shift+m" }, { id: "latex.other", title: "Other" }] } });
    plugin(dir, "notes", { web: "dist/web.js", contributes: { commands: [{ id: "notes.open", title: "Open", key: "cmd+alt+n" }] } });
    const { plugins, ask, overrides } = await setup(dir);
    const list = async () => (await ask("keybindings.list", { plugin: "latex" })) as { command: string; key: string; source: string }[];
    const of = async (...ids: string[]) => (await list()).filter((binding) => ids.includes(binding.command));
    expect(await of("search", "settings", "latex.insert", "latex.other", "notes.open")).toEqual([
      { command: "search", key: "Mod+K", source: "default" },
      { command: "settings", key: "Mod+Shift+P", source: "user" },
      { command: "latex.insert", key: "Mod+Shift+M", source: "plugin" },
      { command: "notes.open", key: "Mod+Alt+N", source: "plugin" },
    ]);
    expect(await ask("keybindings.set", { plugin: "latex", command: "latex.other", key: "cmd+k" })).toEqual({ ok: false, conflict: "search" });
    expect(await ask("keybindings.set", { plugin: "latex", command: "latex.other", key: "Mod+Shift+P" })).toEqual({ ok: false, conflict: "settings" });
    expect(await ask("keybindings.set", { plugin: "latex", command: "latex.other", key: "Mod+C" })).toEqual({ ok: false, conflict: "copy" });
    expect(await ask("keybindings.set", { plugin: "latex", command: "latex.other", key: "option+cmd+n" })).toEqual({ ok: false, conflict: "notes.open" });
    await expect(ask("keybindings.set", { plugin: "latex", command: "notes.open", key: "Mod+Alt+J" })).rejects.toThrow(/not a command of "latex"/);
    await expect(ask("keybindings.set", { plugin: "latex", command: "latex.other", key: "shift+l" })).rejects.toThrow(/is not a key/);
    expect(await ask("keybindings.set", { plugin: "latex", command: "latex.other", key: "Ctrl+Alt+O" })).toEqual({ ok: true });
    expect(await ask("keybindings.set", { plugin: "latex", command: "latex.insert", key: null })).toEqual({ ok: true });
    // What the app page dispatches: the plugin's key in place of its manifest's.
    expect(plugins.view().keybindings!.filter((binding) => binding.plugin === "latex").map((binding) => [binding.command, binding.key])).toEqual([["latex.other", "Ctrl+Alt+O"]]);
    // A key the user chose wins over the one the plugin set.
    overrides["latex.other"] = "Mod+Alt+L";
    expect(await of("latex.other")).toEqual([{ command: "latex.other", key: "Mod+Alt+L", source: "user" }]);
  });

  it("chat.messages reads a chat's newest lines and needs the messages permission", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "news");
    plugin(dir, "reader", { permissions: ["messages"] });
    const { ask } = await setup(dir);
    await expect(ask("chat.messages", { plugin: "news", bot: "main" })).rejects.toThrow('Reading a chat needs the "messages" permission');
    expect(await ask("chat.messages", { plugin: "reader", bot: "main", limit: 5 })).toEqual({ botId: "main", name: "Main bot", unread: 2, messages: [{ id: "L1", role: "bot", text: "hi", date: 1 }], tasks: [] });
    await expect(ask("chat.messages", { plugin: "reader", bot: "B9" })).rejects.toThrow("No such bot.");
    await expect(ask("chat.messages", { plugin: "reader", bot: "main", limit: 5_000 })).rejects.toThrow(/Not a request/);
  });

  it("chat.decorate keeps what a plugin draws in a chat until it draws again, clears or turns off", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "sum", { web: "dist/web.js" });
    plugin(dir, "headless");
    const { plugins, ask, log } = await setup(dir);
    await expect(ask("chat.decorate", { plugin: "headless", bot: "main", decorations: [] })).rejects.toThrow(/web part/);
    await expect(ask("chat.decorate", { plugin: "sum", bot: "B9", decorations: [] })).rejects.toThrow("No such bot.");
    await expect(ask("chat.decorate", { plugin: "sum", bot: "main", decorations: [{ key: "a" }, { key: "a" }] })).rejects.toThrow(/key of its own/);
    await expect(ask("chat.decorate", { plugin: "sum", bot: "main", decorations: [{ key: "a", fold: ["no spaces allowed"] }] })).rejects.toThrow(/Not a request/);
    await expect(ask("chat.decorate", { plugin: "sum", bot: "main", decorations: [{ key: "a", data: "x".repeat(1_100_000) }] })).rejects.toThrow(/1 MB/);
    expect(await ask("chat.decorate", { plugin: "sum", bot: "main", decorations: [{ key: "a", fold: ["L1", "L2"], tasks: ["T1"], data: { state: "loading" } }, { key: "b", after: "L3" }] })).toBeNull();
    expect(plugins.decorations("MAIN-ID")).toEqual([
      // `tasks` is still accepted from an older plugin, and dropped: task cards are gone.
      { plugin: "sum", key: "a", fold: ["L1", "L2"], data: { state: "loading" } },
      { plugin: "sum", key: "b", after: "L3" },
    ]);
    expect(log.decorated).toEqual(["MAIN-ID"]);
    // The same again changes nothing; [] clears.
    await ask("chat.decorate", { plugin: "sum", bot: "main", decorations: [{ key: "a", fold: ["L1", "L2"], tasks: ["T1"], data: { state: "loading" } }, { key: "b", after: "L3" }] });
    expect(log.decorated).toEqual(["MAIN-ID"]);
    await ask("chat.decorate", { plugin: "sum", bot: "main", decorations: [] });
    expect(plugins.decorations("MAIN-ID")).toEqual([]);
    // Turned off: what it drew goes, and the chat is told.
    await ask("chat.decorate", { plugin: "sum", bot: "main", decorations: [{ key: "c", fold: ["L1"] }] });
    plugins.setEnabled("sum", false);
    expect(plugins.decorations("MAIN-ID")).toEqual([]);
    expect(log.decorated).toEqual(["MAIN-ID", "MAIN-ID", "MAIN-ID", "MAIN-ID"]);
  });

  it("engines.cli says how Botling starts an engine's CLI", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "sum");
    const { ask } = await setup(dir);
    expect(await ask("engines.cli", { plugin: "sum", engine: "codex" })).toEqual({ file: "/bin/codex", args: [], env: {} });
    expect(await ask("engines.cli", { plugin: "sum", engine: "claude" })).toBeNull();
    await expect(ask("engines.cli", { plugin: "sum", engine: "agy" })).rejects.toThrow(/Not a request/);
  });

  it("events go to the host only for the names some plugin listens to", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "watch");
    const { plugins, sent, tell } = await setup(dir);
    plugins.event("turnFinished", { botId: "main", ok: true, reply: "a" });
    tell("registered", { beforeSend: 0, afterReply: 0, commands: [], exposed: {}, events: ["turnFinished"] });
    await until(() => plugins.host.events.has("turnFinished"));
    plugins.event("turnFinished", { botId: "main", ok: true, reply: "b" });
    plugins.event("workerDone", { botId: "main", workerId: "w", status: "completed", report: "" });
    expect(sent.filter((m) => m.method === "event")).toEqual([{ method: "event", params: { name: "turnFinished", data: { botId: "main", ok: true, reply: "b" } } }]);
  });

  it("events while the host is starting are told once its plugins have loaded", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "sum");
    const sent: any[] = [];
    let handlers!: HostHandlers;
    let answerLoad: (() => void) | null = null;
    const line = (message: unknown) => handlers.data(JSON.stringify(message) + "\n");
    const node: HostCommand = {
      command: "",
      launch: (_script, _cwd, _env, given) => {
        handlers = given;
        queueMicrotask(() => line({ method: "ready", params: {} }));
        return {
          pid: 4243,
          write: (text) => {
            const message = JSON.parse(text);
            sent.push(message);
            if (message.method === "load") answerLoad = () => {
              line({ method: "registered", params: { beforeSend: 0, afterReply: 0, commands: [], exposed: {}, events: ["chatRead"] } });
              line({ id: message.id, result: { loaded: ["sum"], failed: [] } });
            };
          },
          terminate: async () => {},
        };
      },
    };
    const plugins = new Plugins({ dataDir: dir, world: fakeWorld().world, node, hostScript: "host.mjs", sealer: testSealer("test-key") });
    running.push(plugins);
    await plugins.start();
    await until(() => answerLoad);
    plugins.event("chatRead", { botId: "main", unread: 5, through: "L9" });
    plugins.event("turnFinished", { botId: "main", ok: true, reply: "nobody listens" });
    expect(sent.filter((m) => m.method === "event")).toEqual([]);
    answerLoad!();
    await until(() => plugins.host.running);
    expect(sent.filter((m) => m.method === "event")).toEqual([{ method: "event", params: { name: "chatRead", data: { botId: "main", unread: 5, through: "L9" } } }]);
  });
});

describe("usage for plugins", () => {
  it("answers usage.view with what the core reads (the same as the usage.view command), for any loaded plugin", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "meter");
    const { ask, log } = await setup(dir);
    expect(await ask("usage.view", { plugin: "meter" })).toEqual({ day: "2026-11-02", spent: 1.5 });
    expect(log.usageReads).toBe(1);
    await expect(ask("usage.view", { plugin: "ghost" })).rejects.toThrow("not running");
  });
});

describe("workspace for plugins (plan W1)", () => {
  it("answers each read from the core's workspace, with limits kept in range", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "board");
    const { ask } = await setup(dir);
    expect(await ask("workspace.bots", { plugin: "board" })).toEqual([expect.objectContaining({ id: "main", folder: "Main", engine: "claude" })]);
    expect(await ask("workspace.memory", { plugin: "board", bot: "main" })).toEqual({ currentStatus: ["Up"], inProgress: [], decided: [], waitingOnYou: [] });
    expect(await ask("workspace.tasks", { plugin: "board", bot: "main" })).toHaveLength(100);
    expect(await ask("workspace.tasks", { plugin: "board", bot: "main", limit: 3 })).toHaveLength(3);
    expect(await ask("workspace.tasks", { plugin: "board", bot: "main", limit: 5000 })).toHaveLength(100);
    expect(await ask("workspace.taskHistory", { plugin: "board", bot: "main", days: 7 })).toHaveLength(7);
    expect(await ask("workspace.taskHistory", { plugin: "board", bot: "main", days: 99 })).toHaveLength(14);
    expect(await ask("workspace.results", { plugin: "board", bot: "main" })).toHaveLength(12);
    expect(await ask("workspace.results", { plugin: "board", bot: "main", limit: 2 })).toEqual([{ label: "r0", url: "https://x/0" }, { label: "r1", url: "https://x/1" }]);
    expect(await ask("workspace.waiting", { plugin: "board" })).toEqual({ items: [], doing: {} });
    expect(await ask("workspace.pendingApprovals", { plugin: "board", bot: "main" })).toEqual([{ tool: "Bash", text: "ls", at: null }]);
    expect(await ask("workspace.face", { plugin: "board", bot: "main", look: "cute" })).toBe("data:image/svg+xml;base64,cute");
    expect(await ask("workspace.current", { plugin: "board" })).toEqual({ botId: "main", engine: "claude", sessionId: "S1", heads: [{ engine: "claude", sessionId: "S1" }], view: "tab", tab: "botling.whiteboard/board" });
    await expect(ask("workspace.current", { plugin: "ghost" })).rejects.toThrow("not running");
    await expect(ask("workspace.face", { plugin: "board", bot: "main", look: "scary" })).rejects.toThrow(/Not a request/);
    await expect(ask("workspace.memory", { plugin: "board", bot: "B9" })).rejects.toThrow("No such bot.");
    await expect(ask("workspace.bots", { plugin: "ghost" })).rejects.toThrow("not running");
  });

  it("agyUsage reads an Antigravity conversation from Botling's agy profiles; agyQuota says unknown without a file sign-in", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "meter");
    const c = conversation(join(dir, "agy-acp", "profile-1"), "agy-s1");
    c.add(generation({ usage: usage({ input: 40, output: 9, cacheRead: 100 }), slug: "gemini-3.8-flash-high" }));
    c.db.close();
    const { ask } = await setup(dir);
    expect(await ask("workspace.agyUsage", { plugin: "meter", sessionId: "agy-s1" })).toMatchObject({ sessionId: "agy-s1", retries: 0, models: ["gemini-3.8-flash-high"], total: { input: 40, output: 9, cacheRead: 100, cacheWrite: 0, reasoning: 0 } });
    expect(await ask("workspace.agyUsage", { plugin: "meter", sessionId: "../agy-s1" })).toBeNull();
    // A worker's conversation lives in its own folder: found by session id, and by worker id.
    const w = conversation(join(dir, "agy-acp", "profile-1", "workers", "w-1"), "agy-w1");
    w.add(generation({ usage: usage({ input: 12, output: 3 }) }));
    w.db.close();
    expect(await ask("workspace.agyUsage", { plugin: "meter", sessionId: "agy-w1" })).toMatchObject({ sessionId: "agy-w1", total: { input: 12, output: 3 } });
    expect(await ask("workspace.agyWorkerUsage", { plugin: "meter", workerId: "w-1" })).toMatchObject({ sessionId: "agy-w1", total: { input: 12, output: 3 } });
    expect(await ask("workspace.agyWorkerUsage", { plugin: "meter", workerId: "w-none" })).toBeNull();
    expect(await ask("workspace.agyWorkers", { plugin: "meter", sessionId: "agy-s1" })).toEqual([{ id: "ag-1", nativeId: "w-1", sessionId: "agy-w1", name: "job", state: "completed", model: null, createdAt: 1, endedAt: 2 }]);
    expect(await ask("workspace.agyWorkers", { plugin: "meter", sessionId: "other" })).toEqual([]);
    expect(await ask("workspace.agyQuota", { plugin: "meter" })).toEqual({ status: "unavailable", reason: "unsupported_connection", source: "antigravity_acp" });
    await expect(ask("workspace.agyUsage", { plugin: "ghost", sessionId: "agy-s1" })).rejects.toThrow("not running");
  });

  it("ignoreWaiting sets an item aside, as the app's own I-know does (not an answer)", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "board");
    const { ask, log } = await setup(dir);
    expect(await ask("workspace.ignoreWaiting", { plugin: "board", bot: "main", text: "Pick a domain" })).toBeNull();
    await expect(ask("workspace.ignoreWaiting", { plugin: "board", bot: "main", text: "" })).rejects.toThrow(/Not a request/);
    expect(log.ignored).toEqual([["main", "Pick a domain"]]);
  });

  it("watches only while some plugin listens, says so the moment the host does, and tells the host each change", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "board");
    const { plugins, sent, tell, log } = await setup(dir);
    expect(log.watching).toEqual([]);
    plugins.workspaceChanged({ stamp: "e:1", botIds: ["main"], kinds: ["tasks"] });
    tell("registered", { beforeSend: 0, afterReply: 0, commands: [], exposed: {}, events: ["workspace.changed"] });
    await until(() => log.watching.length === 1);
    expect(log.watching).toEqual([true]);
    expect(plugins.watchingWorkspace).toBe(true);
    plugins.workspaceChanged({ stamp: "e:2", botIds: ["main"], kinds: ["memory"] });
    expect(sent.filter((m) => m.method === "event")).toEqual([{ method: "event", params: { name: "workspace.changed", data: { stamp: "e:2", botIds: ["main"], kinds: ["memory"] } } }]);
    // The same again changes nothing; nobody listening any more stops it.
    tell("registered", { beforeSend: 0, afterReply: 0, commands: [], exposed: {}, events: ["workspace.changed", "turnFinished"] });
    tell("registered", { beforeSend: 0, afterReply: 0, commands: [], exposed: {}, events: [] });
    await until(() => log.watching.length === 2);
    expect(log.watching).toEqual([true, false]);
    expect(plugins.watchingWorkspace).toBe(false);
  });
});

describe("main-area tabs (plan W2)", () => {
  it("a plugin's mainTab views are tabs, with their roles, while it is on and has a web part to draw them; the tab's frame gets that web part", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "board", { web: "dist/web.js", contributes: { views: [{ id: "board.wall", title: "Wall", where: "mainTab", forRole: "main", icon: "people" }, { id: "board.side", title: "Side" }] } });
    plugin(dir, "headless", { contributes: { views: [{ id: "headless.tab", title: "Tab", where: "mainTab" }] } });
    const { plugins } = await setup(dir);
    expect(plugins.view().mainTabs).toEqual([{ plugin: "board", id: "board.wall", title: "Wall", icon: "people", forRole: "main" }]);
    expect(plugins.panel("board", "board.wall")).toEqual({ title: "Wall", source: "export function activate() {}", settings: {} });
    expect(() => plugins.panel("headless", "headless.tab")).toThrow(/No panel/);
    plugins.setEnabled("board", false);
    expect(plugins.view().mainTabs).toEqual([]);
    expect(() => plugins.panel("board", "board.wall")).toThrow(/No panel/);
  });
});


describe("a bot's note for plugins (the Note tab)", () => {
  it("notes.read makes and reads only that bot's note; notes.write saves it, refusing a stale base; both need \"files\"", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "note", { permissions: ["files"] });
    plugin(dir, "nosy");
    const { ask, world } = await setup(dir);
    const project = join(dir, "project");
    world.botNote = (botId) => (botId === "main" ? join(project, ".bot", "note.md") : null);
    await expect(ask("notes.read", { plugin: "nosy", bot: "main" })).rejects.toThrow('Reading a bot\'s note needs the "files" permission');
    await expect(ask("notes.write", { plugin: "nosy", bot: "main", text: "x" })).rejects.toThrow('Changing a bot\'s note needs the "files" permission');
    await expect(ask("notes.read", { plugin: "note", bot: "B9" })).rejects.toThrow("No such bot.");
    const first = await ask("notes.read", { plugin: "note", bot: "main" });
    expect(first).toEqual({ path: join(project, ".bot", "note.md"), text: "", mtime: expect.any(Number) });
    // A path in the ask changes nothing: the core alone says where the note is.
    const saved = await ask("notes.write", { plugin: "note", bot: "main", text: "# Ideas\n", base: first.mtime, path: join(dir, "elsewhere.md") });
    expect(saved).toEqual({ saved: true, mtime: expect.any(Number) });
    expect(readFileSync(join(project, ".bot", "note.md"), "utf8")).toBe("# Ideas\n");
    expect(existsSync(join(dir, "elsewhere.md"))).toBe(false);
    writeFileSync(join(project, ".bot", "note.md"), "the bot's edit");
    utimesSync(join(project, ".bot", "note.md"), Date.now() / 1000 + 5, Date.now() / 1000 + 5);
    expect(await ask("notes.write", { plugin: "note", bot: "main", text: "mine", base: saved.mtime })).toEqual({ saved: false, text: "the bot's edit", mtime: expect.any(Number) });
    expect(readFileSync(join(project, ".bot", "note.md"), "utf8")).toBe("the bot's edit");
    await expect(ask("notes.write", { plugin: "note", bot: "main", text: 7 })).rejects.toThrow();
  });

  it("note pictures: importAsset copies only a picture the note links (or bytes), assetUrls shows only its own refs, localizeImages rewrites links; all need \"files\"", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "note", { permissions: ["files"] });
    plugin(dir, "nosy");
    const { ask, world } = await setup(dir);
    const note = join(dir, "project", ".bot", "note.md");
    const other = join(dir, "sub", "note.md");
    world.botNote = (botId) => (botId === "main" ? note : botId === "S1" ? other : null);
    const served: string[] = [];
    world.imageUrl = (path, type) => { served.push(`${type} ${path}`); return `botling-card://image/${served.length}`; };
    mkdirSync(join(dir, "figs"), { recursive: true });
    const fig = join(dir, "figs", "reward.png");
    const stray = join(dir, "figs", "private.png");
    writeFileSync(fig, "png bytes");
    writeFileSync(stray, "private bytes");
    for (const method of ["notes.importAsset", "notes.assetUrls", "notes.localizeImages"]) {
      await expect(ask(method, { plugin: "nosy", bot: "main", path: fig, refs: [] })).rejects.toThrow(/permission|Not a request/);
    }
    await expect(ask("notes.importAsset", { plugin: "note", bot: "B9", path: fig })).rejects.toThrow("No such bot.");
    // A picture the note does not link is never read.
    await expect(ask("notes.importAsset", { plugin: "note", bot: "main", path: stray })).rejects.toThrow("Only a picture the note links");
    writeFileSync(note, `# Plot\n![reward](file://${fig})\n![gone](${join(dir, "figs", "gone.png")})\n`);
    const imported = await ask("notes.importAsset", { plugin: "note", bot: "main", path: `file://${fig}` });
    expect(imported).toEqual({ ref: expect.stringMatching(/^note-assets\/[0-9a-f]{32}\.png$/), url: "botling-card://image/1" });
    expect(served[0]).toBe(`image/png ${join(realpathSync(dir), "project", ".bot", imported.ref)}`);
    await expect(ask("notes.importAsset", { plugin: "note", bot: "main", path: join(dir, "figs", "gone.png") })).rejects.toThrow("No such picture");
    // A paste: base64 bytes and a name for the extension.
    const pasted = await ask("notes.importAsset", { plugin: "note", bot: "main", data: Buffer.from("pasted").toString("base64"), name: "image.png" });
    expect(pasted.ref).toMatch(/^note-assets\/[0-9a-f]{32}\.png$/);
    await expect(ask("notes.importAsset", { plugin: "note", bot: "main", data: "aGk=", name: "page.html" })).rejects.toThrow("Only png");
    // Refs: only the note's own folder; another bot's note does not reach them.
    expect(await ask("notes.assetUrls", { plugin: "note", bot: "main", refs: [imported.ref, `./${pasted.ref}`, "note-assets/../note.md", fig] }))
      .toEqual({ [imported.ref]: expect.stringMatching(/^botling-card:\/\/image\//), [`./${pasted.ref}`]: expect.stringMatching(/^botling-card:\/\/image\//), "note-assets/../note.md": null, [fig]: null });
    expect(await ask("notes.assetUrls", { plugin: "note", bot: "S1", refs: [imported.ref] })).toEqual({ [imported.ref]: null });
    // Localize: the note's links become refs; a stale base is refused.
    const { mtime } = await ask("notes.read", { plugin: "note", bot: "main" });
    expect(await ask("notes.localizeImages", { plugin: "note", bot: "main", base: mtime - 1000 })).toEqual({ saved: false, text: expect.any(String), mtime, copied: [], missing: [], failed: [] });
    const done = await ask("notes.localizeImages", { plugin: "note", bot: "main", base: mtime });
    expect(done).toEqual({
      saved: true, mtime: expect.any(Number), failed: [],
      text: `# Plot\n![reward](${imported.ref})\n![gone](${join(dir, "figs", "gone.png")})\n`,
      copied: [{ from: `file://${fig}`, ref: imported.ref }], missing: [join(dir, "figs", "gone.png")],
    });
    expect(readFileSync(note, "utf8")).toBe(done.text);
  });

  it("a note read by a plugin is watched: a change on disk is the noteChanged event (bot and mtime, never the words)", async () => {
    const dir = tempDir("plugin-api");
    plugin(dir, "note", { permissions: ["files"] });
    const { ask, world, tell, plugins, sent } = await setup(dir);
    const file = join(dir, "project", ".bot", "note.md");
    world.botNote = (botId) => (botId === "main" ? file : null);
    tell("registered", { beforeSend: 0, afterReply: 0, commands: [], exposed: {}, events: ["noteChanged"] });
    await until(() => plugins.host.events.has("noteChanged"));
    const { mtime } = await ask("notes.read", { plugin: "note", bot: "main" });
    await ask("notes.write", { plugin: "note", bot: "main", text: "editor", base: mtime });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(sent.filter((m) => m.method === "event")).toEqual([]);
    writeFileSync(file, "bot");
    utimesSync(file, Date.now() / 1000 + 5, Date.now() / 1000 + 5);
    await until(() => sent.some((m) => m.method === "event"));
    expect(sent.filter((m) => m.method === "event")).toEqual([{ method: "event", params: { name: "noteChanged", data: { botId: "main", mtime: expect.any(Number) } } }]);
  });
});
