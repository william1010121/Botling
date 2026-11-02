// The object a plugin's `activate(api)` receives (plugin-platform.md §4.2): one per plugin, its name
// bound in. `BotlingApi` is the 3.x name; `CcbHost` (2.x) is the same object, so old plugins keep
// working: its old members (`name`, `notify`, `web.handle`, `storage.dir`, `browser`) stay beside the new.
// What needs Botling is asked over the host's JSON-RPC (`request`, `notify`), always naming the plugin;
// the core checks every ask (desktop/src/core/plugins/index.ts). `exec` and `spawn` run here.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Children, exec, spawn, type ChildHandle, type ExecOptions, type ExecResult, type SpawnOptions } from "./exec";

export type Dispose = () => void;
export type JSONValue = unknown;

/** "bot" is a bot of its own (made with `bots.create`), not a project's manager. */
export interface BotInfo { id: string; name: string; role: "main" | "manager" | "bot"; awake: boolean; created?: boolean }
/** A new bot: its name in the left column, what it is for, and optionally its shape. */
export interface NewBot { name: string; job: string; avatar?: string }
export interface Outgoing { bot: BotInfo; text: string }
export interface Incoming { bot: BotInfo; text: string }

export interface BrowserScope { origin: string; account: string; tab: string }
export interface BrowserOperation extends BrowserScope { operation: "observe" | "click" | "extract"; target?: string }

/** Botling's own settings a plugin may read (`settings.app`). */
export type AppSettingKey = "language" | "botLook" | "workerLimit";
export const APP_SETTING_KEYS: readonly AppSettingKey[] = ["language", "botLook", "workerLimit"];

export interface StatusItem { text: string; icon?: string; tooltip?: string; command?: string }
export interface Keybinding { command: string; key: string; source: "default" | "user" | "plugin" }

export interface PluginEvents {
  messagePosted: { botId: string; role: "user" | "bot"; text: string; id: string };
  turnFinished: { botId: string; ok: boolean; reply: string };
  workerDone: { botId: string; workerId: string; status: string; report: string };
}
export type PluginEventName = keyof PluginEvents;
export const EVENT_NAMES: readonly PluginEventName[] = ["messagePosted", "turnFinished", "workerDone"];

// ── The workspace (plugin-extraction.md §4.3): what the whiteboard reads, for any plugin, read only ──
export type WorkspaceKind = "bots" | "tasks" | "memory" | "waiting" | "results";
/** A bot as `workspace.bots` gives it (the main bot's id is "main"). */
export interface BotSummary {
  id: string; name: string; role: "main" | "manager" | "bot"; parent: string | null;
  /** Its folder's name. */
  folder: string;
  engine: "claude" | "codex" | "agy"; busy: boolean; asleep: boolean;
  /** Its face's shape (see `face`). */
  avatar: string;
  pinned: boolean;
}
export interface TaskView { id: string; name: string; state: string; [more: string]: unknown }
export interface WaitingView { items: { botId: string; text: string; messageId: string | null; at?: string }[]; doing: Record<string, string>; acked?: string[] }
export interface WorkspaceChange { stamp: string; botIds: string[]; kinds: WorkspaceKind[] }
/** The event Botling sends the host when the workspace changed (`workspace.onChange`, not `events.on`). */
export const WORKSPACE_EVENT = "workspace.changed";
export interface WorkspaceApi {
  bots(): Promise<BotSummary[]>;
  memory(botId: string): Promise<{ currentStatus: string[]; inProgress: string[]; decided: string[]; waitingOnYou: string[] }>;
  /** Its task cards, newest last (at most 100, the default). */
  tasks(botId: string, opts?: { limit?: number }): Promise<TaskView[]>;
  /** Tasks finished on each of the last `days` days (at most 14), oldest first; `manual`: closed by the user. */
  taskHistory(botId: string, days: number): Promise<{ day: string; done: number; manual: number }[]>;
  /** The links handed over in its chat, newest first (12 by default, at most 100). */
  results(botId: string, opts?: { limit?: number }): Promise<{ label: string; url: string }[]>;
  waiting(): Promise<WaitingView>;
  /** "I know" for an item waiting on you, as the app's own button: not an answer. */
  ignoreWaiting(botId: string, text: string): Promise<void>;
  /** Its tool approvals waiting for the user; answering is the user's, in the chat. */
  pendingApprovals(botId: string): Promise<{ tool: string; text: string; at: string | null }[]>;
  /** Its face as the app draws it now, as a data URL. */
  face(botId: string, look: "original" | "cute"): Promise<string>;
  /** Told when anything the methods above answer changed, naming the bots and kinds. */
  onChange(fn: (change: WorkspaceChange) => void): Dispose;
}

export interface BotlingApi {
  readonly plugin: { name: string; version: string; dir: string; storageDir: string };
  /** Disposed when the plugin unloads (push what `activate` set up). */
  readonly subscriptions: Dispose[];
  /** `plugin.name` (2.x). */
  name: string;

