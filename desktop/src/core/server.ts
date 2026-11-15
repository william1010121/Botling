import { agyPermissionSessions, changeAgyPermissions } from "./agent/agy-permissions";
import { setBrowserBridge } from "./browser-tools";
import { configureNotes, noteService, setNoteBots } from "./note-tools";
import { ROUTINE_TICK_MS } from "./routines";
import type { ModelDiscovery, ModelEngine } from "../contract/model-discovery";
import { discoveryFailure } from "./agent/model-discovery";
import { RestartJournal, restartPausedNotice } from './restart-continuation';
import { specTrace } from './spec-trace';
import { AgyRuntimeInstaller } from './agy-runtime-install';
import { agyRuntimeStatus, validateAgyRuntimePath } from "./agy-runtime-settings";
import type { AgyConfig } from "./agent/agy";
import { mobileCommand } from '../mobile-bridge/adapter';
import { ALL_BOTS } from '../mobile-bridge/scope';
import { MobileDesk, OFF as MOBILE_OFF } from '../mobile-bridge/desk';
import type { RelayConnector } from '../mobile-relay/connector';
// The core: owns every bot's chat and head, and answers the contract's commands. It is
// transport-agnostic: `receive` takes whatever arrived, `emit` is where answers and events go. It
// validates everything it receives itself — main validating first is defense in depth, not the
// reason the core is safe.
//
// Its data folder has the Swift app's layout (store/workspace.ts). On the first start with an
// empty folder it imports a 1.x folder when one is given (read-only; store/importer.ts).
import { mkdirSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { commandGuidePath } from "./plugins/app-command";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { linkIncoming, PendingFiles, servedType, writeIncoming } from "./attachments";
import { studioWorld } from "./studio-world";
import type { StudioWorld } from "./plugins/studio-seam";
import type { CodexModel } from "./agent/codex-models";
import { botChoicesFromDefaults, engineDefaultsFor } from "./engine-defaults";
import { appliedCodexWorkers, applySetting, claudeWorkersMode, codexWorkersJSON, launchSettings, moveSettingsToPlugins, moveShortcutsToPlugins, readSettings, readSettingsList, seedEngineDefaults, settingsView, writeSettings } from "./settings";
import { claudeAutoCompactWindow, codexConfigFile } from "./engine-files";
import { attachmentFile as attachmentLinkFile } from "../contract/attachment-url";
import { lineHasLink } from "../browser-tab-menu";
import { botName, firstLine, MemoryFiles } from "./projects";
import { answerLabel } from "./attachments";
import { ContractError, PROTOCOL_VERSION, errorResponse, okResponse, parseInbound, type BotView, type Command, type Event, type Outbound, type ResultOf, type WaitingView, type SettingsChange, type SettingsView, type MachinesView, type PluginView } from "../contract";
import { AgentRegistry, isDetached } from "./agent-registry";
import { agyWorkerList } from "./agy-usage-db";
import { AgentStore, migrationRecords } from "./store/agent-store";
import { filePath, pageInCard } from "./page-preview";
import { PAGE_COMPONENT } from "./preview-url";
import { Bot, NO_LONGER_NEEDED, type DeferredTurn, type GuestAnswer, type PresetTurnIds, type SessionStart, type SessionStartCodex, type Status as TurnStatus } from "./bot";
import type { FetchRequest } from "./bot-tools";
import type { HeadConfig } from "./agent/head";
import { CodexThreads, type CodexHeadConfig } from "./agent/codex";
import { maintainerEditorBinding } from "./agent/component-editor";
import { type Engine, type Heads } from "./heads";
import { botPrompts, desktopPrompts, isResultPublishing, preferredLanguage, profilePaths, savedLanguage, withPluginSections, type BotPrompts } from "./prompts";
import { StorageBook, storageItems } from "./storage";
import { BotStore, readJSON } from "./store/bot-store";
import { ProcessLedger } from "./process/ledger";
import { Doctor, DoctorModel } from "./doctor";
import { UsageBook, usageView } from "./usage";
import { fromSwiftDate, isOpenQuestion, MAIN_BOT_ID, newId, toSwiftDate } from "./store/records";
import { botFace } from "./faces";
import { status, statusText } from "../contract/bot-status";
import { currentChat, WorkspaceWatch, type BotSummary, type CurrentChat, type ShownChat, type MemorySections, type ResultLink, type WorkspaceDigest, type WorkspaceSource } from "./workspace";
import { Layout, loadProfiles, type BotProfile } from "./store/workspace";
import { notePath } from "./bot-note";
import { unsupportedRequest } from "./reply";
import { answerMessage, savedQuestions, validPicks, type QuestionPick } from "./questions";
import { Conversations, type ConversationsDeps, type RemoteMember } from "./conversations";
import { answeredNote, guestCardAnswerNote, pickedNote, relayedAnswerNote, type GROUP_TIMING } from "./groups";
import { ComponentsContext } from "./components/service";
import { readdirSync } from "node:fs";
import { FolderWatch } from "./folder-watch";
import { agentContributions, agentStamp, claudeWiring, skillRootsWiring } from "./plugins/agent-contributions";
import { claudeSkillFolders, placedSkillRoot } from "./plugins/engine-skills";
import { Plugins, type BotInfo, type EngineCli, type PluginWorld } from "./plugins";
import type { HostCommand, HostTiming } from "./plugins/host-client";
import type { Sealer } from "./plugins/secrets";
import { MaintainerDesk, builtInManifest, maintainerProfile, prepareLibrary, MAINTAINER_ID } from "./maintainer";
import { PluginStore } from "./plugin-store";
import { INDEX_URL_SETTING } from "./plugins/catalog";
import { maintainerInstructions, maintainerVisualToolRules } from "./maintainer-text";
import { siteToolsFolder } from "./site-tools-guard";
import type { ChatRecord } from "./store/records";
import { ReleaseNotices, confirmHealthyWhen, devWorkRoot, installAndQuit } from "./self-update";
import { CoreWatch } from "./server/watch";
import { CorePeerInbox } from "./server/peer-inbox";
import { CoreProjects } from "./server/projects";
import { CoreBots } from "./server/bots";
import { CoreSubBots } from "./server/sub-bots";
import { CoreAgents } from "./server/agents";

/** What the core asks of main (self-update.ts, plugins/app-seam.ts). */
export type AppOp = "screenshot" | "quit" | "installRelease" | "browser";
export interface AppAnswer { ok: boolean; file?: string; error?: string; plan?: unknown; data?: unknown }
import { discardHandover, drainBots, takeHandover, writeHandover } from "./hot-swap";
import { MACHINE_NAME } from "../remote/machines";
import { machineNameFrom } from "../remote/relay/wire";

/** An id from a peer's rows that is safe as a path part and as a stream key (M5-04c F2). */
export const PEER_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The longest `bots.create` job and `waiting.ignore` text the contract takes (`contract/index.ts`, counted in characters as zod does). */
const BOT_JOB_LIMIT = 4_000;
const WAITING_TEXT_LIMIT = 400;
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
  remoteWorkers?: import("../remote/service").RemoteWorkers | null;
  quotaRetriever?: import("./quota").QuotaRetriever;
  /** Read-only CLI self-check; production starts it offline after activation. */
  doctor?: Doctor;
  /** The public plugin catalog: production checks its index once a day after activation (`autoRefresh`); tests give a fake fetch or none. */
  pluginCatalog?: { autoRefresh?: boolean; fetcher?: import("./plugins/catalog").Fetch };
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
  /** Botling 3's server only: what this plugin asks at its running hash, for the window's approval (`PluginView.asks`). */
  pluginAsks?: (name: string) => PluginView["asks"] | null;
}

/** The core-set commands Botling 3's server applies inside its own transaction (`Core.applyNow`). */
export type ApplyNowCommand = Extract<Command, { type: "chat.react" | "chat.choose" | "chat.answer" | "chat.ignoreQuestion" | "component.approve" | "settings.set" | "bots.create" }>;

/** What asking for a bot came to (`Workspace.BotMaking`). */
export type BotMaking = { kind: "made"; botId: string } | { kind: "existing"; botId: string } | { kind: "empty" } | { kind: "taken" } | { kind: "removedByUser" };

export class Core {
  readonly mainBotId: string;
  readonly maintainerId: string;
  private readonly runMainBot: boolean;
  readonly doctor: DoctorModel;
  private agyInstaller = new AgyRuntimeInstaller();
  readonly epoch = randomUUID().slice(0, 18);
  seq = 0;
  activated = false;
  private inflight = new Map<string, AbortController>();
  private readonly ledger: ProcessLedger;
  /** What the bots used and the subscriptions' limits (spending.json, rate-limits.json, codex-rate-limits.json; Phase 5c). */
  private readonly usage: UsageBook;
  private get imported() { return this.coreProjects.imported; }
  // The collaborators (core/server/*.ts) are made on first use, not in the constructor: a core made without its constructor, as
  // tests make one (`Object.create(Core.prototype)`), reads and writes the moved fields through them too.
  private madeWatch?: CoreWatch;
  private get coreWatch(): CoreWatch { return (this.madeWatch ??= new CoreWatch(this)); }
  private madePeerInbox?: CorePeerInbox;
  private get corePeerInbox(): CorePeerInbox { return (this.madePeerInbox ??= new CorePeerInbox(this)); }
  private madeProjects?: CoreProjects;
  private get coreProjects(): CoreProjects { return (this.madeProjects ??= new CoreProjects(this)); }
  private madeBots?: CoreBots;
  private get coreBots(): CoreBots { return (this.madeBots ??= new CoreBots(this)); }
  private madeSubBots?: CoreSubBots;
  private get coreSubBots(): CoreSubBots { return (this.madeSubBots ??= new CoreSubBots(this)); }
  private madeAgents?: CoreAgents;
  private get coreAgents(): CoreAgents { return (this.madeAgents ??= new CoreAgents(this)); }
  get agents() { return this.coreAgents.agents; }
  set agents(value: CoreAgents["agents"]) { this.coreAgents.agents = value; }
  private get agentStatus() { return this.coreAgents.agentStatus; }
  private get reportTurns() { return this.coreAgents.reportTurns; }
  private get reportStarts() { return this.coreAgents.reportStarts; }
  get bots() { return this.coreBots.bots; }
  set bots(value: CoreBots["bots"]) { this.coreBots.bots = value; }
  private get order() { return this.coreBots.order; }
  private set order(value: CoreBots["order"]) { this.coreBots.order = value; }
  get profiles() { return this.coreBots.profiles; }
  set profiles(value: CoreBots["profiles"]) { this.coreBots.profiles = value; }
  private get newBot() { return this.coreBots.newBot; }
  private set newBot(value: CoreBots["newBot"]) { this.coreBots.newBot = value; }
  get removed() { return this.coreBots.removed; }
  private get removedPluginBots() { return this.coreBots.removedPluginBots; }
  private get subBotsReported() { return this.coreSubBots.subBotsReported; }
  private get routineClock() { return this.coreWatch.routineClock; }
  private set routineClock(value: CoreWatch["routineClock"]) { this.coreWatch.routineClock = value; }
  private get watchClock() { return this.coreWatch.watchClock; }
  private set watchClock(value: CoreWatch["watchClock"]) { this.coreWatch.watchClock = value; }
  private get components() { return this.coreWatch.components; }
  private set components(value: CoreWatch["components"]) { this.coreWatch.components = value; }
  private get componentStamp() { return this.coreWatch.componentStamp; }
  private set componentStamp(value: CoreWatch["componentStamp"]) { this.coreWatch.componentStamp = value; }
  /** Newer signed releases, announced in the main bot's chat in developer mode (the developer tools are botling.dev). */
  readonly releases: ReleaseNotices;
  private get libraryWatch() { return this.coreWatch.libraryWatch; }
  private set libraryWatch(value: CoreWatch["libraryWatch"]) { this.coreWatch.libraryWatch = value; }
  private get memoryWatch() { return this.coreWatch.memoryWatch; }
  private set memoryWatch(value: CoreWatch["memoryWatch"]) { this.coreWatch.memoryWatch = value; }
  private get memoryFiles() { return this.coreWatch.memoryFiles; }
  /** Plugins' workspace changes (`workspace.onChange`): the watch while some plugin listens, its next check, and its clock. */
  private workspaceWatch: WorkspaceWatch | null = null;
  private workspaceTimer: NodeJS.Timeout | null = null;
  private workspaceClock: NodeJS.Timeout | null = null;
  /** The chat the main window shows now, as it last said (`chat.shown`); null: none, or not said yet. */
  private shownChat: ShownChat | null = null;
  readonly plugins: Plugins;
  private get projectFiles() { return this.coreProjects.projectFiles; }
  /** What waits on you as the windows were last told, and the timers that look again. */
  private lastWaiting = "";
  private waitingTimer: NodeJS.Timeout | null = null;
  /** Files waiting in each bot's input box. */
  readonly pending: PendingFiles;
  /** The Storage tab's dragged-in files, by bot (references only; storage.ts). */
  readonly storage: StorageBook;
  readonly maintainer: MaintainerDesk;
  /** The public plugin catalog (Explore, Updates on the Plugins page). */
  readonly pluginStore: PluginStore;
  private get lastPlugins() { return this.coreWatch.lastPlugins; }
  private set lastPlugins(value: CoreWatch["lastPlugins"]) { this.coreWatch.lastPlugins = value; }
  private settlingMaintainer = false;
  private get loadedClaudeParts() { return this.coreWatch.loadedClaudeParts; }
  private set loadedClaudeParts(value: CoreWatch["loadedClaudeParts"]) { this.coreWatch.loadedClaudeParts = value; }
  /** Whether the first chat.snapshot was held already (`firstSnapshotDelayMs`). */
  private snapshotHeld = false;
  /** Bots answering in chats that are not their own: call-ins and bots' @ (Phase 4c). */
  readonly conversations: Conversations;
  /** M5-06c: open `serverAsk` cards by the id of their chat line (the bot they are in, and how to end the wait). */
  private serverAsks = new Map<string, { botId: string; close: (index: number | null) => void }>();
  /** <open-question> copies in the main bot's chat: the copy's id → the question it copies. */
  copies = new Map<string, { botId: string; questionId: string }>();

  mainBot(): Bot | null {
    if (!this.runMainBot) return null;
    const bot = this.bots.get(this.mainBotId);
    return bot?.profile.role === "main" ? bot : null;
  }

  private isMainBotId(id: string): boolean {
    return this.runMainBot && id === this.mainBotId;
  }

  private noMainBotMessage(): string {
    const name = this.options.mainBotMachine?.()?.trim();
    return name ? `There is no main bot on this machine; it runs on ${name}.` : "There is no main bot on this machine.";
  }

  /** Botling 3's server: throws when a command names "main" on a non-designated server. */
  checkBot(id: string): void {
    if (id === "main" && !this.mainBot()) throw new ContractError("not_found", this.noMainBotMessage());
  }

  /**
   * Botling 3's server only: a plugin row changed (a grant, or the running hash). The one path for both M5-14d (front
   * ends see the grant at the running hash) and M5-18a (which program parts may run is decided again): the plugins
   * sync and announce their list through `changed`, which sends `plugins.updated` only when it reads differently.
   */
  pluginGrantsChanged(): void {
    this.plugins.rowsChanged();
  }

