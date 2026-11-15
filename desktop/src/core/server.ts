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
// The core: owns every bot's chat and head, and answers the contract's commands. It is
// transport-agnostic: `receive` takes whatever arrived, `emit` is where answers and events go. It
// validates everything it receives itself — main validating first is defense in depth, not the
// reason the core is safe.
//
// Its data folder has the Swift app's layout (store/workspace.ts). On the first start with an
// empty folder it imports a 1.x folder when one is given (read-only; store/importer.ts).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { PendingFiles, writeIncoming } from "./attachments";
import type { CodexModel } from "./agent/codex-models";
import { launchSettings, moveSettingsToPlugins, moveShortcutsToPlugins, readSettings, seedEngineDefaults, settingsView, writeSettings } from "./settings";
import { botName, MemoryFiles } from "./projects";
import { ContractError, PROTOCOL_VERSION, type Command, type Outbound, type ResultOf, type PluginView } from "../contract";
import { AgentRegistry, isDetached } from "./agent-registry";
import { AgentStore, migrationRecords } from "./store/agent-store";
import { Bot, type DeferredTurn, type SessionStart, type SessionStartCodex } from "./bot";
import type { FetchRequest } from "./bot-tools";
import type { HeadConfig } from "./agent/head";
import { CodexThreads, type CodexHeadConfig } from "./agent/codex";
import { maintainerEditorBinding } from "./agent/component-editor";
import { StorageBook } from "./storage";
import { BotStore, readJSON } from "./store/bot-store";
import { ProcessLedger } from "./process/ledger";
import { Doctor, DoctorModel } from "./doctor";
import { UsageBook, usageView } from "./usage";
import { MAIN_BOT_ID } from "./store/records";
import { status } from "../contract/bot-status";
import { Layout, loadProfiles, type BotProfile } from "./store/workspace";
import { notePath } from "./bot-note";
import { unsupportedRequest } from "./reply";
import { Conversations, type ConversationsDeps, type RemoteMember } from "./conversations";
import { type GROUP_TIMING } from "./groups";
import { ComponentsContext } from "./components/service";
import { readdirSync } from "node:fs";
import { FolderWatch } from "./folder-watch";
import { agentStamp } from "./plugins/agent-contributions";
import { Plugins, type EngineCli, type PluginWorld } from "./plugins";
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
import { CoreCopies } from "./server/copies";
import { CoreWaiting } from "./server/waiting";
import { CoreCommands } from "./server/commands";
import { CorePluginSide } from "./server/plugin-side";
import { CoreSend } from "./server/send";
import { CoreEvents } from "./server/events";

