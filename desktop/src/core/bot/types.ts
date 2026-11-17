// The types and constants of one bot in the core (moved out of bot.ts, M7-S15): what a session starts with, the options a Bot takes, the turn under way, approvals and denials.
import type { FetchRequest } from "../bot-tools";
import type { AgyAcpHead } from "../agent/agy-acp";
import type { AgyConfig } from "../agent/agy";
import type { AgentPort } from "../agent-registry";
import type { SubagentRowView, Event } from "../../contract";
import type { ClaudeHead, HeadConfig } from "../agent/head";
import type { CodexHead, CodexHeadConfig } from "../agent/codex";
import type { Engine, Heads } from "../heads";
import type { ReplyText } from "../agent/stream";
import type { ProcessLedger } from "../process/ledger";
import type { BotPrompts } from "../prompts";
import type { BotRequest, PluginTag } from "../reply";
import type { ComponentsContext } from "../components/service";
import type { CallInRelay } from "../call-in-work";
import type { RateLimits, TokenUsage } from "../usage";
import type { BotStore } from "../store/bot-store";
import type { BackgroundTask } from "../background-tasks";
import type { ChatRecord, StepRecord } from "../store/records";
import type { BotProfile } from "../store/workspace";
import type { RemoteWorkerHost } from "../agent/claude-workers";
import type { Bot, Status } from "../bot";
import type { WorkerCoreOptions } from "../worker-core/core";

export interface SessionStart {
  sessionId: string;
  resume: boolean;
  /** Appended to claude's system prompt (Prompts.swift's, ported in prompts.ts). */
  systemPrompt: string;
  /** Plugins' Claude parts (`--plugin-dir`), and the environment their MCP servers need. */
  pluginDirs?: string[];
  pluginEnv?: Record<string, string>;
  /** The plugins' MCP tools, used without asking (`pluginTools`). */
  pluginTools?: string[];
  /** The plugins' skill folders, for Codex (`skills/extraRoots/set`) and Antigravity (`skills.json`); Claude has them in pluginDirs. */
  skillRoots?: string[];
  /** The bot's model and effort (bot.json; null: the default), its subagents' model, their 1-hour cache. */
  model?: string | null;
  effort?: string | null;
  subagentModel?: string | null;
  subagentHourCache?: boolean;
  /** More folders it may use (`--add-dir`). */
  addDirs?: string[];
  /** Auto mode: Claude Code's (`--permission-mode auto`) or Codex's reviewer (`auto_review`); Claude only: rules for blocked calls the user allowed (`--settings`). */
  autoMode?: boolean;
  claudeBypassPermissions?: boolean;
  codexBypassPermissions?: boolean;
  allowRules?: string[];
  /** Codex workers' model, effort and Fast mode when the app sets them (null: ~/.codex/config.toml's). */
  codexWorkers?: { model: string | null; effort: string | null; fast: boolean | null } | null;
  /** Model families whose app-managed workers may write spec/ (settings.json `specWriters`; spec-guard.ts). */
  specWriters?: readonly string[];
}

export interface SessionStartCodex extends SessionStart {
  /** What app-managed workers are told. */
  workerInstructions: string;
  codexModel: string | null;
  /** The bot's scheduled-routines.json, for `app_routines`. */
  routinesFile: string | null;
}

