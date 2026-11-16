// The plain types, names and constants of the host API (moved byte for byte out of api.ts; api.ts re-exports them).
export type Dispose = () => void;
export type JSONValue = unknown;

/** "bot" is a bot of its own (made with `bots.create`), not a project's manager. */
export interface BotInfo { id: string; name: string; role: "main" | "manager" | "bot"; awake: boolean; created?: boolean }
/**
 * A new bot: its name in the left column, what it is for, and optionally its shape. `parent`: make it a sub bot under that project
 * bot (or bot of its own) instead, hidden from the left column and working in its folder. `instructions`: any length (up to 200,000
 * characters), kept in a file the bot is told to read (asked again, the file is rewritten). `delegation: "onRequest"`: the bot does
 * its work itself and starts subagents or workers only when the user explicitly asks (it runs on Claude); "default" (or none): it
 * hands real work to them by default, as every other bot.
 */
export interface NewBot { name: string; job: string; avatar?: string; parent?: string; instructions?: string; delegation?: "default" | "onRequest" }
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
  /** A bot's note (`notes.read`) changed on disk by someone else (a bot, another editor) since this plugin read or saved it; `mtime` null: it was removed. Read it again with `notes.read`. */
  noteChanged: { botId: string; mtime: number | null };
  /** A card in a bot's note ran (started or finished): read `notes.cards` again for its state. `key` is the card's (`NoteCard.key`). */
  noteCardChanged: { botId: string; key: string };
  /** An edit made in a bot's note.md (by hand, a bot's file edit, git) could not be taken into note.db (it changed an older copy of a cell); it is kept as `file` beside it and note.md is the database's again. */
  noteConflict: { botId: string; file: string; reason: string };
  /** A worker this plugin started with `workers.start` finished a run (`run`); told to that plugin only, once per run. */
  workerReport: { botId: string; taskId: string; run: number; status: string; report: string; startedBy: string };
}
export type PluginEventName = keyof PluginEvents;
/** A tag this plugin declared (`contributes.replyTags`) in a bot's reply, as the bot wrote it; the chat never shows it. */
export interface ReplyTag { bot: BotInfo; tag: string; attributes: Record<string, string>; body: string }
export const EVENT_NAMES: readonly PluginEventName[] = ["messagePosted", "turnStarted", "turnFinished", "workerDone", "chatRead", "developerChanged", "botRemoved", "cardChanged", "componentsChanged", "libraryChanged", "maintainerReplied", "noteChanged", "noteCardChanged", "noteConflict", "workerReport"];

/** A line of a chat as Botling keeps it (chat.json's record: its id, role, words, Swift date and the rest). */
export interface ChatLine { id: string; role: string; text: string; date: number; [field: string]: unknown }
export interface ChatTask { id: string; name: string; state: string; messageIDs: string[] }
/** A chat-referenced content item (`owner`, `sha256:` id, and the `entry` that references it; protocol §9A.2, §9A.7). */
export interface ContentRef {
  owner: string;
  id: string;
  entry: { stream: string; seq: number };
}
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
  /**
   * The model's full context window in tokens (about 1M), from agy's ACP `usage_update`; null until agy has reported one
   * (e.g. a conversation not run since Botling started). It is NOT where agy compacts (earlier, around 290k).
   * Only from `agyUsage`; `agyWorkerUsage` leaves it out.
   */
  window?: number | null;
}
/** An agy worker an agy head started (`workspace.agyWorkers`). */
export interface AgyWorker {
  /** Its id in Botling's agent registry (`ag-…`). */
  id: string;
  /** Its worker id (the registry's `nativeId`, its folder's name): what `agyWorkerUsage` takes. */
  nativeId: string;
  /** Its agy conversation (for `agyUsage`); null: it has not started one yet. */
  sessionId: string | null;
  name: string;
  state: "running" | "idle" | "reportPending" | "completed" | "failed" | "stopped" | "interrupted" | "lost";
  model: string | null;
  /** Epoch ms. */
  createdAt: number;
  endedAt: number | null;
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
  /**
   * The agy workers the agy head session `sessionId` started (as in `current().heads`), oldest first, from Botling's
   * agent registry; [] for none. Each one's usage: `agyUsage(worker.sessionId)`, or `agyWorkerUsage(worker.nativeId)`.
   */
  agyWorkers(sessionId: string): Promise<AgyWorker[]>;
  /** An agy worker's usage by its worker id (`AgyWorker.nativeId`), read from its own folder; null: no conversation yet. */
  agyWorkerUsage(workerId: string): Promise<AgyUsage | null>;
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
  /** A watch ("Name: !command"): the app runs the command and wakes the bot only when it fails; its last run, if any. */
  watch?: { command: string; state: "never" | "ok" | "failing"; lastRun: string | null; exit: number | null; timedOut: boolean };
}
export interface RoutinesList { routines: RoutineRow[]; error: string | null }
export interface UsageApi {
  /** The usage now: the core reads the CLIs' quota first (at most about once a minute), then answers. */
  view(): Promise<UsageView>;
}