  constructor(readonly options: CoreOptions) {
    this.mainBotId = options.mainBotId ?? MAIN_BOT_ID;
    this.maintainerId = options.maintainerId ?? MAINTAINER_ID;
    this.runMainBot = options.runMainBot !== false;
    this.doctor = new DoctorModel(options.doctor ?? new Doctor({ agy: () => agyRuntimeStatus(readSettings(Layout.settings(options.dataDir)), options.dataDir) }), doctor => this.event({ type: "doctor.updated", doctor }));
    mkdirSync(options.dataDir, { recursive: true });
    this.storage = new StorageBook(join(options.dataDir, "storage.json"));
    this.pending = new PendingFiles(join(options.dataDir, "incoming"), (botId, files) => this.event({ type: "files.updated", botId, files }));
    this.ledger = new ProcessLedger(join(options.dataDir, "children.json"));
    const leftovers = this.ledger.endLeftovers();
    if (leftovers.length) this.log(`ended agent process groups an earlier core left running: ${leftovers.join(", ")}`);
    this.importOnce();
    // A remote worker's connection came or went: the worker rows that show it are drawn again (only those that changed).
    options.remoteWorkers?.onChange(() => { for (const bot of this.bots.values()) bot.workerRowsChanged(); });
    // Maintainer (1.x's built-in project): the plugin library is its folder, with the app's files in it.
    // 1.x's key is componentEditorModel (2.0 before Phase 4a read componentEditor: both are honoured).
    // After the import (1.x's settings and library), before the component library first looks: a preview card
    // an app wrote there and nobody edited goes, so botling.cards' shows.
    const editorModel = this.settingsFile()?.componentEditorModel ?? this.settingsFile()?.componentEditor;
    const { editedEditor } = prepareLibrary(options.dataDir, typeof editorModel === "string" && ["sonnet", "opus", "haiku"].includes(editorModel) ? editorModel : "sonnet", options.plugins?.builtIns ?? null);
    if (editedEditor) this.log("ccb-core/claude/agents/component-editor.md was edited by hand; it is left as it is");
    // The component library: <data>/plugins/ccb-components/components first, then other plugins' components/,
    // then the built-in plugins' (botling.cards: the web preview card), so a copy in the library wins.
    const plugins = join(options.dataDir, "plugins");
    const own = join(plugins, "ccb-components", "components");
    this.components = new ComponentsContext(options.dataDir, () => {
      let others: string[] = [];
      try { others = readdirSync(plugins).filter((name) => name !== "ccb-components" && !name.startsWith(".")).sort().map((name) => join(plugins, name, "components")); } catch { /* none */ }
      return [own, ...others, ...(this.plugins?.registry.builtInComponentFolders() ?? [])];
    });
    this.componentStamp = this.components.library.stamp;
    this.components.commands.onPid = (pid, alive) => (alive ? this.ledger.record(pid) : this.ledger.forget(pid));
    // Every card's run goes to the plugins: botling.board's pins (`pin/<id>`), the component studio's specs' cards.
    this.components.commands.onChange = (card) => {
      for (const bot of this.bots.values()) bot.cardChanged(card);
      // A card in a bot's note (`note/<bot id>/<tail>`): the Note tab hears it by the bot and the card's key in the note.
      const note = /^note\/([^/]+)\/(.+)$/.exec(card);
      if (note) this.plugins.event("noteCardChanged", { botId: note[1], key: `note/${note[2]}` });
      else this.plugins.event("cardChanged", { card });
    };
    // The plugins (their host starts later, in start()); the world they see is read when they ask.
    const host = options.plugins ?? null;
    const self = this;
    this.plugins = new Plugins({
      dataDir: options.dataDir,
      node: host?.node ?? null,
      hostScript: host?.hostScript ?? "",
      builtIns: host?.builtIns ?? null,
      sealer: host?.sealer ?? null,
      boundSecrets: host?.boundSecrets,
      timing: host?.timing,
      onPid: (pid, alive) => (alive ? this.ledger.record(pid) : this.ledger.forget(pid)),
      ...(options.mayRunServerPart ? { mayRunServerPart: options.mayRunServerPart } : {}),
      ...(options.separateHosts !== undefined ? { separateHosts: options.separateHosts } : {}),
      ...(options.pluginGrant ? { pluginGrant: options.pluginGrant } : {}),
      ...(options.pluginAsks ? { pluginAsks: options.pluginAsks } : {}),
      world: {
        bots: () => this.order.filter((id) => !this.isSubBot(id)).map((id) => this.botInfo(this.bots.get(id)!)),
        send: (botId, text, via) => {
          const bot = this.pluginBot(botId);
          if (!bot) throw new Error("No such bot.");
          return { messageId: bot.send(text, via ? { via } : {}).messageId };
        },
        interrupt: async (botId) => {
          const bot = this.pluginBot(botId);
          if (!bot) return null;
          // Every turn under way, as the stop button sends them (with two heads, both may work).
          const stopped = await Promise.all(bot.snapshot().runs.map((run) => bot.stop(run.turnId)));
          return stopped.some((outcome) => outcome.stopped);
        },
        notice: (text, actions) => {
          this.mainBot()?.appNotice(text, actions?.map((action) => ({ label: action.label })), actions ? (index) => actions[index]?.run() : undefined);
        },
        ask: (question) => new Promise((resolve) => {
          const main = this.mainBot();
          if (!main) { resolve({ index: Math.max(0, question.choices.length - 1) }); return; }
          // The last choice is Cancel: null, as the plugin sees it (Plugins' ui.quickPick / ui.input).
          const id: string = main.appNotice(question.text, question.choices, (index) => resolve({ index }), question.typed ? {
            onAnswer: (words) => {
              if (!words) return false;
              main.settleAppQuestion(id, { answer: words });
              resolve({ text: words });
              return true;
            },
          } : {});
        }),
        openPanel: (plugin, panel, title) => this.event({ type: "plugins.open", plugin, panel, title }),
        openTab: (plugin, view, botId) => this.event({ type: "plugins.openTab", plugin, view, botId }),
        // Straight to the app page, not through `event()`: no plugin, workspace or phone listener has anything to do with it.
        frameEvent: (plugin, name, botId, data) => this.options.emit({ v: PROTOCOL_VERSION, epoch: this.epoch, seq: ++this.seq, event: { type: "plugins.emit", plugin, name, ...(botId ? { forBot: botId === "main" ? (this.mainBot()?.id ?? botId) : botId } : {}), data } }),
        botFolder: (botId) => this.pluginBot(botId)?.profile.folder ?? null,
        botNote: (botId) => {
          const bot = this.pluginBot(botId);
          return bot ? notePath(bot.profile) : null;
        },
        imageUrl: (path, type) => this.components.images.register(path, type),
        appSettings: () => {
          const settings = settingsView(readSettings(Layout.settings(this.options.dataDir)));
          return { language: settings.effectiveLanguage, botLook: settings.botLook, workerLimit: settings.claudeWorkerLimit };
        },
        shortcutOverrides: () => settingsView(readSettings(Layout.settings(this.options.dataDir))).shortcuts,
        createBot: (plugin, title, name, job, avatar, more) => this.createPluginBot(plugin, title, { name, job, ...(avatar ? { avatar } : {}), ...more }),
        commandApproval: (botId, command) => this.pluginBot(botId)?.commandApproval(command) ?? null,
        commandRun: (botId, key, command, run) => this.pluginBot(botId)?.pluginCommand(key, command, run) ?? null,
        component: (botId, name, data, command) => this.pluginBot(botId)?.libraryEntry(name, data, command) ?? null,
        imageUrls: (botId, data) => this.pluginBot(botId)?.imageUrls(data) ?? null,
        cardAsk: (botId, card, command, component) => this.pluginBot(botId)?.cardAskFor(card, command, component) ?? null,
        cardApprove: (botId, command, component, folder, detail) => this.pluginBot(botId)?.cardApproveFor(command, component, folder, detail) ?? false,
        noteCards: {
          components: (botId) => this.pluginBot(botId)?.noteComponents() ?? null,
          states: (botId, cards) => this.pluginBot(botId)?.noteCardStates(cards) ?? null,
          run: (botId, key, command, force) => this.pluginBot(botId)?.noteCardRun(key, command, force) ?? null,
        },
        cards: {
          library: (botId) => this.pluginBot(botId)?.cardLibrary() ?? null,
          shown: (botId) => this.pluginBot(botId)?.cardsShown() ?? null,
          states: (botId, cards) => this.pluginBot(botId)?.cardStates(cards) ?? null,
          run: (botId, card, command, force) => this.pluginBot(botId)?.cardRun(card, command, force) ?? null,
          ask: (botId, card, command, component) => this.pluginBot(botId)?.cardAskFor(card, command, component) ?? null,
          setNotes: (botId, notes) => { const bot = this.pluginBot(botId); if (!bot) return false; bot.setCardNotes(notes); return true; },
          legacyPins: (botId) => this.pluginBot(botId)?.legacyPins() ?? null,
        },
        dataChanged: (botId, plugin, data) => { if (this.bots.has(botId)) this.event({ type: "chat.pluginData", botId, plugin, data }); },
        approveCommand: (botId, command) => this.pluginBot(botId)?.approveCommand(command) ?? false,
        chat: (botId, limit) => {
          const bot = this.pluginBot(botId);
          if (!bot) return null;
          const chat = bot.pluginChat(limit);
          return { ...chat, botId: this.outId(chat.botId) };
        },
        botId: (botId) => this.pluginBot(botId)?.id ?? null,
        decorated: (botId) => { if (this.bots.has(botId)) this.event({ type: "chat.decorations", botId, decorations: this.plugins.decorations(botId) }); },
        engineCli: (engine) => options.engineCli?.(engine) ?? null,
        addRoutine: (botId, cron, task) => {
          const bot = botId === "main" ? this.mainBot() : this.bots.get(botId);
          if (!bot) return "no-bot";
          return bot.addRoutine(cron, task) ? "added" : "bad-schedule";
        },
        routinesList: (botId) => this.pluginBot(botId)?.routinesView() ?? null,
        routinesChange: (botId, operation, id) => {
          const bot = this.pluginBot(botId);
          // Not `ContractError`'s wording to a plugin: the store's own message, as the app's panel showed it.
          return bot ? bot.changeRoutine({ operation, id }) : null;
        },
        changed: (view) => {
          this.followClaudeParts();
          // A built-in plugin turned on or off brings or takes away its cards (botling.cards).
          if (this.components.library.rescan()) for (const bot of this.bots.values()) bot.componentsChanged();
          this.componentsTick();
          const text = JSON.stringify(view);
          if (text === this.lastPlugins) return;
          this.lastPlugins = text;
          this.event({ type: "plugins.updated", plugins: view });
        },
        pluginWritten: (name) => { const botId = this.activePluginWriter(); if (botId) options.pluginWritten?.(name, botId); },
        broken: (plugin, problem) => this.maintainer.broken(plugin, problem),
        log: (line) => this.log(line),
        app: {
          state: () => ({
            pid: options.app?.pid ?? null, dataDir: options.dataDir, appDataDir: options.app?.dataDir ?? null, bundle: options.app?.bundle ?? null,
            server: options.app?.server ?? null,
            developerMode: settingsView(readSettings(Layout.settings(options.dataDir))).developerMode,
            developer: (() => { const bot = this.developerProject(); return bot ? { id: bot.id, name: bot.profile.name, folder: bot.profile.folder } : null; })(),
          }),
          // Running work resumes on the new build (restart-continuation.ts); a failed checkpoint stops the install.
          installAndRestart: (command, log) => installAndQuit(command, log, {
            prepareRestart: () => this.prepareRestart(), cancelRestart: () => this.cancelRestart(), app: options.app, log: (line) => this.log(line),
          }),
          captureWindow: async () => {
            if (!options.app) return null;
            try { const answer = await options.app.request("screenshot"); return answer.ok && answer.file ? answer.file : null; } catch { return null; }
          },
          card: (text, choices, source) => new Promise((resolve) => {
            const main = this.mainBot();
            if (!main) { resolve(null); return; }
            main.appNotice(text, choices, choices ? (index) => resolve(index) : undefined, source ? { sourceID: source } : {});
            if (!choices) resolve(null);
          }),
          tell: (botId, kind, text, files) => {
            const bot = this.pluginBot(botId);
            if (!bot) return false;
            if (kind === "note") bot.queueNote(text); else bot.relay(text, files.length ? { files } : {});
            return true;
          },
        },
        // The component studio's seam (plugins/studio-seam.ts); built when first asked, once Maintainer and the library exist.
        get studio() { return self.studioNow(); },
        sessionMoved: (botId, reason) => this.bots.get(botId)?.folderMoved(reason),
        sessionBots: () => this.profiles.filter((profile) => profile.role !== "main" && profile.id !== this.maintainerId && !this.removed.has(profile.id)).map((profile) => ({
          id: profile.id, name: profile.name, role: profile.role as "manager" | "bot", parent: profile.parent ?? null, folder: profile.folder,
          memoryPath: profile.memoryPath, storeDir: profile.storeDir, problem: profile.problem,
          workRoot: this.developerProject()?.id === profile.id ? devWorkRoot() : null,
        })),
        usageView: async () => { await this.usage.refresh(); return usageView(this.usage.view()); },
        workspace: this.workspaceSource(),
        workspaceWatch: (on) => this.watchWorkspace(on),
        ...(options.content ? { content: options.content } : {}),
        ...(options.lineContent ? { lineContent: options.lineContent } : {}),
      },
    });
    // Settings that are a built-in plugin's now (the paste limits: botling.chat-extras) move to its settings once.
    moveSettingsToPlugins(Layout.settings(options.dataDir), (plugin, key, value) => this.plugins.registry.set(plugin, key, value));
    moveShortcutsToPlugins(Layout.settings(options.dataDir));
    // The component library has the built-in plugins' cards now (botling.cards' preview card), before any bot
    // gets its first list (the built-ins).
    // (Its first finding is not a "catalog change", so rescan() says false; the stamp moved all the same, and
    // left behind it would make start() announce what the snapshot shows already, with a seq a client may hold.)
    this.components.library.rescan();
    this.componentStamp = this.components.library.stamp;
    // What the snapshot shows already is no event (an event comes only when something changes).
    this.lastPlugins = JSON.stringify(this.plugins.view());
    this.loadedClaudeParts = JSON.stringify(agentStamp(this.plugins.registry));
    // Quota files must be imported before their first in-memory reading.
    this.usage = new UsageBook(options.dataDir, undefined, undefined, options.quotaRetriever);
    const loaded = loadProfiles(options.dataDir, { mainBotId: this.mainBotId, maintainerId: this.maintainerId });
    if (loaded.problem) this.log(`projects: ${loaded.problem}`);
    try {
      const removed = readJSON(join(options.dataDir, "removed-bots.json"));
      if (Array.isArray(removed)) for (const key of removed) if (typeof key === "string") this.removedPluginBots.add(key);
    } catch { /* none */ }
    const appMaintainer = maintainerProfile(options.dataDir, maintainerInstructions(join(options.dataDir, "plugins"), options.checkCommand ?? null, options.shotCommand ?? null)
      + "\n" + maintainerVisualToolRules(siteToolsFolder(options.dataDir, options.app?.dataDir)), this.maintainerId);
    const baseProfiles = this.runMainBot
      ? loaded.profiles
      : loaded.profiles.flatMap((profile) => {
          if (profile.id !== this.mainBotId) return [profile];
          let hasHistory = false;
          try {
            const chat = this.storeOf(profile.storeDir).loadMessages();
            hasHistory = chat.records.length > 0 || chat.dropped > 0;
          } catch {
            hasHistory = true;
          }
          return hasHistory ? [{ ...profile, role: "bot" as const, name: "Main (old)" }] : [];
        });
    const profiles = [...baseProfiles, appMaintainer];
    const editorBinding = maintainerEditorBinding(appMaintainer, options.dataDir, options.headConfig, this.maintainerId);
    const threads = new CodexThreads(join(options.dataDir, "codex-threads"));
    const codexConfig = options.codexConfig;
    this.profiles = profiles;
    // The agent registry, before any bot: the first start adopts every host book (running ones were cut off with the app).
    (this as { agents: AgentRegistry }).agents = new AgentRegistry(new AgentStore(options.dataDir, (line) => this.log(line)));
    if (this.agents.fresh) {
      try { const adopted = this.agents.adopt(migrationRecords(profiles)); if (adopted) this.log(`agents.json made from the bots' subagent lists (${adopted})`); }
      catch (error) { this.log(`agents.json migration: ${(error as Error).message}`); }
    }
    this.agents.onChange((record, previous) => this.agentChanged(record, previous));
    this.newBot = (profile) => {
      const bot = build(profile);
      this.bots.set(profile.id, bot);
      return bot;
    };
    const build = (profile: BotProfile): Bot => {
      const bot: Bot = new Bot({
        profile,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        deferStartup: options.deferStartup && !this.activated,
        headConfig: options.headConfig,
        agyConfig: options.agyConfig,
        codexConfig: codexConfig ? (p, session) => ({
          ...codexConfig(p, session, threads),
          componentEditor: editorBinding(p, session),
          editorStarted: (pid) => { if (pid > 0) this.ledger.record(pid); },
        }) : null,
        claimWaitMs: options.claimWaitMs,
        prompts: (engine, heads) => this.prompts(profile, engine, heads, profile.role === "main" || profile.id === this.maintainerId ? null : this.plugins.sessionFolder(profile.id)?.cwd ?? profile.folder),
        // A project's manager works in the user's own folder, shared with 1.x: one Botling at a time.
        tidyTimeoutMs: options.tidyTimeoutMs,
        quitTidyMs: options.quitTidyMs,
        ledger: this.ledger,
        emit: (event) => this.event(event),
        log: (line) => this.log(line),
        approvalTimeoutMs: options.approvalTimeoutMs ?? 10 * 60_000,
        idleMs: options.idleMs ?? 50 * 60_000,
        interruptGraceMs: options.interruptGraceMs ?? 2_000,
        projectBriefing: profile.role === "main" ? () => this.projectBriefing() : undefined,
        // The main bot wakes with the project list (`mainBot.wakeNote`) and may write every inbox (`--add-dir`).
        wakeNote: profile.role === "main" ? () => this.projectBriefing()
          // The developer project's manager hears what developer mode lets it do (`developerBriefing`).
          : profile.id !== this.maintainerId
            ? () => [profile.role === "manager" ? this.developerBriefing(profile.id) : "", this.plugins.sessionFolder(profile.id)?.note ?? "", this.subBotNote(profile), this.ownedAgentsNote(profile)].filter(Boolean).join("\n\n")
            : undefined,
        // A plugin may decide where a project's or bot's session starts (an app-made worktree: botling.git); the main bot and Maintainer never move.
        worktree: profile.role === "main" || profile.id === this.maintainerId ? undefined : () => {
          const folder = this.plugins.sessionFolder(profile.id);
          return folder && folder.cwd !== profile.folder ? { cwd: folder.cwd, addDirs: folder.addDirs } : null;
        },
        addDirs: profile.role === "main" ? () => this.profiles.filter((other) => other.role !== "main" && !other.parent && !other.problem).map((other) => join(other.folder, ".bot"))
          // Maintainer: the folders you let it read (<need-folder>).
          // and the browser's site tools, which are its alone.
          : profile.id === this.maintainerId ? () => [siteToolsFolder(options.dataDir, options.app?.dataDir), ...this.maintainer.approvedFolders()] : undefined,
        // Every other bot's Claude head and workers are refused writes into the site tools folder (site-tools-guard.ts).
        siteToolsFolder: profile.id === this.maintainerId ? undefined : siteToolsFolder(options.dataDir, options.app?.dataDir),
        remoteWorkers: () => options.remoteWorkers ?? null,
        subBotRows: profile.role === "main" || profile.id === this.maintainerId ? undefined : () => this.subBotRows(profile.id),
        components: this.components,
        onRequests: (bot, requests) => this.maintainer.handle(bot, this.projectRequests(bot, requests)),
        // What each turn used, by bot, and the subscriptions' limits (1.x's `record`, `note`).
        usage: (name, spent, tokens) => this.usage.record(spent, tokens, name),
        rateLimits: (engine, limits) => this.usage.note(engine, limits),
        // What a line shows besides itself for the component studio (botling.component-studio, through its seam): the library component a
        // reply already is. The studio draws its chips under replies itself (chat.decorate).
        lineExtras: (_bot, record) => this.plugins.studioLineExtras(record),
        replyFilter: (): ((text: string) => Promise<string>) | null => this.plugins.afterReplyFilter(() => this.botInfo(bot)),
        replied: (bot, record) => this.replied(bot, record),
        pluginTags: (bot, tags) => this.plugins.replyTags(this.botInfo(bot), tags),
        plugins: () => this.agentWiring(),
        pluginStamp: () => agentStamp(this.plugins.registry),
        launch: () => launchSettings(readSettings(Layout.settings(this.options.dataDir))),
        // (Asked while the bots are made, before the conversations exist.)
        guest: () => this.conversations?.speakers.get(profile.id) ?? null,
        callIns: () => this.conversations?.callIns(profile.id) ?? [],
        answeringIn: () => this.conversations?.answeringIn(profile.id) ?? null,
        callInNote: () => this.conversations?.callInStatus(profile.id) ?? null,
        callInFollowUp: (caller, asked, record, by) => this.conversations?.callInFollowUp(caller, bot, asked, record, by),
        callInFollowUpMissed: (caller, asked, why, by) => this.conversations?.callInFollowUpMissed(caller, bot, asked, why, by),
        agents: this.agentPort(profile),
        ...(options.deferTurn ? { deferTurn: options.deferTurn } : {}),
        ...(options.botStore ? { botStore: options.botStore } : {}),
      });
      return bot;
    };
    for (const profile of profiles) {
      this.newBot(profile);
      this.order.push(profile.id);
    }
    this.conversations = new Conversations({
      dataDir: options.dataDir,
      // Everyone who can answer outside their own chat, in turn order (`everyMember`).
      members: () => this.order.flatMap((id) => {
        const profile = this.profiles.find((candidate) => candidate.id === id);
        return profile && !profile.parent && !this.removed.has(id) ? [{ id, name: profile.role === "main" ? "Main bot" : profile.name }] : [];
      }),
      // A project bot's own sub bots answer @ in its chat (its reply's or yours), nowhere else.
      subBots: () => this.profiles.flatMap((profile) => (profile.parent && !this.removed.has(profile.id) ? [{ id: profile.id, name: profile.name, parent: profile.parent }] : [])),
      bot: (id) => (this.removed.has(id) ? null : this.bots.get(id) ?? null),
      mainBotId: this.mainBotId,
      mentionNote: (text) => this.components.library.mentionNote(text),
      replied: (bot, line) => this.replied(bot, line),
      replyFilter: (bot) => this.plugins.afterReplyFilter(() => this.botInfo(bot)),
      handle: (bot, requests) => {
        const left = this.maintainer.handle(bot, this.projectRequests(bot, requests));
        if (left.length) bot.appNotice(`Botling 2.0 cannot do this yet, so nothing happened: ${[...new Set(left.map(unsupportedRequest))].join("; ")}.`);
      },
      afterMainTurn: () => this.deliverInboxes(),
      speaking: (botId) => this.bots.get(botId)?.refresh(),
      refreshWaiting: () => this.refreshWaiting(),
      log: (line) => this.log(line),
      timing: options.groupTiming,
      ...(options.remoteMembers ? { remoteMembers: options.remoteMembers } : {}),
      ...(options.remoteTurn ? { remoteTurn: options.remoteTurn } : {}),
    });
    this.maintainer = new MaintainerDesk({
      root: options.dataDir,
      maintainerId: this.maintainerId,
      maintainer: () => this.bots.get(this.maintainerId) ?? null,
      mainBot: () => this.mainBot(),
      bots: () => [...this.bots.values()],
      library: this.components.library,
      plugins: () => this.plugins,
      rescan: () => this.scanComponents(),
      log: (line) => this.log(`maintainer: ${line}`),
    });
    this.plugins.previousVersion = (name) => this.maintainer.previousOf(name)?.version ?? null;
    this.pluginStore = new PluginStore({
      root: options.dataDir,
      desk: this.maintainer,
      registry: () => this.plugins.registry,
      indexOverride: () => readSettings(Layout.settings(options.dataDir))[INDEX_URL_SETTING],
      appVersion: process.env.BOTLING_APP_VERSION?.trim() || null,
      ...(options.pluginCatalog?.fetcher ? { fetcher: options.pluginCatalog.fetcher } : {}),
      changed: (store) => this.event({ type: "plugins.store", store }),
      log: (line) => this.log(line),
    });
    const app = options.app ?? null;
    // The bots' tools on the in-app browser pane (browser-tools.ts) ask main through this.
    setBrowserBridge(app ? (request) => app.request("browser", { request }) : null);
    // Every bot's Note (note-tools.ts): this process is the one writer of each note.db; it watches each note.md it opened
    // for edits made there, and one it cannot take (made on an older copy) is kept beside it and told to plugins.
    configureNotes({
      watch: true, log: (line) => this.log(line),
      conflict: (note, kept, reason) => {
        const entry = [...this.bots.entries()].find(([id, bot]) => !this.removed.has(id) && notePath(bot.profile) === note);
        if (entry) this.plugins.event("noteConflict", { botId: this.outId(entry[0]), file: kept, reason });
      },
    });
    setNoteBots(() => [...this.bots.entries()].filter(([id]) => !this.removed.has(id)).map(([id, bot]) => ({ id, name: bot.profile.name, folder: bot.profile.folder, note: notePath(bot.profile) })));
    this.releases = new ReleaseNotices({
      root: options.dataDir,
      developerMode: () => settingsView(readSettings(Layout.settings(options.dataDir))).developerMode,
      mainBot: () => this.mainBot() ?? { appNotice: () => "" },
      installRelease: app ? () => app.request("installRelease") : undefined,
      log: (line) => this.log(line),
    });
    // The registry against the bots' subagent lists (A1.3), once everything is built; its notices wait for `activate`.
    try { this.reconcileAgents(false); } catch (error) { this.log(`agents reconcile: ${(error as Error).message}`); }
    if (!options.deferStartup) this.activate();
  }