export interface BotOptions {
  profile: BotProfile;
  /** Startup timing only (core/phase-marks.ts): while the core makes its bots, the time of each construction step is added here; unset: nothing is measured. */
  buildTally?: import("../phase-marks").PhaseTally;
  /** Botling 3's server only (2.x leaves it unset): `app_fetch`, a file or folder from another machine; answers with the text the tool returns (M5-07d). */
  fetch?: (botId: string, request: FetchRequest) => Promise<string>;
  /** How to run this bot's claude head for a session. */
  headConfig: (profile: BotProfile, session: SessionStart) => HeadConfig;
  /** Antigravity native protocol; no Claude permission or plugin configuration is forwarded. */
  agyConfig?: ((profile: BotProfile, config: AgyConfig) => AgyConfig) | null;
  /** How to run its Codex head (null: Codex is not available here). */
  codexConfig?: ((profile: BotProfile, session: SessionStartCodex) => CodexHeadConfig) | null;
  /** The instructions for this bot's head (settings may change between wakes). */
  prompts: (engine: Engine, heads: Heads | null) => BotPrompts;
  orchestrationRules?: () => import("../orchestration/default-rules").OrchestrationRules;
  /** M7-O05: the app_handoff hook, with the plugin the turn under way stems from (undefined: the user's, a shipped plugin's, or the bot's own). */
  workerAdmit?(...args: [...Parameters<NonNullable<WorkerCoreOptions["admit"]>>, plugin: string | undefined]): ReturnType<NonNullable<WorkerCoreOptions["admit"]>>;
  /** M7-O05 (item 5): the app_send_message hook, with the plugin the turn under way stems from. */
  workerGate?(taskId: string, words: string, plugin: string | undefined): Promise<{ run: number; how: string } | undefined>;
  /** A partner's: the bot whose chat it speaks in (set only on the other head of a two-head bot). */
  primary?: Bot;
  /** The head a partner runs. */
  engine?: Engine;
  /** How long the other head waits for the lead's first words before it gets a message to both anyway (1.x: 20 s). */
  claimWaitMs?: number;
  /** How long a turn set aside (deferred) and back as the turn under way may wait for claude to begin it (default 90 s). */
  deferredStartMs?: number;
  ledger: ProcessLedger;
  emit: (event: Event) => void;
  log: (line: string) => void;
  /** No answer in this time counts as "Don't allow" (1.x: 10 minutes). */
  approvalTimeoutMs: number;
  /** An idle head tidies and goes to sleep after this long. */
  idleMs: number;
  /** How long Stop waits for claude to end the turn before ending its process tree. */
  interruptGraceMs: number;
  /** The most a tidy turn may take before the head is put to sleep anyway. */
  tidyTimeoutMs?: number;
  /** On quit, how long an awake bot may tidy (0: not at all; unset or Infinity: as long as it takes, as in 1.x). */
  quitTidyMs?: number;
  /** Candidate startup must not modify external project notes until its update commits. */
  deferStartup?: boolean;
  /** The main bot's routines get the project list (`Workspace.projectBriefing`). */
  projectBriefing?: () => string;
  /** The component library, command runs and pictures every bot shares (null: none). */
  components?: ComponentsContext | null;
  /** The requests in a reply (<component>, <plugin>, <install>, …) the app acts on; the rest come back (a notice says 2.0 cannot do them yet). */
  onRequests?: (bot: Bot, requests: BotRequest[]) => BotRequest[];
  /** What a turn spent (dollars, Claude's; Codex: 0) and used (tokens), by the bot's name (1.x's `onSpend`, `onTokens`). */
  usage?: (bot: string, spent: number, tokens: TokenUsage) => void;
  /** A subscription's limits as a head reported them (`onRateLimits`, `onCodexRateLimits`). */
  rateLimits?: (engine: "claude" | "codex", limits: RateLimits) => void;
  /** Plugins' afterReply hooks, when any plugin has one: may change a reply after it shows (null: none). */
  replyFilter?: () => ((text: string) => Promise<string>) | null;
  /** A reply showed (plugins' `bots.onReply`; Maintainer's requests settle). */
  replied?: (bot: Bot, record: ChatRecord) => void;
  /** A reply's tags that plugins declared (`replyTags`), for the plugins to hear (the bot is the one whose reply it was). */
  pluginTags?: (bot: Bot, tags: PluginTag[]) => void;
  /** Plugins' Claude parts (`--plugin-dir`) and the secrets their MCP servers read, for a new claude head. */
  plugins?: () => { dirs: string[]; env: Record<string, string>; tools?: string[]; skillRoots?: string[] };
  /** What the plugins' Claude parts are now (`PluginRegistry.claudeStamp`, 1.x's `pluginStamp`). */
  pluginStamp?: () => string[];
  /** Rows for the sub bots under this bot (the core builds them from the bots whose `parent` is this one). */
  subBotRows?: () => SubagentRowView[];
  /** Said at each wake after the wake line (the main bot's project list: `wakeNote`). */
  wakeNote?: () => string;
  /** Folders a new claude head may also read and write (`--add-dir`: the main bot's every `.bot/`). */
  addDirs?: () => string[];
  /** The browser's site tools folder, which only Maintainer writes: this bot's Claude head and workers are refused writes there (site-tools-guard.ts). */
  siteToolsFolder?: string;
  /** Workers on other machines (app_handoff's `machine`); absent or null: refused. */
  remoteWorkers?: () => RemoteWorkerHost | null;
  /** App-managed worktree (a plugin's `sessions.folder`, plugins/session-folders.ts): where its session starts instead of the project folder, and what else it may use there. */
  worktree?: () => { cwd: string; addDirs: string[] } | null;
  /** Another bot answering in its chat right now (a call-in's speaker). */
  guest?: () => string | null;
  /** The call-ins in its chat not answered yet, answering or waiting their turn. */
  callIns?: () => { id: string; state: "queued" | "answering" }[];
  /** The chat it is answering a call-in in now (null: none). */
  answeringIn?: () => string | null;
  /** Its reply on the news of a worker it started when called into `caller`'s chat with `asked` (`by`: "user" for the user's @, else a bot's): told back there (`callInFollowUp`). */
  callInFollowUp?: (caller: string, asked: string, record: ChatRecord, by?: "user") => void;
  /** Its turn on such a worker's report ended without a reply (`why`): that chat is told so (`callInFollowUpMissed`). */
  callInFollowUpMissed?: (caller: string, asked: string, why: string, by?: "user") => void;
  /** A worker at work sent it a note (app_notify_owner; `id`: the worker's task id): plugins listening hear it (`workerNote`). */
  workerNoted?: (note: { id?: string; kind: "report" | "question"; message: string }) => void;
  /** Its @s still being answered or waiting, said with its next turn (status only; null: none). */
  callInNote?: () => string | null;
  /** What a line shows besides itself for the component studio, through its seam (the plugins' `studioLineExtras`): the component it already is (Phase 5a). */
  lineExtras?: (bot: Bot, record: ChatRecord) => { component?: string };
  /** What settings.json says for new heads (the subagents' hour cache; the rest is each bot's own). */
  launch?: () => { subagentHourCache: boolean; defaultPrimaryEngine?: Engine | null; autoMode?: boolean; claudeBypassPermissions?: boolean; codexBypassPermissions?: boolean; agyBypassPermissions?: boolean; claudeWorkers?: "app" | "native"; claudeWorkerLimit?: number; specWriters?: readonly string[]; workerExtraDirs?: readonly string[]; inlineBlockGuidance?: unknown };
  /** The app-wide agent registry (agents.json): agents it hosts for another owner, and agents it owns that run elsewhere. */
  agents?: AgentPort;
  /**
   * Botling 3's server only (2.x leaves it unset): asked before a turn is routed to a head. True keeps the turn
   * aside (not routed); the server records it in its effect outbox and routes it later with `release()`.
   */
  deferTurn?: (turn: DeferredTurn) => boolean;
  /** Botling 3's server only (2.x leaves it unset: the files, `FileBotStore`): the store of the bot kept in `directory`. */
  botStore?: (directory: string) => BotStore;
}

