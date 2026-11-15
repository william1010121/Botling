// The versioned contract between the renderer, the Electron main process and the core process.
//
// Three kinds of envelope travel on every hop (renderer ⇄ main ⇄ core):
//   request  {v, id, cmd}               — a command, answered by exactly one response with that id
//   cancel   {v, cancel: id}            — the sender no longer wants that request's result
//   response {v, id, ok, result|error}  — the answer
//   event    {v, epoch, seq, event}     — something that happened; seq is gapless per epoch
//
// `epoch` changes whenever the core process starts, so a renderer that sees a new epoch or a gap in
// `seq` takes a fresh `chat.snapshot` instead of guessing. Every hop validates what it receives
// with the schemas below: the renderer is not trusted by main, and main does not let anything but
// these shapes reach the core.
import { z } from "zod";
import { DoctorView } from "./doctor";
export { DoctorCheck, DoctorView } from "./doctor";
import { ContractId, CARD_SAVE_LIMIT, FILE_DATA_LIMIT } from "./editor-card";
export { CARD_SAVE_LIMIT, FILE_DATA_LIMIT } from "./editor-card";
import { PROTOCOL_VERSION, RequestId, BotId, Engine, AnswerTarget, MESSAGE_TEXT_LIMIT, StepView, SubagentRowView, SubagentView, DelegationRowView, MessageView, PendingFileView, ComponentInfoView, WaitingView, UploadedFile } from "./views";
export * from "./views";
import { describeIssues, WireError } from "./results";
export * from "./results";

const id = ContractId;
const AgentMoveTo = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("bot"), botId: BotId }),
  z.strictObject({ kind: z.literal("newSubBot"), name: z.string().min(1).max(400), note: z.string().max(4_000).optional() }),
  z.strictObject({ kind: z.literal("back") }),
]);

export const BotView = z.strictObject({
  /** The head turn's token speed (core/token-speed.ts), from the head that last finished a request; null: nothing timed yet. */
  tokenSpeed: z.strictObject({ tokPerSec: z.number().positive(), estimated: z.boolean(), engine: z.enum(["claude", "codex", "agy"]) }).nullable().optional(),
  delegationRows: z.array(DelegationRowView).max(500).optional(),
  id: BotId,
  name: z.string().max(200),
  /** main: the front desk; manager: works in a project folder; bot: a bot of its own. */
  role: z.enum(["main", "manager", "bot"]),
  /** True on the Maintainer bot only (absent on every other bot). */
  maintainer: z.literal(true).optional(),
  /** An avatar shape (`AvatarShape` in the Swift app: circle, square, …). */
  avatar: z.string().max(40),
  folder: z.string().max(4_000),
  /** asleep: no agent process; starting; awake: its process is running; tidying: writing its notes before it sleeps; switching: writing a handoff before it runs on the other engine. */
  phase: z.enum(["asleep", "starting", "awake", "tidying", "switching"]),
  working: z.boolean(),
  /** Engine API retries or an outage waiting for recovery (1.x retryingConnection / outage). */
  connection: z.enum(["retrying", "disconnected"]).nullable().optional(),
  /**
   * Its Codex head waits to try a refused request again (codex's `error` with willRetry): which
   * attempt of how many, why (rateLimited: HTTP 429), and when it goes (ms since 1970; null: not
   * known). Null or absent: not waiting. Codex's own counterpart of bot/sidebar-offline-label's
   * `connection: "retrying"` (claude's api_retry); the two can merge once both land.
   */
  codexRetry: z.strictObject({
    attempt: z.number().int().nonnegative(), max: z.number().int().nonnegative(),
    reason: z.enum(["rateLimited", "connection"]), retryAt: z.number().nullable(),
  }).nullable().optional(),
  /** Tool approvals waiting for the user. */
  approvals: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
  /** Its subagents still at work. */
  subagents: z.number().int().nonnegative(),
  /** Why its chat cannot be used (an unreadable chat file, a missing folder); null when fine. */
  problem: z.string().max(2_000).nullable(),
  /** Its heads, Claude first: one, or Claude and Codex in one chat. */
  heads: z.array(Engine).min(1).max(3),
  /** A bot of its own's job (null for the main bot and managers). */
  job: z.string().max(4_000).nullable(),
  /** A sub bot: the project bot it belongs to. The left column does not list it; its project bot's Tasks list does. */
  parent: BotId.nullable().optional(),
  /** Its subagents sent off by the bot itself (not ones a subagent sent), newest kept. */
  subagentRows: z.array(SubagentRowView).max(100),
  /** Another bot answering in its chat right now (called in with @), for the typing bubble. */
  guest: BotId.nullable().optional(),
  /** The bots called into its chat and not answered yet, in turn order: answering now, or queued behind another call-in. */
  callIns: z.array(z.strictObject({ id: BotId, state: z.enum(["answering", "queued"]) })).max(100).optional(),
  /** The chat it is answering a call-in in right now (null: none). */
  answeringIn: BotId.nullable().optional(),
  /** When its chat's newest line was said (ISO-8601; null: no lines): the column lists chats newest first (`lastActivity`). Phase 5a. */
  lastActivity: z.string().max(40).nullable().optional(),
  /** The bot's own component list (bot.json `components`); null: no list (a group has every component). Phase 5a. */
  components: z.array(z.string().max(200)).max(500).nullable().optional(),
});
export type BotView = z.infer<typeof BotView>;

/** A hand-off between the heads, as the panel over the input box lists it. */
export const HandoffView = z.strictObject({
  id,
  from: Engine,
  to: Engine,
  kind: z.enum(["task", "review", "discuss"]),
  task: z.string().max(400),
  origin: z.string().max(400).nullable(),
  round: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  state: z.enum(["running", "waiting", "done", "stopped"]),
  lines: z.array(z.strictObject({ who: Engine, text: z.string().max(2_000) })).max(20),
});
export type HandoffView = z.infer<typeof HandoffView>;

/** A bot with two heads: who new messages go to, where the hand-offs for your latest message stand. */
export const HeadsView = z.strictObject({
  engines: z.array(Engine).min(1).max(3),
  answerWith: AnswerTarget,
  handoffsOn: z.boolean(),
  rounds: z.strictObject({ kind: z.enum(["discussion", "review", "handoff"]), round: z.number().int().nonnegative(), limit: z.number().int().nonnegative(), text: z.string().max(200) }).nullable(),
  handoffs: z.array(HandoffView).max(12),
});
export type HeadsView = z.infer<typeof HeadsView>;

export const ImportView = z.strictObject({
  source: z.string().max(4_000),
  at: z.string(),
  bots: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  skipped: z.array(z.string().max(2_000)).max(200),
});
export type ImportView = z.infer<typeof ImportView>;

export const RunningView = z.strictObject({ turnId: id, messageId: id });
export type RunningView = z.infer<typeof RunningView>;
/** A turn under way, with its head (two heads can work at once) and its steps so far. */
export interface RunView { turnId: string; messageId: string; head?: "claude" | "codex" | "agy"; live: StepView[] }

/** A routine: a routines.cron line ("legacy", system time) or an app-owned schedule (once / recurring in a zone). */
export const RoutineView = z.strictObject({
  /** "cron:<line>" for a routines.cron job; the saved id otherwise. */
  id: z.string().min(1).max(2_200),
  kind: z.enum(["once", "recurring", "legacy"]),
  task: z.string().max(2_000),
  title: z.string().max(400),
  /** "Every day 08:15", the cron fields, or (once) its time as ISO-8601. */
  schedule: z.string().max(400),
  /** A recurring job's five cron fields ("0,30 * * * *"); null for a one-time job. */
  cron: z.string().max(400).nullable().optional(),
  timezone: z.string().max(100),
  /** pending, due, paused, fired, cancelled, delivery_uncertain; enabled/paused for routines.cron. */
  status: z.string().max(40),
  /** When it next runs (ISO-8601), if it will. */
  next: z.string().nullable(),
  /** A watch ("Name: !command"): the app runs the command and wakes the bot only when it fails; its last run, if any. */
  watch: z.strictObject({
    command: z.string().max(2_000),
    /** never (not run yet), ok, failing. */
    state: z.enum(["never", "ok", "failing"]),
    lastRun: z.string().nullable(),
    exit: z.number().int().nullable(),
    timedOut: z.boolean(),
  }).optional(),
});
export type RoutineView = z.infer<typeof RoutineView>;


// ---------------------------------------------------------------------------------------------
// Commands. `target` says who answers it: main answers some itself, the rest go to the core.

const botId = BotId;
const PluginName = z.string().min(1).max(214).regex(/^[a-z0-9][a-z0-9._-]*$/);

/**
 * What a plugin's web part draws among a chat's messages (chat extension v2, `chat.decorate`): a card
 * that folds the lines in `fold` behind it (drawn before the first), or one after the line `after`, or one under the words of the message `under`.
 * `tasks` is accepted and ignored (task cards were removed in 2.5); `data` is the plugin's own, for its web part.
 */
export const ChatDecoration = z.strictObject({
  plugin: PluginName,
  key: z.string().max(300),
  fold: z.array(id).max(2_000).optional(),
  after: id.optional(),
  /** Or inside the message's own column, under its words (a component made from a reply: its chip). */
  under: id.optional(),
  tasks: z.array(id).max(100).optional(),
  data: z.unknown().optional(),
});
export type ChatDecoration = z.infer<typeof ChatDecoration>;
const PluginCommandId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
/** The app's fixed places a plugin may add a command to (`contributes.menus`). */
const PluginMenu = z.enum(["message/context", "bot/context", "composer/plus", "commandPalette", "message/preview", "browser/tab", "chat/link"]);
/** A `browser/tab` menu entry's tabs, or a `chat/link` one's links (browser-tab-menu.ts `TabWhen`). */
const TabWhenView = z.strictObject({ scheme: z.string().max(100).optional(), ext: z.array(z.string().max(20)).max(20).optional(), host: z.string().max(100).optional() });
/** Who asks a plugin: one of its sandboxed frames (panel, tile, card) or the chat page (its web part). */
const PluginCaller = z.enum(["frame", "chat"]);
/** A bot as plugins name it ("main", or its id: `bots.list`). */
const PluginBotId = z.union([z.literal("main"), BotId]);
const SettingKey = z.string().min(1).max(200);
const SettingValue = z.union([z.boolean(), z.number(), z.string().max(10_000), z.null()]);

