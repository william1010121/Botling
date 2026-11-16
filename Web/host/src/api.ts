// The object a plugin's `activate(api)` receives (plugin-platform.md §4.2): one per plugin, its name
// bound in. `BotlingApi` is the 3.x name; `CcbHost` (2.x) is the same object, so old plugins keep
// working: its old members (`name`, `notify`, `web.handle`, `storage.dir`) stay beside the new.
// What needs Botling is asked over the host's JSON-RPC (`request`, `notify`), always naming the plugin;
// the core checks every ask (desktop/src/core/plugins/index.ts). `exec` and `spawn` run here.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exec, spawn } from "./exec";
import { EVENT_NAMES, WORKSPACE_EVENT } from "./api-types";
import type {
  AgyQuota, AgyUsage, AgyWorker, AppSettingKey, AppState, BotInfo, BotNote, BotSummary, CardLibrary, CardState, ChatData, CommandRun, CurrentChat,
  Dispose, EngineCli, JSONValue, Keybinding, NoteAsset, NoteCardState, NoteComponent, NoteLocalized, NoteOutline, NoteParsed, NoteSave,
  RoutinesList, SessionBot, ShownCard, TaskView, UsageView, WaitingView,
} from "./api-types";
import type { BotlingApi, HostSide, Loaded } from "./api-types-botling";

// Everything api.ts exported before the split is still exported from here (the types and constants live in the two files below).
export * from "./api-types";
export * from "./api-types-botling";

/** A request whose promise a plugin may ignore (2.x `bots.send` returned nothing): no unhandled rejection then. */
function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