/** The ids a Botling 3 server chose for a turn before the core makes it (its intent was committed first). */
export interface PresetTurnIds {
  turnId: string;
  /** The reply's chat line. */
  messageId: string;
  /** The user's line (chat.send). */
  userId?: string;
}

/** A turn the server may keep aside (`BotOptions.deferTurn`). */
export interface DeferredTurn {
  botId: string;
  turnId: string;
  messageId: string;
  userId: string | null;
  origin: "user" | "app" | "background" | "tidy";
  words: string;
  /** The head it goes to. */
  engine: Engine;
  /** A routine's run (its time came, or its watch failed). */
  routine: boolean;
  /** Settles once this turn ended, however it ended (a turn another turn read in settles when that one ends, or never). */
  done: Promise<Status>;
  /** Routes it now; resolves with the turn that took it (another turn under way may read it in) and how it ended. */
  release(): { turnId: string; done: Promise<Status> };
}

export type Origin = "user" | "app" | "background" | "tidy";
export type AgentHead = ClaudeHead | CodexHead | AgyAcpHead;

export interface Turn {
  id: string;
  /** The reply's chat line id. */
  messageId: string;
  /** The user's line this turn answers (null for the app's own and claude's own turns). */
  userId: string | null;
  origin: Origin;
  /** What goes to claude before the briefing and reactions are added (the user's lines, or the app's note). */
  words: string;
  reply: ReplyText;
  steps: StepRecord[];
  /** The reply's chat line, once it has something to show. */
  record: ChatRecord | null;
  /** The gate: false once the turn ended or was stopped; nothing reaches anyone after. */
  open: boolean;
  /** Delivered to a head (false while it waits its turn). */
  sent: boolean;
  head: AgentHead | null;
  /** Sent again once already (its resume failed). */
  retried: boolean;
  /** Swift date it was sent. */
  started: number;
  /** Subagents that ended while it ran (a silent turn has to report them). */
  ended: string[];
  /** Background work it started (1.x's `trace.takeTasks()`), kept in its reply. */
  tasks?: BackgroundTask[];
  /** It ended on an API error with no answer from the API (1.x's `turnLostConnection`). */
  lostConnection?: boolean;
  /** claude was sent a line of yours into this turn with priority "now": it may cut the turn off for it (`error_during_execution`). */
  steeredNow?: boolean;
  /** Work the other head handed over (its reply goes back), and the hand-off it is. */
  conducted: boolean;
  handoffId: string | null;
  /** The other head's lines it passes on: seen by this head once sent. */
  about: string[];
  /** Explicit question views delivered with this turn's peer context (`turnPeerMessages`). */
  peer: Set<string>;
  /** How much of the reply's text the other head has heard already (`headWords`). */
  told: number;
  done: Promise<Status>;
  resolve: (status: Status) => void;
  /** For the tidy turn: its reply. */
  onReply?: (text: string) => void;
  /** Its turn in another chat (a group, or a chat it was called into): hidden here like the tidy, but it may ask for tools. */
  guest?: boolean;
  /** Called into this chat (its id) with @: hidden here, but its own chat and row show it at work. */
  callIn?: string;
  /** Told once whether it reached the head (true: it began, or was read into the turn under way) or never will (false:
   * taken back or dropped while it waited): `send`'s `onDelivery`. */
  delivery?: (delivered: boolean) => void;
  /** For a call-in: what it was asked there (a worker it starts reports back with it, `callInWork`). */
  callInAsked?: string;
  /** For a call-in: "user" when the user's @ called it in (not a bot's). */
  callInBy?: "user";
  /** Its turn on the report or note of a worker it started in a call-in: its reply goes back to that chat too. */
  relayTo?: CallInRelay;
  /** A routine's run (Botling 3's server records it in its effect outbox before it starts). */
  routine?: boolean;
  /** Already past `deferTurn` (released by the server, or never deferred). */
  released?: boolean;
  /**
   * M7-O05 (F6): the plugin (not shipped) this turn stems from: the sender of its message, or for a worker's report the plugin that stands behind the
   * worker. Fixed when the turn is made and never changed (the user writing later does not clear it); every worker the turn starts is checked as that plugin's.
   */
  plugin?: string;
}

