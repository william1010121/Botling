// The object a plugin's `activate(api)` receives (plugin-platform.md §4.2): one per plugin, its name
// bound in. `BotlingApi` is the 3.x name; `CcbHost` (2.x) is the same object, so old plugins keep
// working: its old members (`name`, `notify`, `web.handle`, `storage.dir`) stay beside the new.
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

/** Botling's own settings a plugin may read (`settings.app`). */
export type AppSettingKey = "language" | "botLook" | "workerLimit";
export const APP_SETTING_KEYS: readonly AppSettingKey[] = ["language", "botLook", "workerLimit"];

export interface StatusItem { text: string; icon?: string; tooltip?: string; command?: string }
export interface Keybinding { command: string; key: string; source: "default" | "user" | "plugin" }

export interface PluginEvents {
  messagePosted: { botId: string; role: "user" | "bot"; text: string; id: string };
  /** A turn began in a bot's session (`turnId` is the app's id for it). */
  turnStarted: { botId: string; turnId: string };
  turnFinished: { botId: string; ok: boolean; reply: string };
  workerDone: { botId: string; workerId: string; status: string; report: string };
  /** You read a chat up to its newest line (`through`); `unread`: how many of its lines were unread before. */
  chatRead: { botId: string; unread: number; through: string | null };
  /** The developer project (Settings → Developer) or developer mode changed: `before`/`now` are the project bot's ids (null: none); `turnedOn`: developer mode was just turned on. */
  developerChanged: { before: string | null; now: string | null; turnedOn: boolean };
  /** A bot was removed from Botling (its folder stays). */
  botRemoved: { botId: string };
  /** A component card's command run (a card of a built-in plugin's, such as `pin/<id>`; a spec's test run or built card; a chat card) started or ended; `card` is its key. */
  cardChanged: { card: string };
  /** The component library changed (a component added, edited, being changed). */
  componentsChanged: Record<string, never>;
  /** The component library changed on disk (a component landed, or one's template or about.md did). */
  libraryChanged: Record<string, never>;
  /** Maintainer's reply showed (after the tags in it were handed over): its line's role ("bot" or "error"), its words (the first 2,000 characters) and whether its subagents are still at work. */
  maintainerReplied: { role: string; text: string; running: boolean };
}
export type PluginEventName = keyof PluginEvents;
/** A tag this plugin declared (`contributes.replyTags`) in a bot's reply, as the bot wrote it; the chat never shows it. */
export interface ReplyTag { bot: BotInfo; tag: string; attributes: Record<string, string>; body: string }
export const EVENT_NAMES: readonly PluginEventName[] = ["messagePosted", "turnStarted", "turnFinished", "workerDone", "chatRead", "developerChanged", "botRemoved", "cardChanged", "componentsChanged", "libraryChanged", "maintainerReplied"];

/** A line of a chat as Botling keeps it (chat.json's record: its id, role, words, Swift date and the rest). */
export interface ChatLine { id: string; role: string; text: string; date: number; [field: string]: unknown }
export interface ChatTask { id: string; name: string; state: string; messageIDs: string[] }
/** A chat as `chat.messages` reads it: its newest lines, its task cards, its name and how much is unread. */
export interface ChatData { botId: string; name: string; unread: number; messages: ChatLine[]; tasks: ChatTask[] }

/**
 * Something a plugin draws among a chat's messages (chat extension v2): its web part draws it with
 * `ccb.decorations.register`. `fold`: these lines fold behind it, and it is drawn before the first of
 * them; or `after`: it is drawn after that line, nothing folded; or `under`: it is drawn inside that message's own column, under its words. `tasks`: task cards it is about (the
 * page hands them to the web part as live chips). `data`: the plugin's own, for its web part.
 */
export interface MessageDecoration { key: string; fold?: string[]; after?: string; under?: string; tasks?: string[]; data?: JSONValue }

/** How Botling starts an engine's CLI on this computer, for a one-shot model call: run `file` with `args` first, `env` added. */
export interface EngineCli { file: string; args: string[]; env: Record<string, string> }

