// `BotlingApi` and what the host keeps of a loaded plugin (moved byte for byte out of api.ts; api.ts re-exports them).
import { Children, type ChildHandle, type ExecOptions, type ExecResult, type SpawnOptions } from "./exec";
import type {
  AppApi, AppSettingKey, BotInfo, BotNote, CardsApi, ChatData, CommandRun, ContentRef, Dispose, EngineCli, Incoming, JSONValue, Keybinding,
  MessageDecoration, NewBot, NoteAsset, NoteCardState, NoteComponent, NoteLocalized, NoteOutline, NoteParsed, NoteRoutePicks, NoteSave, Outgoing,
  PluginEventName, PluginEvents, PluginsApi, ReplyTag, RoutinesList, SessionsApi, StatusItem, StudioApi, UsageApi, WorkspaceApi,
} from "./api-types";
import type { WORKSPACE_EVENT } from "./api-types";

export interface BotlingApi {
  /** `appDataDir`: Botling's data folder, given to a built-in plugin only (to take over files the core used to keep). */
  readonly plugin: { name: string; version: string; dir: string; storageDir: string; appDataDir?: string };
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
    /** A bot's working folder (absolute; null: no such bot). The main bot's too. Needs "exec": what runs there is the plugin's own doing. */
    folder(botId: string): Promise<string | null>;
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
  /**
   * Each bot's note: one Markdown file the user keeps for that bot (the Note tab), where Botling says (<project>/.bot/note.md,
   * a sub bot's under .bot/sub-bots/<id>/, the main bot's in its own folder); the bots are told it is there. Needs "files"; write, importAsset, localizeImages and mode(set) only for the built-in Note (`ccb.owns`: ["note"]).
   * A note this plugin reads or saves is watched: `events.on("noteChanged", …)` hears when it changes on disk.
   */
  notes: {
    /** The note's words, made empty (with its folders) the first time. */
    read(botId: string): Promise<BotNote>;
    /** Saves the whole note. With `base` (the mtime last read or saved) a note changed on disk since is not overwritten. */
    write(botId: string, text: string, opts?: { base?: number }): Promise<NoteSave>;
    /**
     * Copies a picture into the note's own note-assets folder (named by a hash of its bytes, so the same picture is kept
     * once) and gives the ref to link. `{ path }`: only a picture the note already links (absolute path, ~/… or file: URL).
     * `{ data, name }`: a paste or drop, base64 bytes (at most 2,500,000 bytes); `name` gives the extension. png, jpg,
     * jpeg, gif, webp or svg only, at most 20 MB.
     */
    importAsset(botId: string, source: { path: string } | { data: string; name: string }): Promise<NoteAsset & { url: string }>;
    /** The URL a frame's <img> shows each ref from ("note-assets/<name>" or "./note-assets/<name>"; null: not in the note's folder). */
    assetUrls(botId: string, refs: string[]): Promise<Record<string, string | null>>;
    /** Copies every picture the note links by absolute path, ~/… or file: URL into note-assets and links the copies instead. */
    localizeImages(botId: string, opts?: { base?: number }): Promise<NoteLocalized>;
    /** A note's branches and cards as the core reads them (what bots are told), from `text`; with `picks`, also the view of that way through; with `lines`, each line's kind. */
    parse(text: string, picks?: NoteRoutePicks, opts?: { lines?: boolean }): Promise<NoteParsed>;
    /**
     * The ids of the note's cells and forks (note.db), with their lines: in `text` (the editor's words, saved or not; cells
     * matched as a save would match them) or, without it, in the note as `read` gives it (returned as `text`).
     */
    outline(botId: string, opts?: { text?: string }): Promise<NoteOutline>;
    /** Whether the note is kept in note.db ("db") or as a plain file ("file", with why); with `mode`, switches it ("file" writes note.md without ids). */
    mode(botId: string, mode?: "db" | "file"): Promise<{ mode: "db" | "file"; reason: string | null }>;
    /** The bot's components for the insert menu: its own list first, then the rest of the library. */
    components(botId: string): Promise<{ folder: string; readOnly: boolean; components: NoteComponent[] }>;
    /** Each card in the note (or in `text`, the editor's words not yet saved) with what it draws now. */
    cards(botId: string, opts?: { text?: string }): Promise<NoteCardState[]>;
    /**
     * Runs card `key`'s command in the bot's folder, only if the user allowed it there (else `needsApproval`: hand it to the
     * frame's `ccb.requestApproval({ botId, ...needsApproval })`, then call again). A finished card runs again only with `force`
     * (↻, its refresh timer), at most every 2 s. `noteCardChanged` says when its state changes.
     */
    runCard(botId: string, key: string, opts?: { force?: boolean; text?: string }): Promise<{ started: boolean; needsApproval: { command: string; folder: string; card: string } | null }>;
  };
  keybindings: {
    /** Every key in effect ("Mod+Shift+L"): Botling's (default or the user's) and plugins' commands'. */
    list(): Promise<Keybinding[]>;
    /**
     * Binds one of this plugin's own commands in place of its manifest's key (null: no key; "Mod+Shift+L"
     * or "cmd+shift+l"); never a key Botling or another command has. A key the user chose still wins.
     */
    set(command: string, key: string | null): Promise<{ ok: true } | { ok: false; conflict: string }>;
  };
  routines: {
    add(botId: string, cron: string, task: string): Promise<void>;
    /** A bot's routines as the app lists them; needs the "routines" permission, built-in plugins only. */
    list(botId: string): Promise<RoutinesList>;
    /** Pauses, resumes or cancels one of a bot's routines (the list after); needs the "routines" permission, built-in plugins only. */
    change(botId: string, operation: "pause" | "resume" | "cancel", id: string): Promise<RoutinesList>;
  };
  workspace: WorkspaceApi;
  usage: UsageApi;
  /** The plugins and who depends on whom (read only, any plugin). */
  plugins: PluginsApi;
  sessions: SessionsApi;
  /** The components a chat shows and their commands; needs the "cards" permission, built-in plugins only. */
  cards: CardsApi;
  /** The app around Botling; needs the "app" permission, built-in plugins only. */
  app: AppApi;
  /** The component studio's seam; needs the "studio" permission, built-in plugins only. */
  studio: StudioApi;
  /** The tags this plugin declared in its manifest (`replyTags`), from bots' replies. */
  replyTags: { on(tag: string, fn: (tag: ReplyTag) => void): Dispose };
  approvals: {
    /**
     * Whether the user allowed `command` to run in the bot's folder (approved-commands.json, as cards' commands).
     * Only the user allows one, on the app page (a frame's `ccb.requestApproval`); a plugin never can.
     */
    check(botId: string, command: string): Promise<{ folder: string; approved: boolean }>;
    /** `check`, and the last run `key` made of that command: "approve" until the user allowed it. */
    state(botId: string, command: string, key: string): Promise<CommandRun>;
    /**
     * Runs an allowed command in the bot's folder, in Botling (a time limit, an output cap, its process group ended with
     * it), as run `key`; not again while it runs or within `minIntervalMs` (default 0) of the last run. Returns the run's state
     * now (`started`: this call started one). A command the user did not allow does not run ("approve").
     */
    run(botId: string, command: string, key: string, opts?: { minIntervalMs?: number }): Promise<CommandRun & { started: boolean }>;
  };
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
    /**
     * Opens (`view`) or closes (null) one of this plugin's `rightPanel.takeover` views: it takes the place of bot `opts.bot`'s right panel
     * while that bot's chat is shown. One at a time, across plugins; `opts.wide` makes it wide.
     */
    takeover(view: string | null, opts?: { bot?: string; wide?: boolean }): Promise<void>;
    /**
     * Shows (`on`) or hides one of this plugin's `mainTab` views declared with `"forRole": "marked"` in bot `botId`'s header: such a
     * tab shows only for the bots marked here (kept across restarts). `opts.open`: also show that bot with this tab now.
     */
    showTab(botId: string, viewId: string, on: boolean, opts?: { open?: boolean }): Promise<void>;
    /** An item of this plugin's in the status area (null: gone). */
    setStatus(id: string, item: StatusItem | null): void;
    /** Opens `method` to this plugin's own frames (panels) and web part: the only methods they can call. */
    expose(method: string, fn: (params: unknown) => unknown): Dispose;
    /**
     * Pushes `data` (JSON, at most 1 MB) to this plugin's frames as event `event` (`ccb.on(event, fn)` there): those of bot `opts.botId`
     * only when given, else every frame of this plugin. Fire and forget: a frame not open misses it, and nothing is kept.
     */
    emit(event: string, data: JSONValue, opts?: { botId?: string }): void;
  };
  /** Needs "orchestrate", "exec", "files" and "bots" in package.json AND the user's OK for this plugin (API 2.8, `engines` "^2.8.0"). A quota applies; a plugin a bot wrote asks the user for every worker. */
  workers: {
    /** Starts a Claude worker for a bot: it has no more rights than this plugin (no spec/, the bot's approval cards). `model` that may change spec/ is refused. */
    start(opts: { bot: string; instructions: string; name?: string; group?: string; engine?: "claude"; model?: string; effort?: string }): Promise<{ taskId: string; run: number }>;
    /** Words for a worker this plugin started (it joins the run under way, or starts the next one). */
    send(taskId: string, message: string): Promise<{ run: number; how: string }>;
    /** Stops a worker this plugin started; no report follows. */
    cancel(taskId: string): Promise<{ stopped: boolean }>;
  };
  events: {
    on<E extends PluginEventName>(event: E, fn: (data: PluginEvents[E]) => void): Dispose;
  };
  chat: {
    /** A chat's newest lines (at most `limit`, 500 by default, 2,000 at most) and its task cards. Needs "messages". */
    messages(botId: string, opts?: { limit?: number }): Promise<ChatData>;
    /** What this plugin draws in a chat, in place of what it drew there before ([] clears). It needs a web part to draw it. */
    decorate(botId: string, decorations: MessageDecoration[]): Promise<void>;
    /**
     * What this plugin's web part draws the chat from, in place of what it kept there before (null clears; 1 MB at most): the chat
     * page gets it with the chat's state (`state.pluginData[<plugin>]`), on the phone too. Built-in plugins only (`cards`).
     */
    setData(botId: string, data: JSONValue | null): Promise<void>;
  };
  content: {
    /** Reads up to 4 MiB of a chat-referenced file starting at `offset` (requires Botling 3). */
    read(ref: ContentRef, offset: number, length: number): Promise<Uint8Array>;
    /** Copies a chat-referenced file (<= 500 MiB) into the plugin storage folder and returns its local path (requires Botling 3). */
    fetch(ref: ContentRef): Promise<string>;
  };
  engines: {
    /** How to start `claude` or `codex` here (null: that engine is not available). */
    cli(engine: "claude" | "codex"): Promise<EngineCli | null>;
  };
  /** `ui.expose`'s 1.x name. */
  web: { handle(method: string, fn: (params: unknown) => unknown): Dispose };
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
  /** Botling's data folder (built-in plugins only). */
  appDataDir?: string;
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
  replyTags: Map<string, ((tag: ReplyTag) => void)[]>;
  children: Children;
}

export function newLoaded(spec: HostPluginSpec): Loaded {
  return {
    spec, disposers: [], beforeSend: [], afterReply: [], replyListeners: [], commands: new Map(), web: new Map(),
    exposed: new Set(), settingHandlers: new Map(), events: new Map(), replyTags: new Map(), children: new Children(),
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
  /**
   * Keeps `dispose` as one of the plugin's registrations (the host's plugin kernel: undone in reverse order at unload, or
   * at once when the plugin is already unloading); returns what takes it back early. Without it, `plugin.disposers` keeps it.
   */
  own?(plugin: Loaded, dispose: Dispose): Dispose;
}
