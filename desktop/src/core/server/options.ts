// The types and constants at the head of server.ts, moved out of it (M7-S70b; no code changed): what the core is started with
// (`CoreOptions`), what it asks of main (`AppOp`, `AppAnswer`), the peer id and message limits, and the shapes `Core`'s methods
// answer with. server.ts imports and re-exports every name, so no importer changes.
import type { ModelDiscovery, ModelEngine } from "../../contract/model-discovery";
import type { AgyConfig } from "../agent/agy";
import type { CodexModel } from "../agent/codex-models";
import type { CodexThreads, CodexHeadConfig } from "../agent/codex";
import type { HeadConfig } from "../agent/head";
import type { Command, Outbound, PluginView } from "../../contract";
import type { DeferredTurn, SessionStart, SessionStartCodex } from "../bot";
import type { FetchRequest } from "../bot-tools";
import type { BotStore } from "../store/bot-store";
import type { Doctor } from "../doctor";
import type { BotProfile } from "../store/workspace";
import type { ConversationsDeps, RemoteMember } from "../conversations";
import type { GROUP_TIMING } from "../groups";
import type { EngineCli, PluginWorld } from "../plugins";
import type { HostCommand, HostTiming } from "../plugins/host-client";
import type { Sealer } from "../plugins/secrets";

/** What the core asks of main (self-update.ts, plugins/app-seam.ts). */
export type AppOp = "screenshot" | "quit" | "installRelease" | "browser";
export interface AppAnswer { ok: boolean; file?: string; error?: string; plan?: unknown; data?: unknown }

/** An id from a peer's rows that is safe as a path part and as a stream key (M5-04c F2). */
export const PEER_ID = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * The most a peer message may take on the wire, counted as the JSON-escaped UTF-8 bytes of its text (M5-04d, checklist 6): a
 * frame is at most 256 KiB (`protocol/frame.ts` FRAME_LIMIT, which a test keeps this under) and the slot, scope and counters
 * around the text need under 2 KiB; 16 KiB is left. Characters alone are not enough: 100,000 CJK characters are about 300 KB.
 */
export const PEER_MESSAGE_BYTES = 240 * 1024;

/** Text from a peer or a model as one clean line for a note, a log or a report: control characters gone, runs of spaces one, at most 300 characters, no closing full stop (the note adds its own). */
export function oneLine(text: string): string {
  const line = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim().replace(/\.$/, "");
  const characters = [...line];
  return characters.length > 300 ? `${characters.slice(0, 299).join("")}…` : line || "no reason given";
}