/** One plugin as the Plugins panel shows it. Secrets show only whether they are set. */
export const PluginView = z.strictObject({
  name: PluginName,
  title: z.string().max(200),
  version: z.string().max(100),
  description: z.string().max(2_000).nullable(),
  enabled: z.boolean(),
  failure: z.string().max(2_000).nullable(),
  installedFrom: z.string().max(2_000).nullable(),
  /** Shipped with Botling (step M11): read-only, can only be turned off. */
  builtIn: z.boolean().optional(),
  /** What this machine grants this plugin at its running hash (Botling 3 only; 2.x leaves it unset). */
  grant: z.enum(["none", "read", "request", "write"]).optional(),
  /**
   * What this plugin asks at its running hash on this machine (Botling 3 only): the window's Settings › Plugins offers the
   * tiers up to `tier` and sends one `plugin.grant` at exactly this hash and these asks. Lazy: the schemas are defined below.
   */
  asks: z.strictObject({
    codeHash: z.lazy(() => PluginCodeHash),
    tier: z.enum(["read", "request", "write"]),
    reads: z.array(z.string().min(1).max(200)).max(50),
    requests: z.array(z.lazy(() => CommandTypeEnum)).max(100),
  }).optional(),
  /** A library plugin running in place of the built-in one of the same name (its version is the same or newer): the built-in's version. */
  replacesBuiltIn: z.string().max(100).optional(),
  /** A built-in plugin running while the library holds an older copy (or one whose version is not a semver), which is ignored: that copy's version. */
  ignoredLibraryVersion: z.string().max(100).optional(),
  /** Entries of its `contributes` this Botling skips, with why (a slot or value it does not know): the rest of it loads. */
  skipped: z.array(z.string().max(2_000)).max(50).optional(),
  /** Installed from outside (the catalog, <install>): the Plugins page offers Remove (its data folder stays). */
  removable: z.boolean().optional(),
  /** The version an install or update replaced, kept for Revert. */
  revertTo: z.string().max(100).optional(),
  permissions: z.array(z.string().max(40)).max(20),
  parts: z.array(z.enum(["web", "host", "claude", "components"])).max(4),
  settings: z.array(z.strictObject({
    key: SettingKey, type: z.string().max(20), title: z.string().max(400), options: z.array(z.string().max(200)).max(50),
    value: SettingValue, secret: z.boolean(), set: z.boolean(),
    /** Set on the Settings page instead (a built-in plugin's), not listed with the plugin. */
    hidden: z.boolean().optional(),
    /** What it is while you have not set it. */
    default: SettingValue.optional(),
  })).max(100),
  commands: z.array(z.strictObject({ id: z.string().max(200), title: z.string().max(200), registered: z.boolean() })).max(100),
  panels: z.array(z.strictObject({ id: z.string().max(100), title: z.string().max(200) })).max(20),
  /** What its program part shows in the status area (`ui.setStatus`); `command`: one of its own, run on a click. */
  status: z.array(z.strictObject({
    id: z.string().max(100), text: z.string().max(200), icon: z.string().max(100).nullable(), tooltip: z.string().max(1_000).nullable(), command: z.string().max(200).nullable(),
  })).max(20).optional(),
});
export type PluginView = z.infer<typeof PluginView>;
// ---------------------------------------------------------------------------------------------
// Settings (settings.json, 1.x's AppSettings keys; per-bot choices in bot.json)

const BotModel = z.enum(["haiku", "sonnet", "opus"]);
const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const ModelId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:\/-]+$/);
/** A bot's settled face colour: #RRGGBB and the avatar shape it was settled on. */
export const HeldBotColor = z.strictObject({ avatar: z.string().max(40), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/) });
export const SettingsView = z.strictObject({
  agyAcpPath: z.string().nullable().optional(),
  language: z.enum(["en", "zh-Hant"]).nullable(),
  /** The language in effect: the chosen one, else the system's (`AppLanguage.preferred`). */
  effectiveLanguage: z.enum(["en", "zh-Hant"]),
  botLook: z.enum(["original", "cute"]),
  chatAvatarSize: z.number().int().min(32).max(96).nullable(),
  /** The whole app's look (Settings → Appearance → App): dark (1.x's look, the default), light, or the system's appearance. */
  appTheme: z.enum(["dark", "light", "system"]).default("dark"),
  /** How report pages (result previews) are drawn: dark, light, or "system": the app's look (appTheme). */
  reportTheme: z.enum(["dark", "light", "system"]).default("system"),
  subagentModel: BotModel.nullable(),
  /** The Claude subagents' (app-managed workers') thinking effort new bots start with; null: each bot's own effort. */
  subagentEffort: Effort.nullable().default(null),
  subagentHourCache: z.boolean(),
  claudeBypassPermissions: z.boolean().default(false),
  codexBypassPermissions: z.boolean().default(false),
  agyBypassPermissions: z.boolean().default(false),
  agyPermissionSessions: z.array(z.object({sessionId:z.string(), mode:z.enum(["default","yolo"]), state:z.enum(["negotiating","ready","active","stopped","error"]), message:z.string()})).default([]),
  /** How many Claude workers of one bot may be at work at once (settings.json `claudeWorkerLimit`); more wait for a slot. */
  claudeWorkerLimit: z.number().int().min(1).max(16).default(4),
  codexWorkersFollow: z.boolean(),
  codexWorkers: z.strictObject({ model: z.string().max(200).nullable(), effort: Effort.nullable(), fast: z.boolean().nullable() }),
  /** Antigravity workers' model new bots start with (settings.json `agyWorkerModelDefault`); null: the same as the head. */
  agyWorkerModel: z.string().max(200).nullable().default(null),
  /** Antigravity workers' effort new bots start with (`agyWorkerEffortDefault`; low, medium or high); null: the head's. */
  agyWorkerEffort: Effort.nullable().default(null),
  /** Read-only, from ~/.claude/settings.json `autoCompactWindow` (tokens); null: not set there (Claude Code's own default). */
  claudeAutoCompactWindow: z.number().int().positive().nullable().optional(),
  /** Read-only, the top-level model, effort and service tier of ~/.codex/config.toml (what workers use while following it). */
  codexConfigFile: z.strictObject({ model: z.string().max(200).nullable(), effort: z.string().max(40).nullable(), fast: z.boolean().nullable() }).nullable().optional(),
  /** Read-only, settings.json `specWriters`: model families whose workers may write spec/. */
  specWriters: z.array(z.string().max(200)).max(50).optional(),
  componentEditorModel: BotModel,
  /** Engines and models: what a new bot starts with, the primary a bot without its own follows, and what "Apply to all bots" writes. */
  engineDefaults: z.strictObject({
    engines: z.array(Engine).min(1).max(3),
    primary: Engine.nullable(),
    models: z.strictObject({ claude: z.string().max(200).nullable(), codex: z.string().max(200).nullable(), agy: z.string().max(200).nullable() }),
    efforts: z.strictObject({ claude: Effort.nullable(), codex: Effort.nullable(), agy: Effort.nullable() }),
  }),
  resultPublishing: z.enum(["artifactUnlessSensitive", "localOnly", "artifactAlways"]),
  stallReminderMinutes: z.number().int().min(0).max(10_000),
  /** The right panel folded into a strip of icons (1.x's `rightPanelCollapsed`). */
  rightPanelCollapsed: z.boolean(),
  /** The left column folded into a strip of faces (1.x's `railCollapsed`). */
  railCollapsed: z.boolean(),
  /** Bots pinned to the top of the left column, in the order they were pinned (1.x's `pinnedBots`). */
  pinnedBots: z.array(BotId).max(200),
  /** Bots the user put away in the left column's Idle group, in the order they were sent (never automatic); absent: none. */
  idleBots: z.array(BotId).max(200).optional(),
  /** Sub bots pinned in the header's Sub bots menu (⌘⌥1–9), in the order dragged there; absent: none. */
  pinnedSubBots: z.array(BotId).max(200).optional(),
  /** Developer mode (1.x's `developerMode`): the project that is Botling's own source gets what you flag as "not right". Phase 5a. */
  developerMode: z.boolean(),
  developerProject: BotId.nullable(),
  /** Phase 5b (2.0 only): main looks at GitHub Releases for a newer Botling 2 (once a day; off by default). */
  updateCheck: z.boolean(),
  /** Keyboard shortcuts the user rebound (id to binding, see shortcuts.ts); an id left out has its default. */
  shortcuts: z.record(z.string().max(200), z.string().max(40)).default({}),
  /** The plugin tab each bot's main area last showed ("<plugin>/<view id>", PluginsView `mainTabs`); a bot left out shows Chat. */
  mainTabs: z.record(BotId, z.string().max(320)).optional(),
  /** Each bot's settled face colour and the shape it was settled on (avatars.ts heldBotColors); absent: none yet. */
  botColors: z.record(BotId, HeldBotColor).optional(),
});
export type SettingsView = z.infer<typeof SettingsView>;
/** One change on the Settings page (null: back to the default). */
export const SettingsChange = z.discriminatedUnion("key", [
  z.strictObject({ key: z.literal("agyAcpPath"), value: z.string().max(4096).nullable() }),
  z.strictObject({ key: z.literal("language"), value: z.enum(["en", "zh-Hant"]).nullable() }),
  z.strictObject({ key: z.literal("botLook"), value: z.enum(["original", "cute"]) }),
  z.strictObject({ key: z.literal("chatAvatarSize"), value: z.number().int().min(32).max(96).nullable() }),
  z.strictObject({ key: z.literal("appTheme"), value: z.enum(["dark", "light", "system"]) }),
  z.strictObject({ key: z.literal("reportTheme"), value: z.enum(["dark", "light", "system"]) }),
  z.strictObject({ key: z.literal("subagentModel"), value: BotModel.nullable() }),
  z.strictObject({ key: z.literal("subagentEffort"), value: Effort.nullable() }),
  z.strictObject({ key: z.literal("subagentHourCache"), value: z.boolean() }),
  z.strictObject({ key: z.literal("claudeWorkerLimit"), value: z.number().int().min(1).max(16).nullable() }),
  z.strictObject({ key: z.literal("claudeBypassPermissions"), value: z.boolean() }),
  z.strictObject({ key: z.literal("codexBypassPermissions"), value: z.boolean() }),
  z.strictObject({ key: z.literal("agyBypassPermissions"), value: z.boolean() }),
  z.strictObject({ key: z.literal("codexWorkersFollow"), value: z.boolean() }),
  z.strictObject({ key: z.literal("codexWorkers"), value: z.strictObject({ model: ModelId.nullable(), effort: Effort.nullable(), fast: z.boolean().nullable() }) }),
  z.strictObject({ key: z.literal("agyWorkerModel"), value: ModelId.nullable() }),
  z.strictObject({ key: z.literal("agyWorkerEffort"), value: Effort.nullable() }),
  z.strictObject({ key: z.literal("componentEditorModel"), value: BotModel }),
  z.strictObject({ key: z.literal("defaultEngines"), value: z.array(Engine).min(1).max(3) }),
  z.strictObject({ key: z.literal("defaultPrimaryEngine"), value: Engine.nullable() }),
  z.strictObject({ key: z.literal("defaultEngineModel"), value: z.strictObject({ engine: Engine, model: ModelId.nullable() }) }),
  z.strictObject({ key: z.literal("defaultEffort"), value: z.strictObject({ engine: Engine, effort: Effort.nullable() }) }),
  z.strictObject({ key: z.literal("resultPublishing"), value: z.enum(["artifactUnlessSensitive", "localOnly", "artifactAlways"]) }),
  z.strictObject({ key: z.literal("stallReminderMinutes"), value: z.number().int().min(0).max(1_440) }),
  z.strictObject({ key: z.literal("rightPanelCollapsed"), value: z.boolean() }),
  z.strictObject({ key: z.literal("developerMode"), value: z.boolean() }),
  z.strictObject({ key: z.literal("developerProject"), value: BotId.nullable() }),
  z.strictObject({ key: z.literal("railCollapsed"), value: z.boolean() }),
  z.strictObject({ key: z.literal("pinnedBots"), value: z.array(BotId).max(200) }),
  z.strictObject({ key: z.literal("idleBots"), value: z.array(BotId).max(200) }),
  z.strictObject({ key: z.literal("pinnedSubBots"), value: z.array(BotId).max(200) }),
  z.strictObject({ key: z.literal("updateCheck"), value: z.boolean() }),
  /** The plugin tab a bot's main area shows (null: none, Chat). */
  z.strictObject({ key: z.literal("mainTab"), value: z.strictObject({ botId: BotId, tab: z.string().min(1).max(320).nullable() }) }),
  /** All rebound shortcuts at once (an empty object: every default). */
  z.strictObject({ key: z.literal("shortcuts"), value: z.record(z.string().max(200), z.string().max(40)) }),
  /** All settled bot colours at once (the renderer holds them, see avatars.ts heldBotColors). */
  z.strictObject({ key: z.literal("botColors"), value: z.record(BotId, HeldBotColor).refine((value) => Object.keys(value).length <= 2_000) }),
]);
export type SettingsChange = z.infer<typeof SettingsChange>;
/** A newer Botling 2 on GitHub Releases (found by electron-updater); installation needs an explicit download and restart. */
export const ReleaseView = z.strictObject({
  version: z.string().max(100), name: z.string().max(400), url: z.string().max(2_000), publishedAt: z.string().max(100).nullable(),
  /** This platform's download on the release page, when it has one. */
  asset: z.string().max(400).nullable(),
});
export type ReleaseView = z.infer<typeof ReleaseView>;
export const UpdateView = z.strictObject({
  current: z.string().max(100),
  /** False: the check is off in Settings (and nothing was fetched). */
  enabled: z.boolean(),
  /** The newest release for this build, when it is newer than this one. */
  newer: ReleaseView.nullable(),
  checkedAt: z.number().nullable(),
  error: z.string().max(2_000).nullable(),
  installError: z.string().max(2_000).nullable().optional(),
  readyVersion: z.string().max(100).nullable().optional(),
  /** 0 to 100 while a download is under way (the sidebar's update entry), else null. */
  downloadPercent: z.number().min(0).max(100).nullable().optional(),
});
export type UpdateView = z.infer<typeof UpdateView>;