  private activate() {
    if (this.activated) return;
    this.activated = true;
    if (this.options.doctor) void this.doctor.run(false).catch(() => this.log("Doctor check failed."));
    for (const bot of this.bots.values()) bot.activateStartup();
    // Started by a core hot swap: the old core's sessions go on, and what waited there is delivered.
    this.adoptSwap();
    try { new RestartJournal(this.options.dataDir).recover(entry => {
      const bot=this.bots.get(entry.botId);if(!bot)throw Error("Original bot unavailable.");bot.adoptRestart(entry);
    }, (entry,reason) => {
      const bot=this.bots.get(entry.botId);
      try { bot?.retainRestartIdentity(entry); } catch(error) { this.log(`restart identity: ${String(error)}`); }
      if (bot) bot.restartPaused(entry, reason); else this.mainBot()?.appNotice(restartPausedNotice(entry, reason));
      this.log(`restart ${entry.botId}: ${reason}`);
    }); } catch(error){
      this.log(String(error));
      this.mainBot()?.appNotice("Restart continuation could not be read. The checkpoint is preserved; no recovery prompt was sent. Reconcile it before retrying.");
    }
    // After restart recovery: the registry again, and what it found told (moves cut short finish their notices).
    try { this.reconcileAgents(true); } catch (error) { this.log(`agents reconcile: ${(error as Error).message}`); }
    const options = this.options;
    // How an install of a developer build went (`checkSelfUpdate`).
    // The new build says it came up (the install script waits for that); botling.dev tells the bot that asked.
    // Botling 3: only once a window stayed attached to this botlingd (`windowHeld`).
    try { confirmHealthyWhen(options.dataDir, options.app?.windowHeld, undefined, (line) => this.log(line)); } catch (error) { this.log(`self-update: ${(error as Error).message}`); }
    void this.plugins.start().catch((error) => this.log(`plugins: ${(error as Error).message}`));
    if (options.pluginCatalog?.autoRefresh) this.pluginStore.startup();
    // Checking a wall-clock time every 15 s (rather than sleeping until it) survives the computer
    // sleeping; a time missed while the app was closed runs once later that day (1.x).
    // The library on disk (a template edited by hand, a plugin dropped in) is watched rather than polled;
    // a slow look still runs, which also re-arms watchers after an external disk comes back.
    const scan = options.componentScanMs ?? 60_000;
    if (scan > 0) {
      this.libraryWatch = new FolderWatch({
        targets: () => this.libraryTargets(), changed: () => this.scanComponents(),
        reconcileMs: scan, fallbackMs: Math.min(scan, 1_500), log: (line) => this.log(line),
      });
      this.libraryWatch.start();
    }
    const tick = options.routineTickMs ?? ROUTINE_TICK_MS;
    if (tick > 0) {
      setTimeout(() => this.checkRoutines(), 0);
      this.routineClock = setInterval(() => this.checkRoutines(), tick);
      this.routineClock.unref?.();
    }
    // Every 20 s (1.x's `startWatching`): runs that went quiet for Settings' "Remind after no new step for" get a reminder.
    const watch = options.watchMs ?? 20_000;
    if (watch > 0) {
      this.watchClock = setInterval(() => this.watchRuns(), watch);
      this.watchClock.unref?.();
    }
    // Memory files change under the bots' hands (a manager's "Waiting on you", "In progress"): watched, and looked at
    // every so often in case a change was missed (a project on an external disk that went away and came back).
    this.lastWaiting = JSON.stringify(this.waiting());
    const look = options.waitingScanMs ?? 60_000;
    if (look > 0) {
      this.memoryWatch = new FolderWatch({
        targets: () => this.memoryTargets(), changed: () => this.refreshWaiting(),
        reconcileMs: look, fallbackMs: Math.min(look, 5_000), log: (line) => this.log(line),
      });
      this.memoryWatch.start();
    }
  }

  private libraryTargets(...a: Parameters<CoreWatch["libraryTargets"]>) { return this.coreWatch.libraryTargets(...a); }

  private memoryTargets(...a: Parameters<CoreWatch["memoryTargets"]>) { return this.coreWatch.memoryTargets(...a); }

  componentsTick(...a: Parameters<CoreWatch["componentsTick"]>) { return this.coreWatch.componentsTick(...a); }

  scanComponents(...a: Parameters<CoreWatch["scanComponents"]>) { return this.coreWatch.scanComponents(...a); }

  private pinOwner(...a: Parameters<CoreWatch["pinOwner"]>) { return this.coreWatch.pinOwner(...a); }

  private reportComponent(...a: Parameters<CoreWatch["reportComponent"]>) { return this.coreWatch.reportComponent(...a); }

  private followClaudeParts(...a: Parameters<CoreWatch["followClaudeParts"]>) { return this.coreWatch.followClaudeParts(...a); }

  checkStalls(...a: Parameters<CoreWatch["checkStalls"]>) { return this.coreWatch.checkStalls(...a); }

  private watchRuns(...a: Parameters<CoreWatch["watchRuns"]>) { return this.coreWatch.watchRuns(...a); }


  checkNetwork(...a: Parameters<CoreWatch["checkNetwork"]>) { return this.coreWatch.checkNetwork(...a); }

  private developerBriefing(...a: Parameters<CoreWatch["developerBriefing"]>) { return this.coreWatch.developerBriefing(...a); }

  developerProject(...a: Parameters<CoreWatch["developerProject"]>) { return this.coreWatch.developerProject(...a); }

  reportFeedback(...a: Parameters<CoreWatch["reportFeedback"]>) { return this.coreWatch.reportFeedback(...a); }

  private componentInfos(...a: Parameters<CoreWatch["componentInfos"]>) { return this.coreWatch.componentInfos(...a); }

  checkRoutines(...a: Parameters<CoreWatch["checkRoutines"]>) { return this.coreWatch.checkRoutines(...a); }

  projectBriefing(...a: Parameters<CorePeerInbox["projectBriefing"]>) { return this.corePeerInbox.projectBriefing(...a); }

  private peerBots(...a: Parameters<CorePeerInbox["peerBots"]>) { return this.corePeerInbox.peerBots(...a); }



  briefAwakeMainBot(...a: Parameters<CorePeerInbox["briefAwakeMainBot"]>) { return this.corePeerInbox.briefAwakeMainBot(...a); }

  makeBot(...a: Parameters<CoreBots["makeBot"]>) { return this.coreBots.makeBot(...a); }

  createPluginBot(...a: Parameters<CoreBots["createPluginBot"]>) { return this.coreBots.createPluginBot(...a); }

  writeInstructions(...a: Parameters<CoreBots["writeInstructions"]>) { return this.coreBots.writeInstructions(...a); }

  private isSubBot(...a: Parameters<CoreBots["isSubBot"]>) { return this.coreBots.isSubBot(...a); }

  private subBotRows(...a: Parameters<CoreBots["subBotRows"]>) { return this.coreBots.subBotRows(...a); }

  private subBotNote(...a: Parameters<CoreBots["subBotNote"]>) { return this.coreBots.subBotNote(...a); }

  subBotRequested(...a: Parameters<CoreSubBots["subBotRequested"]>) { return this.coreSubBots.subBotRequested(...a); }

  removeSubBotRequested(...a: Parameters<CoreSubBots["removeSubBotRequested"]>) { return this.coreSubBots.removeSubBotRequested(...a); }

  removeBotRequested(...a: Parameters<CoreSubBots["removeBotRequested"]>) { return this.coreSubBots.removeBotRequested(...a); }

  agentFlags(...a: Parameters<CoreAgents["agentFlags"]>) { return this.coreAgents.agentFlags(...a); }

  agentBotName(...a: Parameters<CoreAgents["agentBotName"]>) { return this.coreAgents.agentBotName(...a); }

  private agentPort(...a: Parameters<CoreAgents["agentPort"]>) { return this.coreAgents.agentPort(...a); }

  private agentChanged(...a: Parameters<CoreAgents["agentChanged"]>) { return this.coreAgents.agentChanged(...a); }

  private reconcileAgents(...a: Parameters<CoreAgents["reconcileAgents"]>) { return this.coreAgents.reconcileAgents(...a); }

  agentsOfRemovedBot(...a: Parameters<CoreAgents["agentsOfRemovedBot"]>) { return this.coreAgents.agentsOfRemovedBot(...a); }

  private ownedAgentsNote(...a: Parameters<CoreAgents["ownedAgentsNote"]>) { return this.coreAgents.ownedAgentsNote(...a); }

  agentView(...a: Parameters<CoreAgents["agentView"]>) { return this.coreAgents.agentView(...a); }

  agentTargets(...a: Parameters<CoreAgents["agentTargets"]>) { return this.coreAgents.agentTargets(...a); }

  moveAgent(...a: Parameters<CoreAgents["moveAgent"]>) { return this.coreAgents.moveAgent(...a); }

  groupAgents(...a: Parameters<CoreAgents["groupAgents"]>) { return this.coreAgents.groupAgents(...a); }

  moveOwners(...a: Parameters<CoreAgents["moveOwners"]>) { return this.coreAgents.moveOwners(...a); }

  private finishMove(...a: Parameters<CoreAgents["finishMove"]>) { return this.coreAgents.finishMove(...a); }

  commandAgent(...a: Parameters<CoreAgents["commandAgent"]>) { return this.coreAgents.commandAgent(...a); }

  agentMessageCommand(...a: Parameters<CoreAgents["agentMessageCommand"]>) { return this.coreAgents.agentMessageCommand(...a); }

  agentStopCommand(...a: Parameters<CoreAgents["agentStopCommand"]>) { return this.coreAgents.agentStopCommand(...a); }

  agentTag(...a: Parameters<CoreAgents["agentTag"]>) { return this.coreAgents.agentTag(...a); }

  closeSubBot(...a: Parameters<CoreSubBots["closeSubBot"]>) { return this.coreSubBots.closeSubBot(...a); }

  makeSubBot(...a: Parameters<CoreSubBots["makeSubBot"]>) { return this.coreSubBots.makeSubBot(...a); }

  private subBotReplied(...a: Parameters<CoreSubBots["subBotReplied"]>) { return this.coreSubBots.subBotReplied(...a); }

  private storeOf(...a: Parameters<CoreBots["storeOf"]>) { return this.coreBots.storeOf(...a); }

  singleEngine(...a: Parameters<CoreBots["singleEngine"]>) { return this.coreBots.singleEngine(...a); }

  seedEngineDefaults(...a: Parameters<CoreBots["seedEngineDefaults"]>) { return this.coreBots.seedEngineDefaults(...a); }

  attach(...a: Parameters<CoreBots["attach"]>) { return this.coreBots.attach(...a); }

  machineNamed(...a: Parameters<CoreBots["machineNamed"]>) { return this.coreBots.machineNamed(...a); }

  tellMain(...a: Parameters<CoreBots["tellMain"]>) { return this.coreBots.tellMain(...a); }

  /**
   * The main bot's <new-bot name="…" machine="…">job</new-bot> (M5-04d, D26, Q-C3): `bots.create` on that peer's server, this
   * server as origin (scope `manage`). The bot is made there, never here; the outcome comes back to the main bot as a note.
   */
  botRequestedOn(machineName: string, rawName: string, rawJob: string, sentOnce: Set<string>) {
    const machine = this.machineNamed(machineName);
    if (machine.kind === "here") { this.botRequested(rawName, rawJob, null); return; }
    if (machine.kind === "unknown") { this.tellMain((p) => `There is no machine named "${p(machine.name)}"; the bot was not made.`); return; }
    const name = botName(rawName);
    const job = rawJob.trim();
    if (!name || !job) return;
    const remoteCommand = this.options.remoteCommand!;
    let told = false;
    const tell = (why: string | null) => {
      if (told) return;
      told = true;
      this.tellMain((p) => (why === null ? `The bot "${p(name)}" was made on ${p(machine.name)}.` : `${p(machine.name)} did not make the bot "${p(name)}": ${p(oneLine(why))}.`));
    };
    if (machine.kind === "ambiguous") { tell("more than one machine has that name"); return; }
    if (job.length > BOT_JOB_LIMIT) { tell(`the job is longer than ${BOT_JOB_LIMIT} characters`); return; }
    const once = `${machine.id}\n${name.toLowerCase()}`;
    if (sentOnce.has(once)) return;
    sentOnce.add(once);
    let sent: ReturnType<typeof remoteCommand>;
    try { sent = remoteCommand(`srv:${machine.id}`, { type: "bots.create", name, job }); } catch (error) { tell((error as Error).message); return; }
    // The slot is committed first (a failure there is final), the owner's decision comes later; the main bot hears one of them.
    sent.committed.catch((error: unknown) => tell((error as Error).message));
    sent.outcome.then((outcome) => tell(outcome.ok ? null : outcome.why), (error: unknown) => tell((error as Error).message));
  }