// ── The workspace (plugin-extraction.md §4.3): what the whiteboard reads, for any plugin, read only ──
export type WorkspaceKind = "bots" | "tasks" | "memory" | "waiting" | "results" | "current";
/** A bot as `workspace.bots` gives it (the main bot's id is "main"). */
export interface BotSummary {
  id: string; name: string; role: "main" | "manager" | "bot"; parent: string | null;
  /** Its folder's name. */
  folder: string;
  engine: "claude" | "codex" | "agy"; busy: boolean; asleep: boolean;
  /** Its face's shape (see `face`). */
  avatar: string;
  pinned: boolean;
  /** When it last did something (ISO time), if ever. */
  lastActivity: string | null;
  /** What it is for (a bot of its own), if it has a job. */
  job: string | null;
  /** Its subagents at work, and whether a guest bot answers in its chat now. */
  subagents: number;
  guest: boolean;
  /** Its tool approvals waiting for the user. */
  approvals: number;
  /** The app's own words for its state: `key` says which dot to draw (working, waiting, awake, asleep, disconnected, retrying…). */
  status: { key: string; text: string };
  /** The main bot's latest reply, as written (cut at 400 characters); null for any other bot. */
  lastReply: string | null;
}
export interface TaskView { id: string; name: string; state: string; [more: string]: unknown }
export interface WaitingView { items: { botId: string; text: string; messageId: string | null; at?: string }[]; doing: Record<string, string>; acked?: string[] }
/** A bot's command and the last run a plugin's `key` made of it. `data`: its output as component data (JSON, or a JSON string of the text). */
export interface CommandRun {
  folder: string; approved: boolean;
  status: "approve" | "idle" | "running" | "done" | "failed";
  data: string | null; error: string | null;
  /** Epoch ms of the last run's end (or start, while the first runs). */
  ranAt: number | null;
}
/**
 * The chat the user has open in Botling's main window (`workspace.current`). `sessionId`: its primary head's
 * session (Claude: the id Claude Code names its session log by, `<sessionId>.jsonl`; Codex: the
 * thread id); null until that head has started one. `heads`: every head of the chat, the primary first.
 */
/** One model call of an Antigravity conversation (`workspace.agyUsage`). */
export interface AgyCall {
  /** ms since 1970; null: the row has no time. */
  at: number | null;
  model: string;
  /** Input tokens not read from the cache. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Thinking tokens, part of `output`. */
  reasoning: number;
  /** An attempt that was tried again (its tokens were still spent). */
  retry: boolean;
  key: string;
}
export interface AgyUsage {
  sessionId: string;
  calls: AgyCall[];
  total: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  retries: number;
  models: string[];
}
/** A quota bucket: a family (Gemini, Claude & GPT…) and its window, 0…1 left, when it starts over (ms). */
export interface AgyQuotaBucket { group: string; label: string; remainingFraction?: number; remainingAmount?: string; resetsAt?: number; disabled?: boolean }
export type AgyQuota =
  | { status: "available"; source: string; seen: number; buckets: AgyQuotaBucket[] }
  | { status: "unavailable" | "error"; source: string; reason: string; lastKnown?: { seen: number; buckets: AgyQuotaBucket[] } };

export interface CurrentChat {
  botId: string;
  engine: "claude" | "codex" | "agy";
  sessionId: string | null;
  heads: { engine: "claude" | "codex" | "agy"; sessionId: string | null }[];
  /** What the main area shows of it: the chat, the Board, a plugin's tab (`tab`: "<plugin>/<view id>"), or a subagent's run. */
  view: "chat" | "board" | "tab" | "subagent";
  tab: string | null;
}
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
  /**
   * A component of the bot's library: whether there is one by that name, and the command its data comes from (the
   * one given, else the component's own "Command:" line; null: it needs none). The library is read only.
   */
  component(botId: string, name: string, spec?: { data?: string; command?: string }): Promise<{ exists: boolean; command: string | null }>;
  /**
   * The chat open in the main window now, the bot as in `bots` ("main": the main bot); null: none (or the window
   * has not said yet). A switch, a new session or another view is told by `onChange` with kind "current", naming
   * the bot left and the bot opened.
   */
  current(): Promise<CurrentChat | null>;
  /**
   * What an Antigravity conversation used, from agy's own conversation file (`sessionId`: an agy head's, as in
   * `current().heads`): each model call (a retry is a call of its own) with its exact tokens and model. null: no such
   * conversation in Botling's agy profiles, or a file this Botling cannot read. Agy reports no prices.
   */
  agyUsage(sessionId: string): Promise<AgyUsage | null>;
  /** Antigravity's quota (Google's cloudcode-pa quota summary), reused for five minutes; never a token. */
  agyQuota(): Promise<AgyQuota>;
  /** Told when anything the methods above answer changed, naming the bots and kinds. */
  onChange(fn: (change: WorkspaceChange) => void): Dispose;
}

