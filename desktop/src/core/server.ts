import { agyPermissionSessions, changeAgyPermissions } from "./agent/agy-permissions";
import type { ModelDiscovery, ModelEngine } from "../contract/model-discovery";
import { discoveryFailure } from "./agent/model-discovery";
import { ProjectFiles } from "./project-files";
import { RestartJournal } from './restart-continuation';
import { AgyRuntimeInstaller } from './agy-runtime-install';
import { agyRuntimeStatus, validateAgyRuntimePath } from "./agy-runtime-settings";
import type { AgyConfig } from "./agent/agy";
import { mobileCommand } from '../mobile-bridge/adapter';
import { MobileDesk, OFF as MOBILE_OFF } from '../mobile-bridge/desk';
// The core: owns every bot's chat and head, and answers the contract's commands. It is
// transport-agnostic: `receive` takes whatever arrived, `emit` is where answers and events go. It
// validates everything it receives itself — main validating first is defense in depth, not the
// reason the core is safe.
//
// Its data folder has the Swift app's layout (store/workspace.ts). On the first start with an
// empty folder it imports a 1.x folder when one is given (read-only; store/importer.ts).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { writeFileAtomic } from "./durable/atomic";
import { rmSync } from "node:fs";
import { PendingFiles, servedType, writeIncoming } from "./attachments";
import { safeName } from "./components/library";
import { SpecDesk } from "./spec-desk";
import type { CodexModel } from "./agent/codex-models";
import { appendFeedback, FEEDBACK_NO_WORDS } from "./feedback";
import { archiveEntry } from "./briefing";
import { fileURLToPath } from "node:url";
import { botChoicesFromDefaults, engineDefaultsFor } from "./engine-defaults";
import { appliedCodexWorkers, applySetting, claudeWorkersMode, codexWorkersJSON, launchSettings, readSettings, readSettingsList, seedEngineDefaults, settingsView, writeSettings } from "./settings";
import { HANDED_OUT, botName, childFolders, defaultName, firstLine, folderPath, folderURLText, MemoryFiles, nextAvatar, prepareNotesFolder, projectBriefingText, projectFolders, removeProjectRow, saveProjectRow, type BriefingRow } from "./projects";
import { answerLabel } from "./attachments";
import {
  ContractError, PROTOCOL_VERSION, errorResponse, okResponse, parseInbound,
  type Command, type Event, type ImportView, type Outbound, type ResultOf, type WaitingView, type WhiteboardView,
  type SettingsChange, type SettingsView, type SpecAction, type SubagentRowView, type AgentTargetView,
} from "../contract";
import { AgentRegistry, isDetached, newMoveId, rowStatus, TERMINAL_STATES, type AgentPort, type AgentRecord, type ApprovalAnswerer, type HostFacts, type MoveIntent, type ReconcileReport, type WorkerApproval } from "./agent-registry";
import { AgentStore, migrationRecords } from "./store/agent-store";
import { planMove, unmovable, type BotFacts, type MoveFacts, type MoveTarget } from "./agent-moves";
import { agentMessageNotice, agentReportNote, agentToldOfMove, backNote, handedNote, handedNotice, hostLostNotice, movedAwayNote, movedAwayNotice, notOwnedNote, ownedAgentsBriefing, ownerGoneNotice, queuedSentNotice, subBotAdoptedFirstMessage, subBotClosedNotice, subBotGroupFirstMessage } from "./agent-relay";
import type { WorkerOwner } from "./agent/workers";
import { AgentStatusWriter } from "./agent-status";
import { filePath, pageInCard } from "./specs";
import { PAGE_COMPONENT } from "./preview-url";
import { Bot, NO_LONGER_NEEDED, type SessionStart, type SessionStartCodex } from "./bot";
import type { HeadConfig } from "./agent/head";
import { CodexThreads, type CodexHeadConfig } from "./agent/codex";
import { maintainerEditorBinding } from "./agent/component-editor";
import { headsJSON, singleHead, type Engine, type Heads } from "./heads";
import { botPrompts, desktopPrompts, isResultPublishing, preferredLanguage, savedLanguage, type BotPrompts, type ReportTool } from "./prompts";
import { BotStore, readJSON } from "./store/bot-store";
import { ProcessLedger } from "./process/ledger";
import { Doctor, DoctorModel } from "./doctor";
import { UsageBook, usageView } from "./usage";
import { importFrom1x, importRecord, looksLike1x, needsImport } from "./store/importer";
import { fromSwiftDate, isOpenQuestion, MAIN_BOT_ID } from "./store/records";
import { botDescription, latestAction } from "./whiteboard-data";
import { Layout, loadProfiles, projectProfile, type BotProfile } from "./store/workspace";
import { unsupportedRequest, type BotRequest } from "./reply";
import { handoffFile, progressFile, progressStatus, runHandoff, fallbackHandoff, subBotBriefing, subBotFirstMessage, subBotDirectFirstMessage, directSubBotEngine, SUB_BOT_WAIT_MS, safeToken, subBotEngine, wrapUpMessage } from "./sub-bots";
import { Conversations } from "./conversations";
import { answeredNote, pickedNote, type GROUP_TIMING } from "./groups";
import { CatchUpCache, CatchUps, catchUpSettings, type CatchUpViewData, type Summarizer } from "./catchup";
import { ComponentsContext } from "./components/service";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { FolderWatch, type WatchTarget } from "./folder-watch";
import { probeNetwork } from "./network-resume";
import { Plugins, type BotInfo } from "./plugins";
import type { HostCommand, HostTiming } from "./plugins/host-client";
import type { Sealer } from "./plugins/secrets";
import { MaintainerDesk, builtInManifest, maintainerProfile, prepareLibrary, MAINTAINER_ID } from "./maintainer";
import { maintainerInstructions } from "./maintainer-text";
import type { ChatRecord } from "./store/records";
import { WorktreeDesk } from "./worktree-desk";
import { DevBuilds, devWorkRoot, readBuild, spawnInstaller } from "./app-swap";

/** What the core asks of main (app-swap.ts); planBuild and installBuild carry a build's path. */
export type AppOp = "screenshot" | "quit" | "installRelease";
export interface AppAnswer { ok: boolean; file?: string; error?: string; plan?: unknown }
import { discardHandover, drainBots, takeHandover, writeHandover } from "./hot-swap";

export interface CoreOptions {
  quotaRetriever?: import("./quota").QuotaRetriever;
  /** Read-only CLI self-check; production starts it offline after activation. */
  doctor?: Doctor;
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
  /** How often routines are checked (1.x: every 30 s); 0: never (tests drive `checkRoutines`). */
  routineTickMs?: number;
  /** How often quiet runs (and, in 1.x, the network) are looked at (1.x: 20 s; 0: never). */
  watchMs?: number;
  /** How long one of Settings' reminder minutes is (tests shorten it; 60 s). */
  stallMinuteMs?: number;
  /** Whether Claude's API answers again (1.x's `networkProbe`; tests replace it). */
  networkProbe?: () => Promise<boolean>;
  /** Writes Catch-up summaries (an isolated `codex exec`); null: there is no summary service. */
  summarizer?: Summarizer | null;
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
  plugins?: { node: HostCommand | null; hostScript: string; sealer: Sealer | null; timing?: HostTiming } | null;
  /** Maintainer's `ccb plugin check` command (null: none this time). */
  checkCommand?: string | null;
  /** The component-shot command Maintainer is given (Phase 5a; null: none, it reads the template). */
  shotCommand?: string | null;
  /** The report command and its guide every bot is told to build report pages with (null: not told). */
  reports?: ReportTool | null;
  /** Tests: how long the first chat.snapshot is held (the page then shows its input box before any state). */
  firstSnapshotDelayMs?: number;
  /**
   * The app around the core, for developer mode's <install-build> and <app-screenshot/> (app-swap.ts):
   * main's pid and data folder, the app bundle it runs from (null: not a bundle), and what main does on
   * request: a picture of its window, or quitting so the install script can swap the build. Null: no app.
   */
  app?: {
    pid: number | null;
    dataDir: string | null;
    bundle: string | null;
    request: (op: AppOp, args?: Record<string, string>) => Promise<AppAnswer>;
  } | null;
}

/** What asking for a bot came to (`Workspace.BotMaking`). */
export type BotMaking = { kind: "made"; botId: string } | { kind: "existing"; botId: string } | { kind: "empty" } | { kind: "taken" } | { kind: "removedByUser" };

export class Core {
  readonly doctor: DoctorModel;
  private agyInstaller = new AgyRuntimeInstaller();
  readonly epoch = randomUUID().slice(0, 18);
  private seq = 0;
  private activated = false;
  private bots = new Map<string, Bot>();
  private order: string[] = [];
  private inflight = new Map<string, AbortController>();
  private readonly ledger: ProcessLedger;
  /** What the bots used and the subscriptions' limits (spending.json, rate-limits.json, codex-rate-limits.json; Phase 5c). */
  private readonly usage: UsageBook;
  private imported: ImportView | null = null;
  private routineClock: NodeJS.Timeout | null = null;
  private watchClock: NodeJS.Timeout | null = null;
  private readonly catchUps: CatchUps;
  private readonly components: ComponentsContext;
  private componentStamp = 0;
  /** Developer mode's builds and screenshots (1.x's Workspace+Developer.swift). */
  readonly devBuilds: DevBuilds;
  readonly worktrees: WorktreeDesk;
  /** The plugin and component library, watched (`scanComponents` on a change, and every `componentScanMs`). */
  private libraryWatch: FolderWatch | null = null;
  /** Bots' memory files, watched (`refreshWaiting` on a change, and every `waitingScanMs`). */
  private memoryWatch: FolderWatch | null = null;
  /** memory.md files, read again only when they change (what waits on you, the whiteboard). */
  private readonly memoryFiles = new MemoryFiles();
  /** The whiteboard as last answered, and a number that moves when it changes (`whiteboardView`). */
  private whiteboardText = "";
  private whiteboardStamp = 0;
  private pinClock: NodeJS.Timeout | null = null;
  /** The pins the user can see now, in the chat on screen (`RefreshSight`). */
  private visiblePins: { botId: string; ids: string[] } | null = null;
  readonly plugins: Plugins;
  /** Every bot's profile, in the left column's order (Maintainer last). */
  private profiles: BotProfile[] = [];
  private readonly projectFiles = new ProjectFiles();
  private newBot!: (profile: BotProfile) => Bot;
  /** "Add as project?" cards waiting for your pick, by their line in the main chat. */
  private projectQuestions = new Map<string, { folder: string; task: string }[]>();
  /** What waits on you as the windows were last told, and the timers that look again. */
  private lastWaiting = "";
  private waitingTimer: NodeJS.Timeout | null = null;
  /** Files waiting in each bot's input box. */
  readonly pending: PendingFiles;
  readonly maintainer: MaintainerDesk;
  /** Components made from replies (Phase 5a, 1.x's Workspace+Specs). */
  readonly specs: SpecDesk;
  private lastPlugins = "";
  /** The plugins' Claude parts as bots last heard of them (`followClaudeParts`). */
  private loadedClaudeParts = "[]";
  /** Whether the first chat.snapshot was held already (`firstSnapshotDelayMs`). */
  private snapshotHeld = false;
  /** Bots answering in chats that are not their own: call-ins and bots' @ (Phase 4c). */
  readonly conversations: Conversations;
  /** Bots taken out of the left column: what they still say goes nowhere. */
  private removed = new Set<string>();
  /** Bots plugins made that you removed (`plugin/name`, lower case; removed-bots.json), so they stay removed. */
  private removedPluginBots = new Set<string>();
  /** <open-question> copies in the main bot's chat: the copy's id → the question it copies. */
  private copies = new Map<string, { botId: string; questionId: string }>();
  /** The app-wide agent registry (agents.json, A1): who owns each agent apart from who runs it. */
  readonly agents!: AgentRegistry;
  private readonly agentStatus = new AgentStatusWriter();
  /** What the constructor's reconcile found, told once the core is active (a candidate start changes nothing outside the data folder). */
  private agentReconcile: ReconcileReport | null = null;
  private flagCache: { at: number; agentMoves: boolean; claudeOwnerMoves: boolean } | null = null;