  /** A bot of another machine of this cluster (`peerBots`) that is not one of this server's own (a local id always wins). */
  private peerBotFor(botId: string): RemoteMember | null {
    if (botId === "main" || this.bots.has(botId) || this.profiles.some((profile) => profile.id === botId)) return null;
    return this.peerBots().find((peer) => peer.id === botId) ?? null;
  }

  /** Waiting items being set aside on a peer (committed or decided not yet): a second tap sends nothing (M5-04d). */
  private peerIgnoring = new Set<string>();

  /** `waiting.ignore` for a peer's bot, with this server as origin (scope `reply`); a failure is logged, never thrown. */
  private ignoreWaitingOn(peer: RemoteMember, text: string) {
    const remoteCommand = this.options.remoteCommand;
    const who = `${peer.name} on ${peer.serverName}`;
    const key = `${peer.id}\n${text}`;
    if (!remoteCommand || this.peerIgnoring.has(key)) return;
    if (!text || text.length > WAITING_TEXT_LIMIT) { this.log(`ignoring a waiting item of ${who} failed: the text is empty or longer than ${WAITING_TEXT_LIMIT} characters`); return; }
    let sent: ReturnType<typeof remoteCommand>;
    try { sent = remoteCommand(`bot:${peer.id}`, { type: "waiting.ignore", botId: peer.id, text }); } catch (error) { this.log(`ignoring a waiting item of ${who} failed: ${oneLine((error as Error).message)}`); return; }
    this.peerIgnoring.add(key);
    let logged = false;
    const failed = (why: string) => { this.peerIgnoring.delete(key); if (!logged) { logged = true; this.log(`ignoring a waiting item of ${who} failed: ${oneLine(why)}`); } };
    sent.committed.catch((error: unknown) => failed((error as Error).message));
    sent.outcome.then((outcome) => { if (outcome.ok) this.peerIgnoring.delete(key); else failed(outcome.why); }, (error: unknown) => failed((error as Error).message));
  }

  botRequested(...a: Parameters<CoreBots["botRequested"]>) { return this.coreBots.botRequested(...a); }

  removeBot(...a: Parameters<CoreBots["removeBot"]>) { return this.coreBots.removeBot(...a); }

  /**
   * The main bot's <open-question from="name"/> (`showOpenQuestion`): the card a project or bot already
   * shows in its own chat shows here too, a copy kept in step with it; a pick or words on it go there.
   */
  showOpenQuestion(name: string) {
    const main = this.mainBot();
    if (!main) return;
    const wanted = name.replace(/^[\t ]+|[\t ]+$/g, "").toLowerCase();
    const profile = this.profiles.find((candidate) => candidate.role !== "main" && !candidate.parent && candidate.name.toLowerCase() === wanted);
    if (!profile) { main.queueNote(`(App: There is no project or bot called "${name}"; no card was shown.)`); return; }
    const question = this.bots.get(profile.id)?.openQuestion();
    if (!question) {
      main.appNotice(`${profile.name} has no question waiting in its chat now.`, undefined, undefined, { sourceID: profile.id });
      main.queueNote(`(App: ${profile.name} has no open card, so none was shown. Do not ask its question again yourself; if it still needs the user, it asks in its own chat.)`);
      return;
    }
    const copy: string = main.appNotice(`${profile.name}: ${question.text}`, question.choices, (index) => this.pickOnCopy(copy, index), {
      onAnswer: (text, files) => this.answerOnCopy(copy, text, files), sourceID: profile.id, sourceMessageID: question.id, ...(question.questions ? { questions: question.questions } : {}),
    });
    this.copies.set(copy, { botId: profile.id, questionId: question.id });
    this.refreshWaiting();
  }

  /** Resolve copies to their original, then persist the informational disposition everywhere. */
  private ignoreQuestion(botId: string, messageId: string): { accepted: boolean } {
    let chat = this.bot(botId), record = chat.line(messageId);
    const seen = new Set<string>();
    while (record?.sourceID && record.sourceMessageID) {
      const key = `${chat.id}:${record.id}`;
      if (seen.has(key) || !isOpenQuestion(record)) return { accepted: false };
      seen.add(key);
      const source = this.bots.get(record.sourceID);
      const original = source?.line(record.sourceMessageID);
      // The bot it copies was removed (a sub bot's card relayed into its parent's chat), or its line is gone: the copy
      // is ignored where it is, never left open with nothing to settle it (spec/models/callin/RelayedCard.tla).
      if (!source || !original) break;
      chat = source;
      record = original;
    }
    if (!record) return { accepted: false };
    const result = chat.ignoreQuestion(record.id);
    if (result.accepted) this.refreshWaiting();
    return result;
  }

  /** A pick on a copy goes to the question it copies; one settled or gone meanwhile closes the copy. */
  private pickOnCopy(copy: string, index: number) {
    const source = this.copies.get(copy);
    this.copies.delete(copy);
    if (!source) return;
    let accepted = false;
    try { accepted = this.bots.get(source.botId)?.choose(source.questionId, index).accepted ?? false; } catch { /* gone */ }
    if (!accepted) this.log(`a pick on a copy of ${source.botId}'s question found it settled`);
    this.refreshWaiting();
  }

  /** Words on a copy answer the question it copies; both show the answer. */
  private answerOnCopy(copy: string, text: string, files: string[]): boolean {
    const source = this.copies.get(copy);
    const bot = source ? this.bots.get(source.botId) : undefined;
    if (!source || !bot) { this.mainBot()?.settleAppQuestion(copy, { answer: "No longer needed" }); return false; }
    let accepted = false;
    // A question group answered on its copy: the original gets the same picks (its line shows them too).
    const copyLine = this.mainBot()?.line(copy);
    const picks = copyLine?.picks && bot.line(source.questionId)?.questions ? copyLine.picks : undefined;
    try { accepted = bot.answer(source.questionId, text, files, picks).accepted; } catch { /* gone */ }
    if (!accepted && copyLine) delete copyLine.picks;
    this.copies.delete(copy);
    this.mainBot()?.settleAppQuestion(copy, accepted ? { answer: answerLabel(text, files.length) } : { answer: "No longer needed" });
    this.refreshWaiting();
    return true;
  }

  /** A bot's question was settled in its own chat: so is its copy (`closeCopies`). */
  private closeCopiesOf(botId: string, messageId: string) {
    const original = this.bots.get(botId)?.line(messageId);
    if (original?.ignoredAt) {
      const chats = [...this.bots.values()];
      for (const [copy, source] of this.copies) if (source.botId === botId && source.questionId === messageId) this.copies.delete(copy);
      for (const chat of chats) chat.syncIgnoredCopies(botId, messageId, original.ignoredAt);
      return;
    }
    for (const [copy, source] of [...this.copies]) {
      if (source.botId !== botId || source.questionId !== messageId) continue;
      const line = this.bots.get(botId)?.line(messageId);
      if (line && line.chosen == null && line.answer == null) continue;
      this.copies.delete(copy);
      this.mainBot()?.settleAppQuestion(copy, line?.chosen != null ? { chosen: line.chosen } : { answer: line?.answer ?? "No longer needed" });
    }
  }

  deliverInboxes(...a: Parameters<CorePeerInbox["deliverInboxes"]>) { return this.corePeerInbox.deliverInboxes(...a); }



  /**
   * What waits on you (`refreshWaiting`): each bot's latest open question in its own chat, else its
   * memory's "Waiting on you"; then the main bot's own questions; without what you set aside.
   */
  /**
   * M5-06c (D74): a question card from this server itself (a fetch that asks, `server/fetch/approval.ts`) in `botId`'s
   * chat (the Maintainer's). It is a normal app question: the pick comes from any device through `chat.choose`, and the
   * answer is the choice's index. It is `null` whenever there is no pick: the card is ignored, closed after a restart
   * ("No longer needed"), the core shuts down, `cancelled` settles first (the ask it belongs to is over: the card is then
   * closed "No longer needed" so nobody answers a dead question), the bot is missing or there is nothing to choose.
   * A caller must treat anything but a valid index as "no".
   */
  serverAsk(botId: string, ask: { text: string; choices: string[] }, cancelled?: Promise<void>): Promise<number | null> {
    const bot = this.bots.get(botId);
    if (!bot || this.removed.has(botId) || !ask.choices.length) return Promise.resolve(null);
    return new Promise<number | null>((resolve) => {
      let id = "";
      let settled = false;
      const finish = (index: number | null) => {
        if (settled) return;
        settled = true;
        this.serverAsks.delete(id);
        resolve(index);
      };
      id = bot.appNotice(ask.text, ask.choices.map((label) => ({ label })), (index) => finish(Number.isInteger(index) && index >= 0 && index < ask.choices.length ? index : null));
      this.serverAsks.set(id, { botId, close: finish });
      void cancelled?.then(() => {
        if (settled) return;
        // Close the card first (a pick after this finds nothing open), then end the wait.
        try { bot.settleAppQuestion(id, {}); } catch (error) { this.log(`serverAsk: closing the card failed: ${(error as Error).message}`); }
        finish(null);
      });
    });
  }

  /** A `serverAsk` card that is no longer open and was not picked: ignored (the pick, if any, reaches its own callback). */
  private serverAskClosed(messageId: string): void {
    const pending = this.serverAsks.get(messageId);
    if (!pending) return;
    const line = this.bots.get(pending.botId)?.line(messageId) ?? null;
    if (!line || (line.chosen == null && !isOpenQuestion(line))) pending.close(null);
  }

