import { mobileCommand } from '../mobile-bridge/adapter';
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
import { check, type Classifier } from "./promise-check";
import type { CodexModel } from "./agent/codex-models";
import { appendFeedback, FEEDBACK_NO_WORDS } from "./feedback";
import { archiveEntry } from "./briefing";
import { fileURLToPath } from "node:url";
import { appliedCodexWorkers, applySetting, codexWorkersJSON, launchSettings, readSettings, readSettingsList, seedEngineDefaults, settingsView, writeSettings } from "./settings";
import { HANDED_OUT, botName, childFolders, defaultName, firstLine, folderPath, folderURLText, MemoryFiles, nextAvatar, prepareNotesFolder, projectBriefingText, projectFolders, removeProjectRow, saveProjectRow, type BriefingRow } from "./projects";
import { TeamDesk, loadTeams, prepareTeamsPlugin, type TeamSpec } from "./teams";
import { answerLabel } from "./attachments";
import {
  ContractError, PROTOCOL_VERSION, errorResponse, okResponse, parseInbound,
  type Command, type Event, type ImportView, type Outbound, type ResultOf, type WaitingView, type WhiteboardView,
  type SettingsChange, type SettingsView, type WebStateView, type TeamRunView, type SpecAction,
} from "../contract";
import { filePath, pageInCard } from "./specs";
import { PAGE_COMPONENT } from "./preview-url";
import { Bot, NO_LONGER_NEEDED, type SessionStart, type SessionStartCodex } from "./bot";
import type { HeadConfig } from "./agent/head";
import { CodexThreads, type CodexHeadConfig } from "./agent/codex";
import { maintainerEditorBinding } from "./agent/component-editor";
import type { Engine, Heads } from "./heads";
import { botPrompts, desktopPrompts, isAppLanguage, isResultPublishing, preferredLanguage, type BotPrompts, type ReportTool } from "./prompts";
import { BotStore, readJSON } from "./store/bot-store";
import { DEFAULT_ONE_X_PROCESS, ProjectLock, type OneXCheck } from "./store/lock";
import { ProcessLedger } from "./process/ledger";
import { briefConfig, writeBrief } from "./component-brief";
import { Doctor, DoctorModel } from "./doctor";
import { UsageBook, usageView } from "./usage";
import { importFrom1x, importRecord, looksLike1x, needsImport } from "./store/importer";
import { fromSwiftDate, isOpenQuestion, MAIN_BOT_ID, newId, toSwiftDate } from "./store/records";
import { botDescription, latestAction } from "./whiteboard-data";
import { Layout, loadProfiles, projectProfile, type BotProfile } from "./store/workspace";
import { unsupportedRequest, type BotRequest } from "./reply";
import { Conversations } from "./conversations";
import { GroupChats } from "./group-chats";
import { answeredNote, pickedNote, type GROUP_TIMING } from "./groups";
import { CatchUpCache, CatchUps, catchUpSettings, type CatchUpViewData, type Summarizer } from "./catchup";
import { ComponentsContext } from "./components/service";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { FolderWatch, type WatchTarget } from "./folder-watch";
import { probeNetwork } from "./network-resume";
import {
  checklist, checklistCard, features as shareFeatures, labelCreation, listCard, LABEL, owner as forkOwner, pullRequest, runShare, shareBase,
  type Feature, type ShareRunner,
} from "./community-share";
import { Plugins, type BotInfo } from "./plugins";
import type { HostCommand, HostTiming } from "./plugins/host-client";
import type { Sealer } from "./plugins/secrets";
import { MaintainerDesk, builtInManifest, maintainerProfile, prepareLibrary, MAINTAINER_ID } from "./maintainer";
import { EXTRACTORS_PLUGIN, WebShelf, askAboutWebText, decodeReading, extractorCall, extractorFor, installExtractors, webBriefing, webSites, type WebSite } from "./web";
import { maintainerInstructions } from "./maintainer-text";
import type { ChatRecord } from "./store/records";
import { DevBuilds, devWorkRoot, installTarget, readBuild, spawnInstaller } from "./self-update";
import { parsePlan } from "../hot-install-plan";