/** Tokens (1.x's `TokenUsage`). */
const TokensView = z.strictObject({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(), cacheWrite: z.number().int().nonnegative(), cacheRead: z.number().int().nonnegative() });
/** One limit: 0…1 used, when it starts over and when the reading came (ms since 1970). */
const LimitWindowView = z.strictObject({ used: z.number().min(0).max(1), resetsAt: z.number().nullable(), seen: z.number() });
const LimitsView = z.strictObject({ fiveHour: LimitWindowView.nullable(), week: LimitWindowView.nullable() });
/** What the bots used (Phase 5c; 1.x's usage page): today, by bot, the days before, and each CLI's subscription limits. */
const QuotaStatus = z.enum(["available", "missing", "auth_required", "token_expired", "auth_rejected", "forbidden", "timeout", "network_error", "invalid_response", "cli_unavailable"]);
/** Official ACP /usage quota buckets; groups and windows are provider-defined. */
export const AntigravityQuotaBucket = z.strictObject({
  group: z.string(), label: z.string(),
  remainingFraction: z.number().min(0).max(1).optional(),
  remainingAmount: z.string().regex(/^\d+$/).optional(),
  resetsAt: z.number().finite().optional(), disabled: z.boolean().optional(),
});
export const AntigravityQuotaView = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available"), source: z.literal("antigravity_acp"),
    seen: z.number().finite(), buckets: z.array(AntigravityQuotaBucket).min(1) }),
  z.strictObject({ status: z.enum(["unavailable", "error"]), source: z.literal("antigravity_acp"),
    reason: z.enum(["unsupported_connection", "no_connection", "busy", "missing_data", "request_failed", "invalid_response"]),
    lastKnown: z.strictObject({ seen: z.number().finite(), buckets: z.array(AntigravityQuotaBucket).min(1) }).optional() }),
]);
export type AntigravityQuotaView = z.infer<typeof AntigravityQuotaView>;
export const UsageView = z.strictObject({
  antigravity: AntigravityQuotaView.optional(),
  quotaStatus: z.strictObject({ claude: QuotaStatus, codex: QuotaStatus }).optional(),
  /** Whether local spending was read or recorded; missing/corrupt files are not measured zero. */
  spendingStatus: z.enum(["available", "missing", "unreadable"]),
  day: z.string().max(20),
  spent: z.number().nonnegative(),
  tokens: TokensView,
  byBot: z.array(z.strictObject({ name: z.string().max(200), spent: z.number().nonnegative(), tokens: z.number().int().nonnegative(), breakdown: TokensView.nullable().optional() })).max(500),
  history: z.array(z.strictObject({ day: z.string().max(20), spent: z.number().nonnegative(), tokens: z.number().int().nonnegative() })).max(31),
  claude: LimitsView,
  codex: LimitsView,
});
export type UsageView = z.infer<typeof UsageView>;
/** A bot's own choices (bot.json): its heads, its model and effort, its subagents' model, Codex's model. */

/** The phone connection (mobile-bridge/desk.ts): off until the bridge is configured, then its routes in the order a phone
 * tries them and the paired phones. A pairing link is a secret shown once, so it is only in `MobilePairView`.
 * `relay` (mobile-relay/): the end-to-end encrypted relay, its address (null: off) and whether Botling is connected to it;
 * phones paired through it are listed with `via: "relay"`. */
export const MobileRouteView = z.strictObject({ kind: z.enum(["lan", "tailscale", "tunnel", "relay"]), origin: z.string().max(300) });
export const MobileRelayView = z.strictObject({ url: z.string().max(300).nullable(), state: z.enum(["off", "connecting", "online", "offline"]) });
/** Botling 3 only (botlingd's own pairing, server/pairing/phone-desk.ts; the 2.x core never sends it): whether the
 * cluster exists (made at once at the first pairing: the recovery code shown once in a dialog, never typed back), whether
 * BOTLING_SERVER_RELAY_URL fixes the relay, the pairings this window started (waiting for a scan, the 6-digit code to
 * compare, being added, paired or declined; never the link or its secret), and the paired phones (valid ones). */
export const MobileV3Offer = z.strictObject({
  offer: z.string().max(64), expiresAt: z.number(),
  state: z.enum(["waiting", "compare", "adding", "paired", "declined"]),
  code: z.string().regex(/^[0-9]{6}$/).optional(), device: z.string().max(100).optional(),
  reason: z.enum(["code", "expired", "cancelled", "refused"]).optional(),
});
export const MobileV3View = z.strictObject({
  cluster: z.enum(["none", "confirming", "ready"]), relayFixed: z.boolean(),
  offers: z.array(MobileV3Offer).max(10),
  devices: z.array(z.strictObject({ id: z.string().max(64), name: z.string().max(100), addedAt: z.number(), scope: z.array(z.string().max(16)).max(8) })).max(400),
});
export type MobileV3View = z.infer<typeof MobileV3View>;
export const MobileDeskView = z.strictObject({
  enabled: z.boolean(), routes: z.array(MobileRouteView).max(6),
  devices: z.array(z.strictObject({ id: z.string().max(64), label: z.string().max(40), pairedAt: z.number(), expiresAt: z.number(), botIds: z.array(z.string().max(64)).max(200),
    via: z.enum(["bridge", "relay"]).optional() })).max(400),
  relay: MobileRelayView.optional(),
  v3: MobileV3View.optional(),
});
export type MobileDeskView = z.infer<typeof MobileDeskView>;
/** A pairing link (a secret, shown once). Botling 3 adds its offer id (to match the code to compare) and a note when
 * the link names only a placeholder address; its link is longer (an offer with keys, the secret and the cluster). */
export const MobilePairView = z.strictObject({ url: z.string().max(4_000), expiresAt: z.number(), route: MobileRouteView, offer: z.string().max(64).optional(), note: z.string().max(500).optional() });
export type MobilePairView = z.infer<typeof MobilePairView>;
/** Botling 3's first pairing: `mobile.cluster` without a code shows a new recovery code once; with one, confirms it. */
export const MobileClusterView = z.strictObject({ ok: z.boolean(), code: z.string().max(64).optional(), expiresAt: z.number().optional(), reason: z.string().max(40).optional() });
export type MobileClusterView = z.infer<typeof MobileClusterView>;