  waiting(): WaitingView {
    // When a question was asked (its line's time), for the whiteboard's "2h ago".
    const asked = (chat: Bot | null | undefined, id: string): { at?: string } => {
      const date = chat?.line(id)?.date;
      return typeof date === "number" && Number.isFinite(date) ? { at: new Date(fromSwiftDate(date)).toISOString() } : {};
    };
    const ignored = new Set(readSettingsList(readSettings(Layout.settings(this.options.dataDir)).ignoredWaiting));
    const out: WaitingView["items"] = [];
    const doing: WaitingView["doing"] = {};
    // Use the recorded choices, not a possibly unrelated opening sentence. This is only a
    // preview: the original question, recommendations and permission actions stay in chat.
    const addQuestion = (botId: string, chat: Bot | null | undefined, question: { id: string; text: string }) => {
      const legacyText = firstLine(question.text).slice(0, 400);
      // A question is set aside only by its own id (`chat.ignoreQuestion`, the line's `ignoredAt`, which `openQuestion()`
      // already skips), never by a text key: a plain item's `<botId>-<text>` key must not hide a later question whose
      // preview is that text (fu-waiting-plain-ignore).
      const line = chat?.line(question.id);
      const choices = line?.choices;
      const group = savedQuestions(line?.questions);
      // A question group: its questions, numbered (each one's options stay in the chat).
      const labels = group ? group.map((item, index) => `${index + 1}. ${(item.question || item.options.map((option) => option.label).join(" / ")).replace(/\s+/g, " ").trim()}`) : Array.isArray(choices) ? choices.flatMap((choice, index) =>
        typeof choice?.label === "string" && choice.label.trim() ? [`${index + 1}. ${choice.label.trim().replace(/\s+/g, " ")}`] : []) : [];
      // Keep a directly stated question for context (e.g. Yes / No); never infer one from prose.
      const questionLead = /[?？][*_`]*$/.test(legacyText.trim()) ? `${legacyText} — ` : "";
      const preview = labels.length ? questionLead + labels.join(" / ") : legacyText;
      const text = preview.length > 400 ? `${preview.slice(0, 399)}…` : preview;
      out.push({ botId, text, messageId: question.id, ...asked(chat, question.id) });
    };
    for (const profile of this.profiles) {
      if (profile.role === "main" || profile.parent) continue;
      // A manager's Now card: the first thing under "In progress" in its memory.md.
      if (profile.role === "manager" && !profile.problem) {
        const first = this.memoryFiles.items(join(profile.folder, profile.memoryPath), "inProgress")[0];
        if (first) doing[profile.id] = first.slice(0, 400);
      }
      const question = this.bots.get(profile.id)?.openQuestion();
      if (question) addQuestion(profile.id, this.bots.get(profile.id), question);
      else for (const item of this.memoryFiles.items(join(profile.folder, profile.memoryPath), "waitingOnYou")) out.push({ botId: profile.id, text: item.slice(0, 400), messageId: null });
    }
    for (const question of this.mainBot()?.openQuestions() ?? []) addQuestion(this.mainBotId, this.mainBot(), question);
    // M5-06c: the server's own open questions (a fetch waiting for its card). The Maintainer is a manager and its
    // `openQuestion()` sees only `role: "bot"` lines, so these app questions would be missing from the summary.
    for (const [id, pending] of this.serverAsks) {
      const chat = this.bots.get(pending.botId);
      const line = chat?.line(id);
      if (line && isOpenQuestion(line)) addQuestion(pending.botId, chat, { id, text: line.text });
    }
    const acked = [...ignored].filter((key) => key.includes("-task:")).slice(-200);
    // Text keys (`ignoredWaiting`, 1.x's `<botId>-<text>`) set aside plain items only (`messageId` null).
    return { items: out.filter((item) => item.messageId !== null || !ignored.has(`${item.botId}-${item.text}`)).slice(0, 200), doing, ...(acked.length ? { acked } : {}) };
  }

  /** A bot's memory.md sections (empty when its folder has a problem); read and parsed once per change of the file (MemoryFiles). */
  private memorySections(profile: BotProfile): MemorySections {
    const file = join(profile.folder, profile.memoryPath);
    const items = (section: keyof MemorySections) => (profile.problem ? [] : this.memoryFiles.items(file, section).slice(0, 20).map((item) => item.slice(0, 400)));
    return { currentStatus: items("currentStatus"), inProgress: items("inProgress"), decided: items("decided"), waitingOnYou: items("waitingOnYou") };
  }

  /** The links handed over in a bot's chat, newest first. */
  private resultLinks(bot: Bot, limit: number): ResultLink[] {
    return bot.results().slice(0, limit).map((result) => ({ label: result.label.slice(0, 400), url: result.url.slice(0, 4_000) }));
  }

  // ------------------------------------------------------------------------------------------
  // The workspace for plugins (`api.workspace`, plugin-extraction.md §4.3): what the whiteboard reads,
  // one method each, read only. The main bot is "main" to plugins, as in `bots.list`.

  private outId(id: string) {
    return this.isMainBotId(id) ? "main" : id;
  }

  /** The bot a plugin names, with its profile; throws when there is none. */
  private workspaceBot(botId: string): { bot: Bot; profile: BotProfile } {
    const bot = this.pluginBot(botId);
    const profile = bot ? this.profiles.find((candidate) => candidate.id === bot.id) : undefined;
    if (!bot || !profile) throw new Error("No such bot.");
    return { bot, profile };
  }

  /** Every bot (sub bots too), in the left column's order. */
  private workspaceBots(): { bot: Bot; profile: BotProfile }[] {
    return this.profiles.flatMap((profile) => {
      const bot = this.removed.has(profile.id) ? undefined : this.bots.get(profile.id);
      return bot ? [{ bot, profile }] : [];
    });
  }

  private botSummary(bot: Bot, profile: BotProfile, pinned: Set<string>): BotSummary {
    const view = bot.view();
    return {
      id: this.outId(bot.id), name: profile.name.slice(0, 200), role: profile.role, parent: profile.parent ? this.outId(profile.parent) : null,
      folder: basename(profile.folder.replace(/[\\/]+$/, "")).slice(0, 400), engine: view.heads[0] ?? "claude", busy: view.working, asleep: view.phase === "asleep",
      avatar: profile.avatar.slice(0, 40), pinned: pinned.has(bot.id),
      lastActivity: view.lastActivity ?? null, job: view.job?.slice(0, 400) ?? null, subagents: view.subagents, guest: !!view.guest, approvals: view.approvals,
      status: { key: status(view), text: statusText(view) },
      lastReply: profile.role === "main" ? bot.lines().findLast((line) => line.role === "bot" && line.text.trim())?.text.slice(0, 400) ?? null : null,
    };
  }

  /** What waits on you with plugins' bot ids. */
  private workspaceWaiting(): WaitingView {
    const view = this.waiting();
    const main = `${this.mainBotId}-`;
    return {
      items: view.items.map((item) => ({ ...item, botId: this.outId(item.botId) })),
      doing: Object.fromEntries(Object.entries(view.doing).map(([id, text]) => [this.outId(id), text])),
      ...(view.acked ? { acked: view.acked.map((key) => (this.runMainBot && key.startsWith(main) ? `main-${key.slice(main.length)}` : key)) } : {}),
    };
  }

  private workspaceSource(): WorkspaceSource {
    return {
      bots: () => {
        const pinned = new Set(settingsView(readSettings(Layout.settings(this.options.dataDir))).pinnedBots);
        return this.workspaceBots().map(({ bot, profile }) => this.botSummary(bot, profile, pinned));
      },
      memory: (botId) => this.memorySections(this.workspaceBot(botId).profile),
      // Task cards were removed in 2.5: both stay for plugins that still ask, and answer nothing.
      tasks: (botId) => { this.workspaceBot(botId); return []; },
      taskHistory: (botId) => { this.workspaceBot(botId); return []; },
      results: (botId, limit) => this.resultLinks(this.workspaceBot(botId).bot, limit),
      waiting: () => this.workspaceWaiting(),
      ignoreWaiting: (botId, text) => {
        // A bot of this machine first ("main" is the local main bot whatever a peer's rows say: `peerBotFor`), then a peer's (M5-04d).
        const peer = this.peerBotFor(botId);
        if (peer) this.ignoreWaitingOn(peer, text);
        else this.ignoreWaiting(this.workspaceBot(botId).bot.id, text);
      },
      pendingApprovals: (botId) => this.workspaceBot(botId).bot.pendingApprovals(),
      face: (botId, look) => {
        const { bot } = this.workspaceBot(botId);
        const view = bot.view();
        const waiting = view.approvals > 0 || this.waiting().items.some((item) => item.botId === bot.id);
        return botFace(view, look, { asleep: view.phase === "asleep", working: view.working, waiting });
      },
      current: () => this.currentChat(),
      agyWorkers: (sessionId) => agyWorkerList(this.agents.all, sessionId, this.options.dataDir),
    };
  }

  /** The chat the user has open in the main window, for plugins (`workspace.current`); null: none, or gone. */
  private currentChat(): CurrentChat | null {
    const shown = this.shownChat;
    const bot = shown && !this.removed.has(shown.botId) ? this.bots.get(shown.botId) : undefined;
    if (!shown || !bot) return null;
    return currentChat(shown, this.outId(bot.id), bot.view().heads[0] ?? "claude", bot.headSessions());
  }

  /** What each workspace method would answer, by bot and kind: what a change is noticed by. */
  private workspaceDigest(): WorkspaceDigest {
    const pinned = new Set(settingsView(readSettings(Layout.settings(this.options.dataDir))).pinnedBots);
    const waiting = this.workspaceWaiting();
    const out: WorkspaceDigest = {};
    for (const { bot, profile } of this.workspaceBots()) {
      const id = this.outId(bot.id);
      out[id] = {
        bots: JSON.stringify(this.botSummary(bot, profile, pinned)),
        memory: JSON.stringify(this.memorySections(profile)),
        waiting: JSON.stringify([waiting.items.filter((item) => item.botId === id), waiting.doing[id] ?? null, bot.pendingApprovals()]),
        results: JSON.stringify(this.resultLinks(bot, 100)),
      };
    }
    // Only the bot shown has a "current": a switch names the one left and the one opened.
    const current = this.currentChat();
    if (current && out[current.botId]) out[current.botId].current = JSON.stringify(current);
    return out;
  }

  /**
   * Some plugin listens for workspace changes, or none does any more (Plugins, as soon as the host says so).
   * Listening: what is there now is the start; a change is looked for soon after any event, and every 5 s.
   */
  private watchWorkspace(on: boolean) {
    if (!on) {
      this.workspaceWatch?.stop();
      if (this.workspaceTimer) { clearTimeout(this.workspaceTimer); this.workspaceTimer = null; }
      if (this.workspaceClock) { clearInterval(this.workspaceClock); this.workspaceClock = null; }
      return;
    }
    this.workspaceWatch ??= new WorkspaceWatch(this.epoch);
    try { this.workspaceWatch.start(this.workspaceDigest()); } catch (error) { this.log(`workspace: ${(error as Error).message}`); return; }
    if (!this.workspaceClock) {
      this.workspaceClock = setInterval(() => this.checkWorkspace(), 5_000);
      this.workspaceClock.unref?.();
    }
  }

  /** Looks for a workspace change within a second (once, however many events come meanwhile). */
  private checkWorkspaceSoon() {
    if (!this.workspaceWatch?.watching || this.workspaceTimer) return;
    this.workspaceTimer = setTimeout(() => { this.workspaceTimer = null; this.checkWorkspace(); }, 1_000);
    this.workspaceTimer.unref?.();
  }

  private checkWorkspace() {
    if (!this.workspaceWatch?.watching) return;
    let change;
    try { change = this.workspaceWatch.check(this.workspaceDigest()); } catch (error) { this.log(`workspace: ${(error as Error).message}`); return; }
    if (change) this.plugins.workspaceChanged(change);
  }

  /** Tells the windows when what waits on you changed (1.x's `refreshWaiting`, after anything that may change it). */
  refreshWaiting() {
    // A memory file changed, maybe: plugins watching the workspace look again.
    this.checkWorkspaceSoon();
    // Bots added or removed since: their memory files watched (or no longer).
    if (this.memoryWatch) { this.memoryWatch.sync(); this.memoryFiles.keepOnly(this.memoryTargets().map((target) => target.path)); }
    let view: WaitingView;
    try { view = this.waiting(); } catch (error) { this.log(`waiting: ${(error as Error).message}`); return; }
    const text = JSON.stringify(view);
    if (text === this.lastWaiting) return;
    this.lastWaiting = text;
    this.event({ type: "waiting.updated", waiting: view });
  }

  /** A refresh soon after a chat changed (several changes in a row make one). */
  private waitingSoon() {
    if (this.waitingTimer) return;
    this.waitingTimer = setTimeout(() => { this.waitingTimer = null; this.refreshWaiting(); }, 150);
    this.waitingTimer.unref?.();
  }

  /** Takes one off the list without answering it (settings' `ignoredWaiting`, 1.x's ids). */
  ignoreWaiting(botId: string, text: string): WaitingView {
    this.checkBot(botId);
    // A command reached this server because it owns the target (the front end sends a peer bot's command to its owner,
    // and the slot engine refuses a target that is not `bot:<botId>`), so it is never sent on to another machine (§11.2
    // step 5: no second hop). The legacy handler runs before that target check, so forwarding here would let a peer send
    // a command to a third machine as this server. A peer's item is set aside from the workspace source (M5-04d).
    // A text that is on the list only as an open question (a client that names it by its text, such as the whiteboard) is
    // set aside by the question's id, as "Ignore" on the card does: a text key would hide a later question with that preview.
    const items = this.waiting().items.filter((item) => item.botId === botId && item.text === text);
    if (items.length && items.every((item) => item.messageId !== null)) {
      for (const item of items) if (item.messageId) this.ignoreQuestion(botId, item.messageId);
      this.refreshWaiting();
      return this.waiting();
    }
    const file = Layout.settings(this.options.dataDir);
    const raw = readSettings(file);
    const ignored = readSettingsList(raw.ignoredWaiting);
    const key = `${botId}-${text}`;
    // Only the last 200: old ones are long answered or gone (1.x).
    if (!ignored.includes(key)) writeSettings(file, { ...raw, ignoredWaiting: [...ignored, key].slice(-200) });
    this.refreshWaiting();
    return this.waiting();
  }

  /**
   * peer-answer-guard: whether a peer server's `waiting.ignore{botId, text}` may go ahead here. Yes for a plain waiting
   * item (no card: `messageId` null) on the list now, never for a question or approval card or a text that is not on
   * the list. Also yes for a key that is already ignored: the owner checks the scope before the handler runs and again
   * when it stores the outcome, and by then the handler has set the item aside; a repeat of an ignore is a no-op.
   */
  peerMayIgnoreWaiting(botId: string, text: string): boolean {
    const items = this.waiting().items.filter((item) => item.botId === botId && item.text === text);
    if (items.some((item) => item.messageId === null)) return true;
    // A repeat is a no-op only while no open question has that text: a text key is never for a card (and `ignoreWaiting`
    // would set that card aside by its id).
    return !items.length && readSettingsList(readSettings(Layout.settings(this.options.dataDir)).ignoredWaiting).includes(`${botId}-${text}`);
  }

  addProject(...a: Parameters<CoreProjects["addProject"]>) { return this.coreProjects.addProject(...a); }

  private projectRequests(...a: Parameters<CoreProjects["projectRequests"]>) { return this.coreProjects.projectRequests(...a); }



  private importOnce(...a: Parameters<CoreProjects["importOnce"]>) { return this.coreProjects.importOnce(...a); }

  log(line: string) {
    this.options.log?.(line);
  }

  /** How plugins see a bot (`Workspace.info(for:)`): "main", or its id. */
  /** The bot a plugin names ("main": the main bot), unless it was taken out of the column. */
  private studioCache: StudioWorld | null = null;
  private studioNow(): StudioWorld {
    return (this.studioCache ??= studioWorld({
      // Every chat a spec can be in (`chatsWithPins`).
      chats: () => [...this.order.flatMap((id) => (this.removed.has(id) ? [] : [this.bots.get(id)!]))],
      bot: (id) => (this.removed.has(id) ? null : this.bots.get(id) ?? null),
      library: this.components.library,
      commands: this.components.commands,
      maintainer: this.maintainer,
      maintainerBot: () => this.bots.get(this.maintainerId) ?? null,
      componentBots: () => this.order.filter((id) => id !== this.maintainerId && !this.removed.has(id) && !this.isSubBot(id)).map((id) => this.bots.get(id)!),
      componentsChanged: () => this.componentsTick(),
      // Not "main" on a server that runs no main bot: its `Main (old)` keeps its own id, as in `bots.list`.
      mainId: this.runMainBot ? this.mainBotId : "",
    }));
  }

  pluginBot(botId: string): Bot | null {
    const id = botId === "main" ? (this.mainBot()?.id ?? "") : botId;
    return !id || this.removed.has(id) ? null : this.bots.get(id) ?? null;
  }

  /** The workers seen at work, so each one's end is told once (`workerDone`). */
  private readonly workersAtWork = new Set<string>();

  /** What plugins listening with `events.on` hear of a core event. */
  private pluginEvent(event: Event) {
    if (!("botId" in event)) return;
    const botId = this.outId(event.botId);
    if (event.type === "message.added" && event.message.role === "user") {
      this.plugins.event("messagePosted", { botId, role: "user", text: event.message.text, id: event.message.id });
    } else if (event.type === "turn.started") {
      this.plugins.event("turnStarted", { botId, turnId: event.turnId });
    } else if (event.type === "turn.finished") {
      if (event.status === "done" && event.text) this.plugins.event("messagePosted", { botId, role: "bot", text: event.text, id: event.messageId });
      this.plugins.event("turnFinished", { botId, ok: event.status === "done", reply: event.text });
    } else if (event.type === "subagent.updated") {
      // Keyed by the worker and its run: the copy for an agent's owner, and views sent again, are not new ends.
      const key = `${event.subagent.id}/${event.subagent.execution?.run ?? 0}`;
      if (event.subagent.status === "running") {
        if (this.workersAtWork.size < 2_000) this.workersAtWork.add(key);
      } else if (this.workersAtWork.delete(key)) {
        this.plugins.event("workerDone", { botId, workerId: event.subagent.id, status: event.subagent.status, report: event.subagent.result ?? "" });
      }
    }
  }

  private activePluginWriter(): string | null {
    if (this.settlingMaintainer) return this.maintainerId;
    const maintainer = this.bots.get(this.maintainerId);
    if (maintainer && (maintainer.view().working || maintainer.subagentsAtWork)) return this.maintainerId;
    const pluginsRoot = join(this.options.dataDir, "plugins");
    for (const bot of this.bots.values()) {
      if (bot.profile.role === "main") continue;
      const folder = bot.profile.folder;
      if (folder !== pluginsRoot && !pluginsRoot.startsWith(folder + sep) && !folder.startsWith(pluginsRoot + sep)) continue;
      if (bot.view().working || bot.subagentsAtWork) return bot.id;
    }
    return null;
  }

  botInfo(bot: Bot): BotInfo {
    return { id: this.outId(bot.id), name: bot.profile.name, role: bot.profile.role, awake: bot.awake };
  }

  /** A reply showed: plugins listening hear it; Maintainer's settles the component changes bots asked for. */
  private replied(bot: Bot, record: ChatRecord) {
    if (record.text) this.plugins.replied(this.botInfo(bot), record.text);
    if (bot.profile.parent) this.subBotReplied(bot);
    // A line of its reply that starts with @ and another bot's name calls that bot in (`receiveBotMention`).
    this.conversations.receiveBotMention(record, bot);
    // What the main bot wrote into an inbox goes to that bot now (1.x: after every main-bot reply).
    if (bot.profile.role === "main") this.deliverInboxes();
    if (bot.id === this.maintainerId) {
      this.settlingMaintainer = true;
      try { this.maintainer.settle(record); } finally { this.settlingMaintainer = false; }
      this.plugins.event("libraryChanged", {});
      // After the reply's own tags are acted on: a change from a spec panel that did not land is said there.
      setImmediate(() => setImmediate(() => { this.plugins.event("maintainerReplied", { role: record.role, text: record.text.slice(0, 2_000), running: bot.subagentsAtWork }); this.componentsTick(); }));
      this.componentsTick();
    }
  }

  /**
   * Botling 3's server: `chat.send` whose intent the server already committed, with the ids it recorded (the user's
   * line, the turn, the reply's line). Everything else is 2.x's `chat.send`.
   */
  serverSend(botId: string, text: string, options: { replyTo?: string; to?: "both" | "claude" | "codex" | "agy" }, ids: PresetTurnIds, uploads: Array<{ path: string; name: string }> = []): Promise<ResultOf<"chat.send">> {
    return this.send(botId, text, { ...options, ids }, uploads);
  }

  /**
   * Botling 3's server: the user's line of a `chat.send` it is committing (or committed before a crash), in the bot's
   * chat now (`Bot.presetUserLine`); its turn's `serverSend` later finds it by id. `time`: the line's ISO time in the log.
   */
  serverUserLine(botId: string, line: { id: string; text: string; time: string; replyTo?: string; to?: "both" | "claude" | "codex" | "agy" }): boolean {
    const ms = Date.parse(line.time);
    return this.bot(botId).presetUserLine({
      id: line.id, text: line.text, date: toSwiftDate(Number.isFinite(ms) ? ms : Date.now()),
      ...(line.replyTo ? { replyTo: line.replyTo } : {}), ...(line.to ? { to: line.to } : {}),
    });
  }

  /** Botling 3's server: a turn it recorded before a restart (a routine's run, an answer's message), started now. */
  serverTurn(botId: string, spec: Parameters<Bot["startPresetTurn"]>[0]): { turnId: string; done: Promise<TurnStatus> } {
    return this.bot(botId).startPresetTurn(spec);
  }

  /**
   * Botling 3's server (M5-02b): the guest's turn of a call-in from a bot on another server, run in the guest's own
   * session (`Bot.groupTurn`, as a 2.x call-in is) and kept in the guest's own chat afterwards (`Bot.keepCallIn`), as
   * 2.x does. `prompt` and `note` are built and cleaned by the caller (they carry peer text). `signal` ends the wait and
   * the turn (the host gave up, D51); the answer is then `failed` with why "cancelled".
   */
  async serverCallIn(guestId: string, prompt: string, call: {
    host: { botId: string; name: string }; asked: string; by: "user" | "bot"; note: string;
    busyWaitMs: number; answerMs: number; onBegin: () => void; signal?: AbortSignal;
  }): Promise<GuestAnswer> {
    const bot = this.bots.get(guestId);
    if (!bot) return { kind: "failed", why: "It is not running." };
    const askedAt = toSwiftDate();
    const answer = await bot.groupTurn(prompt, call.busyWaitMs, call.answerMs, {
      callIn: call.host.botId, asked: call.asked, ...(call.by === "user" ? { by: "user" as const } : {}), onBegin: call.onBegin, ...(call.signal ? { signal: call.signal } : {}),
    });
    if (answer.kind === "reply") {
      const line: ChatRecord = { id: newId(), role: "bot", text: answer.text, date: toSwiftDate(), steps: answer.steps, engine: answer.engine };
      bot.keepCallIn(call.note, askedAt, line);
    }
    return answer;
  }

  /** Botling 3's server: whether `botId` is one of the core's bots. */
  hasBot(botId: string): boolean {
    return this.profiles.some((profile) => profile.id === botId);
  }

  /** Botling 3's server: a bot's current view (its summary row in the server's srv: table), or null. */
  botView(bot: Bot): BotView {
    const view = bot.view();
    return bot.id === this.maintainerId ? { ...view, maintainer: true } : view;
  }

  serverBotView(botId: string): BotView | null {
    const bot = this.bots.get(botId);
    return bot ? this.botView(bot) : null;
  }

  /** Botling 3's server: the bots the core has now. */
  botIds(): string[] {
    return this.profiles.map((profile) => profile.id);
  }

  /** Botling 3's server (M6-06): re-opens plugin secrets once a window attaches and syncs the host. */
  reloadPluginSecrets(): Promise<void> {
    return this.plugins.reloadSecrets();
  }

  /** Botling 3's server: files waiting in a bot's input box (they go with the next message, even an empty one). */
  pendingFiles(botId: string): number {
    return this.pending.list(botId).length;
  }

  /** Botling 3's server: throws what `bots.remove` would refuse with (`removeBot`), before its intent is stored. */
  checkRemoveBot(id: string): void {
    this.checkBot(id);
    const profile = this.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new ContractError("not_found", "No such bot.");
    if (profile.role === "main" || id === this.mainBotId || id === this.maintainerId) throw new ContractError("forbidden", "The main bot and Maintainer cannot be removed.");
  }

  /**
   * Botling 3's server: the core-set commands it applies inside its own transaction. Synchronous, the same handlers
   * as `handle`: what they emit meanwhile is stored in that transaction, and a turn they start is kept aside by
   * `deferTurn` (the server routes it after the commit).
   */
  applyNow(cmd: ApplyNowCommand): unknown {
    if (!this.activated) throw new ContractError("conflict", "Waiting for the update boot receipt to commit. Please try again shortly.");
    switch (cmd.type) {
      case "chat.react": return this.bot(cmd.botId).react(cmd.messageId, cmd.emoji, cmd.present);
      case "chat.ignoreQuestion": return this.ignoreQuestion(cmd.botId, cmd.messageId);
      case "chat.choose": return this.calledInPick(cmd.botId, cmd.messageId, cmd.index) ?? this.bot(cmd.botId).choose(cmd.messageId, cmd.index, cmd.text);
      case "chat.answer": {
        const files = (cmd.images ?? []).flatMap((image) => writeIncoming(join(this.options.dataDir, "incoming"), image.name, image.base64) ?? []);
        try {
          if (cmd.picks) return this.calledInGroupAnswer(cmd.botId, cmd.messageId, cmd.picks, files.length) ?? this.bot(cmd.botId).answer(cmd.messageId, cmd.text, files, cmd.picks);
          return this.calledInAnswer(cmd.botId, cmd.messageId, cmd.text, files.length) ?? this.bot(cmd.botId).answer(cmd.messageId, cmd.text, files);
        } finally { for (const file of files) rmSync(file, { force: true }); }
      }
      case "component.approve": return this.bot(cmd.botId).componentApprove(cmd.messageId, cmd.index, cmd);
      case "settings.set": return this.changeSetting(cmd.change);
      case "bots.create": {
        const made = this.makeBot(cmd.name, cmd.job, { setUp: true });
        if (made.kind === "empty") throw new ContractError("bad_request", "A bot needs a name and a job.");
        if (made.kind === "taken" || made.kind === "removedByUser") throw new ContractError("conflict", `No bot was made: the name "${botName(cmd.name)}" is already used by a project or the app.`);
        return { botId: made.botId, created: made.kind === "made" };
      }
    }
  }

  /** Your message through the plugins' beforeSend hooks first; one can change it or stop it (`Workspace.send`). */
  private async send(botId: string, text: string, options: { replyTo?: string; to?: "both" | "claude" | "codex" | "agy"; ids?: PresetTurnIds }, uploads: Array<{ path: string; name: string }> = []): Promise<ResultOf<"chat.send">> {
    const bot = this.bot(botId);
    // A message to a bot in Idle brings it back to the list (the user is talking to it again).
    const idle = this.settingsNow().idleBots ?? [];
    if (idle.includes(botId.toUpperCase())) this.changeSetting({ key: "idleBots", value: idle.filter((id) => id !== botId.toUpperCase()) });
    // The files waiting in its input box go with the message (1.x sends them all).
    const files = this.pending.take(botId);
    // Botling 3 uploads (M2 step 12): the server's checked file under the name the page gave, as an incoming copy, so
    // it lands in the bot's attachments folder like a pasted file (`keep` copies it; the incoming name goes after).
    const incoming = uploads.length ? linkIncoming(join(this.options.dataDir, "incoming"), uploads) : [];
    try {
      // Picked or dropped files on disk go by their own path; the incoming copies are copied (`keep`).
      const result = await this.sendWith(bot, text, { ...options, files: [...files.map((file) => file.path), ...incoming], originals: files.filter((file) => !file.incoming).map((file) => file.path) });
      if (result.stoppedBy) this.pending.restore(botId, files);
      else this.pending.done(files);
      return result;
    } catch (error) {
      this.pending.restore(botId, files);
      throw error;
    } finally {
      for (const path of incoming) rmSync(dirname(path), { recursive: true, force: true });
    }
  }

  private async sendWith(bot: Bot, text: string, options: { replyTo?: string; to?: "both" | "claude" | "codex" | "agy"; files: string[]; originals?: string[]; ids?: PresetTurnIds }): Promise<ResultOf<"chat.send">> {
    if (!text.trim() && !options.files.length) throw new ContractError("bad_request", "Nothing to send.");
    const outcome = await this.plugins.beforeSend(this.botInfo(bot), text);
    if ("stoppedBy" in outcome) {
      const plugin = this.plugins.registry.plugin(outcome.stoppedBy);
      const name = plugin ? (plugin.manifest.displayName ?? plugin.manifest.name) : outcome.stoppedBy;
      const messageId = bot.appNotice(`Plugin "${name}" stopped this message: ${text}`);
      return { messageId, turnId: null, stoppedBy: outcome.stoppedBy };
    }
    const words = outcome.send.slice(0, 100_000) || text;
    // Bots you named with @ are called in: they answer here too, after reading the chat (`Workspace.send`).
    const called = this.conversations.calledIn(words, bot.id);
    const appNote = this.conversations.notes(bot, called, words);
    const sent = bot.send(words, { ...options, ...(appNote ? { appNote } : {}) });
    if (called.length) {
      // The line this message made (Botling 3's server: by its id, since lines sent after it may be in the chat already).
      const userId = options.ids?.userId;
      const newest = (userId ? bot.lines().find((line) => line.id === userId) : undefined) ?? bot.lines().findLast((line) => line.role === "user");
      if (newest) this.conversations.startCallIn(bot, called, newest.id, null);
    }
    specTrace("callin", "UserLine", { chat: bot.id, to: called[0]?.id ?? null, pending: this.conversations.callIns(bot.id) });
    return sent;
  }

  /** A file the chat origin may serve for this bot: one of its lines' attachments, or one waiting in its input box. */
  /** `line`: the line showing it, whose copy of the picture (as it was when the line was posted) is served when there is one. */
  private attachmentFile(botId: string, ref: string, line?: string): ResultOf<"attachment.file"> {
    const bot = this.bot(botId);
    let path: string | null = null;
    if (ref.startsWith("pending:")) path = this.pending.get(botId, ref.slice(8))?.path ?? null;
    else path = bot.attachmentPath(ref, line);
    if (!path) throw new ContractError("not_found", "No such attachment.");
    return { path, type: servedType(path) };
  }

  private settingsFile(): Record<string, unknown> | undefined {
    try {
      const value = readJSON(Layout.settings(this.options.dataDir));
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  /** settings.json as 1.x writes it (`AppSettings`): only the keys the prompts need. */
  private settings(): { language: string | undefined; results: string | undefined } {
    const value = this.settingsFile();
    return { language: value?.languageChoice as string | undefined, results: value?.resultPublishingChoice as string | undefined };
  }

  /** The app's language: settings.json's, else the system's (`AppLanguage.preferred`). */
  private language() {
    const settings = this.settings();
    return savedLanguage(settings.language) ?? preferredLanguage(this.options.languages ?? [Intl.DateTimeFormat().resolvedOptions().locale]);
  }

  /** The bot's instructions (Prompts.swift's), from its profile and the app's settings. */
  /** `workingFolder`: the app worktree the session starts in, when there is one. */
  prompts(profile: BotProfile, engine: Engine = "claude", heads: Heads | null = null, workingFolder: string | null = null): BotPrompts {
    const settings = this.settings();
    const languages = this.options.languages ?? [Intl.DateTimeFormat().resolvedOptions().locale];
    return desktopPrompts(botPrompts({
      profile: { ...profile, instructions: profile.instructions ?? null },
      language: savedLanguage(settings.language) ?? preferredLanguage(languages),
      results: isResultPublishing(settings.results) ? settings.results : "artifactUnlessSensitive",
      engine,
      heads: heads && heads.engines.length > 1 ? { handoffs: heads.handoffs, limits: heads.limits } : null,
      workingFolder: workingFolder !== profile.folder ? workingFolder : null,
      parentName: profile.parent ? this.profiles.find((candidate) => candidate.id === profile.parent)?.name ?? null : null,
    }), profile, engine, claudeWorkersMode(this.settingsFile() ?? {}) === "app", withPluginSections(this.promptSections()));
  }

  /** The prompt sections plugins give, each that names a command with that command's line and guide (none without one). */
  private promptSections() {
    const commands = this.plugins.agentCommands();
    return this.plugins.promptSections().flatMap((section) => {
      if (section.command === undefined) return [section];
      const command = commands.find((candidate) => candidate.plugin === section.plugin && candidate.id === section.command);
      const line = command ? this.options.runCommand?.(command) : null;
      return command && line ? [{ ...section, tool: { command: line, docs: command.docs ? this.commandGuide(command) : "" } }] : [];
    });
  }

  /**
   * The path bots are told for a command's guide: one that stays the same (`<data>/plugin-guides/<plugin>/…`, a link to the plugin
   * folder whose script the command runs: an override's, else the shipped one), so the prompt does not change when an override
   * comes or goes and a rebuilt guide is read by the next report a bot writes. Re-pointed each time prompts are built.
   */
  /**
   * What enabled plugins give a new head (agent-contributions.ts, engine-skills.ts): Claude's --plugin-dir folders (its parts,
   * and one made for each skill folder outside them, under `<data>/plugin-skills/claude`), the secrets' environment, the MCP
   * tools, and the skill folders Codex and Antigravity are pointed at. Skill folders go through `skillPlace`.
   */
  private agentWiring(): { dirs: string[]; env: Record<string, string>; tools: string[]; skillRoots: string[] } {
    const contributions = agentContributions(this.plugins.registry);
    const place = (plugin: string, root: string) => this.skillPlace(plugin, root);
    const own = contributions.skillRoots.filter((entry) => !entry.claude).map((entry) => ({ plugin: entry.plugin, root: place(entry.plugin, entry.root) }));
    return { ...claudeWiring(contributions, claudeSkillFolders(own, join(this.options.dataDir, "plugin-skills", "claude"))), skillRoots: skillRootsWiring(contributions, place) };
  }

  /** The path engines are told for a plugin's skill folder (engine-skills.ts `placedSkillRoot`). */
  private skillPlace(plugin: string, root: string): string {
    const command = this.plugins.agentCommands().find((candidate) => candidate.plugin === plugin && candidate.docs);
    return placedSkillRoot(root, command, join(this.options.dataDir, "plugin-guides"), this.options.pluginOverrides ?? null);
  }

  private commandGuide(command: { plugin: string; folder: string; flag: string; docs: string | null }): string {
    return commandGuidePath({ ...command, docs: command.docs! }, join(this.options.dataDir, "plugin-guides"), this.options.pluginOverrides ?? null);
  }

  event(event: Event) {
    // A removed bot (still stopping) is heard no more.
    if (this.removed.size && (("botId" in event && this.removed.has(event.botId)) || (event.type === "bot.updated" && this.removed.has(event.bot.id)))) return;
    if (event.type === "bot.updated" && event.bot.id === this.maintainerId && event.bot.maintainer !== true) {
      event = { ...event, bot: { ...event.bot, maintainer: true } };
    }
    this.options.emit({ v: PROTOCOL_VERSION, epoch: this.epoch, seq: ++this.seq, event });
    if (event.type === "message.updated" && this.serverAsks.size) this.serverAskClosed(event.message.id);
    this.pluginEvent(event);
    this.checkWorkspaceSoon();
    // An agent another bot owns: its owner's view of it follows too.
    if (event.type === "subagent.updated") {
      const record = this.agents.byHostBot(event.botId, event.subagent.id);
      if (record && isDetached(record) && !this.removed.has(record.owner.botId) && this.bots.has(record.owner.botId)) {
        this.event({ ...event, botId: record.owner.botId, subagent: { ...event.subagent, owner: this.agentBotName(record.owner.botId).slice(0, 200), host: this.agentBotName(record.host.botId).slice(0, 200) } });
      }
    }
    // A sub bot's row under its project bot follows it (working or not, unread).
    if (event.type === "bot.updated" && event.bot.parent) this.bots.get(event.bot.parent)?.refresh();
    if (this.changeListeners.size) {
      const botId = event.type === "bot.updated" ? event.bot.id : "botId" in event ? event.botId : undefined;
      for (const listener of [...this.changeListeners]) { try { listener(botId === undefined ? {} : { botId }); } catch { /* a listener never stops the core */ } }
    }
    // An owner's turn with an agent's report began: that report is delivered.
    if (event.type === "turn.started") {
      this.reportStarts?.add(event.turnId);
      const report = this.reportTurns.get(event.turnId);
      if (report) { this.reportTurns.delete(event.turnId); this.agents.reportDelivered(report.agentId, report.run); }
    }
    // A question copied into the main bot's chat was settled in its own: so is the copy.
    if (event.type === "message.updated" && (this.copies.size || event.message.ignoredAt)) this.closeCopiesOf(event.botId, event.message.id);
    // A called-in bot's question relayed into the chat that called it was answered in its own: so is the copy there.
    if (event.type === "message.updated") this.closeRelayedCopies(event.botId, event.message.id);
    // A question asked or answered, a bot added: what waits on you may have changed.
    if (event.type === "message.added" || event.type === "message.updated" || event.type === "message.removed" || event.type === "bot.updated") this.waitingSoon();
  }

  private changeListeners = new Set<(change: { botId?: string }) => void>();
  /** The phone bridge's event stream: told that something changed (and in which bot), never what. */
  onChange(listener: (change: { botId?: string }) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  private mobileDesk: MobileDesk | null = null;
  /** Called once by the bridge's start when the phone connection is configured (mobile-bridge/start.ts). */
  attachMobile(desk: MobileDesk) { this.mobileDesk = desk; }
  private mobileOr(): MobileDesk { if (!this.mobileDesk) throw new Error("The phone connection is not set up."); return this.mobileDesk; }
  private relay: RelayConnector | null = null;
  /** Called once at startup (mobile-relay/start.ts): the end-to-end encrypted relay, off until Settings › Phone gives it an address. */
  attachRelay(relay: RelayConnector) { this.relay = relay; }
  /** Settings › Phone: the bridge's routes and phones, plus the relay and the phones paired through it. */
  private mobileView() {
    const view = this.mobileDesk ? this.mobileDesk.view() : MOBILE_OFF;
    if (!this.relay) return view;
    const relayed = this.relay.devices().map(({ id, label, pairedAt, expiresAt, botIds }) => ({ id, label: label ?? "", pairedAt, expiresAt, botIds: [...botIds], via: "relay" as const }));
    return { ...view, devices: [...view.devices.map((device) => ({ ...device, via: "bridge" as const })), ...relayed].sort((a, b) => b.pairedAt - a.pairedAt), relay: this.relay.view() };
  }

  /** Settings › Machines (remote/service.ts); off when this app runs no remote workers (tests, probes). */
  private machinesView(): MachinesView {
    return this.options.remoteWorkers?.view() ?? { enabled: false, relay: { url: null, state: "off" }, machines: [] };
  }
  private machinesOr() {
    const remote = this.options.remoteWorkers;
    if (!remote) throw new ContractError("conflict", "Workers on other machines are not available here.");
    return remote;
  }

  /** Private mobile transport: the guard and handle's synchronous send prefix share this loop. */
  mobileCommand(raw: unknown, allowedBots: readonly string[]) {
    return mobileCommand({
      pending: botId => this.pending.views(botId),
      snapshot: botId => this.snapshot(botId),
      history: command => this.bot(command.botId).history(command.before, command.bytes, command.until),
      handle: command => this.handle(command, new AbortController().signal),
    }, raw, allowedBots);
  }

  /** Handles one message from main. Exactly one response per request id, cancelled or not. */
  receive(raw: unknown) {
    const parsed = parseInbound(raw);
    if (!parsed.ok) {
      this.log(`refused: ${parsed.error.code} ${parsed.error.message}`);
      if (parsed.id) this.options.emit(errorResponse(parsed.id, parsed.error));
      return;
    }
    const message = parsed.value;
    if ("cancel" in message) {
      this.inflight.get(message.cancel)?.abort();
      return;
    }
    if (this.inflight.has(message.id)) {
      this.options.emit(errorResponse(message.id, { code: "conflict", message: "A request with this id is already running." }));
      return;
    }
    const controller = new AbortController();
    this.inflight.set(message.id, controller);
    const cancelled = new Promise<never>((_, reject) =>
      controller.signal.addEventListener("abort", () => reject(new ContractError("cancelled", "The request was cancelled."))),
    );
    cancelled.catch(() => {});
    Promise.resolve()
      .then(() => Promise.race([this.handle(message.cmd, controller.signal), cancelled]))
      .then((result) => this.options.emit(okResponse(message.id, result)))
      .catch((error) => {
        const wire = error instanceof ContractError ? error.toWire() : { code: "internal" as const, message: String((error as Error)?.message ?? error) };
        if (wire.code === "internal") this.log(`internal error: ${(error as Error)?.stack ?? error}`);
        this.options.emit(errorResponse(message.id, wire));
      })
      .finally(() => this.inflight.delete(message.id));
  }

  /** Your pick on a called-in bot's line goes back to it (`answerCallIn`); null: not such a line. */
  private calledInPick(botId: string, messageId: string, index: number): { accepted: boolean } | null {
    const chat = this.bot(botId);
    const record = chat.line(messageId);
    if (!record || !this.conversations.isCalledIn(record, chat.id)) return null;
    const label = record.choices?.[index]?.label;
    if (!isOpenQuestion(record) || label === undefined) return { accepted: false };
    const relayed = this.answerRelayedCopy(chat, record, label, { chosen: index });
    if (relayed) return relayed;
    return this.answerGuestLine(chat, record, pickedNote(label), label, { chosen: index });
  }

  /** Your words on a called-in bot's question go back to it. */
  private calledInAnswer(botId: string, messageId: string, text: string, files: number): { accepted: boolean } | null {
    const chat = this.bot(botId);
    const record = chat.line(messageId);
    if (!record || !this.conversations.isCalledIn(record, chat.id) || !record.choices?.length) return null;
    const shown = answerLabel(text.trim(), files);
    if (!shown || !isOpenQuestion(record)) return { accepted: false };
    const relayed = this.answerRelayedCopy(chat, record, text.trim() || shown, { answer: shown });
    if (relayed) return relayed;
    return this.answerGuestLine(chat, record, answeredNote(shown), text.trim() || shown, { answer: shown });
  }

  /**
   * Your answer on a called-in bot's line in this chat (its guest line, `isCalledIn`) goes back to it, and counts once it
   * gets there (spec/models/callin/RelayedCard.tla): free, it answers here (a call-in, as when you named it); at work, the
   * answer goes into its own chat, read into its turn under way or waiting for it to end. Meanwhile the card shows the
   * answer "Queued"; if it never gets there (taken back, the bot stopped or removed), the card is open again and says so.
   */
  private answerGuestLine(chat: Bot, record: ChatRecord, note: string, words: string, outcome: { chosen?: number; answer?: string }): { accepted: boolean } {
    const guest = typeof record.sourceID === "string" ? this.bots.get(record.sourceID) : undefined;
    if (!guest || !this.conversations.callable(chat.id).some((member) => member.id === guest.id)) {
      chat.settleAppQuestion(record.id, { answer: NO_LONGER_NEEDED });
      return { accepted: false };
    }
    if (!chat.holdCardAnswer(record.id, outcome, guest.profile.name)) return { accepted: false };
    const told = (delivered: boolean) => {
      chat.releaseCardAnswer(record.id, delivered);
      // A relayed copy of the user's call-in (`callInBy`): the card it copies shows the answer too.
      if (delivered) this.settleRelayedOriginal(record, outcome);
    };
    const intoItsChat = () => {
      try { guest.send(words, { appNote: guestCardAnswerNote(chat.profile.name), onDelivery: told }); } catch { told(false); }
    };
    if (guest.takesGuest && !this.conversations.callIns(chat.id).length) {
      this.conversations.answerCallIn(chat, record, note, { began: () => told(true), busy: intoItsChat, failed: () => told(false) });
    } else intoItsChat();
    return { accepted: true };
  }

  /**
   * A called-in bot's question relayed into the chat of the bot that called it (`callInFollowUp`: the copy names it
   * with `sourceMessageID`) answered there: received where it was given. The answer is your message to this chat's own
   * bot (it asked on your behalf and carries the work on), and the card it copies shows the answer in the called-in
   * bot's chat; that bot is not woken, so two bots never act on one answer: the caller tells it with @ when needed.
   * null: not such a copy, or a copy of a call-in the user made (`callInBy`): this chat's bot did not ask, so the answer
   * goes to the called bot like its guest line's (answerGuestLine), and its own card shows it once it gets there.
   */
  private answerRelayedCopy(chat: Bot, copy: ChatRecord, words: string, outcome: { chosen?: number; answer?: string }): { accepted: boolean } | null {
    if (copy.role !== "bot" || typeof copy.sourceID !== "string" || typeof copy.sourceMessageID !== "string" || copy.callInBy === "user") return null;
    const name = this.bots.get(copy.sourceID)?.profile.name ?? "the bot you called in";
    chat.send(words, { replyTo: copy.id, appNote: relayedAnswerNote(name) });
    chat.settleAppQuestion(copy.id, outcome);
    this.settleRelayedOriginal(copy, outcome);
    return { accepted: true };
  }

  /**
   * A called-in bot's question relayed into another chat (`callInFollowUp`: the copy names it with `sourceMessageID`)
   * was answered on the copy: the answer went to that bot with the call-in, so its own card only shows it.
   */
  private settleRelayedOriginal(copy: ChatRecord, outcome: { chosen?: number; answer?: string }) {
    if (copy.role !== "bot" || typeof copy.sourceID !== "string" || typeof copy.sourceMessageID !== "string") return;
    const source = this.bots.get(copy.sourceID);
    const original = source?.line(copy.sourceMessageID);
    if (!source || !original || !isOpenQuestion(original)) return;
    if (copy.picks && original.questions) original.picks = copy.picks;
    source.settleAppQuestion(original.id, outcome);
  }

  /** A called-in bot answered in its own chat on a question relayed into other chats: every open copy shows the answer. */
  private closeRelayedCopies(botId: string, messageId: string) {
    const original = this.bots.get(botId)?.line(messageId);
    if (!original || original.role !== "bot" || original.sourceMessageID || isOpenQuestion(original) || original.ignoredAt
      || !(original.choices?.length || original.questions?.length)) return;
    for (const chat of this.bots.values()) {
      if (chat.id === botId) continue;
      for (const copy of chat.lines()) {
        if (copy.role !== "bot" || copy.sourceID !== botId || copy.sourceMessageID !== messageId || !isOpenQuestion(copy)) continue;
        if (original.picks && copy.questions) copy.picks = original.picks;
        chat.settleAppQuestion(copy.id, original.chosen != null ? { chosen: original.chosen } : { answer: original.answer ?? NO_LONGER_NEEDED });
      }
    }
  }

  /** A called-in bot's question group answered together: its one answer message goes to that bot, as words would. */
  private calledInGroupAnswer(botId: string, messageId: string, picks: QuestionPick[], files: number): { accepted: boolean } | null {
    const record = this.bot(botId).line(messageId);
    if (!record || !this.conversations.isCalledIn(record, botId)) return null;
    const questions = savedQuestions(record.questions);
    const clean = questions ? validPicks(questions, picks) : null;
    if (!questions || !clean) throw new ContractError("bad_request", "Those answers do not fit the questions.");
    if (!isOpenQuestion(record)) return { accepted: false };
    record.picks = clean;
    const result = this.calledInAnswer(botId, messageId, answerMessage(questions, clean), files);
    if (!result?.accepted && isOpenQuestion(record)) delete record.picks;
    return result;
  }

  bot(id: string): Bot {
    if (id === "main") {
      const main = this.mainBot();
      if (!main) throw new ContractError("not_found", this.noMainBotMessage());
      return main;
    }
    const bot = this.bots.get(id);
    if (!bot) throw new ContractError("not_found", "No such bot.");
    return bot;
  }

  private async handle(cmd: Command, signal: AbortSignal): Promise<unknown> {
    if (!this.activated && !new Set<string>(["boot.commit", "chat.snapshot", "settings.get", "plugins.list", "plugins.web", "plugins.file", "results.list", "waiting.list", "bot.settings", "usage.view", "doctor.view", "attachment.file", "card.image", "link.authorize", "chat.shown"]).has(cmd.type)) {
      throw new ContractError("conflict", "Waiting for the update boot receipt to commit. Please try again shortly.");
    }
    switch (cmd.type) {
      case "boot.commit": { const first = !this.activated; this.activate(); if (first) this.event({type:"plugins.updated",plugins:this.plugins.view()}); return {}; }
      case "chat.snapshot": {
        const delay = this.options.firstSnapshotDelayMs ?? 0;
        if (delay > 0 && !this.snapshotHeld) {
          this.snapshotHeld = true;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        return this.snapshot(cmd.botId);
      }
      case "chat.send":
        // Files named by their hash are uploads to a Botling 3 server (M2 step 12); the 2.x app has none.
        if (cmd.files) throw new ContractError("bad_request", "Files named by their hash are taken only by the Botling 3 server.");
        return this.send(cmd.botId, cmd.text, { replyTo: cmd.replyTo, to: cmd.to });
      case "plugins.list": return this.plugins.view();
      case "plugins.enable": return this.plugins.setEnabled(cmd.name, cmd.enabled);
      case "plugins.store": return cmd.refresh ? await this.pluginStore.refresh() : this.pluginStore.view();
      case "plugins.storeInstall": return await this.pluginStore.install(cmd.name);
      case "plugins.storeDismiss": return this.pluginStore.dismiss(cmd.name);
      case "plugins.revert": { const problem = this.maintainer.revertPlugin(cmd.name); if (problem) throw new ContractError("conflict", problem); return this.plugins.view(); }
      case "plugins.remove": { const problem = this.maintainer.removePlugin(cmd.name); if (problem) throw new ContractError("conflict", problem); return this.plugins.view(); }
      case "plugins.setting": return this.plugins.setSetting(cmd.name, cmd.key, cmd.value);
      case "plugins.secret": return this.plugins.setSecret(cmd.name, cmd.key, cmd.value);
      case "plugins.command": return { result: await this.plugins.command(cmd.id, cmd.from, cmd.name, cmd.args) ?? null };
      case "plugins.linkCommand": {
        // A chat attachment's link (the chat origin's URL) stands for its file; the link must be in that bot or user line.
        const url = attachmentLinkFile(cmd.url, cmd.botId) ?? cmd.url;
        const line = this.bot(cmd.botId).lines().find((candidate) => candidate.id === cmd.messageId);
        if (!line || (line.role !== "bot" && line.role !== "user") || !lineHasLink(line, url)) throw new ContractError("not_found", "That link is not in that message.");
        return { result: await this.plugins.linkCommand(cmd.id, { botId: cmd.botId, messageId: cmd.messageId, url }) ?? null };
      }
      case "plugins.tabCommand": return { result: await this.plugins.tabCommand(cmd.id, { botId: cmd.botId, tabId: cmd.tabId, url: cmd.url }) ?? null };
      case "plugins.panel": return this.plugins.panel(cmd.name, cmd.panel);
      case "plugins.call": return { result: await this.plugins.call(cmd.name, cmd.method, cmd.params, cmd.from) ?? null };
      case "plugins.approvalAsk": return this.plugins.approvalAsk(cmd.name, cmd.botId, cmd.command, cmd.folder, cmd.card, cmd.component, cmd.detail, cmd.from);
      case "plugins.approve": return this.plugins.approve(cmd.name, cmd.botId, cmd.command, cmd.folder, cmd.component, cmd.detail);
      case "plugins.tileImages": return this.plugins.tileImages(cmd.name, cmd.botId, cmd.data);
      case "plugins.noteSnapshot": return this.plugins.noteSnapshot(cmd.name, cmd.botId, cmd.picture);
      case "plugins.linkTarget": return this.plugins.linkTarget(cmd.name, cmd.botId, cmd.href);
      case "plugins.web": return { specs: this.activated ? this.plugins.webSpecs() : [] };
      case "settings.get": return this.settingsNow();
      case "agy.runtime.install": {
        if (process.env.BOTLING_AGY_ACP_PATH) throw new Error('BOTLING_AGY_ACP_PATH overrides saved settings. Remove it and restart Botling before installing from Doctor.');
        const path = await this.agyInstaller.install(this.options.dataDir);
        this.changeSetting({ key: 'agyAcpPath', value: path });
        return this.doctor.run(false);
      }
      case "agy.runtime.check": return agyRuntimeStatus(readSettings(Layout.settings(this.options.dataDir)), this.options.dataDir);
      case "projects.add": return this.addProject(cmd.folder);
      case "bots.create": {
        const made = this.makeBot(cmd.name, cmd.job, { setUp: true });
        if (made.kind === "empty") throw new ContractError("bad_request", "A bot needs a name and a job.");
        if (made.kind === "taken" || made.kind === "removedByUser") throw new ContractError("conflict", `No bot was made: the name "${botName(cmd.name)}" is already used by a project or the app.`);
        return { botId: made.botId, created: made.kind === "made" };
      }
      case "bots.remove": return this.removeBot(cmd.botId);
      case "subagent.settle": return this.bot(cmd.botId).settleSubagent(cmd.subagentId, cmd.settled);
      case "link.authorize": {
        const lines=this.bot(cmd.botId).lines();
        const context=cmd.messageId?lines.find(line=>line.id===cmd.messageId):null;
        const pin=cmd.pinId?await this.pinOwner(cmd.botId,cmd.pinId,null):null;
        if(cmd.pinId&&(!pin||typeof pin.linkAuthor!=="string"))return {result:false,linked:false};
        // A component inherits its own reply's author, never a guest's links merely because they
        // appear in the same host/group chat. Notices can echo user text and grant no authority.
        if(cmd.messageId&&(!context||context.role!=="bot"))return {result:false,linked:false};
        // Automatically generated preview frames come from Markdown, without stored displays.
        const author=(line:typeof lines[number])=>typeof line.sourceID==='string'?line.sourceID.toUpperCase():cmd.botId;
        const owner=pin?String(pin.linkAuthor).toUpperCase():context?author(context):cmd.botId;
        const same=(url:string)=>url===cmd.url||(filePath(url)!==null&&filePath(url)===filePath(cmd.url));
        let result=false,linked=false;
        for(const line of lines){
          if(line.role!=="bot"&&!(cmd.source==="user"&&line.role==="notice"))continue;
          const match=[...line.text.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)].some(value=>same(value[1]!));
          const shown=line.displays?.some(display=>display.name===PAGE_COMPONENT&&same(pageInCard(display.data)??""));
          if(match||shown){if(line.role==="bot")result=true;if(cmd.source==="user"||line.role==="bot"&&author(line)===owner)linked=true;}
        }
        // A card's picture in the lightbox (its Open in Preview / Show in Finder): exactly the file its token
        // stands for, a picture some component's data named (what the chat origin's card-image route serves).
        if(cmd.cardImage&&this.components.images.covers(cmd.cardImage,cmd.url)){result=true;linked=true;}
        // A file attached in this chat (yours, a relayed report's, a reply's): the app copied it into
        // the bot's folder and the chat shows it, so your click on it opens it (a component's does not).
        if(cmd.source==="user"&&!cmd.messageId&&!cmd.pinId&&lines.some(line=>line.attachments?.some(file=>typeof file?.url==="string"&&same(file.url))))linked=true;
        return {result,linked};
      }
      case "results.list": return { results: this.bot(cmd.botId).results().slice(0, 200) };
      case "storage.list": {
        const bot = this.bot(cmd.botId);
        const artifacts = bot.profile.folder ? profilePaths(bot.profile).artifacts : null;
        return { items: storageItems(artifacts, this.storage.refs(cmd.botId), bot.linkedFiles()), artifacts };
      }
      // Main checked the paths are files (main.ts storageAdd).
      case "storage.add": this.bot(cmd.botId); return { added: this.storage.add(cmd.botId, cmd.paths) };
      case "storage.remove": this.bot(cmd.botId); return { removed: this.storage.remove(cmd.botId, cmd.id) };
      case "waiting.list": return this.waiting();
      case "waiting.ignore": return this.ignoreWaiting(cmd.botId, cmd.text);
      case "settings.set": return this.changeSetting(cmd.change);
      case "engineDefaults.applyAll": return this.applyEngineDefaultsToAll();
      case "bot.settings": return this.bot(cmd.botId).settingsView();
      case "mobile.view": return this.mobileView();
      case "mobile.pair": {
        // No list: every bot (`*`, resolved on each request), so a bot made later is on the phone too.
        const botIds = cmd.botIds ?? [ALL_BOTS];
        if (cmd.botIds?.some((id) => id === "main" && !this.mainBot())) throw new ContractError("not_found", this.noMainBotMessage());
        if (cmd.botIds?.some((id) => !this.bots.has(id))) throw new Error("Unknown bot.");
        if (cmd.relay) {
          if (!this.relay) throw new Error("The phone relay is not available.");
          const offer = await this.relay.pair(botIds);
          return { ...offer, route: { kind: "relay" as const, origin: new URL(offer.url).origin } };
        }
        return this.mobileOr().pair(botIds, cmd.route);
      }
      case "mobile.revoke": {
        if (!this.mobileDesk && !this.relay) throw new Error("The phone connection is not set up.");
        this.mobileDesk?.revoke(cmd.deviceId);
        await this.relay?.revoke(cmd.deviceId);
        return this.mobileView();
      }
      case "mobile.relay": {
        if (!this.relay) throw new Error("The phone relay is not available.");
        await this.relay.setURL(cmd.url);
        return this.mobileView();
      }
      // Botling 3's first pairing and code check (botlingd answers them itself); the 2.x renderer never sends them.
      case "mobile.cluster":
      case "mobile.confirm": throw new ContractError("conflict", "This is a Botling 3 pairing request.");
      case "machines.view": return this.machinesView();
      case "machines.hosts": return { hosts: this.machinesOr().sshHosts().slice(0, 500) };
      case "machines.add": {
        const name = cmd.name?.trim() || undefined;
        if (name && !MACHINE_NAME.test(name)) throw new ContractError("bad_request", "A machine's name is letters, digits, and . _ @ - (up to 64).");
        await this.machinesOr().addSsh(cmd.host.trim(), name ?? machineNameFrom(cmd.host.trim()));
        return this.machinesView();
      }
      case "machines.pair": {
        const { command, expiresAt } = await this.machinesOr().pairRelay();
        return { command, expiresAt };
      }
      case "machines.approve": {
        const remote = this.machinesOr();
        const machine = remote.machines.get(cmd.id);
        if (!machine) throw new ContractError("not_found", "No such machine.");
        if (machine.via === "relay") {
          if (!cmd.code?.trim()) throw new ContractError("bad_request", "Type the code the machine shows.");
          await remote.approveRelay(cmd.id, cmd.code);
        } else await remote.approveSsh(cmd.id);
        return this.machinesView();
      }
      case "machines.decline": await this.machinesOr().decline(cmd.id); return this.machinesView();
      case "machines.revoke": this.machinesOr().revoke(cmd.id); return this.machinesView();
      case "machines.remove": this.machinesOr().remove(cmd.id); return this.machinesView();
      case "machines.check": {
        // What the check found (or why it failed) is in the machine's info.
        try { await this.machinesOr().check(cmd.id); } catch (error) { if (!this.machinesOr().machines.get(cmd.id)?.info?.error) throw error; }
        return this.machinesView();
      }
      case "bot.configure": {
        const { type: _type, botId, ...change } = cmd;
        return this.bot(botId).configure(change);
      }
      case "bot.restart": return this.bot(cmd.botId).restartNow();
      case "files.add": this.bot(cmd.botId); return { files: this.pending.addPaths(cmd.botId, cmd.paths) };
      case "files.data": this.bot(cmd.botId); return { files: await this.pending.addData(cmd.botId, cmd.name, cmd.base64) };
      case "files.remove": this.checkBot(cmd.botId); return { files: this.pending.remove(cmd.botId, cmd.id) };
      case "project.files": {
        this.bot(cmd.botId);
        const profile = this.profiles.find(p => p.id === cmd.botId);
        if (!profile) throw new ContractError("not_found", "No project.");
        return this.projectFiles.search(profile.folder, cmd.query);
      }
      case "project.preview": {
        this.bot(cmd.botId);
        const profile = this.profiles.find(p => p.id === cmd.botId);
        if (!profile) throw new ContractError("not_found", "No project.");
        return this.projectFiles.preview(profile.folder, cmd.path);
      }
      case "attachment.file": return this.attachmentFile(cmd.botId, cmd.ref, cmd.line);
      case "plugins.loaded": this.plugins.webLoaded(cmd.name); return {};
      case "plugins.failed": this.plugins.webFailed(cmd.name, cmd.message); return {};
      case "plugins.notice": this.plugins.webNotice(cmd.name, cmd.text); return {};
      case "plugins.file": return this.plugins.webFile(cmd.name, cmd.path);
      case "heads.set": return this.bot(cmd.botId).setHeads(cmd.engines);
      case "usage.view": if (!cmd.localOnly) await this.usage.refresh(); return usageView(this.usage.view(), cmd.localOnly);
      case "doctor.view": return this.doctor.view();
      case "doctor.run": return this.doctor.run(cmd.includeLatest);
      case "heads.answerWith": return this.bot(cmd.botId).setAnswerWith(cmd.to);
      case "handoff.stop": return this.bot(cmd.botId).stopHandoff(cmd.handoffId);
      case "rounds.stop": return this.bot(cmd.botId).stopRounds();
      case "chat.ignoreQuestion": return this.ignoreQuestion(cmd.botId, cmd.messageId);
      case "chat.choose": return this.calledInPick(cmd.botId, cmd.messageId, cmd.index) ?? this.bot(cmd.botId).choose(cmd.messageId, cmd.index, cmd.text);
      case "chat.answer": {
        // A component's pictures: written to incoming/, kept by the bot with the answer, then removed.
        const files = (cmd.images ?? []).flatMap((image) => writeIncoming(join(this.options.dataDir, "incoming"), image.name, image.base64) ?? []);
        try {
          if (cmd.picks) return this.calledInGroupAnswer(cmd.botId, cmd.messageId, cmd.picks, files.length) ?? this.bot(cmd.botId).answer(cmd.messageId, cmd.text, files, cmd.picks);
          return this.calledInAnswer(cmd.botId, cmd.messageId, cmd.text, files.length) ?? this.bot(cmd.botId).answer(cmd.messageId, cmd.text, files);
        } finally { for (const file of files) rmSync(file, { force: true }); }
      }
      case "chat.react": return this.bot(cmd.botId).react(cmd.messageId, cmd.emoji, cmd.present);
      case "chat.history": return this.bot(cmd.botId).history(cmd.before, cmd.bytes, cmd.until);
      case "task.output": return this.bot(cmd.botId).taskOutput(cmd.messageId, cmd.taskId);
      case "subagent.view": return this.agentView(cmd.botId, cmd.subagentId);
      case "worker.cwd": {
        this.checkBot(cmd.botId);
        // Where the worker runs: its host bot's session folder (a worktree when one is set), else that bot's own folder.
        const record = this.agents.byHostBot(cmd.botId, cmd.subagentId) ?? this.agents.movedIn(cmd.botId).find((candidate) => candidate.nativeId === cmd.subagentId);
        const hostId = record?.host.botId ?? cmd.botId;
        const profile = this.profiles.find((candidate) => candidate.id === hostId);
        return { cwd: this.plugins.sessionFolder(hostId)?.cwd ?? record?.host.folder ?? profile?.folder ?? null };
      }
      case "agent.targets": return this.agentTargets(cmd.botId, cmd.subagentId);
      case "agent.move": return this.moveAgent(cmd.botId, cmd.subagentId, cmd.to, { notifyAgent: cmd.notifyAgent === true });
      case "agent.message": return this.agentMessageCommand(cmd.botId, cmd.subagentId, cmd.text);
      case "agent.stop": return this.agentStopCommand(cmd.botId, cmd.subagentId);
      case "agent.group": return this.groupAgents(cmd.botId, cmd.subagentIds, { kind: "newSubBot", name: cmd.name, ...(cmd.note ? { note: cmd.note } : {}) });
      case "subbot.close": return this.closeSubBot(cmd.botId);
      case "chat.shown": {
        if (cmd.botId) this.checkBot(cmd.botId);
        // The main window says what it shows; plugins watching the workspace hear it (kind "current").
        this.shownChat = cmd.botId ? { botId: cmd.botId, view: cmd.view, tab: cmd.tab } : null;
        this.checkWorkspaceSoon();
        return { shown: true };
      }
      case "chat.read": {
        // You read it up to its newest line: plugins hear how much was unread before (`chatRead`).
        const bot = this.bot(cmd.botId);
        this.plugins.event("chatRead", { botId: this.outId(bot.id), ...bot.readMark() });
        return bot.read();
      }
      case "component.command": return this.bot(cmd.botId).componentCommand(cmd.messageId, cmd.index, cmd);
      case "component.approve": return this.bot(cmd.botId).componentApprove(cmd.messageId, cmd.index, cmd);
      case "component.detail": return this.bot(cmd.botId).componentDetail(cmd.name, cmd.folder, cmd.values, cmd.card, cmd.command);
      case "component.save": return this.bot(cmd.botId).componentSave(cmd.messageId, cmd.index, cmd.data);
      case "component.report": return { sent: await this.reportComponent(cmd) };
      case "chat.feedback": {
        const incoming = join(this.options.dataDir, "incoming");
        const pictures = cmd.images.flatMap((image) => writeIncoming(incoming, image.name, image.base64) ?? []);
        const shot = cmd.screenshot ? writeIncoming(incoming, "feedback.png", cmd.screenshot) : null;
        try { return { sent: this.reportFeedback(cmd.text, cmd.messageId, this.bot(cmd.botId), shot, pictures) }; }
        finally { for (const file of [...pictures, ...(shot ? [shot] : [])]) rmSync(file, { force: true }); }
      }
      case "engine.models": {
        const bot = this.bot(cmd.botId);
        return this.options.engineModels?.(cmd.engine, bot.profile) ?? discoveryFailure(cmd.engine, "unsupported", "Model discovery is unavailable in this runtime.");
      }
      case "codex.models": return { models: ((await this.options.codexModels?.()) ?? []).slice(0, 200).map((model) => ({ id: model.id.slice(0, 200), name: model.name.slice(0, 200), isDefault: model.isDefault, efforts: model.efforts?.slice(0, 10) ?? null })) };
      case "component.revert": {
        const problem = this.components.library.revert(cmd.name);
        if (problem) this.mainBot()?.appNotice(`Couldn't revert component "${cmd.name}": ${problem}`);
        this.componentsTick();
        return { reverted: !problem, problem };
      }
      case "card.image": {
        const file = this.components.images.file(cmd.token);
        if (!file) throw new ContractError("not_found", "No such picture.");
        return file satisfies ResultOf<"card.image">;
      }
      case "turn.stop": return this.bot(cmd.botId).stop(cmd.turnId);
      case "turn.await": return this.bot(cmd.botId).await(cmd.turnId, signal);
      case "routines.list": return this.bot(cmd.botId).routinesView();
      case "routines.change": {
        const { type: _type, botId: _bot, requestId, ...rest } = cmd;
        return this.bot(cmd.botId).changeRoutine({ ...rest, ...(requestId ? { request_id: requestId } : {}) });
      }
      // M5-01: call-ins between servers are Botling 3's server only; the 2.x core never takes them.
      case "callin.ask":
      case "callin.reply":
      case "callin.cancel":
        throw new ContractError("bad_request", "Botling 3 only.");
      default: throw new ContractError("not_found", `The core does not handle ${cmd.type}.`);
    }
  }