/** What a bot said for its turn in another chat (1.x's `GroupAnswer`). */
export type GuestAnswer = { kind: "busy" } | { kind: "failed"; why: string } | { kind: "reply"; text: string; steps: StepRecord[]; engine: string };

export interface Approval {
  /** Monitors and managed workers outlive the coordinator turn; their owner closes their cards. */
  lasting: boolean;
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
  head: AgentHead;
  timer: NodeJS.Timeout;
  expires: number;
}

/** A call auto mode blocked, waiting on its card (`Bot.Denial`). */
export interface Denial {
  tool: string;
  summary: string;
  /** What lets that call through: "Bash(rm -rf build)". */
  rule: string;
  /** One of its subagents made the call: which one, in the bot's words. */
  subagent: string | null;
  /** The user allowed it before and claude blocked it anyway: allowing again cannot help. */
  allowedBefore: boolean;
}

/** How many recent tool calls are kept (`recentToolCalls`). */
export const RECENT_TOOL_CALLS = 500;

export const NO_LONGER_NEEDED = "No longer needed";
export const NO_ANSWER = "No answer in time";
/** Tools whose "always" would be far broader than it sounds; they are asked every time (`Bot.neverAlways`). */
export const NEVER_ALWAYS = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Monitored command", "Permissions"]);
/** 1.x's `RestartReason.plugins`. */
export const PLUGINS_RESTART = { told: "loading new plugins", shown: "loading new plugins" };
export const PROMPT_SESSION_DIVIDER = "New session (instructions updated)";
export const NEW_SESSION_DIVIDER = "Couldn't go on in the same session → new session";

/**
 * A component spec as specs.json keeps it. It is the component studio's (botling.component-studio) record: the core keeps the list a chat
 * has, and knows only each record's id and the line it is made from.
 */
export interface StoredSpec { id: string; messageID?: string; [field: string]: unknown }
export const readStoredSpec = (value: unknown): StoredSpec | null =>
  value && typeof value === "object" && !Array.isArray(value) && typeof (value as StoredSpec).id === "string" ? (value as StoredSpec) : null;