// ── Cards (plugin-extraction.md §3.3, M8): the components a chat shows and their commands, for built-in plugins that keep cards of their own ──
/** A component in a chat's line, newest line first (what a pin is made from). */
export interface ShownCard {
  messageId: string; index: number; name: string;
  /** The command="…" its tag carried, if any. */
  command: string | null;
  /** The command its data comes from now: that one, else its component's own for one shown with no data. */
  shownCommand: string | null;
  data: string;
  /** The bot that wrote the line (upper case id), if it was not the chat's own. */
  author: string | null;
}
/** The component library as a chat's bot has it. `offered`: what the bot may use; `entries`: each component's Command, Detail command, refresh interval (seconds) and the sizes about.md hints at. */
export interface CardLibrary {
  /** The bot's own id ("main" is the main bot's real one). */
  botId: string;
  names: string[]; offered: string[];
  entries: Record<string, { command: string | null; detail: string | null; every: number | null; sizes: string[] }>;
  /** The bot cannot change anything (its folder is gone). */
  readOnly: boolean;
  /** The folder its commands run in. */
  folder: string;
}
export interface CardRunState { status: CommandRun["status"]; data: string | null; error: string | null; ranAt: number | null }
/** A card's command as the core has it: what it asks, how it ran, the pictures its data names. */
export interface CardState extends CardRunState {
  folder: string; detail: string | null; every: number | null;
  /** The pictures the run's data names, and those the data you gave names (`data`). */
  images: Record<string, string>; dataImages: Record<string, string>;
  /** When the card last ran, whatever it ran. */
  lastRan: number | null;
  /** The card's last run of exactly this command in this folder. */
  run: CardRunState | null;
}
export interface CardsApi {
  library(botId: string): Promise<CardLibrary | null>;
  /** Every component in the chat, newest first. */
  shown(botId: string): Promise<ShownCard[]>;
  /** Each card's state (`command` null: not a card with one: only its component's Detail command and interval, and its data's pictures). */
  states(botId: string, cards: { card: string; command: string | null; name: string; data?: string }[]): Promise<CardState[]>;
  /** Runs the command of a card of this plugin's kind (`pin/<id>`) when the user allowed it in the bot's folder; false: not allowed. */
  run(botId: string, card: string, command: string, force: boolean): Promise<boolean>;
  /** What the ApprovalSheet asks about a card's command and its component's Detail command; null: allowed already. */
  ask(botId: string, card: string, command: string, component: string): Promise<{ command: string; folder: string; detail: string | null; card: string } | null>;
  /** What changed in this plugin's cards, which the bot hears with the user's next message (Swift dates and the words). */
  setNotes(botId: string, notes: { date: number; line: string }[]): Promise<void>;
  /** The pins the core kept in the bot's pins.json before this plugin did (as the file has them); null: none. */
  legacyPins(botId: string): Promise<unknown[] | null>;
}

// ── Usage: what Settings → Usage and the quota rings show, for any plugin, read only ──
export interface UsageLimitWindow { used: number; resetsAt: number | null; seen: number }
export interface UsageLimits { fiveHour: UsageLimitWindow | null; week: UsageLimitWindow | null }
export type UsageQuotaStatus = "available" | "missing" | "auth_required" | "token_expired" | "auth_rejected" | "forbidden" | "timeout" | "network_error" | "invalid_response" | "cli_unavailable";
/** One of Antigravity's quota buckets; groups and windows are the provider's own. */
export interface AntigravityBucket { group: string; label: string; remainingFraction?: number; remainingAmount?: string; resetsAt?: number; disabled?: boolean }
export type AntigravityQuota =
  | { status: "available"; source: "antigravity_acp"; seen: number; buckets: AntigravityBucket[] }
  | { status: "unavailable" | "error"; source: "antigravity_acp"; reason: "unsupported_connection" | "no_connection" | "busy" | "missing_data" | "request_failed" | "invalid_response"; lastKnown?: { seen: number; buckets: AntigravityBucket[] } };
export interface UsageTokens { input: number; output: number; cacheWrite: number; cacheRead: number }
/** What the bots used today, by bot, the days before and each CLI's subscription limits (the `usage.view` command's answer; times are ms since 1970). */
export interface UsageView {
  antigravity?: AntigravityQuota;
  quotaStatus?: { claude: UsageQuotaStatus; codex: UsageQuotaStatus };
  spendingStatus: "available" | "missing" | "unreadable";
  day: string; spent: number; tokens: UsageTokens;
  byBot: { name: string; spent: number; tokens: number; breakdown?: UsageTokens | null }[];
  history: { day: string; spent: number; tokens: number }[];
  claude: UsageLimits; codex: UsageLimits;
}
/** A routine as the app lists it (the `routines.list` command's rows). */
export interface RoutineRow {
  id: string; kind: "once" | "recurring" | "legacy"; task: string; title: string;
  /** "Every day 08:15", the cron fields, or (once) its time as ISO-8601. */
  schedule: string; cron?: string | null; timezone: string;
  /** pending, due, paused, fired, cancelled, delivery_uncertain; enabled/paused for routines.cron. */
  status: string; next: string | null;
}
export interface RoutinesList { routines: RoutineRow[]; error: string | null }
export interface UsageApi {
  /** The usage now: the core reads the CLIs' quota first (at most about once a minute), then answers. */
  view(): Promise<UsageView>;
}