  snapshot(botId?: string): ResultOf<"chat.snapshot"> {
    const bot = botId === undefined ? this.mainBot() : this.bot(botId);
    const views = this.order.map((id) => this.botView(this.bots.get(id)!));
    return {
      epoch: this.epoch,
      seq: this.seq,
      bots: views,
      imported: this.imported,
      chat: bot ? { ...bot.snapshot(), decorations: this.plugins.decorations(bot.id), pluginData: this.plugins.chatData(bot.id), pendingFiles: this.pending.views(bot.id) } : null,
      components: this.componentInfos(),
      plugins: this.plugins.view(),
      settings: this.settingsNow(),
      doctor: this.doctor.view(),
      waiting: this.waiting(),
    };
  }

  private settingsNow(): SettingsView {
    return { ...settingsView(readSettings(Layout.settings(this.options.dataDir)), this.language()), agyPermissionSessions: agyPermissionSessions(),
      claudeAutoCompactWindow: claudeAutoCompactWindow(), codexConfigFile: codexConfigFile() };
  }

  /**
   * "Apply to all bots" (the Settings page asked first; the command carries `confirmed`): every bot's engines, models,
   * effort and primary become the app's defaults. One that cannot (read-only, an engine that is not available) is listed, the rest go on.
   */
  private async applyEngineDefaultsToAll(): Promise<ResultOf<"engineDefaults.applyAll">> {
    const choices = botChoicesFromDefaults(engineDefaultsFor(readSettings(Layout.settings(this.options.dataDir))));
    const failed: { botId: string; name: string; reason: string }[] = [];
    let applied = 0;
    for (const [botId, bot] of [...this.bots]) {
      try { await bot.applyEngineChoices(choices); applied += 1; }
      catch (error) { failed.push({ botId, name: bot.profile.name, reason: String((error as Error)?.message ?? error).slice(0, 300) }); }
    }
    this.log(`engine defaults applied to ${applied} bots, ${failed.length} failed`);
    return { applied, failed };
  }