/** One plugin on the dependency board (`plugins.deps`; desktop/src/core/plugins/dep-board.ts is the source of these shapes). `app`: the app's own page, not a plugin. */
export interface DepNode {
  name: string; title: string; version: string; enabled: boolean; builtIn: boolean; failure: string | null; app: boolean;
  /** Whether its manifest has kernel fields; the lists below are empty for a plugin without them. */
  declared: boolean;
  provides: { services: string[]; slots: string[] }; requires: string[]; uses: string[];
  /** The slots it fills now (new names), while it is on. */
  fills: string[];
}
/** An arrow from the plugin that needs a service to one that provides it; `live`: both are on. */
export interface DepEdge { from: string; to: string; service: string; kind: "requires" | "uses"; live: boolean }
/** A service an enabled plugin requires that no enabled plugin provides (`offProviders`: plugins that do, but are off). */
export interface DepMissing { plugin: string; service: string; offProviders: string[] }
export interface DepSlot { slot: string; group: "view" | "menu" | "status" | "hook" | "other"; fills: string[] }
export interface DepBoard { plugins: DepNode[]; edges: DepEdge[]; missing: DepMissing[]; slots: DepSlot[] }
export interface PluginsApi {
  /** Who depends on whom among the plugins, read only: every plugin's name, version, on or off, services, slots and the arrows between them. */
  deps(): Promise<DepBoard>;
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
  /** The pid the install script waits for to quit: main's in 2.x, botlingd's in Botling 3 (null: no app around). */
  pid: number | null;
  /** The core's data folder, and the app's own. */
  dataDir: string;
  appDataDir: string | null;
  /** The app bundle running now (null: not running from a bundle, as in development). */
  bundle: string | null;
  developerMode: boolean;
  /** The project that is Botling's own source while developer mode is on. */
  developer: { id: string; name: string; folder: string } | null;
  /** Botling 3: botlingd runs the core; its data folder (the install script's last word). Null or absent in 2.x. */
  server?: { dataDir: string } | null;
}
export interface AppApi {
  state(): Promise<AppState>;
  /**
   * Starts `command` (the install script `<dataDir>/self-update/install.sh` with its twelve words, thirteen in Botling 3) detached and quits the app for it, after
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

/** A bot's note as `notes.read` gives it: its absolute path (to show, never to write by hand), its words and its mtime (ms). */
export interface BotNote { path: string; text: string; mtime: number }
/** What `notes.write` did: saved, or refused because the note on disk changed since `base` (its words and mtime come back to take in). */
export type NoteSave = { saved: true; mtime: number } | { saved: false; text: string; mtime: number };
/** A picture kept in the note's own folder: `ref` is what the note links ("note-assets/<hash>.png", relative to the note); `url` is what a frame's <img> loads (null: not there). */
export interface NoteAsset { ref: string; url: string | null }
/** What `notes.localizeImages` did: as `notes.write` (refused when the note changed since `base`), plus the note's words now and which pictures were copied in, missing or failed. */
export type NoteLocalized =
  | { saved: true; text: string; mtime: number; copied: Array<{ from: string; ref: string }>; missing: string[]; failed: Array<{ from: string; error: string }> }
  | { saved: false; text: string; mtime: number; copied: []; missing: []; failed: [] };

/** A fork in a note: `<!-- branch: name -->`, then its routes (format: note-format.ts). Lines are 0-based. */
export interface NoteFork { key: string; name: string; line: number; end: number | null; routes: NoteRoute[] }
/** A route of a fork: `<!-- route: name -->` and the lines up to `end` (exclusive). */
export interface NoteRoute { key: string; name: string; line: number; end: number; forks: NoteFork[] }
/** A `<show name="…">…</show>` in a note, as the chat reads one. */
export interface NoteCard {
  /** `note/<16 hex>-<n>`: from its name and command, the nth such card; kept while the note changes around it. */
  key: string; line: number; endLine: number; name: string; command: string | null;
  /** refresh="10m" in seconds; null: none (or past an hour). */
  refresh: number | null;
  /** Its JSON ("null" when empty). */
  data: string; attributes: Record<string, string>; source: string;
  /** The innermost route it is in (its key); null: shared. */
  route: string | null;
}
/** One way through a note's forks: each fork's key to a route's name. */
export type NoteRoutePicks = Record<string, string>;
export interface NoteParsed {
  forks: NoteFork[]; cards: NoteCard[];
  /** Every way through, first routes first. */
  routes: NoteRoutePicks[];
  /** Marker lines that could not be placed and cards that could not be read (kept as text). */
  problems: { line: number; message: string }[];
  /** With `picks`: the note as that way reads it, without markers, and where each line came from. */
  view?: { text: string; lines: number[] };
  /** The Note tab's own cells (desktop/src/core/note-cells.ts `cellRuns`, the editor's rules): lines 0-based; `id` from a `<!-- cell: id -->` line. */
  cells: NoteCellRun[];
  /** Its branches as the editor reads them (`parseBranches`): keys "<parent fork key>/<parent route>>name#n". */
  branches: NoteBranch[];
  /** With `lines`: what each line is (fence / code / card / table / mathb / text) and its block's lines. */
  lines?: Array<{ kind: "text" } | { kind: "fence" | "code" | "card" | "table" | "mathb"; start: number; end: number }>;
}
export interface NoteCellRun {
  start: number; end: number; above: number; below: number; softAbove: boolean; softBelow: boolean; aboveCell: boolean; belowCell: boolean;
  first: number; last: number; empty: boolean; type: "markdown" | "code" | "math" | "table" | "card"; id: string | null;
}
export interface NoteBranch {
  key: string; name: string; start: number; endLine: number; depth: number; parent: { fork: string; route: string } | null;
  routes: Array<{ name: string; marker: number; start: number; end: number; implicit: boolean }>;
}
/** Where a cell sits: each fork and route around it, outermost first. */
export interface NotePathStep { fork: string; forkId: string; route: string; routeId: string }
/** `notes.outline`: the ids note.db gives the cells and forks of a text (lines 0-based, `end` inclusive for cells). */
export interface NoteOutline {
  mode: "db" | "file"; reason: string | null; rev: number; mtime: number;
  /** Without `text` in the ask: the note it refers to (as notes.read gives it). */
  text?: string;
  /** `id` null: a cell not saved yet. `rev` null: not saved as it reads now. `label`: "Note #<id> · Fork › Route", for a quote's first line. */
  cells: Array<{ id: string | null; rev: number | null; kind: "text" | "card" | "image"; type: NoteCellRun["type"]; start: number; end: number; path: NotePathStep[]; label: string }>;
  /** `label`: "Note #<id> · Fork › Route › Name" (the routes above it, then its name), for a quote's first line. */
  forks: Array<{ id: string | null; name: string; start: number; end: number; path: NotePathStep[]; label: string; routes: Array<{ id: string | null; name: string; implicit: boolean; start: number; end: number }> }>;
}
/** A component for a note's insert menu. */
export interface NoteComponent {
  name: string; title: string | null; summary: string;
  /** In the bot's own list (else elsewhere in the library). */
  offered: boolean;
  /** Its Command: an empty `<show name="…"></show>` runs it. */
  command: string | null; every: number | null; sizes: string[]; icon: string | null;
  /** The newest JSON the bot's chat drew it with (a preview); null: none. */
  chatData: string | null;
}
/** A note card as it draws now. */
export interface NoteCardState {
  key: string; name: string; exists: boolean;
  /** What it runs: its command="…", or its component's Command when it has no JSON; null: it shows its JSON. */
  command: string | null; folder: string; every: number | null;
  status: "static" | "approve" | "idle" | "running" | "done" | "failed";
  /** JSON to draw: the last run's output, else its own JSON. */
  data: string; error: string | null; ranAt: number | null;
  images: Record<string, string>; chatData: string | null;
}