/** What the core asks of main (self-update.ts); planBuild and installBuild carry a build's path. */
export type AppOp = "screenshot" | "quit" | "installRelease" | "planBuild" | "installBuild";
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
  /** Whether claude still has a session's transcript, started in a folder (1.x's `claudeSessionExists`); unset: never. */
  claudeSessionExists?: (session: string, folder: string) => boolean;
  /** How long a component brief may take (1.x: 120 s). */
  briefTimeoutMs?: number;
  /** How to run a Codex head (threads: <data>/codex-threads); null when Codex is not available. */
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
  /** How to tell that Botling 1.x has a project open (its data folder; null: do not look). */
  oneX?: OneXCheck;
  /** How often routines are checked (1.x: every 30 s); 0: never (tests drive `checkRoutines`). */
  routineTickMs?: number;
  /** How often quiet runs (and, in 1.x, the network) are looked at (1.x: 20 s; 0: never). */
  watchMs?: number;
  /** How long one of Settings' reminder minutes is (tests shorten it; 60 s). */
  stallMinuteMs?: number;
  /** Whether Claude's API answers again (1.x's `networkProbe`; tests replace it). */
  networkProbe?: () => Promise<boolean>;
  /** Runs git and gh for /share's push and pull request (1.x's `shareRunner`; tests replace it). */
  shareRunner?: ShareRunner;
  /** Writes Catch-up summaries (an isolated `codex exec`); null: there is no summary service. */
  summarizer?: Summarizer | null;
  /** The completion judge on Codex for a model (`completionClassifier`); null: none (the check stays off). */
  classifier?: ((model: string) => Classifier) | null;
  /** The models the local Codex offers (`model/list`); null: none known. */
  codexModels?: (() => Promise<CodexModel[]>) | null;
  /**
   * The component and plugin library is watched for changes on disk (folder-watch.ts); this is how often it is
   * looked at anyway, to catch what a watcher missed (0: neither watched nor looked at; default 60 s; 1.x polled every 1.5 s).
   */
  componentScanMs?: number;
  /** Bots' memory files are watched for what waits on you; this is how often they are looked at anyway (0: never; chat changes always look; default 60 s). */
  waitingScanMs?: number;
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
  /** The app's own copy of the web AIs' page readers (1.x's Resources/web-extractors); null: none. */
  webExtractors?: string | null;
  /** The web AIs the column lists (1.x's three unless a test names its own). */
  webSites?: WebSite[];
  /**
   * The app around the core, for developer mode's <install-build> and <app-screenshot/> (self-update.ts):
   * main's pid and data folder, the app bundle it runs from (null: not a bundle), and what main does on
   * request: a picture of its window, or quitting so the install script can swap the build. Null: no app.
   */
  app?: {
    pid: number | null;
    dataDir: string | null;
    /** The data folder the app opens with when nothing names one (packaged builds; ~/Library/Application Support/…). */
    localDataDir?: string | null;
    bundle: string | null;
    request: (op: AppOp, args?: Record<string, string>) => Promise<AppAnswer>;
  } | null;
}

/** What asking for a bot came to (`Workspace.BotMaking`). */
export type BotMaking = { kind: "made"; botId: string } | { kind: "existing"; botId: string } | { kind: "empty" } | { kind: "taken" } | { kind: "removedByUser" };

export class Core {
  readonly doctor: DoctorModel;
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
  /** The web AIs' conversations and their saved text (<data>/web). */
  readonly web: WebShelf;
  private lastWeb = "";
  private webQueued = false;
  /** The temporary teams at work (`runningTeams`). */
  readonly teams: TeamDesk;
  /** Bots answering in chats that are not their own: call-ins and bots' @ (Phase 4c). */
  readonly conversations: Conversations;
  /** Group chats (Phase 4c): a name and members; each group's chat is a bot that never runs. */
  readonly groups: GroupChats;
  /** Bots taken out of the left column: what they still say goes nowhere. */
  private removed = new Set<string>();
  /** Bots plugins made that you removed (`plugin/name`, lower case; removed-bots.json), so they stay removed. */
  private removedPluginBots = new Set<string>();
  /** <open-question> copies in the main bot's chat: the copy's id → the question it copies. */
  private copies = new Map<string, { botId: string; questionId: string }>();