export const BotSettingsView = z.strictObject({
  botId: id,
  engines: z.array(z.enum(["claude", "codex", "agy"])).min(1).max(3),
  /** The bot's own primary engine; null: it follows the app's default. */
  primary: Engine.nullable().optional(),
  /** The engine a message goes to when the composer has not been used: its own, else the app's, else its first. */
  primaryEffective: Engine.optional(),
  model: z.string().max(200).nullable(),
  /** The old single effort; an engine with none of its own uses it. */
  effort: Effort.nullable(),
  /** Each engine's effective effort (its own, else `effort`); the levels an engine does not support are never shown. */
  efforts: z.strictObject({ claude: Effort.nullable(), codex: Effort.nullable(), agy: Effort.nullable() }).optional(),
  subagentModel: z.string().max(200).nullable(),
  /** Its Claude subagents' (app-managed workers') thinking effort; null: the bot's own Claude effort. */
  subagentEffort: Effort.nullable().optional(),
  codexModel: z.string().max(200).nullable(),
  agyModel: z.string().max(200).nullable().optional(),
  /** Its Codex workers' own model, effort and Fast mode (bot.json `codexWorkers`); null: ~/.codex/config.toml's. */
  codexWorkers: z.strictObject({ model: z.string().max(200).nullable(), effort: Effort.nullable(), fast: z.boolean().nullable() }).nullable().optional(),
  /** Its Antigravity workers' model and effort (bot.json `agyWorkerModel`, `agyWorkerEffort`); null: the same as its Antigravity head. */
  agyWorkerModel: z.string().max(200).nullable().optional(),
  agyWorkerEffort: Effort.nullable().optional(),
  /** Where its Claude workers run when app_handoff names no machine (bot.json `workerMachine`, Settings › Machines); null: here. */
  workerMachine: z.string().max(64).nullable().optional(),
});
export type BotSettingsView = z.infer<typeof BotSettingsView>;

/**
 * Settings › Machines (remote/service.ts): the machines Claude workers can run on, how each is reached (an ssh host
 * from ~/.ssh/config, or the relay), its trust, and what its last check found. An ssh machine waits for its host key
 * to be approved; a relay machine for the code it shows. The relay install line holds a one-time secret, so it is only
 * in `MachinePairView`.
 */
export const MachineView = z.strictObject({
  id: z.string().max(64), name: z.string().max(64), via: z.enum(["ssh", "relay"]), trust: z.enum(["asked", "trusted", "revoked"]),
  /** ssh: the alias. */
  host: z.string().max(255).nullable(),
  /** ssh: the host key's ("SHA256:…"); relay: the agent key's (shown on the machine too). */
  fingerprint: z.string().max(120).nullable(),
  /** ssh: the key was already in ~/.ssh/known_hosts. */
  known: z.boolean(),
  /** relay: it is waiting for its code here now. */
  waiting: z.boolean(),
  /** relay: its agent is connected to the relay. */
  connected: z.boolean(),
  info: z.strictObject({ node: z.string().max(100).nullable(), git: z.string().max(200).nullable(), claude: z.string().max(200).nullable(), platform: z.string().max(100).nullable(),
    at: z.number(), error: z.string().max(2_000).nullable() }).nullable(),
  /** Workers on it now (running or reconnecting). */
  workers: z.number().int().nonnegative(),
});
export type MachineView = z.infer<typeof MachineView>;
export const MachinesView = z.strictObject({
  /** False: workers on other machines are not available in this app (a test or probe run). */
  enabled: z.boolean(),
  relay: z.strictObject({ url: z.string().max(300).nullable(), state: z.enum(["off", "connecting", "online", "offline"]) }),
  machines: z.array(MachineView).max(100),
});
export type MachinesView = z.infer<typeof MachinesView>;
export const MachinePairView = z.strictObject({ command: z.string().max(4_000), expiresAt: z.number() });
export type MachinePairView = z.infer<typeof MachinePairView>;

/** A plugin's web part for the chat page (1.x's `WebPluginSpec`). */
export const WebPluginSpecView = z.strictObject({
  name: z.string().max(214), version: z.string().max(100), source: z.string().max(5_000_000),
  /** Its stylesheets, served by the chat origin (botling-chat://chat/plugin-files/<name>/<path>). */
  styles: z.array(z.string().max(2_000)).max(20),
  settings: z.record(z.string().max(200), z.unknown()),
  commands: z.array(z.strictObject({ id: z.string().max(200), title: z.string().max(200), key: z.string().max(40).optional() })).max(100),
  /** Ships with Botling: its web part may use the chat page's own parts (`ccb.page`, the message bars). */
  builtIn: z.boolean().optional(),
});
export type WebPluginSpecView = z.infer<typeof WebPluginSpecView>;
/** One plugin of the public catalog (botling-plugins' index.json) as the Plugins page's Explore and Updates show it. */
export const PluginStoreEntryView = z.strictObject({
  name: PluginName, title: z.string().max(200), description: z.string().max(2_000), version: z.string().max(100), license: z.string().max(100).nullable(),
  permissions: z.array(z.string().max(40)).max(20), parts: z.array(z.string().max(40)).max(8), minAppVersion: z.string().max(100).nullable(),
  size: z.number(), files: z.number(), commit: z.string().max(40),
  /** Its folder at that commit on GitHub; null until released. */
  page: z.string().max(2_000).nullable(),
  /**
   * available: not installed; installed: this version or newer is; update: an older one is installed (or built in); builtIn: Botling ships
   * this version or newer; devCopy: the plugin library has its own copy (never replaced); tooOld: this Botling is too old for it;
   * unreleased: no commit recorded yet.
   */
  state: z.enum(["available", "installed", "update", "builtIn", "devCopy", "tooOld", "unreleased"]),
  installedVersion: z.string().max(100).nullable(),
  /** An install from the page: being downloaded and checked, waiting on the install card, or how it ended. */
  status: z.strictObject({ kind: z.enum(["checking", "asking", "installed", "declined", "failed"]), message: z.string().max(2_000).nullable() }).nullable(),
});
export type PluginStoreEntryView = z.infer<typeof PluginStoreEntryView>;
export const PluginStoreView = z.strictObject({
  url: z.string().max(2_000),
  /** The official catalog (not settings.json `pluginIndexURL`). */
  official: z.boolean(),
  /** When the entries were fetched (ms since 1970); null: never. */
  fetchedAt: z.number().nullable(),
  /** The last fetch failed: the entries are the copy from `fetchedAt`. */
  fromCache: z.boolean(),
  error: z.string().max(2_000).nullable(),
  /** The last fetch did not reach the server at all. */
  offline: z.boolean(),
  loading: z.boolean(),
  appVersion: z.string().max(100).nullable(),
  entries: z.array(PluginStoreEntryView).max(500),
  /** How many installed plugins have a newer version in the catalog. */
  updates: z.number().int(),
});
export type PluginStoreView = z.infer<typeof PluginStoreView>;
export const PluginsView = z.strictObject({
  plugins: z.array(PluginView).max(200),
  /** Folders that look like plugins but failed the check, with why. */
  broken: z.array(z.strictObject({ folder: z.string().max(214), problems: z.array(z.string().max(2_000)).max(50) })).max(200),
  host: z.strictObject({ running: z.boolean(), problem: z.string().max(2_000).nullable() }),
  /** Why secrets cannot be kept here (no safe storage), or null. */
  secretsProblem: z.string().max(2_000).nullable(),
  /** Plugin commands on keys (default key, shortcuts.ts spelling), in the / menu and in the app's menus, from plugins that are on. */
  keybindings: z.array(z.strictObject({ command: PluginCommandId, key: z.string().max(40), plugin: PluginName, title: z.string().max(200) })).max(500).optional(),
  /** Without `command` the name goes into the message as words, for the bot (botling.design's /design). */
  slash: z.array(z.strictObject({ name: z.string().max(40), about: z.string().max(400), command: PluginCommandId.optional(), plugin: PluginName })).max(200).optional(),
  menus: z.array(z.strictObject({ menu: PluginMenu, command: PluginCommandId, plugin: PluginName, title: z.string().max(200), icon: z.string().max(40).optional(), quick: z.boolean().optional(), alt: z.string().max(200).optional(), hint: z.string().max(400).optional(), locales: z.record(z.string().max(20), z.strictObject({ title: z.string().max(400).optional(), alt: z.string().max(400).optional(), hint: z.string().max(400).optional() })).optional(), when: TabWhenView.optional() })).max(200).optional(),
  /** Plugin views that are tabs beside Chat / Storage (`where: "mainTab"`), for the main bot, project bots or any (plan W2). */
  // forRole "marked": only the bots in `bots` (the plugin's `ui.showTab`); chat "float": the bot's chat floats over the tab (as the Note tab's).
  mainTabs: z.array(z.strictObject({ plugin: PluginName, id: z.string().max(100), title: z.string().max(200), icon: z.string().max(40).optional(), forRole: z.enum(["main", "project", "bots", "any", "marked"]),
    chat: z.literal("float").optional(), bots: z.array(z.string().max(100)).max(500).optional() })).max(50).optional(),
  /** Plugin views that are pages of Settings (`where: "settings.section"`): `after` names the core page it follows, `link` the sidebar popover's link that opens it. */
  settingsSections: z.array(z.strictObject({ plugin: PluginName, id: z.string().max(100), title: z.string().max(200), terms: z.string().max(1_000), after: z.string().max(40).optional(), link: z.string().max(100).optional() })).max(20).optional(),
  /** Plugin views that are blocks in a bot's right panel overview, under its tasks (`where: "rightPanel.section"`), for the bots its `forRole` names. */
  rightPanelSections: z.array(z.strictObject({ plugin: PluginName, id: z.string().max(100), title: z.string().max(200), forRole: z.enum(["main", "project", "bots", "any"]) })).max(20).optional(),
  /** Panels under the chat (`bottomPanel` views): one frame per bot, a toggle in the chat header; `toggle`: the plugin's command the page runs itself to show or hide it. */
  bottomPanels: z.array(z.strictObject({ plugin: PluginName, id: z.string().max(100), title: z.string().max(200), toggle: PluginCommandId.optional() })).max(5).optional(),
  /** Plugin views that are buttons in the chat header, each opening a popover with its frame for the bot on screen (`where: "chatHeader"`). */
  chatHeaderViews: z.array(z.strictObject({ plugin: PluginName, id: z.string().max(100), title: z.string().max(200) })).max(5).optional(),
  /**
   * Plugin views at the right end of the row above the input box (`where: "composerBar"`), for the bots its `forRole` names: a one-line frame
   * `width` px wide whose click opens a card above it with the frame again (`ccb.context.surface` "compact" / "expanded"). The page shows the first one.
   */
  composerBarViews: z.array(z.strictObject({ plugin: PluginName, id: z.string().max(100), title: z.string().max(200), width: z.number().int().min(80).max(480), forRole: z.enum(["main", "project", "bots", "any"]) })).max(5).optional(),
  /** Pages that take the whole right panel's place for a bot while a plugin's program part has one open (`rightPanel.takeover` views, `ui.takeover`). */
  takeovers: z.array(z.strictObject({ plugin: PluginName, id: z.string().max(100), title: z.string().max(200) })).max(5).optional(),
  /** The takeover open now (null: none): which view, for which bot, and whether it is wide. */
  takeover: z.strictObject({ plugin: PluginName, view: z.string().max(100), botId: z.string().max(100), wide: z.boolean() }).nullable().optional(),
  /** Plugin views that are blocks in the sidebar gear's popover (`where: "quickSettings"`). */
  quickSettings: z.array(z.strictObject({ plugin: PluginName, id: z.string().max(100), title: z.string().max(200) })).max(10).optional(),
});
export type PluginsView = z.infer<typeof PluginsView>;