  constructor(private options: CoreOptions) {
    this.doctor = new DoctorModel(options.doctor ?? new Doctor({ agy: () => agyRuntimeStatus(readSettings(Layout.settings(options.dataDir)), options.dataDir) }), doctor => this.event({ type: "doctor.updated", doctor }));
    mkdirSync(options.dataDir, { recursive: true });
    this.pending = new PendingFiles(join(options.dataDir, "incoming"), (botId, files) => this.event({ type: "files.updated", botId, files }));
    this.catchUps = new CatchUps({
      cache: new CatchUpCache(join(options.dataDir, "catchup-summaries.json")),
      summarizer: options.summarizer ?? null,
      settings: () => catchUpSettings(this.settingsFile()),
      language: () => this.language(),
      changed: (botId) => { const bot = this.bots.get(botId); if (bot) this.event({ type: "catchup.updated", botId, ...this.summaries(bot) }); },
    });
    // The component library: <data>/plugins/ccb-components/components first, then other plugins' components/.
    const plugins = join(options.dataDir, "plugins");
    const own = join(plugins, "ccb-components", "components");
    this.components = new ComponentsContext(options.dataDir, () => {
      let others: string[] = [];
      try { others = readdirSync(plugins).filter((name) => name !== "ccb-components" && !name.startsWith(".")).sort().map((name) => join(plugins, name, "components")); } catch { /* none */ }
      return [own, ...others];
    });
    this.componentStamp = this.components.library.stamp;
    this.components.commands.onChange = (card) => { for (const bot of this.bots.values()) bot.cardChanged(card); this.specs?.cardChanged(card); };
    this.ledger = new ProcessLedger(join(options.dataDir, "children.json"));
    const leftovers = this.ledger.endLeftovers();
    if (leftovers.length) this.log(`ended agent process groups an earlier core left running: ${leftovers.join(", ")}`);
    this.importOnce();
    // Quota files must be imported before their first in-memory reading.
    this.usage = new UsageBook(options.dataDir, undefined, undefined, options.quotaRetriever);
    const loaded = loadProfiles(options.dataDir);
    if (loaded.problem) this.log(`projects: ${loaded.problem}`);
    // Maintainer (1.x's built-in project): the plugin library is its folder, with the app's files in it.
    // 1.x's key is componentEditorModel (2.0 before Phase 4a read componentEditor: both are honoured).
    const editorModel = this.settingsFile()?.componentEditorModel ?? this.settingsFile()?.componentEditor;
    const { editedEditor } = prepareLibrary(options.dataDir, typeof editorModel === "string" && ["sonnet", "opus", "haiku"].includes(editorModel) ? editorModel : "sonnet");
    if (editedEditor) this.log("ccb-core/claude/agents/component-editor.md was edited by hand; it is left as it is");
    // The library has the app's own preview card now (seeded just above).
    if (this.components.library.rescan()) this.componentStamp = this.components.library.stamp;
    try {
      const removed = readJSON(join(options.dataDir, "removed-bots.json"));
      if (Array.isArray(removed)) for (const key of removed) if (typeof key === "string") this.removedPluginBots.add(key);
    } catch { /* none */ }
    const appMaintainer = maintainerProfile(options.dataDir, maintainerInstructions(join(options.dataDir, "plugins"), options.checkCommand ?? null, options.shotCommand ?? null));
    const profiles = [...loaded.profiles, appMaintainer];
    const editorBinding = maintainerEditorBinding(appMaintainer, options.dataDir, options.headConfig);
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
    this.worktrees = new WorktreeDesk({
      dataDir: options.dataDir,
      settings: () => { const view = settingsView(readSettings(Layout.settings(options.dataDir))); return { enabled: view.worktrees, root: view.worktreeRoot }; },
      devWork: () => devWorkRoot(),
      isDeveloper: (botId) => this.developerProject()?.id === botId,
      // The folder its session starts in changed: an awake one starts again before its next message.
      moved: (botId, reason) => this.bots.get(botId)?.restartBeforeNextMessage(reason),
    });
    this.newBot = (profile) => {
      const bot = build(profile);
      this.bots.set(profile.id, bot);
      return bot;
    };
    const build = (profile: BotProfile): Bot => {
      const bot: Bot = new Bot({
        profile,
        deferStartup: options.deferStartup && !this.activated,
        headConfig: options.headConfig,
        agyConfig: options.agyConfig,
        codexConfig: codexConfig ? (p, session) => ({
          ...codexConfig(p, session, threads),
          componentEditor: editorBinding(p, session),
          editorStarted: (pid) => { if (pid > 0) this.ledger.record(pid); },
        }) : null,
        claimWaitMs: options.claimWaitMs,
        prompts: (engine, heads) => this.prompts(profile, engine, heads, profile.role === "main" || profile.id === MAINTAINER_ID ? null : this.worktrees.sessionFolder(profile)),
        // A project's manager works in the user's own folder, shared with 1.x: one Botling at a time.
        tidyTimeoutMs: options.tidyTimeoutMs,
        quitTidyMs: options.quitTidyMs,
        ledger: this.ledger,
        emit: (event) => this.event(event),
        log: (line) => this.log(line),
        approvalTimeoutMs: options.approvalTimeoutMs ?? 10 * 60_000,
        idleMs: options.idleMs ?? 50 * 60_000,
        interruptGraceMs: options.interruptGraceMs ?? 2_000,
        welcome: profile.id === MAIN_BOT_ID && !this.imported,
        projectBriefing: profile.role === "main" ? () => this.projectBriefing() : undefined,
        // The main bot wakes with the project list (`mainBot.wakeNote`) and may write every inbox (`--add-dir`).
        wakeNote: profile.role === "main" ? () => this.projectBriefing()
          // The developer project's manager hears what developer mode lets it do (`developerBriefing`).
          : profile.id !== MAINTAINER_ID
            ? () => [profile.role === "manager" ? this.devBuilds.briefing(bot, this.worktrees.current(profile) !== null) : "", this.worktrees.note(profile), this.subBotNote(profile), this.ownedAgentsNote(profile)].filter(Boolean).join("\n\n")
            : undefined,
        worktree: profile.role === "main" || profile.id === MAINTAINER_ID ? undefined : () => {
          const cwd = this.worktrees.sessionFolder(profile);
          return cwd === profile.folder ? null : { cwd, addDirs: this.worktrees.extraDirs(profile) };
        },
        addDirs: profile.role === "main" ? () => this.profiles.filter((other) => other.role !== "main" && !other.parent && !other.problem).map((other) => join(other.folder, ".bot"))
          // Maintainer: the folders you let it read (<need-folder>).
          : profile.id === MAINTAINER_ID ? () => this.maintainer.approvedFolders() : undefined,
        subBotRows: profile.role === "main" || profile.id === MAINTAINER_ID ? undefined : () => this.subBotRows(profile.id),
        components: this.components,
        onRequests: (bot, requests) => this.maintainer.handle(bot, this.projectRequests(bot, requests)),
        // What each turn used, by bot, and the subscriptions' limits (1.x's `record`, `note`).
        usage: (name, spent, tokens) => this.usage.record(spent, tokens, name),
        rateLimits: (engine, limits) => this.usage.note(engine, limits),
        // A reply's spec chips and its own component (Phase 5a).
        lineExtras: (bot, record) => this.specs?.lineExtras(bot, record) ?? {},
        specsChanged: (bot) => this.specs?.specsChanged(bot),
        replyFilter: (): ((text: string) => Promise<string>) | null => this.plugins.afterReplyFilter(() => this.botInfo(bot)),
        replied: (bot, record) => this.replied(bot, record),
        plugins: () => ({ dirs: this.plugins.registry.claudeDirectories(), env: this.plugins.registry.secretEnvironment(), tools: this.plugins.registry.claudeTools() }),
        pluginStamp: () => this.plugins.registry.claudeStamp(),
        launch: () => launchSettings(readSettings(Layout.settings(this.options.dataDir))),
        // (Asked while the bots are made, before the conversations exist.)
        guest: () => this.conversations?.speakers.get(profile.id) ?? null,
        agents: this.agentPort(profile),
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
      mainBotId: MAIN_BOT_ID,
      mentionNote: (text) => this.components.library.mentionNote(text),
      replied: (bot, line) => this.replied(bot, line),
      replyFilter: (bot) => this.plugins.afterReplyFilter(() => this.botInfo(bot)),
      handle: (bot, requests) => {
        const left = this.maintainer.handle(bot, this.projectRequests(bot, requests));
        if (left.length) bot.appNotice(`Botling 2.0 cannot do this yet, so nothing happened: ${[...new Set(left.map(unsupportedRequest))].join("; ")}.`);
      },
      afterMainTurn: () => this.deliverInboxes(),
      speaking: (chatId) => this.bots.get(chatId)?.refresh(),
      refreshWaiting: () => this.refreshWaiting(),
      log: (line) => this.log(line),
      timing: options.groupTiming,
    });
    this.maintainer = new MaintainerDesk({
      root: options.dataDir,
      maintainer: () => this.bots.get(MAINTAINER_ID) ?? null,
      mainBot: () => this.bots.get(MAIN_BOT_ID)!,
      bots: () => [...this.bots.values()],
      library: this.components.library,
      plugins: () => this.plugins,
      rescan: () => this.scanComponents(),
      log: (line) => this.log(`maintainer: ${line}`),
    });
    this.specs = new SpecDesk({
      // Every chat a spec can be in (`chatsWithPins`).
      chats: () => [...this.order.flatMap((id) => (this.removed.has(id) ? [] : [this.bots.get(id)!]))],
      library: this.components.library,
      commands: this.components.commands,
      maintainer: this.maintainer,
      maintainerBot: () => this.bots.get(MAINTAINER_ID) ?? null,
      member: (id) => (this.removed.has(id) ? null : this.bots.get(id) ?? null),
      bots: () => this.order.filter((id) => id !== MAINTAINER_ID && !this.removed.has(id) && !this.isSubBot(id)).map((id) => this.bots.get(id)!),
      emit: (spec) => this.event({ type: "spec.updated", spec }),
      componentsChanged: () => this.componentsTick(),
      clock: () => ({}),
      log: (line) => this.log(`specs: ${line}`),
    });
    const host = options.plugins ?? null;
    this.plugins = new Plugins({
      dataDir: options.dataDir,
      node: host?.node ?? null,
      hostScript: host?.hostScript ?? "",
      sealer: host?.sealer ?? null,
      timing: host?.timing,
      onPid: (pid, alive) => (alive ? this.ledger.record(pid) : this.ledger.forget(pid)),
      world: {
        bots: () => this.order.filter((id) => !this.isSubBot(id)).map((id) => this.botInfo(this.bots.get(id)!)),
        send: (botId, text) => {
          const bot = this.bots.get(botId === "main" ? MAIN_BOT_ID : botId);
          try { bot?.send(text); } catch (error) { this.log(`plugin message to ${botId}: ${(error as Error).message}`); }
        },
        notice: (text) => this.bots.get(MAIN_BOT_ID)?.appNotice(text),
        createBot: (plugin, title, name, job, avatar) => {
          const made = this.makeBot(name, job, { avatar, by: `plugin "${title}"`, plugin });
          if (made.kind === "empty") throw new Error("A bot needs a name and a job.");
          if (made.kind === "taken") throw new Error(`The name "${name}" is taken (by another bot, a project, or the app).`);
          if (made.kind === "removedByUser") throw new Error(`The user removed the bot "${name}"; it is not made again.`);
          const bot = this.bots.get(made.botId);
          if (!bot) throw new Error("The bot could not be started.");
          return { ...this.botInfo(bot), created: made.kind === "made" };
        },
        addRoutine: (botId, cron, task) => {
          const bot = this.bots.get(botId === "main" ? MAIN_BOT_ID : botId);
          if (!bot) return "no-bot";
          return bot.addRoutine(cron, task) ? "added" : "bad-schedule";
        },
        changed: (view) => {
          this.followClaudeParts();
          const text = JSON.stringify(view);
          if (text === this.lastPlugins) return;
          this.lastPlugins = text;
          this.event({ type: "plugins.updated", plugins: view });
        },
        broken: (plugin, problem) => this.maintainer.broken(plugin, problem),
        log: (line) => this.log(line),
      },
    });
    // What the snapshot shows already is no event (an event comes only when something changes).
    this.lastPlugins = JSON.stringify(this.plugins.view());
    this.loadedClaudeParts = JSON.stringify(this.plugins.registry.claudeStamp());
    const app = options.app ?? null;
    this.devBuilds = new DevBuilds({
      root: options.dataDir,
      // Read each time: a hot install changes the bundle on disk under a running core.
      runningBuild: () => (app?.bundle ? readBuild(app.bundle) : null),
      developer: () => this.developerProject(),
      developerMode: () => settingsView(readSettings(Layout.settings(options.dataDir))).developerMode,
      mainBot: () => this.bots.get(MAIN_BOT_ID)!,
      bot: (id) => (this.removed.has(id) ? null : this.bots.get(id) ?? null),
      appPid: app?.pid ?? null,
      appDataDir: app?.dataDir ?? null,
      devWork: () => devWorkRoot(),
      launchInstaller: (command, log) => {
        // Running work resumes on the new build (restart-continuation.ts); a failed checkpoint stops the install.
        this.prepareRestart();
        try { spawnInstaller(command, log); } catch (error) { this.cancelRestart(); throw error; }
        // Bots write their notes as the app quits; the script waits for that.
        void app?.request("quit");
      },
      installRelease: app ? () => app.request("installRelease") : undefined,
      captureWindow: async () => {
        if (!app) return null;
        try { const answer = await app.request("screenshot"); return answer.ok && answer.file ? answer.file : null; } catch { return null; }
      },
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
      (bot ?? this.bots.get(MAIN_BOT_ID))?.appNotice(`Restart continuation paused (${entry.engine}, ${entry.botId}): ${reason}`);
      this.log(`restart ${entry.botId}: ${reason}`);
    }); } catch(error){
      this.log(String(error));
      this.bots.get(MAIN_BOT_ID)?.appNotice("Restart continuation could not be read. The checkpoint is preserved; no recovery prompt was sent. Reconcile it before retrying.");
    }
    // After restart recovery: the registry again, and what it found told (moves cut short finish their notices).
    try { this.reconcileAgents(true); } catch (error) { this.log(`agents reconcile: ${(error as Error).message}`); }
    const options = this.options;
    // How an install of a developer build went (`checkSelfUpdate`).
    try { this.devBuilds.check(); } catch (error) { this.log(`self-update: ${(error as Error).message}`); }
    void this.plugins.start().catch((error) => this.log(`plugins: ${(error as Error).message}`));
    // Checking a wall-clock time every 30 s (rather than sleeping until it) survives the computer
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
    // Pins refreshed every so often that the user can see run when their time comes (1.x: each second).
    this.pinClock = setInterval(() => {
      const seen = this.visiblePins;
      if (seen) this.bots.get(seen.botId)?.refreshDuePins(seen.ids);
    }, 1_000);
    this.pinClock.unref?.();
    const tick = options.routineTickMs ?? 30_000;
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

  /** What the library watch looks at: the plugin library (with every plugin's components), and plugins linked in from elsewhere. */
  private libraryTargets(): WatchTarget[] {
    const plugins = join(this.options.dataDir, "plugins");
    const targets: WatchTarget[] = [{ path: plugins, recursive: true }];
    let names: string[] = [];
    try { names = readdirSync(plugins); } catch { return targets; }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      try {
        // A recursive watch does not follow a symbolic link: its target is watched on its own.
        if (lstatSync(join(plugins, name)).isSymbolicLink()) targets.push({ path: realpathSync(join(plugins, name)), recursive: true });
      } catch { /* a dangling link: nothing to watch */ }
    }
    return targets;
  }

