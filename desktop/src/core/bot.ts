import { readImagePaths } from "./read-images";
import { isBotTool, type BotToolName, type ToolCaller } from "./bot-tools";
import {nativeRestartContext} from './claude-restart';
import {claudeConfigFolder} from './claude-files';
import { RESEND_WAITING, RESTART_NOTE, restartPausedNotice, type RestartEntry } from './restart-continuation';
import { monitorTask, type CommandMonitor } from "./agent/monitors";
import { AgyAcpHead } from "./agent/agy-acp";
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
import type { ApprovalAnswerer, HostFacts, StartupHost, WorkerApproval } from "./agent-registry";
import { ContractError, type ApprovalAskView, type RoutineView, type BotView, type SubagentRowView, type ChatSnapshot, type Event, type HeadsView, type MessageView, type ResultOf, type BotSettingsView, type ResultView } from "../contract";
import type { EngineEfforts } from "./engine-defaults";
import { ClaudeHead, type HeadExit } from "./agent/head";
import type { HotSettings } from "./agent/hot-settings";
import { CodexHead, type CodexItem } from "./agent/codex";
import { Conductor, displayName, fitted, hasTwo, isActive, otherHead, parseHeadTags, readHeads, resolvePrimary, roundsText, type AnswerTarget, type CardPick, type ConductorAction, type Engine, type Handoff, type Heads, type RoundsProgress } from "./heads";
import { scheduleCall, scheduledTask, scheduleCancellation, isScheduled, holdsScheduleAwake, type ScheduleCall, type ScheduleCancellation } from "./session-schedules";
import type { RequestEvent, SpeedTotals } from "./token-speed";
import { commandEnded, ReplyText, type CommandState, type StreamItem } from "./agent/stream";
import { archiveAll, archiveLine, reactionIntro, reactionUpdate, recentChat, reportNote, seenReactions, type SeenReactions } from "./briefing";
import { isPlainOK, PARTS_NOTE, PAUSE_NOTE, RESUME_NOTE, withoutPartsNote, type BotPrompts } from "./prompts";
import { parseReply, unsupportedRequest, type BotRequest, Display } from "./reply";
import { SubagentBook, readSubagent, SUBAGENT_TOOLS, type SubagentRecord } from "./subagents";
import type { SubagentHistory } from "./store/subagent-store";
import type { ComponentsContext, DisplayData } from "./components/service";
import { BUILT_INS, spelledSize, type ComponentKnowledge } from "./components/library";
import { savedQuestions, type QuestionPick } from "./questions";
import { headTurnContent, headTurnEnd } from "./head-turn";
import { costDelta, hasVisibleContent, type WorkerCoreFactory, type WorkerLedgerRecord, type WorkerNote } from "./worker-core";
import { projectWorker } from "./worker-projection";
import type { Routine, ScheduledRoutine, ScheduledRoutineStore } from "./routines";
import { BotRoutines } from "./bot/bot-routines";
import { CallInWorkBook, type CallInRelay } from "./call-in-work";
import { PAGE_COMPONENT } from "./page-preview";
import { totalTokens } from "./usage";
import { BotStore, type HeadState } from "./store/bot-store";
import { connectionErrorLine, lostText, mentionsConnectionError, type Outage } from "./network-resume";
import { apiGaveUpText, apiRetryDelays } from "./api-retry";
import { CONTINUE_NOTE, type SwapEntry } from "./hot-swap";
import { stopBackgroundTasks, type BackgroundKind, type BackgroundTask } from "./background-tasks";
import { fromSwiftDate as fromSwiftDateMs, isOpenQuestion, newId, toSwiftDate, type ChatRecord, type StepRecord } from "./store/records";
import { isWorkerType, ownProcessWorker, type WorkerHost, type WorkerOwner, type WorkerOwnerResult, type WorkerSendResult } from "./agent/workers";
import { CLAUDE_AGENT_GUARD, CLAUDE_APP_SERVER, CLAUDE_APP_TOOLS, CLAUDE_ROUTINE_TOOLS, ClaudeWorkers, claudeWorkersFile } from "./agent/claude-workers";
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
import { sameJSON } from "./same-json";
import { parseFeedback } from "./feedback";
import { detailValues, type CommandStatus } from "./components/commands";
import { fromRoutineWatches, nextWatchState, runWatch, watchCommand, watchPrompt, type WatchState } from "./routine-watch";
import { specTrace } from "./spec-trace";
import { codexWorkerDefaults, codexWorkersJSON } from "./settings";
import { alwaysAllows } from "./permission-rules";
import { MAX_PAGE_BYTES, PAGE_BYTES, pageBack, sliceViews } from "./history-page";
import { BotWorkers } from "./bot/workers";
import { isBrowserTool } from "../browser-bot";
import { runBrowserTool } from "./browser-tools";
import { isNoteTool, runNoteTool } from "./note-tools";
import { BotRestart } from "./bot/restart";
import { BotHead } from "./bot/head";
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
  private get managedTaskHandoffs() { return this.workers.managedTaskHandoffs; }
  private get managedHandbacks() { return this.workers.managedHandbacks; }
  get specList(): StoredSpec[] { return this.recordsBook.specList; }
  set specList(value: StoredSpec[]) { this.recordsBook.specList = value; }
  /** Read by BotContext (M7-S41). */
  get records(): ChatRecord[] { return this.recordsBook.records; }
  set records(value: ChatRecord[]) { this.recordsBook.records = value; }
  /** Set when its chat file could not be read: nothing is written over it then. */
  problem: string | null = null;
  readOnly = false;
  get head(): AgentHead | null { return this.headRun.head; }
  set head(v: AgentHead | null) { this.headRun.head = v; }
  /** Which CLI this bot's head is. */
  readonly engine: Engine;
  /** Its heads (bot.json `heads`, 1.x's format). Kept by the primary; a partner reads it. */
  /** Read by BotContext (M7-S41). */
  get headsSettings(): Heads { return this.settings.headsSettings; }
  set headsSettings(v: Heads) { this.settings.headsSettings = v; }
  get startupActive(): boolean { return this.headRun.startupActive; }
  set startupActive(v: boolean) { this.headRun.startupActive = v; }
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
  get managedPending() { return this.workers.managedPending; }
  set managedPending(value: boolean) { this.workers.managedPending = value; }
  get outage(): Outage | null { return this.progress.outage; }
  get retryingConnection() { return this.progress.retryingConnection; }
  set retryingConnection(v: boolean) { this.progress.retryingConnection = v; }
  private get apiRetries() { return this.progress.apiRetries; }
  private set apiRetries(v: number) { this.progress.apiRetries = v; }
  get codexRetry() { return this.progress.codexRetry; }
  set codexRetry(v: NonNullable<BotView["codexRetry"]> | null) { this.progress.codexRetry = v; }
  /** Subagents whose last line was claude's connection error (1.x's `cutOffByNetwork`). */
  private get cutOffByNetwork() { return this.workers.cutOffByNetwork; }
  /** Tidying memory.md before it sleeps. */
  get tidying(): boolean { return this.headRun.tidying; }
  set tidying(v: boolean) { this.headRun.tidying = v; }
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
  paused: { conducted: boolean; handoffId: string | null } | null = null;
  /** Read by BotContext (M7-S41). */
  get session(): HeadState { return this.headRun.session; }
  set session(v: HeadState) { this.headRun.session = v; }
  /** The next head is a new session: its first message carries the wake briefing. */
  get briefing(): boolean { return this.headRun.briefing; }
  set briefing(v: boolean) { this.headRun.briefing = v; }
  /** Its next message starts its process again in the same session (1.x's `restart(_:)`, e.g. "may read …"). */
  get restartPending(): boolean { return this.restarts.restartPending; }
  set restartPending(v: boolean) { this.restarts.restartPending = v; }
  get modelSettingsPending(): boolean { return this.restarts.modelSettingsPending; }
  set modelSettingsPending(v: boolean) { this.restarts.modelSettingsPending = v; }
  /**
   * The restart waiting is for a new working folder (a plugin's `sessions.folder`): your message never goes to the process
   * still in the old one; while its own work runs it waits, as for a model change (spec/models/folders TurnStartsCurrent).
   */
  get folderPending(): boolean { return this.restarts.folderPending; }
  set folderPending(v: boolean) { this.restarts.folderPending = v; }
  /** The restart waiting is also for something other than its model or effort (plugins, folders, subagents' model): a hot switch cannot stand in for it. */
  get restartNonModel(): boolean { return this.restarts.restartNonModel; }
  set restartNonModel(v: boolean) { this.restarts.restartNonModel = v; }
  /** Counts model/effort changes, so a hot switch that finishes after a newer one leaves that one waiting. */
  get settingsGeneration(): number { return this.restarts.settingsGeneration; }
  set settingsGeneration(v: number) { this.restarts.settingsGeneration = v; }
  /**
   * Your message waits for this head's own work (its subagents, workers, background tasks) to finish, so a
   * model or effort change that needs a restart can be applied first; it is sent then, never on the old
   * settings. `noticeId`: the chat card that says so.
   */
  get settingsHold(): { noticeId: string; timer: ReturnType<typeof setInterval> } | null { return this.restarts.settingsHold; }
  set settingsHold(v: { noticeId: string; timer: ReturnType<typeof setInterval> } | null) { this.restarts.settingsHold = v; }
  /** Why it starts again before its next message (1.x's `RestartReason`): what it is told, what its divider says. */
  get restartReason(): { told: string; shown: string } | null { return this.restarts.restartReason; }
  set restartReason(v: { told: string; shown: string } | null) { this.restarts.restartReason = v; }
  /** The restart waiting is only for plugins: when they changed back, it is not needed (1.x's `pendingRestartForPluginsOnly`). */
  get restartForPluginsOnly(): boolean { return this.restarts.restartForPluginsOnly; }
  set restartForPluginsOnly(v: boolean) { this.restarts.restartForPluginsOnly = v; }
  /** The plugins' Claude parts its process started with (1.x's `loadedPluginStamp`). */
  get loadedPluginStamp(): string[] | null { return this.headRun.loadedPluginStamp; }
  set loadedPluginStamp(v: string[] | null) { this.headRun.loadedPluginStamp = v; }
  /** A head ended for such a restart: its session carries on. */
  get restarting(): AgentHead | null { return this.restarts.restarting; }
  set restarting(v: AgentHead | null) { this.restarts.restarting = v; }
  /** What its process has cost so far (claude's `total_cost_usd`, a running total; 1.x's `sessionCost`). */
  get sessionCost(): { last: number } { return this.headRun.sessionCost; }
  set sessionCost(v: { last: number }) { this.headRun.sessionCost = v; }
  /** Its head runs on another CLI from its next message on (1.x's `switchEngine`): a handoff through memory.md first. */
  /** Read by BotContext (M7-S41). */
  get switchTo(): Engine | null { return this.settings.switchTo; }
  set switchTo(v: Engine | null) { this.settings.switchTo = v; }
  /** Writing that handoff (1.x's `.switching(.writing)`). */
  get switching() { return this.settings.switching; }
  set switching(v: boolean) { this.settings.switching = v; }
  get idleTimer(): NodeJS.Timeout | null { return this.headRun.idleTimer; }
  set idleTimer(v: NodeJS.Timeout | null) { this.headRun.idleTimer = v; }
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
  pendingEnded: string[] = [];
  /** While tidying, a Codex worker's report turn on the memory update (`internalReply` kept open in 1.x). */
  get tidyFollowUp(): ((text: string) => void) | null { return this.headRun.tidyFollowUp; }
  set tidyFollowUp(v: ((text: string) => void) | null) { this.headRun.tidyFollowUp = v; }
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
  get briefedComponents(): ComponentKnowledge | null { return this.cards.briefedComponents; }
  set briefedComponents(told: ComponentKnowledge | null) { this.cards.briefedComponents = told; }
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
  private botWorkers: BotWorkers | null = null;
  private get workers(): BotWorkers { return this.botWorkers ??= new BotWorkers(this, this.ctx); }
  private botRestart: BotRestart | null = null;
  private get restarts(): BotRestart { return this.botRestart ??= new BotRestart(this, this.ctx); }
  private botHead: BotHead | null = null;
  private get headRun(): BotHead { return this.botHead ??= new BotHead(this, this.ctx); }

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

  get guestTurn() { return this.guests.guestTurn; }
  set guestTurn(v: boolean) { this.guests.guestTurn = v; }
  /** The core is being swapped: no turn begins (hot-swap.ts). */
  get swapHold(): boolean { return this.restarts.swapHold; }
  set swapHold(v: boolean) { this.restarts.swapHold = v; }
  get restartRecovery(): boolean { return this.restarts.restartRecovery; }
  set restartRecovery(v: boolean) { this.restarts.restartRecovery = v; }
  get restartProviderTurn(): string | undefined { return this.restarts.restartProviderTurn; }
  set restartProviderTurn(v: string | undefined) { this.restarts.restartProviderTurn = v; }
  get restartWorkerRecords(): import('./agent/codex').WorkerRecord[] | undefined { return this.restarts.restartWorkerRecords; }
  set restartWorkerRecords(v: import('./agent/codex').WorkerRecord[] | undefined) { this.restarts.restartWorkerRecords = v; }
  get restartWorkersSince(): number | undefined { return this.restarts.restartWorkersSince; }
  set restartWorkersSince(v: number | undefined) { this.restarts.restartWorkersSince = v; }

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

  headSessions(): { engine: Engine; sessionId: string | null }[] { return this.workers.headSessions(); }

  hostFacts(): HostFacts { return this.workers.hostFacts(); }

  agentFacts(nativeId: string) { return this.workers.agentFacts(nativeId); }

  hostBooks(): StartupHost[] { return this.workers.hostBooks(); }

  subagentRowFor(nativeId: string): SubagentRowView | null { return this.workers.subagentRowFor(nativeId); }

  findSubagent(key: string) { return this.workers.findSubagent(key); }

  get headEngines(): Engine[] { return this.workers.headEngines; }

  handoffMode(subagentId: string): "ask" | "steer" | "stop" { return this.workers.handoffMode(subagentId); }

  askForHandoff(subagentId: string, text: string): boolean { return this.workers.askForHandoff(subagentId, text); }

  stopForHandoff(subagentId: string): Promise<void> { return this.workers.stopForHandoff(subagentId); }

  /** Claude's app-managed workers (claude-workers.ts), made when first needed; they belong to this bot, not to its head process. */
  get claudeWorkerHost() { return this.workers.claudeWorkerHost; }
  set claudeWorkerHost(value: ClaudeWorkers | null) { this.workers.claudeWorkerHost = value; }
  /** Answers worker approval cards through this member's worker host (the bot's approvals keep the head that asked; a worker's is its manager). */
  private readonly workerApprovals = { running: true, answer: (requestId: string, allow: boolean, input: Record<string, unknown>, message?: string) => { this.workerHost?.answer(requestId, allow, input, message); } } as unknown as AgentHead;

  private get workerLedgerFile() { return this.workers.workerLedgerFile; }
  /** What each of its workers' ledger records last said (the registry's and the rows' state come from it). */
  get workerViews() { return this.workers.workerViews; }

  /**
   * This member's worker core, as its facade makes it (ClaudeWorkers, its Codex or Antigravity head): the member's
   * ledger (the old journals imported once, then never written), every transition projected, and a restart told from
   * a quit. One live core per member: a head's core goes with its head.
   */
  get workerCore(): WorkerCoreFactory { return this.workers.workerCore; }

  claudeWorkersOn(): boolean { return this.workers.claudeWorkersOn(); }

  ensureClaudeWorkers(): ClaudeWorkers { return this.workers.ensureClaudeWorkers(); }

  botTool(name: BotToolName, args: Record<string, unknown>, caller?: ToolCaller): Promise<unknown> { return this.workers.botTool(name, args, caller); }

  private fetchTool(args: Record<string, unknown>, caller: ToolCaller): Promise<string> { return this.workers.fetchTool(args, caller); }

  private componentUsage(args: Record<string, unknown>, caller: ToolCaller): Record<string, unknown> { return this.workers.componentUsage(args, caller); }

  private workerReport(text: string, workerId?: string): boolean { return this.workers.workerReport(text, workerId); }

  private get callInWork(): CallInWorkBook { return this.workers.callInWork; }
  get callInWorkBook() { return this.workers.callInWorkBook; }
  set callInWorkBook(value: CallInWorkBook | null) { this.workers.callInWorkBook = value; }

  private linkCallInWork(workerId: string) { this.workers.linkCallInWork(workerId); }

  private relayIfCallInWork(turn: Turn, workerId: string | null | undefined, news: CallInRelay["news"]) { this.workers.relayIfCallInWork(turn, workerId, news); }

  private relayFollowUp(turn: Turn, status: Status, record: ChatRecord | null, error?: string) { this.workers.relayFollowUp(turn, status, record, error); }

  workerNote(note: Pick<WorkerNote, "kind" | "name" | "message" | "files"> & { id?: string }, text: string): boolean { return this.workers.workerNote(note, text); }

  onWorkerOutput(item: CodexItem) { this.workers.onWorkerOutput(item); }

  private jobOfTurn(): { turnId: string; title: string } | undefined { return this.workers.jobOfTurn(); }

  private onItemPending(pending: boolean) { this.workers.onItemPending(pending); }

  private projectWorker(record: WorkerLedgerRecord, atStart?: boolean) { this.workers.projectWorker(record, atStart); }

  private markWorkerStep(id: string, failed: boolean) { this.workers.markWorkerStep(id, failed); }

  private projectLedgerAtStart() { this.workers.projectLedgerAtStart(); }

  get workerHost(): WorkerHost | null { return this.workers.workerHost; }

  workerHostFor(nativeId: string, load?: boolean): WorkerHost | null { return this.workers.workerHostFor(nativeId, load); }

  syncWorkerOwners() { this.workers.syncWorkerOwners(); }

  setWorkerOwner(nativeId: string, owner: WorkerOwner | null): WorkerOwnerResult | null { return this.workers.setWorkerOwner(nativeId, owner); }

  commandWorker(nativeId: string, action: { kind: "message"; text: string } | { kind: "stop" }): Promise<WorkerSendResult | { ok: true; how: "stopped" }> { return this.workers.commandWorker(nativeId, action); }

  private workerReported(item: Extract<CodexItem, { kind: "workerReport" }>) { this.workers.workerReported(item); }

  private workerNoted(item: Extract<CodexItem, { kind: "workerNote" }>) { this.workers.workerNoted(item); }

  /** A worker another bot owns asks for an approval: the owner's chat shows the card (the host's own standing rules still answer what they cover). */
  routeWorkerApproval(head: ApprovalAnswerer, item: Extract<StreamItem, { kind: "permission" }>): boolean { return this.questions.routeWorkerApproval(head, item); }
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

  get dirtySubagents(): Set<string> { return this.subagentRowBook.dirtySubagents; }
  saveSubagents(progress = false, changed?: SubagentRecord) { return this.subagentRowBook.saveSubagents(progress, changed); }
  private scheduleSubagentSave(delay: number) { return this.subagentRowBook.scheduleSubagentSave(delay); }
  flushSubagents(progress = false) { return this.subagentRowBook.flushSubagents(progress); }

  // ------------------------------------------------------------------------------------------
  // Views

  get phase(): BotView["phase"] { return this.views.phase; }

  get working(): boolean { return this.views.working; }

  view(): BotView { return this.views.view(); }

  private tokenSpeed(): BotView["tokenSpeed"] { return this.views.tokenSpeed(); }

  noteRequest(event: RequestEvent) { this.views.noteRequest(event); }

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
  get speaker(): string { return this.views.speaker; }

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
  becomeEngine(to: Engine) { return this.settings.becomeEngine(to); }
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

  restartBeforeNextMessage(reason: { told: string; shown: string } | null = null) { this.restarts.restartBeforeNextMessage(reason); }

  folderMoved(reason: { told: string; shown: string }) { this.restarts.folderMoved(reason); }

  restartFor(reason: { told: string; shown: string } | null, modelSettings = false, folder = false) { this.restarts.restartFor(reason, modelSettings, folder); }

  restartNow(): { restart: "next-message" | "asleep" } { return this.restarts.restartNow(); }

  /** "Restart bot" on a claude head: its next start is a new session, whatever its prompt hash says. */
  get freshSessionPending(): boolean { return this.headRun.freshSessionPending; }
  set freshSessionPending(v: boolean) { this.headRun.freshSessionPending = v; }
  /** ensureHead began a new session for the message being sent (its briefing says it all; no restart note). */
  get startedFresh(): boolean { return this.headRun.startedFresh; }
  set startedFresh(v: boolean) { this.headRun.startedFresh = v; }

  /** A session handed over by the old core is resumed as it is once (a cut-off turn goes on exactly where it stopped). */
  get adoptedSession(): boolean { return this.headRun.adoptedSession; }
  set adoptedSession(v: boolean) { this.headRun.adoptedSession = v; }
  savedPromptHash(sessionId: string): { promptHash?: string } { return this.restarts.savedPromptHash(sessionId); }

  promptHash(): string { return this.restarts.promptHash(); }

  hasCurrentPlugins(): boolean { return this.restarts.hasCurrentPlugins(); }

  reloadPlugins() { this.restarts.reloadPlugins(); }

  private async deliver(turn: Turn, given?: AgentHead) { return this.delivery.deliver(turn, given); }
  private turnImages(turn: Turn): string[] { return this.delivery.turnImages(turn); }
  get lineMediaStore(): string { return this.delivery.lineMediaStore; }
  attachmentPath(url: string, line?: string): string | null { return this.delivery.attachmentPath(url, line); }
  private namedAttachmentPath(url: string): string | null { return this.delivery.namedAttachmentPath(url); }
  private compose(turn: Turn, brief: boolean): string { return this.delivery.compose(turn, brief); }
  private wakeLine(turn: Turn, recent: (leavingOut: string | null) => string): string { return this.delivery.wakeLine(turn, recent); }
  wakeNote(): string { return this.delivery.wakeNote(); }
  prompts(): BotPrompts { return this.delivery.prompts(); }

  ensureHead(): AgentHead { return this.headRun.ensureHead(); }

  sessionStart(resume: boolean, prompts: BotPrompts): SessionStart { return this.headRun.sessionStart(resume, prompts); }

  canSwitchInPlace(head: AgentHead): boolean { return this.headRun.canSwitchInPlace(head); }

  switchInPlace(head: AgentHead): Promise<boolean> { return this.headRun.switchInPlace(head); }

  newSession() { this.headRun.newSession(); }

  place(turn: Turn): ChatRecord { return this.headRun.place(turn); }

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

  onItem(head: AgentHead, item: CodexItem) {
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

  private onSubagentItem(item: CodexItem): boolean { return (this.workers ?? new BotWorkers(this)).onSubagentItem(item); }
  subagentChanged(subagent: SubagentRecord | undefined, progress?: boolean, redrawLine?: boolean) { this.workers.subagentChanged(subagent, progress, redrawLine); }
  subagentEnded(id: string) { this.workers.subagentEnded(id); }

  emitSteps(turn: Turn) {
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

  private takeHandback(turn: Turn): boolean { return this.workers.takeHandback(turn); }

  forgetReturnRoutes(handoffId?: string) { this.workers.forgetReturnRoutes(handoffId); }

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

  onExit(head: AgentHead, exit: HeadExit) {
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

  private noteSubagentEnd(id: string, text: string) { this.workers.noteSubagentEnd(id, text); }

  recordOutage(opts: { turnFailed?: boolean; subagents?: string[]; lostSession?: string | null }) { this.progress.recordOutage(opts); }
  networkRestored(now = Date.now()) { this.progress.networkRestored(now); }
  private retryApiLater(turn: Turn): boolean { return this.progress.retryApiLater(turn); }
  clearApiRetry() { this.progress.clearApiRetry(); }

  // ------------------------------------------------------------------------------------------
  // Background work (1.x's BackgroundTask: a chip in the reply, and what a wake is told was cut off)

  private refreshScheduleDue() { this.tasks.refreshScheduleDue(); }
  private settleSessionSchedules() { this.tasks.settleSessionSchedules(); }
  addBackgroundTask(id: string, kind: BackgroundKind, title: string) { (this.tasks ?? new BotTasks(this)).addBackgroundTask(id, kind, title); }
  private cancelScheduled(cancellation: ScheduleCancellation, turn: Turn | null) { this.tasks.cancelScheduled(cancellation, turn); }
  private findTask(id: string): BackgroundTask | undefined { return this.tasks.findTask(id); }
  private touchTask(id: string) { this.tasks.touchTask(id); }
  private addSubagentTask(ownerId: string, id: string, kind: BackgroundKind, title: string, detail: string) { this.tasks.addSubagentTask(ownerId, id, kind, title, detail); }
  private placeSubagentTask(ownerId: string, task: BackgroundTask) { this.tasks.placeSubagentTask(ownerId, task); }
  endSubagentTasks(ownerId: string) { this.tasks.endSubagentTasks(ownerId); }
  endBackground(id: string, status: string, summary: string | null) { this.tasks.endBackground(id, status, summary); }
  private keepTasks(turn: Turn, record: ChatRecord | null) { this.tasks.keepTasks(turn, record); }
  private stopTasks() { this.tasks.stopTasks(); }
  get backgroundWorkRunning(): boolean { return this.tasks.backgroundWorkRunning; }

  get ownRecords(): ChatRecord[] { return this.recordsBook.ownRecords; }

  get ownWorkRunning(): boolean { return this.tasks.ownWorkRunning; }
  get inHeadSubagents(): SubagentRecord[] { return this.tasks.inHeadSubagents; }

  ownWorkWords(): string { return this.workers.ownWorkWords(); }

  holdForSettings(turn: Turn) { this.restarts.holdForSettings(turn); }

  waitsForRestart(turn: Turn): boolean { return this.restarts.waitsForRestart(turn); }

  releaseSettingsHold(): boolean { return this.restarts.releaseSettingsHold(); }

  checkSettingsHold() { this.restarts.checkSettingsHold(); }

  takeInterruptedNote(): string { return this.recordsBook.takeInterruptedNote(); }

  // ------------------------------------------------------------------------------------------
  // Quiet runs (1.x's `checkStall`, `noteProgress`)

  private noteCodexRetry(item: Extract<CodexItem, { kind: "apiRetry" }>) { this.progress.noteCodexRetry(item); }
  private clearCodexRetry() { this.progress.clearCodexRetry(); }
  noteProgress() { this.progress.noteProgress(); }
  noteProgressOf(item: CodexItem) { this.progress.noteProgressOf(item); }
  checkStall(now: number, intervalMs: number): string[] { return this.progress.checkStall(now, intervalMs); }
  private outageBlocksStall(): boolean { return this.progress.outageBlocksStall(); }

  // ------------------------------------------------------------------------------------------
  // Sleeping

  scheduleIdle() { this.headRun.scheduleIdle(); }

  clearIdle() { this.headRun.clearIdle(); }

  sleep(options: { tidyMs?: number } = {}): Promise<void> { return this.headRun.sleep(options); }

  maintenance(text: string, timeoutMs: number, head: AgentHead): Promise<string | null> { return this.headRun.maintenance(text, timeoutMs, head); }

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

  get context(): ComponentsContext | null { return this.cards.context; }
  get commandFolder(): string { return this.cards.commandFolder; }
  private giveFirstComponents() { this.cards.giveFirstComponents(); }
  private drewComponents(names: string[]) { this.cards.drewComponents(names); }
  ownComponents(): string[] { return this.cards.ownComponents(); }
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

  ask(head: AgentHead, item: Extract<StreamItem, { kind: "permission" }>, turn: Turn | null) { return this.questions.ask(head, item, turn); }
  private showReviewRefusal(head: AgentHead, item: Extract<StreamItem, { kind: "permission" }>) { return this.questions.showReviewRefusal(head, item); }
  private tellReviewOutcome(approval: Approval, allowed: boolean, words?: string) { return this.questions.tellReviewOutcome(approval, allowed, words); }
  noteToolCall(item: Extract<StreamItem, { kind: "toolUse" }>) { return this.questions.noteToolCall(item); }
  get allowRules(): string[] { return this.questions.allowRules; }
  showDenial(denial: Extract<StreamItem, { kind: "permissionDenied" }>) { return this.questions.showDenial(denial); }
  private decideDenial(record: ChatRecord, index: number): boolean { return this.questions.decideDenial(record, index); }
  /** Something only the app says, to this head: wakes it like a message (`Bot.appMessage`). */
  tellHead(text: string) {
    this.owner.deliverTo(this.engine, text, null, { origin: "app" });
  }

  /** The coordinator turn ended/stopped; a monitor or managed worker may still be waiting. */
  private settleTurnApprovals() { this.questions.settleTurnApprovals(); }
  private expire(id: string) { this.questions.expire(id); }
  settle(id: string, answer: string, deny: boolean) { this.questions.settle(id, answer, deny); }
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

  holdForSwap(hold: boolean) { this.restarts.holdForSwap(hold); }
  get swapBusy(): boolean { return this.restarts.swapBusy; }
  get swapToolInFlight(): boolean { return this.restarts.swapToolInFlight; }
  swapInterrupt(): Promise<void> { return this.restarts.swapInterrupt(); }
  swapEntries(cutOff: boolean): SwapEntry[] { return this.restarts.swapEntries(cutOff); }
  flushForSwap(): Promise<void> { return this.restarts.flushForSwap(); }
  /** A fake `this` (a plain object a test passes to `Bot.prototype.restartEntries.call`) has no collaborator: one is made from it. */
  restartEntries(): RestartEntry[] { return (this.restarts ?? new BotRestart(this, new BotContext(this))).restartEntries(); }
  retainRestartIdentity(entry: RestartEntry): Bot { return this.restarts.retainRestartIdentity(entry); }

  restartedWorkers(entry: RestartEntry): WorkerLedgerRecord[] { return this.workers.restartedWorkers(entry); }

  /** An entry the restart did not continue (`reason`): said in this chat, with the messages that waited behind it (BotRestart). */
  restartPaused(entry: RestartEntry, reason: string): string { return this.restarts.restartPaused(entry, reason); }

  /** A fake `this` (a plain object a test passes to `Bot.prototype.adoptRestart.call`) has no collaborator: one is made from it. */
  adoptRestart(entry: RestartEntry) { (this.restarts ?? new BotRestart(this, new BotContext(this))).adoptRestart(entry); }

  adoptSwap(entries: SwapEntry[]) { this.restarts.adoptSwap(entries); }

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

