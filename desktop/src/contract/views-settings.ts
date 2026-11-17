import { z } from "zod";
import { isClaudeModel } from "./claude-model";
import { ContractId } from "./editor-card";
import { AnswerTarget, BotId, DelegationRowView, Engine, StepView, SubagentRowView } from "./views";

const id = ContractId;
const botId = BotId;

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


export const PluginName = z.string().min(1).max(214).regex(/^[a-z0-9][a-z0-9._-]*$/);

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
// ---------------------------------------------------------------------------------------------
// Settings (settings.json, 1.x's AppSettings keys; per-bot choices in bot.json)

/** A Claude model: an alias (haiku, sonnet, opus) or any full `claude-*` id (src/contract/claude-model.ts). */
const BotModel = z.string().refine(isClaudeModel, { message: "not a Claude model (haiku, sonnet, opus or claude-…)" });
export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const ModelId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:\/\[\]-]+$/);
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
