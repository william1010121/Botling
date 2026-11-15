import { readImagePaths } from "./read-images";
import { isBrowserTool } from "../browser-bot";
import { runBrowserTool } from "./browser-tools";
import { COMPONENT_USAGE_TOOL, FETCH_TOOL, isBotTool, parseFetchRequest, type BotToolName, type ToolCaller } from "./bot-tools";
import { isNoteTool, runNoteTool } from "./note-tools";
import {nativeRestartContext} from './claude-restart';
import {claudeConfigFolder} from './claude-files';
import { RESEND_WAITING, RESTART_NOTE, restartPausedNotice, type RestartEntry } from './restart-continuation';
import { monitorTask, type CommandMonitor } from "./agent/monitors";
import { AgyAcpHead, isAgyConversationGone } from "./agent/agy-acp";
import { AGY_EXECUTION_BLOCKED } from "./agent/agy";
// One bot in the core: its chat (kept in 1.x's chat.json format), its head (one long-lived
// claude process), the turn under way, the tool approvals it is waiting on, and its subagents
// (subagents.json).
//
// Rules, as in the Swift `Bot` (Bot.swift) unless said otherwise:
// - Waking: an asleep bot's head starts a NEW claude session, and its first message carries the
//   wake briefing (Prompts.swift's wake line: read memory.md), the chat's last lines and the
//   reactions intro before the user's words. The app starting counts as waking.
// - Sleeping: after `idleMs` with nothing under way (no turn, approval, waiting message or running
//   subagent) the bot tidies — the 1.x "tidy" turn, which updates memory.md and is never shown —
//   then its head's stdin is closed. Quitting the app tidies awake bots too, with no time limit (1.x).
// - One turn at a time. A message while a reply is written never stops it (1.x steering; 2.x has no
//   Stop button, Escape pressed twice stops):
//   · a head at work on anything but handed-over work or the tidy takes the message into the turn
//     under way — claude as a message on its stdin, read in at its next step; Codex as `turn/steer` —
//     and that turn goes on: one reply answers both, after your new line, even with an approval
//     open or a foreground subagent at work (an approval is answered by its card, never by words); A line claude reads only after that turn ended gets
//     a turn of its own (`command_lifecycle` "started"), which answers you;
//   · the turn is work the user did not start (handed over by the other head, a routine, a report,
//     claude's own turn), with no approval open and no foreground subagent at work: as 1.x
//     (`Bot.pausing`), that work is paused for you — your message joins the turn under way the same
//     way, with 1.x's pause note (Codex: handed-over work only), and once it has answered you it is
//     told to carry on (1.x's resume note), on the same hand-off, whose reply still goes back to the
//     head that handed it;
//   · otherwise (the tidy; work the user did not start while an approval is open or a foreground subagent
//     works; an Antigravity head, which has no way to take a line in mid-turn; a line already waiting ahead;
//     a line from the app, not the user) the message waits, its line marked "Queued", and goes when the
//     turn ends.
// - Stop closes the turn's gate first (nothing it prints afterwards reaches anyone) and says so,
//   then asks claude to interrupt; a head that does not end the turn in time is ended with its
//   whole process tree.
// - An approval is a chat line with Allow once / Always allow / Don't allow. What a pick means
//   comes from the button's action, never its words. No answer in time counts as no. Approvals
//   left open by a restart or a dead head are closed ("No longer needed"), never answered later.
// - A head that crashes fails the turn it was on and the bot is asleep, as in 1.x: the next message
//   wakes a new session (briefed from memory.md and the chat). A non-zero exit says so in the chat.
// - A reply's tags are acted on (reply.ts): <choices> become buttons whose pick goes back as the
//   user's answer, <task> lines (task cards, removed) are dropped, <reaction> lines set the bot's reaction,
//   <no-reply/> leaves a turn claude started itself (a background subagent reporting) unshown.
//   Other requests (<component>, …) are taken out and a notice says 2.0 cannot do them yet.
// - A project bot shares its project's .bot/ with 1.x.
// - A conversation has one storage owner and app-owned Claude/Codex/Antigravity peers.
//   Each peer has its own process, turns, approvals and partner-<engine>/ files.
//   A user message goes once to the selected primary; peer commentary never broadcasts work.
//   Explicit handoff tags use the conductor's budgets and correlated return routes. A shared
//   decision retains one owner, and a pick on any copy is applied exactly once.
import { createHash, randomUUID } from "node:crypto";
import { backgroundOutputFile } from "./background-work";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LinkedFile } from "./storage";
import { attachmentKind, attachmentList, attachmentsFolder, imageMediaType, keep, namesPath } from "./attachments";
import { keepLineMedia, lineMediaCopy } from "./chat-media";
import { hostKind, type ApprovalAnswerer, type HostFacts, type StartupHost, type WorkerApproval } from "./agent-registry";
import { ContractError, type ApprovalAskView, type RoutineView, type BotView, type SubagentRowView, type ChatSnapshot, type Event, type HeadsView, type MessageView, type ResultOf, type BotSettingsView, type ResultView } from "../contract";
import type { EngineEfforts } from "./engine-defaults";
import { ClaudeHead, type HeadExit } from "./agent/head";
import type { HotSettings } from "./agent/hot-settings";
import { CodexHead, type CodexItem } from "./agent/codex";
import {
  Conductor, displayName, fitted, hasTwo, isActive, otherHead, parseHeadTags, readHeads, resolvePrimary, roundsText,
  type AnswerTarget, type CardPick, type ConductorAction, type Engine, type Handoff, type Heads, type RoundsProgress,
} from "./heads";
import { scheduleCall, scheduledTask, scheduleCancellation, isScheduled, holdsScheduleAwake, type ScheduleCall, type ScheduleCancellation } from "./session-schedules";
import type { RequestEvent, SpeedTotals } from "./token-speed";
import { commandEnded, ReplyText, type CommandState, type StreamItem } from "./agent/stream";
import { archiveAll, archiveLine, reactionIntro, reactionUpdate, recentChat, reportNote, seenReactions, type SeenReactions } from "./briefing";
import { isPlainOK, PARTS_NOTE, PAUSE_NOTE, RESUME_NOTE, withoutPartsNote, type BotPrompts } from "./prompts";
import { parseReply, unsupportedRequest, type BotRequest } from "./reply";
import { SubagentBook, readSubagent, SUBAGENT_TOOLS, type SubagentRecord } from "./subagents";
import type { SubagentHistory } from "./store/subagent-store";
import type { ComponentsContext, DisplayData } from "./components/service";
import { BUILT_INS, spelledSize, type ComponentKnowledge } from "./components/library";
import type { Display } from "./reply";
import { savedQuestions, type QuestionPick } from "./questions";
import { headTurnContent, headTurnEnd } from "./head-turn";
import { costDelta, hasVisibleContent, WorkerCore, WorkerLedger, workerNoteLine, type WorkerCoreFactory, type WorkerLedgerRecord, type WorkerNote } from "./worker-core";
import { projectWorker } from "./worker-projection";
import type { Routine, ScheduledRoutine, ScheduledRoutineStore } from "./routines";
import { BotRoutines } from "./bot/bot-routines";
import { CallInWorkBook, type CallInRelay } from "./call-in-work";
import { PAGE_COMPONENT } from "./page-preview";
import { totalTokens } from "./usage";
import { BotStore, type HeadState } from "./store/bot-store";
import { connectionErrorLine, isConnectionError, lostText, mentionsConnectionError, type Outage } from "./network-resume";
import { apiGaveUpText, apiRetryDelays } from "./api-retry";
import { CONTINUE_NOTE, type SwapEntry } from "./hot-swap";
import { stopBackgroundTasks, type BackgroundKind, type BackgroundTask } from "./background-tasks";
import { fromSwiftDate as fromSwiftDateMs, isOpenQuestion, newId, toSwiftDate, type ChatRecord, type StepRecord } from "./store/records";
import { isWorkerHost, isWorkerType, ownProcessWorker, type WorkerHost, type WorkerOwner, type WorkerOwnerResult, type WorkerSendResult } from "./agent/workers";
import { CLAUDE_AGENT_GUARD, CLAUDE_APP_SERVER, CLAUDE_APP_TOOLS, CLAUDE_ROUTINE_TOOLS, ClaudeWorkers, DEFAULT_CLAUDE_WORKER_LIMIT, claudeWorkersFile } from "./agent/claude-workers";
import { DEFAULT_SPEC_WRITERS } from "./spec-guard";
import { BotContext } from "./bot/context";
import { BotQuestions } from "./bot/questions";
import { BotCards } from "./bot/cards";
import { BotProgress } from "./bot/progress";
import { BotTasks } from "./bot/tasks";
import { BotGuests } from "./bot/guests";
import { BotSettings } from "./bot/settings";
import { NO_LONGER_NEEDED, PLUGINS_RESTART, PROMPT_SESSION_DIVIDER, NEW_SESSION_DIVIDER, readStoredSpec, type SessionStart, type BotOptions, type PresetTurnIds, type Origin, type AgentHead, type Turn, type GuestAnswer, type Approval, type Denial, type StoredSpec } from "./bot/types";
import { union, sleep, turnCommandId, preview, streamingText, subagentOf, isRule, allowRule, permissionText, clip, stepView, iso, subagentView, messageView } from "./bot/view-functions";
import { BotRecords } from "./bot/records";
import { BotSubagentRows } from "./bot/subagent-rows";
import { BotGroup } from "./bot/group";
import { BotDelivery } from "./bot/delivery";
import { BotViews } from "./bot/views";
import { BotDecisions } from "./bot/decisions";
export type Status = "done" | "stopped" | "failed";
export { NO_LONGER_NEEDED } from "./bot/types";
export type { SessionStart, SessionStartCodex, BotOptions, PresetTurnIds, DeferredTurn, GuestAnswer, StoredSpec } from "./bot/types";
export { preview, streamingText, isRule, allowRule, permissionText, stepView, subagentView, messageView } from "./bot/view-functions";


export class Bot {
  readonly store: BotStore;
  readonly subagents: SubagentBook;
  /**
   * Worker return routes (1.x's `managedTaskHandoffs`, `managedHandbackIDs`): a Codex worker started for
   * handed-over work owns that hand-off; the coordinator's turn that only accepted it does not hand back,
   * the worker's report turn does.
   */
  private managedTaskHandoffs = new Map<string, string>();
  private managedHandbacks = new Set<string>();
  get specList(): StoredSpec[] { return this.recordsBook.specList; }
  set specList(value: StoredSpec[]) { this.recordsBook.specList = value; }
  /** Read by BotContext (M7-S41). */
  get records(): ChatRecord[] { return this.recordsBook.records; }
  set records(value: ChatRecord[]) { this.recordsBook.records = value; }
  /** Set when its chat file could not be read: nothing is written over it then. */
  problem: string | null = null;
  readOnly = false;
  head: AgentHead | null = null;
  /** Which CLI this bot's head is. */
  readonly engine: Engine;
  /** Its heads (bot.json `heads`, 1.x's format). Kept by the primary; a partner reads it. */
  /** Read by BotContext (M7-S41). */
  get headsSettings(): Heads { return this.settings.headsSettings; }
  set headsSettings(v: Heads) { this.settings.headsSettings = v; }
  private startupActive = false;
  /** Read by BotContext (M7-S41). */
  get partners() { return this.group.partners; }
  set partners(v) { this.group.partners = v; }
  /** Compatibility view for integrations that inspect the first peer. Routing uses all peers. */
  get partner(): Bot | null { return this.ctx.partner; }
  get peers(): Bot[] { return this.ctx.peers; }
  /** Read by BotContext (M7-S41): it stays here because it names `this` as the Bot itself. */
  get members(): Bot[] { return [this, ...this.peers]; }
  private ownsTurn(id: string): boolean { return this.ctx.ownsTurn(id); }