  /** What the memory watch looks at: each bot's memory.md (not the main bot's: its memory is not on the list). */
  private memoryTargets(): WatchTarget[] {
    return this.profiles.filter((profile) => profile.role !== "main" && !profile.parent && !profile.problem).map((profile) => ({ path: join(profile.folder, profile.memoryPath), file: true }));
  }

  /** The library's state changed in the app (being worked on, reverted): the page hears it now. */
  componentsTick() {
    if (this.components.library.stamp === this.componentStamp) return;
    this.componentStamp = this.components.library.stamp;
    this.event({ type: "components.updated", components: this.componentInfos() });
  }

  /** A template or about.md changed on disk: the page draws it anew; bots hear what changed with their next message. */
  scanComponents() {
    this.plugins.scan();
    const before = this.components.library.names.join("\n");
    const catalogChanged = this.components.library.rescan();
    if (catalogChanged) for (const bot of this.bots.values()) bot.componentsChanged();
    // Components bots asked Maintainer for that are in the library now go on their lists.
    if (catalogChanged || before !== this.components.library.names.join("\n")) {
      this.maintainer.deliverAsked();
      this.specs.finishBuilds();
    }
    if (this.components.library.stamp !== this.componentStamp) {
      this.componentStamp = this.components.library.stamp;
      this.event({ type: "components.updated", components: this.componentInfos() });
    }
  }

  /**
   * A component card's report (1.x's ChatSurface `componentReport`): "Report a problem…" goes to Maintainer
   * as the card's own bot's (a floating card may be another bot's), with its pin and the screenshot kept with
   * that bot; otherwise the user's change request, the screenshot first among the pictures.
   */
  private reportComponent(cmd: Extract<Command, { type: "component.report" }>): boolean {
    const incoming = join(this.options.dataDir, "incoming");
    const pictures = cmd.images.flatMap((image) => writeIncoming(incoming, image.name, image.base64) ?? []);
    const shot = cmd.screenshot ? writeIncoming(incoming, `${safeName(cmd.name) || "component"}.png`, cmd.screenshot) : null;
    try {
      if (cmd.problem) {
        const owner = (cmd.pinId ? [...this.bots.values()].find((bot) => bot.hasPin(cmd.pinId!)) : undefined) ?? this.bot(cmd.botId);
        return this.maintainer.reportProblem(cmd.name, cmd.text, owner, owner.pin(cmd.pinId) ?? owner.pinNamed(cmd.name), shot, pictures);
      }
      const files = [...(shot ? [shot] : []), ...pictures];
      if (!cmd.text.trim() && !files.length) return false;
      this.maintainer.requestComponentChange(cmd.name, cmd.text, "The user", null, files);
      return true;
    } finally {
      for (const file of [...pictures, ...(shot ? [shot] : [])]) rmSync(file, { force: true });
      this.componentsTick();
    }
  }

  /** Something done with a spec (its chip under a reply, its panel); false when there is no such spec. */
  private async specAct(id: string, action: SpecAction): Promise<boolean> {
    const found = this.specs.locate(id.toUpperCase());
    if (!found) return false;
    const { chat, spec } = found;
    switch (action.kind) {
      case "press": this.specs.press(spec.id, chat); break;
      case "open": this.specs.open(spec.id, chat); break;
      case "edit": this.specs.editValue(spec.id, action.key, action.value, chat); break;
      case "answer": this.specs.answer(spec.id, action.question, action.option, chat); break;
      case "say": this.specs.say(spec.id, action.text, action.request ?? null, chat); break;
      case "testRun": void this.specs.testRun(spec.id, chat, action.command, action.folder, !!action.approve); break;
      case "command": void this.specs.runComponent(spec.id, chat, action); break;
      case "build": this.specs.build(spec.id, chat); break;
      case "cancel": this.specs.cancel(spec.id, chat); break;
    }
    return true;
  }

  /**
   * Plugins' Claude parts changed (1.x's `followClaudeParts`): awake bots restart (once they are free: no
   * turn and no subagent at work) so they get the new skills, agents and MCP servers.
   */
  private followClaudeParts() {
    const now = JSON.stringify(this.plugins.registry.claudeStamp());
    if (now === this.loadedClaudeParts) return;
    this.loadedClaudeParts = now;
    for (const bot of this.bots.values()) bot.reloadPlugins();
  }

  /** 1.x's `checkStalls`: each bot (not a partner head) is reminded of a quiet run once per quiet spell. */
  checkStalls(now = Date.now()) {
    const minutes = settingsView(readSettings(Layout.settings(this.options.dataDir))).stallReminderMinutes;
    for (const bot of this.bots.values()) bot.checkStall(now, minutes * (this.options.stallMinuteMs ?? 60_000));
  }

  private watchRuns() {
    void this.checkNetwork();
    this.checkStalls();
  }

  private probing = false;

  /** 1.x's `checkNetwork`: asks the probe only while a bot waits for the network; once it answers, they carry on. */
  async checkNetwork(now?: number) {
    const waiting = [...this.bots.values()].filter((bot) => bot.outage || bot.peers.some(peer => peer.outage));
    if (!waiting.length || this.probing) return;
    this.probing = true;
    try {
      if (!(await (this.options.networkProbe ?? probeNetwork)())) return;
    } finally {
      this.probing = false;
    }
    const date = now ?? Date.now();
    for (const bot of waiting) bot.networkRestored(date);
  }

  /** The project that is Botling's own source, while developer mode is on (`developerProject`). */
  developerProject(): Bot | null {
    const view = settingsView(readSettings(Layout.settings(this.options.dataDir)));
    if (!view.developerMode || !view.developerProject) return null;
    const profile = this.profiles.find((candidate) => candidate.id === view.developerProject && candidate.role === "manager" && candidate.id !== MAINTAINER_ID);
    return profile && !this.removed.has(profile.id) ? this.bots.get(profile.id) ?? null : null;
  }

  /**
   * You flagged a reply as not right (`reportFeedback`): it goes to the developer project with the chat around
   * it, to become a test and a fix; the screenshot (the chat as you saw it) and your pictures are kept in its
   * attachments and listed. Every report is also kept in <data>/feedback.md.
   */
  reportFeedback(text: string, messageId: string, chat: Bot, screenshot: string | null, files: string[]): boolean {
    const developer = this.developerProject();
    const lines = chat.lines();
    const index = lines.findIndex((line) => line.id === messageId);
    if (!developer || index < 0) return false;
    const message = lines[index]!;
    const around = lines.slice(Math.max(0, index - 12), index + 1).flatMap((line) => archiveEntry(line) ?? []).join("\n");
    const steps = message.steps ? "\n\nWhat it did on the way: " + (message.steps as { title?: string }[]).map((step) => step.title ?? "").join(" → ") : "";
    const words = text.trim();
    const pictures: string[] = [];
    if (screenshot) pictures.push("The first attachment is a screenshot of the chat as the user saw it, centered on that reply.");
    if (files.length) pictures.push(`With it the user added ${files.length} picture${files.length === 1 ? "" : "s"} of their own.`);
    const seen = pictures.length ? "\n\n" + pictures.join(" ") : "";
    const name = chat.profile.name;
    const report = `Feedback: the user flagged a reply of ${name} as not right.
What is wrong, in their words: ${words || FEEDBACK_NO_WORDS}

The chat up to that reply, oldest first:
${around}${steps}${seen}

First write a test that shows this, then fix it.`;
    developer.relay(report, { files: [...(screenshot ? [screenshot] : []), ...files], feedback: { about: name, words } });
    const kept = (developer.lines().findLast((line) => line.role === "relay")?.attachments ?? []).map((file) => { try { return fileURLToPath(file.url); } catch { return file.url; } });
    appendFeedback(kept.length ? report + "\n\nAttachments:\n" + kept.map((path) => "- " + path).join("\n") : report, this.options.dataDir);
    chat.appNotice(`Sent to ${developer.profile.name} as feedback.`, undefined, undefined, { sourceID: developer.id });
    return true;
  }

  /** Every library component as the page draws it. */
  private componentInfos(): ResultOf<"chat.snapshot">["components"] {
    const out: ResultOf<"chat.snapshot">["components"] = {};
    for (const name of this.components.library.names) {
      const info = this.components.library.info(name);
      if (info) out[name] = { ...info, template: info.template.slice(0, 1_000_000), sizes: info.sizes.slice(0, 16), title: info.title?.slice(0, 200) ?? null };
    }
    return out;
  }

  /** Every bot's routines that are due run now (`Workspace.checkRoutines`). */
  checkRoutines(now = Date.now()) {
    for (const bot of this.bots.values()) {
      try { bot.checkRoutines(now); } catch (error) { this.log(`routines of ${bot.profile.name}: ${(error as Error).message}`); }
    }
  }

  /**
   * The project list the main bot wakes with and its routines get (`Workspace.projectBriefing`): each
   * project's and bot's memory and inbox file and a question waiting in its own chat, Maintainer's, the
   * <open-question> note when one asks.
   */
  projectBriefing(): string {
    const row = (profile: BotProfile, about: string): BriefingRow => ({
      name: profile.name, about, memory: join(profile.folder, profile.memoryPath), inbox: join(profile.folder, ".bot", "inbox.md"),
      question: this.bots.get(profile.id)?.openQuestion()?.text ?? null,
    });
    const maintainer = this.profiles.find((profile) => profile.id === MAINTAINER_ID) ?? maintainerProfile(this.options.dataDir, "");
    return projectBriefingText({
      projects: this.profiles.filter((profile) => profile.role === "manager" && profile.id !== MAINTAINER_ID).map((profile) => row(profile, `folder ${profile.folder}`)),
      bots: this.profiles.filter((profile) => profile.role === "bot" && !profile.parent).map((profile) => row(profile, firstLine(profile.job ?? ""))),
      maintainer: row(maintainer, "plugin-library extensions and in-chat components only"),
    });
  }