  constructor(private options: CoreOptions) {
    this.doctor = new DoctorModel(options.doctor, doctor => this.event({ type: "doctor.updated", doctor }));
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
    // The temporary teams: the ccb-teams plugin (team files from before plugins move into it once).
    prepareTeamsPlugin(join(options.dataDir, "plugins"), join(options.dataDir, "teams"));
    try {
      const removed = readJSON(join(options.dataDir, "removed-bots.json"));
      if (Array.isArray(removed)) for (const key of removed) if (typeof key === "string") this.removedPluginBots.add(key);
    } catch { /* none */ }
    // The web AIs' page readers: the plugin ccb-web-extractors (Maintainer's to fix), the app's copy as the fallback.
    installExtractors(join(options.dataDir, "plugins"), options.webExtractors ?? null, () => builtInManifest(EXTRACTORS_PLUGIN, "Web page readers",
      `Reads the conversation on a web AI's page (${(options.webSites ?? webSites()).map((site) => site.name).join(", ")}) into text for the main bot. One script per site; README.md has the contract.`, []));
    this.web = new WebShelf(join(options.dataDir, "web"), options.webSites ?? webSites(), () => this.webChanged());
    const appMaintainer = maintainerProfile(options.dataDir, maintainerInstructions(join(options.dataDir, "plugins"), options.checkCommand ?? null, options.shotCommand ?? null));
    const profiles = [...loaded.profiles, appMaintainer];
    const editorBinding = maintainerEditorBinding(appMaintainer, options.dataDir, options.headConfig);
    const oneX: OneXCheck = options.oneX ?? { folder: null, process: DEFAULT_ONE_X_PROCESS };
    const threads = new CodexThreads(join(options.dataDir, "codex-threads"));
    const codexConfig = options.codexConfig;
    this.profiles = profiles;
    this.newBot = (profile) => {
      const bot = build(profile);
      this.bots.set(profile.id, bot);
      return bot;
    };
    const build = (profile: BotProfile, group = false): Bot => {
      const bot: Bot = new Bot({
        profile,
        deferStartup: options.deferStartup && !this.activated,
        headConfig: options.headConfig,
        codexConfig: codexConfig ? (p, session) => ({
          ...codexConfig(p, session, threads),
          componentEditor: group ? null : editorBinding(p, session),
          editorStarted: (pid) => { if (pid > 0) this.ledger.record(pid); },
        }) : null,
        claimWaitMs: options.claimWaitMs,
        prompts: (engine, heads) => this.prompts(profile, engine, heads),
        // A project's manager works in the user's own folder, shared with 1.x: one Botling at a time.
        lock: profile.role === "manager" && !profile.problem && !group ? new ProjectLock(profile.folder, options.dataDir, oneX) : null,
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
        // …and where the web AIs' saved conversations are (`webBriefing`).
        wakeNote: profile.role === "main" ? () => [this.projectBriefing(), webBriefing(this.web)].filter(Boolean).join("\n\n")
          // The developer project's manager hears what developer mode lets it do (`developerBriefing`).
          : profile.role === "manager" && profile.id !== MAINTAINER_ID && !group ? () => this.devBuilds.briefing(bot) : undefined,
        addDirs: profile.role === "main" ? () => this.profiles.filter((other) => other.role !== "main" && !other.problem).map((other) => join(other.folder, ".bot"))
          // Maintainer: the folders you let it read (<need-folder>).
          : profile.id === MAINTAINER_ID ? () => this.maintainer.approvedFolders() : undefined,
        components: this.components,
        onRequests: (bot, requests) => this.maintainer.handle(bot, this.projectRequests(bot, requests)),
        // What each turn used, by bot, and the subscriptions' limits (1.x's `record`, `note`).
        usage: (name, spent, tokens) => this.usage.record(spent, tokens, name),
        rateLimits: (engine, limits) => this.usage.note(engine, limits),
        // The completion judge, while Settings has it on (`configureCompletionVerification`).
        promiseCheck: () => {
          const classify = this.options.classifier;
          if (!classify) return null;
          const view = settingsView(readSettings(Layout.settings(this.options.dataDir)));
          if (!view.completionVerification) return null;
          const model = view.completionVerificationModel;
          const classifier = classify(model);
          return { model, check: (end) => check(end, classifier) };
        },
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
        // A group's chat shows as a group with its members.
        ...(group ? { viewExtras: () => ({ role: "group" as const, members: this.groups?.members(this.groups.group(profile.id) ?? { id: "", name: "", members: [] }).map((member) => member.id) ?? [] }) } : {}),
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
        return profile && !this.removed.has(id) ? [{ id, name: profile.role === "main" ? "Main bot" : profile.name }] : [];
      }),
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
    this.groups = new GroupChats({
      root: options.dataDir,
      members: () => this.conversations.members(),
      bot: (id) => (this.removed.has(id) ? null : this.bots.get(id) ?? null),
      mainBotId: MAIN_BOT_ID,
      conversations: this.conversations,
      makeChat: (profile) => build(profile, true),
      afterMainTurn: () => this.deliverInboxes(),
      changed: (id, removed) => {
        if (removed) this.options.emit({ v: PROTOCOL_VERSION, epoch: this.epoch, seq: ++this.seq, event: { type: "bot.removed", botId: id } });
        else this.groups.chat(id)?.refresh();
      },
      log: (line) => this.log(line),
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
      chats: () => [...this.order.flatMap((id) => (this.removed.has(id) ? [] : [this.bots.get(id)!])), ...this.groups.groups.flatMap((group) => this.groups.chat(group.id) ?? [])],
      library: this.components.library,
      commands: this.components.commands,
      maintainer: this.maintainer,
      maintainerBot: () => this.bots.get(MAINTAINER_ID) ?? null,
      member: (id) => (this.removed.has(id) ? null : this.bots.get(id) ?? null),
      isGroup: (bot) => !!this.groups.group(bot.id),
      bots: () => this.order.filter((id) => id !== MAINTAINER_ID && !this.removed.has(id)).map((id) => this.bots.get(id)!),
      emit: (spec) => this.event({ type: "spec.updated", spec }),
      componentsChanged: () => this.componentsTick(),
      clock: () => ({}),
      // "Make into component": a read-only fork of the writer's claude session writes Maintainer a brief.
      brief: ({ bot, session, prompt }) => {
        const choices = bot.settingsView();
        const config = briefConfig(options.headConfig(bot.profile, { sessionId: session.toLowerCase(), resume: true, systemPrompt: "", model: choices.model, effort: choices.effort }));
        this.log(`specs: asking a copy of ${bot.profile.name}'s session for a component brief`);
        return writeBrief(config, prompt, options.briefTimeoutMs);
      },
      sessionExists: (session, folder) => options.claudeSessionExists?.(session, folder) ?? false,
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
        bots: () => this.order.map((id) => this.botInfo(this.bots.get(id)!)),
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
    this.teams = new TeamDesk({
      root: options.dataDir,
      // A team's head runs as bots' heads do (the real CLI, or the fake one), in its own folder, asking nothing.
      config: (folder, spec, tools, session) => options.headConfig(
        { id: "team", name: spec.title, role: "bot", avatar: "cloud", folder, memoryPath: ".bot/memory.md", storeDir: folder, tools, job: null, problem: null },
        { sessionId: session.sessionId, resume: false, systemPrompt: session.systemPrompt, model: session.model, pluginDirs: this.plugins.registry.claudeDirectories(), pluginEnv: this.plugins.registry.secretEnvironment(), pluginTools: this.plugins.registry.claudeTools() },
      ),
      language: () => this.language(),
      results: () => { const chosen = this.settings().results; return isResultPublishing(chosen) ? chosen : "artifactUnlessSensitive"; },
      teams: () => this.teamSpecs(),
      tell: (text) => this.bots.get(MAIN_BOT_ID)?.appNotice(text),
      changed: () => this.event({ type: "teams.updated", teams: this.teamViews() }),
      ledger: this.ledger,
      log: (line) => this.log(line),
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
      mainBot: () => this.bots.get(MAIN_BOT_ID)!,
      bot: (id) => (this.removed.has(id) ? null : this.bots.get(id) ?? null),
      appPid: app?.pid ?? null,
      appDataDir: app?.dataDir ?? null,
      localDataDir: app?.localDataDir ?? null,
      // The app the user runs lives on this Mac's disk; only development work goes on the work drive.
      installTarget: (running) => installTarget(running, homedir()),
      devWork: () => devWorkRoot(),
      launchInstaller: (command, log) => {
        spawnInstaller(command, log);
        // Bots write their notes as the app quits; the script waits for that.
        void app?.request("quit");
      },
      installRelease: app ? () => app.request("installRelease") : undefined,
      planBuild: app ? async (path) => {
        const answer = await app.request("planBuild", { path });
        return (answer.ok ? parsePlan(answer.plan) : null) ?? { mode: "restart", reasons: [answer.error ?? "main could not compare the builds"] };
      } : undefined,
      hotInstall: app ? (request) => app.request("installBuild", request) : undefined,
      captureWindow: async () => {
        if (!app) return null;
        try { const answer = await app.request("screenshot"); return answer.ok && answer.file ? answer.file : null; } catch { return null; }
      },
      log: (line) => this.log(line),
    });
    if (!options.deferStartup) this.activate();
  }

  private activate() {
    if (this.activated) return;
    this.activated = true;
    if (this.options.doctor) void this.doctor.run(false).catch(() => this.log("Doctor check failed."));
    for (const bot of this.bots.values()) bot.activateStartup();
    // Started by a core hot swap: the old core's sessions go on, and what waited there is delivered.
    this.adoptSwap();
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
    return this.profiles.filter((profile) => profile.role !== "main" && !profile.problem).map((profile) => ({ path: join(profile.folder, profile.memoryPath), file: true }));
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
    const waiting = [...this.bots.values()].filter((bot) => bot.outage || bot.partner?.outage);
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

  // ------------------------------------------------------------------------------------------
  // /share (1.x's Workspace+Share.swift)

  /** `text` is /share (alone, or with a branch): the app answers it instead of the bot; its line's id. Null for anything else. */
  private share(text: string, bot: Bot): string | null {
    const words = text.trim().split(/\s+/);
    if (words[0] !== "/share" || words.length > 2) return null;
    const line: ChatRecord = { id: newId(), role: "user", text, date: toSwiftDate() };
    bot.post(line, { unread: false });
    const developer = this.developerProject();
    if (!developer || developer.id !== bot.id) {
      bot.appNotice("/share needs developer mode, in the chat of the project that is Botling's source: it shares a feature you built there as a pull request. Turn it on in Settings › Developer mode.");
      return line.id;
    }
    const asked = words[1] ?? null;
    const repo = developer.profile.folder;
    const project = developer.id;
    const tell = (words: string, choices?: { label: string; detail?: string; recommended?: boolean }[], onPick?: (index: number) => void) =>
      bot.appNotice(words, choices, onPick, { sourceID: project });
    setTimeout(() => {
      const base = shareBase(repo);
      const all = shareFeatures(repo, base);
      if (asked) {
        const found = all.find((candidate) => candidate.branch === asked);
        if (!found) {
          tell(`No feature called ${asked} to share: it is not a branch with commits ${base} does not have.${all.length ? ` Yours: ${all.map((candidate) => candidate.branch).join(", ")}.` : ""}`);
          return;
        }
        this.checkShare(found, repo, base, tell, bot);
        return;
      }
      if (!all.length) {
        tell(`No features to share yet. A feature is a branch with commits ${base} does not have: ask your Manager to build one on a branch of its own (bot/<name>), then /share again.`);
        return;
      }
      const card = listCard(all, base);
      tell(card.text, card.choices, (index) => {
        const picked = card.offered[index];
        if (picked) this.checkShare(picked, repo, base, tell, bot);
      });
    }, 0);
    return line.id;
  }

  /** The checklist for `feature`; a card to open its pull request when nothing failed (`check`). */
  private checkShare(feature: Feature, repo: string, base: string, tell: (words: string, choices?: { label: string; recommended?: boolean }[], onPick?: (index: number) => void) => string, bot: Bot) {
    const checks = checklist(repo, feature, base);
    const fork = forkOwner(repo);
    const card = checklistCard(feature, checks, fork);
    if (!card.ready || !fork) { tell(card.text); return; }
    tell(card.text, [{ label: "Open pull request", recommended: true }, { label: "Not now" }], (index) => {
      if (index === 0) void this.openShare(feature, fork, repo, tell, bot);
    });
  }

  /**
   * Pushes `feature` to your fork and opens its pull request with the label, making the label on Botling
   * first when it is missing there; one you may not add is left for the owner to add, and the result says why.
   */
  private async openShare(feature: Feature, fork: string, folder: string, tell: (words: string) => string, bot: Bot) {
    const run = this.options.shareRunner ?? runShare;
    const push = await run(["git", "push", "-u", "origin", feature.branch], folder);
    if (!push.ok) {
      tell(`Couldn't push ${feature.branch} to your fork, so no pull request was opened:\n\n\`\`\`\n${push.output}\n\`\`\``);
      return;
    }
    const lastLine = (text: string) => text.split("\n").filter(Boolean).at(-1) ?? text;
    const labelled = pullRequest(feature, fork, true);
    let made = await run(labelled, folder);
    let refused: string | null = null;
    if (!made.ok && made.output.toLowerCase().includes("label")) {
      // gh refused the label: most often it is missing on Botling. Make it, then try again.
      const creation = await run(labelCreation(), folder);
      const there = creation.ok || creation.output.toLowerCase().includes("already exists");
      if (there) made = await run(labelled, folder);
      if (!there || (!made.ok && made.output.toLowerCase().includes("label"))) {
        refused = there ? made.output : creation.output;
        made = await run(pullRequest(feature, fork, false), folder);
      }
    }
    if (!made.ok) {
      tell(`Couldn't open the pull request for ${feature.branch}:\n\n\`\`\`\n${made.output}\n\`\`\``);
      return;
    }
    const link = made.output.split("\n").findLast((line) => line.startsWith("https://")) ?? made.output;
    const label = refused !== null ? ` It went without the ${LABEL} label, so the Release planner does not list it until the owner adds it: GitHub refused it (\`${lastLine(refused)}\`).` : "";
    tell(`Opened a pull request for "${feature.title}": ${link}${label} Others vote on it with 👍.`);
    bot.queueNote(`(App: The user shared ${feature.branch} with /share: ${link}. Commits pushed to that branch later update the pull request.)`);
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
   * <open-question> note when one asks, and the temporary teams it can start.
   */
  projectBriefing(): string {
    const row = (profile: BotProfile, about: string): BriefingRow => ({
      name: profile.name, about, memory: join(profile.folder, profile.memoryPath), inbox: join(profile.folder, ".bot", "inbox.md"),
      question: this.bots.get(profile.id)?.openQuestion()?.text ?? null,
    });
    const maintainer = this.profiles.find((profile) => profile.id === MAINTAINER_ID) ?? maintainerProfile(this.options.dataDir, "");
    return projectBriefingText({
      projects: this.profiles.filter((profile) => profile.role === "manager" && profile.id !== MAINTAINER_ID).map((profile) => row(profile, `folder ${profile.folder}`)),
      bots: this.profiles.filter((profile) => profile.role === "bot").map((profile) => row(profile, firstLine(profile.job ?? ""))),
      maintainer: row(maintainer, "plugin-library extensions and in-chat components only"),
      teams: this.teamSpecs(),
    });
  }

  /** The teams there are now: agents in enabled plugins' Claude parts (`loadTeams`). */
  teamSpecs(): TeamSpec[] {
    return loadTeams(this.plugins.registry.agentFiles());
  }

  private teamViews(): TeamRunView[] {
    return this.teams.running.slice(0, 50).map((run) => ({ id: run.id, name: run.spec.name.slice(0, 200), title: run.spec.title.slice(0, 200), task: run.task.slice(0, 4_000), startedAt: run.startedAt }));
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
    const existing = this.profiles.find((profile) => profile.role === "bot" && same(profile.name, name));
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
  async removeBot(id: string): Promise<{ removed: boolean }> {
    const profile = this.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new ContractError("not_found", "No such bot.");
    if (profile.role === "main" || id === MAINTAINER_ID) throw new ContractError("forbidden", "The main bot and Maintainer cannot be removed.");
    const bot = this.bots.get(id);
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
    main.appNotice(profile.role === "bot"
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
    const profile = this.profiles.find((candidate) => candidate.role !== "main" && candidate.name.toLowerCase() === wanted);
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
      if (profile.role === "main" || profile.problem) continue;
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
    for (const profile of this.profiles) {
      if (profile.role === "main") continue;
      // A manager's Now card: the first thing under "In progress" in its memory.md.
      if (profile.role === "manager" && !profile.problem) {
        const first = this.memoryFiles.items(join(profile.folder, profile.memoryPath), "inProgress")[0];
        if (first) doing[profile.id] = first.slice(0, 400);
      }
      const question = this.bots.get(profile.id)?.openQuestion();
      if (question) out.push({ botId: profile.id, text: firstLine(question.text).slice(0, 400), messageId: question.id, ...asked(this.bots.get(profile.id), question.id) });
      else for (const item of this.memoryFiles.items(join(profile.folder, profile.memoryPath), "waitingOnYou")) out.push({ botId: profile.id, text: item.slice(0, 400), messageId: null });
    }
    for (const question of this.bots.get(MAIN_BOT_ID)?.openQuestions() ?? []) out.push({ botId: MAIN_BOT_ID, text: firstLine(question.text).slice(0, 400), messageId: question.id, ...asked(this.bots.get(MAIN_BOT_ID), question.id) });
    // Questions in group chats: the member that asked (else the group), and the group (1.x's `inGroups`).
    for (const group of this.groups?.groups ?? []) {
      for (const question of this.groups.chat(group.id)?.openQuestions() ?? []) {
        out.push({ botId: question.sourceID ?? group.id, text: firstLine(question.text).slice(0, 400), messageId: question.id, groupId: group.id, ...asked(this.groups.chat(group.id), question.id) });
      }
    }
    return { items: out.filter((item) => !ignored.has(`${item.botId}-${item.text}`)).slice(0, 200), doing };
  }

  /**
   * The main bot's whiteboard: for every bot but the main bot (groups are its sections, drawn from
   * their members), its memory.md's "Current status", "In progress" and "Decided" (its "Waiting on you" is in `waiting()`), its task cards and its chat's results. Read when
   * asked; the page asks every few seconds while the whiteboard is shown.
   */
  whiteboard(): WhiteboardView {
    const out: WhiteboardView["bots"] = [];
    for (const profile of this.profiles) {
      if (profile.role === "main") continue;
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
    const existing = this.profiles.find((profile) => profile.role !== "main" && profile.folder === folder);
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
    // Teams, new bots and <open-question> (`Workspace.handle`): only the main bot pulls up teams and
    // shows other bots' cards; it makes bots when you ask it, and Maintainer may too. From anyone else
    // they are left out, as in 1.x. They act once the reply is in.
    const main = bot.id === MAIN_BOT_ID;
    const later: (() => void)[] = [];
    const rest: BotRequest[] = [];
    for (const request of requests) {
      if (request.kind === "team") { if (main) later.push(() => this.teams.start(request.name, request.task)); }
      else if (request.kind === "newBot") { if (main || bot.id === MAINTAINER_ID) later.push(() => this.botRequested(request.name, request.job, main ? null : bot.profile.name)); }
      else if (request.kind === "openQuestion") { if (main) later.push(() => this.showOpenQuestion(request.from)); }
      // A bot's <suggest-component>: a chip under its reply; Maintainer's <component-spec>: into that spec (`Workspace.handle`).
      else if (request.kind === "suggestComponent") later.push(() => this.specs.suggest(request.name, request.draft, this.bots.get(bot.id) ?? bot));
      else if (request.kind === "componentSpec") { if (bot.id === MAINTAINER_ID) later.push(() => this.specs.applyUpdate(request.id, request.json, bot.lines().findLast((line) => line.role === "bot")?.text ?? "")); }
      // Developer mode (`proposeBuild`, `sendScreenshot`): a project's manager (the desk checks it is the developer
      // project); from the main bot or a group they do nothing, as in 1.x.
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
      const existing = this.profiles.find((profile) => profile.role !== "main" && profile.folder === folder);
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
  private async send(botId: string, text: string, options: { replyTo?: string; to?: "both" | "claude" | "codex" }): Promise<ResultOf<"chat.send">> {
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

  private async sendWith(bot: Bot, text: string, options: { replyTo?: string; to?: "both" | "claude" | "codex"; files: string[] }): Promise<ResultOf<"chat.send">> {
    if (!text.trim() && !options.files.length) throw new ContractError("bad_request", "Nothing to send.");
    // You wrote in a group (`postToGroup`, after the plugins' beforeSend).
    if (this.groups.group(bot.id)) {
      const outcome = await this.plugins.beforeSend(this.botInfo(bot), text);
      if ("stoppedBy" in outcome) {
        const messageId = bot.appNotice(`Plugin "${outcome.stoppedBy}" stopped this message: ${text}`);
        return { messageId, turnId: null, stoppedBy: outcome.stoppedBy };
      }
      return { ...this.groups.post(bot.id, outcome.send.slice(0, 100_000) || text, options.files, options.replyTo), turnId: null };
    }
    const outcome = await this.plugins.beforeSend(this.botInfo(bot), text);
    if ("stoppedBy" in outcome) {
      const plugin = this.plugins.registry.plugin(outcome.stoppedBy);
      const name = plugin ? (plugin.manifest.displayName ?? plugin.manifest.name) : outcome.stoppedBy;
      const messageId = bot.appNotice(`Plugin "${name}" stopped this message: ${text}`);
      return { messageId, turnId: null, stoppedBy: outcome.stoppedBy };
    }
    const words = outcome.send.slice(0, 100_000) || text;
    // /share is the app's: it lists your features and opens a pull request for one (`Workspace.share`).
    const shared = this.share(words, bot);
    if (shared) return { messageId: shared, turnId: null };
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
    return isAppLanguage(settings.language) ? settings.language : preferredLanguage(this.options.languages ?? [Intl.DateTimeFormat().resolvedOptions().locale]);
  }

  private summaries(bot: Bot): { catchUp: CatchUpViewData | null; intervalSummaries: CatchUpViewData[] } {
    const views = this.catchUps.views(bot.catchUpChat());
    return { catchUp: views.catchUp, intervalSummaries: views.intervalSummaries.slice(-200) };
  }

  /** The bot's instructions (Prompts.swift's), from its profile and the app's settings. */
  prompts(profile: BotProfile, engine: Engine = "claude", heads: Heads | null = null): BotPrompts {
    const settings = this.settings();
    const languages = this.options.languages ?? [Intl.DateTimeFormat().resolvedOptions().locale];
    return desktopPrompts(botPrompts({
      profile: { ...profile, instructions: profile.instructions ?? null },
      language: isAppLanguage(settings.language) ? settings.language : preferredLanguage(languages),
      results: isResultPublishing(settings.results) ? settings.results : "artifactUnlessSensitive",
      engine,
      heads: heads && heads.engines.length > 1 ? { handoffs: heads.handoffs, limits: heads.limits } : null,
    }), profile, this.options.reports ?? null);
  }

  private event(event: Event) {
    // A removed bot (still stopping) is heard no more.
    if (this.removed.size && (("botId" in event && this.removed.has(event.botId)) || (event.type === "bot.updated" && this.removed.has(event.bot.id)))) return;
    this.options.emit({ v: PROTOCOL_VERSION, epoch: this.epoch, seq: ++this.seq, event });
    // A question copied into the main bot's chat was settled in its own: so is the copy.
    if (this.copies.size && event.type === "message.updated") this.closeCopiesOf(event.botId, event.message.id);
    // A question asked or answered, a bot added: what waits on you may have changed.
    if (event.type === "message.added" || event.type === "message.updated" || event.type === "message.removed" || event.type === "bot.updated") this.waitingSoon();
    // Your line closes an interval: it may be summarized by itself (`summarizeClosedInterval`).
    if (event.type === "message.added" && event.message.role === "user") {
      const bot = this.bots.get(event.botId);
      if (bot) this.catchUps.closedInterval(bot.catchUpChat(), event.message.id);
    }
  }

  /** Private mobile transport: the guard and handle's synchronous send prefix share this loop. */
  mobileCommand(raw: unknown, allowedBots: readonly string[]) {
    return mobileCommand({
      pending: botId => this.pending.views(botId),
      snapshot: botId => this.snapshot(botId),
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

  /** Your pick on a called-in bot's line goes back to it (`answerCallIn`), or in a group to that member (`answerInGroup`); null: not such a line. */
  private calledInPick(botId: string, messageId: string, index: number): { accepted: boolean } | null {
    const chat = this.bot(botId);
    const record = chat.line(messageId);
    if (record && this.groups.group(botId) && record.role === "bot" && typeof record.sourceID === "string") {
      const label = record.choices?.[index]?.label;
      if (!isOpenQuestion(record) || label === undefined) return { accepted: false };
      if (!this.groups.answer(botId, record, pickedNote(label))) { chat.settleAppQuestion(messageId, { answer: NO_LONGER_NEEDED }); return { accepted: false }; }
      chat.settleAppQuestion(messageId, { chosen: index });
      return { accepted: true };
    }
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
    if (record && this.groups.group(botId) && record.role === "bot" && typeof record.sourceID === "string" && record.choices?.length) {
      const shown = answerLabel(text.trim(), files);
      if (!shown || !isOpenQuestion(record)) return { accepted: false };
      if (!this.groups.answer(botId, record, answeredNote(shown))) { chat.settleAppQuestion(messageId, { answer: NO_LONGER_NEEDED }); return { accepted: false }; }
      chat.settleAppQuestion(messageId, { answer: shown });
      return { accepted: true };
    }
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

  private bot(id: string): Bot {
    const bot = this.bots.get(id) ?? this.groups.chat(id);
    if (!bot) throw new ContractError("not_found", "No such bot.");
    return bot;
  }

  private async handle(cmd: Command, signal: AbortSignal): Promise<unknown> {
    if (!this.activated && !new Set<string>(["boot.commit", "chat.snapshot", "settings.get", "plugins.list", "plugins.web", "plugins.file", "results.list", "waiting.list", "bot.settings", "usage.view", "doctor.view", "attachment.file", "card.image", "web.state", "link.authorize"]).has(cmd.type)) {
      throw new ContractError("conflict", "Waiting for the update boot receipt to commit. Please try again shortly.");
    }
    switch (cmd.type) {
      case "boot.commit": { const first = !this.activated; this.activate(); if (first) this.event({type:"plugins.updated",plugins:this.plugins.view()}); return {}; }
      case "web.open": {
        const site = this.webSite(cmd.site);
        if (cmd.conversationId) {
          this.web.show(this.webRow(cmd.site, cmd.conversationId).row, site);
          this.web.showing(site);
        } else {
          this.web.openFresh(site);
        }
        return this.webView();
      }
      case "web.new": this.web.startNew(this.webSite(cmd.site)); return this.webView();
      case "web.settle": { const { site, row } = this.webRow(cmd.site, cmd.conversationId); this.web.settle(row, site); return this.webView(); }
      case "web.ask": return this.askMainBot(cmd.site, cmd.conversationId);
      case "web.leave": this.web.showing(null); return this.webView();
      case "web.page": this.web.pageChanged(this.webSite(cmd.site), cmd.page, cmd.url, cmd.title); return {};
      case "web.read": return { file: this.web.record(this.webSite(cmd.site), cmd.page, cmd.url, cmd.title, decodeReading(cmd.json), cmd.settled) };
      case "web.front": this.web.bringToFront(cmd.page, this.webSite(cmd.site)); return {};
      case "web.closed": this.web.closed(cmd.page); return {};
      case "web.handled": this.web.handled(this.webSite(cmd.site)); return {};
      case "web.reader": {
        const found = extractorFor(this.webSite(cmd.site), join(this.options.dataDir, "plugins"), this.options.webExtractors ?? null);
        return { code: found ? extractorCall(found.source) : null, hash: found ? createHash("sha256").update(found.source).digest("hex") : null };
      }
      case "web.state": return this.webView();
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
      case "projects.add": return this.addProject(cmd.folder);
      case "bots.create": {
        const made = this.makeBot(cmd.name, cmd.job, { setUp: true });
        if (made.kind === "empty") throw new ContractError("bad_request", "A bot needs a name and a job.");
        if (made.kind === "taken" || made.kind === "removedByUser") throw new ContractError("conflict", `No bot was made: the name "${botName(cmd.name)}" is already used by a project or the app.`);
        return { botId: made.botId, created: made.kind === "made" };
      }
      case "bots.remove": return this.removeBot(cmd.botId);
      case "groups.create": {
        const group = this.groups.create(cmd.name, cmd.members);
        if (!group) throw new ContractError("bad_request", "A group needs a name and at least one member.");
        return { groupId: group.id };
      }
      case "groups.edit":
        if (!this.groups.edit(cmd.groupId, cmd.name, cmd.members)) throw new ContractError(this.groups.group(cmd.groupId) ? "bad_request" : "not_found", "No such group, or no name or member.");
        return {};
      case "groups.delete":
        if (!(await this.groups.delete(cmd.groupId))) throw new ContractError("not_found", "No such group.");
        return {};
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
      case "bot.settings": return this.bot(cmd.botId).settingsView();
      case "bot.configure": {
        const { type: _type, botId, ...change } = cmd;
        return this.bot(botId).configure(change);
      }
      case "files.add": this.bot(cmd.botId); return { files: this.pending.addPaths(cmd.botId, cmd.paths) };
      case "files.data": this.bot(cmd.botId); return { files: await this.pending.addData(cmd.botId, cmd.name, cmd.base64) };
      case "files.remove": return { files: this.pending.remove(cmd.botId, cmd.id) };
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
      case "chat.choose": return this.calledInPick(cmd.botId, cmd.messageId, cmd.index) ?? this.bot(cmd.botId).choose(cmd.messageId, cmd.index, cmd.text);
      case "chat.answer": {
        // A component's pictures: written to incoming/, kept by the bot with the answer, then removed.
        const files = (cmd.images ?? []).flatMap((image) => writeIncoming(join(this.options.dataDir, "incoming"), image.name, image.base64) ?? []);
        try { return this.calledInAnswer(cmd.botId, cmd.messageId, cmd.text, files.length) ?? this.bot(cmd.botId).answer(cmd.messageId, cmd.text, files); } finally { for (const file of files) rmSync(file, { force: true }); }
      }
      case "chat.react": return this.bot(cmd.botId).react(cmd.messageId, cmd.emoji, cmd.present);
      case "task.output": return this.bot(cmd.botId).taskOutput(cmd.messageId, cmd.taskId);
      case "subagent.view": return this.bot(cmd.botId).subagentView(cmd.subagentId);
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
    const bot = this.bots.get(botId ?? MAIN_BOT_ID) ?? (botId ? this.groups.chat(botId) ?? undefined : undefined);
    if (botId && !bot) throw new ContractError("not_found", "No such bot.");
    // The groups before Maintainer (who stays last).
    const views = this.order.map((id) => this.bots.get(id)!.view());
    const at = views.findIndex((view) => view.id === MAINTAINER_ID);
    views.splice(at < 0 ? views.length : at, 0, ...this.groups.groups.flatMap((group) => this.groups.chat(group.id)?.view() ?? []));
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
      web: this.webView(),
      teams: this.teamViews(),
      spec: this.specs.openId ? this.specs.payload(this.specs.openId) : null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Web AIs (1.x's WebShelf in the core; main shows the sites and reads their pages)

  webView(): WebStateView {
    const web = this.web;
    return {
      folder: web.folder,
      sites: web.sites.map((site) => ({
        id: site.id, name: site.name, accent: site.accent, host: site.host, startURL: site.startURL, insideDomains: site.insideDomains.slice(0, 20),
        status: web.status.get(site.id) ?? { kind: "reading" },
        open: web.open.get(site.id) ?? null,
        requested: web.requested.get(site.id) ?? null,
        front: web.frontPage(site),
        pages: [...web.pages.entries()].filter(([, row]) => web.conversation(row, site)).slice(0, 50).map(([page, row]) => ({ page, row })),
        toReadAgain: web.toReadAgain(site).slice(0, 50).map((row) => ({ id: row.id, url: row.url })),
        conversations: web.conversations(site).slice(0, 500).map((row) => ({
          id: row.id, url: row.url, title: row.title.slice(0, 2_000), messages: row.messages, savedAt: row.savedAt ?? null, updatedAt: row.updatedAt,
          file: web.filePath(row, site), question: row.question?.slice(0, 4_000) ?? null, awaiting: row.askedAt !== undefined, settled: row.settledAt !== undefined,
        })),
      })),
    };
  }

  /** Something about the web AIs changed: the windows (and main, which shows the sites) are told once, after the change. */
  private webChanged() {
    if (this.webQueued) return;
    this.webQueued = true;
    queueMicrotask(() => {
      this.webQueued = false;
      const view = this.webView();
      const text = JSON.stringify(view);
      if (text === this.lastWeb) return;
      this.lastWeb = text;
      this.event({ type: "web.updated", web: view });
    });
  }

  private webSite(id: string): WebSite {
    const site = this.web.site(id);
    if (!site) throw new ContractError("not_found", "No such web site.");
    return site;
  }

  private webRow(siteId: string, conversationId: string) {
    const site = this.webSite(siteId);
    const row = this.web.conversation(conversationId, site);
    if (!row) throw new ContractError("not_found", "No such conversation.");
    return { site, row };
  }

  /** "Ask Main bot about this": the main bot gets a message naming the saved file (`askMainBot`). */
  private async askMainBot(siteId: string, conversationId: string): Promise<ResultOf<"web.ask">> {
    const { site, row } = this.webRow(siteId, conversationId);
    const file = this.web.filePath(row, site);
    if (!file) throw new ContractError("bad_request", "This conversation has no saved text yet.");
    this.web.showing(null);
    const sent = await this.send(MAIN_BOT_ID, askAboutWebText(row.title || site.name, site, file), {});
    return { botId: MAIN_BOT_ID, messageId: sent.messageId };
  }

  private settingsNow(): SettingsView {
    return settingsView(readSettings(Layout.settings(this.options.dataDir)), this.language());
  }

  /** One change on the Settings page: saved in settings.json (other keys kept), then told to every window. */
  private changeSetting(change: SettingsChange): SettingsView {
    const file = Layout.settings(this.options.dataDir);
    const before = readSettings(file);
    const developerBefore = this.developerProject();
    const next = applySetting(before, change);
    writeSettings(file, next);
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
    const view = settingsView(next, this.language());
    this.event({ type: "settings.updated", settings: view });
    return view;
  }

  // ------------------------------------------------------------------------------------------
  // Core hot swap (hot-swap.ts; main/core-swap.ts runs it)

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
  async shutdown() {
    if (this.routineClock) { clearInterval(this.routineClock); this.routineClock = null; }
    if (this.watchClock) { clearInterval(this.watchClock); this.watchClock = null; }
    this.libraryWatch?.stop(); this.libraryWatch = null;
    if (this.pinClock) { clearInterval(this.pinClock); this.pinClock = null; }
    this.memoryWatch?.stop(); this.memoryWatch = null;
    if (this.waitingTimer) { clearTimeout(this.waitingTimer); this.waitingTimer = null; }
    // After a swap's drain the heads end without the tidy (it would end their sessions): the new core resumes them.
    const tidy = !this.swapping;
    await Promise.all([...this.bots.values()].map((bot) => bot.shutdown({ tidy })).concat(this.plugins.shutdown(), this.teams.shutdown()));
  }
}