  get conductor() { return this.group.conductor; }
  set conductor(v) { this.group.conductor = v; }
  /** Read by BotContext (M7-S41). */
  get claimHold() { return this.group.claimHold; }
  set claimHold(v) { this.group.claimHold = v; }
  private get lastLead() { return this.group.lastLead; }
  private set lastLead(v) { this.group.lastLead = v; }
  get pendingNote() { return this.delivery.pendingNote; }
  set pendingNote(v) { this.delivery.pendingNote = v; }
  get pendingAbout() { return this.delivery.pendingAbout; }
  set pendingAbout(v) { this.delivery.pendingAbout = v; }
  /** The conductor's cards waiting for a pick: what each button does. */
  get cardPicks() { return this.guests.cardPicks; }
  set cardPicks(v) { this.guests.cardPicks = v; }
  get handoffDecisions() { return this.group.handoffDecisions; }
  set handoffDecisions(v) { this.group.handoffDecisions = v; }
  get rounds() { return this.group.rounds; }
  set rounds(v) { this.group.rounds = v; }
  /** Codex: workers at work or their reports waiting (the bot stays awake). */
  managedPending = false;
  get outage(): Outage | null { return this.progress.outage; }
  get retryingConnection() { return this.progress.retryingConnection; }
  set retryingConnection(v: boolean) { this.progress.retryingConnection = v; }
  private get apiRetries() { return this.progress.apiRetries; }
  private set apiRetries(v: number) { this.progress.apiRetries = v; }
  get codexRetry() { return this.progress.codexRetry; }
  set codexRetry(v: NonNullable<BotView["codexRetry"]> | null) { this.progress.codexRetry = v; }
  /** Subagents whose last line was claude's connection error (1.x's `cutOffByNetwork`). */
  private cutOffByNetwork = new Set<string>();
  /** Tidying memory.md before it sleeps. */
  tidying = false;
  /** Read by BotContext (M7-S41). */
  turn: Turn | null = null;
  /** Messages that wait for the turn under way (or the tidy) to end. */
  /** Read by BotContext (M7-S41). */
  queue: Turn[] = [];
  private finished = new Map<string, Status>();
  get approvals(): Map<string, Approval> { return this.questions.approvals; }
  set approvals(value: Map<string, Approval>) { this.questions.approvals = value; }
  draining: { head: AgentHead; resolve: () => void; promise: Promise<void> } | null = null;
  /** Results still to come from turns ended early (a tidy or a guest turn that ran late): they belong to nobody. */
  ignoreResults = 0;
  /** The app's own questions in this chat (installing a plugin): what a pick does. */
  get appQuestions() { return this.guests.appQuestions; }
  set appQuestions(v) { this.guests.appQuestions = v; }
  /** …and what words typed on one do instead of going to the bot (a copy of another bot's question). */
  get appAnswers() { return this.guests.appAnswers; }
  set appAnswers(v) { this.guests.appAnswers = v; }
  /** The subagent rows as the windows last saw them (a change sends bot.updated). */
  get lastRows(): string { return this.recordsBook.lastRows; }
  set lastRows(value: string) { this.recordsBook.lastRows = value; }
  /** What the app tells it with its next message (`queueNote`). */
  get queuedNote() { return this.delivery.queuedNote; }
  set queuedNote(v) { this.delivery.queuedNote = v; }
  /** Work paused for the user's message (1.x's `pausedWork`): carried on once the user has been answered. */
  private paused: { conducted: boolean; handoffId: string | null } | null = null;
  /** Read by BotContext (M7-S41). */
  session: HeadState;
  /** The next head is a new session: its first message carries the wake briefing. */
  briefing = true;
  /** Its next message starts its process again in the same session (1.x's `restart(_:)`, e.g. "may read …"). */
  restartPending = false;
  modelSettingsPending = false;
  /**
   * The restart waiting is for a new working folder (a plugin's `sessions.folder`): your message never goes to the process
   * still in the old one; while its own work runs it waits, as for a model change (spec/models/folders TurnStartsCurrent).
   */
  folderPending = false;
  /** The restart waiting is also for something other than its model or effort (plugins, folders, subagents' model): a hot switch cannot stand in for it. */
  restartNonModel = false;
  /** Counts model/effort changes, so a hot switch that finishes after a newer one leaves that one waiting. */
  private settingsGeneration = 0;
  /**
   * Your message waits for this head's own work (its subagents, workers, background tasks) to finish, so a
   * model or effort change that needs a restart can be applied first; it is sent then, never on the old
   * settings. `noticeId`: the chat card that says so.
   */
  private settingsHold: { noticeId: string; timer: ReturnType<typeof setInterval> } | null = null;
  /** Why it starts again before its next message (1.x's `RestartReason`): what it is told, what its divider says. */
  restartReason: { told: string; shown: string } | null = null;
  /** The restart waiting is only for plugins: when they changed back, it is not needed (1.x's `pendingRestartForPluginsOnly`). */
  restartForPluginsOnly = false;
  /** The plugins' Claude parts its process started with (1.x's `loadedPluginStamp`). */
  private loadedPluginStamp: string[] | null = null;
  /** A head ended for such a restart: its session carries on. */
  restarting: AgentHead | null = null;
  /** What its process has cost so far (claude's `total_cost_usd`, a running total; 1.x's `sessionCost`). */
  private sessionCost = { last: 0 };
  /** Its head runs on another CLI from its next message on (1.x's `switchEngine`): a handoff through memory.md first. */
  /** Read by BotContext (M7-S41). */
  get switchTo(): Engine | null { return this.settings.switchTo; }
  set switchTo(v: Engine | null) { this.settings.switchTo = v; }
  /** Writing that handoff (1.x's `.switching(.writing)`). */
  get switching() { return this.settings.switching; }
  set switching(v: boolean) { this.settings.switching = v; }
  private idleTimer: NodeJS.Timeout | null = null;
  private get alwaysAllowed(): string[] { return this.questions.alwaysAllowed; }
  private set alwaysAllowed(value: string[]) { this.questions.alwaysAllowed = value; }
  get denialAsks(): Map<string, Denial> { return this.questions.denialAsks; }
  set denialAsks(value: Map<string, Denial>) { this.questions.denialAsks = value; }
  private get sessionRules(): string[] { return this.questions.sessionRules; }
  private set sessionRules(value: string[]) { this.questions.sessionRules = value; }
  private get rulesGivenAfter(): Map<string, string | null> { return this.questions.rulesGivenAfter; }
  private set rulesGivenAfter(value: Map<string, string | null>) { this.questions.rulesGivenAfter = value; }
  private get scheduleCalls() { return this.tasks.scheduleCalls; }
  /** Owned by BotQuestions (M7-S44); an accessor each, so a test that assigns or reads one on a Bot still works. */
  private get toolCalls(): Map<string, { tool: string; detail: string; parent: string | null }> { return this.questions.toolCalls; }
  private set toolCalls(value: Map<string, { tool: string; detail: string; parent: string | null }>) { this.questions.toolCalls = value; }
  private get deniedFrames(): Map<string, { tool: string | null; reason: string }> { return this.questions.deniedFrames; }
  private set deniedFrames(value: Map<string, { tool: string | null; reason: string }>) { this.questions.deniedFrames = value; }
  private get deniedCalls(): Set<string> { return this.questions.deniedCalls; }
  private set deniedCalls(value: Set<string>) { this.questions.deniedCalls = value; }
  get unread(): number { return this.recordsBook.unread; }
  set unread(value: number) { this.recordsBook.unread = value; }
  shuttingDown = false;
  /** What this head's session has been told of the chat's reactions (null: tell it from scratch). */
  get reactionsSeen(): SeenReactions | null { return this.recordsBook.reactionsSeen; }
  set reactionsSeen(value: SeenReactions | null) { this.recordsBook.reactionsSeen = value; }
  /** Finished subagents a silent turn has already been asked to report, once. */
  private reportAsked = new Set<string>();
  /** Subagents that ended between turns: the next turn claude starts itself reports them. */
  private pendingEnded: string[] = [];
  /** While tidying, a Codex worker's report turn on the memory update (`internalReply` kept open in 1.x). */
  private tidyFollowUp: ((text: string) => void) | null = null;
  /** Heads being ended (a Stop it did not listen to, quitting): nothing they print counts any more. */
  ending = new WeakSet<AgentHead>();
  /** The other head's words written to claude mid-turn, by message uuid: one that gets a turn of its own is the app's. */
  contextSent = new Set<string>();
  /** Your lines written to claude while its turn ran, by message uuid: one claude begins a turn of its own for is answered there. */
  steered = new Map<string, Turn>();
  /**
   * claude has a turn under way: it said "started" for a line, or its turn said something, and no result came since.
   * A "started" for a line then means claude read it into that turn (3353d2d9), never a turn of its own.
   */
  private claudeMidTurn = new WeakSet<AgentHead>();
  /** Your lines offered into an Antigravity turn (`offerInsert`), by id: in the queue ("Queued") until it reads them. */
  private inserting = new Map<string, Turn>();
  /** Our turn that claude has not begun yet, set aside while it answers the other head's words first. */
  /** Read by BotContext (M7-S41). */
  deferred: Turn | null = null;
  /**
   * The deferred turn back as the turn under way that claude has not begun yet (no "started", no output), and the clock
   * that ends it if claude never does: its words were taken into the turn that just ended, so nothing more comes for it.
   */
  private unbegun: { turn: Turn; head: AgentHead; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The components and cards of this bot (M7-S43): made on first use, from this bot. */
  private botCards: BotCards | null = null;
  private get cards(): BotCards { return this.botCards ??= new BotCards(this, this.ctx); }
  /** The fields BotCards owns, as this bot has always had them (`componentList` and `componentsMayHaveChanged` are read by BotCards through other bots). */
  get componentList(): string[] | null { return this.cards.componentList; }
  set componentList(list: string[] | null) { this.cards.componentList = list; }
  private get briefedComponents(): ComponentKnowledge | null { return this.cards.briefedComponents; }
  private set briefedComponents(told: ComponentKnowledge | null) { this.cards.briefedComponents = told; }
  get componentsMayHaveChanged(): boolean { return this.cards.componentsMayHaveChanged; }
  set componentsMayHaveChanged(may: boolean) { this.cards.componentsMayHaveChanged = may; }

  /** Made on first use, from this bot: a fake `Object.create(Bot.prototype)` has one too. */
  private botContext: BotContext | null = null;
  private get ctx(): BotContext { return this.botContext ??= new BotContext(this); }
  /** Made on first use too (M7-S44): it owns the approvals and the allow rules. */
  private botQuestions: BotQuestions | null = null;
  private get questions(): BotQuestions { return this.botQuestions ??= new BotQuestions(this, this.ctx); }
  private botProgress: BotProgress | null = null;
  private get progress(): BotProgress { return this.botProgress ??= new BotProgress(this, this.ctx); }
  private botTasks: BotTasks | null = null;
  private get tasks(): BotTasks { return this.botTasks ??= new BotTasks(this, this.ctx); }
  private botGuests: BotGuests | null = null;
  private get guests(): BotGuests { return this.botGuests ??= new BotGuests(this, this.ctx); }
  private botSettings: BotSettings | null = null;
  private get settings(): BotSettings { return this.botSettings ??= new BotSettings(this, this.ctx); }
  /** Made on first use, from this bot (M7-S42). */
  private botRoutines: BotRoutines | null = null;
  private get routines(): BotRoutines { return this.botRoutines ??= new BotRoutines(this, this.ctx); }
  private botRecords: BotRecords | null = null;
  private get recordsBook(): BotRecords { return this.botRecords ??= new BotRecords(this, this.ctx); }
  private botSubagentRows: BotSubagentRows | null = null;
  private get subagentRowBook(): BotSubagentRows { return this.botSubagentRows ??= new BotSubagentRows(this, this.ctx); }
  private botGroup: BotGroup | null = null;
  private get group(): BotGroup { return this.botGroup ??= new BotGroup(this, this.ctx); }
  private botDelivery: BotDelivery | null = null;
  private get delivery(): BotDelivery { return this.botDelivery ??= new BotDelivery(this, this.ctx); }
  private botViews: BotViews | null = null;
  private get views(): BotViews { return this.botViews ??= new BotViews(this, this.ctx); }
  private botDecisions: BotDecisions | null = null;
  private get decisions(): BotDecisions { return this.botDecisions ??= new BotDecisions(this, this.ctx); }

  constructor(/** Read by BotContext (M7-S41). */ public options: BotOptions) {
    const primary = options.primary;
    this.engine = options.engine ?? "claude";
    const storeDir = primary ? join(primary.profile.storeDir, `partner-${this.engine}`) : options.profile.storeDir;
    this.store = options.botStore ? options.botStore(storeDir) : new BotStore(storeDir);
    // A new session at every start: the app starting is a wake (1.x).
    this.session = { sessionId: randomUUID(), started: false };
    this.alwaysAllowed = (primary ?? this).storeAlwaysAllowed();
    this.unread = primary ? 0 : this.store.loadUnread();
    // Kept from trimming: the ones another bot owns now (their rows and steps are its to show).
    this.subagents = new SubagentBook(this.readList("subagents.json", readSubagent), () => new Set(this.options.agents?.retained(this.engine) ?? []));
    this.subagents.sink = (id, line) => { if (!this.readOnly) this.store.stageSubagentLine(id, line); };
    // Its app-managed workers' rows are the worker ledger's projection (`projectWorker`), never their end notices.
    this.subagents.workerProjection = true;
    this.subagents.loadSteps = (id) => this.store.readSubagentSteps(id).steps.slice(-500);
    if (!primary) {
      this.specList = this.readList("specs.json", readStoredSpec);
      const list = this.store.loadSettings().components;
      this.componentList = Array.isArray(list) ? list.filter((name): name is string => typeof name === "string") : null;
    }
    if (primary) {
      this.headsSettings = primary.headsSettings;
    } else {
      const settings = this.store.loadSettings();
      this.headsSettings = readHeads(settings.heads, settings.engine);
      // 1.x's `engine`: the primary's head when it is one of the bot's heads.
      const saved = settings.engine === "agy" || settings.engine === "codex" || settings.engine === "claude" ? settings.engine : null;
      (this as { engine: Engine }).engine = saved && this.headsSettings.engines.includes(saved) ? saved : this.headsSettings.engines[0]!;
    }
    if (this.engine === "agy") {
      const saved = this.store.loadSettings().agyConversation;
      if (typeof saved === "string" && /^[0-9a-f-]{36}$/i.test(saved)) { this.session = { sessionId: saved, started: true }; this.briefing = false; }
    }
    this.conductor = new Conductor(this.headsSettings);
    this.load();
    // Subagents that were running when the app went away went with their process. App-managed workers are their
    // ledger's: shown as it says (one it still lists at work was cut off), until their core is up.
    this.projectLedgerAtStart();
    // A worker its ledger does not have yet (an old journal not imported until its core is up) stopped, as before.
    if (this.subagents.stopRunning(undefined, (subagent) => this.workerViews.has(subagent.id))) this.saveSubagents();
    // Claude workers in the ledger (or still only in claude-workers.json): restored (one at work when the app went away
    // is interrupted), and a report that never reached this head is handed over again once the bot is up.
    if (this.engine === "claude" && (existsSync(this.workerLedgerFile) || existsSync(claudeWorkersFile(this.store.directory)))) {
      const workers = this.ensureClaudeWorkers();
      setTimeout(() => { if (!this.shuttingDown) workers.redeliver(); }, 0).unref?.();
    }
    if (!options.deferStartup) this.activateStartup();
    if (!primary) {
      if (!this.readOnly) this.saveHeads();
      for (const engine of this.headsSettings.engines) if (engine !== this.engine) this.makePartner(engine, true);
      this.giveFirstComponents();
    }
  }

  activateStartup() {
    if (this.startupActive) return;
    this.startupActive = true;
    if (!this.problem && !this.options.primary) archiveAll(this.paths.archive, this.records);
    if (!this.options.primary) this.setUpRoutines();
    for (const peer of this.peers) peer.activateStartup();
  }

  private storeAlwaysAllowed() {
    return this.store.loadAlwaysAllowed();
  }

  /** The bot whose chat this is (itself, or a partner's primary). Read by BotContext (M7-S41): it names `this` as the Bot itself. */
  get owner(): Bot {
    return this.options.primary ?? this;
  }

  private get chat(): ChatRecord[] { return this.ctx.chat; }
  private get sharesChat(): boolean { return this.ctx.sharesChat; }
  get heads(): Heads { return this.ctx.heads; }
  private peerEngine(head: Engine): Engine { return this.ctx.peerEngine(head); }
  private get singleActionApprovals(): boolean { return this.ctx.singleActionApprovals; }
  private allowsEngineRoute(head: Engine, from?: Engine): boolean { return this.ctx.allowsEngineRoute(head, from); }
  private requireEngineRoute(head: Engine, from?: Engine): void { this.ctx.requireEngineRoute(head, from); }
  private botFor(head: Engine): Bot | null { return this.ctx.botFor(head); }

  makePartner(onDemand?: Engine, restore?: boolean): Bot | null { return this.group.makePartner(onDemand, restore); }

  get id() { return this.ctx.id; }
  get profile() { return this.ctx.profile; }
  get paths() { return this.ctx.paths; }
  log(line: string) { this.ctx.log(line); }
  emit(event: Event) { this.ctx.emit(event); }

  fromPartner(partner: Bot, event: Event) { return this.recordsBook.fromPartner(partner, event); }
  private readList<T>(name: "subagents.json" | "specs.json", read: (value: unknown) => T | null): T[] { return this.recordsBook.readList(name, read); }
  private load() { return this.recordsBook.load(); }
  persist(soon = false) { return this.recordsBook.persist(soon); }
  messageView(record: ChatRecord): MessageView { return this.recordsBook.messageView(record); }

  // ------------------------------------------------------------------------------------------
  // Component specs (1.x's `specs`, `editSpecs`)

  get specs(): readonly StoredSpec[] { return this.recordsBook.specs; }
  editSpecs(change: (specs: StoredSpec[]) => void): boolean { return this.recordsBook.editSpecs(change); }
  refreshLine(messageId: string) { return this.recordsBook.refreshLine(messageId); }
  add(record: ChatRecord, options?: { archive?: boolean }) { return this.recordsBook.add(record, options); }
  changed(record: ChatRecord) { return this.recordsBook.changed(record); }
  remove(record: ChatRecord) { return this.recordsBook.remove(record); }
  notice(text: string) { return this.recordsBook.notice(text); }

  appNotice(text: string, choices?: { label: string; recommended?: boolean; detail?: string }[], onPick?: (index: number) => void,
    more?: { onAnswer?: (text: string, files: string[]) => boolean; sourceID?: string; sourceMessageID?: string; moveNotice?: string; questions?: ChatRecord["questions"] }): string {
    return this.guests.appNotice(text, choices, onPick, more);
  }

  relay(text: string, options?: { files?: string[]; feedback?: { about: string; words: string } }): ResultOf<"chat.send"> { return this.recordsBook.relay(text, options); }
  appMessage(text: string): string | null { return this.recordsBook.appMessage(text); }

  // ------------------------------------------------------------------------------------------
  // Turns in other chats (1.x's `groupTurn`, `post`, `keepCallIn`)

  private get guestTurn() { return this.guests.guestTurn; }
  private set guestTurn(v: boolean) { this.guests.guestTurn = v; }
  /** The core is being swapped: no turn begins (hot-swap.ts). */
  private swapHold = false;

  groupTurn(text: string, waitForMs: number, answerWithinMs: number, options?: { callIn?: string; asked?: string; by?: "user"; onBegin?: () => void; signal?: AbortSignal }): Promise<GuestAnswer> {
    return this.guests.groupTurn(text, waitForMs, answerWithinMs, options);
  }
  get takesGuest(): boolean { return this.guests.takesGuest; }
  post(record: ChatRecord, options?: { unread?: boolean }) { return this.guests.post(record, options); }

  keepCallIn(asked: string, at: number, line: ChatRecord) { return this.guests.keepCallIn(asked, at, line); }
  keepFiles(files: string[]): { url: string; kind: string; path: string }[] { return this.guests.keepFiles(files); }
  guestReactions(actions: { messageId: string; emoji: string; present: boolean }[], actor: string) { return this.guests.guestReactions(actions, actor); }

  markRead() { return this.recordsBook.markRead(); }

  openQuestion() { return this.guests.openQuestion(); }
  lines(): readonly ChatRecord[] { return this.guests.lines(); }
  line(id: string): ChatRecord | null { return this.guests.line(id); }
  ignoreQuestion(id: string, at?: string): ResultOf<"chat.ignoreQuestion"> { return this.guests.ignoreQuestion(id, at); }
  syncIgnoredCopies(sourceID: string, sourceMessageID: string, at: string): void { return this.guests.syncIgnoredCopies(sourceID, sourceMessageID, at); }
  settleAppQuestion(id: string, outcome: { chosen?: number; answer?: string }): void { return this.guests.settleAppQuestion(id, outcome); }
  holdCardAnswer(id: string, outcome: { chosen?: number; answer?: string }, to: string): boolean { return this.guests.holdCardAnswer(id, outcome, to); }
  releaseCardAnswer(id: string, delivered: boolean): void { return this.guests.releaseCardAnswer(id, delivered); }
  openCopies(botId?: string): ChatRecord[] { return this.guests.openCopies(botId); }
  settleSubagent(id: string, settled: boolean): ResultOf<"subagent.settle"> { return this.guests.settleSubagent(id, settled); }

  /** Each head's session, this one first (null: none started yet), for plugins' `workspace.current`. */
  headSessions(): { engine: Engine; sessionId: string | null }[] {
    return this.members.map((bot) => ({ engine: bot.engine, sessionId: bot.session.started ? bot.session.sessionId : null }));
  }

  /** Where this head's subagents live, for the agent registry. */
  hostFacts(): HostFacts {
    return { botId: this.owner.profile.id, engine: this.engine, sessionId: this.session.sessionId, folder: this.commandFolder, kind: hostKind(this.engine) };
  }

  /** What the registry (and C1) reads of one of its subagents, whichever head holds it. */
  agentFacts(nativeId: string): { status: SubagentRecord["status"]; steps: StepRecord[]; result: string; execution: SubagentRecord["execution"] | null; agentID: string | null; background: boolean } | null {
    for (const bot of this.members) {
      const found = bot.subagents.get(nativeId);
      if (!found) continue;
      const steps = found.steps.length ? found.steps : bot.subagentHistory(found).steps;
      return { status: found.status, steps: [...steps], result: found.result ?? "", execution: found.execution ?? null, agentID: typeof found.agentID === "string" ? found.agentID : null, background: found.background };
    }
    return null;
  }

  /** Its heads' subagent lists as they are now, for the registry's reconcile at start. */
  hostBooks(): StartupHost[] {
    return this.members.map((bot) => ({ ...bot.hostFacts(), running: bot.head?.running ?? false, list: bot.subagents.list, workers: bot.workerViews }));
  }

  /** One of its own rows by native id (for the owner's list when another bot owns it), with the head that holds it. */
  subagentRowFor(nativeId: string): SubagentRowView | null {
    for (const bot of this.members) {
      if (!bot.subagents.get(nativeId)) continue;
      return bot.subagents.rows(bot.engine).find((row) => row.id === nativeId) ?? null;
    }
    return null;
  }

  /**
   * A subagent by the id or name its engine reaches it by (Claude's `SendMessage` `to`, a Codex or Antigravity
   * worker's task id), or its call's id, for the sub-bot hand-off: where it is, which head holds it, which engine
   * it runs on, what it was asked and the steps it has taken (read from its file).
   */
  findSubagent(key: string): { id: string; status: SubagentRecord["status"]; head: Engine; engine: Engine; description: string; prompt: string; result: string; steps: StepRecord[]; threadId: string | null; run: number | null } | null {
    for (const bot of this.members) {
      const found = bot.subagents.find(key);
      if (!found) continue;
      const steps = found.steps.length ? found.steps : bot.subagentHistory(found).steps;
      const runtime = (found as { runtime?: { engine?: unknown } }).runtime?.engine;
      const engine: Engine = runtime === "codex" || runtime === "agy" || runtime === "claude" ? runtime : bot.engine;
      return {
        id: found.id, status: found.status, head: bot.engine, engine, description: found.description, prompt: found.prompt, result: found.result ?? "", steps: [...steps],
        threadId: found.execution?.threadId ?? null, run: found.execution?.run ?? null,
      };
    }
    return null;
  }

  /** The engines this bot may run a sub bot on (its heads). */
  get headEngines(): Engine[] { return [...this.headsSettings.engines]; }

  /**
   * How the hand-off reaches a subagent: `ask` (claude: the project bot's own SendMessage, so the app only waits),
   * `steer` (a Codex worker: the app joins a wrap-up request into its turn), or `stop` (an Antigravity worker
   * takes no message while it works: it is stopped at once).
   */
  handoffMode(subagentId: string): "ask" | "steer" | "stop" {
    const holder = this.members.find((bot) => bot.subagents.find(subagentId));
    const host = holder?.workerHostFor(subagentId);
    if (host) return host.steersRunning ? "steer" : "stop";
    return "ask";
  }

  /** Sends a worker at work the wrap-up request (false: not sent: it is not at work, not a worker, or its engine cannot be steered). */
  askForHandoff(subagentId: string, text: string): boolean {
    const holder = this.members.find((bot) => bot.subagents.find(subagentId));
    const found = holder?.subagents.find(subagentId);
    const host = found ? holder?.workerHostFor(found.id) : null;
    if (!host?.steersRunning || !found) return false;
    if (host.listWorkers().find((worker) => worker.id === found.id)?.state !== "running") return false;
    const sent = host.sendToWorker(found.id, text);
    return !(sent instanceof Promise) && sent.ok && sent.how === "steered";
  }

  /**
   * The hand-off's last resort. Claude: the turn running now is stopped whole (claude has no stop for one subagent).
   * An app-managed worker (any engine) is stopped alone (no report is made). Either way the
   * subagent, if it still shows as running, is marked stopped. It then goes on in a sub bot from its handoff file.
   */
  async stopForHandoff(subagentId: string): Promise<void> {
    const holder = this.members.find((bot) => bot.subagents.find(subagentId));
    const found = holder?.subagents.find(subagentId);
    const host = found ? holder?.workerHostFor(found.id) : null;
    if (holder && found && host) await host.stopWorker(found.id).catch((error) => this.log(`sub-bot hand-off: stopping worker ${found.id}: ${(error as Error).message}`));
    else {
      const owner = this.owner;
      const turn = owner.turn;
      if (turn && turn.origin !== "tidy") await owner.stop(turn.id);
    }
    for (const bot of this.members) {
      if (bot.subagents.stopOne(subagentId)) { bot.saveSubagents(false, bot.subagents.get(subagentId)); this.rowsChanged(true); }
    }
  }

  /** Claude's app-managed workers (claude-workers.ts), made when first needed; they belong to this bot, not to its head process. */
  claudeWorkerHost: ClaudeWorkers | null = null;
  /** Answers worker approval cards through this member's worker host (the bot's approvals keep the head that asked; a worker's is its manager). */
  private readonly workerApprovals = { running: true, answer: (requestId: string, allow: boolean, input: Record<string, unknown>, message?: string) => { this.workerHost?.answer(requestId, allow, input, message); } } as unknown as AgentHead;

  /** <member store>/worker-ledger.json: the one record of this member's app-managed workers (shared-core spec 3.2). */
  private get workerLedgerFile() { return join(this.store.directory, "worker-ledger.json"); }
  /** What each of its workers' ledger records last said (the registry's and the rows' state come from it). */
  private workerViews = new Map<string, WorkerLedgerRecord>();

  /**
   * This member's worker core, as its facade makes it (ClaudeWorkers, its Codex or Antigravity head): the member's
   * ledger (the old journals imported once, then never written), every transition projected, and a restart told from
   * a quit. One live core per member: a head's core goes with its head.
   */
  private readonly workerCore: WorkerCoreFactory = (options, legacy) => {
    const core = new WorkerCore({
      ...options, store: new WorkerLedger(this.workerLedgerFile, legacy),
      projected: (record) => this.projectWorker(record),
      note: (note, text) => this.workerNote(note, text),
      closeReason: () => (this.swapHold ? "restart" : "quit"),
      log: (line) => this.log(line),
    });
    // Once the facade that asked for it is made (it may be made while this bot is).
    queueMicrotask(() => core.projectAll());
    return core;
  };

  /** Whether this bot's Claude subagents are app-managed workers (the default) or native Agent calls (settings.json `claudeWorkers: "native"`). */
  private claudeWorkersOn(): boolean {
    return this.options.launch?.().claudeWorkers !== "native";
  }

  private ensureClaudeWorkers(): ClaudeWorkers {
    if (this.claudeWorkerHost) return this.claudeWorkerHost;
    this.claudeWorkerHost = new ClaudeWorkers({
      file: claudeWorkersFile(this.store.directory),
      core: this.workerCore,
      ownerSessionId: () => this.session.sessionId,
      base: () => {
        try {
          const base = this.options.headConfig(this.profile, this.sessionStart(false, this.prompts()));
          const tree = this.owner.options.worktree?.() ?? null;
          return tree ? { ...base, cwd: tree.cwd, addDirs: [...new Set([...(base.addDirs ?? []), ...tree.addDirs])] } : base;
        } catch (error) { this.log(`claude workers: no head config: ${(error as Error).message}`); return null; }
      },
      cwd: () => this.owner.options.worktree?.()?.cwd ?? this.commandFolder,
      subagentModel: () => this.owner.choices().subagentModel,
      subagentEffort: () => this.owner.choices().subagentEffort,
      defaultMachine: () => this.owner.choices().workerMachine,
      pluginDirs: () => this.options.plugins?.().dirs ?? [],
      processStarted: (pid) => this.options.ledger.record(pid),
      maxRunning: () => this.options.launch?.().claudeWorkerLimit ?? DEFAULT_CLAUDE_WORKER_LIMIT,
      specWriters: () => this.options.launch?.().specWriters ?? DEFAULT_SPEC_WRITERS,
      siteToolsFolder: () => this.options.siteToolsFolder,
      browser: (name, args, caller) => this.botTool(name, args, caller),
      remote: () => this.options.remoteWorkers?.() ?? null,
    }, (item) => this.onWorkerOutput(item), (id, text) => this.workerReport(text, id), (config, handlers) => new ClaudeHead(config, handlers));
    this.syncWorkerOwners();
    return this.claudeWorkerHost;
  }

  /**
   * A bot tool call from this bot's head or one of its workers (core/bot-tools.ts): the browser tools read the user's
   * pane beside this bot's chat (saved data goes to the bot's own `.bot/browser/`); the Note tools read this project's
   * Notes and change this bot's own (a worker only reads).
   */
  private async botTool(name: BotToolName, args: Record<string, unknown>, caller: ToolCaller = "coordinator"): Promise<unknown> {
    if (isNoteTool(name)) return runNoteTool(name, args, { botId: this.owner.profile.id, caller });
    if (name === COMPONENT_USAGE_TOOL) return this.componentUsage(args, caller);
    if (name === FETCH_TOOL) return this.fetchTool(args, caller);
    if (!isBrowserTool(name)) throw new Error(`Unknown app tool ${name}.`);
    return runBrowserTool(name, args, { botId: this.owner.profile.id, folder: this.owner.profile.folder });
  }

  /** app_fetch: files from another machine into this bot's `.bot/incoming/` (the server's `fetch` option does it; 2.x has none). */
  private async fetchTool(args: Record<string, unknown>, caller: ToolCaller): Promise<string> {
    if (caller !== "coordinator") throw new Error("Only the bot itself fetches from another machine.");
    const fetch = this.options.fetch;
    if (!fetch) return "Fetching from another machine needs Botling 3.";
    return fetch(this.owner.profile.id, parseFetchRequest(args));
  }

  /** app_component_usage: one component's whole usage (its about.md), for the coordinator that is about to use it. */
  private componentUsage(args: Record<string, unknown>, caller: ToolCaller): Record<string, unknown> {
    if (caller !== "coordinator") throw new Error("Only the bot itself reads component usage; a worker does not show components.");
    const library = this.context?.library;
    if (!library) throw new Error("The component library is not available here.");
    const wanted = typeof args.name === "string" ? args.name.trim() : "";
    const name = library.names.find((each) => each === wanted) ?? library.names.find((each) => each.toLowerCase() === wanted.toLowerCase());
    if (!name) throw new Error(`No component named "${wanted}". The library has: ${library.names.join(", ")}.`);
    const yours = this.ownComponents().includes(name) || BUILT_INS.includes(name);
    return {
      name, yours, command: library.command(name), usage: library.catalog([name]),
      ...(yours ? {} : { note: `Not on your list yet: ask Maintainer with <component name="${name}">add it to my list</component> before you show it.` }),
    };
  }

  /** A Claude worker's run ended: its report goes to this head as the app's message (waking it, or queued behind its turn). */
  private workerReport(text: string, workerId?: string): boolean {
    if (this.shuttingDown || this.problem || this.profile.problem) return false;
    try { this.relayIfCallInWork((this.options.primary ?? this).deliverTo(this.engine, text, null, { origin: "app" }), workerId, "report"); return true; }
    catch (error) { this.log(`claude worker report not delivered: ${(error as Error).message}`); return false; }
  }

  /** Workers started in a call-in turn, by worker id (`CallInWork`): kept in the owner's settings, so a restart keeps them. */
  private get callInWork(): CallInWorkBook {
    const bot = this.owner;
    bot.callInWorkBook ??= new CallInWorkBook({ load: () => bot.store.loadSettings().callInWork, save: (work) => bot.store.saveSetting("callInWork", work) });
    return bot.callInWorkBook;
  }
  private callInWorkBook: CallInWorkBook | null = null;

  /** A worker just started: in a call-in turn (a bot's @ or the user's), its news is to go back to that chat. */
  private linkCallInWork(workerId: string) {
    const turn = this.turn ?? this.owner.turn;
    if (!turn?.open || !turn.callIn || !turn.callInAsked) return;
    this.callInWork.link(workerId, turn.callIn, turn.callInAsked, turn.callInBy);
  }

  /** `turn` takes a worker's report or note: if that worker was started for a bot's @, its reply goes back there too. */
  private relayIfCallInWork(turn: Turn, workerId: string | null | undefined, news: CallInRelay["news"]) {
    const relay = this.callInWork.relay(workerId, news);
    if (relay && turn.open && turn.origin !== "tidy") turn.relayTo = relay;
  }

  /** `turn` ended (`record`: its line, null when it showed nothing): a worker's news it was on goes back to the asking bot. */
  private relayFollowUp(turn: Turn, status: Status, record: ChatRecord | null, error?: string) {
    const relay = turn.relayTo;
    if (!relay) return;
    const told = this.callInWork.followUp(relay, { status: status === "done" ? "done" : status === "stopped" ? "stopped" : "failed", visible: !!record, error: error ?? null });
    if (told?.kind === "reply" && record) this.owner.options.callInFollowUp?.(relay.caller, relay.asked, record, relay.by);
    else if (told?.kind === "noReply") this.owner.options.callInFollowUpMissed?.(relay.caller, relay.asked, told.why, relay.by);
  }

  /**
   * A note from one of this member's workers at work (app_notify_owner): a relay line in the chat (not the user's),
   * and this head woken with the <app_worker_note> message, or the note queued behind its turn. The run goes on.
   * Also the owner's side of a note from a worker another bot runs (the registry routes it here, `text` its words).
   */
  workerNote(note: Pick<WorkerNote, "kind" | "name" | "message" | "files"> & { id?: string }, text: string): boolean {
    const bot = this.options.primary ?? this;
    if (this.shuttingDown || this.problem || this.profile.problem || bot.shuttingDown) return false;
    try {
      bot.add({ id: newId(), role: "relay", text: workerNoteLine(note), date: toSwiftDate() });
      this.relayIfCallInWork(bot.deliverTo(this.engine, text, null, { origin: "app" }), note.id, "note");
      return true;
    } catch (error) { this.log(`worker note not delivered: ${(error as Error).message}`); return false; }
  }

  /**
   * The one entry for every app-managed worker's items, whatever engine runs it (shared-core spec S4b). Workers are
   * not the head's: their items come whether or not the head is awake (never dropped as an old head's), and only
   * their own bookkeeping happens here (the book, the step that started one, approvals, usage, speed),
   * never the coordinator's turn. Their state is the ledger's (`projectWorker`).
   */
  private onWorkerOutput(item: CodexItem) {
    if (this.shuttingDown && item.kind !== "subagentEnded" && item.kind !== "permissionCancelled") return;
    switch (item.kind) {
      // Each usage's own spend (the core's), never a running total.
      case "usage": if (item.totalCost > 0 || totalTokens(item.tokens) > 0) this.options.usage?.(this.owner.profile.name, item.totalCost, item.tokens); return;
      case "request": this.noteRequest(item.request); return;
      case "rateLimits": this.options.rateLimits?.(item.engine, item.limits); return;
      case "connectionLost": if (item.parent) this.cutOffByNetwork.add(item.parent); return;
      case "permissionDenied": this.showDenial(item); return;
      case "workerReport": this.workerReported(item); return;
      case "workerNote": this.workerNoted(item); return;
      case "managedPending": this.onItemPending(item.pending); return;
      case "permission":
        if (this.routeWorkerApproval(this.workerApprovals, item)) return;
        return this.ask(this.workerApprovals, item, null);
      case "permissionCancelled":
        for (const [id, approval] of this.approvals) if (approval.head === this.workerApprovals && approval.requestId === item.requestId) this.settle(id, NO_LONGER_NEEDED, false);
        this.options.agents?.approvalCancelled?.(this.hostFacts(), item.requestId);
        return;
    }
    this.noteProgressOf(item);
    if (item.kind === "toolUse") this.noteToolCall(item);
    const handled = this.onSubagentItem(item);
    // A run whose end reached the ledger before its opening items did (Codex hands them over after the call that ended
    // it, e.g. a start that failed at once): its end shows now, over the opening's "running".
    const opened = item.kind === "subagentStarted" ? this.workerViews.get(item.id) : undefined;
    if (opened && opened.status !== "running") this.projectWorker(opened);
    if (handled) return;
    // The step in the coordinator's turn that started it.
    const turn = this.turn;
    if (item.kind === "toolUse" && item.parent === null && turn?.open && turn.origin !== "tidy") {
      turn.steps.push({ id: item.id, kind: "subagent", tool: item.tool, title: item.title, detail: item.detail, failed: false, done: false });
      this.emitSteps(turn);
    }
  }

  /**
   * The turn a worker is handed off in, as its job: workers handed off in one turn are listed as one job unless their
   * bot named one (app_handoff's `group`). Titled by the user's words (else the turn's), first 20 characters.
   */
  private jobOfTurn(): { turnId: string; title: string } | undefined {
    const turn = this.turn ?? (this.options.primary as Bot | undefined)?.turn;
    if (!turn) return undefined;
    const said = turn.userId ? this.owner.records.find((record) => record.id === turn.userId)?.text : undefined;
    const words = (typeof said === "string" && said.trim() ? said : turn.words).replace(/\s+/g, " ").trim();
    return { turnId: turn.id, title: [...words].length > 20 ? `${[...words].slice(0, 20).join("")}…` : words };
  }

  /** Whether a Codex or Antigravity head keeps work it must stay awake for (its workers, a report turn to come). */
  private onItemPending(pending: boolean) {
    this.managedPending = pending;
    if (!pending && !this.turn && !this.queue.length) this.scheduleIdle();
    if (!pending) this.checkSettingsHold();
  }

  /**
   * One of its workers' ledger records changed (WorkerCore `projected`): its row (subagents.json), its chip, its
   * registry entry and the step that started it follow, through status.ts and nothing else. The end of a run is told
   * once, here (`subagentEnded`): the step is done, a silent turn reports it, its cards stop being at work.
   */
  private projectWorker(record: WorkerLedgerRecord, atStart = false) {
    this.workerViews.set(record.id, record);
    // A chip still in the turn under way (not yet in a reply) is the newest.
    const pending = this.turn?.tasks?.some((task) => task.id === record.id) ? { backgroundTasks: this.turn.tasks } as unknown as ChatRecord : null;
    const projected = projectWorker(this.subagents, pending ? [...this.records, pending] : this.records, record);
    if (projected.chip && projected.chip !== pending) this.changed(projected.chip);
    const row = projected.row;
    if (!row || atStart || (!projected.rowChanged && !this.options.agents)) return;
    if (projected.ended) this.subagentEnded(record.id);
    else if (projected.rowChanged) this.markWorkerStep(record.id, projected.stepFailed);
    // A row that did not change (every old worker, re-projected when its head starts) is told to the registry, but
    // the line that sent it is not drawn again: nothing on it changed.
    this.subagentChanged(row, false, projected.rowChanged || projected.ended);
  }

  /** The step that started a worker shows how its latest run ended (a report left unresolved later fails it too). */
  private markWorkerStep(id: string, failed: boolean) {
    const mark = (steps: StepRecord[] | undefined) => {
      const step = steps?.findLast((candidate) => candidate.id === id);
      if (!step || step.failed === failed) return !!step;
      step.failed = failed;
      return true;
    };
    if (mark(this.turn?.steps)) { if (this.turn) this.emitSteps(this.turn); return; }
    for (let i = this.records.length - 1; i >= Math.max(0, this.records.length - 80); i--) {
      if (mark(this.records[i]!.steps)) { this.persist(true); return; }
    }
  }

  /**
   * At start: what its ledger says of its workers, before any core is up (a Codex or Antigravity core comes with its
   * head). One it still lists at work was cut off when the app went away: it shows as interrupted.
   */
  private projectLedgerAtStart() {
    let records: WorkerLedgerRecord[];
    try { records = existsSync(this.workerLedgerFile) ? new WorkerLedger(this.workerLedgerFile).load() : []; }
    catch (error) { this.log(`worker ledger: ${(error as Error).message}`); return; }
    for (const record of records) {
      this.projectWorker(record.status === "running" ? { ...record, status: "interrupted", interruptedBy: "crash", report: { ...record.report, status: "interrupted", state: "none" } } : record, true);
    }
    if (records.length) { this.saveSubagents(); this.persist(true); }
  }

  /** This head's app-managed workers, whatever the engine (workers.ts): its Codex or Antigravity head, or its Claude workers. */
  get workerHost(): WorkerHost | null {
    if (this.engine === "claude") return this.claudeWorkerHost;
    const head = this.head as (AgentHead & { workerHost?: unknown }) | null;
    if (isWorkerHost(head?.workerHost)) return head.workerHost;
    return isWorkerHost(head) ? head : null;
  }

  /** The worker host holding this subagent of its own, when it is an app-managed worker (`load`: Claude's workers are read from their journal if they are not yet). */
  workerHostFor(nativeId: string, load = false): WorkerHost | null {
    const record = this.subagents.get(nativeId);
    if (!record || !isWorkerType(record.type)) return null;
    if (load && this.engine === "claude" && !this.claudeWorkerHost && this.claudeWorkersOn() && !this.shuttingDown) this.ensureClaudeWorkers();
    const host = this.workerHost;
    return host?.listWorkers().some((worker) => worker.id === record.id) ? host : null;
  }

  /** Its worker host told who owns each of its workers, as the registry has it (a move made while the host was not up). */
  private syncWorkerOwners() {
    const host = this.workerHost;
    const port = this.options.agents;
    if (!host || !port) return;
    const moved = port.movedOut(this.engine);
    for (const worker of host.listWorkers()) {
      const entry = moved.get(worker.id);
      const wanted: WorkerOwner | null = entry ? { botId: entry.owner.botId, name: entry.ownerName, agentId: entry.agentId } : null;
      if ((worker.owner?.botId ?? null) === (wanted?.botId ?? null)) continue;
      const set = host.setWorkerOwner(worker.id, wanted);
      if (!set.ok) this.log(`worker ${worker.id}: owner not set yet (${set.reason})`);
    }
  }

  /**
   * Gives one of its workers to another bot (or back: null), through its worker host. Null: it is no worker of a host that is up
   * now; its host is told when it starts (`syncWorkerOwners`).
   */
  setWorkerOwner(nativeId: string, owner: WorkerOwner | null): WorkerOwnerResult | null {
    for (const bot of this.members) {
      if (!bot.subagents.get(nativeId)) continue;
      return bot.workerHostFor(nativeId, true)?.setWorkerOwner(nativeId, owner) ?? null;
    }
    return null;
  }

  /**
   * The owner's follow-up or stop for one of the workers this bot hosts (any engine, through its WorkerHost). A follow-up to a
   * worker whose Codex or Antigravity head is asleep wakes that head first (the worker lives in it).
   */
  async commandWorker(nativeId: string, action: { kind: "message"; text: string } | { kind: "stop" }): Promise<WorkerSendResult | { ok: true; how: "stopped" }> {
    const holder = this.members.find((bot) => bot.subagents.get(nativeId));
    if (!holder) return { ok: false, reason: "No such agent here." };
    let host = holder.workerHostFor(nativeId, true);
    if (!host && action.kind === "message" && holder.engine !== "claude" && isWorkerType(holder.subagents.get(nativeId)?.type)) {
      try { holder.ensureHead(); }
      catch (error) { return { ok: false, reason: `Its host could not start: ${(error as Error).message}` }; }
      host = holder.workerHostFor(nativeId);
    }
    if (!host) return { ok: false, reason: action.kind === "stop" ? "It is not at work." : "It is not an app-managed worker this bot can reach now." };
    if (action.kind === "stop") return (await host.stopWorker(nativeId)) ? { ok: true, how: "stopped" } : { ok: false, reason: "It is not at work." };
    return await host.sendToWorker(nativeId, action.text);
  }

  /** A worker another bot owns ended a run: its report goes to the registry, which hands it to the owner. */
  private workerReported(item: Extract<CodexItem, { kind: "workerReport" }>) {
    const port = this.options.agents;
    if (port?.report) { port.report(this.hostFacts(), { nativeId: item.id, run: item.run, status: item.status, text: item.report }); return; }
    this.log(`worker ${item.id} reported for an owner, but there is no registry: its report stays in its row`);
  }

  /** A worker another bot owns sent a note: the registry hands it to the owner. */
  private workerNoted(item: Extract<CodexItem, { kind: "workerNote" }>) {
    const port = this.options.agents;
    if (port?.note) { port.note(this.hostFacts(), { nativeId: item.id, run: item.run, kind: item.noteKind, name: item.name, message: item.message, files: item.files }); return; }
    this.log(`worker ${item.id} sent a note for an owner, but there is no registry: it was dropped`);
  }

  /** A worker another bot owns asks for an approval: the owner's chat shows the card (the host's own standing rules still answer what they cover). */
  private routeWorkerApproval(head: ApprovalAnswerer, item: Extract<StreamItem, { kind: "permission" }>): boolean { return this.questions.routeWorkerApproval(head, item); }
  /** The owner's side: a card for a worker it owns that another bot runs; the pick goes back to that bot's `head`. */
  askForWorker(head: ApprovalAnswerer, item: WorkerApproval): void { return this.questions.askForWorker(head, item); }
  /** A worker's approval was withdrawn: its card here (if any) is no longer needed. */
  settleWorkerApproval(requestId: string): void { return this.questions.settleWorkerApproval(requestId); }


  subagentRows(): SubagentRowView[] { return this.subagentRowBook.subagentRows(); }
  rowsChanged(force = false) { return this.subagentRowBook.rowsChanged(force); }
  workerRowsChanged() { return this.subagentRowBook.workerRowsChanged(); }
  openQuestions(): { id: string; text: string; sourceID?: string }[] { return this.subagentRowBook.openQuestions(); }
  results(): ResultView[] { return this.subagentRowBook.results(); }
  linkedFiles(): LinkedFile[] { return this.subagentRowBook.linkedFiles(); }
  queueNote(note: string) { return this.subagentRowBook.queueNote(note); }

  // Its own components, moved to BotCards (M7-S43).
  get components(): string[] | null { return this.cards.components; }
  setComponentList(names: string[]) { this.cards.setComponentList(names); }
  get ownComponentNames(): string[] { return this.cards.ownComponentNames; }

  get lastAsked(): string { return this.views.lastAsked; }
  get subagentsAtWork(): boolean { return this.views.subagentsAtWork; }
  private afterReplyHooks(record: ChatRecord) { this.views.afterReplyHooks(record); }

  addRoutine(cron: string, task: string): boolean { return this.routines.addRoutine(cron, task); }

  get awake(): boolean { return this.views.awake; }

  /** Its tool approvals waiting for you: the tool, what it would run, when it asked (oldest first). */
  pendingApprovals(): { tool: string; text: string; at: string | null }[] { return this.questions.pendingApprovals(); }

  private get dirtySubagents(): Set<string> { return this.subagentRowBook.dirtySubagents; }
  saveSubagents(progress = false, changed?: SubagentRecord) { return this.subagentRowBook.saveSubagents(progress, changed); }
  private scheduleSubagentSave(delay: number) { return this.subagentRowBook.scheduleSubagentSave(delay); }
  private flushSubagents(progress = false) { return this.subagentRowBook.flushSubagents(progress); }

  // ------------------------------------------------------------------------------------------
  // Views

  get phase(): BotView["phase"] { return this.views.phase; }

  get working(): boolean { return this.views.working; }

  view(): BotView { return this.views.view(); }

  private tokenSpeed(): BotView["tokenSpeed"] { return this.views.tokenSpeed(); }

  private noteRequest(event: RequestEvent) { this.views.noteRequest(event); }

  /** Running sums of this head's own finished requests this session (never persisted; subagents keep theirs in their records). */
  get mainSpeed(): SpeedTotals | undefined { return this.views.mainSpeed; }
  get mainSpeedAt(): number { return this.views.mainSpeedAt; }

  refresh() { this.views.refresh(); }

  headsView(): HeadsView | null { return this.views.headsView(); }

  claudeWorkerLimitChanged(): void { this.views.claudeWorkerLimitChanged(); }

  appPrimaryChanged(): void { this.views.appPrimaryChanged(); }

  headsChanged(): void { this.views.headsChanged(); }

  updated() { this.views.updated(); }

  get shownTurn(): Turn | null { return this.views.shownTurn; }

  snapshot(): ChatSnapshot { return this.views.snapshot(); }

  private chatRoutines(): RoutineView[] { return this.views.chatRoutines(); }

  history(before: string, bytes?: number, until?: string): ResultOf<"chat.history"> { return this.views.history(before, bytes, until); }

  get messageCount() { return this.recordsBook.messageCount; }

  pluginChat(limit: number) { return this.views.pluginChat(limit); }

  readMark(): { unread: number; through: string | null } { return this.recordsBook.readMark(); }

  taskOutput(messageId: string, taskId: string): Promise<ResultOf<"task.output">> { return this.views.taskOutput(messageId, taskId); }
  subagentView(id: string, who?: { owner: string; host: string | null }): ResultOf<"subagent.view"> { return this.views.subagentView(id, who); }
  hasMoveNotice(key: string): boolean { return this.views.hasMoveNotice(key); }
  subagentHistory(subagent: SubagentRecord): SubagentHistory { return this.views.subagentHistory(subagent); }
  private get speaker(): string { return this.views.speaker; }

  // ------------------------------------------------------------------------------------------
  // Sending, and the turn

  refuseIfClosed(): void { return this.questions.refuseIfClosed(); }

  send(text: string, opts: { replyTo?: string; to?: AnswerTarget; appNote?: string; decisionOwner?: Engine; files?: string[]; originals?: string[]; via?: string; onDelivery?: (delivered: boolean) => void; ids?: PresetTurnIds } = {}): ResultOf<"chat.send"> { return this.group.send(text, opts); }

  private userRecord(id: string, words: string, date: number, opts: { replyTo?: string; to?: AnswerTarget; via?: string }) { return this.group.userRecord(id, words, date, opts); }

  private updateUserLine(line: ChatRecord, made: ChatRecord) { return this.group.updateUserLine(line, made); }

  presetUserLine(line: { id: string; text: string; date: number; replyTo?: string; to?: AnswerTarget }): boolean { return this.group.presetUserLine(line); }

  deliverTo(head: Engine, words: string, userId: string | null, extra?: Partial<Pick<Turn, "conducted" | "handoffId" | "about" | "origin" | "delivery" | "routine" | "released">> & { ids?: PresetTurnIds }): Turn { return this.group.deliverTo(head, words, userId, extra); }

  watchDelivery(turn: Turn, delivery?: (delivered: boolean) => void): Turn { return this.group.watchDelivery(turn, delivery); }

  private delivered(turn: Turn) { return this.group.delivered(turn); }

  startPresetTurn(spec: { ids: PresetTurnIds; words: string; userId: string | null; origin: "user" | "app"; engine?: Engine; routine?: boolean }): { turnId: string; done: Promise<Status> } { return this.group.startPresetTurn(spec); }

  newTurn(origin: Origin, words: string, userId: string | null, ids?: PresetTurnIds): Turn { return this.group.newTurn(origin, words, userId, ids); }

  // ------------------------------------------------------------------------------------------
  // Two heads: who reads a message to both first

  private claimLead(heads: Engine[]): Engine | null { return this.group.claimLead(heads); }

  private holdForClaim(words: string, userId: string, held: Engine, lead: Engine): Turn { return this.group.holdForClaim(words, userId, held, lead); }

  releaseClaim(words?: string, about?: string[]) { return this.group.releaseClaim(words, about); }

  private headStopped(head: Engine) { return this.group.headStopped(head); }

  private tell(head: Engine, note: string, about: string[]) { return this.group.tell(head, note, about); }

  hearNow(note: string, about: string[]): boolean { return this.group.hearNow(note, about); }

  private headWords(words: string) { return this.group.headWords(words); }

  private headReplied(record: ChatRecord, head: Engine, handoff: Handoff | null, handed: boolean, handoffId: string | null) { return this.group.headReplied(record, head, handoff, handed, handoffId); }

  conduct(actions: ConductorAction[]): void { return this.group.conduct(actions); }

  stopRounds(): ResultOf<"rounds.stop"> { return this.group.stopRounds(); }

  stopHandoff(id: string): ResultOf<"handoff.stop"> { return this.group.stopHandoff(id); }

  setAnswerWith(to: AnswerTarget): ResultOf<"heads.answerWith"> { return this.group.setAnswerWith(to); }

  appPrimary(): Engine | null { return this.group.appPrimary(); }

  setHeads(engines: Engine[]): Promise<ResultOf<"heads.set">> { return this.settings.setHeads(engines); }
  choices() { return this.settings.choices(); }
  applyEngineChoices(choices: { engines: Engine[]; model: string | null; efforts: EngineEfforts; codexModel: string | null; agyModel: string | null }) { return this.settings.applyEngineChoices(choices); }
  applyEngineDefaults(change: { subagentModel?: string | null; subagentEffort?: string | null; codexWorkers?: Record<string, unknown> | undefined; agyWorkerModel?: string | null; agyWorkerEffort?: string | null }) { return this.settings.applyEngineDefaults(change); }
  settingsView(): BotSettingsView { return this.settings.settingsView(); }
  configure(change: { workerMachine?: string | null; agyModel?: string | null; agyWorkerModel?: string | null; agyWorkerEffort?: string | null; codexWorkers?: { model: string | null; effort: string | null; fast: boolean | null } | null; model?: string | null; effort?: string | null; subagentModel?: string | null; subagentEffort?: string | null; codexModel?: string | null; primary?: Engine | null; efforts?: Partial<Record<Engine, string | null>> }): BotSettingsView { return this.settings.configure(change); }
  saveHeads(engine?: Engine) { return this.settings.saveHeads(engine); }
  private switchEngine(to: Engine) { return this.settings.switchEngine(to); }
  private becomeEngine(to: Engine) { return this.settings.becomeEngine(to); }
  private get switchReady(): boolean { return this.settings.switchReady; }
  private handOver(): Promise<void> { return this.settings.handOver(); }

  withSavedMemory(prompt: string): string { return this.decisions.withSavedMemory(prompt); }

  showAppReply(raw: string) { this.decisions.showAppReply(raw); }

  private handleRequests(requests: BotRequest[]): BotRequest[] { return this.decisions.handleRequests(requests); }

  markSeen(ids: string[], head: Engine) { return this.recordsBook.markSeen(ids, head); }
  bumpUnread() { return this.recordsBook.bumpUnread(); }

  // ------------------------------------------------------------------------------------------
  // Shared decisions (a question handed over between the heads)

  identifyDecision(id: string) { this.decisions.identifyDecision(id); }

  decisionContext(ids: Set<string>): string { return this.decisions.decisionContext(ids); }

  private associateDecision(record: ChatRecord, reference: string | null, turn: Turn) { this.decisions.associateDecision(record, reference, turn); }

  resolveDecision(messageId: string, index: number | null, text: string | undefined): boolean | null { return this.decisions.resolveDecision(messageId, index, text); }

  waitsFor(id: string): boolean { return this.decisions.waitsFor(id); }

  private redrawQueued(turn: Turn) { this.decisions.redrawQueued(turn); }

  /** Where a new turn goes: now, joined with the one under way, or after it. The turn that carries it. */
  route(turn: Turn): Turn {
    if (this.options.deferTurn && !turn.released) {
      turn.released = true;
      const kept = this.options.deferTurn({
        botId: this.id, turnId: turn.id, messageId: turn.messageId, userId: turn.userId, origin: turn.origin, words: turn.words,
        engine: this.engine, routine: turn.routine === true, done: turn.done,
        release: () => ({ turnId: this.route(turn).id, done: turn.done }),
      });
      if (kept) return turn;
    }
    const routed = this.routeTurn(turn);
    if (routed === turn && this.queue.includes(turn)) this.redrawQueued(turn);
    return routed;
  }

  private routeTurn(turn: Turn): Turn {
    this.requireEngineRoute(this.engine, this.owner.engine);
    const current = this.turn;
    // The core is being swapped (hot-swap.ts): nothing new begins; it waits and is handed over.
    if (this.swapHold) { this.queue.push(turn); return turn; }
    // A switch of engine waits for this message: the handoff first, then the message (`restartsBeforeMessage`).
    if (!current && this.switchReady) { this.queue.push(turn); void this.handOver(); return turn; }
    // A message already waits for this head's work before a model/effort restart: this one goes after it.
    if (this.settingsHold) { this.queue.push(turn); this.checkSettingsHold(); return turn; }
    if (!current && !this.tidying && !this.switching && this.waitsForRestart(turn) && this.head?.running && this.ownWorkRunning
      && (this.folderPending || (this.modelSettingsPending && !this.canSwitchInPlace(this.head)))) {
      this.holdForSettings(turn);
      return turn;
    }
    if (!current && !this.tidying && !this.switching) { this.begin(turn); return turn; }
    // A saved model/effort, or a new working folder, belongs to a new turn, never to steering the old process.
    // While it tidies before sleep nothing joins a turn of claude's own (a report): its process is about to end.
    if (current && (this.modelSettingsPending || this.folderPending || this.tidying)) { this.queue.push(turn); return turn; }
    if (current && this.canPause(current, turn)) return this.pause(current, turn);
    if (current && this.canSteer(current, turn) && this.steerInto(current, turn)) return current;
    if (current && this.offerInsert(current, turn)) {
      this.queue.push(turn);
      this.log("you wrote while Antigravity worked: your message goes into its turn with its next tool result (queued until then)");
      return turn;
    }
    this.queue.push(turn);
    this.log("a message waits for the turn under way");
    return turn;
  }

  /**
   * `Bot.pausing`: you wrote while it works on something you did not start (handed-over work, a
   * routine, a report, claude's own turn). Unless stopping it would lose work (an approval is open, a
   * subagent runs in the foreground), that work waits until you are answered. Codex pauses only
   * handed-over work (its other turns take your message in with `turn/steer`, as 1.x).
   */
  private canPause(current: Turn, next: Turn): boolean {
    if (next.origin !== "user" || current.origin === "user" || current.origin === "tidy" || this.paused) return false;
    if (!current.open || !current.sent || !current.head?.running || current.head !== this.head || this.queue.length || this.draining || this.ignoreResults) return false;
    if (this.approvals.size || this.subagents.running.some((subagent) => !subagent.background)) return false;
    return this.engine === "claude" || (current.conducted && this.head instanceof CodexHead);
  }

  /** Pauses `current` for your message `next` (1.x's `route` with `pausing`): see the header. */
  private pause(current: Turn, next: Turn): Turn {
    const paused = { conducted: current.conducted, handoffId: current.handoffId };
    next.words = `${PAUSE_NOTE}\n\n${next.words}`;
    // Your message joins the turn, which is yours from now on; the work it was on waits.
    current.conducted = false;
    current.handoffId = null;
    if (!this.steerInto(current, next)) {
      current.conducted = paused.conducted;
      current.handoffId = paused.handoffId;
      next.words = next.words.slice(PAUSE_NOTE.length + 2);
      this.queue.push(next);
      return next;
    }
    this.paused = paused;
    this.log("you wrote while it worked on something you did not start: that work is paused for your message");
    return current;
  }

  /** `Bot.resumePausedWork`: the user has been answered; the paused work goes on, on its own hand-off. */
  private resumePaused(): boolean {
    const paused = this.paused;
    if (!paused) return false;
    this.paused = null;
    if (!this.head?.running) return false;
    // A hand-off stopped (or settled) meanwhile has nothing left to carry on.
    if (paused.handoffId && !this.owner.conductor.records.some((record) => record.id === paused.handoffId && isActive(record))) return false;
    const turn = this.newTurn("app", RESUME_NOTE, null);
    turn.conducted = paused.conducted;
    turn.handoffId = paused.handoffId;
    this.log("carrying on with the work paused for your message");
    this.begin(turn);
    return true;
  }

  /**
   * 1.x's steering: a message from you while a head works joins the turn under way (Codex: `turn/steer`;
   * claude: on its stdin), unless that turn is handed-over work (paused for you: `canPause`) or the tidy.
   * claude takes it in the user's own turn whatever is open; in work the user did not start only with no approval open and no foreground subagent at work (else it waits).
   */
  private canSteer(current: Turn, next: Turn): boolean {
    if (next.origin !== "user" || current.origin === "tidy" || current.conducted || !current.open || !current.sent) return false;
    if (current.head !== this.head || !this.head?.running || this.draining || this.ignoreResults || this.ending.has(this.head)) return false;
    if (this.head instanceof AgyAcpHead) return false;
    if (this.head instanceof CodexHead) return true;
    // claude reads a line on its stdin at its next step, so an open approval (answered by its card, never by words) or a
    // foreground subagent does not stop the user's own turn from taking it. Work the user did not start keeps those
    // gates: there `canPause` refused for them, and joining it unpaused would turn it into the user's turn.
    if (this.queue.length) return false;
    return current.origin === "user" || (!this.approvals.size && !this.subagents.running.some((subagent) => !subagent.background));
  }

  /**
   * An Antigravity head cannot take words into a running prompt (ACP has no steer), but every tool it calls is the
   * app's: your line `next` is offered to the turn under way and rides on its next tool result (`AgyAcpHead.offerInsert`).
   * It stays in the queue, "Queued", until the head says it was read (`insertDelivered`); a turn that ends without
   * another tool call drops the offer and the queue sends it as the next turn. The same gates as claude's steering.
   */
  private offerInsert(current: Turn, next: Turn): boolean {
    const head = this.head;
    if (!(head instanceof AgyAcpHead) || typeof head.offerInsert !== "function") return false;
    if (next.origin !== "user" || current.origin === "tidy" || current.conducted || !current.open || !current.sent) return false;
    if (current.head !== head || !head.running || this.draining || this.ignoreResults || this.ending.has(head)) return false;
    // Behind a message that waits for the next turn it would jump the order.
    const offered = new Set(this.inserting.values());
    if (this.queue.some((turn) => !offered.has(turn))) return false;
    if (current.origin !== "user" && this.approvals.size) return false;
    if (this.turnImages(next).length) return false;
    const id = (next.userId ?? next.messageId).toLowerCase();
    if (!head.offerInsert(id, next.words)) return false;
    this.inserting.set(id, next);
    return true;
  }

  /** Antigravity read your line with a tool result of its turn: it joins that turn, as a steered line does. */
  private insertDelivered(head: AgentHead, id: string) {
    const next = this.inserting.get(id);
    if (!next) return;
    this.inserting.delete(id);
    const current = this.turn;
    const at = this.queue.indexOf(next);
    if (at < 0 || !next.open || next.sent || !current?.open || current.head !== head) return;
    this.queue.splice(at, 1);
    next.head = head;
    next.sent = true;
    this.joinTurn(current, next);
    this.delivered(next);
    this.redrawQueued(next);
    this.log("Antigravity read your message with a tool result: it joined its turn");
  }

  /** A line offered into an Antigravity turn leaves the queue another way (taken back, sent as a turn): the offer goes. */
  private withdrawInsert(turn: Turn) {
    const id = (turn.userId ?? turn.messageId).toLowerCase();
    if (this.inserting.get(id) !== turn) return;
    this.inserting.delete(id);
    const head = this.head;
    if (head instanceof AgyAcpHead && typeof head.withdrawInsert === "function") head.withdrawInsert(id);
  }

  /** Steers `next` into `current`: the reply now answers your latest words, and shows after them. */
  private steerInto(current: Turn, next: Turn): boolean {
    const head = this.head;
    if (!head) return false;
    if (head instanceof CodexHead) {
      if (!head.steer(this.compose(next, false))) return false;
    } else {
      // claude reads it into the turn under way at once (priority "now"; a foreground subagent at work goes to the
      // background first, so it is not stopped); if that turn ends first, it begins a turn of its own for it (`steeredStarted`).
      const id = next.userId ?? next.messageId;
      next.head = head;
      next.sent = true;
      this.steered.set(id.toLowerCase(), next);
      head.send(this.compose(next, false), id, this.turnImages(next), { now: true });
      current.steeredNow = true;
    }
    this.joinTurn(current, next);
    this.delivered(next);
    this.log(head instanceof CodexHead ? "you wrote while Codex worked: your message joined its turn (turn/steer)" : "you wrote while claude worked: your message went into its turn");
    return true;
  }

  /** `next`, already read into `current`: their cards join, the turn is yours, and the reply so far moves below your line. */
  private joinTurn(current: Turn, next: Turn) {
    current.origin = "user";
    current.userId = next.userId;
    current.words = next.words;
    current.about.push(...next.about);
    for (const id of next.peer) current.peer.add(id);
    this.markSeen([...next.about, ...(next.userId ? [next.userId] : [])], this.engine);
    // The reply so far moves below your new line, where its end will be.
    const record = current.record;
    if (record) {
      const at = this.records.indexOf(record);
      if (at >= 0) {
        this.records.splice(at, 1);
        this.emit({ type: "message.removed", botId: this.id, messageId: record.id });
        this.records.push(record);
        this.persist();
        this.emit({ type: "message.added", botId: this.id, message: this.messageView(record) });
      }
    }
    void current.done.then(next.resolve);
  }

  /**
   * claude begins a turn of its own for a line of yours it was sent mid-turn (the turn under way ended
   * before it read it in): that turn answers you. Our turn sent after it and not begun waits for it.
   */
  private steeredStarted(head: AgentHead, next: Turn) {
    if (head !== this.head || this.ignoreResults || this.draining || this.ending.has(head)) return;
    const waiting = this.turn;
    // Read into the turn under way after all.
    if (waiting && (!waiting.open || waiting.head !== head || waiting.reply.text || waiting.steps.length || waiting.record || this.deferred)) return;
    if (waiting) { this.turn = null; this.deferred = waiting; }
    const turn = this.newTurn("user", next.words, next.userId);
    turn.head = head;
    turn.sent = true;
    turn.about = [...next.about];
    this.turn = turn;
    this.clearIdle();
    this.emit({ type: "turn.started", botId: this.id, turnId: turn.id, messageId: turn.messageId, head: this.engine });
    this.updated();
    this.log("claude read your line after its turn ended: it answers it in a turn of its own");
  }

  /**
   * claude is done with a message the app sent it (`command_lifecycle`'s end). A message it took into the turn under way
   * ("absorbed_mid_turn") gets no "started" and no result of its own: only this, before that turn's result. A turn of ours
   * set aside for it (deferred) would otherwise wait for a turn that never comes, and everything after it with it.
   * A turn under way that it ends is left to the result that follows (that result is its answer).
   */
  private commandEnded(head: AgentHead, id: string, state: CommandState) {
    // Words steered into a turn, or the other head's words: read in there, nothing more comes for them.
    this.steered.delete(id);
    this.contextSent.delete(id);
    // The turn set aside and back as the turn under way, not begun: its end after the result means claude took its words
    // into the turn that just ended (2026-11-09: it waited for a turn that never came, hours of "Thinking").
    const unbegun = this.unbegun;
    if (unbegun && unbegun.head === head && this.turn === unbegun.turn && turnCommandId(unbegun.turn) === id) {
      this.clearUnbegun();
      this.finishTurn(unbegun.turn, state === "completed" ? "done" : "stopped");
      this.log(`claude was done with a message set aside for its own turn (${state}) without beginning it: that turn ended`);
      return;
    }
    const deferred = this.deferred;
    if (!deferred || deferred.head !== head || turnCommandId(deferred) !== id) return;
    this.deferred = null;
    // Stopped by you meanwhile: closed already, and claude has nothing of it left to interrupt.
    if (!deferred.open) return;
    const status: Status = state === "completed" ? "done" : "stopped";
    deferred.open = false;
    this.emit({ type: "turn.finished", botId: this.id, turnId: deferred.id, messageId: deferred.messageId, status, text: "" });
    this.finished.set(deferred.id, status);
    deferred.resolve(status);
    this.log(state === "completed" ? "claude took a message into the turn under way: it gets no turn of its own" : `claude dropped a message it had taken into a turn (${state})`);
    this.updated();
  }

  /** Makes `turn` the one under way and sends it (waking the bot if it sleeps). */
  begin(turn: Turn, head?: AgentHead) {
    this.turn = turn;
    this.delivered(turn);
    this.redrawQueued(turn);
    this.clearIdle();
    if (turn.origin !== "tidy") {
      this.emit({ type: "turn.started", botId: this.id, turnId: turn.id, messageId: turn.messageId, head: this.engine });
      this.updated();
    } else if (turn.callIn) this.updated();
    // Handing the turn to the agent starts its process (ps for the process ledger, locks, fsyncs, the
    // recent-chat briefing): synchronous work that took seconds on a busy machine. A message you send is
    // accepted once its line is saved, so chat.send must answer first; deliver re-checks the turn.
    if (turn.origin === "user") setImmediate(() => { void this.deliver(turn, head); });
    else void this.deliver(turn, head);
  }

  /**
   * Its process starts again, in the same session, before its next message (1.x's `restart(_:)` for
   * "may read <folder>": a folder you allowed is one more `--add-dir`). Asleep, the next wake has it anyway.
   */
  restartBeforeNextMessage(reason: { told: string; shown: string } | null = null) {
    if (this.options.primary) { this.options.primary.restartBeforeNextMessage(reason); return; }
    this.restartFor(reason);
  }

  /** Its session's folder moved (a plugin's `sessions.folder`): it starts again there before your next message, never answering it from the old one. */
  folderMoved(reason: { told: string; shown: string }) {
    if (this.options.primary) { this.options.primary.folderMoved(reason); return; }
    this.restartFor(reason, false, true);
  }

  /** This head starts again in the same session before its next message, for `reason` (`restart(_:)`). Asleep: the next wake has it. */
  restartFor(reason: { told: string; shown: string } | null, modelSettings = false, folder = false) {
    this.restartForPluginsOnly = false;
    if (!this.head?.running) { this.restartPending = false; this.restartNonModel = false; this.folderPending = false; return; }
    this.restartPending = true;
    this.folderPending ||= folder;
    this.modelSettingsPending ||= modelSettings;
    if (modelSettings) this.settingsGeneration += 1;
    else this.restartNonModel = true;
    if (reason) this.restartReason = reason;
  }

  /**
   * "Restart bot": every head of this conversation starts again before its next message (the way a model
   * change does, so a running turn, subagents or workers are never cut off). A claude head starts a NEW
   * session with the wake briefing (memory.md and the recent chat): claude keeps a session's first system
   * prompt on --resume, so only a new session has the app's current instructions. Asleep, nothing runs now;
   * the next wake starts the new session.
   */
  restartNow(): { restart: "next-message" | "asleep" } {
    const owner = this.owner;
    if (owner.readOnly) throw new ContractError("conflict", owner.problem ?? "Read-only.");
    let awake = false;
    for (const bot of owner.members) {
      if (bot.engine === "claude") bot.freshSessionPending = true;
      bot.restartFor({ told: "restarted at your user's request", shown: "manual restart" });
      awake ||= bot.restartPending;
    }
    return { restart: awake ? "next-message" : "asleep" };
  }

  /** "Restart bot" on a claude head: its next start is a new session, whatever its prompt hash says. */
  private freshSessionPending = false;
  /** ensureHead began a new session for the message being sent (its briefing says it all; no restart note). */
  startedFresh = false;

  /** A session handed over by the old core is resumed as it is once (a cut-off turn goes on exactly where it stopped). */
  private adoptedSession = false;
  /** The prompt hash head.json kept for this session (the old core wrote it): none for an older file or another session. */
  private savedPromptHash(sessionId: string): { promptHash?: string } {
    const saved = this.store.loadHead();
    return saved?.sessionId === sessionId && saved.promptHash ? { promptHash: saved.promptHash } : {};
  }

  /** A hash of the system prompt this head's session would be created with now (engine differences included). */
  private promptHash(): string {
    return createHash("sha256").update(this.prompts().system).digest("hex").slice(0, 16);
  }

  /** Its process has the plugins' Claude parts as they are now. */
  hasCurrentPlugins(): boolean {
    const stamp = this.options.pluginStamp?.();
    return !!stamp && JSON.stringify(stamp) === JSON.stringify(this.loadedPluginStamp);
  }

  /**
   * Plugins' Claude parts changed (1.x's `reloadPlugins`). Asleep: the next wake loads them. Awake: it
   * restarts just before its next message, so the new skills and agents are there. Many changes make one
   * restart, and changes that come back to what its session has make none. Its other head restarts too.
   */
  reloadPlugins() {
    if (this.options.primary) return;
    if (this.hasCurrentPlugins()) {
      if (this.restartForPluginsOnly) { this.restartPending = false; this.restartNonModel = false; this.restartReason = null; this.restartForPluginsOnly = false; }
      return;
    }
    const waiting = this.restartPending;
    for (const peer of this.peers) peer.restartFor(PLUGINS_RESTART);
    this.restartFor(PLUGINS_RESTART);
    if (!waiting && this.restartPending) this.restartForPluginsOnly = true;
  }

  private async deliver(turn: Turn, given?: AgentHead) { return this.delivery.deliver(turn, given); }
  private turnImages(turn: Turn): string[] { return this.delivery.turnImages(turn); }
  get lineMediaStore(): string { return this.delivery.lineMediaStore; }
  attachmentPath(url: string, line?: string): string | null { return this.delivery.attachmentPath(url, line); }
  private namedAttachmentPath(url: string): string | null { return this.delivery.namedAttachmentPath(url); }
  private compose(turn: Turn, brief: boolean): string { return this.delivery.compose(turn, brief); }
  private wakeLine(turn: Turn, recent: (leavingOut: string | null) => string): string { return this.delivery.wakeLine(turn, recent); }
  wakeNote(): string { return this.delivery.wakeNote(); }
  prompts(): BotPrompts { return this.delivery.prompts(); }

  ensureHead(): AgentHead {
    this.requireEngineRoute(this.engine, this.owner.engine);
    if (this.head?.running) return this.head;
    // It fell asleep before its switch of engine was done: it wakes on the new one.
    if (this.switchTo) { const to = this.switchTo; this.switchTo = null; this.becomeEngine(to); }
    this.requireEngineRoute(this.engine, this.owner.engine);
    this.restartPending = false;
    this.restartNonModel = false;
    this.modelSettingsPending = false;
    this.folderPending = false;
    this.restartForPluginsOnly = false;
    this.loadedPluginStamp = this.options.pluginStamp?.() ?? null;
    const prompts = this.prompts();
    // claude keeps the system prompt a session was created with (--resume ignores a new one): when the app's
    // has changed since (or "Restart bot" asks, or head.json has no hash yet), this is a new session, and its
    // first message carries the wake briefing. Codex refreshes its instructions on resume, and agy is given
    // them again on session/load, so only claude is told apart.
    const adopted = this.adoptedSession;
    this.adoptedSession = false;
    if (this.engine === "claude" && this.session.started && !this.briefing && (this.freshSessionPending || (!adopted && this.session.promptHash !== this.promptHash()))) {
      this.newSession();
      this.startedFresh = true;
      this.owner.add({ id: newId(), role: "divider", text: PROMPT_SESSION_DIVIDER, date: toSwiftDate() });
    }
    this.freshSessionPending = false;
    const resume = this.session.started && !this.briefing;
    if (!resume) this.session.promptHash = this.promptHash();
    const launch = this.options.launch?.() ?? { subagentHourCache: false };
    const start = this.sessionStart(resume, prompts);
    // An app-made worktree: the session starts there; the project's .bot (memory, inbox) stays reachable.
    const tree = this.owner.options.worktree?.() ?? null;
    let head: AgentHead;
    if (this.engine === "agy") {
      if (!this.options.agyConfig) throw new Error("Antigravity is not available here.");
      const config = this.options.agyConfig(this.profile, { command: "agy", cwd: tree?.cwd ?? this.profile.folder, ...(tree ? { addDirs: tree.addDirs } : {}), sessionId: start.sessionId, resume: start.resume,
        bypassPermissions: launch.agyBypassPermissions === true, ...(launch.specWriters ? { specWriters: launch.specWriters } : {}), model: this.settingsView().agyModel, effort: start.effort, workerChoice: () => { const choices = this.owner.choices(); return { model: choices.agyWorkerModel, effort: choices.agyWorkerEffort }; }, systemPrompt: prompts.system, workerInstructions: prompts.codexWorkerSystem, skillRoots: start.skillRoots ?? [], processStarted: pid => this.options.ledger.record(pid), browser: (name, args, caller) => this.botTool(name, args, caller), routines: (args) => this.routinesTool(args), canStartReport: () => !this.turn && (!this.queue.length || !!this.settingsHold) && !this.draining && !this.shuttingDown, });
      if (config.transport !== "acp") throw new ContractError("conflict", AGY_EXECUTION_BLOCKED);
      head = new AgyAcpHead(config, { onItem: item => this.onItem(head, item), onExit: exit => this.onExit(head, exit) }, undefined,
        { core: this.workerCore, sink: (item) => this.onWorkerOutput(item) });
    } else if (this.engine === "codex") {
      if (!this.options.codexConfig) throw new Error("Codex is not available here.");
      const base = this.options.codexConfig(this.profile, { ...start, workerInstructions: prompts.codexWorkerSystem, codexModel: this.heads.codexModel, routinesFile: this.routineStorePath });
      const config = tree ? { ...base, cwd: tree.cwd, writableRoots: [...new Set([...(base.writableRoots ?? []), ...tree.addDirs])] } : base;
      if (this.restartRecovery && config.resume) {
        const thread = config.threads.thread(config.sessionId);
        if (!thread || (config.workerInstructions && !config.threads.isManaged(config.sessionId, thread))) throw new Error("Mixed Codex conversation mapping unavailable; identity retained, no replacement or replay.");
      }
      const restartWorkers=this.restartWorkerRecords;
      const restartTurn=this.restartProviderTurn;
      const restartRecovery=this.restartWorkersSince;
      this.restartProviderTurn=undefined;
      this.restartWorkerRecords=undefined;
      this.restartWorkersSince=undefined;
      head = new CodexHead({...config, browser: (name, args, caller) => this.botTool(name, args, caller), restartWorkers, restartRecovery, restartTurn, strictResume:this.restartRecovery && config.resume,
        workerCore: this.workerCore, workerSink: (item) => this.onWorkerOutput(item)}, { onItem: item => {
        this.onItem(head, item);
      }, onExit: exit => this.onExit(head, exit) });
    } else {
      const base = this.options.headConfig(this.profile, start);
      const config = tree ? { ...base, cwd: tree.cwd, addDirs: [...new Set([...(base.addDirs ?? []), ...tree.addDirs])] } : base;
      // Claude's subagents are app-managed workers (claude-workers.ts): the app's tools come in over the control channel
      // and the native Agent/Task tool is gone. The hidden settings.json `claudeWorkers: "native"` keeps the native one.
      const workers = !config.harmless && this.claudeWorkersOn() ? this.ensureClaudeWorkers() : null;
      const siteTools = this.options.siteToolsFolder ? { siteToolsGuard: { folder: this.options.siteToolsFolder } } : {};
      // app_routines comes on the same server, also for the native fallback (which gets only that tool).
      const appMcp = config.harmless ? null : { server: CLAUDE_APP_SERVER, tools: workers ? CLAUDE_APP_TOOLS : CLAUDE_ROUTINE_TOOLS };
      head = new ClaudeHead({ ...config, ...siteTools, monitorWorker: false, ...(appMcp ? { appMcp } : {}), ...(workers ? { agentGuard: CLAUDE_AGENT_GUARD } : {}) }, {
        onItem: (item) => this.onItem(head, item), onExit: (exit) => this.onExit(head, exit),
        ...(appMcp ? { onAppTool: async (name: string, args: Record<string, unknown>) => name === "app_routines" ? this.routinesTool(args)
          : isBotTool(name) ? this.botTool(name, args, "coordinator") : workers ? workers.tool(name, args) : Promise.reject(new Error(`Unknown app tool ${name}.`)) } : {}),
      });
    }
    head.start();
    this.head = head;
    // Workers it hosts for another bot: their host learns who owns them before any report goes out (a move made while it slept).
    if (this.engine !== "claude") this.syncWorkerOwners();
    this.sessionCost = { last: 0 };
    if (head.pid > 0) this.options.ledger.record(head.pid);
    this.log(`head started pid ${head.pid} session ${this.session.sessionId}${resume ? " (resumed)" : " (new)"}`);
    this.store.saveHead(this.session);
    this.updated();
    return head;
  }

  /** What a head of this bot starts with now (its settings, plugins, instructions). */
  private sessionStart(resume: boolean, prompts: BotPrompts): SessionStart {
    const plugins = this.options.plugins?.() ?? { dirs: [], env: {} };
    const choices = this.owner.choices();
    const launch = this.options.launch?.() ?? { subagentHourCache: false };
    return {
      sessionId: this.session.sessionId, resume, systemPrompt: prompts.system, pluginDirs: plugins.dirs, pluginEnv: plugins.env, pluginTools: plugins.tools ?? [], skillRoots: plugins.skillRoots ?? [],
      model: choices.model, effort: choices.efforts[this.engine], subagentModel: choices.subagentModel,
      subagentHourCache: launch.subagentHourCache, codexWorkers: choices.codexWorkers,
      addDirs: this.owner.options.addDirs?.() ?? [],
      // 1.x's "Auto-approve safe actions": on unless turned off.
      autoMode: launch.autoMode !== false, allowRules: this.allowRules,
      claudeBypassPermissions: launch.claudeBypassPermissions === true,
      codexBypassPermissions: launch.codexBypassPermissions === true,
      ...(launch.specWriters ? { specWriters: launch.specWriters } : {}),
    };
  }

  /** The model and effort a head of this engine would start with now (what a hot switch moves a running one to). */
  private settingsTarget(): HotSettings {
    if (this.engine === "agy") return { model: this.settingsView().agyModel, effort: this.owner.choices().efforts.agy ?? null };
    const prompts = this.prompts();
    const start = this.sessionStart(this.session.started, prompts);
    if (this.engine === "codex") {
      if (!this.options.codexConfig) return {};
      const config = this.options.codexConfig(this.profile, { ...start, workerInstructions: prompts.codexWorkerSystem, codexModel: this.heads.codexModel, routinesFile: this.routineStorePath });
      return { model: config.model ?? null, effort: config.effort ?? null };
    }
    const config = this.options.headConfig(this.profile, start);
    return { model: config.model ?? null, effort: config.effort ?? null };
  }

  /** Whether the running head would take the pending model/effort change in place (no restart needed). */
  private canSwitchInPlace(head: AgentHead): boolean {
    const can = (head as { canApplySettings?: (target: HotSettings) => boolean }).canApplySettings;
    try { return typeof can === "function" && can.call(head, this.settingsTarget()); }
    catch { return false; }
  }

  /**
   * The running head takes its new model/effort in place, without a restart (Claude: `set_model`; Codex: the
   * next turn/start's override; Antigravity: `session/set_model`, where on). True: done, a divider says so,
   * and no restart is needed for it. False: not supported, refused or failed; the restart path applies.
   */
  async switchInPlace(head: AgentHead): Promise<boolean> {
    const apply = (head as { applySettings?: (target: HotSettings) => Promise<boolean> }).applySettings;
    if (typeof apply !== "function") return false;
    const generation = this.settingsGeneration;
    let switched = false;
    try { switched = await apply.call(head, this.settingsTarget()); }
    catch (error) { this.log(`switching its model/effort in place failed: ${(error as Error).message}`); }
    if (!switched || this.head !== head || !head.running) {
      this.log("its model/effort could not be switched in place: it restarts for it instead");
      return false;
    }
    // Changed again meanwhile: the newer change still waits (a later message applies it).
    if (generation !== this.settingsGeneration) return true;
    this.modelSettingsPending = false;
    const shown = this.restartReason?.shown ?? "new settings";
    if (!this.restartNonModel) { this.restartPending = false; this.restartReason = null; this.restartForPluginsOnly = false; }
    this.owner.add({ id: newId(), role: "divider", text: `Switched → ${shown}`, date: toSwiftDate() });
    this.log(`switched to ${shown} in place, without a restart`);
    return true;
  }

  /** A new session for the next wake (after a sleep, or a resume claude no longer had). */
  newSession() {
    if (this.engine === "agy" && !this.readOnly) {
      this.store.saveSetting("agyConversation", undefined);
      this.store.saveSetting("agyRecovery", undefined);
    }
    this.queuedNote = null;
    this.freshSessionPending = false;
    this.session = { sessionId: randomUUID(), started: false };
    this.briefing = true;
    this.reactionsSeen = null;
    this.briefedComponents = null;
  }

  /** The turn's reply line, put in the chat once it has something to show. */
  private place(turn: Turn): ChatRecord {
    if (turn.record) return turn.record;
    const record: ChatRecord = { id: turn.messageId, role: "bot", text: "", date: toSwiftDate(), turnID: turn.id, state: "streaming", engine: this.engine };
    if (this.sharesChat) record.seenBy = [this.engine];
    turn.record = record;
    this.add(record, { archive: false });
    return record;
  }

  /** Claude started a turn of its own (a background subagent told it something; `app`: the other head's words it answers). */
  private backgroundTurn(head: AgentHead, origin: "background" | "app" = "background"): Turn {
    // While tidying, the app's own turns (a Codex worker's report on the memory file) are the tidy's.
    const turn = this.newTurn(this.tidying ? "tidy" : origin, "", null);
    if (this.tidying) turn.onReply = (text) => this.tidyFollowUp?.(text);
    turn.head = head;
    turn.sent = true;
    this.turn = turn;
    this.clearIdle();
    if (turn.origin !== "tidy") {
      this.emit({ type: "turn.started", botId: this.id, turnId: turn.id, messageId: turn.messageId, head: this.engine });
      this.updated();
    }
    return turn;
  }

  private onItem(head: AgentHead, item: CodexItem) {
    if (head !== this.head || this.ending.has(head)) return;
    // Workers' own items come through `onWorkerOutput` only.
    if (item.kind === "workerReport" || item.kind === "workerNote") return;
    if (item.kind === "request") { this.noteRequest(item.request); return; }
    this.settleSessionSchedules();
    // claude retrying the API is no step (1.x's `noteProgress(of:)` skips it).
    if (item.kind === "connectionTrouble") {
      if (!this.retryingConnection) { this.retryingConnection = true; this.updated(); }
      return;
    }
    // Codex waiting on a retry is no step either; the bot shows it until the turn moves on.
    if (item.kind === "apiRetry") return this.noteCodexRetry(item);
    if (!subagentOf(item) && item.kind !== "managedPending" && item.kind !== "rateLimits") this.clearCodexRetry();
    if (item.kind === "connectionLost") {
      if (item.parent) this.cutOffByNetwork.add(item.parent);
      else if (this.turn?.open && this.turn.head === head) this.turn.lostConnection = true;
      return;
    }
    if (item.kind === "inserted") return this.insertDelivered(head, item.id);
    if (item.kind !== "rateLimits") this.noteProgressOf(item);
    if (item.kind === "managedPending") return this.onItemPending(item.pending);
    if (item.kind === "monitorState") return this.monitorState(item.record);
    if (item.kind === "monitorEnded") return this.monitorEnded(item.id, item.output, item.failed);
    if (item.kind === "routinesChanged") return this.routinesEdited();
    if (item.kind === "backgroundTurn") {
      // A Codex worker's report: the app's own turn on the coordinator, which claude-style turns start on their first line.
      if (!this.turn && !this.ignoreResults) {
        const turn = this.backgroundTurn(head);
        // The app's worker id is authoritative even when the report is not a hand-off.
        if (item.taskId) turn.ended.push(item.taskId);
        this.relayIfCallInWork(turn, item.taskId, "report");
        // The report of a worker that owns a hand-off goes back as that hand-off's reply (`managedWorkerReportStarted`).
        const handoff = item.taskId ? this.managedTaskHandoffs.get(item.taskId) : undefined;
        if (item.taskId && handoff) {
          this.managedTaskHandoffs.delete(item.taskId);
          if (this.managedHandbacks.delete(handoff)) { turn.conducted = true; turn.handoffId = handoff; }
        }
      }
      return;
    }
    if (item.kind === "init") {
      if (this.engine === "agy") this.store.saveSetting("agyRecovery", undefined);
      let save = false;
      if (!this.session.started) { this.session.started = true; save = true; }
      if (item.sessionId && item.sessionId !== this.session.sessionId && /^[0-9a-f-]{36}$/i.test(item.sessionId)) { this.session.sessionId = item.sessionId; save = true; }
      if (save) { this.store.saveHead(this.session); if (this.engine === "agy") this.store.saveSetting("agyConversation", this.session.sessionId); }
      return;
    }
    if (item.kind === "controlResponse") return;
    if (item.kind === "usage") {
      // Claude's cost is a running total for its process: this turn's is the difference.
      const spent = costDelta(this.sessionCost, item.totalCost);
      if (spent > 0 || totalTokens(item.tokens) > 0) this.options.usage?.(this.owner.profile.name, spent, item.tokens);
      return;
    }
    if (item.kind === "rateLimits") { this.options.rateLimits?.(item.engine, item.limits); return; }
    if (item.kind === "command") {
      if (commandEnded(item.state)) { this.commandEnded(head, item.id, item.state); return; }
      const mid = this.claudeMidTurn.has(head);
      if (item.state === "started") this.claudeMidTurn.add(head);
      // claude begins a turn: the one set aside is under way after all (or another first, whose result tells).
      if (item.state === "started" && this.unbegun?.head === head) this.clearUnbegun();
      const steered = this.steered.get(item.id);
      if (steered) {
        if (item.state === "started") { this.steered.delete(item.id); if (!mid) this.steeredStarted(head, steered); }
        return;
      }
      // The other head's words, read too late for the turn they were meant for: claude answers them
      // in a turn of its own, the app's (its words show; <no-reply/> shows nothing). A message of
      // ours sent after them but not begun yet waits for that turn to end.
      if (item.state !== "started" || !this.contextSent.delete(item.id) || mid || this.ignoreResults || this.draining) return;
      const waiting = this.turn;
      if (waiting && (!waiting.open || waiting.head !== head || waiting.reply.text || waiting.steps.length || waiting.record)) return;
      if (waiting) { this.turn = null; this.deferred = waiting; }
      this.backgroundTurn(head, "app");
      return;
    }
    if (item.kind === "permissionCancelled") {
      for (const [id, approval] of this.approvals) if (approval.head === head && approval.requestId === item.requestId) this.settle(id, NO_LONGER_NEEDED, false);
      if (item.requestId.startsWith("worker:")) this.options.agents?.approvalCancelled?.(this.hostFacts(), item.requestId);
      return;
    }
    if (item.kind === "toolUse") this.noteToolCall(item);
    if (item.kind === "permissionDenied") { this.showDenial(item); return; }
    // A managed worker owns its own turn. Its approval must neither create a phantom
    // coordinator turn nor be denied by an unrelated coordinator's cleanup/drain/tidy.
    if (item.kind === "permission" && item.workerId) { if (this.routeWorkerApproval(head, item)) return; return this.ask(head, item, null); }
    if (item.kind === "backgroundStarted") {
      // A Monitor running a command is a background shell task too.
      const call = this.toolCalls.get(item.id);
      const monitor = item.monitor || (call ? call.tool === "Monitor" : this.turn?.steps.findLast((step) => step.id === item.id)?.tool === "Monitor");
      if (call?.parent) this.addSubagentTask(call.parent, item.id, monitor ? "monitor" : "command", item.description || call.detail, call.detail);
      else this.addBackgroundTask(item.id, monitor ? "monitor" : "command", item.description);
      return;
    }
    // A subagent's own background work: a command claude moved to the background after its timeout, a wake-up, a cron job.
    if (item.kind === "toolResult" && item.parent && item.launch?.background && !item.failed) {
      const call = this.toolCalls.get(item.id);
      if (call?.tool === "Bash") {
        this.addSubagentTask(item.parent, item.id, "command", "", call.detail);
        const task = this.findTask(item.id);
        if (task) { task.outputFile = item.launch.outputFile ?? backgroundOutputFile(item.output) ?? task.outputFile; this.touchTask(item.id); }
      }
    }
    if (item.kind === "toolUse" && item.parent) {
      const call = scheduleCall(item.tool, item.input);
      if (call) this.scheduleCalls.set(item.id, call);
    }
    if (item.kind === "scheduleResult" && item.parent) {
      const call = this.scheduleCalls.get(item.id);
      this.scheduleCalls.delete(item.id);
      const task = call ? scheduledTask(item.id, call, item.result) : null;
      if (task) this.placeSubagentTask(item.parent, task);
      const tool = this.toolCalls.get(item.id)?.tool;
      const cancellation = tool ? scheduleCancellation(tool, item.result) : null;
      if (cancellation) this.cancelScheduled(cancellation, this.turn);
      this.refreshScheduleDue();
      return;
    }
    // Subagents are followed whoever's turn it is; their own lines stop here.
    if (this.onSubagentItem(item)) return;
    if (item.kind === "result") this.claudeMidTurn.delete(head);
    else this.claudeMidTurn.add(head);
    // Output of a turn: claude began the one set aside after all.
    if (item.kind !== "result" && this.unbegun?.head === head) this.clearUnbegun();
    // The tail of a turn that was cut off: it belongs to nobody.
    if (this.ignoreResults > 0) {
      if (item.kind === "permission") head.answer(item.requestId, false, item.input, "Not now: that turn has ended.");
      if (item.kind === "result") this.ignoreResults -= 1;
      return;
    }
    let turn = this.turn;
    if (!turn || !turn.open || turn.head !== head) {
      // The tail of a stopped turn: only its end matters, to know the head is free again.
      if (this.draining?.head === head) {
        // Not while its tree is being ended (stop's grace ran out): what waits goes once the process is gone.
        if (item.kind === "result" && !this.ending.has(head)) this.drained(head);
        if (item.kind === "permission") head.answer(item.requestId, false, item.input, "Not now: the user stopped this turn.");
        return;
      }
      if (turn) return; // A turn of ours waits to be sent: nothing of claude's can be for it yet.
      // Nothing of ours under way: claude started a turn itself.
      if (item.kind === "result" && !item.text) return;
      if (item.kind === "textBlock") return;
      turn = this.backgroundTurn(head);
    }
    if (item.kind === "permission") return this.ask(head, item, turn);
    if (item.kind === "scheduleResult") {
      const call = this.scheduleCalls.get(item.id);
      this.scheduleCalls.delete(item.id);
      const task = call ? scheduledTask(item.id, call, item.result) : null;
      if (task && !turn.tasks?.some((candidate) => candidate.id === task.id)) (turn.tasks ??= []).push(task);
      const tool = this.toolCalls.get(item.id)?.tool;
      const cancellation = tool ? scheduleCancellation(tool, item.result) : null;
      if (cancellation) this.cancelScheduled(cancellation, turn);
      this.refreshScheduleDue();
      return;
    }
    switch (item.kind) {
      case "stepText":
        // Codex's commentary: a step, and what the other head hears it say.
        turn.steps.push({ id: `${turn.id}:text:${turn.steps.length}`, kind: "text", title: item.text, failed: false, done: true });
        if (turn.origin !== "tidy") this.headWords(item.text);
        this.emitSteps(turn);
        return;
      case "toolUse": {
        const call = scheduleCall(item.tool, item.input);
        if (call) this.scheduleCalls.set(item.id, call);
        // The words claude said before this call: the other head hears them now.
        const said = turn.reply.text.slice(turn.told).trim();
        if (said && turn.origin !== "tidy") { turn.told = turn.reply.text.length; this.headWords(streamingText(said)); }
        const isSubagent = SUBAGENT_TOOLS.has(item.tool);
        turn.steps.push({ id: item.id, kind: isSubagent ? "subagent" : "tool", tool: item.tool, title: item.title, detail: item.detail, failed: false, done: false });
        this.emitSteps(turn);
        return;
      }
      case "toolResult": {
        this.scheduleCalls.delete(item.id);
        const step = turn.steps.find((candidate) => candidate.id === item.id);
        if (!step) return;
        // A subagent's step is done when the subagent is, not when its call returns.
        if (step.kind !== "subagent" || this.subagents.get(item.id)?.status !== "running") step.done = true;
        step.failed = item.failed;
        if (item.output) step.output = item.output;
        // A Bash call claude moved to the background itself (it outlived its timeout) said `is_backgrounded: false`
        // at `task_started`; only this result (`backgroundTaskId`) tells, so it is background work from here.
        if (item.launch?.background && step.tool === "Bash" && !item.failed && !item.parent) this.addBackgroundTask(item.id, "command", "");
        const task = turn.tasks?.find((task) => task.id === item.id);
        if (task) task.outputFile = item.launch?.outputFile ?? backgroundOutputFile(item.output) ?? task.outputFile;
        this.emitSteps(turn);
        return;
      }
      case "result": {
        if (item.ok) turn.reply.add(item);
        const end = headTurnEnd(item, turn.reply.text, this.engine);
        // Its turn ended with claude's connection error: say so, and wait for the network instead of going to sleep (`showNetworkLoss`).
        if (end.status === "failed" && turn.lostConnection && turn.origin !== "tidy") {
          turn.reply = new ReplyText();
          this.recordOutage({ turnFailed: true });
          this.finishTurn(turn, "failed", lostText(item.error || item.text));
          this.bumpUnread();
          return;
        }
        // An API error that passes (a Cloudflare block, an overload): the turn is tried again in the same session after a
        // wait, with a short line instead of claude's words; once every try failed, one plain failed line.
        if (end.status === "failed" && item.apiPassing && turn.origin !== "tidy") {
          if (this.retryApiLater(turn)) return;
          this.apiRetries = 0;
          turn.reply = new ReplyText();
          this.finishTurn(turn, "failed", apiGaveUpText(apiRetryDelays().length, item.error || item.text));
          return;
        }
        if (turn.origin !== "tidy") this.apiRetries = 0;
        // claude cut this turn off to take your line (priority "now"): the app's doing, not an error. It ends stopped,
        // with the words it wrote so far or, with none, no bubble at all; the raw subtype never shows.
        if (!item.ok && item.subtype === "error_during_execution" && turn.steeredNow) { this.finishTurn(turn, "stopped"); return; }
        this.finishTurn(turn, end.status, end.error);
        return;
      }
      default: {
        const piece = turn.reply.add(item);
        if (!piece) return;
        // claude's own turns show only once they end (or never); the tidy never.
        if (turn.origin === "background" || turn.origin === "tidy") return;
        this.showSoFar(turn);
      }
    }
  }

  /** The reply so far, without the app's tags (a tag still being written is held back). */
  private showSoFar(turn: Turn) {
    const shown = streamingText(turn.reply.text);
    if (!shown && !turn.record) return;
    const record = this.place(turn);
    const before = record.text;
    if (shown === before) return;
    record.text = shown;
    this.persist(true);
    if (shown.startsWith(before)) {
      this.emit({ type: "turn.delta", botId: this.id, turnId: turn.id, messageId: turn.messageId, text: shown.slice(before.length) });
    } else {
      this.emit({ type: "message.updated", botId: this.id, message: this.messageView(record) });
    }
  }

  /** Only app-owned coordinator records can update a coordinator's monitor chip. */
  private monitorState(monitor: CommandMonitor) {
    if (monitor.owner.toLowerCase() !== this.session.sessionId.toLowerCase()) return;
    const task = monitorTask(monitor);
    if (!task) return;
    // Correlate to its existing coordinator step, never to descendants or a later reply.
    if (this.turn?.steps.some(step => step.id === monitor.id && step.tool === "Monitor")) {
      const tasks = this.turn.tasks ??= [];
      const index = tasks.findIndex(candidate => candidate.id === monitor.id);
      if (index < 0) tasks.push(task); else tasks[index] = task;
      this.emitSteps(this.turn);
      return;
    }
    const record = this.records.findLast(record => record.engine === "codex" && record.steps?.some(step => step.id === monitor.id && step.tool === "Monitor"));
    if (!record) return;
    const tasks = Array.isArray(record.backgroundTasks) ? record.backgroundTasks as BackgroundTask[] : [];
    const index = tasks.findIndex(candidate => candidate.id === monitor.id);
    if (index < 0) tasks.push(task); else tasks[index] = task;
    record.backgroundTasks = tasks;
    this.changed(record);
  }

  /** A monitored command ended: its step, in the reply of the turn that started it, is done. */
  private monitorEnded(id: string, output: string, failed: boolean) {
    const mark = (steps: StepRecord[] | undefined) => {
      const step = steps?.findLast((candidate) => candidate.id === id);
      if (!step) return false;
      step.done = true;
      step.failed = failed;
      step.output = output.slice(0, 10_000);
      return true;
    };
    if (this.turn && mark(this.turn.steps)) { this.emitSteps(this.turn); return; }
    for (let i = this.records.length - 1; i >= Math.max(0, this.records.length - 80); i--) {
      const record = this.records[i]!;
      if (mark(record.steps)) { this.changed(record); return; }
    }
  }

  /** Subagent bookkeeping (subagents.json). True when the item was the subagent's own (not the turn's). */
  private onSubagentItem(item: CodexItem): boolean {
    switch (item.kind) {
      case "toolUse":
        if (this.subagents.toolUse(item)) this.subagentChanged(this.subagents.get(item.parent ?? item.id));
        return item.parent !== null;
      case "toolResult": {
        const wasRunning = this.subagents.get(item.id)?.status === "running";
        if (this.subagents.toolResult(item)) {
          // A nested Agent result changes both the parent's tool step and the child's record.
          this.dirtySubagents.add(item.id);
          this.subagentChanged(this.subagents.get(item.parent ?? item.id));
        }
        if (wasRunning && this.subagents.get(item.id)?.status !== "running") this.subagentEnded(item.id);
        // The call that started it (not a SendMessage call's result) came back with claude's connection error.
        if (this.subagents.get(item.id)?.id === item.id) this.noteSubagentEnd(item.id, item.output);
        return item.parent !== null;
      }
      case "subagentRuntime":
        if (this.subagents.runtime(item.id, item.runtime, item.model)) this.subagentChanged(this.subagents.get(item.id), true);
        return true;
      case "subagentWaitingOn":
        if (this.subagents.waitingOn(item.id, item.on)) this.subagentChanged(this.subagents.get(item.id), true);
        return true;
      case "subagentOutput":
        if (this.subagents.output(item.id, item.counter, item.tokens)) this.subagentChanged(this.subagents.get(item.id), true);
        return true;
      case "subagentExecution":
        if (this.subagents.execution(item.id, item.execution)) this.subagentChanged(this.subagents.get(item.id));
        return true;
      case "subagentText":
        if (this.subagents.text(item.parent, item.text)) this.subagentChanged(this.subagents.get(item.parent), true);
        return true;
      case "subagentUser":
        if (this.subagents.said(item.parent, item.text, item.from)) this.subagentChanged(this.subagents.get(item.parent), true);
        return true;
      case "subagentStarted":
        // Initial ownership comes from the Agent call, never from whichever turn is now visible.
        if (this.subagents.started(item, undefined, isWorkerType(item.type) ? this.jobOfTurn() : undefined)) this.subagentChanged(this.subagents.get(item.id));
        if (item.background) this.addBackgroundTask(this.subagents.get(item.id)?.id ?? item.id, "agent", item.description);
        // A worker started for a bot's @: its news goes back to that bot (`callInWork`).
        if (isWorkerType(item.type)) this.linkCallInWork(item.id);
        // A worker for handed-over work: its report carries the hand-back.
        if ((this.engine === "codex" || this.engine === "agy") && this.turn?.conducted && this.turn.handoffId && (item.type === "codex-worker" || item.type === "agy-worker" || item.type === "ccb-core:component-editor")) {
          this.managedTaskHandoffs.set(item.id, this.turn.handoffId);
        }
        return true;
      case "subagentEnded": {
        const known = this.subagents.get(item.id)?.id ?? this.subagents.list.find(child=>child.agentID===item.id)?.id;
        // A worker's chip is its ledger's (`projectWorker`); other background work ends here.
        if (!isWorkerType((known ? this.subagents.get(known) : undefined)?.type)) this.endBackground(known ?? item.id, item.status, item.summary);
        const ended = this.subagents.ended(item);
        // A notification says more than the error, so a failed one counts if any line is it.
        if (known && (item.status.toLowerCase() === "failed" || item.status.toLowerCase() === "error" || this.cutOffByNetwork.has(known) || isConnectionError(item.summary ?? ""))) {
          this.noteSubagentEnd(known, connectionErrorLine(item.summary ?? ""));
        }
        if (ended) {
          this.subagentEnded(ended.id);
          this.subagentChanged(ended);
        }
        return true;
      }
      case "subagentWaiting":
        return true;
      default:
        return false;
    }
  }

  /** It changed: saved, its view sent, and the step that sent it (status, count) drawn again. */
  subagentChanged(subagent: SubagentRecord | undefined, progress = false, redrawLine = true) {
    if (!subagent) return;
    this.saveSubagents(progress && subagent.status === "running", subagent);
    if (!subagent.parentID) this.options.agents?.observed(this.hostFacts(), subagent, this.workerViews.get(subagent.id));
    this.rowsChanged();
    // The current run's tail is in memory; earlier runs (rare) come from its file so an open view keeps them.
    const live = subagent.runs ? { runs: this.subagentHistory(subagent).runs, steps: subagent.steps } : undefined;
    this.emit({ type: "subagent.updated", botId: this.id, subagent: subagentView(subagent, this.speaker, this.subagents, this.engine, live) });
    const top = subagent.parentID ? this.subagents.get(subagent.parentID) ?? subagent : subagent;
    if (this.turn?.steps.some((step) => step.id === top.id)) this.emitSteps(this.turn);
    if (!redrawLine) return;
    for (let i = this.records.length - 1, seen = 0; i >= 0 && seen < 80; i--, seen++) {
      const record = this.records[i]!;
      if (record !== this.turn?.record && record.steps?.some((step) => step.id === top.id)) {
        this.emit({ type: "message.updated", botId: this.id, message: this.messageView(record) });
        break;
      }
    }
  }

  /** A subagent ended: the step that sent it is done, and a silent turn will have to say what came of it. */
  private subagentEnded(id: string) {
    const subagent = this.subagents.get(id);
    if (!subagent) return;
    if (!subagent.parentID) this.options.agents?.ended(this.hostFacts(), subagent, this.workerViews.get(subagent.id));
    // One another bot owns: its news is that bot's (its report is routed there), so no turn of this head reports it.
    const moved = !subagent.parentID && (this.options.agents?.movedOut(this.engine).has(subagent.id) ?? false);
    this.endSubagentTasks(subagent.id);
    const mark = (steps: StepRecord[] | undefined) => {
      const step = steps?.findLast((candidate) => candidate.id === id);
      if (!step) return false;
      step.done = true;
      step.failed = subagent.status === "failed";
      return true;
    };
    if (!mark(this.turn?.steps)) {
      for (let i = this.records.length - 1; i >= Math.max(0, this.records.length - 80); i--) {
        if (mark(this.records[i]!.steps)) { this.persist(true); break; }
      }
    }
    if (moved) { /* routed to its owner */ }
    else if (this.turn && this.turn.origin !== "tidy") this.turn.ended.push(id);
    else this.pendingEnded.push(id);
    if (!this.turn && !this.queue.length && !this.tidying) this.scheduleIdle();
    this.checkSettingsHold();
  }

  private emitSteps(turn: Turn) {
    if (turn.origin === "tidy" || turn !== this.turn) return;
    this.emit({ type: "turn.steps", botId: this.id, turnId: turn.id, messageId: turn.messageId, steps: turn.steps.slice(-500).map((step) => stepView(step, this.subagents)) });
  }

  finishTurn(turn: Turn, status: Status, error?: string) {
    if (this.unbegun?.turn === turn) this.clearUnbegun();
    if (!turn.open) return;
    turn.open = false;
    if (this.turn === turn) this.turn = null;
    this.clearCodexRetry();
    if (turn.origin === "tidy") {
      if (turn.callIn) this.updated();
      turn.onReply?.(status === "done" ? turn.reply.text : "");
      this.finished.set(turn.id, status);
      turn.resolve(status);
      this.settleTurnApprovals();
      return; // sleep() goes on from here.
    }
    const raw = turn.reply.text;
    const parsed = parseReply(raw);
    // A hand-off to the other head is the app's, not the chat's.
    const tags = status === "done" ? parseHeadTags(parsed.body) : { body: parsed.body, handoff: null };
    const ended = turn.origin === "background" ? [...this.pendingEnded.splice(0), ...turn.ended] : turn.ended;
    if (status === "done") this.applyReactions(parsed.reactions);
    if (status === "done" && parsed.pluginTags) this.options.pluginTags?.(this.owner, parsed.pluginTags);
    // Nothing for the user, whoever started the turn: no bubble (`headTurnContent` says what the head keeps out).
    const content = headTurnContent({ status, origin: turn.origin, sharesChat: this.sharesChat, raw, parsed, body: tags.body, handoff: !!tags.handoff, steps: turn.steps.length, error: error ?? null });
    // A turn cut off with no words of its own (`steeredNow`) shows nothing either: an interrupted reply has no bubble.
    if (!hasVisibleContent(content) || (status === "stopped" && !tags.body.trim())) {
      if (turn.record) this.remove(turn.record);
      this.keepTasks(turn, null);
      this.emit({ type: "turn.finished", botId: this.id, turnId: turn.id, messageId: turn.messageId, status, text: "" });
      this.finished.set(turn.id, status);
      turn.resolve(status);
      this.relayFollowUp(turn, status, null, error);
      this.afterTurn();
      // Handed work done with nothing to say still goes back to the head that handed it.
      if (this.sharesChat) {
        const owner = this.owner;
        owner.conduct(owner.conductor.replied(this.engine, "", null, this.takeHandback(turn), turn.handoffId));
        this.headStopped(this.engine);
      }
      // A finished subagent's result always reaches the user: ask once, then say it ourselves.
      if (turn.origin !== "user" && ended.length) this.reportFinished(ended);
      else this.next();
      return;
    }
    const fresh = !turn.record;
    const record: ChatRecord = turn.record ?? { id: turn.messageId, role: "bot", text: "", date: toSwiftDate(), turnID: turn.id, engine: this.engine };
    if (this.sharesChat) record.seenBy = union(record.seenBy, [this.engine]);
    turn.record = record;
    this.keepTasks(turn, record);
    let text = tags.body;
    if (status === "done") {
      if (parsed.choices) record.choices = parsed.choices.map((choice) => ({ label: choice.label, ...(choice.detail ? { detail: choice.detail } : {}), recommended: choice.recommended }));
      if (parsed.questions) record.questions = parsed.questions;
      if (parsed.displays.length) {
        record.displays = parsed.displays;
        // A library component it drew without having it goes on its list, if there is room (`countComponents`).
        this.owner.drewComponents((parsed.displays as Display[]).map((display) => display.name));
      }
      this.associateDecision(record, parsed.decisionReference, turn);
      // <show id="tests"> updates that card in place; a reply that is only that shows no line of its own.
      if (record.displays?.some((display) => (display as Display).id)) {
        record.text = text;
        if (this.owner.updateCards(record) && !turn.steps.length) {
          if (!fresh) this.remove(record);
          this.emit({ type: "turn.finished", botId: this.id, turnId: turn.id, messageId: turn.messageId, status, text: "" });
          this.finished.set(turn.id, status);
          turn.resolve(status);
          this.afterTurn();
          if (this.sharesChat) this.headStopped(this.engine);
          this.next();
          return;
        }
      }
    }
    if (status === "failed" && !text && error) text = error;
    record.text = text;
    record.state = status;
    // The pictures it shows by path, as they are now: a later reply that rewrites the file leaves this one's alone (chat-media.ts).
    keepLineMedia(this.lineMediaStore, record.id, text);
    record.session = this.session.sessionId.toUpperCase();
    if (turn.steps.length) record.steps = turn.steps;
    if (status !== "done") record.interrupted = true;
    if (error) record.error = error.slice(0, 2_000);
    if (fresh) this.add(record);
    else {
      this.persist();
      archiveLine(this.paths.archive, record);
    }
    this.emit({
      type: "turn.finished", botId: this.id, turnId: turn.id, messageId: turn.messageId, status, text: record.text,
      ...(error ? { error: error.slice(0, 2_000) } : {}),
    });
    this.emit({ type: "message.updated", botId: this.id, message: this.messageView(record) });
    this.finished.set(turn.id, status);
    turn.resolve(status);
    if (status === "done") {
      this.bumpUnread();
      const left = this.handleRequests(parsed.requests);
      if (left.length) {
        const what = [...new Set(left.map(unsupportedRequest))];
        this.notice(`Botling 2.0 cannot do this yet, so nothing happened: ${what.join("; ")}.`);
      }
      this.afterReplyHooks(record);
      // What it said covers the subagents that ended so far.
      this.pendingEnded = [];
    }
    this.relayFollowUp(turn, status, record, error);
    this.afterTurn();
    // The other head hears the reply; a hand-off in it goes on (`headReplied`).
    // A bot with one head may hand work to the other CLI too (1.x: `sharesChat || tags.handoff`): its
    // other head is made for it (`makePartner`), and the reply comes back.
    if (status === "done" && (this.sharesChat || tags.handoff)) this.owner.headReplied(record, this.engine, tags.handoff, this.takeHandback(turn), turn.handoffId);
    else if (this.sharesChat) this.headStopped(this.engine);
    this.next();
  }

  /** Whether this turn hands its work back now (`takeHandback`): not while a worker it started for the hand-off owns it. */
  private takeHandback(turn: Turn): boolean {
    const id = turn.handoffId;
    if ((this.engine === "codex" || this.engine === "agy") && turn.conducted && id && [...this.managedTaskHandoffs.values()].includes(id)) {
      this.managedHandbacks.add(id);
      return false;
    }
    return turn.conducted;
  }

  /** The return routes of a hand-off that stopped (or of all of them) are gone. */
  forgetReturnRoutes(handoffId?: string) {
    for (const [task, id] of [...this.managedTaskHandoffs]) if (!handoffId || id === handoffId) this.managedTaskHandoffs.delete(task);
    if (handoffId) this.managedHandbacks.delete(handoffId); else this.managedHandbacks.clear();
  }

  /** claude waits on nothing once its turn ended: no approval stays open. */
  private afterTurn() {
    this.settleTurnApprovals();
    this.updated();
  }

  /**
   * `turn`, set aside while claude answered a line first, is the turn under way again: claude begins it now, as a rule at
   * once (it was sent already and waits in claude's queue). Should claude never begin it (its words went into the turn
   * that just ended, and its end was lost or never said), it ends after `deferredStartMs` and what waits behind it goes:
   * never a "Thinking" that lasts until the app is restarted.
   */
  private awaitBegin(turn: Turn, head: AgentHead) {
    this.clearUnbegun();
    const timer = setTimeout(() => {
      if (this.unbegun?.timer !== timer) return;
      this.unbegun = null;
      if (this.turn !== turn || !turn.open || turn.reply.text || turn.steps.length || turn.record) return;
      this.log(`claude did not begin a message set aside for its own turn within ${Math.round(this.deferredStartMs / 1000)} s: that turn ended, and what waits goes on`);
      this.finishTurn(turn, "stopped");
    }, this.deferredStartMs);
    timer.unref?.();
    this.unbegun = { turn, head, timer };
  }

  private get deferredStartMs(): number { return this.options.deferredStartMs ?? 90_000; }

  private clearUnbegun() {
    if (!this.unbegun) return;
    clearTimeout(this.unbegun.timer);
    this.unbegun = null;
  }

  /** The next waiting message, if any; else the idle clock starts. */
  next(): void {
    // While a stopped turn drains nothing begins (not even the turn set aside): stop() goes on here once it ended.
    if (this.turn || this.tidying || this.switching || this.draining) return;
    const deferred = this.deferred;
    if (deferred) {
      // It was sent already: claude begins it now.
      this.deferred = null;
      if (deferred.open && deferred.head === this.head && this.head?.running) { this.turn = deferred; this.awaitBegin(deferred, this.head); return; }
      // Stopped meanwhile: what claude does with it belongs to nobody.
      if (!deferred.open && deferred.head === this.head && this.head?.running) { this.ignoreResults += 1; this.head.interrupt(); }
    }
    if (this.swapHold) return;
    if (this.resumePaused()) return;
    // Your message waits for this head's own work before a model/effort restart.
    if (this.settingsHold && !this.releaseSettingsHold()) return;
    if (this.queue.some((turn) => turn.open) && this.switchReady) { void this.handOver(); return; }
    const waiting = this.queue.shift();
    if (waiting) {
      this.withdrawInsert(waiting);
      if (!waiting.open) return this.next();
      this.begin(waiting);
      return;
    }
    this.scheduleIdle();
  }

  /** `Bot.reportFinishedSubagents`: the bot answered a finished subagent's news with nothing. */
  private reportFinished(ids: string[]) {
    // Codex: a worker's report turn is on its way (or under way); it says what came of it.
    if ((this.engine === "codex" || this.engine === "agy") && this.managedPending) return this.next();
    const moved = this.options.agents?.movedOut(this.engine);
    const finished = [...new Set(ids)].filter((id) => !moved?.has(id)).map((id) => this.subagents.get(id)).filter((subagent): subagent is SubagentRecord => !!subagent && subagent.status !== "running");
    const ask = finished.filter((subagent) => !this.reportAsked.has(subagent.id));
    if (ask.length && this.engine === "claude" && this.head?.running && !this.queue.length) {
      for (const subagent of ask) this.reportAsked.add(subagent.id);
      const turn = this.newTurn("app", reportNote(ask), null);
      turn.ended = ask.map((subagent) => subagent.id);
      this.begin(turn);
      return;
    }
    if (finished.length) {
      this.notice(finished.map((subagent) => {
        const report = (subagent.result ?? "").split("\n").find((line) => line.trim()) ?? "";
        const line = `Subagent “${subagent.description}” finished.`;
        return report ? `${line} Its report: ${report}` : line;
      }).join("\n"));
      this.bumpUnread();
    }
    this.next();
  }

  /** `quitting`: no polite interrupt first (the app is going), the tree is ended at once. */
  async stop(turnId: string, { quitting = false } = {}): Promise<ResultOf<"turn.stop">> {
    // Stopped by you: the judge does not continue it (1.x's explicit stop wins).
    const turn = this.turn;
    if (!turn || turn.id !== turnId || turn.origin === "tidy") {
      // A message still waiting its turn: taken back (it never reached claude).
      const waiting = this.queue.find((candidate) => candidate.id === turnId);
      if (waiting) {
        this.queue.splice(this.queue.indexOf(waiting), 1);
        this.withdrawInsert(waiting);
        waiting.open = false;
        this.emit({ type: "turn.finished", botId: this.id, turnId, messageId: waiting.messageId, status: "stopped", text: "" });
        this.finished.set(turnId, "stopped");
        waiting.resolve("stopped");
        // The message that waited for a model/effort restart was taken back: its card goes too.
        this.checkSettingsHold();
        return { stopped: true, killed: [], forced: false };
      }
      // Sent, but set aside while claude answers the other head's words first.
      if (this.deferred?.id === turnId) {
        const deferred = this.deferred;
        deferred.open = false;
        this.emit({ type: "turn.finished", botId: this.id, turnId, messageId: deferred.messageId, status: "stopped", text: "" });
        this.finished.set(turnId, "stopped");
        deferred.resolve("stopped");
        return { stopped: true, killed: [], forced: false };
      }
      // The message held for the other head (a message to both): taken back too.
      const hold = this.claimHold;
      if (hold?.turn.id === turnId) {
        this.claimHold = null;
        clearTimeout(hold.timer);
        hold.turn.open = false;
        this.emit({ type: "turn.finished", botId: this.id, turnId, messageId: hold.turn.messageId, status: "stopped", text: "" });
        hold.turn.resolve("stopped");
        return { stopped: true, killed: [], forced: false };
      }
      // The other head's turn.
      const peer = this.peers.find(bot => bot.ownsTurn(turnId));
      if (peer) return peer.stop(turnId, { quitting });
      return { stopped: false, killed: [], forced: false };
    }
    // Stop stops the work paused for the user too.
    this.paused = null;
    // Order matters: the turn is closed (and says so) before claude hears of it.
    turn.open = false;
    this.turn = null;
    const text = parseReply(turn.reply.text).body;
    let record = turn.record;
    if (record || turn.origin !== "background") {
      record ??= this.place(turn);
      record.text = text;
      record.state = "stopped";
      record.interrupted = true;
      if (turn.steps.length) record.steps = turn.steps;
      this.persist();
      archiveLine(this.paths.archive, record);
    }
    this.emit({ type: "turn.finished", botId: this.id, turnId, messageId: turn.messageId, status: "stopped", text });
    if (record) this.emit({ type: "message.updated", botId: this.id, message: this.messageView(record) });
    this.finished.set(turnId, "stopped");
    turn.resolve("stopped");
    this.settleTurnApprovals();
    this.updated();
    // A message this head led for both: the other head gets it now.
    if (this.sharesChat) this.headStopped(this.engine);
    const head = turn.head;
    if (!head || !head.running || !turn.sent) { this.next(); return { stopped: true, killed: [], forced: false }; }
    if (quitting) {
      this.ending.add(head);
      const result = await head.terminate(1_000);
      return { stopped: true, killed: result.killed, forced: result.forced };
    }
    // Ask claude to end the turn (the session goes on); wait for its result line.
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    const draining = { head, resolve, promise };
    this.draining = draining;
    head.interrupt();
    const ended = await Promise.race([promise.then(() => true), sleep(this.options.interruptGraceMs).then(() => false)]);
    if (ended) {
      if (this.draining === draining) this.draining = null;
      this.log(`turn ${turnId} stopped; claude ended it`);
      this.next();
      return { stopped: true, killed: [], forced: false };
    }
    // It did not answer: end its whole tree. The next message starts the head again (--resume). What waits goes only
    // once the process is gone (onExit), never to the process being ended.
    this.ending.add(head);
    const result = await head.terminate(1_500);
    if (this.draining === draining) this.draining = null;
    resolve();
    this.log(`turn ${turnId} stopped; claude did not end it in time, so its tree was ended: ${result.killed.join(",")} forced=${result.forced}`);
    this.next();
    return { stopped: true, killed: result.killed, forced: result.forced };
  }

  /** A stopped turn has drained (claude ended it, or its process is gone): the turn that waited is sent now. */
  private drained(head: AgentHead) {
    const draining = this.draining;
    if (draining?.head !== head) return;
    this.draining = null;
    draining.resolve();
  }

  async await(turnId: string, signal: AbortSignal): Promise<ResultOf<"turn.await">> {
    const done = this.members.map(bot => bot.finished.get(turnId)).find(Boolean);
    if (done) return { status: done };
    const turn = this.turn?.id === turnId ? this.turn : this.deferred?.id === turnId ? this.deferred : this.queue.find((candidate) => candidate.id === turnId)
      ?? (this.claimHold?.turn.id === turnId ? this.claimHold.turn : undefined);
    if (!turn) {
      const peer = this.peers.find(bot => bot.ownsTurn(turnId));
      if (peer) return peer.await(turnId, signal);
      throw new ContractError("not_found", "No such turn.");
    }
    const status = await Promise.race([
      turn.done,
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new ContractError("cancelled", "Stopped waiting.")))),
    ]);
    return { status };
  }

  private onExit(head: AgentHead, exit: HeadExit) {
    if (head.pid > 0) this.options.ledger.forget(head.pid);
    this.drained(head);
    if (head !== this.head) return;
    // Gone because of the network (or gone while waiting for it): its session and the subagents still
    // at work are picked up again when the network is back (1.x's `lostToNetwork`).
    const lostToNetwork = !exit.expected && !this.shuttingDown && (this.outage !== null || (exit.code !== 0 && mentionsConnectionError(exit.stderr)));
    const cutOff = lostToNetwork ? this.inHeadSubagents.map((subagent) => subagent.id) : [];
    const lostSession = this.session.started ? this.session.sessionId : null;
    this.head = null;
    this.retryingConnection = false;
    this.codexRetry = null;
    this.clearIdle();
    this.ignoreResults = 0;
    // Paused work went with the process (1.x drops `pausedWork` when the process exits).
    this.paused = null;
    this.contextSent.clear();
    this.steered.clear();
    for (const [id, approval] of [...this.approvals]) if (approval.head === head) this.settle(id, NO_LONGER_NEEDED, false);
    // Its subagents (and Codex's workers) run inside its process: they went with it.
    this.managedPending = false;
    if (this.subagents.stopRunning()) this.saveSubagents();
    const why = `${exit.signal ?? exit.code}`;
    const turn = this.turn;
    let failedTurn = false;
    if (turn?.open && turn.head === head) {
      // A resume of a session claude (or Antigravity: its conversation is not found) no longer has: start a new session and send the message again, once.
      if (!this.restartRecovery && (this.engine !== "agy" || isAgyConversationGone(exit.stderr)) && exit.silent && this.session.started && !turn.retried && !exit.expected && (turn.origin !== "tidy" || (turn.guest && this.engine === "agy")) && turn.origin !== "background") {
        this.log(`resuming session ${this.session.sessionId} failed (${why}: ${exit.stderr.slice(0, 200)}); starting a new session`);
        this.newSession();
        this.store.saveHead(this.session);
        this.add({ id: newId(), role: "divider", text: NEW_SESSION_DIVIDER, date: toSwiftDate() });
        turn.retried = true;
        turn.head = null;
        turn.sent = false;
        void this.deliver(turn);
        return;
      }
      this.finishTurn(turn, "failed", `The agent exited (${why}) without finishing. ${exit.stderr.slice(-1_000)}`.trim());
      failedTurn = true;
    }
    const deferred = this.deferred;
    this.deferred = null;
    if (deferred?.open) this.finishTurn(deferred, "failed", `The agent exited (${why}) before it began this message.`);
    // What it left running in the background went with its process.
    this.stopTasks();
    this.log(`head exited (${why})${exit.expected ? "" : " unexpectedly"}`);
    if (exit.expected && this.restarting === head) {
      // Ended to start again before a message: the same session goes on (`--resume`).
      this.restarting = null;
    } else if (this.restartRecovery || (exit.expected && this.engine === "agy")) {
      // agy resumes by its actual conversation ID after cancel, sleep or shutdown.
      this.briefing = !this.session.started;
    } else if (exit.expected) {
      // It went to sleep: the next wake is a new session, briefed from memory.md and the chat.
      this.newSession();
    } else if (!this.shuttingDown) {
      // Nobody asked it to exit (1.x's `.exited`): it is asleep, and the next message wakes a new
      // session, briefed from memory.md and the chat. A non-zero exit is said in the chat (1.x:
      // its stderr, else "claude exited unexpectedly"); a failed turn already says it.
      if (this.engine === "agy") {
        // Preserve identity across failed resumes, the next explicit message and app restart.
        this.store.saveSetting("agyRecovery", { sessionId: this.session.sessionId, state: "resume-required", reason: exit.stderr.slice(-1000) || why });
        this.briefing = !this.session.started;
      } else this.newSession();
      this.store.saveHead(this.session);
      if (lostToNetwork) {
        const shown = this.outage !== null;
        this.recordOutage({ subagents: cutOff, lostSession });
        if (!shown) {
          this.add({ id: newId(), role: "error", text: lostText(connectionErrorLine(exit.stderr)), date: toSwiftDate() });
          this.bumpUnread();
        }
      } else if (exit.code !== 0 && !failedTurn) {
        const stderr = exit.stderr.trim();
        this.add({ id: newId(), role: "error", text: stderr ? stderr.slice(-2_000) : `${this.engine === "agy" ? "Antigravity ACP" : this.engine === "codex" ? "codex" : "claude"} exited unexpectedly (${why})`, date: toSwiftDate() });
        this.bumpUnread();
      }
    }
    this.updated();
  }

  // ------------------------------------------------------------------------------------------
  // The network (1.x's NetworkResume: `recordOutage`, `noteSubagentEnd`, `networkRestored`)

  /** A subagent's call returned or it ended with claude's connection error: then it waits for the network like the bot. */
  private noteSubagentEnd(id: string, text: string) {
    const subagent = this.subagents.get(id);
    if (!subagent || subagent.status === "running" || !(this.cutOffByNetwork.has(id) || isConnectionError(text))) return;
    this.cutOffByNetwork.delete(id);
    this.recordOutage({ subagents: [id] });
  }

  private recordOutage(opts: { turnFailed?: boolean; subagents?: string[]; lostSession?: string | null }) { this.progress.recordOutage(opts); }
  networkRestored(now = Date.now()) { this.progress.networkRestored(now); }
  private retryApiLater(turn: Turn): boolean { return this.progress.retryApiLater(turn); }
  clearApiRetry() { this.progress.clearApiRetry(); }

  // ------------------------------------------------------------------------------------------
  // Background work (1.x's BackgroundTask: a chip in the reply, and what a wake is told was cut off)

  private refreshScheduleDue() { this.tasks.refreshScheduleDue(); }
  private settleSessionSchedules() { this.tasks.settleSessionSchedules(); }
  private addBackgroundTask(id: string, kind: BackgroundKind, title: string) { (this.tasks ?? new BotTasks(this)).addBackgroundTask(id, kind, title); }
  private cancelScheduled(cancellation: ScheduleCancellation, turn: Turn | null) { this.tasks.cancelScheduled(cancellation, turn); }
  private findTask(id: string): BackgroundTask | undefined { return this.tasks.findTask(id); }
  private touchTask(id: string) { this.tasks.touchTask(id); }
  private addSubagentTask(ownerId: string, id: string, kind: BackgroundKind, title: string, detail: string) { this.tasks.addSubagentTask(ownerId, id, kind, title, detail); }
  private placeSubagentTask(ownerId: string, task: BackgroundTask) { this.tasks.placeSubagentTask(ownerId, task); }
  private endSubagentTasks(ownerId: string) { this.tasks.endSubagentTasks(ownerId); }
  private endBackground(id: string, status: string, summary: string | null) { this.tasks.endBackground(id, status, summary); }
  private keepTasks(turn: Turn, record: ChatRecord | null) { this.tasks.keepTasks(turn, record); }
  private stopTasks() { this.tasks.stopTasks(); }
  private get backgroundWorkRunning(): boolean { return this.tasks.backgroundWorkRunning; }

  get ownRecords(): ChatRecord[] { return this.recordsBook.ownRecords; }

  get ownWorkRunning(): boolean { return this.tasks.ownWorkRunning; }
  get inHeadSubagents(): SubagentRecord[] { return this.tasks.inHeadSubagents; }

  /** Words for the work that holds a model/effort restart back (the queue card). */
  private ownWorkWords(): string {
    const parts: string[] = [];
    const subagents = this.inHeadSubagents.length;
    if (subagents) parts.push(`${subagents} ${this.engine === "claude" ? "subagent" : "worker"}${subagents === 1 ? "" : "s"}`);
    else if (this.managedPending) parts.push("its workers");
    if (this.backgroundWorkRunning) parts.push("background tasks");
    if (this.outage) parts.push("the network to come back");
    return parts.join(", ") || "its work";
  }

  /** `turn` (your message) waits for this head's own work to finish before its model/effort restart; a card says so. */
  holdForSettings(turn: Turn) {
    this.queue.unshift(turn);
    if (!this.settingsHold) {
      const id = newId();
      const settings = this.restartReason?.shown ?? "the new model or effort";
      const what = this.modelSettingsPending ? "Model or effort change" : "Moving to its new working folder";
      const after = this.modelSettingsPending ? `on ${settings}` : "there";
      this.owner.add({ id, role: "notice", text: `${what} is waiting for active work to finish (${displayName(this.engine)}: ${this.ownWorkWords()}). ${turn.origin === "user" ? "Your message is" : "Its next message is"} queued and is sent ${after} as soon as that work finishes.`, date: toSwiftDate() });
      // Work whose end the app hears of without an event (a background task too old to hold the bot) is seen here.
      const timer = setInterval(() => this.checkSettingsHold(), 15_000);
      timer.unref?.();
      this.settingsHold = { noticeId: id, timer };
      this.log(`your message waits for its own work to finish before restarting for ${settings}`);
    }
    this.updated();
  }

  /**
   * Whether `turn` waits for this head's own work before the restart it owes. Yours always; after a move every turn but
   * the tidy (a routine, a worker's report, a follow-up, the resume note): none may go to the process in the old folder.
   */
  waitsForRestart(turn: Turn): boolean {
    return turn.origin === "user" || (this.folderPending && turn.origin !== "tidy");
  }

  /** Lets the held message go once this head's own work is done (or nothing waits any more). True: let go. */
  private releaseSettingsHold(): boolean {
    const hold = this.settingsHold;
    if (!hold) return true;
    const waiting = this.queue.some((turn) => turn.open && this.waitsForRestart(turn));
    if (waiting && (this.modelSettingsPending || this.folderPending) && this.head?.running && this.ownWorkRunning) return false;
    clearInterval(hold.timer);
    this.settingsHold = null;
    const card = this.owner.records.find((record) => record.id === hold.noticeId);
    if (card) this.owner.remove(card);
    if (waiting) this.log("its own work finished: your queued message goes now");
    return true;
  }

  /** Something that may have ended this head's own work happened: a held message may go now. */
  checkSettingsHold() {
    if (!this.settingsHold || !this.releaseSettingsHold()) return;
    if (!this.turn && !this.tidying && !this.switching) this.next();
  }

  takeInterruptedNote(): string { return this.recordsBook.takeInterruptedNote(); }

  // ------------------------------------------------------------------------------------------
  // Quiet runs (1.x's `checkStall`, `noteProgress`)

  private noteCodexRetry(item: Extract<CodexItem, { kind: "apiRetry" }>) { this.progress.noteCodexRetry(item); }
  private clearCodexRetry() { this.progress.clearCodexRetry(); }
  noteProgress() { this.progress.noteProgress(); }
  private noteProgressOf(item: CodexItem) { this.progress.noteProgressOf(item); }
  checkStall(now: number, intervalMs: number): string[] { return this.progress.checkStall(now, intervalMs); }
  private outageBlocksStall(): boolean { return this.progress.outageBlocksStall(); }

  // ------------------------------------------------------------------------------------------
  // Sleeping

  scheduleIdle() {
    this.clearIdle();
    if (!this.head?.running || this.turn || this.queue.length || this.approvals.size || this.tidying || this.shuttingDown || this.managedPending) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.sleep();
    }, this.options.idleMs);
  }

  clearIdle() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  /** `Bot.sleep(tidy: true)`: memory.md is tidied, then the head ends. Nothing under way is cut off. */
  async sleep({ tidyMs = this.options.tidyTimeoutMs ?? 5 * 60_000 } = {}): Promise<void> {
    const head = this.head;
    if (!head?.running || this.turn || this.queue.length || this.approvals.size || this.tidying) return;
    // A subagent (or a Codex worker) at work in the background would end with the process: wait for it.
    // So would a command or Monitor it left running in the background (1.x's `hasBackgroundWorkRunning`).
    // Cut off by the network, it keeps its session for when the network is back.
    if ((this.inHeadSubagents.length || this.managedPending || this.backgroundWorkRunning || this.outage || this.steered.size) && !this.shuttingDown) { this.scheduleIdle(); return; }
    this.clearIdle();
    this.tidying = true;
    this.updated();
    this.log("idle: tidying its notes, then going to sleep");
    if (tidyMs > 0) {
      const reply = await this.maintenance(this.prompts().tidy, tidyMs, head);
      if (reply !== null && !isPlainOK(reply)) this.log(`its tidy reply was not a plain OK: ${reply.slice(0, 200)}`);
    }
    if (this.head === head && head.running) {
      head.finish();
      const exited = await Promise.race([head.exited.then(() => true), sleep(5_000).then(() => false)]);
      if (!exited) await head.terminate(1_000);
    }
    this.tidying = false;
    this.updated();
    // What the user said meanwhile wakes it again, in a new session.
    if (!this.shuttingDown) this.next();
  }

  /**
   * An app turn nobody sees that updates memory.md (the tidy, a handoff): its reply, or null when it did
   * not end in time. Codex hands the update to a worker and ends its turn: it is done when the worker's
   * report turn answers (1.x keeps its `internalReply` open while work is pending).
   */
  async maintenance(text: string, timeoutMs: number, head: AgentHead): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    const wasTidying = this.tidying;
    this.tidying = true;
    try {
      let reply = await this.internal(text, timeoutMs);
      while (this.engine === "codex" && reply !== null && this.head === head && head.running && (this.managedPending || this.turn) && Date.now() < deadline) {
        reply = await new Promise<string | null>((resolve) => {
          const timer = Number.isFinite(deadline) ? setTimeout(() => { this.tidyFollowUp = null; resolve(null); }, Math.max(0, deadline - Date.now())) : undefined;
          this.tidyFollowUp = (text) => { clearTimeout(timer); this.tidyFollowUp = null; resolve(text); };
        });
      }
      return reply;
    } finally {
      this.tidying = wasTidying;
    }
  }

  /** An app turn nobody sees (the tidy): its reply, or null when it did not end in time. */
  private internal(text: string, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const turn = this.newTurn("tidy", text, null);
      let settled = false;
      const settle = (value: string | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      // No limit (quitting, as in 1.x): it takes as long as it takes.
      const timer = Number.isFinite(timeoutMs) ? setTimeout(() => {
        this.log("the tidy did not end in time");
        if (turn.open) {
          turn.open = false;
          if (this.turn === turn) this.turn = null;
          turn.resolve("stopped");
          // Its result, if it comes, belongs to nobody.
          if (turn.sent && turn.head?.running) { this.ignoreResults += 1; turn.head.interrupt(); }
        }
        settle(null);
      }, timeoutMs) : undefined;
      turn.onReply = (reply) => settle(reply);
      void turn.done.then(() => settle(""));
      this.begin(turn, this.head ?? undefined);
    });
  }

  // ------------------------------------------------------------------------------------------
  // Routines (Routines.swift, ScheduledRoutines.swift; the clock is the core's, `Core.checkRoutines`)

  private setUpRoutines() { this.routines.setUpRoutines(); }
  private routinesSpec() { return this.routines.routinesSpec(); }
  get routineStorePath(): string | null { return this.routines.routineStorePath; }
  get scheduledStore(): ScheduledRoutineStore | null { return this.routines.scheduledStore; }
  private loadRoutines(): { jobs: Routine[]; scheduled: ScheduledRoutine[] } { return this.routines.loadRoutines(); }
  routinesView(now?: number): ResultOf<"routines.list"> { return this.routines.routinesView(now); }
  private watchView(key: string, task: string): Pick<RoutineView, "watch"> { return this.routines.watchView(key, task); }
  routinesChanged(view?: ResultOf<"routines.list">) { this.routines.routinesChanged(view); }
  changeRoutine(args: Record<string, unknown>): ResultOf<"routines.change"> { return this.routines.changeRoutine(args); }
  routinesEdited() { this.routines.routinesEdited(); }
  routinesTool(args: Record<string, unknown>): Record<string, unknown> { return this.routines.routinesTool(args); }
  private isDue(job: Routine, now: number): boolean { return this.routines.isDue(job, now); }
  private saveRoutineRuns() { this.routines.saveRoutineRuns(); }
  checkRoutines(now?: number) { this.routines.checkRoutines(now); }
  private runRoutine(key: string, job: Routine, now: number) { this.routines.runRoutine(key, job, now); }
  private startWatch(key: string, job: Routine, command: string) { this.routines.startWatch(key, job, command); }
  private forgetWatches(jobs: Routine[], scheduled: ScheduledRoutine[]) { this.routines.forgetWatches(jobs, scheduled); }
  private dispatchRoutine(job: Routine, now: number) { this.routines.dispatchRoutine(job, now); }

  // ------------------------------------------------------------------------------------------
  // Components and cards: moved to BotCards (M7-S43); one-line delegates keep every name

  private get context(): ComponentsContext | null { return this.cards.context; }
  get commandFolder(): string { return this.cards.commandFolder; }
  private giveFirstComponents() { this.cards.giveFirstComponents(); }
  private drewComponents(names: string[]) { this.cards.drewComponents(names); }
  private ownComponents(): string[] { return this.cards.ownComponents(); }
  componentNote(): string { return this.cards.componentNote(); }
  componentsChanged() { this.cards.componentsChanged(); }
  componentNotes(user: ChatRecord): string[] { return this.cards.componentNotes(user); }
  previews(record: ChatRecord): string[] | null { return this.cards.previews(record); }
  displayViews(record: ChatRecord): DisplayData[] | undefined { return this.cards.displayViews(record); }
  updateCards(reply: ChatRecord): boolean { return this.cards.updateCards(reply); }
  cardChanged(card: string) { this.cards.cardChanged(card); }
  componentSave(messageId: string, index: number, data: string): ResultOf<"component.save"> { return this.cards.componentSave(messageId, index, data); }
  componentCommand(messageId: string, index: number, shown: Parameters<BotCards["componentCommand"]>[2]): ResultOf<"component.command"> { return this.cards.componentCommand(messageId, index, shown); }
  componentApprove(messageId: string, index: number, shown: Parameters<BotCards["componentApprove"]>[2]): ResultOf<"component.approve"> { return this.cards.componentApprove(messageId, index, shown); }
  componentDetail(name: string, folder: string, rawValues: unknown, card?: string, command?: string): Promise<ResultOf<"component.detail">> { return this.cards.componentDetail(name, folder, rawValues, card, command); }
  commandApproval(command: string): ReturnType<BotCards["commandApproval"]> { return this.cards.commandApproval(command); }
  approveCommand(command: string): boolean { return this.cards.approveCommand(command); }
  pluginCommand(key: string, command: string, run: false | { minIntervalMs: number }): ReturnType<BotCards["pluginCommand"]> { return this.cards.pluginCommand(key, command, run); }
  libraryEntry(name: string, data: string | undefined, command: string | undefined): ReturnType<BotCards["libraryEntry"]> { return this.cards.libraryEntry(name, data, command); }
  imageUrls(data: string): Record<string, string> | null { return this.cards.imageUrls(data); }
  static pluginCard(card: string): boolean { return BotCards.pluginCard(card); }
  cardLibrary(): ReturnType<BotCards["cardLibrary"]> { return this.cards.cardLibrary(); }
  cardsShown(): ReturnType<BotCards["cardsShown"]> { return this.cards.cardsShown(); }
  cardStates(cards: Parameters<BotCards["cardStates"]>[0]): ReturnType<BotCards["cardStates"]> { return this.cards.cardStates(cards); }
  cardRun(card: string, command: string, force: boolean): boolean { return this.cards.cardRun(card, command, force); }
  cardAskFor(card: string, command: string, name: string): ApprovalAskView | null { return this.cards.cardAskFor(card, command, name); }
  cardApproveFor(command: string, name: string, folder: string, shownDetail: string | null): boolean { return this.cards.cardApproveFor(command, name, folder, shownDetail); }
  setCardNotes(notes: { date: number; line: string }[]): void { this.cards.setCardNotes(notes); }
  legacyPins(): unknown[] | null { return this.cards.legacyPins(); }
  noteComponents(): ReturnType<BotCards["noteComponents"]> { return this.cards.noteComponents(); }
  noteCardStates(cards: Parameters<BotCards["noteCardStates"]>[0]): ReturnType<BotCards["noteCardStates"]> { return this.cards.noteCardStates(cards); }
  noteCardRun(key: string, command: string, force: boolean): ReturnType<BotCards["noteCardRun"]> { return this.cards.noteCardRun(key, command, force); }

  // ------------------------------------------------------------------------------------------
  // Approvals and blocked calls (BotQuestions, M7-S44)

  private ask(head: AgentHead, item: Extract<StreamItem, { kind: "permission" }>, turn: Turn | null) { return this.questions.ask(head, item, turn); }
  private showReviewRefusal(head: AgentHead, item: Extract<StreamItem, { kind: "permission" }>) { return this.questions.showReviewRefusal(head, item); }
  private tellReviewOutcome(approval: Approval, allowed: boolean, words?: string) { return this.questions.tellReviewOutcome(approval, allowed, words); }
  private noteToolCall(item: Extract<StreamItem, { kind: "toolUse" }>) { return this.questions.noteToolCall(item); }
  private get allowRules(): string[] { return this.questions.allowRules; }
  private showDenial(denial: Extract<StreamItem, { kind: "permissionDenied" }>) { return this.questions.showDenial(denial); }
  private decideDenial(record: ChatRecord, index: number): boolean { return this.questions.decideDenial(record, index); }
  /** Something only the app says, to this head: wakes it like a message (`Bot.appMessage`). */
  tellHead(text: string) {
    this.owner.deliverTo(this.engine, text, null, { origin: "app" });
  }

  /** The coordinator turn ended/stopped; a monitor or managed worker may still be waiting. */
  private settleTurnApprovals() { this.questions.settleTurnApprovals(); }
  private expire(id: string) { this.questions.expire(id); }
  private settle(id: string, answer: string, deny: boolean) { this.questions.settle(id, answer, deny); }
  /** A button on a question: an approval's action, or a bot's own question answered with the pick's label (`Bot.choose`). */
  choose(messageId: string, index: number, notes?: string): ResultOf<"chat.choose"> { return this.questions.choose(messageId, index, notes); }
  /** `Bot.answer`: the user answered a question in their own words instead of a button. */
  answer(messageId: string, text: string, files: string[] = [], picks?: QuestionPick[]): ResultOf<"chat.answer"> { return this.questions.answer(messageId, text, files, picks); }
  private answerQuestions(messageId: string, picks: QuestionPick[], files: string[]): ResultOf<"chat.answer"> { return this.questions.answerQuestions(messageId, picks, files); }

  react(messageId: string, emoji: string, present: boolean): ResultOf<"chat.react"> { return this.recordsBook.react(messageId, emoji, present); }
  setReaction(messageId: string, emoji: string, present: boolean, actor: string): boolean { return this.recordsBook.setReaction(messageId, emoji, present, actor); }
  private applyReactions(actions: { messageId: string; emoji: string; present: boolean }[]) { return this.recordsBook.applyReactions(actions); }
  read(): ResultOf<"chat.read"> { return this.recordsBook.read(); }

  // ------------------------------------------------------------------------------------------
  // Core hot swap (hot-swap.ts): this bot and its partner head as one.

  holdForSwap(hold: boolean) {
    this.swapHold = hold;
    for (const peer of this.peers) peer.holdForSwap(hold);
    // Let go again (the swap was called off): what waited begins now.
    if (!hold) { this.next(); for (const peer of this.peers) peer.next(); }
  }

  get swapBusy(): boolean {
    const own = !!this.turn || this.tidying || this.switching || this.guestTurn || !!this.deferred || !!this.claimHold || !!this.paused
      || this.subagents.running.length > 0 || this.managedPending;
    return own || this.peers.some(peer => peer.swapBusy);
  }

  get swapToolInFlight(): boolean {
    const own = !!this.turn?.steps.some((step) => step.kind === "tool" && !step.done);
    return own || this.peers.some(peer => peer.swapToolInFlight);
  }

  /** Stops what is under way for a swap; the session goes on (the new core resumes it). */
  async swapInterrupt(): Promise<void> {
    this.paused = null;
    const stops: Promise<unknown>[] = [];
    for (const bot of this.members) {
      if (bot.turn && bot.turn.origin !== "tidy") stops.push(bot.stop(bot.turn.id));
      if (bot.deferred) stops.push(bot.stop(bot.deferred.id));
    }
    await Promise.all(stops);
  }

  /** Its heads' sessions and the turns that wait, for the new core. */
  swapEntries(cutOff: boolean): SwapEntry[] {
    const entries: SwapEntry[] = [];
    for (const bot of this.members) {
      const queued = bot.queue.filter((turn) => turn.open && turn.origin !== "tidy").map((turn) => ({ words: turn.words, userId: turn.userId, origin: turn.origin }));
      const sessionId = bot.session.started ? bot.session.sessionId : null;
      if (!sessionId && !queued.length) continue;
      // Only a head that was at work is told to carry on.
      entries.push({ botId: this.owner.id, engine: bot.engine, sessionId, continue: cutOff && !!sessionId && (bot.engine === this.engine || !!bot.head?.running), queued });
    }
    return entries;
  }

  async flushForSwap() {
    this.persist();
    for (const peer of this.peers) peer.persist();
    const saved = await Promise.allSettled(this.members.map(async bot => {
      try { bot.flushSubagents(); if (!bot.readOnly) bot.store.flushSubagents(); }
      catch (error) { bot.log(`subagents save failed during core swap: ${String(error)}`); throw error; }
      finally { if (bot.session.started) bot.store.saveHead(bot.session); }
    }));
    const failed = saved.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  /** Capture before shutdown cancels transports; never treat a pending approval as consent. */
  restartEntries(): RestartEntry[] {
    // The three-engine integration exposes all peers; older cores expose only partner.
    const peers = (this as Bot & { readonly peers?: Bot[] }).peers;
    return [this, ...(peers ?? (this.partner ? [this.partner] : []))].flatMap(bot => {
      const turn = bot.turn;
      const workers = bot.head instanceof CodexHead ? bot.head.restartWorkers : undefined;
      const nativeChildren=bot.engine==="claude"?bot.subagents.running.filter(child=>!ownProcessWorker(child.type)).map(child=>({id:child.id,agentId:child.agentID,parentId:child.parentID?(bot.subagents.get(child.parentID)?.id??child.parentID):undefined,
        checkpoint:child.steps.findLast(step=>step.kind==="tool"&&step.done&&!step.failed)?.id,
        prompt:child.prompt,description:child.description,type:child.type})):undefined;
      // Own-process Claude workers end as interrupted by the restart (their ledger says so); the coordinator is told their ids then.
      const claudeWorkers=bot.engine==="claude"?bot.subagents.running.filter(child=>ownProcessWorker(child.type)).map(child=>child.id):undefined;
      const nativeConfig=bot.head instanceof ClaudeHead?bot.head.config:undefined;
      const active = !!turn?.open && turn.origin !== "tidy";
      const queued=bot.queue.filter(t=>t.open&&!t.sent&&t.origin!=="tidy").map(t=>({words:t.words,userId:t.userId,origin:t.origin,turnId:t.id,messageId:t.messageId,handoffId:t.handoffId,conducted:t.conducted}));
      if (!active && !queued.length && !bot.managedPending && !bot.subagents.running.length) return [];
      const blocked = bot.readOnly ? "The conversation store is read-only."
        : bot.approvals.size ? "A permission decision was pending. Review the original request before continuing."
        : bot.engine === "agy" && bot.managedPending ? "Antigravity worker execution reconciliation is not supported; original worker identities are retained."
        : bot.head instanceof CodexHead && bot.head.restartBlocker ? bot.head.restartBlocker
        : active && bot.head instanceof CodexHead && !bot.head.restartTurn ? "Coordinator turn delivery is unconfirmed; reconcile the original thread."
        : workers?.some(w=>w.reportDispatching) ? "Worker report delivery is uncertain. Inspect the original coordinator conversation before any retry."
        : active && turn && !turn.reply.text && !turn.steps.length ? "Prompt delivery has no confirmed response yet; reconcile the original conversation before retrying."
        : bot.turn?.steps.some(step=>step.kind==="tool"&&!step.done) ? "A tool call had no confirmed result. Reconcile its outcome before continuing."
        : bot.deferred || bot.paused || bot.claimHold ? "Paused or deferred work needs explicit reconciliation."
        : nativeChildren?.some(child=>!child.agentId) ? "Native child lacks an observed agent ID. Original assignment remains in subagent history; no replacement was started."
        : bot.subagents.running.some(child=>!ownProcessWorker(child.type)) && !workers?.length && !nativeChildren?.length ? "This child transport has no safe restart contract."
        : workers?.some(w => w.wasActive && (!w.restartSafe || !w.thread)) ? "A worker has pending approval, tool execution, or unconfirmed delivery. Reconcile the original task."
        : active && !bot.session.started ? "Provider session creation was not confirmed." : undefined;
      // Its workers are not written here: the member's ledger keeps what each needs to go on (`restartedAt` finds them).
      return [{botId:this.owner.id,engine:bot.engine,sessionId:bot.session.sessionId,sessionStarted:bot.session.started,
        continue:active||!!nativeChildren?.length||!!claudeWorkers?.length,queued,nativeChildren,nativeCwd:nativeConfig?.cwd,nativeConfigDir:nativeConfig?claudeConfigFolder({...process.env,...nativeConfig.env}):undefined,turnId:turn?.id,messageId:turn?.messageId,userId:turn?.userId,handoffId:turn?.handoffId,
        blocked,restartedAt:Date.now(),providerTurnId:bot.head instanceof CodexHead ? bot.head.restartTurn : undefined}];
    });
  }

  retainRestartIdentity(entry: RestartEntry): Bot {
    const bot=this.botFor(entry.engine);
    if(!bot || !entry.sessionId)throw Error("Original engine/session unavailable; no replacement was created.");
    bot.session={sessionId:entry.sessionId,started:entry.sessionStarted!==false,...bot.savedPromptHash(entry.sessionId)};bot.briefing=entry.sessionStarted===false;
    bot.adoptedSession=!!entry.continue||!!entry.workers?.length||bot.restartedWorkers(entry).length>0;
    bot.store.saveHead(bot.session);
    bot.restartRecovery=true;
    return bot;
  }

  /** Its workers this restart interrupted, as its ledger says (an entry from before the ledger names them itself). */
  private restartedWorkers(entry: RestartEntry): WorkerLedgerRecord[] {
    if (entry.restartedAt === undefined) return [];
    return [...this.workerViews.values()].filter((r) => r.status === "interrupted" && r.interruptedBy === "restart" && (r.endedAt ?? 0) >= entry.restartedAt!);
  }

  /**
   * An entry the restart did not continue (`reason`): said in this chat, with the messages that waited behind it. They never
   * reached the provider, so sending them cannot repeat anything: the notice offers to send them now as they were (your own
   * lines shown as you wrote them), so your words are never left behind with only a note (2026-11-09).
   */
  restartPaused(entry: RestartEntry, reason: string): string {
    const waiting = (entry.queued ?? []).filter((saved) => ["user", "app", "background"].includes(saved.origin));
    const own = (userId: string) => this.owner.records.find((record) => record.id === userId && record.role === "user")?.text ?? null;
    const offered = waiting.length > 0 && !this.owner.readOnly && !!this.botFor(entry.engine);
    const text = restartPausedNotice(entry, reason, own, offered);
    if (!offered) return this.appNotice(text);
    let sent = false;
    return this.appNotice(text, [{ label: RESEND_WAITING, recommended: true }], (index) => {
      if (index !== 0 || sent) return;
      sent = true;
      const bot = this.botFor(entry.engine);
      if (!bot) return;
      // As a continued restart sends them (`adoptRestart`): in their order, each a turn of its own, after any under way.
      for (const saved of waiting) {
        const userId = saved.userId && this.owner.records.some((record) => record.id === saved.userId) ? saved.userId : null;
        const turn = bot.newTurn(userId ? saved.origin as Origin : saved.origin === "user" ? "app" : saved.origin as Origin, saved.words, userId);
        turn.id = saved.turnId; turn.messageId = saved.messageId; turn.handoffId = saved.handoffId; turn.conducted = saved.conducted;
        bot.queue.push(turn);
      }
      if (!bot.turn) bot.next();
      this.log(`restart ${entry.botId}: the ${waiting.length} message(s) that waited were sent at the user's pick`);
    });
  }

  adoptRestart(entry: RestartEntry) {
    const bot=this.retainRestartIdentity(entry);
    const restarted=bot.restartedWorkers(entry);
    bot.restartWorkerRecords=entry.workers;
    bot.restartWorkersSince=entry.restartedAt;
    bot.restartProviderTurn=entry.providerTurnId;
    // The coordinator's own app workers (own processes) are told; a Codex head's workers the app reconciles itself.
    const ownWorkers=[...(entry.claudeWorkers ?? []), ...restarted.filter(r=>r.adapter==="claude-process").map(r=>r.id)];
    const reconciled=[...(entry.workers ?? []).map(w=>w.id), ...restarted.filter(r=>r.adapter!=="claude-process").map(r=>r.id)];
    const nativeContext=entry.nativeChildren?.length?nativeRestartContext(entry.nativeChildren,{cwd:entry.nativeCwd??bot.commandFolder,configDir:entry.nativeConfigDir,sessionId:entry.sessionId!}):"";
    if(entry.continue){
      const turn=bot.newTurn(entry.userId ? "user" : "app",RESTART_NOTE+nativeContext+(reconciled.length ? "\nExisting worker task IDs (the app reconciles these; do not create replacements): "+reconciled.join(", ") : "")
        +(ownWorkers.length ? "\nApp worker task IDs interrupted by the restart (nothing was replayed; continue any that are still needed with app_send_message to the same task_id, do not create replacements): "+ownWorkers.join(", ") : ""),entry.userId??null);
      turn.handoffId=entry.handoffId??null;
      // Keep task correlation, but use a new transport turn: the prior turn is visibly interrupted.
      turn.retried=true; // A failed resume must never fall back to a fresh session/replay.
      bot.queue.push(turn);
    }
    for(const saved of entry.queued){
      if(!["user","app","background"].includes(saved.origin))throw Error("Queued work origin requires reconciliation.");
      const turn=bot.newTurn(saved.origin as Origin,saved.words,saved.userId);
      turn.id=saved.turnId;turn.messageId=saved.messageId;turn.handoffId=saved.handoffId;turn.conducted=saved.conducted;turn.retried=true;
      bot.queue.push(turn);
    }
    if(bot.queue.length)bot.next();
    // A Codex head's workers live in it: it starts to check and resume them (and hand over reports they still owe).
    else if(entry.workers?.some(w=>w.wasActive||w.reportPending)||(bot.engine!=="claude"&&restarted.length))bot.ensureHead();
  }

  private restartRecovery = false;
  private restartProviderTurn?: string;
  private restartWorkerRecords?: import('./agent/codex').WorkerRecord[];
  /** The restart's time: its next Codex head checks and resumes the workers its ledger says that restart interrupted. */
  private restartWorkersSince?: number;

  /** At the new core's start: go on in the sessions the old core handed over (`--resume`), then what waited. */
  adoptSwap(entries: SwapEntry[]) {
    for (const entry of entries) {
      const bot = this.botFor(entry.engine);
      if (!bot) continue;
      if (entry.sessionId) {
        bot.session = { sessionId: entry.sessionId, started: true, ...bot.savedPromptHash(entry.sessionId) };
        bot.adoptedSession = !!entry.continue;
        // The same conversation: no wake briefing (what was cut off in the background is said with its next message).
        bot.briefing = false;
        bot.store.saveHead(bot.session);
        const cut = bot.takeInterruptedNote();
        if (cut) bot.queuedNote = cut;
        this.log(`core swap: ${entry.engine} resumes session ${entry.sessionId}${entry.continue ? " and carries on" : ""}`);
      }
      if (entry.continue && entry.sessionId) this.deliverTo(entry.engine, CONTINUE_NOTE, null, { origin: "app" });
      for (const turn of entry.queued) {
        const origin = (["user", "app", "background"] as string[]).includes(turn.origin) ? turn.origin as Origin : "app";
        const userId = turn.userId && this.owner.records.some((record) => record.id === turn.userId) ? turn.userId : null;
        this.deliverTo(entry.engine, turn.words, userId, { origin: userId ? origin : origin === "user" ? "app" : origin });
      }
    }
  }

  /** Ends the turn and the head (with its tree) and writes everything out; for quitting. An idle awake bot tidies first (1.x). */
  async shutdown({ tidy = true }: { tidy?: boolean } = {}) {
    // 1.x waits for each awake bot's tidy at quit with no time limit (`putEveryoneToSleep`).
    const tidyMs = tidy ? this.options.quitTidyMs ?? Number.POSITIVE_INFINITY : 0;
    if (this.claimHold) { clearTimeout(this.claimHold.timer); this.claimHold.turn.resolve("stopped"); this.claimHold = null; }
    const partner = Promise.allSettled(this.peers.map(peer => peer.shutdown({ tidy }))).then(results => results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason);
    this.clearIdle();
    this.clearApiRetry();
    this.shuttingDown = true;
    // Messages still waiting never reached claude.
    for (const waiting of this.queue.splice(0)) { waiting.open = false; waiting.resolve("stopped"); }
    const held = this.settingsHold;
    if (held) {
      clearInterval(held.timer);
      this.settingsHold = null;
      const card = this.owner.records.find((record) => record.id === held.noticeId);
      if (card) { card.text = "Model or effort change was waiting for active work to finish; the app quit first, so the queued message was not sent."; this.owner.changed(card); }
    }
    if (this.deferred) { this.deferred.open = false; this.deferred.resolve("stopped"); this.deferred = null; }
    // A running turn's tree is ended at once (what it said so far stays); such a head does not tidy.
    const working = this.shownTurn;
    if (working) await this.stop(working.id, { quitting: true }).catch(() => {});
    for (const id of [...this.approvals.keys()]) this.settle(id, NO_LONGER_NEEDED, false);
    if (!working && this.head?.running && !this.turn && !this.tidying && tidyMs > 0) await this.sleep({ tidyMs });
    if (this.head?.running) {
      const last = this.head;
      // A polite end first (claude writes its session); then the tree.
      last.finish();
      const ended = await Promise.race([last.exited.then(() => true), sleep(1_000).then(() => false)]);
      if (!ended) await last.terminate(1_000);
    }
    // Its Claude workers end with the app: one at work is interrupted, to be resumed later (claude-workers.ts).
    await this.claudeWorkerHost?.close().catch((error) => this.log(`claude workers: close failed: ${(error as Error).message}`));
    const partnerError = await partner;
    let historyError: unknown;
    try { this.flushSubagents(); if (!this.readOnly) this.store.flushSubagents(); }
    catch (error) { historyError = error; this.log(`subagents save failed during shutdown: ${String(error)}`); }
    this.persist();
    if (historyError) throw historyError;
    if (partnerError) throw partnerError;
  }
}

