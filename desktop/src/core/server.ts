import { setBrowserBridge } from "./browser-tools";
import { configureNotes, noteService, setNoteBots } from "./note-tools";
import { ROUTINE_TICK_MS } from "./routines";
import type { ModelDiscovery, ModelEngine } from "../contract/model-discovery";
import { RestartJournal, restartPausedNotice } from './restart-continuation';
import { specTrace } from './spec-trace';
import { AgyRuntimeInstaller } from './agy-runtime-install';
import { agyRuntimeStatus } from "./agy-runtime-settings";
import type { AgyConfig } from "./agent/agy";
import { mobileCommand } from '../mobile-bridge/adapter';
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
import { claudeWorkersMode, moveSettingsToPlugins, moveShortcutsToPlugins, readSettings, readSettingsList, seedEngineDefaults, settingsView, writeSettings } from "./settings";
import { botName, firstLine, MemoryFiles } from "./projects";
import { answerLabel } from "./attachments";
import { ContractError, PROTOCOL_VERSION, errorResponse, okResponse, parseInbound, type BotView, type Command, type Event, type Outbound, type ResultOf, type WaitingView, type SubagentRowView, type AgentTargetView, type MachinesView, type PluginView } from "../contract";
import { AgentRegistry, isDetached, newMoveId, rowStatus, TERMINAL_STATES, type AgentPort, type AgentRecord, type ApprovalAnswerer, type HostFacts, type MoveIntent, type ReconcileReport, type WorkerApproval } from "./agent-registry";
import { agyWorkerList } from "./agy-usage-db";
import { AgentStore, migrationRecords } from "./store/agent-store";
import { planMove, unmovable, type BotFacts, type MoveFacts, type MoveTarget } from "./agent-moves";
import { agentMessageNotice, agentNoteTail, agentReportNote, agentToldOfMove, backNote, handedNote, handedNotice, hostLostNotice, movedAwayNote, movedAwayNotice, notOwnedNote, ownedAgentsBriefing, ownerGoneNotice, queuedSentNotice, subBotAdoptedFirstMessage, subBotGroupFirstMessage } from "./agent-relay";
import { workerNoteText } from "./worker-core";
import type { WorkerOwner } from "./agent/workers";
import { AgentStatusWriter } from "./agent-status";
import { Bot, NO_LONGER_NEEDED, type DeferredTurn, type GuestAnswer, type PresetTurnIds, type SessionStart, type SessionStartCodex, type Status as TurnStatus } from "./bot";
import type { FetchRequest } from "./bot-tools";
import type { HeadConfig } from "./agent/head";
import { CodexThreads, type CodexHeadConfig } from "./agent/codex";
import { maintainerEditorBinding } from "./agent/component-editor";
import { type Engine, type Heads } from "./heads";
import { botPrompts, desktopPrompts, isResultPublishing, preferredLanguage, savedLanguage, withPluginSections, type BotPrompts } from "./prompts";
import { StorageBook } from "./storage";
import { BotStore, readJSON } from "./store/bot-store";
import { ProcessLedger } from "./process/ledger";
import { Doctor, DoctorModel } from "./doctor";
import { UsageBook } from "./usage";
import { fromSwiftDate, isOpenQuestion, MAIN_BOT_ID, newId, toSwiftDate } from "./store/records";
import { botFace } from "./faces";
import { status, statusText } from "../contract/bot-status";
import { currentChat, WorkspaceWatch, type BotSummary, type CurrentChat, type MemorySections, type ResultLink, type WorkspaceDigest, type WorkspaceSource } from "./workspace";
import { Layout, loadProfiles, type BotProfile } from "./store/workspace";
import { notePath } from "./bot-note";
import { unsupportedRequest, type BotRequest } from "./reply";
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
import { ReleaseNotices, confirmHealthyWhen } from "./self-update";
import { CoreWatch } from "./server/watch";
import { CorePeerInbox } from "./server/peer-inbox";
import { CoreProjects } from "./server/projects";
import { CoreBots } from "./server/bots";
import { CorePluginWorld } from "./server/plugin-world";
import { CoreSubBots } from "./server/sub-bots";
import { CoreCommands } from "./server/commands";