// ── Sessions (plugin-extraction.md §3.2 #2): which folder a bot's session starts in, for built-in plugins ──
/** Where a bot's session starts (`cwd`, absolute), what else it may use there (`addDirs`) and the words it hears at each wake (`note`, appended after the app's briefing). */
export interface SessionFolder { cwd: string; addDirs?: string[]; note?: string }
export interface SessionBot {
  id: string; name: string; role: "manager" | "bot"; parent: string | null;
  /** Its working folder (absolute) and its memory.md, relative to it. */
  folder: string; memoryPath: string;
  /** Where its chat files are. */
  storeDir: string;
  /** Why it cannot run (its folder is gone), or null. */
  problem: string | null;
  /** Botling's own source's project: where development work goes (the work drive), else null. */
  workRoot: string | null;
}
export interface SessionsApi {
  /**
   * Says where `botId`'s session starts (null: its own folder again). Botling keeps the answer and uses it at once whenever a
   * turn starts, even before this plugin has loaded after a restart; an awake bot starts again before its next message
   * (`reason.told` is what it hears, `reason.shown` what the chat shows). Needs the "sessions" permission; built-in plugins only.
   */
  setFolder(botId: string, folder: SessionFolder | null, reason?: { told: string; shown: string }): Promise<void>;
  /** The whole picture, to say when the plugin loads: bots missing from it go back to their own folders. */
  syncFolders(folders: Record<string, SessionFolder>): Promise<void>;
  /** The bots whose sessions this plugin may place: every one but the main bot and Maintainer, with where their folders and chat files are. */
  bots(): Promise<SessionBot[]>;
}

// ── The app (plugin-extraction.md §3.2 #6): install a build and restart, a picture of the window; built-in plugins only ──
/** The app as the developer tools see it. */
export interface AppState {
  /** Main's pid (null: no app around). */
  pid: number | null;
  /** The core's data folder, and the app's own. */
  dataDir: string;
  appDataDir: string | null;
  /** The app bundle running now (null: not running from a bundle, as in development). */
  bundle: string | null;
  developerMode: boolean;
  /** The project that is Botling's own source while developer mode is on. */
  developer: { id: string; name: string; folder: string } | null;
}
export interface AppApi {
  state(): Promise<AppState>;
  /**
   * Starts `command` (the install script `<dataDir>/self-update/install.sh` with its twelve words) detached and quits the app for it, after
   * Botling checkpointed the work under way so it resumes on the new build. Throws when it cannot start; nothing quits then.
   */
  installAndRestart(command: string[], log: string): Promise<void>;
  /** A PNG of the app's window (null: none). */
  captureWindow(): Promise<string | null>;
  /** A card in the main bot's chat (`source`: the bot it is about). With `choices` it resolves with the index picked, and waits for it (null: none). */
  card(text: string, opts?: { choices?: { label: string; recommended?: boolean }[]; source?: string }): Promise<number | null>;
  /** A relay line (`relay`, optionally with files) in a bot's chat, or a note it hears at its next wake or turn (`note`). */
  tell(botId: string, kind: "relay" | "note", text: string, files?: string[]): Promise<void>;
  /** What the developer project's manager hears at each wake (`worktree`: when its session is in an app worktree); null: nothing. Botling keeps it, so a wake never waits for the plugin. */
  briefing(briefing: { bot: string; plain: string; worktree: string } | null): Promise<void>;
}

/**
 * The component studio's asks of the core (`studio.*`, plugin-extraction.md §3.2 #4): the "studio" permission, built-in plugins only.
 * `request` takes the method's name without "studio." and its params; desktop/src/core/plugins/studio-seam.ts says what each answers.
 */
export interface StudioApi { request(method: string, params?: JSONValue): Promise<unknown> }

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
      setStatus: (id, item) => host.notify("ui.setStatus", { plugin: name, id, item: item ?? null }),
      expose,
      emit: (event, data, opts = {}) => host.notify("ui.emit", { plugin: name, name: String(event), data: data === undefined ? null : data, ...(opts.botId ? { botId: opts.botId } : {}) }),
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
    chat: {
      messages: async (botId, opts = {}) => (await ask("chat.messages", { bot: botId, ...(opts.limit === undefined ? {} : { limit: opts.limit }) })) as ChatData,
      decorate: async (botId, decorations) => { await ask("chat.decorate", { bot: botId, decorations: decorations as JSONValue }); },
      setData: async (botId, data) => { await ask("chat.setData", { bot: botId, data: data as JSONValue }); },
    },
    engines: {
      cli: async (engine) => (await ask("engines.cli", { engine })) as EngineCli | null,
    },
    web: { handle: expose },
    notify: (text) => notify(text),
  };
}