export interface CoreOptions {
  /** Workers on other machines (src/remote/service.ts): app_handoff's `machine`; absent: refused. */
  remoteWorkers?: import("../../remote/service").RemoteWorkers | null;
  quotaRetriever?: import("../quota").QuotaRetriever;
  /** Read-only CLI self-check; production starts it offline after activation. */
  doctor?: Doctor;
  /** The public plugin catalog: production checks its index once a day after activation (`autoRefresh`); tests give a fake fetch or none. */
  pluginCatalog?: { autoRefresh?: boolean; fetcher?: import("../plugins/catalog").Fetch };
  dataDir: string;
  /** Update candidate: startup writes are snapshotted; external work waits for commit. */
  deferStartup?: boolean;
  /** How long a bot answering in another chat waits for a busy one and may take (tests shorten it; 1.x's `groupTiming`). */
  groupTiming?: typeof GROUP_TIMING;
  /** How to run a bot's head for a session. */
  headConfig: (profile: BotProfile, session: SessionStart) => HeadConfig;
  /** How to run a Codex head (threads: <data>/codex-threads); null when Codex is not available. */
  agyConfig?: ((profile: BotProfile, config: AgyConfig) => AgyConfig) | null;
  codexConfig?: ((profile: BotProfile, session: SessionStartCodex, threads: CodexThreads) => CodexHeadConfig) | null;
  /** How long the second head waits for the lead's first words (1.x: 20 s). */
  claimWaitMs?: number;
  emit: (message: Outbound) => void;
  log?: (line: string) => void;
  /** Startup timing lines (`timing: …`, core/phase-marks.ts); unset: none are written. */
  phaseLog?: (line: string) => void;
  /** A Botling 1.x data folder to import from on the first start (read-only). */
  importFrom?: string | null;
  approvalTimeoutMs?: number;
  idleMs?: number;
  interruptGraceMs?: number;
  tidyTimeoutMs?: number;
  /** How long an awake bot may tidy when the app quits (0: not at all). */
  quitTidyMs?: number;
  /** The system's preferred languages, best first (for bots' reply language when settings name none). */
  languages?: string[];
  /** How often routines are checked (ROUTINE_TICK_MS, 15 s; 1.x: 30 s); 0: never (tests drive `checkRoutines`). */
  routineTickMs?: number;
  /** How often quiet runs (and, in 1.x, the network) are looked at (1.x: 20 s; 0: never). */
  watchMs?: number;
  /** How long one of Settings' reminder minutes is (tests shorten it; 60 s). */
  stallMinuteMs?: number;
  /** Whether Claude's API answers again (1.x's `networkProbe`; tests replace it). */
  networkProbe?: () => Promise<boolean>;
  /** How an engine's CLI is started here, for a plugin's one-shot model call (`engines.cli`); null: none. */
  engineCli?: (engine: "claude" | "codex") => EngineCli | null;
  /** The models the local Codex offers (`model/list`); null: none known. */
  engineModels?: (engine: ModelEngine, profile: BotProfile) => Promise<ModelDiscovery>;
  codexModels?: (() => Promise<CodexModel[]>) | null;
  /**
   * The component and plugin library is watched for changes on disk (folder-watch.ts); this is how often it is
   * looked at anyway, to catch what a watcher missed (0: neither watched nor looked at; default 60 s; 1.x polled every 1.5 s).
   */
  componentScanMs?: number;
  /** Bots' memory files are watched for what waits on you; this is how often they are looked at anyway (0: never; chat changes always look; default 60 s). */
  waitingScanMs?: number;
  /** How long the sub-bot hand-off waits for the subagent to end before it stops the turn (tests shorten it). */
  subBotWaitMs?: number;
  /** The plugin host (null: plugins' program parts do not run) and how secrets are sealed. */
  /** `builtIns`: the plugins shipped with the app (out/builtin-plugins; none when left out). */
  plugins?: { node: HostCommand | null; hostScript: string; sealer: Sealer | null; boundSecrets?: boolean; timing?: HostTiming; builtIns?: string | null } | null;
  /** Maintainer's `ccb plugin check` command (null: none this time). */
  checkCommand?: string | null;
  /** The component-shot command Maintainer is given (Phase 5a; null: none, it reads the template). */
  shotCommand?: string | null;
  /**
   * How a bot runs a command a shipped plugin gives it (`agentCommands`: botling.report's `--render-report`): the command line
   * for its script and the app's `flag`, null when this core has no way to (a section that names the command is then not told).
   */
  runCommand?: ((command: { script: string; flag: string }) => string | null) | null;
  /**
   * Where rebuilt shipped plugins go (`<data dir>/plugin-overrides`, app-command.ts) when the command `runCommand` gives runs the
   * app's own flag, which takes an override's script from there; a command's guide then comes from there too (null: shipped only).
   */
  pluginOverrides?: string | null;
  /** Tests: how long the first chat.snapshot is held (the page then shows its input box before any state). */
  firstSnapshotDelayMs?: number;
  /**
   * The app around the core, for the developer tools (botling.dev, plugins/app-seam.ts) and release notices (self-update.ts):
   * main's pid and data folder, the app bundle it runs from (null: not a bundle), and what main does on
   * request: a picture of its window, or quitting so the install script can swap the build. Null: no app.
   */
  app?: {
    pid: number | null;
    dataDir: string | null;
    bundle: string | null;
    request: (op: AppOp, args?: Record<string, string>) => Promise<AppAnswer>;
    /** Botling 3 (server/shell-bridge.ts): botlingd runs this core; `pid` is then its pid, the process an install waits for. */
    server?: { dataDir: string } | null;
    /** Botling 3: for an install the window quits itself, then botlingd stops (2.x asks main to quit). */
    quitForInstall?: () => Promise<void>;
    /** Botling 3: resolves once a window stayed attached for `ms` (a new build counts as up only then). */
    windowHeld?: (ms: number) => Promise<void>;
  } | null;
  /** Botling 3's server only (2.x leaves it unset): turns it keeps aside in its effect outbox (bot.ts `deferTurn`). */
  deferTurn?: (turn: DeferredTurn) => boolean;
  /**
   * Botling 3's server only (2.x leaves it unset, so every bot keeps 2.x's files, `FileBotStore`): the store of the bot
   * kept in `directory` (its folder, or a second head's partner-<engine>/ in it), on server.db rows.
   */
  botStore?: (directory: string) => BotStore;
  /** Botling 3's server only (default: the 2.x `MAIN_BOT_ID`): UUID of the main bot. */
  mainBotId?: string;
  /** Botling 3's server only (default: the 2.x `MAINTAINER_ID`): UUID of Maintainer. */
  maintainerId?: string;
  /** Botling 3's server only (default: true): whether this server runs a main bot. */
  runMainBot?: boolean;
  /** Botling 3's server only: designated server name when `runMainBot` is false. */
  mainBotMachine?: () => string | null;
  /** Botling 3's server only (2.x leaves it unset): content read/fetch for plugins (`content.read`, `content.fetch`). */
  content?: PluginWorld["content"];
  /** Botling 3's server only (2.x leaves it unset): the content reference of a chat line's file, for `plugins.linkCommand` (M5-09). */
  lineContent?: PluginWorld["lineContent"];
  /** Botling 3's server only (2.x leaves it unset): `app_fetch`, files from another machine into the bot's folder (M5-07d). */
  fetch?: (botId: string, request: FetchRequest) => Promise<string>;
  /** Botling 3's server only (2.x leaves it unset): whether a plugin's program part may start at `codeHash` (M5-18a). */
  mayRunServerPart?: (name: string, codeHash: string) => boolean;
  /** Botling 3's server only (2.x leaves it unset): run each non-built-in plugin's program part in its own host process (M5-18b). */
  separateHosts?: boolean;
  /** Botling 3's server only (2.x leaves it unset): a bot created or edited a plugin in `<data>/plugins`. */
  pluginWritten?: (name: string, botId: string) => void;
  /** Botling 3's server only (2.x leaves it unset): peer bots callable with @. */
  remoteMembers?: () => RemoteMember[];
  /** Botling 3's server only (2.x leaves it unset): runs a cross-server call-in turn (M5-02c). */
  remoteTurn?: ConversationsDeps["remoteTurn"];
  /**
   * Botling 3's server only (2.x leaves it unset; M5-04c): sends `cmd` to the server that owns `target` with this
   * server as origin. `committed` settles when the slot is durably queued; `outcome` when the owner has decided.
   */
  remoteCommand?(target: string, cmd: Command): { committed: Promise<void>; outcome: Promise<{ ok: true } | { ok: false; why: string }> };
  /** Botling 3's server only: this machine's name, for "From the main bot on <name>" in what a peer's bot is sent (M5-04c); read at each send. */
  machineName?: string | (() => string);
  /** Botling 3's server only (M5-04d): the other machines of this cluster (valid peers, not this server), named as the main bot's tags name them; read at each use. */
  machines?(): Array<{ id: string; name: string }>;
  /** Botling 3's server only (2.x leaves it unset): the grant tier at this plugin's running hash. */
  pluginGrant?: (name: string) => "none" | "read" | "request" | "write" | null;
  /**
   * Botling 3's server only (M7-O03a): whether the user granted this plugin the named capability at its running hash. `orchestrate`: it may
   * start workers at all; `installed` (2026-11-16): the user allowed it once, so a plugin a bot wrote needs no card per worker. Unset: nobody has it.
   */
  pluginCapability?: (name: string, capability: "orchestrate" | "installed") => boolean;
  /** Where `workers.start` starts to warn (workers at once, workers a day; never a refusal); unset: WARN_AT in orchestration/plugin-workers.ts. */
  orchestrateQuota?: () => { atOnce?: number; perDay?: number };
  /** Botling 3's server only: what this plugin asks at its running hash, for the window's approval (`PluginView.asks`). */
  pluginAsks?: (name: string) => PluginView["asks"] | null;
}

/** The core-set commands Botling 3's server applies inside its own transaction (`Core.applyNow`). */
export type ApplyNowCommand = Extract<Command, { type: "chat.react" | "chat.choose" | "chat.answer" | "chat.ignoreQuestion" | "component.approve" | "settings.set" | "bots.create" }>;

/** What asking for a bot came to (`Workspace.BotMaking`). */
export type BotMaking = { kind: "made"; botId: string } | { kind: "existing"; botId: string } | { kind: "empty" } | { kind: "taken" } | { kind: "removedByUser" };