const PluginCodeHash = z.string().min(1).max(100).regex(/^[A-Za-z0-9:_.-]+$/);
const BASE_COMMANDS = [
  z.strictObject({ type: z.literal("project.files"), botId, query: z.string().max(200) }),
  z.strictObject({ type: z.literal("project.preview"), botId, path: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal("boot.commit") }),
  /** Every bot, and (with `botId`) that bot's chat. Main bot when `botId` is left out. */
  z.strictObject({ type: z.literal("chat.snapshot"), botId: botId.optional() }),
  /**
   * A page of older lines (the snapshot holds only the newest, `ChatSnapshot.history`): those before the line `before`,
   * about `bytes` of them (default 1 MiB). With `until`, the page reaches back far enough to hold that line.
   */
  z.strictObject({ type: z.literal("chat.history"), botId, before: id, bytes: z.number().int().min(1024).max(8 * 1024 * 1024).optional(), until: id.optional() }),
  /** Read only the output of a stored background task (never a renderer-supplied path). */
  z.strictObject({ type: z.literal("task.output"), botId, messageId: id, taskId: z.string().min(1).max(200) }),
  /** A message; while a reply is being written it joins or follows that turn (as 1.x steers). `replyTo`: a line it answers. */
  /**
   * Your words and the files waiting in the input box (either may be empty, not both). `files`: Botling 3 only (M2 step
   * 12, protocol v1 §9A.9): files a phone or browser page uploaded to the server by their hash (`content.put`); the
   * server holds the command until their bytes are in. The 2.x core refuses a `chat.send` that carries them.
   */
  z.strictObject({ type: z.literal("chat.send"), botId, text: z.string().max(MESSAGE_TEXT_LIMIT), replyTo: id.optional(), to: AnswerTarget.optional(), files: z.array(UploadedFile).min(1).max(50).optional() }),
  /** Main only: the + button's file picker (main's dialog); what you pick waits in the input box. */
  z.strictObject({ type: z.literal("files.pick"), botId }),
  /** Main only (from its dialog): files to wait in the input box. Never from a page: a page names no paths. */
  z.strictObject({ type: z.literal("files.add"), botId, paths: z.array(z.string().min(1).max(4_096)).min(1).max(50) }),
  /** A pasted or dropped file, read by the page (`addFileData`). */
  z.strictObject({ type: z.literal("files.data"), botId, name: z.string().min(1).max(255), base64: z.string().min(1).max(FILE_DATA_LIMIT) }),
  z.strictObject({ type: z.literal("files.remove"), botId, id }),
  /** Main only: a file the chat shows (an attachment of one of the bot's lines, or one waiting: `pending:<id>`). */
  z.strictObject({ type: z.literal("attachment.file"), botId, ref: z.string().min(1).max(5_000), line: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/).optional() }),
  /** One head or two (Claude, Codex). Leaving out the head it runs on runs it on the other, through a handoff (Phase 5c). */
  z.strictObject({ type: z.literal("heads.set"), botId, engines: z.array(Engine).min(1).max(3) }),
  /** Who new messages go to (the composer's Both / Claude / Codex). */
  z.strictObject({ type: z.literal("heads.answerWith"), botId, to: AnswerTarget }),
  /** Stops one hand-off's chain. */
  z.strictObject({ type: z.literal("handoff.stop"), botId, handoffId: id }),
  /** "Stop now" on the rounds line: no more hand-offs for the latest message. */
  z.strictObject({ type: z.literal("rounds.stop"), botId }),
  /** Picks a button on a question (a tool approval): the core decides what it means from its action. `text`: notes with the pick. */
  z.strictObject({ type: z.literal("chat.choose"), botId, messageId: id, index: z.number().int().nonnegative().max(19), text: z.string().max(MESSAGE_TEXT_LIMIT).optional() }),
  /** Answers a bot's question in the user's own words instead of a button. */
  /** `images`: pictures a component sent with its answer (`{text, images}`), as `{name, base64}`; they go along as attachments. */
  /** `picks`: a question group's answers, one per question in order; the app writes the bot's message from them (`text` is then ignored). */
  z.strictObject({ type: z.literal("chat.answer"), botId, messageId: id, text: z.string().max(MESSAGE_TEXT_LIMIT), images: z.array(z.strictObject({ name: z.string().min(1).max(255), base64: z.string().min(1).max(FILE_DATA_LIMIT) })).max(10).optional(),
    picks: z.array(z.strictObject({ options: z.array(z.number().int().nonnegative().max(5)).max(6), other: z.string().max(1_000).optional(), skipped: z.boolean().optional(),
      notes: z.record(z.string().regex(/^[0-5]$/), z.string().max(1_000)).optional() })).min(1).max(5).optional() }),
  /** Explicitly dismiss a question as a notification; never dispatches an answer. */
  z.strictObject({ type: z.literal("chat.ignoreQuestion"), botId, messageId: id }),
  /** The user's own reaction on a line (one of 👍 ❤️ 😂 🎉 🤔 👀). */
  z.strictObject({ type: z.literal("chat.react"), botId, messageId: id, emoji: z.string().min(1).max(16), present: z.boolean() }),
  /** A subagent's own conversation (the Agent call's id). */
  z.strictObject({ type: z.literal("subagent.view"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/) }),
  /** Settles a subagent's row out of the left column into the right panel's "Settled" (false: back). It keeps working. */
  z.strictObject({ type: z.literal("subagent.settle"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/), settled: z.boolean() }),
  /** "Move to…" (agentMoves): the bots an agent shown in `botId`'s rows can go to. */
  z.strictObject({ type: z.literal("agent.targets"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/) }),
  /** Moves an agent's ownership (it keeps running where it is), or hands a Claude subagent's work to a new sub bot. */
  z.strictObject({ type: z.literal("agent.move"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/), to: AgentMoveTo, notifyAgent: z.boolean().optional() }),
  /** The owner's follow-up for an agent shown in its rows (an app-managed worker of any engine): joined into its run, its next run, or sent after its run. */
  z.strictObject({ type: z.literal("agent.message"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/), text: z.string().min(1).max(64_000) }),
  /** The owner stops one agent shown in its rows (no report is made). */
  z.strictObject({ type: z.literal("agent.stop"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/) }),
  /** "New sub bot with these…": several agents shown in `botId`'s rows move to one new sub bot together (all or none). */
  z.strictObject({ type: z.literal("agent.group"), botId, subagentIds: z.array(z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/)).min(1).max(20), name: z.string().min(1).max(400), note: z.string().max(4_000).optional() }),
  /** Closes a sub bot: the agents it owns go back to their host (or are stopped when that is gone), then it is removed. */
  z.strictObject({ type: z.literal("subbot.close"), botId }),
  /** "New bot": a bot of its own with a name and a job; it sets up its own routines (`createBot`, setUp). */
  z.strictObject({ type: z.literal("bots.create"), name: z.string().min(1).max(400), job: z.string().min(1).max(4_000) }),
  /** Removes a bot of its own or a project from the left column and stops it. Its folders stay on disk. */
  z.strictObject({ type: z.literal("bots.remove"), botId }),
  /** The links handed over in a bot's chat, newest first (the right panel's Results). */
  z.strictObject({ type: z.literal("results.list"), botId }),
  /** Main only: opens one of a bot's results (a web link in the browser, a local page with its app). */
  /** Main only: the folder a worker runs in (its host bot's session folder), for the relative paths in its "Files changed". */
  z.strictObject({ type: z.literal("worker.cwd"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/) }),
  z.strictObject({ type: z.literal("worker.file"), botId, subagentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/), path: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal("result.open"), botId, url: z.string().min(1).max(4_000) }),
  /** The Storage tab (檔案庫): the bot's own files (its artifacts folder) and the files dragged in (references only). */
  z.strictObject({ type: z.literal("storage.list"), botId }),
  /**
   * Remembers files for a bot's Storage, by path (dropped from Finder) or by a link the chat handed over (a file: URL or
   * a chat attachment). Main checks each is a file and passes the paths on; nothing is copied.
   */
  z.strictObject({ type: z.literal("storage.add"), botId, paths: z.array(z.string().min(1).max(4_096)).max(50).default([]), urls: z.array(z.string().min(1).max(4_096)).max(50).default([]) }),
  /** Main only: its file picker, then `storage.add`. */
  z.strictObject({ type: z.literal("storage.pick"), botId }),
  /** Forgets a dragged-in file (`r:…`); the original is never touched. A bot's own file is not removed here. */
  z.strictObject({ type: z.literal("storage.remove"), botId, id: z.string().min(1).max(4_200) }),
  /** Main only: opens one of the list's files (a page or Markdown in the app's report preview, anything else with its app; `reveal`: in Finder). */
  z.strictObject({ type: z.literal("storage.open"), botId, id: z.string().min(1).max(4_200), reveal: z.boolean().optional() }),
  /** Main only: a row's drag began; main starts an OS file drag of that file, so a web page in the Browser pane gets it as an upload. */
  z.strictObject({ type: z.literal("storage.drag"), botId, id: z.string().min(1).max(4_200) }),
  /** A local file a line of this chat links or shows, dragged out of the chat: main starts an OS file drag of it. */
  z.strictObject({ type: z.literal("link.drag"), botId, url: z.string().min(1).max(4_000) }),
  z.strictObject({ type: z.literal("link.open"), /** Open a web page in the default browser, not the app's browser pane (⌘-click, the lightbox's button). */ external: z.boolean().optional(), cardImage: z.string().regex(/^[0-9a-f]{40}$/).optional(), preview: z.boolean().optional(), reveal: z.boolean().optional(), pinId:z.string().min(1).max(100).optional(), messageId:z.string().min(1).max(100).optional(), source: z.enum(["user", "component"]).default("component"), botId, url: z.string().min(1).max(4_000) }),
  /** Core-only membership lookup: no chat payload or component rendering. */
  z.strictObject({ type: z.literal("link.authorize"), cardImage: z.string().regex(/^[0-9a-f]{40}$/).optional(), source:z.enum(["user","component"]).optional(), pinId:z.string().min(1).max(100).optional(), messageId:z.string().min(1).max(100).optional(), botId, url: z.string().min(1).max(4_000) }),
  z.strictObject({ type: z.literal("chat.read"), botId }),
  /**
   * Main window only: the chat on screen now (null: none) and which of its views — its chat, the Storage tab, a plugin's
   * main tab (`tab`: "<plugin>/<view id>") or a subagent's run. Plugins read it with `workspace.current`.
   */
  z.strictObject({ type: z.literal("chat.shown"), botId: botId.nullable(), view: z.enum(["chat", "storage", "tab", "subagent"]), tab: z.string().min(1).max(400).nullable() }),
  z.strictObject({ type: z.literal("turn.stop"), botId, turnId: id }),
  /** Resolves when the turn ends. Cancelling the request stops the wait, never the turn. */
  z.strictObject({ type: z.literal("turn.await"), botId, turnId: id }),
  /** The bot's routines (routines.cron and scheduled-routines.json), and why they cannot be read, if so. */
  z.strictObject({ type: z.literal("routines.list"), botId }),
  /** Creates (once with `at`, recurring with `cron` in `timezone`), pauses, resumes or cancels one (`app_routines`' operations). */
  z.strictObject({
    type: z.literal("routines.change"), botId, operation: z.enum(["create", "pause", "resume", "cancel"]),
    id: z.string().min(1).max(2_200).optional(), kind: z.enum(["once", "recurring", "watch"]).optional(), task: z.string().min(1).max(2_000).optional(),
    at: z.string().max(64).optional(), cron: z.string().max(200).optional(), timezone: z.string().max(100).optional(), requestId: id.optional(),
    /** kind "watch": the shell command the app runs on the schedule (the bot is woken only when it fails). */
    command: z.string().min(1).max(2_000).optional(),
  }),
  /**
   * A component card's command: run (with the command and folder it showed), again (↻), or by its own timer (`live`).
   * It never allows anything: one not allowed yet answers `needsApproval`, and only the app page's ApprovalSheet sends `component.approve`.
   */
  z.strictObject({
    type: z.literal("component.command"), botId, messageId: id, index: z.number().int().nonnegative().max(19),
    command: z.string().max(20_000), folder: z.string().max(4_000), detail: z.string().max(20_000).optional(),
    force: z.boolean().optional(), live: z.boolean().optional(),
  }),
  /** "Allow and run" on the app page's ApprovalSheet (never from the chat page): the command, folder and Detail command the sheet showed. */
  z.strictObject({
    type: z.literal("component.approve"), botId, messageId: id, index: z.number().int().nonnegative().max(19),
    command: z.string().min(1).max(20_000), folder: z.string().min(1).max(4_000), detail: z.string().max(20_000).optional(),
  }),
  /** A component's `ccb.runDetail(values)`: its about.md's Detail command, only once allowed in `folder`. `card`+`command`: `{save: true}`. */
  z.strictObject({
    type: z.literal("component.detail"), botId, name: z.string().min(1).max(200), folder: z.string().max(4_000),
    values: z.record(z.string().max(64), z.union([z.string().max(1_000), z.number()])), card: z.string().max(200).optional(), command: z.string().max(20_000).optional(),
  }),
  /** A component's `ccb.save(data)` in a chat line: kept in that line. */
  z.strictObject({ type: z.literal("component.save"), botId, messageId: id, index: z.number().int().nonnegative().max(19), data: z.string().max(CARD_SAVE_LIMIT) }),
  /**
   * A component card's ⋯ menu (Phase 5a): "Report a problem…" (`problem`, 1.x's `reportComponentProblem`) or
   * a change asked of Maintainer, with pictures pasted on the box. Main takes the screenshot of `rect` (in
   * the app page's coordinates) and adds it as `screenshot` (base64 PNG) before the core gets it.
   */
  z.strictObject({ type: z.literal("component.report"), botId, name: z.string().min(1).max(200), text: z.string().max(20_000),
    images: z.array(z.strictObject({ name: z.string().min(1).max(255), base64: z.string().min(1).max(FILE_DATA_LIMIT) })).max(10),
    rect: z.strictObject({ x: z.number(), y: z.number(), width: z.number().positive().max(10_000), height: z.number().positive().max(10_000) }).nullable(),
    problem: z.boolean(), pinId: id.optional(), screenshot: z.string().max(FILE_DATA_LIMIT).optional() }),
  /** The models the local Codex offers (`model/list`, 1.x's `CodexModels`), for the Codex model menu. */
  z.strictObject({ type: z.literal("codex.models") }),
  z.strictObject({ type: z.literal("engine.models"), botId, engine: z.enum(["claude", "codex", "agy"]) }),
  /**
   * "Not right" on a reply, in developer mode (1.x's `reportFeedback`): your words and pictures go to the
   * developer project with the chat around it. Main adds the chat frame as you saw it (`rect`, app page coordinates).
   */
  z.strictObject({ type: z.literal("chat.feedback"), botId, messageId: id, text: z.string().max(20_000),
    images: z.array(z.strictObject({ name: z.string().min(1).max(255), base64: z.string().min(1).max(FILE_DATA_LIMIT) })).max(10),
    rect: z.strictObject({ x: z.number(), y: z.number(), width: z.number().positive().max(10_000), height: z.number().positive().max(10_000) }).nullable(),
    screenshot: z.string().max(FILE_DATA_LIMIT).optional() }),
  /** Puts back a component's version from before its last change (git; 1.x's `revert`). */
  z.strictObject({ type: z.literal("component.revert"), name: z.string().min(1).max(200) }),
  /** Main only: a component page for a sandboxed frame, served from botling-card://page/<token>. `panel`: a plugin panel (its web part loads as a module). */
  z.strictObject({ type: z.literal("card.page"), html: z.string().max(4_000_000), panel: z.boolean().optional() }),
  /** The plugin library: every plugin, what is broken, and the plugin host. */
  z.strictObject({ type: z.literal("plugins.list") }),
  /** Turns a plugin on or off (on again gives a broken one another try). */
  z.strictObject({ type: z.literal("plugins.enable"), name: PluginName, enabled: z.boolean() }),
  /** The public catalog's view (Explore, Updates); `refresh`: fetch index.json again first. */
  z.strictObject({ type: z.literal("plugins.store"), refresh: z.boolean().optional() }),
  /** Install or update one catalog plugin: downloaded, checked, then asked on the install card in the main bot's chat. */
  z.strictObject({ type: z.literal("plugins.storeInstall"), name: PluginName }),
  /** The page showed how an install ended: its note goes. */
  z.strictObject({ type: z.literal("plugins.storeDismiss"), name: PluginName }),
  /** Puts back the version an install or update replaced. */
  z.strictObject({ type: z.literal("plugins.revert"), name: PluginName }),
  /** Deletes a plugin installed from outside (its data folder stays). */
  z.strictObject({ type: z.literal("plugins.remove"), name: PluginName }),
  /** A plugin's setting (not a secret). */
  z.strictObject({ type: z.literal("plugins.setting"), name: PluginName, key: SettingKey, value: SettingValue }),
  /** A plugin's secret setting: sealed in the core, never sent back (null or "": taken out). */
  z.strictObject({ type: z.literal("plugins.secret"), name: PluginName, key: SettingKey, value: z.string().max(10_000).nullable() }),
  /**
   * Runs a command a plugin's program part registered. `from` says who asks when it is not the app page
   * itself: a plugin's frame (only its own plugin's commands; `name` is the plugin the page bound the frame
   * to) or the chat page (only commands of plugins whose web part runs there).
   */
  z.strictObject({ type: z.literal("plugins.command"), id: PluginCommandId, from: PluginCaller.optional(), name: PluginName.optional(), args: z.array(z.string().max(200)).max(4).optional() }),
  /**
   * A plugin's button beside a link in a chat message (menu "chat/link"): its command, run with that bot, message and link. The core
   * runs it only when the link is in that message and the entry's `when` matches it.
   */
  z.strictObject({ type: z.literal("plugins.linkCommand"), id: PluginCommandId, botId: BotId, messageId: z.string().min(1).max(200), url: z.string().min(1).max(8_000) }),
  /** A plugin's button in the browser pane's toolbar (menu "browser/tab"): its command, run with that bot's tab on screen. */
  z.strictObject({ type: z.literal("plugins.tabCommand"), id: PluginCommandId, botId: BotId, tabId: z.string().min(1).max(200), url: z.string().min(1).max(8_000) }),
  /** A plugin panel's web part (module text) and its settings, for its sandboxed frame. */
  z.strictObject({ type: z.literal("plugins.panel"), name: PluginName, panel: z.string().min(1).max(100) }),
  /**
   * A frame's or the chat page's `ccb.call(method, params)` to its own plugin's program part: only a
   * method that plugin exposed (`ui.expose`). For a frame the plugin is the one the page bound it to.
   */
  z.strictObject({ type: z.literal("plugins.call"), name: PluginName, method: z.string().min(1).max(200), params: z.unknown(), from: PluginCaller }),
  /**
   * Botling 3 only (N2): the result the owner kept for a slot of this front end whose result did not fit its
   * `cmd.applied` entry (the outcome carried a `resultKept` marker). A read, sent as a req on the local socket by the
   * window's main process, never by the renderer; the server answers it itself (session-core), the core never sees it.
   */
  z.strictObject({
    type: z.literal("slot.result"),
    slot: z.strictObject({ origin: z.string().min(1).max(200), originEpoch: z.string().regex(/^[0-9a-f]{32}$/), target: z.string().min(1).max(300), n: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }),
  }),
  /**
   * A plugin frame's `ccb.requestApproval` (plugin-extraction.md W4), from the app page that bound the frame to `name`:
   * what its ApprovalSheet shows for a bot's command in that bot's folder (null: allowed already). It allows nothing.
   */
  z.strictObject({ type: z.literal("plugins.approvalAsk"), name: PluginName, botId: PluginBotId, command: z.string().min(1).max(20_000), folder: z.string().min(1).max(4_000), card: z.string().min(1).max(200).optional(), component: z.string().min(1).max(200).optional(), detail: z.string().min(1).max(20_000).optional(), from: PluginCaller.optional() }),
  /** "Allow and run" on the app page's ApprovalSheet for a plugin frame's ask: the command and folder the sheet showed. No frame can send it. */
  z.strictObject({ type: z.literal("plugins.approve"), name: PluginName, botId: PluginBotId, command: z.string().min(1).max(20_000), folder: z.string().min(1).max(4_000), component: z.string().min(1).max(200).optional(), detail: z.string().max(20_000).nullable().optional() }),
  /**
   * A plugin frame's `ccb.snapshot` (the Note tab's "freeze to image"): `rect` is in the app page's coordinates, already kept
   * inside that frame by the page. Main takes the picture and adds it as `picture` before the core gets it; the core keeps it
   * in the bot's note-assets folder (the plugin needs "files").
   */
  z.strictObject({ type: z.literal("plugins.noteSnapshot"), name: PluginName, botId: PluginBotId,
    rect: z.strictObject({ x: z.number(), y: z.number(), width: z.number().positive().max(10_000), height: z.number().positive().max(10_000) }),
    picture: z.strictObject({ base64: z.string().min(1).max(FILE_DATA_LIMIT), name: z.string().min(1).max(40) }).optional() }),
  /**
   * A plugin frame's `ccb.openLink` (the Note tab's links): main asks the core what `href` names (`plugins.linkTarget`) and opens it
   * as a chat link: a web link in the default browser, a Markdown file in the app's report preview (`previewURL`, shown by the page),
   * any other file with its app (a page, picture, video, document) or in Finder. No prompt; never run.
   */
  z.strictObject({ type: z.literal("plugins.openLink"), name: PluginName, botId: PluginBotId, href: z.string().min(1).max(4_000) }),
  /** What `href` of a bot's note names for a plugin (core only, plugin-link.ts): asked by main for `plugins.openLink`. No page may send it. */
  z.strictObject({ type: z.literal("plugins.linkTarget"), name: PluginName, botId: PluginBotId, href: z.string().min(1).max(4_000) }),
  /** The pictures a plugin frame's tile data names, as card-page URLs: the app page puts them into the tile's page (`ccb.tile`). */
  z.strictObject({ type: z.literal("plugins.tileImages"), name: PluginName, botId: PluginBotId, data: z.string().max(300_000) }),
  /** The app's settings (settings.json), with every default filled in. */
  z.strictObject({ type: z.literal("settings.get") }),
  z.strictObject({ type: z.literal("agy.runtime.check") }),
  z.strictObject({ type: z.literal("agy.runtime.install") }),
  z.strictObject({ type: z.literal("settings.set"), change: SettingsChange }),
  /** Main: look at GitHub Releases (`manual`: now, even when the check is off or was done lately). */
  z.strictObject({ type: z.literal("updates.check"), manual: z.boolean() }),
  /** What the bots used today and before, and the subscriptions' limits (Settings → Usage).
   * localOnly skips quota refresh and includes normalized per-name token buckets for Token Flow. */
  z.strictObject({ type: z.literal("usage.view"), localOnly: z.boolean().optional() }),
  z.strictObject({ type: z.literal("doctor.view") }),
  z.strictObject({ type: z.literal("doctor.copy"), tool: z.enum(["claude", "codex"]) }),
  z.strictObject({ type: z.literal("doctor.run"), includeLatest: z.boolean() }),
  /** Main: open the newer release's page in the browser (only a release page of the app's own repository). */
  z.strictObject({ type: z.literal("updates.open") }),
  z.strictObject({ type: z.literal("updates.stage") }),
  z.strictObject({ type: z.literal("updates.restart") }),
  /** Main: reload this window's native chat page in place (new chat assets/preload; state comes back from the core). */
  z.strictObject({ type: z.literal("chat.reloadPage") }),
  /** A bot's own choices (bot.json). */
  z.strictObject({ type: z.literal("bot.settings"), botId }),
  /** The phone connection: its routes and paired phones; a one-time pairing link for the bots named; ending one phone's session. */
  z.strictObject({ type: z.literal("mobile.view") }),
  /** `botIds` omitted: the phone may use every bot, including bots added later. */
  z.strictObject({ type: z.literal("mobile.pair"), botIds: z.array(botId).min(1).max(50).optional(), route: z.number().int().min(0).max(5).optional(), relay: z.boolean().optional() }),
  z.strictObject({ type: z.literal("mobile.revoke"), deviceId: z.string().max(64) }),
  /** Turns the phone relay on (its wss:// address) or off (null). */
  z.strictObject({ type: z.literal("mobile.relay"), url: z.string().max(300).nullable() }),
  /** Botling 3 only: the first pairing's cluster (no code: make it at once and return its recovery code, shown once; a code: the older type-back, now only told the cluster exists). */
  z.strictObject({ type: z.literal("mobile.cluster"), code: z.string().max(64).optional() }),
  /** Botling 3 only: the person compared the phone's 6-digit code with the window's (accept adds the phone). An accept
   * names the code it was shown: a different phone that took the offer since (a new code) is not added. */
  z.strictObject({ type: z.literal("mobile.confirm"), offer: z.string().min(1).max(64), accept: z.boolean(), code: z.string().regex(/^[0-9]{6}$/).optional() }),
  /** Settings › Machines: the list; ~/.ssh/config's hosts; add an ssh host (its key is read, to approve next); a relay
   * install line (a one-time secret); approve (ssh: its key; relay: the code it shows); decline; revoke; remove; check. */
  z.strictObject({ type: z.literal("machines.view") }),
  z.strictObject({ type: z.literal("machines.hosts") }),
  z.strictObject({ type: z.literal("machines.add"), host: z.string().min(1).max(255), name: z.string().max(64).optional() }),
  z.strictObject({ type: z.literal("machines.pair") }),
  z.strictObject({ type: z.literal("machines.approve"), id: z.string().min(1).max(64), code: z.string().max(40).optional() }),
  z.strictObject({ type: z.literal("machines.decline"), id: z.string().min(1).max(64) }),
  z.strictObject({ type: z.literal("machines.revoke"), id: z.string().min(1).max(64) }),
  z.strictObject({ type: z.literal("machines.remove"), id: z.string().min(1).max(64) }),
  z.strictObject({ type: z.literal("machines.check"), id: z.string().min(1).max(64) }),
  /** "Restart bot": each head starts again in the same session before the bot's next message, told the app's current instructions (asleep: the next wake). */
  z.strictObject({ type: z.literal("bot.restart"), botId }),
  /** Changes a bot's model, effort, subagents' model or Codex model (null: the default); a running head keeps its own until it next wakes. */
  z.strictObject({
    type: z.literal("bot.configure"), botId, model: ModelId.nullable().optional(), effort: Effort.nullable().optional(),
    subagentModel: ModelId.nullable().optional(), subagentEffort: Effort.nullable().optional(), codexModel: ModelId.nullable().optional(), agyModel: ModelId.nullable().optional(),
    /** Its Antigravity workers' model and effort (null: the same as its Antigravity head). */
    agyWorkerModel: ModelId.nullable().optional(), agyWorkerEffort: Effort.nullable().optional(),
    /** Where its Claude workers run when app_handoff names no machine (a machine's name; null: here). */
    workerMachine: z.string().max(64).nullable().optional(),
    /** Its Codex workers' model, effort and Fast mode (null: ~/.codex/config.toml's); used from a Codex head's next wake. */
    codexWorkers: z.strictObject({ model: ModelId.nullable(), effort: Effort.nullable(), fast: z.boolean().nullable() }).nullable().optional(),
    /** The bot's own primary engine (null: follow the app's default). */
    primary: Engine.nullable().optional(),
    /** An engine's own effort (null: back to the old single effort, else the engine's default); only the keys given change. */
    efforts: z.strictObject({ claude: Effort.nullable().optional(), codex: Effort.nullable().optional(), agy: Effort.nullable().optional() }).optional(),
  }),
  /** Settings → Engines and models → "Apply to all bots": every bot's engines, models, effort and primary become the app's defaults. Needs `confirmed: true`, as the UI asks first. */
  z.strictObject({ type: z.literal("engineDefaults.applyAll"), confirmed: z.literal(true) }),
  /** Main only: "Add project…" (main's folder picker), then `projects.add`; the new bot is selected. */
  z.strictObject({ type: z.literal("projects.pick") }),
  /** Main only (from its picker): a folder becomes a project with a manager (one that is already a project: that one). */
  z.strictObject({ type: z.literal("projects.add"), folder: z.string().min(1).max(4_096) }),
  /** What waits on you across the bots (the main bot's right panel). */
  z.strictObject({ type: z.literal("waiting.list") }),
  /** Takes one off that list without answering it. */
  z.strictObject({ type: z.literal("waiting.ignore"), botId, text: z.string().min(1).max(400) }),
  /** Every enabled plugin's web part, for the chat page. */
  z.strictObject({ type: z.literal("plugins.web") }),
  /** The chat page loaded a plugin's web part (kept as the one to fall back to). */
  z.strictObject({ type: z.literal("plugins.loaded"), name: PluginName }),
  /** A plugin's web part threw in the chat page: off until its files change (1.x's `markFailed`). */
  z.strictObject({ type: z.literal("plugins.failed"), name: PluginName, message: z.string().max(4_000) }),
  /** A web part's `ccb.notify(text)`: a line in the main bot's chat. */
  z.strictObject({ type: z.literal("plugins.notice"), name: PluginName, text: z.string().min(1).max(4_000) }),
  /** Main only: one of a plugin's web files (a stylesheet it declares, or a font or picture beside one). */
  z.strictObject({ type: z.literal("plugins.file"), name: PluginName, path: z.string().min(1).max(1_000) }),
  /** Main only: the picture a component's data named, by its token. */
  z.strictObject({ type: z.literal("card.image"), token: z.string().regex(/^[0-9a-f]{40}$/) }),
] as const;
type BaseCommandType = (typeof BASE_COMMANDS)[number]["shape"]["type"]["value"];
const BASE_COMMAND_TYPES = BASE_COMMANDS.map((schema) => schema.shape.type.value) as [BaseCommandType, ...BaseCommandType[]];
/** Every contract command name; used to bound `plugin.grant.requests` (§11.7). */
export const CommandTypeEnum = z.enum([...BASE_COMMAND_TYPES, "plugin.grant"]);