  /** One change on the Settings page: saved in settings.json (other keys kept), then told to every window. */
  private changeSetting(change: SettingsChange): SettingsView {
    const file = Layout.settings(this.options.dataDir);
    const before = readSettings(file);
    const developerBefore = this.developerProject();
    if (change.key === "agyAcpPath" && change.value?.trim()) validateAgyRuntimePath(change.value.trim(), this.options.dataDir);
    const next = applySetting(before, change);
    writeSettings(file, next);
    if (change.key === "agyBypassPermissions" && before.agyBypassPermissions !== change.value) changeAgyPermissions(change.value);
    // botling.dev gives builds a fresh start after failures when developer mode is turned on again, and tells the developer
    // project's manager at once if awake, else at its next wake (`setDeveloperMode`).
    const developerNow = this.developerProject();
    if ((change.key === "developerMode" && change.value === true) || developerNow?.id !== developerBefore?.id) {
      this.plugins.event("developerChanged", { before: developerBefore?.id ?? null, now: developerNow?.id ?? null, turnedOn: change.key === "developerMode" && change.value === true });
    }
    // The engine defaults go to every bot at once (`setSubagentModelDefault`, `setCodexWorkerDefaults`).
    const model = settingsView(next).subagentModel;
    if (change.key === "subagentModel" && model !== settingsView(before).subagentModel) {
      for (const bot of this.bots.values()) bot.applyEngineDefaults({ subagentModel: model });
    }
    const subagentEffort = settingsView(next).subagentEffort;
    if (change.key === "subagentEffort" && subagentEffort !== settingsView(before).subagentEffort) {
      for (const bot of this.bots.values()) bot.applyEngineDefaults({ subagentEffort });
    }
    const workers = appliedCodexWorkers(next);
    if ((change.key === "codexWorkers" || change.key === "codexWorkersFollow") && JSON.stringify(workers) !== JSON.stringify(appliedCodexWorkers(before))) {
      for (const bot of this.bots.values()) bot.applyEngineDefaults({ codexWorkers: codexWorkersJSON(workers) });
    }
    // The Antigravity workers' defaults go to every bot as the Claude subagents' do (each worker reads its bot's at its start).
    for (const key of ["agyWorkerModel", "agyWorkerEffort"] as const) {
      const now = settingsView(next)[key];
      if (change.key === key && now !== settingsView(before)[key]) for (const bot of this.bots.values()) bot.applyEngineDefaults({ [key]: now });
    }
    if (change.key === "defaultPrimaryEngine" || change.key === "defaultEngines") for (const bot of this.bots.values()) bot.appPrimaryChanged();
    if (change.key === "claudeWorkerLimit") for (const bot of this.bots.values()) bot.claudeWorkerLimitChanged();
    if (change.key === "language" || change.key === "botLook" || change.key === "claudeWorkerLimit") this.plugins.appSettingsChanged();
    const view = this.settingsNow();
    this.event({ type: "settings.updated", settings: view });
    return view;
  }