/** What the core asks of main (self-update.ts, plugins/app-seam.ts). */
export type AppOp = "screenshot" | "quit" | "installRelease" | "browser";
export interface AppAnswer { ok: boolean; file?: string; error?: string; plan?: unknown; data?: unknown }
import { discardHandover, drainBots, takeHandover, writeHandover } from "./hot-swap";

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
  readonly runMainBot: boolean;
  readonly doctor: DoctorModel;
  agyInstaller = new AgyRuntimeInstaller();
  readonly epoch = randomUUID().slice(0, 18);
  activated = false;
  private readonly ledger: ProcessLedger;
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
  private madeSubBots?: CoreSubBots;
  private get coreSubBots(): CoreSubBots { return (this.madeSubBots ??= new CoreSubBots(this)); }
  private madeAgents?: CoreAgents;
  private get coreAgents(): CoreAgents { return (this.madeAgents ??= new CoreAgents(this)); }
  get agents() { return this.coreAgents.agents; }
  set agents(value: CoreAgents["agents"]) { this.coreAgents.agents = value; }
  private get agentStatus() { return this.coreAgents.agentStatus; }
  private get reportTurns() { return this.coreAgents.reportTurns; }
  private get reportStarts() { return this.coreAgents.reportStarts; }
  private madeCopies?: CoreCopies;
  private get coreCopies(): CoreCopies { return (this.madeCopies ??= new CoreCopies(this)); }
  private madeWaiting?: CoreWaiting;
  private get coreWaiting(): CoreWaiting { return (this.madeWaiting ??= new CoreWaiting(this)); }
  get copies() { return this.coreCopies.copies; }
  get serverAsks() { return this.coreCopies.serverAsks; }
  private get lastWaiting() { return this.coreWaiting.lastWaiting; }
  private set lastWaiting(value: CoreWaiting["lastWaiting"]) { this.coreWaiting.lastWaiting = value; }
  private get waitingTimer() { return this.coreWaiting.waitingTimer; }
  private set waitingTimer(value: CoreWaiting["waitingTimer"]) { this.coreWaiting.waitingTimer = value; }
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
  private madePluginSide?: CorePluginSide;
  private get corePluginSide(): CorePluginSide { return (this.madePluginSide ??= new CorePluginSide(this)); }
  private madeSend?: CoreSend;
  private get coreSend(): CoreSend { return (this.madeSend ??= new CoreSend(this)); }
  private madeEvents?: CoreEvents;
  private get coreEvents(): CoreEvents { return (this.madeEvents ??= new CoreEvents(this)); }
  get seq() { return this.coreEvents.seq; }
  set seq(value: CoreEvents["seq"]) { this.coreEvents.seq = value; }
  private get inflight() { return this.coreEvents.inflight; }
  get mobileDesk() { return this.coreEvents.mobileDesk; }
  get relay() { return this.coreEvents.relay; }
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
  get memoryWatch() { return this.coreWatch.memoryWatch; }
  set memoryWatch(value: CoreWatch["memoryWatch"]) { this.coreWatch.memoryWatch = value; }
  get memoryFiles() { return this.coreWatch.memoryFiles; }
  readonly plugins: Plugins;
  get projectFiles() { return this.coreProjects.projectFiles; }
  /** Files waiting in each bot's input box. */
  readonly pending: PendingFiles;
  /** The Storage tab's dragged-in files, by bot (references only; storage.ts). */
  readonly storage: StorageBook;
  readonly maintainer: MaintainerDesk;
  /** The public plugin catalog (Explore, Updates on the Plugins page). */
  readonly pluginStore: PluginStore;
  private get lastPlugins() { return this.coreWatch.lastPlugins; }
  private set lastPlugins(value: CoreWatch["lastPlugins"]) { this.coreWatch.lastPlugins = value; }
  private get loadedClaudeParts() { return this.coreWatch.loadedClaudeParts; }
  private set loadedClaudeParts(value: CoreWatch["loadedClaudeParts"]) { this.coreWatch.loadedClaudeParts = value; }
  /** Bots answering in chats that are not their own: call-ins and bots' @ (Phase 4c). */
  readonly conversations: Conversations;

  mainBot(): Bot | null {
    if (!this.runMainBot) return null;
    const bot = this.bots.get(this.mainBotId);
    return bot?.profile.role === "main" ? bot : null;
  }

  isMainBotId(id: string): boolean {
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

  memoryTargets(...a: Parameters<CoreWatch["memoryTargets"]>) { return this.coreWatch.memoryTargets(...a); }

  componentsTick(...a: Parameters<CoreWatch["componentsTick"]>) { return this.coreWatch.componentsTick(...a); }

  scanComponents(...a: Parameters<CoreWatch["scanComponents"]>) { return this.coreWatch.scanComponents(...a); }

  pinOwner(...a: Parameters<CoreWatch["pinOwner"]>) { return this.coreWatch.pinOwner(...a); }

  reportComponent(...a: Parameters<CoreWatch["reportComponent"]>) { return this.coreWatch.reportComponent(...a); }

  private followClaudeParts(...a: Parameters<CoreWatch["followClaudeParts"]>) { return this.coreWatch.followClaudeParts(...a); }

  checkStalls(...a: Parameters<CoreWatch["checkStalls"]>) { return this.coreWatch.checkStalls(...a); }

  private watchRuns(...a: Parameters<CoreWatch["watchRuns"]>) { return this.coreWatch.watchRuns(...a); }


  checkNetwork(...a: Parameters<CoreWatch["checkNetwork"]>) { return this.coreWatch.checkNetwork(...a); }

  private developerBriefing(...a: Parameters<CoreWatch["developerBriefing"]>) { return this.coreWatch.developerBriefing(...a); }

  developerProject(...a: Parameters<CoreWatch["developerProject"]>) { return this.coreWatch.developerProject(...a); }

  reportFeedback(...a: Parameters<CoreWatch["reportFeedback"]>) { return this.coreWatch.reportFeedback(...a); }

  componentInfos(...a: Parameters<CoreWatch["componentInfos"]>) { return this.coreWatch.componentInfos(...a); }

  checkRoutines(...a: Parameters<CoreWatch["checkRoutines"]>) { return this.coreWatch.checkRoutines(...a); }

  projectBriefing(...a: Parameters<CorePeerInbox["projectBriefing"]>) { return this.corePeerInbox.projectBriefing(...a); }

  peerBots(...a: Parameters<CorePeerInbox["peerBots"]>) { return this.corePeerInbox.peerBots(...a); }



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

  subBotReplied(...a: Parameters<CoreSubBots["subBotReplied"]>) { return this.coreSubBots.subBotReplied(...a); }

  private storeOf(...a: Parameters<CoreBots["storeOf"]>) { return this.coreBots.storeOf(...a); }

  singleEngine(...a: Parameters<CoreBots["singleEngine"]>) { return this.coreBots.singleEngine(...a); }

  seedEngineDefaults(...a: Parameters<CoreBots["seedEngineDefaults"]>) { return this.coreBots.seedEngineDefaults(...a); }

  attach(...a: Parameters<CoreBots["attach"]>) { return this.coreBots.attach(...a); }

  machineNamed(...a: Parameters<CoreBots["machineNamed"]>) { return this.coreBots.machineNamed(...a); }

  tellMain(...a: Parameters<CoreBots["tellMain"]>) { return this.coreBots.tellMain(...a); }

  botRequestedOn(...a: Parameters<CoreCopies["botRequestedOn"]>) { return this.coreCopies.botRequestedOn(...a); }
  peerBotFor(...a: Parameters<CoreCopies["peerBotFor"]>) { return this.coreCopies.peerBotFor(...a); }
  ignoreWaitingOn(...a: Parameters<CoreCopies["ignoreWaitingOn"]>) { return this.coreCopies.ignoreWaitingOn(...a); }

  botRequested(...a: Parameters<CoreBots["botRequested"]>) { return this.coreBots.botRequested(...a); }

  removeBot(...a: Parameters<CoreBots["removeBot"]>) { return this.coreBots.removeBot(...a); }

  showOpenQuestion(...a: Parameters<CoreCopies["showOpenQuestion"]>) { return this.coreCopies.showOpenQuestion(...a); }
  ignoreQuestion(...a: Parameters<CoreCopies["ignoreQuestion"]>) { return this.coreCopies.ignoreQuestion(...a); }
  closeCopiesOf(...a: Parameters<CoreCopies["closeCopiesOf"]>) { return this.coreCopies.closeCopiesOf(...a); }

  deliverInboxes(...a: Parameters<CorePeerInbox["deliverInboxes"]>) { return this.corePeerInbox.deliverInboxes(...a); }



  /**
   * What waits on you (`refreshWaiting`): each bot's latest open question in its own chat, else its
   * memory's "Waiting on you"; then the main bot's own questions; without what you set aside.
   */
  serverAsk(...a: Parameters<CoreCopies["serverAsk"]>) { return this.coreCopies.serverAsk(...a); }
  serverAskClosed(...a: Parameters<CoreCopies["serverAskClosed"]>) { return this.coreCopies.serverAskClosed(...a); }

  waiting(...a: Parameters<CoreWaiting["waiting"]>) { return this.coreWaiting.waiting(...a); }
  outId(...a: Parameters<CoreWaiting["outId"]>) { return this.coreWaiting.outId(...a); }
  workspaceSource(...a: Parameters<CoreWaiting["workspaceSource"]>) { return this.coreWaiting.workspaceSource(...a); }
  watchWorkspace(...a: Parameters<CoreWaiting["watchWorkspace"]>) { return this.coreWaiting.watchWorkspace(...a); }
  checkWorkspaceSoon(...a: Parameters<CoreWaiting["checkWorkspaceSoon"]>) { return this.coreWaiting.checkWorkspaceSoon(...a); }
  refreshWaiting(...a: Parameters<CoreWaiting["refreshWaiting"]>) { return this.coreWaiting.refreshWaiting(...a); }
  waitingSoon(...a: Parameters<CoreWaiting["waitingSoon"]>) { return this.coreWaiting.waitingSoon(...a); }
  ignoreWaiting(...a: Parameters<CoreWaiting["ignoreWaiting"]>) { return this.coreWaiting.ignoreWaiting(...a); }
  peerMayIgnoreWaiting(...a: Parameters<CoreWaiting["peerMayIgnoreWaiting"]>) { return this.coreWaiting.peerMayIgnoreWaiting(...a); }

  addProject(...a: Parameters<CoreProjects["addProject"]>) { return this.coreProjects.addProject(...a); }

  private projectRequests(...a: Parameters<CoreProjects["projectRequests"]>) { return this.coreProjects.projectRequests(...a); }



  private importOnce(...a: Parameters<CoreProjects["importOnce"]>) { return this.coreProjects.importOnce(...a); }

  log(line: string) {
    this.options.log?.(line);
  }

  studioNow(...a: Parameters<CorePluginSide["studioNow"]>) { return this.corePluginSide.studioNow(...a); }

  pluginBot(...a: Parameters<CorePluginSide["pluginBot"]>) { return this.corePluginSide.pluginBot(...a); }

  pluginEvent(...a: Parameters<CorePluginSide["pluginEvent"]>) { return this.corePluginSide.pluginEvent(...a); }

  activePluginWriter(...a: Parameters<CorePluginSide["activePluginWriter"]>) { return this.corePluginSide.activePluginWriter(...a); }

  botInfo(...a: Parameters<CorePluginSide["botInfo"]>) { return this.corePluginSide.botInfo(...a); }

  replied(...a: Parameters<CorePluginSide["replied"]>) { return this.corePluginSide.replied(...a); }

  serverSend(...a: Parameters<CorePluginSide["serverSend"]>) { return this.corePluginSide.serverSend(...a); }

  serverUserLine(...a: Parameters<CorePluginSide["serverUserLine"]>) { return this.corePluginSide.serverUserLine(...a); }

  serverTurn(...a: Parameters<CorePluginSide["serverTurn"]>) { return this.corePluginSide.serverTurn(...a); }

  serverCallIn(...a: Parameters<CorePluginSide["serverCallIn"]>) { return this.corePluginSide.serverCallIn(...a); }

  hasBot(...a: Parameters<CorePluginSide["hasBot"]>) { return this.corePluginSide.hasBot(...a); }

  botView(...a: Parameters<CorePluginSide["botView"]>) { return this.corePluginSide.botView(...a); }

  serverBotView(...a: Parameters<CorePluginSide["serverBotView"]>) { return this.corePluginSide.serverBotView(...a); }

  botIds(...a: Parameters<CorePluginSide["botIds"]>) { return this.corePluginSide.botIds(...a); }

  reloadPluginSecrets(...a: Parameters<CorePluginSide["reloadPluginSecrets"]>) { return this.corePluginSide.reloadPluginSecrets(...a); }

  pendingFiles(...a: Parameters<CorePluginSide["pendingFiles"]>) { return this.corePluginSide.pendingFiles(...a); }

  checkRemoveBot(...a: Parameters<CorePluginSide["checkRemoveBot"]>) { return this.corePluginSide.checkRemoveBot(...a); }


  applyNow(...a: Parameters<CoreSend["applyNow"]>) { return this.coreSend.applyNow(...a); }

  send(...a: Parameters<CoreSend["send"]>) { return this.coreSend.send(...a); }

  sendWith(...a: Parameters<CoreSend["sendWith"]>) { return this.coreSend.sendWith(...a); }

  attachmentFile(...a: Parameters<CoreSend["attachmentFile"]>) { return this.coreSend.attachmentFile(...a); }

  settingsFile(...a: Parameters<CoreSend["settingsFile"]>) { return this.coreSend.settingsFile(...a); }

  settings(...a: Parameters<CoreSend["settings"]>) { return this.coreSend.settings(...a); }

  language(...a: Parameters<CoreSend["language"]>) { return this.coreSend.language(...a); }

  prompts(...a: Parameters<CoreSend["prompts"]>) { return this.coreSend.prompts(...a); }

  promptSections(...a: Parameters<CoreSend["promptSections"]>) { return this.coreSend.promptSections(...a); }

  agentWiring(...a: Parameters<CoreSend["agentWiring"]>) { return this.coreSend.agentWiring(...a); }

  skillPlace(...a: Parameters<CoreSend["skillPlace"]>) { return this.coreSend.skillPlace(...a); }

  commandGuide(...a: Parameters<CoreSend["commandGuide"]>) { return this.coreSend.commandGuide(...a); }


  event(...a: Parameters<CoreEvents["event"]>) { return this.coreEvents.event(...a); }

  onChange(...a: Parameters<CoreEvents["onChange"]>) { return this.coreEvents.onChange(...a); }

  attachMobile(...a: Parameters<CoreEvents["attachMobile"]>) { return this.coreEvents.attachMobile(...a); }

  mobileOr(...a: Parameters<CoreEvents["mobileOr"]>) { return this.coreEvents.mobileOr(...a); }

  attachRelay(...a: Parameters<CoreEvents["attachRelay"]>) { return this.coreEvents.attachRelay(...a); }

  mobileView(...a: Parameters<CoreEvents["mobileView"]>) { return this.coreEvents.mobileView(...a); }

  machinesView(...a: Parameters<CoreEvents["machinesView"]>) { return this.coreEvents.machinesView(...a); }

  machinesOr(...a: Parameters<CoreEvents["machinesOr"]>) { return this.coreEvents.machinesOr(...a); }

  mobileCommand(...a: Parameters<CoreEvents["mobileCommand"]>) { return this.coreEvents.mobileCommand(...a); }

  receive(...a: Parameters<CoreEvents["receive"]>) { return this.coreEvents.receive(...a); }

  calledInPick(...a: Parameters<CoreCopies["calledInPick"]>) { return this.coreCopies.calledInPick(...a); }
  calledInAnswer(...a: Parameters<CoreCopies["calledInAnswer"]>) { return this.coreCopies.calledInAnswer(...a); }
  closeRelayedCopies(...a: Parameters<CoreCopies["closeRelayedCopies"]>) { return this.coreCopies.closeRelayedCopies(...a); }
  calledInGroupAnswer(...a: Parameters<CoreCopies["calledInGroupAnswer"]>) { return this.coreCopies.calledInGroupAnswer(...a); }
  bot(...a: Parameters<CoreCopies["bot"]>) { return this.coreCopies.bot(...a); }

  private madeCommands?: CoreCommands;
  private get coreCommands(): CoreCommands { return (this.madeCommands ??= new CoreCommands(this)); }
  get shownChat() { return this.coreCommands.shownChat; }
  private handle(...a: Parameters<CoreCommands["handle"]>) { return this.coreCommands.handle(...a); }
  snapshot(...a: Parameters<CoreCommands["snapshot"]>) { return this.coreCommands.snapshot(...a); }
  settingsNow(...a: Parameters<CoreCommands["settingsNow"]>) { return this.coreCommands.settingsNow(...a); }
  changeSetting(...a: Parameters<CoreCommands["changeSetting"]>) { return this.coreCommands.changeSetting(...a); }

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