/** A call-in's transcript slice is at most 64 KiB of UTF-8 (the host cuts the oldest lines first, M5-02c). */
const CALLIN_TRANSCRIPT_BYTES = 64 * 1024;
const CALLIN_REPLY_BYTES = 200 * 1024;
/** UTF-8 bytes of `text` as it travels in a frame (JSON-escaped, quotes not counted), so a valid call-in always fits FRAME_LIMIT. */
const wireBytes = (text: string): number => new TextEncoder().encode(JSON.stringify(text)).length - 2;
/**
 * Cross-server call-ins (Q-C1, D51, protocol v1 §15): slots whose origin is a server, never a device or the window
 * (`COMMAND_SCOPES` scope `server`). They sit outside `BASE_COMMANDS` so `plugin.grant.requests` cannot name them: a plugin is
 * never given a server-only command. No `picks` in 3.0 (the guest's cards stay in the guest's chat).
 */
const CALLIN_COMMANDS = [
  /** Host server A asks the guest's owner B to run `botId`'s turn: the host chat's transcript slice and what was asked. */
  z.strictObject({
    type: z.literal("callin.ask"),
    botId,
    callId: id,
    host: z.strictObject({ server: z.string().min(1).max(200), botId, name: z.string().min(1).max(200) }),
    transcript: z.string().max(CALLIN_TRANSCRIPT_BYTES).refine((text) => wireBytes(text) <= CALLIN_TRANSCRIPT_BYTES, "transcript is over 64 KiB"),
    asked: z.string().max(4_000),
    by: z.enum(["user", "bot"]),
    depth: z.number().int().min(1).max(2),
  }),
  /** The guest's owner B answers the host bot `botId` on server A: the reply, or why there is none (applied once by the slot). */
  z.strictObject({
    type: z.literal("callin.reply"),
    botId,
    callId: id,
    guest: z.strictObject({ botId, name: z.string().min(1).max(200) }),
    outcome: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("reply"), text: z.string().max(CALLIN_REPLY_BYTES).refine((text) => wireBytes(text) <= CALLIN_REPLY_BYTES, "reply text is over 200 KiB"), engine: Engine }),
      z.strictObject({ kind: z.literal("failed"), why: z.string().max(1_000) }),
      z.strictObject({ kind: z.literal("busy") }),
    ]),
  }),
  /** The host gave up (D51): B skips the call-in if it has not started, and stops the guest turn if it has. */
  z.strictObject({ type: z.literal("callin.cancel"), botId, callId: id }),
] as const;