  /** An awake main bot hears about bots made or removed with its next message (`briefAwakeMainBot`). */
  private briefAwakeMainBot() {
    this.bots.get(MAIN_BOT_ID)?.queueNote("(App: The list of projects and bots changed.)\n" + this.projectBriefing());
  }

  /**
   * Makes a bot of its own (`Workspace.makeBot`): a folder under <data>/bots/, a row in the left column,
   * its own memory, inbox and routines like a manager. One by the same name (ignoring case) is given
   * back as it is; a plugin gets back only one it made itself, and never one you removed. `setUp` sends
   * it its job at once, so it introduces itself and writes its routines.
   */
  makeBot(rawName: string, rawJob: string, options: { avatar?: string; setUp?: boolean; by?: string | null; plugin?: string | null } = {}): BotMaking {
    const name = botName(rawName);
    const job = rawJob.trim();
    if (!name || !job) return { kind: "empty" };
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const existing = this.profiles.find((profile) => profile.role === "bot" && !profile.parent && same(profile.name, name));
    if (existing) return !options.plugin || existing.plugin === options.plugin ? { kind: "existing", botId: existing.id } : { kind: "taken" };
    // A name that would pass for someone else in a group chat or in an @.
    const others = ["Main bot", "Maintainer", "User", "App", "Notice", ...this.profiles.filter((profile) => profile.role === "manager").map((profile) => profile.name)];
    if (others.some((other) => same(other, name))) return { kind: "taken" };
    if (options.plugin && this.removedPluginBots.has(`${options.plugin}/${name}`.toLowerCase())) return { kind: "removedByUser" };
    const id = randomUUID().toUpperCase();
    const folder = Layout.standalone(this.options.dataDir, id);
    mkdirSync(folder, { recursive: true });
    const avatar = options.avatar && HANDED_OUT.includes(options.avatar) ? options.avatar : nextAvatar(this.profiles.filter((profile) => profile.role !== "main" && profile.id !== MAINTAINER_ID).map((profile) => profile.avatar));
    prepareNotesFolder(folder);
    this.seedEngineDefaults(id);
    saveProjectRow(this.options.dataDir, { id, name, folder, avatar, job, ...(options.plugin ? { plugin: options.plugin } : {}) });
    const profile = projectProfile(this.options.dataDir, { id, name, folder: folderURLText(folder), avatar, job, ...(options.plugin ? { plugin: options.plugin } : {}) });
    this.attach(profile);
    const main = this.bots.get(MAIN_BOT_ID)!;
    main.appNotice(`${options.by ? `New bot "${name}" (made by ${options.by})` : `New bot "${name}"`}: ${firstLine(job)}`, undefined, undefined, { sourceID: id });
    this.briefAwakeMainBot();
    if (options.setUp) {
      try {
        this.bots.get(id)?.relay(`(App) You were just created. Your job: ${job}\nIf it should happen at fixed times, add those jobs to your routines file now; if it is a report, also do the first one now. Then introduce yourself to the user in one sentence.`);
      } catch (error) { this.log(`new bot ${name}: ${(error as Error).message}`); }
    }
    this.log(`made the bot ${name} (${folder})`);
    return { kind: "made", botId: id };
  }

  /** A sub bot (a hidden bot under a project bot) as opposed to a bot in the left column. */
  private isSubBot(id: string): boolean {
    return Boolean(this.profiles.find((profile) => profile.id === id)?.parent);
  }

  /** The rows a project bot's subagent list shows for its sub bots: each opens as a chat with an input box. */
  private subBotRows(parentId: string): SubagentRowView[] {
    return this.profiles.filter((profile) => profile.parent === parentId && !this.removed.has(profile.id)).map((profile) => ({
      id: profile.id, title: profile.name.slice(0, 400), status: "running" as const, head: "claude" as const, outputTokens: null,
      startedAt: profile.createdAt ?? 0, endedAt: null, unsettledAt: null, settled: false, prompt: (profile.job ?? "").slice(0, 1_000), subBot: profile.id,
    }));
  }

  /** The note a project bot wakes with when it has sub bots: who, and the progress file to read instead of waking them. */
  private subBotNote(profile: BotProfile): string {
    return subBotBriefing(this.profiles.filter((sub) => sub.parent === profile.id && !this.removed.has(sub.id)).map((sub) => {
      const file = progressFile(profile.folder, sub.handoff ?? sub.id);
      let status: string | null = null;
      try { status = progressStatus(readFileSync(file, "utf8")); } catch { /* not written yet */ }
      return { name: sub.name, progress: file, working: Boolean(this.bots.get(sub.id)?.view().working), status };
    }));
  }

  /**
   * A project bot's <sub-bot name="…" subagent="id"/>: the subagent (a Claude subagent, a Codex worker or an Antigravity
   * worker) is asked to write handoff.md and end (Claude: by the project bot's own SendMessage; a Codex worker: by the app,
   * joined into its turn; an Antigravity worker takes no message while it works, so it is stopped at once) and waited for
   * (and stopped, with the file written here, only if it does not end in time); then a hidden sub bot is made in the same
   * folder, on the worker's engine when the project bot has it, and handed the file. A request that cannot be done says
   * why in the chat, never silently.
   */
  private async subBotRequested(bot: Bot, request: { name: string; subagent: string; note: string; engine?: string; subagents?: string[] }): Promise<void> {
    const profile = bot.profile;
    const refuse = (why: string) => {
      bot.appNotice(`No sub bot was made: ${why}`);
      bot.queueNote(`(App: No sub bot was made: ${why})`);
    };
    if (profile.role === "main" || profile.id === MAINTAINER_ID) return refuse("only a project's or a bot's own subagents can become sub bots.");
    if (profile.parent) return refuse("a sub bot cannot make another sub bot; it starts subagents of its own instead.");
    const name = botName(request.name);
    if (!name) return refuse("it needs a name.");
    // App-managed workers (any engine) are pulled in: the new sub bot owns them, they keep running where they are.
    const keys = [...new Set([request.subagent, ...(request.subagents ?? [])].filter(Boolean))];
    if (keys.length && this.agentFlags().agentMoves) {
      const records = keys.map((key) => this.tagAgent(bot, key));
      const missing = keys.filter((_, i) => !records[i]);
      if (records.every((record) => record && record.host.kind !== "claude-sidechain")) {
        try { await this.moveOwners(records as AgentRecord[], { kind: "newSubBot", name, ...(request.note.trim() ? { note: request.note } : {}) }, { task: request.note.trim() || undefined }); }
        catch (error) { refuse((error as Error).message); }
        return;
      }
      if (keys.length > 1) return refuse(missing.length ? `there is no worker ${missing.map((key) => `"${key}"`).join(", ")} of yours here.` : "only app-managed workers can be pulled into one sub bot together.");
    } else if (keys.length > 1) return refuse("moving several workers at once needs agentMoves on.");
    const key = keys[0] ?? "";
    if (!key) return this.subBotMade(bot, name, request);
    const found = bot.findSubagent(key);
    if (!found) return refuse(`there is no subagent "${key}" here.`);
    // One that already ended can still move if the app has a record of what it did; with none there is nothing to hand over.
    if (found.status !== "running" && !found.steps.length && !found.result.trim()) return refuse(`the subagent "${key}" has already ended and left no record of its work, so there is nothing to hand over.`);
    const token = safeToken(key);
    if (this.profiles.some((sub) => sub.parent === profile.id && sub.handoff === token) || this.movingSubagents.has(`${profile.id}:${token}`)) return refuse(`"${key}" was already moved to a sub bot.`);
    this.movingSubagents.add(`${profile.id}:${token}`);
    try {
      const file = handoffFile(profile.folder, token);
      mkdirSync(join(file, ".."), { recursive: true });
      const mode = bot.handoffMode(found.id);
      const result = await runHandoff({
        status: () => bot.findSubagent(key)?.status ?? "missing",
        ...(mode === "steer" ? { ask: () => { bot.askForHandoff(found.id, wrapUpMessage(file)); } } : {}),
        ...(mode === "stop" ? { stopAtOnce: true } : {}),
        forceStop: () => bot.stopForHandoff(found.id),
        fallbackText: (reason) => {
          const now = bot.findSubagent(key) ?? found;
          return fallbackHandoff({ name, description: now.description, prompt: now.prompt, steps: now.steps, status: now.status, result: now.result, reason, engine: now.engine, id: now.id, threadId: now.threadId, run: now.run });
        },
        written: () => { try { return readFileSync(file, "utf8").trim().length > 0; } catch { return false; } },
        write: (text) => writeFileAtomic(file, text),
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        now: () => Date.now(),
        waitMs: this.options.subBotWaitMs ?? SUB_BOT_WAIT_MS,
        pollMs: Math.min(500, Math.max(5, Math.floor((this.options.subBotWaitMs ?? SUB_BOT_WAIT_MS) / 10))),
      });
      const chosen = subBotEngine(found.engine, { engine: bot.engine, heads: bot.headEngines });
      const subId = this.makeSubBot(profile, name, `Continue the work moved out of a subagent: ${found.description || found.prompt.slice(0, 200)}`, token, chosen.engine);
      this.agents.succeed(profile.id, found.id, { kind: "subBot", botId: subId }, file);
      const progress = progressFile(profile.folder, token);
      if (!existsSync(progress)) writeFileAtomic(progress, "Status: working\n");
      bot.appNotice(`Moved "${found.description || key}" to the sub bot "${name}".${result.outcome === "forced" ? (mode === "stop" ? " The worker cannot take a message while it works, so it was stopped at once and the handoff was written from its recorded steps." : " The subagent did not end in time, so it was stopped and the handoff was written from its recorded steps.") : ""}${chosen.note ? ` ${chosen.note}` : ""}`, undefined, undefined, { sourceID: subId });
      this.bots.get(subId)?.relay(subBotFirstMessage({ parentName: profile.name, name, handoff: file, progress, note: request.note }));
      this.log(`sub bot ${name} made under ${profile.name} (${result.outcome}${result.wroteFallback ? ", handoff written by the app" : ""})`);
    } catch (error) {
      refuse(`${(error as Error).message}`);
    } finally {
      this.movingSubagents.delete(`${profile.id}:${token}`);
    }
  }

  /** An agent a bot names in a tag (its agent id, its task id, or the id it reaches it by), if that bot owns it. */
  private tagAgent(bot: Bot, key: string): AgentRecord | undefined {
    const record = this.agents.get(key) ?? this.agents.byHostBot(bot.id, key) ?? this.agents.movedIn(bot.id).find((candidate) => candidate.nativeId === key);
    return record && record.owner.botId === bot.id ? record : undefined;
  }

  /** A <sub-bot> with no subagent: a new empty sub bot under the project bot, sent the words inside the tag as its first task. */
  private subBotMade(bot: Bot, name: string, request: { note: string; engine?: string }): void {
    const profile = bot.profile;
    const task = request.note.trim();
    const refuse = (why: string) => { bot.appNotice(`No sub bot was made: ${why}`); bot.queueNote(`(App: No sub bot was made: ${why})`); };
    if (!task) return refuse("it needs a task (the words inside the tag) or a subagent to move.");
    try {
      const chosen = directSubBotEngine(request.engine, { engine: bot.engine, heads: bot.headEngines });
      const subId = this.makeSubBot(profile, name, task.slice(0, 1_000), undefined, chosen.engine);
      const progress = progressFile(profile.folder, subId);
      mkdirSync(join(progress, ".."), { recursive: true });
      writeFileAtomic(progress, "Status: working\n");
      bot.appNotice(`Made the sub bot "${name}" and gave it its first task.${chosen.note ? ` ${chosen.note}` : ""}`, undefined, undefined, { sourceID: subId });
      this.bots.get(subId)?.relay(subBotDirectFirstMessage({ parentName: profile.name, name, task, progress }));
      this.log(`sub bot ${name} made directly under ${profile.name}`);
    } catch (error) {
      refuse((error as Error).message);
    }
  }

  // ---- Agents (A1): the registry, "Move to…", notices, status files ----