export function createApi(host: HostSide, plugin: Loaded): BotlingApi {
  const name = plugin.spec.name;
  const own = (dispose: Dispose): Dispose => {
    if (host.own) return host.own(plugin, dispose);
    plugin.disposers.push(dispose);
    return dispose;
  };
  const remove = <T>(list: T[], item: T) => own(() => {
    const at = list.indexOf(item);
    if (at !== -1) list.splice(at, 1);
  });
  const announceLater = () => host.announceLater(plugin);
  // The code this instance was loaded from: a request says so, and the core refuses one from code it has since replaced.
  const code = plugin.spec.fingerprint;
  const ask = (method: string, params: Record<string, JSONValue> = {}) => host.request(method, { ...params, plugin: name, code });
  const limit = (opts: { limit?: number } | undefined) => (opts?.limit === undefined ? {} : { limit: opts.limit });
  let stored: Record<string, unknown> | null = null;
  const storageFile = join(plugin.spec.storageDir, "storage.json");
  const storage = () => {
    if (stored) return stored;
    try { stored = JSON.parse(readFileSync(storageFile, "utf8")); } catch { stored = {}; }
    return stored!;
  };
  mkdirSync(plugin.spec.storageDir, { recursive: true });
  const expose = (method: string, fn: (params: unknown) => unknown): Dispose => {
    plugin.web.set(method, fn);
    plugin.exposed.add(method);
    announceLater();
    return own(() => {
      plugin.web.delete(method);
      plugin.exposed.delete(method);
      announceLater();
    });
  };
  const notify = (text: string, opts: { level?: string; actions?: { title: string; command: string }[] } = {}) =>
    host.notify("notify", { plugin: name, text: String(text), ...(opts.level ? { level: opts.level } : {}), ...(opts.actions?.length ? { actions: opts.actions } : {}) });
  const subscriptions: Dispose[] = [];
  own(() => { for (const dispose of subscriptions.splice(0).reverse()) { try { dispose(); } catch { /* the rest still go */ } } });
  own(() => plugin.children.endAll());
  const where = { get cwd() { return plugin.spec.storageDir; } };

  return {
    plugin: {
      name, version: plugin.spec.version, dir: plugin.spec.dir ?? dirname(plugin.spec.main), storageDir: plugin.spec.storageDir,
      ...(plugin.spec.appDataDir ? { appDataDir: plugin.spec.appDataDir } : {}),
    },
    subscriptions,
    name,
    exec: (command, opts = {}) => exec(String(command), opts, where, plugin.children),
    spawn: (file, args, opts = {}) => spawn(String(file), (args ?? []).map(String), opts, where, plugin.children),
    bots: {
      list: async () => (await ask("bots.list")) as BotInfo[],
      folder: async (botId) => (await ask("bots.folder", { bot: botId })) as string | null,
      send: (botId, text, opts = {}) => quiet(ask("bots.send", { bot: botId, text, as: opts.as === "user" ? "user" : "plugin" }) as Promise<{ messageId: string }>),
      wake: async (botId, prompt) => { await ask("bots.wake", { bot: botId, ...(prompt === undefined ? {} : { prompt }) }); },
      interrupt: async (botId) => { await ask("bots.interrupt", { bot: botId }); },
      create: async (bot) => (await ask("bots.create", { name: bot?.name, job: bot?.job, avatar: bot?.avatar, parent: bot?.parent, instructions: bot?.instructions, delegation: bot?.delegation })) as BotInfo,
      onReply: (fn) => {
        plugin.replyListeners.push(fn);
        return remove(plugin.replyListeners, fn);
      },
    },
    hooks: {
      beforeSend: (fn) => {
        plugin.beforeSend.push(fn);
        announceLater();
        return remove(plugin.beforeSend, fn);
      },
      afterReply: (fn) => {
        plugin.afterReply.push(fn);
        announceLater();
        return remove(plugin.afterReply, fn);
      },
    },
    commands: {
      register: (id, run) => {
        plugin.commands.set(id, run);
        announceLater();
        return own(() => plugin.commands.delete(id));
      },
    },
    keybindings: {
      list: async () => (await ask("keybindings.list")) as Keybinding[],
      set: async (command, key) => (await ask("keybindings.set", { command, key })) as { ok: true } | { ok: false; conflict: string },
    },
    routines: {
      add: async (botId, cron, task) => { await ask("routines.add", { bot: botId, cron, task }); },
      list: async (botId) => (await ask("routines.list", { bot: botId })) as RoutinesList,
      change: async (botId, operation, id) => (await ask("routines.change", { bot: botId, operation, id })) as RoutinesList,
    },
    usage: { view: async () => (await ask("usage.view")) as UsageView },
    app: {
      state: async () => (await ask("app.state")) as AppState,
      installAndRestart: async (command, log) => { await ask("app.installAndRestart", { command, log }); },
      captureWindow: async () => (await ask("app.captureWindow")) as string | null,
      card: async (text, opts = {}) => ((await ask("app.card", { text, ...(opts.choices ? { choices: opts.choices } : {}), ...(opts.source ? { source: opts.source } : {}) })) as { index: number } | null)?.index ?? null,
      tell: async (bot, kind, text, files) => { await ask("app.tell", { bot, kind, text, ...(files?.length ? { files } : {}) }); },
      briefing: async (briefing) => { await ask("app.briefing", { briefing }); },
    },
    studio: { request: async (method, params) => ask(`studio.${String(method)}`, (params ?? {}) as Record<string, JSONValue>) },
    notes: {
      read: async (botId) => (await ask("notes.read", { bot: botId })) as BotNote,
      write: async (botId, text, opts = {}) => (await ask("notes.write", { bot: botId, text, ...(opts.base === undefined ? {} : { base: opts.base }) })) as NoteSave,
      importAsset: async (botId, source) => (await ask("notes.importAsset", { bot: botId, ...("path" in source ? { path: source.path } : { data: source.data, name: source.name }) })) as NoteAsset & { url: string },
      assetUrls: async (botId, refs) => (await ask("notes.assetUrls", { bot: botId, refs })) as Record<string, string | null>,
      localizeImages: async (botId, opts = {}) => (await ask("notes.localizeImages", { bot: botId, ...(opts.base === undefined ? {} : { base: opts.base }) })) as NoteLocalized,
      parse: async (text, picks, opts = {}) => (await ask("notes.parse", { text, ...(picks ? { picks } : {}), ...(opts.lines ? { lines: true } : {}) })) as NoteParsed,
      outline: async (botId, opts = {}) => (await ask("notes.outline", { bot: botId, ...(opts.text === undefined ? {} : { text: opts.text }) })) as NoteOutline,
      mode: async (botId, mode) => (await ask("notes.mode", { bot: botId, ...(mode ? { mode } : {}) })) as { mode: "db" | "file"; reason: string | null },
      components: async (botId) => (await ask("notes.components", { bot: botId })) as { folder: string; readOnly: boolean; components: NoteComponent[] },
      cards: async (botId, opts = {}) => (await ask("notes.cards", { bot: botId, ...(opts.text === undefined ? {} : { text: opts.text }) })) as NoteCardState[],
      runCard: async (botId, key, opts = {}) => (await ask("notes.runCard", { bot: botId, key, ...(opts.force ? { force: true } : {}), ...(opts.text === undefined ? {} : { text: opts.text }) })) as { started: boolean; needsApproval: { command: string; folder: string; card: string } | null },
    },
    sessions: {
      setFolder: async (botId, folder, reason) => { await ask("sessions.folder", { bot: botId, folder, ...(reason ? { reason } : {}) }); },
      syncFolders: async (folders) => { await ask("sessions.folders", { folders }); },
      bots: async () => (await ask("sessions.bots")) as SessionBot[],
    },
    workspace: {
      bots: async () => (await ask("workspace.bots")) as BotSummary[],
      memory: async (botId) => (await ask("workspace.memory", { bot: botId })) as never,
      tasks: async (botId, opts) => (await ask("workspace.tasks", { bot: botId, ...limit(opts) })) as TaskView[],
      taskHistory: async (botId, days) => (await ask("workspace.taskHistory", { bot: botId, days })) as never,
      results: async (botId, opts) => (await ask("workspace.results", { bot: botId, ...limit(opts) })) as never,
      waiting: async () => (await ask("workspace.waiting")) as WaitingView,
      ignoreWaiting: async (botId, text) => { await ask("workspace.ignoreWaiting", { bot: botId, text }); },
      pendingApprovals: async (botId) => (await ask("workspace.pendingApprovals", { bot: botId })) as never,
      face: async (botId, look) => (await ask("workspace.face", { bot: botId, look })) as string,
      current: async () => (await ask("workspace.current")) as CurrentChat | null,
      agyUsage: async (sessionId) => (await ask("workspace.agyUsage", { sessionId })) as AgyUsage | null,
      agyWorkers: async (sessionId) => (await ask("workspace.agyWorkers", { sessionId })) as AgyWorker[],
      agyWorkerUsage: async (workerId) => (await ask("workspace.agyWorkerUsage", { workerId })) as AgyUsage | null,
      agyQuota: async () => (await ask("workspace.agyQuota")) as AgyQuota,
      component: async (botId, name, spec) => (await ask("workspace.component", { bot: botId, name, ...(spec?.data !== undefined ? { data: spec.data } : {}), ...(spec?.command !== undefined ? { command: spec.command } : {}) })) as never,
      onChange: (fn) => {
        const list = plugin.events.get(WORKSPACE_EVENT) ?? [];
        list.push(fn as (data: unknown) => void);
        plugin.events.set(WORKSPACE_EVENT, list);
        // Botling starts watching when told, so it is told before any read this plugin makes next:
        // what that read gives is then never older than the watch's start (spec/models/workspace).
        host.announceNow(plugin);
        const off = remove(list, fn as (data: unknown) => void);
        return own(() => { off(); announceLater(); });
      },
    },
    replyTags: {
      on: (tag, fn) => {
        const list = plugin.replyTags.get(String(tag)) ?? [];
        list.push(fn);
        plugin.replyTags.set(String(tag), list);
        return remove(list, fn);
      },
    },
    approvals: {
      check: async (botId, command) => (await ask("approvals.check", { bot: botId, command })) as { folder: string; approved: boolean },
      state: async (botId, command, key) => (await ask("approvals.state", { bot: botId, command, key })) as CommandRun,
      run: async (botId, command, key, opts) => (await ask("approvals.run", { bot: botId, command, key, ...(opts?.minIntervalMs === undefined ? {} : { minIntervalMs: opts.minIntervalMs }) })) as CommandRun & { started: boolean },
    },
    cards: {
      library: async (botId) => (await ask("cards.library", { bot: botId })) as CardLibrary | null,
      shown: async (botId) => ((await ask("cards.shown", { bot: botId })) ?? []) as ShownCard[],
      states: async (botId, cards) => ((await ask("cards.states", { bot: botId, cards: cards as JSONValue })) ?? []) as CardState[],
      run: async (botId, card, command, force) => (await ask("cards.run", { bot: botId, card, command, force })) === true,
      ask: async (botId, card, command, component) => (await ask("cards.ask", { bot: botId, card, command, name: component })) as never,
      setNotes: async (botId, notes) => { await ask("cards.setNotes", { bot: botId, notes: notes as JSONValue }); },
      legacyPins: async (botId) => (await ask("cards.legacyPins", { bot: botId })) as unknown[] | null,
    },
    settings: {
      get: <T>(key: string) => plugin.spec.settings[key] as T,
      update: async (key, value) => { await ask("settings.update", { key, value: value === undefined ? null : value }); },
      onChange: (key, fn) => {
        const list = plugin.settingHandlers.get(key) ?? [];
        list.push(fn);
        plugin.settingHandlers.set(key, list);
        return remove(list, fn);
      },
      app: <T>(key: AppSettingKey) => (plugin.spec.app?.[key] ?? null) as T,
    },
    storage: {
      dir: plugin.spec.storageDir,
      get: (key) => storage()[key],
      set: (key, value) => {
        storage()[key] = value;
        writeFileSync(storageFile, JSON.stringify(storage(), null, 2));
      },
    },
    secrets: {
      get: async (key) => (await ask("secrets.get", { key })) as string | null,
      set: async (key, value) => { await ask("secrets.set", { key, value: value ?? null }); },
    },
    ui: {
      notify: (text, opts) => notify(text, opts),
      quickPick: async (items, opts = {}) => (await ask("ui.quickPick", { items, ...(opts.title ? { title: opts.title } : {}) })) as never,
      input: async (opts) => (await ask("ui.input", { title: opts?.title, ...(opts?.placeholder ? { placeholder: opts.placeholder } : {}), ...(opts?.secret ? { secret: true } : {}) })) as string | null,
      openView: async (id, args) => { await ask("ui.openView", { id, ...(args === undefined ? {} : { args }) }); },
      takeover: async (view, opts = {}) => { await ask("ui.takeover", { view, ...(opts.bot ? { bot: opts.bot } : {}), ...(opts.wide ? { wide: true } : {}) }); },
      showTab: async (botId, viewId, on, opts = {}) => { await ask("ui.showTab", { bot: botId, view: viewId, on: on === true, ...(opts.open ? { open: true } : {}) }); },
      setStatus: (id, item) => host.notify("ui.setStatus", { plugin: name, id, item: item ?? null }),
      expose,
      emit: (event, data, opts = {}) => host.notify("ui.emit", { plugin: name, name: String(event), data: data === undefined ? null : data, ...(opts.botId ? { botId: opts.botId } : {}) }),
    },
    workers: {
      start: async (opts) => (await ask("workers.start", opts as unknown as Record<string, JSONValue>)) as { taskId: string; run: number },
      send: async (taskId, message) => (await ask("workers.send", { taskId, message })) as { run: number; how: string },
      cancel: async (taskId) => (await ask("workers.cancel", { taskId })) as { stopped: boolean },
    },
    events: {
      on: (event, fn) => {
        if (!EVENT_NAMES.includes(event)) throw new Error(`No event "${String(event)}" (there are ${EVENT_NAMES.join(", ")}).`);
        const list = plugin.events.get(event) ?? [];
        // `workerReport` is told to the plugin that started the worker only (the core sends it to that plugin's host; a shared host also checks).
        const listener = event === "workerReport" ? (data: unknown) => { if ((data as { startedBy?: unknown } | null)?.startedBy === name) (fn as (data: unknown) => void)(data); } : fn as (data: unknown) => void;
        list.push(listener);
        plugin.events.set(event, list);
        announceLater();
        const off = remove(list, listener);
        return own(() => { off(); announceLater(); });
      },
    },
    chat: {
      messages: async (botId, opts = {}) => (await ask("chat.messages", { bot: botId, ...(opts.limit === undefined ? {} : { limit: opts.limit }) })) as ChatData,
      decorate: async (botId, decorations) => { await ask("chat.decorate", { bot: botId, decorations: decorations as JSONValue }); },
      setData: async (botId, data) => { await ask("chat.setData", { bot: botId, data: data as JSONValue }); },
    },
    content: {
      read: async (ref, offset, length) => {
        const { data } = (await ask("content.read", { ref: ref as unknown as JSONValue, offset, length })) as { data: string };
        const buf = Buffer.from(data, "base64");
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      },
      fetch: async (ref) => {
        const { path } = (await ask("content.fetch", { ref: ref as unknown as JSONValue })) as { path: string };
        return path;
      },
    },
    engines: {
      cli: async (engine) => (await ask("engines.cli", { engine })) as EngineCli | null,
    },
    web: { handle: expose },
    notify: (text) => notify(text),
  };
}