export const Command = z.discriminatedUnion("type", [
  ...BASE_COMMANDS,
  /** Raises, lowers, or revokes (`tier: "none"`) one plugin grant at one code hash on the target server (D54, §11.7). */
  z.strictObject({
    type: z.literal("plugin.grant"),
    plugin: PluginName,
    codeHash: PluginCodeHash,
    tier: z.enum(["none", "read", "request", "write"]),
    reads: z.array(z.string().min(1).max(200)).max(50),
    requests: z.array(CommandTypeEnum).max(100),
  }),
  ...CALLIN_COMMANDS,
]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command["type"];


// ---------------------------------------------------------------------------------------------
// Events (core → main → renderer). Every chat event names its bot.

export const Event = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("bot.updated"), bot: BotView }),
  z.strictObject({ type: z.literal("message.added"), botId, message: MessageView }),
  /** A message changed as a whole (a question answered, a reply finished with its steps). */
  z.strictObject({ type: z.literal("message.updated"), botId, message: MessageView }),
  /** A line went (a reply with nothing to show: only <no-reply/> or reactions; a cut-off turn that had said nothing). */
  z.strictObject({ type: z.literal("message.removed"), botId, messageId: id }),
  z.strictObject({ type: z.literal("subagent.updated"), botId, subagent: SubagentView }),
  // Identity is available before the reply record exists; optional for older event producers.
  z.strictObject({ type: z.literal("turn.started"), botId, turnId: id, messageId: id, head: Engine.optional() }),
  z.strictObject({ type: z.literal("turn.delta"), botId, turnId: id, messageId: id, text: z.string() }),
  /** What the turn is doing now: its steps so far. */
  z.strictObject({ type: z.literal("turn.steps"), botId, turnId: id, messageId: id, steps: z.array(StepView).max(500) }),
  z.strictObject({
    type: z.literal("turn.finished"), botId, turnId: id, messageId: id,
    status: z.enum(["done", "stopped", "failed"]), text: z.string(), error: z.string().optional(),
  }),
  /** A bot with two heads: who new messages go to, the rounds line and the hand-offs changed (null: one head now). */
  z.strictObject({ type: z.literal("heads.updated"), botId, heads: HeadsView.nullable() }),
  /** What a plugin keeps for a chat's page to draw from changed (`chat.setData`). */
  z.strictObject({ type: z.literal("chat.pluginData"), botId, plugin: PluginName, data: z.unknown() }),
  /** The component library changed on disk: every component as the page draws it. */
  z.strictObject({ type: z.literal("components.updated"), components: z.record(z.string().max(200), ComponentInfoView) }),
  /** What plugins draw among a chat's messages changed (`chat.decorate`). */
  z.strictObject({ type: z.literal("chat.decorations"), botId, decorations: z.array(ChatDecoration).max(1_000) }),
  /** The plugin library changed (a plugin added, edited, turned off, broken; the host started or stopped). */
  z.strictObject({ type: z.literal("plugins.updated"), plugins: PluginsView }),
  z.strictObject({ type: z.literal("plugins.store"), store: PluginStoreView }),
  /** A plugin's program part pushed something to its frames (`ui.emit`), those of the bot `forBot` only when it names one. Not part of any snapshot. */
  z.strictObject({ type: z.literal("plugins.emit"), plugin: PluginName, name: z.string().min(1).max(100), forBot: z.string().max(128).optional(), data: z.unknown() }),
  /** A plugin's program part opened one of its panels (`ui.openView`). */
  z.strictObject({ type: z.literal("plugins.open"), plugin: PluginName, panel: z.string().max(100), title: z.string().max(200) }),
  /** A plugin's `ui.showTab(…, { open: true })`: the main window shows that bot with that `mainTab` view. */
  z.strictObject({ type: z.literal("plugins.openTab"), plugin: PluginName, view: z.string().max(100), botId: BotId }),
  /** The app's settings changed. */
  z.strictObject({ type: z.literal("settings.updated"), settings: SettingsView }),
  z.strictObject({ type: z.literal("doctor.updated"), doctor: DoctorView }),
  /** What waits on you across the bots (or a manager's "In progress") changed. */
  z.strictObject({ type: z.literal("waiting.updated"), waiting: WaitingView }),
  /** The files waiting in a bot's input box changed. */
  z.strictObject({ type: z.literal("files.updated"), botId, files: z.array(PendingFileView).max(50) }),
  /** Its routines changed (one ran, the bot or the app edited them). */
  z.strictObject({ type: z.literal("routines.updated"), botId, routines: z.array(RoutineView).max(200), error: z.string().max(2_000).nullable() }),
  /** A bot of its own or a project was taken out of the left column. */
  z.strictObject({ type: z.literal("bot.removed"), botId }),
  /** The core is being replaced by a newer build : draining, updating; null: called off. */
  z.strictObject({ type: z.literal("core.swap"), phase: z.enum(["draining", "updating"]).nullable() }),
]);
export type Event = z.infer<typeof Event>;