  /** settings.json's agent flags (read at most every 2 s: rows ask often). */
  private agentFlags(): { agentMoves: boolean; claudeOwnerMoves: boolean } {
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
  private agentBotName(id: string): string {
    const profile = this.profiles.find((candidate) => candidate.id === id);
    return !profile ? "a removed bot" : profile.role === "main" ? "Main bot" : profile.name;
  }

  private botFacts(id: string): BotFacts | null {
    const profile = this.profiles.find((candidate) => candidate.id === id);
    const bot = this.bots.get(id);
    if (!profile || !bot || this.removed.has(id)) return null;
    return { id, name: this.agentBotName(id), role: profile.role, parent: profile.parent ?? null, maintainer: id === MAINTAINER_ID, problem: profile.problem, folder: profile.folder, engine: bot.engine, heads: bot.headEngines };
  }

  /** The registry as one bot's heads see it (a partner head shares its primary's). */
  private agentPort(profile: BotProfile): AgentPort {
    const id = profile.id;
    return {
      observed: (host, rec, worker) => { this.agents.observe(host, rec, worker); },
      // Its report (if any) comes as the host's `workerReport` and goes to the owner (`report`).
      ended: (host, rec, worker) => { this.agents.observe(host, rec, worker); },
      report: (host, r) => this.agentReported(host, r),
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
  private agentsOfRemovedBot(id: string) {
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
  private ownedAgentsNote(profile: BotProfile): string {
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
  private agentView(botId: string, subagentId: string): ResultOf<"subagent.view"> {
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
    const candidates = this.profiles.filter((profile) => !this.removed.has(profile.id) && profile.role !== "main" && profile.id !== MAINTAINER_ID && profile.id !== record.owner.botId && !(isDetached(record) && profile.id === record.host.botId));
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
  private async moveOwners(records: AgentRecord[], to: MoveTarget, options: { notifyAgent?: boolean; note?: string; task?: string }): Promise<string> {
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
    const turnId = owner.appMessage(agentReportNote({
      engine: record.engine, title: record.summary.description || "Agent", from: this.agentBotName(from), host: this.agentBotName(record.host.botId),
      run: report.run, status: record.state === "failed" ? "failed" : record.state === "stopped" ? "stopped" : "completed", report: record.summary.lastReport ?? "", agentId, statusFile,
    }));
    if (!turnId) return;
    this.reportsHanded.add(key);
    this.reportTurns.set(turnId, { agentId, run: report.run });
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
  private async agentMessageCommand(botId: string, subagentId: string, text: string): Promise<ResultOf<"agent.message">> {
    const done = await this.commandAgent(botId, subagentId, { kind: "message", text });
    const how = done.how === "stopped" ? "newRun" : done.how;
    this.bots.get(botId)?.appNotice(agentMessageNotice({ title: done.record.summary.description || "Agent", how, run: done.run ?? 0 }), undefined, undefined, { sourceID: done.record.host.botId });
    return { agentId: done.record.id, how, run: done.run };
  }

  /** `agent.stop` from a row's "Stop". */
  private async agentStopCommand(botId: string, subagentId: string): Promise<ResultOf<"agent.stop">> {
    const done = await this.commandAgent(botId, subagentId, { kind: "stop" });
    this.bots.get(botId)?.appNotice(`Stopped "${done.record.summary.description || "Agent"}".`, undefined, undefined, { sourceID: done.record.host.botId });
    return { agentId: done.record.id, stopped: true };
  }

  /** A bot's `<agent-message>` / `<agent-stop>`: as the commands, with what went wrong told to it and the chat, never silently. */
  private async agentTag(bot: Bot, request: Extract<BotRequest, { kind: "agentMessage" | "agentStop" }>) {
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

  /**
   * "Close sub bot": the agents it owns go back to the bot that runs them (or, when that bot is gone, are only listed as stopped),
   * the ones it runs itself are stopped, then it is removed. Its project bot's chat says which went where.
   */
  async closeSubBot(id: string): Promise<ResultOf<"subbot.close">> {
    const profile = this.profiles.find((candidate) => candidate.id === id);
    if (!profile || this.removed.has(id)) throw new ContractError("not_found", "No such bot.");
    if (!profile.parent) throw new ContractError("bad_request", "Only a sub bot can be closed.");
    const parentId = profile.parent;
    const returned: { title: string; to: string }[] = [];
    const stopped: { title: string; why: string }[] = [];
    for (const record of this.agents.movedIn(id)) {
      const title = record.summary.description || "Agent";
      const host = this.removed.has(record.host.botId) ? undefined : this.bots.get(record.host.botId);
      if (!host || record.state === "lost") { stopped.push({ title, why: "the bot that ran it is gone" }); continue; }
      try { await this.moveOwners([record], { kind: "back" }, {}); returned.push({ title, to: this.agentBotName(record.host.botId) }); }
      catch (error) {
        // It cannot go back now (its report is being handed over this very moment): stopped instead, never left without an owner.
        await host.commandWorker(record.nativeId, { kind: "stop" }).catch(() => undefined);
        stopped.push({ title, why: `it could not go back: ${(error as Error).message}` });
      }
    }
    const sub = this.bots.get(id);
    for (const record of this.agents.all.filter((candidate) => candidate.host.botId === id && candidate.state === "running")) {
      const stoppedNow = await sub?.commandWorker(record.nativeId, { kind: "stop" }).catch(() => null);
      if (stoppedNow?.ok) stopped.push({ title: record.summary.description || "Agent", why: "it ran on this sub bot" });
    }
    await this.removeBot(id, { quiet: true });
    const parent = this.removed.has(parentId) ? undefined : this.bots.get(parentId);
    const words = subBotClosedNotice({ name: profile.name, returned, stopped });
    parent?.appNotice(words, undefined, undefined, { sourceID: id });
    parent?.queueNote(`(App: ${words})`);
    parent?.refresh();
    return { closed: true, parentBotId: parentId, returned: returned.length, stopped: stopped.length };
  }

  private movingSubagents = new Set<string>();
  /** Sub bots that already told their project bot they were done. */
  private subBotsReported = new Set<string>();

  /** Makes the hidden sub bot: a Bot of its own (head, chat.json, subagents.json) under `parent`, in the same folder, no worktree. */
  makeSubBot(parent: BotProfile, rawName: string, job: string, handoff: string | undefined, engine?: Engine): string {
    const taken = new Set(this.profiles.filter((profile) => profile.parent === parent.id).map((profile) => profile.name.toLowerCase()));
    let name = botName(rawName) || "Sub bot";
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${botName(rawName) || "Sub bot"} ${n}`;
    const id = randomUUID().toUpperCase();
    mkdirSync(join(parent.folder, ".bot", "sub-bots", id), { recursive: true });
    this.seedEngineDefaults(id);
    // It runs on the engine of the worker it took over (`subBotEngine`), as a single head: the app's defaults would otherwise decide.
    if (engine) {
      const store = new BotStore(Layout.bot(this.options.dataDir, id));
      store.saveSetting("heads", headsJSON(singleHead(engine)));
      store.saveSetting("engine", engine);
    }
    const row = { id, name, folder: parent.folder, avatar: parent.avatar, job, parent: parent.id, createdAt: Date.now(), ...(handoff ? { handoff } : {}) };
    saveProjectRow(this.options.dataDir, row);
    this.attach(projectProfile(this.options.dataDir, { ...row, folder: folderURLText(parent.folder) }));
    // The project bot's subagent list gains the row.
    this.bots.get(parent.id)?.refresh();
    return id;
  }

  /** A sub bot's reply showed: when its progress file says it is done, its project bot hears of it once. */
  private subBotReplied(bot: Bot) {
    const sub = bot.profile;
    if (!sub.parent || this.subBotsReported.has(sub.id)) return;
    let status: string | null = null;
    try { status = progressStatus(readFileSync(progressFile(sub.folder, sub.handoff ?? sub.id), "utf8")); } catch { return; }
    if (!status?.startsWith("done")) return;
    this.subBotsReported.add(sub.id);
    const parent = this.bots.get(sub.parent);
    if (!parent) return;
    const words = `The sub bot "${sub.name}" finished its job. Progress file: ${progressFile(sub.folder, sub.handoff ?? sub.id)}`;
    parent.appNotice(words, undefined, undefined, { sourceID: sub.id });
    parent.queueNote(`(App: ${words})`);
    parent.refresh();
  }

  /** The app's engine defaults saved into a new bot's bot.json before it is made (`seedEngineDefaults`). */
  private seedEngineDefaults(id: string) {
    const store = new BotStore(Layout.bot(this.options.dataDir, id));
    seedEngineDefaults(readSettings(Layout.settings(this.options.dataDir)), (key, value) => store.saveSetting(key, value));
  }

  /** A new project's or bot's row in the left column, before Maintainer (who stays last). */
  private attach(profile: BotProfile): Bot {
    const at = this.profiles.findIndex((candidate) => candidate.id === MAINTAINER_ID);
    this.profiles.splice(at < 0 ? this.profiles.length : at, 0, profile);
    const bot = this.newBot(profile);
    const orderAt = this.order.indexOf(MAINTAINER_ID);
    this.order.splice(orderAt < 0 ? this.order.length : orderAt, 0, profile.id);
    this.event({ type: "bot.updated", bot: bot.view() });
    return bot;
  }

  /** The main bot's (or Maintainer's) <new-bot name="…">job</new-bot>: made and set up, or why not. */
  private botRequested(name: string, job: string, by: string | null) {
    const main = this.bots.get(MAIN_BOT_ID)!;
    const made = this.makeBot(name, job, { setUp: true, by });
    if (made.kind === "existing") {
      const old = this.bots.get(made.botId)!;
      main.appNotice(`There is already a bot called "${old.profile.name}"; nothing new was made. To change its job, tell it, or remove it from its menu first.`, undefined, undefined, { sourceID: made.botId });
    } else if (made.kind === "taken") {
      main.appNotice(`No bot was made: the name "${botName(name)}" is already used by a project or the app.`);
    }
  }

  /**
   * Takes a bot of its own (`Workspace.removeBot`) — or, in 2.0, a project — out of the left column and
   * stops it. Nothing on disk is deleted: its folder (memory, results; a project's own files and .bot/)
   * and its chat files stay. Its questions copied into the main bot's chat can no longer be answered.
   */
  async removeBot(id: string, { quiet = false }: { quiet?: boolean } = {}): Promise<{ removed: boolean }> {
    const profile = this.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new ContractError("not_found", "No such bot.");
    if (profile.role === "main" || id === MAINTAINER_ID) throw new ContractError("forbidden", "The main bot and Maintainer cannot be removed.");
    // Its sub bots go with it (they hang under it, in its folder).
    for (const sub of this.profiles.filter((candidate) => candidate.parent === id)) await this.removeBot(sub.id);
    const bot = this.bots.get(id);
    // Its agents (reconcile rules 4 and 5, at once): ones it ran for another owner are lost; ones it owned go back to their host.
    this.agentsOfRemovedBot(id);
    this.removed.add(id);
    this.profiles = this.profiles.filter((candidate) => candidate.id !== id);
    this.order = this.order.filter((candidate) => candidate !== id);
    this.bots.delete(id);
    removeProjectRow(this.options.dataDir, id);
    if (profile.plugin) {
      this.removedPluginBots.add(`${profile.plugin}/${profile.name}`.toLowerCase());
      writeFileAtomic(join(this.options.dataDir, "removed-bots.json"), JSON.stringify([...this.removedPluginBots].sort()));
    }
    if (this.visiblePins?.botId === id) this.visiblePins = null;
    const main = this.bots.get(MAIN_BOT_ID)!;
    for (const [copy, source] of [...this.copies]) {
      if (source.botId !== id) continue;
      this.copies.delete(copy);
      main.settleAppQuestion(copy, { answer: "No longer needed" });
    }
    for (const copy of main.openCopies(id)) main.settleAppQuestion(copy.id, { answer: "No longer needed" });
    this.options.emit({ v: PROTOCOL_VERSION, epoch: this.epoch, seq: ++this.seq, event: { type: "bot.removed", botId: id } });
    this.briefAwakeMainBot();
    this.refreshWaiting();
    if (!quiet) main.appNotice(profile.role === "bot"
      ? `Removed the bot "${profile.name}". Its folder stays at ${profile.folder}.`
      : `Removed the project "${profile.name}" from Botling. Its folder stays at ${profile.folder}, with its notes in .bot/.`);
    this.log(`removed ${profile.role === "bot" ? "the bot" : "the project"} ${profile.name} (${profile.folder} kept)`);
    // It stops at once (no tidy); its chat files stay where they are.
    await bot?.shutdown({ tidy: false }).catch((error) => this.log(`stopping ${profile.name}: ${(error as Error).message}`));
    return { removed: true };
  }

  /**
   * The main bot's <open-question from="name"/> (`showOpenQuestion`): the card a project or bot already
   * shows in its own chat shows here too, a copy kept in step with it; a pick or words on it go there.
   */
  private showOpenQuestion(name: string) {
    const main = this.bots.get(MAIN_BOT_ID)!;
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
      onAnswer: (text, files) => this.answerOnCopy(copy, text, files), sourceID: profile.id, sourceMessageID: question.id,
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
      chat = this.bot(record.sourceID);
      record = chat.line(record.sourceMessageID);
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
    if (!source || !bot) { this.bots.get(MAIN_BOT_ID)?.settleAppQuestion(copy, { answer: "No longer needed" }); return false; }
    let accepted = false;
    try { accepted = bot.answer(source.questionId, text, files).accepted; } catch { /* gone */ }
    this.copies.delete(copy);
    this.bots.get(MAIN_BOT_ID)?.settleAppQuestion(copy, accepted ? { answer: answerLabel(text, files.length) } : { answer: "No longer needed" });
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
      this.bots.get(MAIN_BOT_ID)?.settleAppQuestion(copy, line?.chosen != null ? { chosen: line.chosen } : { answer: line?.answer ?? "No longer needed" });
    }
  }

  /** Hands what the main bot wrote into an inbox.md to that bot, emptying the file (`deliverInboxes`). */
  deliverInboxes() {
    for (const profile of this.profiles) {
      // A sub bot shares its project bot's folder, so that folder's inbox is the project bot's alone.
      if (profile.role === "main" || profile.parent || profile.problem) continue;
      const file = join(profile.folder, ".bot", "inbox.md");
      let text: string;
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      if (!text.trim()) continue;
      const bot = this.bots.get(profile.id);
      if (!bot) continue;
      // Handed over first, then emptied: a bot that cannot take it now (read-only, closing) keeps it for later.
      try { bot.relay(text); } catch (error) { this.log(`inbox of ${profile.name} kept: ${(error as Error).message}`); continue; }
      try { writeFileSync(file, ""); } catch (error) { this.log(`inbox of ${profile.name} not emptied: ${(error as Error).message}`); }
    }
  }

  /**
   * What waits on you (`refreshWaiting`): each bot's latest open question in its own chat, else its
   * memory's "Waiting on you"; then the main bot's own questions; without what you set aside.
   */
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
      // Older versions keyed an ignored item by its first line; changing the preview must not revive it.
      if (ignored.has(`${botId}-${legacyText}`)) return;
      const choices = chat?.line(question.id)?.choices;
      const labels = Array.isArray(choices) ? choices.flatMap((choice, index) =>
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
    for (const question of this.bots.get(MAIN_BOT_ID)?.openQuestions() ?? []) addQuestion(MAIN_BOT_ID, this.bots.get(MAIN_BOT_ID), question);
    const acked = [...ignored].filter((key) => key.includes("-task:")).slice(-200);
    return { items: out.filter((item) => !ignored.has(`${item.botId}-${item.text}`)).slice(0, 200), doing, ...(acked.length ? { acked } : {}) };
  }

  /**
   * The main bot's whiteboard: for every bot but the main bot, its memory.md's "Current status", "In progress" and "Decided" (its "Waiting on you" is in `waiting()`), its task cards and its chat's results. Read when
   * asked; the page asks every few seconds while the whiteboard is shown.
   */
  whiteboard(): WhiteboardView {
    const out: WhiteboardView["bots"] = [];
    for (const profile of this.profiles) {
      if (profile.role === "main" || profile.parent) continue;
      const bot = this.bots.get(profile.id);
      if (!bot) continue;
      // Read and parsed once per change of the file (MemoryFiles), not on every ask.
      const file = join(profile.folder, profile.memoryPath);
      const items = (section: "currentStatus" | "inProgress" | "decided") => (profile.problem ? [] : this.memoryFiles.items(file, section).slice(0, 20).map((item) => item.slice(0, 400)));
      const currentStatus = items("currentStatus");
      const tasks = bot.taskViews().slice(-100);
      out.push({
        botId: profile.id, currentStatus, inProgress: items("inProgress"), decided: items("decided"),
        tasks, results: bot.results().slice(0, 12).map((result) => ({ label: result.label.slice(0, 400), url: result.url.slice(0, 4_000) })),
        picture: bot.whiteboardPicture(),
        latest: latestAction(tasks), doneDays: bot.doneDays(), description: botDescription(profile.job, currentStatus[0], profile.folder), approvals: bot.pendingApprovals(),
      });
      // Shown now: a picture whose command the user allowed runs again (at most every 30 s), as a pin "when shown".
      bot.whiteboardShown();
    }
    return { bots: out.slice(0, 500) };
  }

  /**
   * The whiteboard for `whiteboard.view`: `stamp` moves only when what it shows changed, and an ask with the
   * stamp it has (`since`) gets `same` and no bots, so an unchanged board is not sent or compared on the page.
   * The board is still built on each ask: being asked is what shows it (`whiteboardShown`).
   */
  whiteboardView(since?: string): WhiteboardView {
    const view = this.whiteboard();
    const text = JSON.stringify(view.bots);
    if (text !== this.whiteboardText) { this.whiteboardText = text; this.whiteboardStamp++; }
    const stamp = `${this.epoch}:${this.whiteboardStamp}`;
    return since === stamp ? { bots: [], stamp, same: true } : { ...view, stamp };
  }

  /** Tells the windows when what waits on you changed (1.x's `refreshWaiting`, after anything that may change it). */
  refreshWaiting() {
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
   * Adds a folder as a project with a manager (`Workspace.addProject`); a folder that is one already
   * gives that project. Its row goes into projects.json, its `.bot/` is made, its bot joins the list.
   */
  addProject(path: string): { botId: string; added: boolean } {
    const folder = folderPath(path);
    if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) throw new ContractError("not_found", `There is no folder at ${path}.`);
    const existing = this.profiles.find((profile) => profile.role !== "main" && !profile.parent && profile.folder === folder);
    if (existing) return { botId: existing.id, added: false };
    const id = randomUUID().toUpperCase();
    const row = { id, name: defaultName(folder), folder, avatar: nextAvatar(this.profiles.filter((profile) => profile.role !== "main" && profile.id !== MAINTAINER_ID).map((profile) => profile.avatar)) };
    prepareNotesFolder(folder);
    this.seedEngineDefaults(id);
    saveProjectRow(this.options.dataDir, row);
    this.attach(projectProfile(this.options.dataDir, { id, name: row.name, folder: folderURLText(folder), avatar: row.avatar }));
    this.log(`added project ${row.name} (${folder})`);
    return { botId: id, added: true };
  }

  /**
   * The main bot's <new-project folder="…">task</new-project> (`proposeProjects`): folders found (`/*`,
   * `/**`), ones that are projects already get the task, the rest are asked about on one card.
   */
  private projectRequests(bot: Bot, requests: BotRequest[]): BotRequest[] {
    // New bots and <open-question> (`Workspace.handle`): only the main bot
    // shows other bots' cards; it makes bots when you ask it, and Maintainer may too. From anyone else
    // they are left out, as in 1.x. They act once the reply is in.
    const main = bot.id === MAIN_BOT_ID;
    const later: (() => void)[] = [];
    const rest: BotRequest[] = [];
    for (const request of requests) {
      if (request.kind === "newBot") { if (main || bot.id === MAINTAINER_ID) later.push(() => this.botRequested(request.name, request.job, main ? null : bot.profile.name)); }
      else if (request.kind === "openQuestion") { if (main) later.push(() => this.showOpenQuestion(request.from)); }
      else if (request.kind === "subBot") later.push(() => { void this.subBotRequested(bot, request); });
      else if (request.kind === "agentMessage" || request.kind === "agentStop") later.push(() => { void this.agentTag(bot, request); });
      // A bot's <suggest-component>: a chip under its reply; Maintainer's <component-spec>: into that spec (`Workspace.handle`).
      else if (request.kind === "suggestComponent") later.push(() => this.specs.suggest(request.name, request.draft, this.bots.get(bot.id) ?? bot));
      else if (request.kind === "componentSpec") { if (bot.id === MAINTAINER_ID) later.push(() => this.specs.applyUpdate(request.id, request.json, bot.lines().findLast((line) => line.role === "bot")?.text ?? "")); }
      // Developer mode (`proposeBuild`, `sendScreenshot`): a project's manager (the desk checks it is the developer
      // project); from the main bot they do nothing, as in 1.x.
      else if (request.kind === "installBuild") { if (bot.profile.role === "manager") later.push(() => this.devBuilds.propose(request.path, request.note, bot)); }
      else if (request.kind === "appScreenshot") { if (bot.profile.role === "manager") later.push(() => this.devBuilds.screenshot(bot)); }
      else rest.push(request);
    }
    if (later.length) setImmediate(() => { for (const act of later) { try { act(); } catch (error) { this.log(`request: ${(error as Error).message}`); } } });
    return this.newProjectRequests(bot, rest);
  }

  /** The main bot's <new-project> requests: found, asked about on one card (the rest are passed on). */
  private newProjectRequests(bot: Bot, requests: BotRequest[]): BotRequest[] {
    const asked = requests.filter((request): request is Extract<BotRequest, { kind: "newProject" }> => request.kind === "newProject");
    if (!asked.length) return requests;
    // Only the main bot adds projects; anyone else's <new-project> is left out silently, as in 1.x (`Workspace.handle`).
    if (bot.id !== MAIN_BOT_ID) return requests.filter((request) => request.kind !== "newProject");
    const main = bot;
    const home = homedir();
    const own = resolvePath(this.options.dataDir);
    const adding: { folder: string; task: string }[] = [];
    const missing: string[] = [];
    const tooBroad: string[] = [];
    const handed: string[] = [];
    const expanded: { path: string; task: string }[] = [];
    for (const { folder: path, task } of asked) {
      const trimmed = path.trim();
      if (trimmed.endsWith("/**")) {
        const parent = folderPath(trimmed.slice(0, -3));
        if (!parent || !existsSync(parent)) { missing.push(trimmed.slice(0, -3)); continue; }
        const found = projectFolders(parent);
        if (!found.length) missing.push(trimmed);
        expanded.push(...found.map((folder) => ({ path: folder, task })));
        continue;
      }
      if (!trimmed.endsWith("/*")) { expanded.push({ path, task }); continue; }
      const parent = folderPath(trimmed.slice(0, -2));
      const inside = parent ? childFolders(parent) : null;
      if (!inside) { missing.push(trimmed.slice(0, -2)); continue; }
      if (!inside.length) missing.push(trimmed);
      expanded.push(...inside.map((folder) => ({ path: folder, task })));
    }
    for (const { path, task: raw } of expanded) {
      const task = raw.trim();
      const folder = folderPath(path);
      if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) { missing.push(path); continue; }
      if (folder === "/" || folder === home || folder === own || folder.startsWith(own + "/")) { tooBroad.push(folder); continue; }
      const existing = this.profiles.find((profile) => profile.role !== "main" && !profile.parent && profile.folder === folder);
      if (existing) {
        if (task) { try { this.bots.get(existing.id)?.relay(task); } catch { /* read-only */ } }
        handed.push(existing.name);
        continue;
      }
      if (!adding.some((entry) => entry.folder === folder)) adding.push({ folder, task });
    }
    const notes: string[] = [];
    if (missing.length) {
      main.appNotice(`Couldn't add a project: there is no folder at ${missing.join(", ")}.`);
      notes.push(`There is no folder at ${missing.join(", ")}; nothing was added for it. Ask the user for the full path.`);
    }
    if (tooBroad.length) {
      main.appNotice(`Couldn't add ${tooBroad.join(", ")} as a project: a manager there could change far more than one project.`);
      notes.push(`${tooBroad.join(", ")} was not added: a whole disk, the home folder or Botling's own folder cannot be a project. Ask for the project's own folder.`);
    }
    if (handed.length) main.appNotice(handed.length === 1 ? `${handed[0]} is already a project; any task went to its manager.` : `${handed.join(", ")} are already projects; any task went to their managers.`);
    if (adding.length) {
      let text: string;
      let add: string;
      if (adding.length === 1) {
        const only = adding[0]!;
        text = `Add **${basename(only.folder)}** as a project?\n\n\`${only.folder}\`\n\nIts manager can read and change the files in this folder.${only.task ? `\n\nThen its manager starts on: ${only.task}` : ""}`;
        add = "Add as project";
      } else {
        const tasks = new Set(adding.map((entry) => entry.task));
        const shared = tasks.size === 1 ? [...tasks][0]! : null;
        const list = adding.map((entry) => `- **${basename(entry.folder)}** \`${entry.folder}\`${shared !== null || !entry.task ? "" : ` — then: ${entry.task}`}`);
        const then = shared ? `\n\nThen each manager starts on: ${shared}` : "";
        text = `Add these ${adding.length} folders as projects?\n\n${list.join("\n")}${then}\n\nEach gets a manager that can read and change the files in its folder. To leave some out, tell the main bot instead.`;
        add = `Add all ${adding.length}`;
      }
      const question = main.appNotice(text, [{ label: add, recommended: true }, { label: "Don't add" }], (index) => this.answerProjects(question, index === 0));
      this.projectQuestions.set(question, adding);
      notes.push(`The user now sees a card asking to add ${adding.length === 1 ? "this folder" : `these ${adding.length} folders`} as projects: ${adding.map((entry) => entry.folder).join(", ")}. Nothing is added until they pick.`);
    }
    if (notes.length) main.queueNote(`(App: ${notes.join(" ")})`);
    return requests.filter((request) => request.kind !== "newProject");
  }

  /** Your pick on an "Add as project?" card (`answerProjects`). */
  private answerProjects(question: string, add: boolean) {
    const folders = this.projectQuestions.get(question);
    this.projectQuestions.delete(question);
    const main = this.bots.get(MAIN_BOT_ID);
    if (!folders || !main) return;
    const paths = folders.map((entry) => entry.folder).join(", ");
    if (!add) { main.queueNote(`(App: The user chose not to add ${paths} as projects.)`); return; }
    const names: string[] = [];
    for (const { folder, task } of folders) {
      try {
        const { botId } = this.addProject(folder);
        names.push(this.bots.get(botId)!.profile.name);
        if (task) this.bots.get(botId)?.relay(task);
      } catch (error) {
        this.log(`adding ${folder}: ${(error as Error).message}`);
      }
    }
    if (!names.length) { main.appNotice(`Couldn't add ${paths} as ${folders.length === 1 ? "a project" : "projects"}.`); return; }
    const list = names.join(", ");
    const anyTask = folders.some((entry) => entry.task);
    main.appNotice(names.length === 1
      ? (anyTask ? `Added ${list} as a project; the managers with a task are on it.` : `Added ${list} as a project.`)
      : (anyTask ? `Added ${list} as projects; the managers with a task are on it.` : `Added ${list} as projects.`));
    main.queueNote(`(App: The user added ${list} as projects (${paths}); they are in the project list now.)`);
  }

  private importOnce() {
    const source = this.options.importFrom;
    const root = this.options.dataDir;
    if (source && needsImport(root)) {
      if (looksLike1x(source)) {
        try {
          const report = importFrom1x(source, root);
          this.log(`imported ${report.bots.length} bot(s) and ${report.messages} message(s) from ${source} (read-only); skipped ${report.skipped.length}`);
        } catch (error) {
          this.log(`import from ${source} failed: ${(error as Error).message}`);
        }
      } else {
        this.log(`nothing to import: ${source} is not a Botling 1.x data folder`);
      }
    }
    const report = importRecord(root);
    if (report) {
      this.imported = {
        source: report.source.slice(0, 4_000), at: report.at, bots: report.bots.length, messages: report.messages,
        skipped: report.skipped.slice(0, 200).map((entry) => entry.slice(0, 2_000)),
      };
    }
  }

  private log(line: string) {
    this.options.log?.(line);
  }

  /** How plugins see a bot (`Workspace.info(for:)`): "main", or its id. */
  private botInfo(bot: Bot): BotInfo {
    return { id: bot.id === MAIN_BOT_ID ? "main" : bot.id, name: bot.profile.name, role: bot.profile.role, awake: bot.awake };
  }

  /** A reply showed: plugins listening hear it; Maintainer's settles the component changes bots asked for. */
  private replied(bot: Bot, record: ChatRecord) {
    if (record.text) this.plugins.replied(this.botInfo(bot), record.text);
    if (bot.profile.parent) this.subBotReplied(bot);
    // A line of its reply that starts with @ and another bot's name calls that bot in (`receiveBotMention`).
    this.conversations.receiveBotMention(record, bot);
    // What the main bot wrote into an inbox goes to that bot now (1.x: after every main-bot reply).
    if (bot.id === MAIN_BOT_ID) this.deliverInboxes();
    if (bot.id === MAINTAINER_ID) {
      this.maintainer.settle(record);
      this.specs.finishBuilds();
      // After the reply's own tags are acted on: a change from a spec panel that did not land is said there.
      setImmediate(() => setImmediate(() => { this.specs.settleChanges(record, bot.subagentsAtWork); this.componentsTick(); }));
      this.componentsTick();
    }
  }

  /** Your message through the plugins' beforeSend hooks first; one can change it or stop it (`Workspace.send`). */
  private async send(botId: string, text: string, options: { replyTo?: string; to?: "both" | "claude" | "codex" | "agy" }): Promise<ResultOf<"chat.send">> {
    const bot = this.bot(botId);
    // The files waiting in its input box go with the message (1.x sends them all).
    const files = this.pending.take(botId);
    try {
      const result = await this.sendWith(bot, text, { ...options, files: files.map((file) => file.path) });
      if (result.stoppedBy) this.pending.restore(botId, files);
      else this.pending.done(files);
      return result;
    } catch (error) {
      this.pending.restore(botId, files);
      throw error;
    }
  }

  private async sendWith(bot: Bot, text: string, options: { replyTo?: string; to?: "both" | "claude" | "codex" | "agy"; files: string[] }): Promise<ResultOf<"chat.send">> {
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
      const newest = bot.lines().findLast((line) => line.role === "user");
      if (newest) this.conversations.startCallIn(bot, called, newest.id, null);
    }
    return sent;
  }

  /** A file the chat origin may serve for this bot: one of its lines' attachments, or one waiting in its input box. */
  private attachmentFile(botId: string, ref: string): ResultOf<"attachment.file"> {
    const bot = this.bot(botId);
    let path: string | null = null;
    if (ref.startsWith("pending:")) path = this.pending.get(botId, ref.slice(8))?.path ?? null;
    else path = bot.attachmentPath(ref);
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

  private summaries(bot: Bot): { catchUp: CatchUpViewData | null; intervalSummaries: CatchUpViewData[] } {
    const views = this.catchUps.views(bot.catchUpChat());
    return { catchUp: views.catchUp, intervalSummaries: views.intervalSummaries.slice(-200) };
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
    }), profile, this.options.reports ?? null, engine, claudeWorkersMode(this.settingsFile() ?? {}) === "app");
  }

  private event(event: Event) {
    // A removed bot (still stopping) is heard no more.
    if (this.removed.size && (("botId" in event && this.removed.has(event.botId)) || (event.type === "bot.updated" && this.removed.has(event.bot.id)))) return;
    this.options.emit({ v: PROTOCOL_VERSION, epoch: this.epoch, seq: ++this.seq, event });
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
      const report = this.reportTurns.get(event.turnId);
      if (report) { this.reportTurns.delete(event.turnId); this.agents.reportDelivered(report.agentId, report.run); }
    }
    // A turn began: remember what its worktree looked like, so the review can show what the turn changed.
    if (event.type === "turn.started" && !this.removed.has(event.botId)) {
      const bot = this.bots.get(event.botId);
      if (bot) void this.worktrees.turnStarted(bot.profile, event.turnId);
    }
    // A question copied into the main bot's chat was settled in its own: so is the copy.
    if (event.type === "message.updated" && (this.copies.size || event.message.ignoredAt)) this.closeCopiesOf(event.botId, event.message.id);
    // A question asked or answered, a bot added: what waits on you may have changed.
    if (event.type === "message.added" || event.type === "message.updated" || event.type === "message.removed" || event.type === "bot.updated") this.waitingSoon();
    // Your line closes an interval: it may be summarized by itself (`summarizeClosedInterval`).
    if (event.type === "message.added" && event.message.role === "user") {
      const bot = this.bots.get(event.botId);
      if (bot) this.catchUps.closedInterval(bot.catchUpChat(), event.message.id);
    }
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
    if (!this.conversations.answerCallIn(chat, record, pickedNote(label))) {
      chat.settleAppQuestion(messageId, { answer: NO_LONGER_NEEDED });
      return { accepted: false };
    }
    chat.settleAppQuestion(messageId, { chosen: index });
    return { accepted: true };
  }

  /** Your words on a called-in bot's question go back to it. */
  private calledInAnswer(botId: string, messageId: string, text: string, files: number): { accepted: boolean } | null {
    const chat = this.bot(botId);
    const record = chat.line(messageId);
    if (!record || !this.conversations.isCalledIn(record, chat.id) || !record.choices?.length) return null;
    const shown = answerLabel(text.trim(), files);
    if (!shown || !isOpenQuestion(record)) return { accepted: false };
    if (!this.conversations.answerCallIn(chat, record, answeredNote(shown))) {
      chat.settleAppQuestion(messageId, { answer: NO_LONGER_NEEDED });
      return { accepted: false };
    }
    chat.settleAppQuestion(messageId, { answer: shown });
    return { accepted: true };
  }

  /** A project's or bot's own profile: Maintainer has no worktrees. */
  private worktreeProfile(id: string) {
    const bot = this.bots.get(id);
    if (!bot || id === MAINTAINER_ID || this.removed.has(id)) throw new ContractError("not_found", "No such project.");
    return bot.profile;
  }

  private bot(id: string): Bot {
    const bot = this.bots.get(id);
    if (!bot) throw new ContractError("not_found", "No such bot.");
    return bot;
  }

  private async handle(cmd: Command, signal: AbortSignal): Promise<unknown> {
    if (!this.activated && !new Set<string>(["boot.commit", "chat.snapshot", "settings.get", "plugins.list", "plugins.web", "plugins.file", "results.list", "waiting.list", "bot.settings", "usage.view", "doctor.view", "attachment.file", "card.image", "link.authorize"]).has(cmd.type)) {
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
      case "chat.send": return this.send(cmd.botId, cmd.text, { replyTo: cmd.replyTo, to: cmd.to });
      case "plugins.list": return this.plugins.view();
      case "plugins.enable": return this.plugins.setEnabled(cmd.name, cmd.enabled);
      case "plugins.setting": return this.plugins.setSetting(cmd.name, cmd.key, cmd.value);
      case "plugins.secret": return this.plugins.setSecret(cmd.name, cmd.key, cmd.value);
      case "plugins.command": return { result: await this.plugins.command(cmd.id) ?? null };
      case "plugins.panel": return this.plugins.panel(cmd.name, cmd.panel);
      case "plugins.call": return { result: await this.plugins.call(cmd.name, cmd.method, cmd.params) ?? null };
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
      case "task.complete": return this.bot(cmd.botId).completeTask(cmd.taskId);
      case "link.authorize": {
        const lines=this.bot(cmd.botId).lines();
        const context=cmd.messageId?lines.find(line=>line.id===cmd.messageId):null;
        const pin=cmd.pinId?this.bot(cmd.botId).pin(cmd.pinId):null;
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
        // A file attached in this chat (yours, a relayed report's, a reply's): the app copied it into
        // the bot's folder and the chat shows it, so your click on it opens it (a component's does not).
        if(cmd.source==="user"&&!cmd.messageId&&!cmd.pinId&&lines.some(line=>line.attachments?.some(file=>typeof file?.url==="string"&&same(file.url))))linked=true;
        return {result,linked};
      }
      case "results.list": return { results: this.bot(cmd.botId).results().slice(0, 200) };
      case "waiting.list": return this.waiting();
      case "whiteboard.view": return this.whiteboardView(cmd.since);
      case "whiteboard.allow": return this.bot(cmd.botId).whiteboardAllow({ command: cmd.command, folder: cmd.folder });
      case "waiting.ignore": return this.ignoreWaiting(cmd.botId, cmd.text);
      case "settings.set": return this.changeSetting(cmd.change);
      case "engineDefaults.applyAll": return this.applyEngineDefaultsToAll();
      case "bot.settings": return this.bot(cmd.botId).settingsView();
      case "mobile.view": return this.mobileDesk ? this.mobileDesk.view() : MOBILE_OFF;
      case "mobile.pair": {
        const unknown = cmd.botIds.find((id) => !this.bots.has(id));
        if (unknown) throw new Error("Unknown bot.");
        return this.mobileOr().pair(cmd.botIds, cmd.route);
      }
      case "mobile.revoke": return this.mobileOr().revoke(cmd.deviceId);
      case "worktrees.list": return this.worktrees.view(this.worktreeProfile(cmd.botId));
      case "worktrees.create": return this.worktrees.create(this.worktreeProfile(cmd.botId), cmd.name, cmd.base);
      case "worktrees.use": return this.worktrees.use(this.worktreeProfile(cmd.botId), cmd.worktreeId);
      case "worktrees.merge": return this.worktrees.merge(this.worktreeProfile(cmd.botId), cmd.worktreeId);
      case "worktrees.discard": return this.worktrees.discard(this.worktreeProfile(cmd.botId), cmd.worktreeId, cmd.force === true);
      case "worktrees.terminal": return this.worktrees.terminal(this.worktreeProfile(cmd.botId), cmd.worktreeId);
      case "worktrees.commit": return this.worktrees.commit(this.worktreeProfile(cmd.botId), cmd.worktreeId, cmd.message);
      case "pr.draft": return this.worktrees.prDraft(this.worktreeProfile(cmd.botId), cmd.worktreeId);
      case "pr.create": return this.worktrees.prCreate(this.worktreeProfile(cmd.botId), cmd.worktreeId, cmd.title, cmd.body);
      case "review.files": return this.worktrees.reviewFiles(this.worktreeProfile(cmd.botId), cmd.worktreeId, cmd.scope, cmd.turn);
      case "review.diff": return this.worktrees.reviewDiff(this.worktreeProfile(cmd.botId), cmd.worktreeId, cmd.from, cmd.to, cmd.path, cmd.oldPath, cmd.force === true);
      case "bot.configure": {
        const { type: _type, botId, ...change } = cmd;
        return this.bot(botId).configure(change);
      }
      case "bot.restart": return this.bot(cmd.botId).restartNow();
      case "files.add": this.bot(cmd.botId); return { files: this.pending.addPaths(cmd.botId, cmd.paths) };
      case "files.data": this.bot(cmd.botId); return { files: await this.pending.addData(cmd.botId, cmd.name, cmd.base64) };
      case "files.remove": return { files: this.pending.remove(cmd.botId, cmd.id) };
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
      case "attachment.file": return this.attachmentFile(cmd.botId, cmd.ref);
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
        try { return this.calledInAnswer(cmd.botId, cmd.messageId, cmd.text, files.length) ?? this.bot(cmd.botId).answer(cmd.messageId, cmd.text, files); } finally { for (const file of files) rmSync(file, { force: true }); }
      }
      case "chat.react": return this.bot(cmd.botId).react(cmd.messageId, cmd.emoji, cmd.present);
      case "chat.history": return this.bot(cmd.botId).history(cmd.before, cmd.bytes, cmd.until);
      case "task.output": return this.bot(cmd.botId).taskOutput(cmd.messageId, cmd.taskId);
      case "subagent.view": return this.agentView(cmd.botId, cmd.subagentId);
      case "agent.targets": return this.agentTargets(cmd.botId, cmd.subagentId);
      case "agent.move": return this.moveAgent(cmd.botId, cmd.subagentId, cmd.to, { notifyAgent: cmd.notifyAgent === true });
      case "agent.message": return this.agentMessageCommand(cmd.botId, cmd.subagentId, cmd.text);
      case "agent.stop": return this.agentStopCommand(cmd.botId, cmd.subagentId);
      case "agent.group": return this.groupAgents(cmd.botId, cmd.subagentIds, { kind: "newSubBot", name: cmd.name, ...(cmd.note ? { note: cmd.note } : {}) });
      case "subbot.close": return this.closeSubBot(cmd.botId);
      case "chat.read": {
        // You came back to it: many unread replies fold into a summary first (`arrive(at:)`).
        const bot = this.bot(cmd.botId);
        this.catchUps.arrive(bot.catchUpChat());
        return bot.read();
      }
      case "component.command": return this.bot(cmd.botId).componentCommand(cmd.messageId, cmd.index, cmd);
      case "component.detail": return this.bot(cmd.botId).componentDetail(cmd.name, cmd.folder, cmd.values, cmd.card, cmd.command);
      case "component.save": return this.bot(cmd.botId).componentSave(cmd.messageId, cmd.index, cmd.data);
      case "component.report": return { sent: this.reportComponent(cmd) };
      case "chat.feedback": {
        const incoming = join(this.options.dataDir, "incoming");
        const pictures = cmd.images.flatMap((image) => writeIncoming(incoming, image.name, image.base64) ?? []);
        const shot = cmd.screenshot ? writeIncoming(incoming, "feedback.png", cmd.screenshot) : null;
        try { return { sent: this.reportFeedback(cmd.text, cmd.messageId, this.bot(cmd.botId), shot, pictures) }; }
        finally { for (const file of [...pictures, ...(shot ? [shot] : [])]) rmSync(file, { force: true }); }
      }
      case "spec.make": {
        const spec = this.specs.make(this.bot(cmd.botId), cmd.messageId, cmd.purpose ?? null, cmd.preview ?? null);
        return { specId: spec?.id ?? null };
      }
      case "spec.act": return { accepted: await this.specAct(cmd.specId, cmd.action) };
      case "spec.close": this.specs.close(); return {};
      case "engine.models": {
        const bot = this.bot(cmd.botId);
        return this.options.engineModels?.(cmd.engine, bot.profile) ?? discoveryFailure(cmd.engine, "unsupported", "Model discovery is unavailable in this runtime.");
      }
      case "codex.models": return { models: ((await this.options.codexModels?.()) ?? []).slice(0, 200).map((model) => ({ id: model.id.slice(0, 200), name: model.name.slice(0, 200), isDefault: model.isDefault, efforts: model.efforts?.slice(0, 10) ?? null })) };
      case "spec.wide": this.specs.setWide(cmd.wide); return {};
      case "component.revert": {
        const problem = this.components.library.revert(cmd.name);
        if (problem) this.bots.get(MAIN_BOT_ID)?.appNotice(`Couldn't revert component "${cmd.name}": ${problem}`);
        this.componentsTick();
        return { reverted: !problem, problem };
      }
      case "pin.add": return this.bot(cmd.botId).pinAdd(cmd.id, { messageId: cmd.messageId, index: cmd.index, name: cmd.name }, cmd.refresh, cmd.minutes, cmd.seconds);
      case "pin.change": return this.bot(cmd.botId).pinChange(cmd.id, cmd.change);
      case "pin.arrange": return this.bot(cmd.botId).pinArrange(cmd.places);
      case "pin.command": return this.bot(cmd.botId).pinCommand(cmd.id, cmd);
      case "pin.shown": {
        const bot = this.bot(cmd.botId);
        if (cmd.visible) {
          this.visiblePins = { botId: cmd.botId, ids: cmd.ids ?? [] };
          return { ran: bot.refreshDuePins(cmd.ids ?? []) };
        }
        return bot.pinsShown(cmd.ids);
      }
      case "card.image": {
        const file = this.components.images.file(cmd.token);
        if (!file) throw new ContractError("not_found", "No such picture.");
        return file satisfies ResultOf<"card.image">;
      }
      case "catchup.retry": return { started: this.catchUps.retry(this.bot(cmd.botId).catchUpChat(), cmd.key) };
      case "catchup.interval": return { started: this.catchUps.interval(this.bot(cmd.botId).catchUpChat(), cmd.userMessageId) };
      case "turn.stop": return this.bot(cmd.botId).stop(cmd.turnId);
      case "turn.await": return this.bot(cmd.botId).await(cmd.turnId, signal);
      case "card.save": return this.bot(cmd.botId).cardSave(cmd.messageId, cmd.cardId, cmd.data);
      case "card.action": return this.bot(cmd.botId).cardAction(cmd.messageId, cmd.cardId, cmd.name, cmd.value);
      case "card.html": return { html: this.bot(cmd.botId).card(cmd.messageId, cmd.cardId).html } satisfies ResultOf<"card.html">;
      case "routines.list": return this.bot(cmd.botId).routinesView();
      case "routines.change": {
        const { type: _type, botId: _bot, requestId, ...rest } = cmd;
        return this.bot(cmd.botId).changeRoutine({ ...rest, ...(requestId ? { request_id: requestId } : {}) });
      }
      default: throw new ContractError("not_found", `The core does not handle ${cmd.type}.`);
    }
  }

  snapshot(botId?: string): ResultOf<"chat.snapshot"> {
    const bot = this.bots.get(botId ?? MAIN_BOT_ID);
    if (botId && !bot) throw new ContractError("not_found", "No such bot.");
    const views = this.order.map((id) => this.bots.get(id)!.view());
    return {
      epoch: this.epoch,
      seq: this.seq,
      bots: views,
      imported: this.imported,
      chat: bot ? { ...bot.snapshot(), ...this.summaries(bot), pendingFiles: this.pending.views(bot.id) } : null,
      components: this.componentInfos(),
      plugins: this.plugins.view(),
      settings: this.settingsNow(),
      doctor: this.doctor.view(),
      waiting: this.waiting(),
      spec: this.specs.openId ? this.specs.payload(this.specs.openId) : null,
    };
  }

  private settingsNow(): SettingsView {
    return { ...settingsView(readSettings(Layout.settings(this.options.dataDir)), this.language()), agyPermissionSessions: agyPermissionSessions() };
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
    // Turning developer mode on again gives builds a fresh start after failures (`setDeveloperMode`).
    if (change.key === "developerMode" && change.value === true) this.devBuilds.developerModeOn();
    // The developer project's manager hears about it at once if awake, else at its next wake (`setDeveloperMode`).
    const developerNow = this.developerProject();
    if (developerNow && developerNow.id !== developerBefore?.id) developerNow.queueNote(this.devBuilds.briefing(developerNow));
    if (developerBefore && developerBefore.id !== developerNow?.id) {
      developerBefore.queueNote("(App: Developer mode is off for this project now: you can no longer install builds of Botling or take screenshots of it.)");
    }
    // The engine defaults go to every bot at once (`setSubagentModelDefault`, `setCodexWorkerDefaults`).
    const model = settingsView(next).subagentModel;
    if (change.key === "subagentModel" && model !== settingsView(before).subagentModel) {
      for (const bot of this.bots.values()) bot.applyEngineDefaults({ subagentModel: model });
    }
    const workers = appliedCodexWorkers(next);
    if ((change.key === "codexWorkers" || change.key === "codexWorkersFollow") && JSON.stringify(workers) !== JSON.stringify(appliedCodexWorkers(before))) {
      for (const bot of this.bots.values()) bot.applyEngineDefaults({ codexWorkers: codexWorkersJSON(workers) });
    }
    if (change.key === "defaultPrimaryEngine" || change.key === "defaultEngines") for (const bot of this.bots.values()) bot.appPrimaryChanged();
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
    // Re-snapshot synchronously: completion/cancellation after confirmation wins over intent.
    const journal=new RestartJournal(this.options.dataDir);
    if(this.restarting)journal.checkpoint([...this.bots.values()].flatMap(bot=>bot.restartEntries()));
    if (this.routineClock) { clearInterval(this.routineClock); this.routineClock = null; }
    if (this.watchClock) { clearInterval(this.watchClock); this.watchClock = null; }
    this.libraryWatch?.stop(); this.libraryWatch = null;
    if (this.pinClock) { clearInterval(this.pinClock); this.pinClock = null; }
    this.memoryWatch?.stop(); this.memoryWatch = null;
    if (this.waitingTimer) { clearTimeout(this.waitingTimer); this.waitingTimer = null; }
    // (Optional: a core made without its constructor, as tests make one, has neither.)
    this.agentStatus?.close();
    try { this.agents?.flush(); } catch (error) { this.log(`agents.json: ${(error as Error).message}`); }
    // After a swap's drain the heads end without the tidy (it would end their sessions): the new core resumes them.
    const tidy = !this.swapping && !this.restarting;
    // Invoke every participant even if one throws synchronously, and never let an early
    // rejection reach the process exit boundary while another durable flush is pending.
    const participants = [...this.bots.values()].map(bot => () => bot.shutdown({ tidy }));
    participants.push(() => this.plugins.shutdown());
    const results = await Promise.allSettled(participants.map(stop => Promise.resolve().then(stop)));
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Core shutdown failed", { cause: failures[0] });
    if(this.restarting)journal.ready();
  }
}