  /** A command in the user's shell: its own process group, a time limit (60 s) and an output cap (1 MB). */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** A program without a shell, for output that streams; ended (with its group) when the plugin unloads. */
  spawn(file: string, args: string[], opts?: SpawnOptions): ChildHandle;

  bots: {
    list(): Promise<BotInfo[]>;
    /**
     * A message to a bot. By default it shows as sent by this plugin; `as: "user"` sends it as the
     * user's own and needs the "bots" capability.
     */
    send(botId: string, text: string, opts?: { as?: "plugin" | "user" }): Promise<{ messageId: string }>;
    /** Wakes a bot with `prompt` as a message from this plugin (a wake without one is not offered yet). */
    wake(botId: string, prompt?: string): Promise<void>;
    /** Stops what the bot is doing, as its stop button does. Needs "bots". */
    interrupt(botId: string): Promise<void>;
    /**
     * Makes a bot of its own (`created: true`), or returns the one this plugin made by that name
     * (`created: false`). Throws if the name is someone else's or the user removed it. Needs "bots".
     */
    create(bot: NewBot): Promise<BotInfo>;
    onReply(fn: (bot: BotInfo, reply: string) => void): Dispose;
  };
  hooks: {
    /** Return new text, or false to stop the message from being sent. */
    beforeSend(fn: (message: Outgoing) => Outgoing | string | false | void | Promise<Outgoing | string | false | void>): Dispose;
    afterReply(fn: (message: Incoming) => Incoming | string | void | Promise<Incoming | string | void>): Dispose;
  };
  commands: { register(id: string, run: (...args: unknown[]) => unknown): Dispose };
  keybindings: {
    /** Every key in effect ("Mod+Shift+L"): Botling's (default or the user's) and plugins' commands'. */
    list(): Promise<Keybinding[]>;
    /**
     * Binds one of this plugin's own commands in place of its manifest's key (null: no key; "Mod+Shift+L"
     * or "cmd+shift+l"); never a key Botling or another command has. A key the user chose still wins.
     */
    set(command: string, key: string | null): Promise<{ ok: true } | { ok: false; conflict: string }>;
  };
  routines: { add(botId: string, cron: string, task: string): Promise<void> };
  workspace: WorkspaceApi;
  settings: {
    get<T>(key: string): T;
    /** One of this plugin's own settings (a secret one is set with `secrets.set`). */
    update(key: string, value: JSONValue): Promise<void>;
    onChange(key: string, fn: (value: unknown) => void): Dispose;
    /** Botling's own settings, read only. */
    app<T>(key: AppSettingKey): T;
  };
  storage: { dir: string; get(key: string): unknown; set(key: string, value: unknown): void };
  /** Kept sealed by Botling, per plugin. */
  secrets: { get(key: string): Promise<string | null>; set(key: string, value: string | null): Promise<void> };
  ui: {
    notify(text: string, opts?: { level?: "info" | "warn" | "error"; actions?: { title: string; command: string }[] }): void;
    /** The user picks one (null: dismissed, or nobody answered before Botling restarted). */
    quickPick<T extends string>(items: { id: T; label: string; detail?: string }[], opts?: { title?: string }): Promise<T | null>;
    /** The user types an answer (null: dismissed). */
    input(opts: { title: string; placeholder?: string; secret?: boolean }): Promise<string | null>;
    /** Opens one of this plugin's views (panels). */
    openView(id: string, args?: JSONValue): Promise<void>;
    /** An item of this plugin's in the status area (null: gone). */
    setStatus(id: string, item: StatusItem | null): void;
    /** Opens `method` to this plugin's own frames (panels) and web part: the only methods they can call. */
    expose(method: string, fn: (params: unknown) => unknown): Dispose;
  };
  events: {
    on<E extends PluginEventName>(event: E, fn: (data: PluginEvents[E]) => void): Dispose;
  };
  /** `ui.expose`'s 1.x name. */
  web: { handle(method: string, fn: (params: unknown) => unknown): Dispose };
  browser: {
    /** Offered only at this exact origin; run receives the user's selected account/tab. */
    registerTool(tool: { id: string; title: string; origin: string }, run: (scope: BrowserScope) => unknown): Dispose;
    /** Runs only during a user-invoked tool, on that invocation's exact page scope. */
    perform(operation: BrowserOperation): Promise<unknown>;
  };
  /** `ui.notify` (2.x). */
  notify(text: string): void;
}

/** The 2.x name of the same object. */
export type CcbHost = BotlingApi;