// ---------------------------------------------------------------------------------------------
// Envelopes


const v = z.literal(PROTOCOL_VERSION);
export const RequestEnvelope = z.strictObject({ v, id: RequestId, cmd: Command });
export const CancelEnvelope = z.strictObject({ v, cancel: RequestId });
export const ResponseEnvelope = z.union([
  z.strictObject({ v, id: RequestId, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ v, id: RequestId, ok: z.literal(false), error: WireError }),
]);
export const EventEnvelope = z.strictObject({ v, epoch: z.string().min(1).max(64), seq: z.number().int().nonnegative(), event: Event });
/** What may go towards the core (or main): a request or a cancel. */
export const Inbound = z.union([RequestEnvelope, CancelEnvelope]);
/** What comes back: a response or an event. */
export const Outbound = z.union([ResponseEnvelope, EventEnvelope]);

export type RequestEnvelope = z.infer<typeof RequestEnvelope>;
export type CancelEnvelope = z.infer<typeof CancelEnvelope>;
export type ResponseEnvelope = z.infer<typeof ResponseEnvelope>;
export type EventEnvelope = z.infer<typeof EventEnvelope>;
export type Inbound = z.infer<typeof Inbound>;
export type Outbound = z.infer<typeof Outbound>;


/** Validates something that should be a request or cancel; unsupported versions get their own code. */
export function parseInbound(value: unknown): { ok: true; value: Inbound } | { ok: false; id: string | null; error: WireError } {
  const result = Inbound.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  const raw = value as { v?: unknown; id?: unknown } | null;
  const requestId = typeof raw?.id === "string" && RequestId.safeParse(raw.id).success ? raw.id : null;
  if (raw && typeof raw === "object" && raw.v !== PROTOCOL_VERSION) {
    return { ok: false, id: requestId, error: { code: "unsupported_version", message: `Protocol version ${String(raw.v)} is not ${PROTOCOL_VERSION}.` } };
  }
  return { ok: false, id: requestId, error: { code: "bad_request", message: describeIssues(result.error) } };
}

export function errorResponse(id: string, error: WireError): ResponseEnvelope {
  return { v: PROTOCOL_VERSION, id, ok: false, error };
}
export function okResponse(id: string, result: unknown): ResponseEnvelope {
  return { v: PROTOCOL_VERSION, id, ok: true, result };
}