/** What the core asks of main (self-update.ts, plugins/app-seam.ts). */
export type AppOp = "screenshot" | "quit" | "installRelease" | "browser";
export interface AppAnswer { ok: boolean; file?: string; error?: string; plan?: unknown; data?: unknown }
import { discardHandover, drainBots, takeHandover, writeHandover } from "./hot-swap";

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
  agyInstaller = new AgyRuntimeInstaller();
  readonly epoch = randomUUID().slice(0, 18);
  seq = 0;
  activated = false;
  private inflight = new Map<string, AbortController>();
  readonly ledger: ProcessLedger;
  /** What the bots used and the subscriptions' limits (spending.json, rate-limits.json, codex-rate-limits.json; Phase 5c). */
  readonly usage: UsageBook;
  get imported() { return this.coreProjects.imported; }
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
  private madePluginWorld?: CorePluginWorld;
  private get corePluginWorld(): CorePluginWorld { return (this.madePluginWorld ??= new CorePluginWorld(this)); }
  private madeSubBots?: CoreSubBots;
  private get coreSubBots(): CoreSubBots { return (this.madeSubBots ??= new CoreSubBots(this)); }
  get bots() { return this.coreBots.bots; }
  set bots(value: CoreBots["bots"]) { this.coreBots.bots = value; }
  get order() { return this.coreBots.order; }
  set order(value: CoreBots["order"]) { this.coreBots.order = value; }
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
  get components() { return this.coreWatch.components; }
  set components(value: CoreWatch["components"]) { this.coreWatch.components = value; }
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
  readonly plugins: Plugins;
  get projectFiles() { return this.coreProjects.projectFiles; }
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
  get lastPlugins() { return this.coreWatch.lastPlugins; }
  set lastPlugins(value: CoreWatch["lastPlugins"]) { this.coreWatch.lastPlugins = value; }
  private settlingMaintainer = false;
  private get loadedClaudeParts() { return this.coreWatch.loadedClaudeParts; }
  private set loadedClaudeParts(value: CoreWatch["loadedClaudeParts"]) { this.coreWatch.loadedClaudeParts = value; }
  /** Bots answering in chats that are not their own: call-ins and bots' @ (Phase 4c). */
  readonly conversations: Conversations;
  /** M5-06c: open `serverAsk` cards by the id of their chat line (the bot they are in, and how to end the wait). */
  private serverAsks = new Map<string, { botId: string; close: (index: number | null) => void }>();
  /** <open-question> copies in the main bot's chat: the copy's id → the question it copies. */
  copies = new Map<string, { botId: string; questionId: string }>();
  /** The app-wide agent registry (agents.json, A1): who owns each agent apart from who runs it. */
  readonly agents!: AgentRegistry;
  private readonly agentStatus = new AgentStatusWriter();
  /** What the constructor's reconcile found, told once the core is active (a candidate start changes nothing outside the data folder). */
  private agentReconcile: ReconcileReport | null = null;
  private flagCache: { at: number; agentMoves: boolean; claudeOwnerMoves: boolean } | null = null;

  mainBot(): Bot | null {
    if (!this.runMainBot) return null;
    const bot = this.bots.get(this.mainBotId);
    return bot?.profile.role === "main" ? bot : null;
  }

  private isMainBotId(id: string): boolean {
    return this.runMainBot && id === this.mainBotId;
  }

  noMainBotMessage(): string {
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
    // The plugins (their host starts later, in start()); the world they see is read when they ask (core/server/plugin-world.ts).
    this.plugins = new Plugins(this.corePluginWorld.pluginOptions());
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
    this.profiles = profiles;
    // The agent registry, before any bot: the first start adopts every host book (running ones were cut off with the app).
    (this as { agents: AgentRegistry }).agents = new AgentRegistry(new AgentStore(options.dataDir, (line) => this.log(line)));
    if (this.agents.fresh) {
      try { const adopted = this.agents.adopt(migrationRecords(profiles)); if (adopted) this.log(`agents.json made from the bots' subagent lists (${adopted})`); }
      catch (error) { this.log(`agents.json migration: ${(error as Error).message}`); }
    }
    this.agents.onChange((record, previous) => this.agentChanged(record, previous));
    this.newBot = (profile) => {
      const bot = this.coreBots.build(profile, threads, editorBinding);
      this.bots.set(profile.id, bot);
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

  activate() {
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

  pinOwner(...a: Parameters<CoreWatch["pinOwner"]>) { return this.coreWatch.pinOwner(...a); }

  reportComponent(...a: Parameters<CoreWatch["reportComponent"]>) { return this.coreWatch.reportComponent(...a); }

  followClaudeParts(...a: Parameters<CoreWatch["followClaudeParts"]>) { return this.coreWatch.followClaudeParts(...a); }

  checkStalls(...a: Parameters<CoreWatch["checkStalls"]>) { return this.coreWatch.checkStalls(...a); }

  private watchRuns(...a: Parameters<CoreWatch["watchRuns"]>) { return this.coreWatch.watchRuns(...a); }


  checkNetwork(...a: Parameters<CoreWatch["checkNetwork"]>) { return this.coreWatch.checkNetwork(...a); }

  developerBriefing(...a: Parameters<CoreWatch["developerBriefing"]>) { return this.coreWatch.developerBriefing(...a); }

  developerProject(...a: Parameters<CoreWatch["developerProject"]>) { return this.coreWatch.developerProject(...a); }

  reportFeedback(...a: Parameters<CoreWatch["reportFeedback"]>) { return this.coreWatch.reportFeedback(...a); }

  componentInfos(...a: Parameters<CoreWatch["componentInfos"]>) { return this.coreWatch.componentInfos(...a); }

  checkRoutines(...a: Parameters<CoreWatch["checkRoutines"]>) { return this.coreWatch.checkRoutines(...a); }

  projectBriefing(...a: Parameters<CorePeerInbox["projectBriefing"]>) { return this.corePeerInbox.projectBriefing(...a); }

  private peerBots(...a: Parameters<CorePeerInbox["peerBots"]>) { return this.corePeerInbox.peerBots(...a); }



  briefAwakeMainBot(...a: Parameters<CorePeerInbox["briefAwakeMainBot"]>) { return this.corePeerInbox.briefAwakeMainBot(...a); }

  makeBot(...a: Parameters<CoreBots["makeBot"]>) { return this.coreBots.makeBot(...a); }

  createPluginBot(...a: Parameters<CoreBots["createPluginBot"]>) { return this.coreBots.createPluginBot(...a); }

  writeInstructions(...a: Parameters<CoreBots["writeInstructions"]>) { return this.coreBots.writeInstructions(...a); }

  isSubBot(...a: Parameters<CoreBots["isSubBot"]>) { return this.coreBots.isSubBot(...a); }

  private subBotRows(...a: Parameters<CoreBots["subBotRows"]>) { return this.coreBots.subBotRows(...a); }

  private subBotNote(...a: Parameters<CoreBots["subBotNote"]>) { return this.coreBots.subBotNote(...a); }

  subBotRequested(...a: Parameters<CoreSubBots["subBotRequested"]>) { return this.coreSubBots.subBotRequested(...a); }

  removeSubBotRequested(...a: Parameters<CoreSubBots["removeSubBotRequested"]>) { return this.coreSubBots.removeSubBotRequested(...a); }

  removeBotRequested(...a: Parameters<CoreSubBots["removeBotRequested"]>) { return this.coreSubBots.removeBotRequested(...a); }

  // ---- Agents (A1): the registry, "Move to…", notices, status files ----

  /** settings.json's agent flags (read at most every 2 s: rows ask often). */
  agentFlags(): { agentMoves: boolean; claudeOwnerMoves: boolean } {
    const now = Date.now();
    if (!this.flagCache || now - this.flagCache.at > 2_000) {
      const raw = readSettings(Layout.settings(this.options.dataDir)) as Record<string, unknown>;
      // agentMoves is on unless settings.json turns it off (A2 shipped).
      this.flagCache = { at: now, agentMoves: raw.agentMoves !== false, claudeOwnerMoves: raw.claudeOwnerMoves === true };
    }
    return this.flagCache;
  }

  private requireAgentMoves() {
    if (!this.agentFlags().agentMoves) throw new ContractError("forbidden", "Moving agents is off (agentMoves in settings.json).");
  }

  /** A bot's name as agent notices say it. */
  agentBotName(id: string): string {
    const profile = this.profiles.find((candidate) => candidate.id === id);
    return !profile ? "a removed bot" : profile.role === "main" ? "Main bot" : profile.name;
  }

  private botFacts(id: string): BotFacts | null {
    const profile = this.profiles.find((candidate) => candidate.id === id);
    const bot = this.bots.get(id);
    if (!profile || !bot || this.removed.has(id)) return null;
    return { id, name: this.agentBotName(id), role: profile.role, parent: profile.parent ?? null, maintainer: id === this.maintainerId, problem: profile.problem, folder: profile.folder, engine: bot.engine, heads: bot.headEngines };
  }

  /** The registry as one bot's heads see it (a partner head shares its primary's). */
  agentPort(profile: BotProfile): AgentPort {
    const id = profile.id;
    return {
      observed: (host, rec, worker) => { this.agents.observe(host, rec, worker); },
      // Its report (if any) comes as the host's `workerReport` and goes to the owner (`report`).
      ended: (host, rec, worker) => { this.agents.observe(host, rec, worker); },
      report: (host, r) => this.agentReported(host, r),
      note: (host, n) => this.agentNoted(host, n),
      approval: (host, nativeId, item, head) => this.agentApproval(host, nativeId, item, head),
      approvalCancelled: (_host, requestId) => { for (const bot of this.bots.values()) bot.settleWorkerApproval(requestId); },
      retained: (engine) => this.agents.retained(id, engine),
      movedOut: (engine) => new Map([...this.agents.movedOut(id, engine)].map(([nativeId, record]) => [nativeId, {
        agentId: record.id, owner: { botId: record.owner.botId, engine: record.owner.engine }, ownerName: this.agentBotName(record.owner.botId), muted: record.relay.muted,
      }])),
      movedInRows: () => this.movedInRows(id),
      settle: (ownerBotId, nativeId, settled) => this.agents.settle(ownerBotId, nativeId, settled),
      rowInfo: (engine, nativeId) => {
        const record = this.agents.byNative(id, engine, nativeId);
        if (!record) return {};
        return { agentId: record.id, ...(this.agentFlags().agentMoves ? { movable: this.movability(record) } : {}) };
      },
    };
  }

  private movability(record: AgentRecord): { ok: boolean; reason: string | null } {
    const owner = this.botFacts(record.owner.botId);
    if (!owner) return { ok: false, reason: "Its owner is gone." };
    const reason = unmovable(record, { owner, pending: this.agents.moving(record.id), claudeOwnerMoves: this.agentFlags().claudeOwnerMoves });
    return { ok: !reason, reason: reason ? reason.slice(0, 200) : null };
  }

  /** The rows of agents this bot owns that another bot runs: the host's row, with the registry's status, settling and host. */
  private movedInRows(ownerId: string): SubagentRowView[] {
    const moves = this.agentFlags().agentMoves;
    return this.agents.movedIn(ownerId).map((record): SubagentRowView => {
      const row = this.bots.get(record.host.botId)?.subagentRowFor(record.nativeId) ?? null;
      return {
        outputTokens: row?.outputTokens ?? null,
        id: record.nativeId.slice(0, 200),
        title: (row?.title || record.summary.description).slice(0, 400),
        status: rowStatus(record.state),
        head: row?.head ?? record.host.engine,
        startedAt: row?.startedAt ?? record.createdAt,
        endedAt: record.state === "running" ? null : row?.endedAt ?? record.endedAt,
        unsettledAt: record.ownerView.unsettledAt,
        settled: record.ownerView.settledAt !== null,
        prompt: (row?.prompt ?? record.summary.prompt).slice(0, 1_000),
        agentId: record.id,
        host: { botId: record.host.botId, name: this.agentBotName(record.host.botId).slice(0, 400) },
        ...(moves ? { movable: this.movability(record) } : {}),
      };
    });
  }

  /** A registry record changed: the rows of the bots it concerns, and its status file while it is owned elsewhere. */
  private agentChanged(record: AgentRecord, previous: AgentRecord | null) {
    const detached = isDetached(record);
    if (!detached && !(previous && isDetached(previous))) return;
    const ownerChanged = !!previous && previous.owner.botId !== record.owner.botId;
    const rowChanged = !previous || ownerChanged || previous.state !== record.state || previous.summary.description !== record.summary.description
      || previous.endedAt !== record.endedAt || previous.ownerView.settledAt !== record.ownerView.settledAt || previous.ownerView.unsettledAt !== record.ownerView.unsettledAt;
    if (rowChanged) {
      this.bots.get(record.owner.botId)?.refresh();
      if (ownerChanged) { this.bots.get(previous!.owner.botId)?.refresh(); this.bots.get(record.host.botId)?.refresh(); }
    }
    if (detached && this.activated) this.writeAgentStatus(record, !previous || previous.state !== record.state || ownerChanged);
  }

  /** <owner folder>/.bot/agents/<id>/status.md (A1.4); its path, or null when it could not be written. */
  private writeAgentStatus(record: AgentRecord, force: boolean): string | null {
    const owner = this.profiles.find((candidate) => candidate.id === record.owner.botId);
    if (!owner || owner.problem) return null;
    try {
      const file = this.agentStatus.write(owner.folder, record, () => this.bots.get(record.host.botId)?.agentFacts(record.nativeId)?.steps ?? [], this.agentBotName(record.host.botId), force);
      if (record.summary.statusFile !== file) this.agents.setFiles(record.id, { statusFile: file });
      return file;
    } catch (error) {
      this.log(`agent status ${record.id}: ${(error as Error).message}`);
      return null;
    }
  }

  /** Reconcile (A1.3). `notify`: tell what it found (and what the constructor's found), and finish moves cut short. */
  private reconcileAgents(notify: boolean) {
    const alive = [...this.bots.keys()].filter((id) => !this.removed.has(id));
    const report = this.agents.reconcile({ hosts: alive.flatMap((id) => this.bots.get(id)!.hostBooks()), bots: new Set(alive) });
    const held = this.agentReconcile;
    this.agentReconcile = null;
    const found: ReconcileReport = held ? { ...report, hostLost: [...held.hostLost, ...report.hostLost], ownerReverted: [...held.ownerReverted, ...report.ownerReverted] } : report;
    if (report.added.length || report.dropped.length || report.interrupted.length) this.log(`agents: ${report.added.length} added, ${report.dropped.length} dropped, ${report.interrupted.length} interrupted`);
    if (!notify) { this.agentReconcile = found; return; }
    for (const record of found.hostLost) {
      this.bots.get(record.owner.botId)?.appNotice(hostLostNotice({ title: record.summary.description || "Subagent", host: this.agentBotName(record.host.botId), statusFile: record.summary.statusFile }), undefined, undefined, { moveNotice: `lost:${record.id}` });
    }
    for (const { record, from } of found.ownerReverted) {
      const host = this.bots.get(record.host.botId);
      host?.setWorkerOwner(record.nativeId, null);
      host?.appNotice(ownerGoneNotice({ title: record.summary.description || "Subagent", owner: this.agentBotName(from.botId) }));
    }
    for (const move of found.resend) {
      try { this.finishMove(move, {}); } catch (error) { this.log(`agent move ${move.id}: ${(error as Error).message}`); }
    }
    this.redeliverAgentReports();
  }

  /** `removeBot`'s part: reconcile rules 4 and 5 for that bot, before it leaves the profiles. */
  agentsOfRemovedBot(id: string) {
    const name = this.agentBotName(id);
    const gone = this.agents.botRemoved(id, (other) => other !== id && this.bots.has(other) && !this.removed.has(other));
    for (const record of gone.hostLost) {
      this.bots.get(record.owner.botId)?.appNotice(hostLostNotice({ title: record.summary.description || "Subagent", host: name, statusFile: record.summary.statusFile }), undefined, undefined, { moveNotice: `lost:${record.id}` });
    }
    for (const { record } of gone.ownerReverted) {
      const host = this.bots.get(record.host.botId);
      // Its host hears its reports again (it never stopped running).
      host?.setWorkerOwner(record.nativeId, null);
      host?.appNotice(ownerGoneNotice({ title: record.summary.description || "Subagent", owner: name }));
      host?.refresh();
    }
  }

  /** The wake note's part for agents it owns that run on another bot. */
  ownedAgentsNote(profile: BotProfile): string {
    return ownedAgentsBriefing(this.agents.movedIn(profile.id).filter((record) => !TERMINAL_STATES.has(record.state) || record.ownerView.settledAt === null).map((record) => ({
      title: record.summary.description || "Subagent", id: record.nativeId, engine: record.engine, host: this.agentBotName(record.host.botId), state: record.state, statusFile: record.summary.statusFile,
    })));
  }

  /** An agent by the bot whose rows show it and its row id: that bot's own book first, then the agents it owns elsewhere. */
  private resolveAgent(botId: string, subagentId: string): AgentRecord {
    this.bot(botId);
    const record = this.agents.byHostBot(botId, subagentId) ?? this.agents.movedIn(botId).find((candidate) => candidate.nativeId === subagentId);
    if (!record) throw new ContractError("not_found", "No such agent.");
    return record;
  }

  /** `subagent.view`: one of the bot's own, or one it owns that another bot runs (read from its host, named as the owner's). */
  agentView(botId: string, subagentId: string): ResultOf<"subagent.view"> {
    const view = this.agentViewBase(botId, subagentId);
    // Words the host could not take while the run worked wait here; they show as the last lines, marked queued, until sent.
    const record = this.agents.byHostBot(botId, subagentId) ?? this.agents.movedIn(botId).find((candidate) => candidate.nativeId === subagentId);
    const waiting = record?.relay.pendingMessages ?? [];
    if (!waiting.length) return view;
    return { ...view, subagent: { ...view.subagent, steps: [...view.subagent.steps, ...waiting.map((message) => ({
      id: `queued:${message.id}`, kind: "message" as const, tool: null, title: message.text.slice(0, 2_000), detail: null, output: null, failed: false, done: true,
      from: "owner", time: new Date(message.at).toISOString(), queued: true,
    }))].slice(-500) } };
  }

  private agentViewBase(botId: string, subagentId: string): ResultOf<"subagent.view"> {
    const bot = this.bot(botId);
    const own = this.agents.byHostBot(botId, subagentId);
    if (own || bot.agentFacts(subagentId)) {
      return bot.subagentView(subagentId, own && isDetached(own) ? { owner: this.agentBotName(own.owner.botId), host: this.agentBotName(botId) } : undefined);
    }
    const moved = this.agents.movedIn(botId).find((candidate) => candidate.nativeId === subagentId);
    if (!moved) return bot.subagentView(subagentId);
    const host = this.removed.has(moved.host.botId) ? undefined : this.bots.get(moved.host.botId);
    if (!host) throw new ContractError("not_found", "The bot that ran it is gone.");
    return host.subagentView(subagentId, { owner: this.agentBotName(botId), host: this.agentBotName(moved.host.botId) });
  }

  private moveFacts(record: AgentRecord, to?: MoveTarget): MoveFacts {
    const owner = this.botFacts(record.owner.botId);
    if (!owner) throw new ContractError("not_found", "Its owner is gone.");
    return {
      owner, host: this.botFacts(record.host.botId),
      ...(to?.kind === "bot" ? { target: this.botFacts(to.botId) } : {}),
      project: owner.parent ? this.botFacts(owner.parent) : owner,
      pending: this.agents.moving(record.id),
      claudeOwnerMoves: this.agentFlags().claudeOwnerMoves,
    };
  }

  /** `agent.targets`: where "Move to…" can take it, each with why not when it cannot. */
  agentTargets(botId: string, subagentId: string): ResultOf<"agent.targets"> {
    this.requireAgentMoves();
    const record = this.resolveAgent(botId, subagentId);
    const base = this.moveFacts(record);
    const view = (kind: AgentTargetView["kind"], target: MoveTarget, botIdOf: string | null, name: string, folder: string, facts: MoveFacts): AgentTargetView => {
      const plan = planMove(record, target, facts);
      return { kind, botId: botIdOf, name: name.slice(0, 400), folder: folder.slice(0, 4_000), sameFolder: folder === record.host.folder,
        disabled: "refuse" in plan ? plan.refuse.slice(0, 400) : null, mode: "refuse" in plan ? "owner" : plan.mode };
    };
    const targets: AgentTargetView[] = [];
    if (isDetached(record) && base.host) targets.push(view("back", { kind: "back" }, base.host.id, base.host.name, base.host.folder, base));
    const handoff = record.engine === "claude" && !(record.background && base.claudeOwnerMoves);
    targets.push(view("newSubBot", { kind: "newSubBot", name: "New sub bot" }, null, "New sub bot…", (handoff ? base.owner.folder : base.project?.folder) ?? base.owner.folder, base));
    // Its project's own family first (the project bot and its sub bots), then every other bot that can take one.
    const project = base.project?.id ?? null;
    const candidates = this.profiles.filter((profile) => !this.removed.has(profile.id) && profile.role !== "main" && profile.id !== this.maintainerId && profile.id !== record.owner.botId && !(isDetached(record) && profile.id === record.host.botId));
    const family = (profile: BotProfile) => profile.id === project || (project !== null && profile.parent === project) ? 0 : 1;
    for (const profile of [...candidates].sort((a, b) => family(a) - family(b))) {
      const facts = { ...base, target: this.botFacts(profile.id) };
      targets.push(view("bot", { kind: "bot", botId: profile.id }, profile.id, this.agentBotName(profile.id), profile.folder, facts));
    }
    return { engine: record.engine, targets: targets.slice(0, 200) };
  }

  /**
   * `agent.move` (A1.6). An owner move writes its intent first, makes the new sub bot when asked, tells the host who owns the
   * worker now (its reports, approvals and coordinator calls follow), then changes the owner and commits in one write; the
   * notices follow, once per move (sent again at the next start when cut short). A Claude subagent inside its parent's
   * process (a sidechain, only with claudeWorkers "native") goes by the sub-bot hand-off instead (unchanged).
   */
  async moveAgent(botId: string, subagentId: string, to: MoveTarget, options: { notifyAgent?: boolean } = {}): Promise<ResultOf<"agent.move">> {
    this.requireAgentMoves();
    const record = this.resolveAgent(botId, subagentId);
    const plan = planMove(record, to, this.moveFacts(record, to));
    if ("refuse" in plan) throw new ContractError("conflict", plan.refuse);
    if (plan.mode === "handoff") {
      const host = this.bots.get(record.host.botId);
      if (!host) throw new ContractError("not_found", "The bot that runs it is gone.");
      void this.subBotRequested(host, { name: to.kind === "newSubBot" ? to.name : "", subagent: record.nativeId, note: to.kind === "newSubBot" ? to.note ?? "" : "" });
      return { agentId: record.id, ownerBotId: record.owner.botId, mode: "handoff" };
    }
    const owner = await this.moveOwners([record], to, { notifyAgent: options.notifyAgent === true, note: to.kind === "newSubBot" ? to.note : undefined });
    return { agentId: record.id, ownerBotId: owner, mode: "owner" };
  }

  /**
   * "New sub bot with these…" and `<sub-bot subagents="…">`: several agents shown in one bot's rows move to one new sub bot (or
   * one bot) together. Every one is planned first; one that cannot go refuses them all.
   */
  async groupAgents(botId: string, subagentIds: string[], to: MoveTarget, options: { task?: string } = {}): Promise<ResultOf<"agent.group">> {
    this.requireAgentMoves();
    const records = [...new Map(subagentIds.map((id) => { const record = this.resolveAgent(botId, id); return [record.id, record] as const; })).values()];
    const owner = await this.moveOwners(records, to, { note: to.kind === "newSubBot" ? to.note : undefined, task: options.task });
    return { ownerBotId: owner, agentIds: records.map((record) => record.id) };
  }

  /** The owner of each of these (an app-managed worker) is told to its host: null when the new owner is the host itself. */
  private workerOwnerFor(record: AgentRecord, to: string): WorkerOwner | null {
    return to === record.host.botId ? null : { botId: to, name: this.agentBotName(to), agentId: record.id };
  }

  /**
   * Owner moves of one or more agents to one target, all or none: intents first, the sub bot (once), each host told the new
   * owner (a refusal undoes the ones before it and the sub bot), then the commits and the notices.
   */
  async moveOwners(records: AgentRecord[], to: MoveTarget, options: { notifyAgent?: boolean; note?: string; task?: string }): Promise<string> {
    if (!records.length) throw new ContractError("bad_request", "No agents to move.");
    const plans = records.map((record) => {
      const plan = planMove(record, to, this.moveFacts(record, to));
      if ("refuse" in plan) throw new ContractError("conflict", records.length > 1 ? `"${record.summary.description || record.nativeId}" cannot move: ${plan.refuse}` : plan.refuse);
      if (plan.mode !== "owner") throw new ContractError("conflict", `"${record.summary.description || record.nativeId}" is a Claude subagent inside its parent: it can only be handed over on its own, through handoff.md.`);
      return plan;
    });
    const sub = plans.find((plan) => plan.makeSubBot)?.makeSubBot;
    if (sub && plans.some((plan) => plan.makeSubBot && plan.makeSubBot.parentId !== sub.parentId)) throw new ContractError("conflict", "These agents belong to different projects; move them one project at a time.");
    const moves: MoveIntent[] = records.map((record, i) => ({ id: newMoveId(), agentId: record.id, kind: "owner", from: { owner: { botId: record.owner.botId, engine: record.owner.engine } }, to: { owner: plans[i]!.to }, phase: "intent", at: Date.now() }));
    const begun: MoveIntent[] = [];
    const told: AgentRecord[] = [];
    let subId: string | null = null;
    try {
      for (const move of moves) { this.agents.beginMove(move); begun.push(move); }
      if (sub) {
        const parent = this.profiles.find((candidate) => candidate.id === sub.parentId);
        if (!parent) throw new Error("its project bot is gone");
        const from = this.agentBotName(records[0]!.owner.botId);
        const job = records.length === 1 ? `Own the agent "${records[0]!.summary.description || "an agent"}" handed over by ${from}.` : `Own ${records.length} agents handed over by ${from}.`;
        subId = this.makeSubBot(parent, sub.name, `${job}${options.task?.trim() ? ` ${options.task.trim()}` : ""}`.slice(0, 1_000), undefined, sub.engine);
        for (const move of moves) this.agents.retarget(move.id, { botId: subId, engine: sub.engine });
      }
      for (const [i, record] of records.entries()) {
        const target = this.agents.pendingMoves.find((candidate) => candidate.id === moves[i]!.id)!.to.owner.botId;
        if (record.host.kind === "claude-sidechain") continue;
        const set = this.bots.get(record.host.botId)?.setWorkerOwner(record.nativeId, this.workerOwnerFor(record, target)) ?? null;
        if (set && !set.ok) throw new Error(`"${record.summary.description || record.nativeId}": ${set.reason}`);
        told.push(record);
      }
      for (const move of moves) this.agents.commitMove(move.id);
    } catch (error) {
      // Undo: the hosts are told the owners they had, the intents are dropped, the sub bot made for them goes.
      for (const record of told) this.bots.get(record.host.botId)?.setWorkerOwner(record.nativeId, this.workerOwnerFor(record, record.owner.botId));
      for (const move of begun) this.agents.endMove(move.id);
      if (subId) await this.removeBot(subId, { quiet: true }).catch(() => undefined);
      throw error instanceof ContractError ? error : new ContractError("conflict", `It was not moved: ${(error as Error).message}`);
    }
    const group = records.length > 1 || !!options.task;
    for (const move of moves) {
      const committed = this.agents.pendingMoves.find((candidate) => candidate.id === move.id);
      if (!committed) continue;
      try { this.finishMove(committed, { note: options.note, notifyAgent: options.notifyAgent === true, madeSubBot: !!subId && !group, quietFresh: group }); }
      catch (error) { this.log(`agent move ${move.id}: notices will be sent again at the next start (${(error as Error).message})`); }
    }
    const ownerId = this.agents.get(records[0]!.id)?.owner.botId ?? subId ?? "";
    // A sub bot made for several: one first message listing every one of them and its status file.
    if (subId && group) {
      const next = this.bots.get(subId);
      const parentId = this.profiles.find((candidate) => candidate.id === subId)?.parent ?? null;
      const from = this.agentBotName(moves[0]!.from.owner.botId);
      next?.relay(subBotGroupFirstMessage({
        parentName: parentId ? this.agentBotName(parentId) : from, name: next.profile.name, from, task: options.task ?? options.note,
        agents: records.map((record) => { const now = this.agents.get(record.id) ?? record; return { title: now.summary.description || "Agent", agentId: now.id, nativeId: now.nativeId, engine: now.engine, state: now.state, host: this.agentBotName(now.host.botId), statusFile: now.summary.statusFile }; }),
      }));
    }
    for (const record of records) this.log(`agent ${record.id} now belongs to ${this.agentBotName(this.agents.get(record.id)?.owner.botId ?? "")}`);
    return ownerId;
  }

  /** A committed move's notices (A1.7), each posted once (keyed by move id), then the move is done. */
  private finishMove(move: MoveIntent, options: { note?: string; notifyAgent?: boolean; madeSubBot?: boolean; quietFresh?: boolean }) {
    const record = this.agents.get(move.agentId);
    if (record) {
      const title = record.summary.description || "Subagent";
      const fromId = move.from.owner.botId, toId = move.to.owner.botId, hostId = record.host.botId;
      const fromName = this.agentBotName(fromId), toName = this.agentBotName(toId), hostName = this.agentBotName(hostId);
      const back = toId === hostId;
      const statusFile = back ? null : this.writeAgentStatus(record, true);
      const old = this.removed.has(fromId) ? undefined : this.bots.get(fromId);
      if (old && !old.hasMoveNotice(`${move.id}:from`)) {
        old.appNotice(movedAwayNotice({ title, to: toName, host: hostName }), undefined, undefined, { sourceID: toId, moveNotice: `${move.id}:from` });
        old.queueNote(movedAwayNote({ title, nativeId: record.nativeId, to: toName }));
      }
      const next = this.removed.has(toId) ? undefined : this.bots.get(toId);
      if (next && !next.hasMoveNotice(`${move.id}:to`)) {
        if (back) {
          next.appNotice(`${fromName} gave "${title}" back. Its reports come to you again.`, undefined, undefined, { sourceID: fromId, moveNotice: `${move.id}:to` });
          next.queueNote(backNote({ title, nativeId: record.nativeId, from: fromName }));
        } else {
          // A sub bot made for it (or, after a crash, one that has said nothing yet) is woken with it; an existing bot hears with its next message.
          const fresh = !options.quietFresh && (options.madeSubBot ?? (!!next.profile.parent && next.view().lastActivity === null));
          next.appNotice(handedNotice({ from: fromName, title, engine: record.engine, state: record.state, host: hostName, folder: record.host.folder, statusFile: statusFile ?? "(not written yet)" }), undefined, undefined, { sourceID: fromId, moveNotice: `${move.id}:to` });
          if (fresh) {
            const parent = next.profile.parent ? this.agentBotName(next.profile.parent) : fromName;
            next.relay(subBotAdoptedFirstMessage({ parentName: parent, name: next.profile.name, from: fromName, title, nativeId: record.nativeId, agentId: record.id, engine: record.engine, host: hostName, folder: record.host.folder, statusFile: statusFile ?? "(not written yet)", ...(options.note ? { note: options.note } : {}) }));
          } else if (!options.quietFresh) next.queueNote(handedNote({ from: fromName, title, nativeId: record.nativeId, agentId: record.id, engine: record.engine, host: hostName, statusFile: statusFile ?? "(not written yet)" }));
        }
      }
      // The host, when it is neither: it must leave the agent alone too.
      if (hostId !== fromId && hostId !== toId) this.bots.get(hostId)?.queueNote(movedAwayNote({ title, nativeId: record.nativeId, to: toName }));
      // The agent itself: a running Codex worker, only when asked for. Never Claude, never Antigravity.
      if (options.notifyAgent && record.engine === "codex" && record.host.kind === "codex-thread" && record.state === "running") this.bots.get(hostId)?.askForHandoff(record.nativeId, agentToldOfMove(toName));
    }
    this.agents.setPhase(move.id, "notified");
    this.agents.endMove(move.id);
  }

  // ---- Agents (A2): reports, approvals, follow-ups and stops go to the owner; closing a sub bot ----

  /** Owner app turns carrying a report: turn id → the report (delivered once that turn starts). */
  private reportTurns = new Map<string, { agentId: string; run: number }>();
  /** The turns that began while a report was being handed over (`deliverAgentReport`). */
  private reportStarts: Set<string> | null = null;
  /** Reports handed to an owner in this run of the core (redelivery after a restart goes once per run). */
  private reportsHanded = new Set<string>();

  /** A worker another bot owns ended a run (its host's `workerReport`): recorded, then handed to the owner as an app message. */
  private agentReported(host: HostFacts, r: { nativeId: string; run: number; status: string; text: string }) {
    const record = this.agents.byNative(host.botId, host.engine, r.nativeId);
    if (!record) { this.log(`agent report from ${host.botId} for ${r.nativeId}: not in the registry`); return; }
    if (!this.agents.reported(record.id, r)) return;
    this.deliverAgentReport(record.id);
    void this.sendQueuedMessages(record.id);
  }

  /** A worker another bot owns sent a note from its run under way (its host's `workerNote`): handed to the owner now, never kept. */
  private agentNoted(host: HostFacts, n: { nativeId: string; run: number; kind: "report" | "question"; name: string; message: string; files: string[] }) {
    const record = this.agents.byNative(host.botId, host.engine, n.nativeId);
    const owner = record && !this.removed.has(record.owner.botId) ? this.bots.get(record.owner.botId) : undefined;
    if (!record || !owner) { this.log(`agent note from ${host.botId} for ${n.nativeId}: no owner to take it`); return; }
    const name = record.summary.description || n.name;
    const text = workerNoteText({ id: record.id, run: n.run, kind: n.kind, name, message: n.message, files: n.files }, agentNoteTail({ kind: n.kind, host: this.agentBotName(record.host.botId), agentId: record.id }));
    if (!owner.workerNote({ kind: n.kind, name, message: n.message, files: n.files }, text)) this.log(`agent note for ${record.id}: its owner could not take it now`);
  }

  /** The owner's app turn with the report (its status file brought up to date first). Stays undelivered when the owner cannot run. */
  private deliverAgentReport(agentId: string) {
    const record = this.agents.get(agentId);
    const report = record?.relay.report;
    if (!record || !report || report.delivered) return;
    const key = `${agentId}:${report.run}`;
    if (this.reportsHanded.has(key)) return;
    const owner = this.removed.has(record.owner.botId) ? undefined : this.bots.get(record.owner.botId);
    if (!owner) return;
    const statusFile = isDetached(record) ? this.writeAgentStatus(record, true) : record.summary.statusFile;
    const from = record.owner.history.at(-1)?.botId ?? record.host.botId;
    // A free owner begins the turn (turn.started) before appMessage returns its id: those starts are caught here.
    const started = new Set<string>();
    this.reportStarts = started;
    let turnId: string | null;
    try {
      turnId = owner.appMessage(agentReportNote({
        engine: record.engine, title: record.summary.description || "Agent", from: this.agentBotName(from), host: this.agentBotName(record.host.botId),
        run: report.run, status: record.state === "failed" ? "failed" : record.state === "stopped" ? "stopped" : "completed", report: record.summary.lastReport ?? "", agentId, statusFile,
      }));
    } finally { this.reportStarts = null; }
    if (!turnId) return;
    this.reportsHanded.add(key);
    if (started.has(turnId)) this.agents.reportDelivered(agentId, report.run);
    else this.reportTurns.set(turnId, { agentId, run: report.run });
  }

  /** Words left for an agent whose host could not take them while it worked: sent now that its run ended. */
  private async sendQueuedMessages(agentId: string) {
    const record = this.agents.get(agentId);
    if (!record?.relay.pendingMessages.length) return;
    const host = this.removed.has(record.host.botId) ? undefined : this.bots.get(record.host.botId);
    const owner = this.removed.has(record.owner.botId) ? undefined : this.bots.get(record.owner.botId);
    if (!host) return;
    const words = this.agents.takeMessages(agentId);
    const sent = await host.commandWorker(record.nativeId, { kind: "message", text: words.map((message) => message.text).join("\n\n") });
    const title = record.summary.description || "Agent";
    if (sent.ok && sent.how !== "stopped") owner?.appNotice(queuedSentNotice({ title, run: sent.run }), undefined, undefined, { sourceID: record.host.botId });
    else if (!sent.ok && sent.busy) for (const message of words) this.agents.queueMessage(agentId, message);
    else if (!sent.ok) owner?.appNotice(`The words you left for "${title}" could not be sent: ${sent.reason}`);
  }

  /** Reports that never reached their owner (the app stopped first): handed over again, once. */
  private redeliverAgentReports() {
    for (const record of this.agents.all) if (record.relay.report && !record.relay.report.delivered) this.deliverAgentReport(record.id);
  }

  /** A worker another bot owns asks for an approval: the owner's chat shows the card. */
  private agentApproval(host: HostFacts, nativeId: string, item: WorkerApproval, head: ApprovalAnswerer): boolean {
    const record = this.agents.byNative(host.botId, host.engine, nativeId);
    if (!record || !isDetached(record)) return false;
    const owner = this.removed.has(record.owner.botId) ? undefined : this.bots.get(record.owner.botId);
    if (!owner) return false;
    owner.askForWorker(head, { ...item, summary: `${item.summary} (worker "${record.summary.description || nativeId}" on ${this.agentBotName(record.host.botId)})` });
    return true;
  }

  /** An agent by what its owner calls it: its agent id, or the id its row shows (its native id). */
  private ownedAgent(ownerBotId: string, key: string): AgentRecord | undefined {
    return this.agents.get(key) ?? this.agents.movedIn(ownerBotId).find((record) => record.nativeId === key) ?? this.agents.byHostBot(ownerBotId, key);
  }

  /**
   * The owner's follow-up or stop (`agent.message` / `agent.stop`, `<agent-message>` / `<agent-stop>`), through the host's
   * WorkerHost. Only the registry owner may command. A follow-up a busy host cannot take now waits for the run to end.
   */
  async commandAgent(ownerBotId: string, key: string, action: { kind: "message"; text: string } | { kind: "stop" }): Promise<{ record: AgentRecord; how: "steered" | "newRun" | "queued" | "stopped"; run: number | null }> {
    const record = this.ownedAgent(ownerBotId, key);
    if (!record) throw new ContractError("not_found", `There is no agent "${key}".`);
    if (record.owner.botId !== ownerBotId) throw new ContractError("forbidden", `It belongs to ${this.agentBotName(record.owner.botId)}; only its owner may command it.`);
    if (record.host.kind === "claude-sidechain") throw new ContractError("conflict", "A Claude subagent inside its parent cannot be messaged or stopped on its own.");
    if (record.state === "lost") throw new ContractError("conflict", "Its host is gone.");
    const host = this.removed.has(record.host.botId) ? undefined : this.bots.get(record.host.botId);
    if (!host) throw new ContractError("conflict", "Its host is gone.");
    const result = await host.commandWorker(record.nativeId, action);
    if (!result.ok) {
      if (action.kind === "message" && result.busy) {
        this.agents.queueMessage(record.id, { text: action.text, from: this.agentBotName(ownerBotId) });
        return { record, how: "queued", run: null };
      }
      throw new ContractError("conflict", result.reason);
    }
    return { record, how: result.how, run: result.how === "stopped" ? null : result.run };
  }

  /** `agent.message` from a row's "Send a message…". */
  async agentMessageCommand(botId: string, subagentId: string, text: string): Promise<ResultOf<"agent.message">> {
    const done = await this.commandAgent(botId, subagentId, { kind: "message", text });
    const how = done.how === "stopped" ? "newRun" : done.how;
    this.bots.get(botId)?.appNotice(agentMessageNotice({ title: done.record.summary.description || "Agent", how, run: done.run ?? 0 }), undefined, undefined, { sourceID: done.record.host.botId });
    return { agentId: done.record.id, how, run: done.run };
  }

  /** `agent.stop` from a row's "Stop". */
  async agentStopCommand(botId: string, subagentId: string): Promise<ResultOf<"agent.stop">> {
    const done = await this.commandAgent(botId, subagentId, { kind: "stop" });
    this.bots.get(botId)?.appNotice(`Stopped "${done.record.summary.description || "Agent"}".`, undefined, undefined, { sourceID: done.record.host.botId });
    return { agentId: done.record.id, stopped: true };
  }

  /** A bot's `<agent-message>` / `<agent-stop>`: as the commands, with what went wrong told to it and the chat, never silently. */
  async agentTag(bot: Bot, request: Extract<BotRequest, { kind: "agentMessage" | "agentStop" }>) {
    const owner = this.bots.get(bot.id) ?? bot;
    try {
      const done = await this.commandAgent(owner.id, request.to, request.kind === "agentMessage" ? { kind: "message", text: request.text } : { kind: "stop" });
      const title = done.record.summary.description || "Agent";
      if (done.how === "stopped") owner.appNotice(`Stopped "${title}".`, undefined, undefined, { sourceID: done.record.host.botId });
      else owner.appNotice(agentMessageNotice({ title, how: done.how, run: done.run ?? 0 }), undefined, undefined, { sourceID: done.record.host.botId });
    } catch (error) {
      const record = this.agents.get(request.to) ?? this.agents.all.find((candidate) => candidate.nativeId === request.to);
      if (error instanceof ContractError && error.code === "forbidden") owner.queueNote(notOwnedNote(request.to, record ? this.agentBotName(record.owner.botId) : null));
      else owner.queueNote(`(App: Nothing reached the agent "${request.to}": ${(error as Error).message})`);
      owner.appNotice(`${request.kind === "agentStop" ? "Did not stop" : "Did not send to"} "${record?.summary.description || request.to}": ${(error as Error).message}`);
    }
  }

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
  ignoreQuestion(botId: string, messageId: string): { accepted: boolean } {
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

  outId(id: string) {
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

  workspaceSource(): WorkspaceSource {
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
  watchWorkspace(on: boolean) {
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
  checkWorkspaceSoon() {
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

  projectRequests(...a: Parameters<CoreProjects["projectRequests"]>) { return this.coreProjects.projectRequests(...a); }



  private importOnce(...a: Parameters<CoreProjects["importOnce"]>) { return this.coreProjects.importOnce(...a); }

  log(line: string) {
    this.options.log?.(line);
  }

  /** How plugins see a bot (`Workspace.info(for:)`): "main", or its id. */
  /** The bot a plugin names ("main": the main bot), unless it was taken out of the column. */
  private studioCache: StudioWorld | null = null;
  studioNow(): StudioWorld {
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

  activePluginWriter(): string | null {
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
  replied(bot: Bot, record: ChatRecord) {
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
  async send(botId: string, text: string, options: { replyTo?: string; to?: "both" | "claude" | "codex" | "agy"; ids?: PresetTurnIds }, uploads: Array<{ path: string; name: string }> = []): Promise<ResultOf<"chat.send">> {
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
  attachmentFile(botId: string, ref: string, line?: string): ResultOf<"attachment.file"> {
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
  language() {
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
  agentWiring(): { dirs: string[]; env: Record<string, string>; tools: string[]; skillRoots: string[] } {
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

  mobileDesk: MobileDesk | null = null;
  /** Called once by the bridge's start when the phone connection is configured (mobile-bridge/start.ts). */
  attachMobile(desk: MobileDesk) { this.mobileDesk = desk; }
  mobileOr(): MobileDesk { if (!this.mobileDesk) throw new Error("The phone connection is not set up."); return this.mobileDesk; }
  relay: RelayConnector | null = null;
  /** Called once at startup (mobile-relay/start.ts): the end-to-end encrypted relay, off until Settings › Phone gives it an address. */
  attachRelay(relay: RelayConnector) { this.relay = relay; }
  /** Settings › Phone: the bridge's routes and phones, plus the relay and the phones paired through it. */
  mobileView() {
    const view = this.mobileDesk ? this.mobileDesk.view() : MOBILE_OFF;
    if (!this.relay) return view;
    const relayed = this.relay.devices().map(({ id, label, pairedAt, expiresAt, botIds }) => ({ id, label: label ?? "", pairedAt, expiresAt, botIds: [...botIds], via: "relay" as const }));
    return { ...view, devices: [...view.devices.map((device) => ({ ...device, via: "bridge" as const })), ...relayed].sort((a, b) => b.pairedAt - a.pairedAt), relay: this.relay.view() };
  }

  /** Settings › Machines (remote/service.ts); off when this app runs no remote workers (tests, probes). */
  machinesView(): MachinesView {
    return this.options.remoteWorkers?.view() ?? { enabled: false, relay: { url: null, state: "off" }, machines: [] };
  }
  machinesOr() {
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
  calledInPick(botId: string, messageId: string, index: number): { accepted: boolean } | null {
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
  calledInAnswer(botId: string, messageId: string, text: string, files: number): { accepted: boolean } | null {
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
  calledInGroupAnswer(botId: string, messageId: string, picks: QuestionPick[], files: number): { accepted: boolean } | null {
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

  private madeCommands?: CoreCommands;
  private get coreCommands(): CoreCommands { return (this.madeCommands ??= new CoreCommands(this)); }
  private get shownChat() { return this.coreCommands.shownChat; }
  private handle(...a: Parameters<CoreCommands["handle"]>) { return this.coreCommands.handle(...a); }
  snapshot(...a: Parameters<CoreCommands["snapshot"]>) { return this.coreCommands.snapshot(...a); }
  private settingsNow(...a: Parameters<CoreCommands["settingsNow"]>) { return this.coreCommands.settingsNow(...a); }
  private changeSetting(...a: Parameters<CoreCommands["changeSetting"]>) { return this.coreCommands.changeSetting(...a); }

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