/** What Botling sends for each plugin with a program part. */
export interface HostPluginSpec {
  name: string;
  version: string;
  /** Absolute path of the bundled ES module that exports `activate(api)`. */
  main: string;
  /** The plugin's folder (older Botlings did not send it: the main module's folder then). */
  dir?: string;
  /** Changes whenever the plugin's files change, so a new version is imported fresh. */
  fingerprint: string;
  settings: Record<string, JSONValue>;
  /** Botling's own settings it may read (`settings.app`). */
  app?: Partial<Record<AppSettingKey, JSONValue>>;
  /** A folder the plugin may keep data in. */
  storageDir: string;
}

/** A loaded plugin's registrations, which the host routes to. */
export interface Loaded {
  spec: HostPluginSpec;
  disposers: Dispose[];
  beforeSend: ((message: Outgoing) => unknown)[];
  afterReply: ((message: Incoming) => unknown)[];
  replyListeners: ((bot: BotInfo, reply: string) => void)[];
  commands: Map<string, (...args: unknown[]) => unknown>;
  web: Map<string, (params: unknown) => unknown>;
  /** The methods in `web` its frames and web part may call (ui.expose); website tools are not. */
  exposed: Set<string>;
  settingHandlers: Map<string, ((value: unknown) => void)[]>;
  /** `events.on`'s listeners, and `workspace.onChange`'s under WORKSPACE_EVENT. */
  events: Map<PluginEventName | typeof WORKSPACE_EVENT, ((data: unknown) => void)[]>;
  children: Children;
}

export function newLoaded(spec: HostPluginSpec): Loaded {
  return {
    spec, disposers: [], beforeSend: [], afterReply: [], replyListeners: [], commands: new Map(), web: new Map(),
    exposed: new Set(), settingHandlers: new Map(), events: new Map(), children: new Children(),
  };
}

/** What the api needs of the host. */
export interface HostSide {
  request(method: string, params: JSONValue): Promise<JSONValue>;
  notify(method: string, params: JSONValue): void;
  /** Tells Botling again what is registered (soon, once, if the plugin is still loaded). */
  announceLater(plugin: Loaded): void;
  /** The same now, before anything the plugin sends next (if it is still loaded). */
  announceNow(plugin: Loaded): void;
}

/** A request whose promise a plugin may ignore (2.x `bots.send` returned nothing): no unhandled rejection then. */
function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

export function createApi(host: HostSide, plugin: Loaded): BotlingApi {
  const name = plugin.spec.name;
  const own = (dispose: Dispose): Dispose => {
    plugin.disposers.push(dispose);
    return dispose;
  };
  const remove = <T>(list: T[], item: T) => own(() => {
    const at = list.indexOf(item);
    if (at !== -1) list.splice(at, 1);
  });
  const announceLater = () => host.announceLater(plugin);
  const ask = (method: string, params: Record<string, JSONValue> = {}) => host.request(method, { ...params, plugin: name });
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
    plugin: { name, version: plugin.spec.version, dir: plugin.spec.dir ?? dirname(plugin.spec.main), storageDir: plugin.spec.storageDir },
    subscriptions,
    name,
    exec: (command, opts = {}) => exec(String(command), opts, where, plugin.children),
    spawn: (file, args, opts = {}) => spawn(String(file), (args ?? []).map(String), opts, where, plugin.children),
    bots: {
      list: async () => (await ask("bots.list")) as BotInfo[],
      send: (botId, text, opts = {}) => quiet(ask("bots.send", { bot: botId, text, as: opts.as === "user" ? "user" : "plugin" }) as Promise<{ messageId: string }>),
      wake: async (botId, prompt) => { await ask("bots.wake", { bot: botId, ...(prompt === undefined ? {} : { prompt }) }); },
      interrupt: async (botId) => { await ask("bots.interrupt", { bot: botId }); },
      create: async (bot) => (await ask("bots.create", { name: bot?.name, job: bot?.job, avatar: bot?.avatar })) as BotInfo,
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
      setStatus: (id, item) => host.notify("ui.setStatus", { plugin: name, id, item: item ?? null }),
      expose,
    },
    events: {
      on: (event, fn) => {
        if (!EVENT_NAMES.includes(event)) throw new Error(`No event "${String(event)}" (there are ${EVENT_NAMES.join(", ")}).`);
        const list = plugin.events.get(event) ?? [];
        list.push(fn as (data: unknown) => void);
        plugin.events.set(event, list);
        announceLater();
        const off = remove(list, fn as (data: unknown) => void);
        return own(() => { off(); announceLater(); });
      },
    },
    web: { handle: expose },
    browser: {
      registerTool: (tool, run) => {
        const method = `browser.tool.${tool.id}`;
        plugin.web.set(method, run as (params: unknown) => unknown);
        host.notify("browser.register", { ...tool, plugin: name });
        return own(() => {
          plugin.web.delete(method);
          host.notify("browser.unregister", { id: tool.id, plugin: name });
        });
      },
      perform: async (operation) => host.request("browser.perform", { ...operation, plugin: name }),
    },
    notify: (text) => notify(text),
  };
}