  // ------------------------------------------------------------------------------------------
  // Core hot swap (hot-swap.ts)

  /** Drained for a swap: quitting now hands over instead of tidying. */
  private swapping = false;

  /** Stops beginning turns, lets those under way finish (or stops them at a tool-call boundary), and writes the handover. */
  async drainForSwap(timeoutMs: number, boundaryMs: number): Promise<{ entries: number; interrupted: string[] }> {
    if (this.swapping) throw new ContractError("conflict", "A core swap is already under way.");
    this.swapping = true;
    this.event({ type: "core.swap", phase: "draining" });
    try {
      const result = await drainBots([...this.bots.values()], { timeoutMs, boundaryMs, log: (line) => this.log(line) });
      writeHandover(this.options.dataDir, result.entries);
      this.log(`core swap: drained; ${result.entries.length} head(s) handed over, ${result.interrupted.length} stopped mid-turn`);
      this.event({ type: "core.swap", phase: "updating" });
      return { entries: result.entries.length, interrupted: result.interrupted };
    } catch (error) {
      this.cancelSwap();
      throw error;
    }
  }

  /** The swap was called off (the new core did not start): this core goes on as before. */
  cancelSwap() {
    discardHandover(this.options.dataDir);
    this.swapping = false;
    for (const bot of this.bots.values()) bot.holdForSwap(false);
    this.event({ type: "core.swap", phase: null });
  }

  private adoptSwap() {
    let handover;
    try { handover = takeHandover(this.options.dataDir); } catch (error) { this.log(`core swap: handover unreadable: ${(error as Error).message}`); return; }
    if (!handover) return;
    this.log(`core swap: taking over ${handover.entries.length} head(s) from the previous core`);
    for (const botId of new Set(handover.entries.map((entry) => entry.botId))) {
      const entries = handover.entries.filter((entry) => entry.botId === botId);
      const bot = this.bots.get(botId);
      if (!bot) continue;
      try { bot.adoptSwap(entries); } catch (error) { this.log(`core swap: ${botId}: ${(error as Error).message}`); }
    }
  }

  /** Ends every turn and head (with their trees) and writes everything out; for quitting. */
  private restarting = false;
  prepareRestart() {
    if(this.restarting)throw Error("Restart is already prepared.");
    if(this.swapping)throw Error("A core swap is already in progress.");
    const journal=new RestartJournal(this.options.dataDir);
    journal.prepare([...this.bots.values()].flatMap(bot=>bot.restartEntries()));
    this.restarting=true;
    for(const bot of this.bots.values())bot.holdForSwap(true);
  }
  /** Quit-time variant: arms continuation only if a turn is in flight; never throws, never disturbs an update restart. */
  prepareQuitContinuation(): boolean {
    if(this.restarting||this.swapping)return false;
    if(![...this.bots.values()].some(bot=>bot.restartEntries().length))return false;
    try{this.prepareRestart();return true;}
    catch(error){this.log(`quit continuation skipped: ${String((error as Error)?.message??error)}`);return false;}
  }
  cancelRestart(){
    if(!this.restarting)return;
    new RestartJournal(this.options.dataDir).cancel();this.restarting=false;
    for(const bot of this.bots.values())bot.holdForSwap(false);
  }

  async shutdown() {
    // M5-06c: no pick will come: a fetch waiting for its card is told "no" (the card itself stays for the next start to close).
    for (const pending of [...(this.serverAsks?.values() ?? [])]) pending.close(null);
    // Re-snapshot synchronously: completion/cancellation after confirmation wins over intent.
    const journal=new RestartJournal(this.options.dataDir);
    if(this.restarting)journal.checkpoint([...this.bots.values()].flatMap(bot=>bot.restartEntries()));
    if (this.routineClock) { clearInterval(this.routineClock); this.routineClock = null; }
    if (this.watchClock) { clearInterval(this.watchClock); this.watchClock = null; }
    this.libraryWatch?.stop(); this.libraryWatch = null;
    this.memoryWatch?.stop(); this.memoryWatch = null;
    if (this.waitingTimer) { clearTimeout(this.waitingTimer); this.waitingTimer = null; }
    this.watchWorkspace(false);
    // (Optional: a core made without its constructor, as tests make one, has neither.)
    this.agentStatus?.close();
    try { this.agents?.flush(); } catch (error) { this.log(`agents.json: ${(error as Error).message}`); }
    // After a swap's drain the heads end without the tidy (it would end their sessions): the new core resumes them.
    const tidy = !this.swapping && !this.restarting;
    // Invoke every participant even if one throws synchronously, and never let an early
    // rejection reach the process exit boundary while another durable flush is pending.
    const bots = [...this.bots.entries()];
    const participants = bots.map(([, bot]) => () => bot.shutdown({ tidy }));
    participants.push(() => this.plugins.shutdown());
    const results = await Promise.allSettled(participants.map(stop => Promise.resolve().then(stop)));
    try { this.options.remoteWorkers?.close(); } catch (error) { this.log(`remote workers: ${(error as Error).message}`); }
    try { noteService().close(); } catch (error) { this.log(`notes: ${(error as Error).message}`); }
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (this.restarting) results.forEach((result, i) => specTrace("restart", "Settle", { part: bots[i]?.[0] ?? "plugins", ok: result.status === "fulfilled" }));
    // Each bot's continuation rests on its own shutdown: one that failed is held back (with why), the others resume.
    // Another participant's failure (a plugin host, a different bot) is no reason to drop their work.
    if (this.restarting) {
      const failed = new Map(bots.flatMap(([id], i) => {
        const result = results[i]!;
        return result.status === "rejected" ? [[id, String((result.reason as Error)?.message ?? result.reason).slice(0, 300)] as const] : [];
      }));
      try { journal.ready(failed); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Core shutdown failed", { cause: failures[0] });
  }
}
