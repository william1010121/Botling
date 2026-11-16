import type { BotToolName, ToolCaller } from "./bot-tools";
import type { RestartEntry } from './restart-continuation';
import type { CommandMonitor } from "./agent/monitors";
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
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ApprovalAnswerer } from "./agent-registry";
import type { BotView, ChatSnapshot, Event, MessageView, ResultOf, BotSettingsView, ResultView } from "../contract";
import type { HeadExit } from "./agent/head";
import type { CodexItem } from "./agent/codex";
import { Conductor, readHeads, type AnswerTarget, type ConductorAction, type Engine, type Heads } from "./heads";
import type { CommandState, StreamItem } from "./agent/stream";
import { archiveAll, type SeenReactions } from "./briefing";
import type { BotPrompts } from "./prompts";
import { SubagentBook, readSubagent, type SubagentRecord } from "./subagents";
import type { ComponentKnowledge } from "./components/library";
import type { QuestionPick } from "./questions";
import type { WorkerLedgerRecord, WorkerNote } from "./worker-core";
import { BotRoutines } from "./bot/bot-routines";
import { BotStore, type HeadState } from "./store/bot-store";
import type { Outage } from "./network-resume";
import type { SwapEntry } from "./hot-swap";
import type { BackgroundKind, BackgroundTask } from "./background-tasks";
import type { ChatRecord } from "./store/records";
import type { WorkerHost } from "./agent/workers";
import type { ClaudeWorkers } from "./agent/claude-workers";
import { BotContext } from "./bot/context";
import { BotQuestions } from "./bot/questions";
import { BotCards } from "./bot/cards";
import { BotProgress } from "./bot/progress";
import { BotTasks } from "./bot/tasks";
import { BotGuests } from "./bot/guests";
import { BotSettings } from "./bot/settings";
import { NO_LONGER_NEEDED, readStoredSpec, type SessionStart, type BotOptions, type PresetTurnIds, type Origin, type AgentHead, type Turn, type GuestAnswer, type Approval, type Denial, type StoredSpec } from "./bot/types";
import { sleep, preview, streamingText, isRule, allowRule, permissionText, stepView, subagentView, messageView } from "./bot/view-functions";
import { BotRecords } from "./bot/records";
import { BotSubagentRows } from "./bot/subagent-rows";
import { BotGroup } from "./bot/group";
import { BotDelivery } from "./bot/delivery";
import { BotViews } from "./bot/views";
import { BotDecisions } from "./bot/decisions";
import { BotWorkers } from "./bot/workers";
import { BotRestart } from "./bot/restart";
import { BotHead } from "./bot/head";
import { TurnControl } from "./bot/turn-control";
import { HeadEvents, monitorStateOf } from "./bot/head-events";
export type Status = "done" | "stopped" | "failed";
export { NO_LONGER_NEEDED } from "./bot/types";
export type { SessionStart, SessionStartCodex, BotOptions, PresetTurnIds, DeferredTurn, GuestAnswer, StoredSpec } from "./bot/types";
export { preview, streamingText, isRule, allowRule, permissionText, stepView, subagentView, messageView } from "./bot/view-functions";

export class Bot {
  readonly store: BotStore;
  readonly subagents: SubagentBook;
  /** Read by BotContext (M7-S41). */
  get records(): ChatRecord[] { return this.recordsBook.records; }
  set records(value: ChatRecord[]) { this.recordsBook.records = value; }
  /** Set when its chat file could not be read: nothing is written over it then. */
  get problem(): string | null { return this.recordsBook.problem; }
  get readOnly(): boolean { return this.recordsBook.readOnly; }
  get head(): AgentHead | null { return this.headRun.head; }
  set head(v: AgentHead | null) { this.headRun.head = v; }
  /** Which CLI this bot's head is. */
  readonly engine: Engine;
  /** Its heads (bot.json `heads`, 1.x's format). Kept by the primary; a partner reads it. */
  /** Read by BotContext (M7-S41). */
  get headsSettings(): Heads { return this.settings.headsSettings; }
  set headsSettings(v: Heads) { this.settings.headsSettings = v; }
  /** Read by BotContext (M7-S41). */
  get partners() { return this.group.partners; }
  set partners(v) { this.group.partners = v; }
  /** Compatibility view for integrations that inspect the first peer. Routing uses all peers. */
  get partner(): Bot | null { return this.ctx.partner; }
  get peers(): Bot[] { return this.ctx.peers; }
  /** Read by BotContext (M7-S41): it stays here because it names `this` as the Bot itself. */
  get members(): Bot[] { return [this, ...this.peers]; }

  get conductor() { return this.group.conductor; }
  private set conductor(v) { this.group.conductor = v; }
  /** Read by BotContext (M7-S41). */
  get claimHold() { return this.group.claimHold; }
  set claimHold(v) { this.group.claimHold = v; }
  get pendingNote() { return this.delivery.pendingNote; }
  set pendingNote(v) { this.delivery.pendingNote = v; }
  /** The conductor's cards waiting for a pick: what each button does. */
  get cardPicks() { return this.guests.cardPicks; }
  private set cardPicks(v) { this.guests.cardPicks = v; }
  get handoffDecisions() { return this.group.handoffDecisions; }
  private set handoffDecisions(v) { this.group.handoffDecisions = v; }
  get rounds() { return this.group.rounds; }
  private set rounds(v) { this.group.rounds = v; }
  /** Codex: workers at work or their reports waiting (the bot stays awake). */
  get managedPending() { return this.workers.managedPending; }
  set managedPending(value: boolean) { this.workers.managedPending = value; }
  get outage(): Outage | null { return this.progress.outage; }
  get retryingConnection() { return this.progress.retryingConnection; }
  set retryingConnection(v: boolean) { this.progress.retryingConnection = v; }
  get apiRetries() { return this.progress.apiRetries; }
  set apiRetries(v: number) { this.progress.apiRetries = v; }
  get codexRetry() { return this.progress.codexRetry; }
  set codexRetry(v: NonNullable<BotView["codexRetry"]> | null) { this.progress.codexRetry = v; }
  /** Subagents whose last line was claude's connection error (1.x's `cutOffByNetwork`). */
  get cutOffByNetwork() { return this.workers.cutOffByNetwork; }
  /** Tidying memory.md before it sleeps. */
  get tidying(): boolean { return this.headRun.tidying; }
  set tidying(v: boolean) { this.headRun.tidying = v; }
  /** Read by BotContext (M7-S41). */
  /** Read by BotContext (M7-S41). */
  get approvals(): Map<string, Approval> { return this.questions.approvals; }
  set approvals(value: Map<string, Approval>) { this.questions.approvals = value; }
  /** The app's own questions in this chat (installing a plugin): what a pick does. */
  get appQuestions() { return this.guests.appQuestions; }
  private set appQuestions(v) { this.guests.appQuestions = v; }
  /** …and what words typed on one do instead of going to the bot (a copy of another bot's question). */
  get appAnswers() { return this.guests.appAnswers; }
  private set appAnswers(v) { this.guests.appAnswers = v; }
  /** What the app tells it with its next message (`queueNote`). */
  get queuedNote() { return this.delivery.queuedNote; }
  set queuedNote(v) { this.delivery.queuedNote = v; }
  /** Read by BotContext (M7-S41). */
  get session(): HeadState { return this.headRun.session; }
  set session(v: HeadState) { this.headRun.session = v; }
  /** The next head is a new session: its first message carries the wake briefing. */
  get briefing(): boolean { return this.headRun.briefing; }
  set briefing(v: boolean) { this.headRun.briefing = v; }
  /** Its next message starts its process again in the same session (1.x's `restart(_:)`, e.g. "may read …"). */
  get restartPending(): boolean { return this.restarts.restartPending; }
  get modelSettingsPending(): boolean { return this.restarts.modelSettingsPending; }
  /**
   * The restart waiting is for a new working folder (a plugin's `sessions.folder`): your message never goes to the process
   * still in the old one; while its own work runs it waits, as for a model change (spec/models/folders TurnStartsCurrent).
   */
  get folderPending(): boolean { return this.restarts.folderPending; }
  /** The restart waiting is also for something other than its model or effort (plugins, folders, subagents' model): a hot switch cannot stand in for it. */
  get restartNonModel(): boolean { return this.restarts.restartNonModel; }
  /** Counts model/effort changes, so a hot switch that finishes after a newer one leaves that one waiting. */
  get settingsGeneration(): number { return this.restarts.settingsGeneration; }
  /**
   * Your message waits for this head's own work (its subagents, workers, background tasks) to finish, so a
   * model or effort change that needs a restart can be applied first; it is sent then, never on the old
   * settings. `noticeId`: the chat card that says so.
   */
  get settingsHold(): { noticeId: string; timer: ReturnType<typeof setInterval> } | null { return this.restarts.settingsHold; }
  set settingsHold(v: { noticeId: string; timer: ReturnType<typeof setInterval> } | null) { this.restarts.settingsHold = v; }
  /** Why it starts again before its next message (1.x's `RestartReason`): what it is told, what its divider says. */
  get restartReason(): { told: string; shown: string } | null { return this.restarts.restartReason; }
  /** The restart waiting is only for plugins: when they changed back, it is not needed (1.x's `pendingRestartForPluginsOnly`). */
  get restartForPluginsOnly(): boolean { return this.restarts.restartForPluginsOnly; }
  /** A head ended for such a restart: its session carries on. */
  get restarting(): AgentHead | null { return this.restarts.restarting; }
  /** Its head runs on another CLI from its next message on (1.x's `switchEngine`): a handoff through memory.md first. */
  /** Read by BotContext (M7-S41). */
  get switchTo(): Engine | null { return this.settings.switchTo; }
  set switchTo(v: Engine | null) { this.settings.switchTo = v; }
  /** Writing that handoff (1.x's `.switching(.writing)`). */
  get switching() { return this.settings.switching; }
  private set switching(v: boolean) { this.settings.switching = v; }
  private get alwaysAllowed(): string[] { return this.questions.alwaysAllowed; }
  private set alwaysAllowed(value: string[]) { this.questions.alwaysAllowed = value; }
  get denialAsks(): Map<string, Denial> { return this.questions.denialAsks; }
  private set denialAsks(value: Map<string, Denial>) { this.questions.denialAsks = value; }
  private get sessionRules(): string[] { return this.questions.sessionRules; }
  private set sessionRules(value: string[]) { this.questions.sessionRules = value; }
  private get rulesGivenAfter(): Map<string, string | null> { return this.questions.rulesGivenAfter; }
  private set rulesGivenAfter(value: Map<string, string | null>) { this.questions.rulesGivenAfter = value; }
  get scheduleCalls() { return this.tasks.scheduleCalls; }
  /** Owned by BotQuestions (M7-S44); an accessor each, so a test that assigns or reads one on a Bot still works. */
  get toolCalls(): Map<string, { tool: string; detail: string; parent: string | null }> { return this.questions.toolCalls; }
  private set toolCalls(value: Map<string, { tool: string; detail: string; parent: string | null }>) { this.questions.toolCalls = value; }
  shuttingDown = false;
  /** What this head's session has been told of the chat's reactions (null: tell it from scratch). */
  get reactionsSeen(): SeenReactions | null { return this.recordsBook.reactionsSeen; }
  set reactionsSeen(value: SeenReactions | null) { this.recordsBook.reactionsSeen = value; }
  /** Read by BotContext (M7-S41). */
  /** The components and cards of this bot (M7-S43): made on first use, from this bot. */
  private botCards: BotCards | null = null;
  get cards(): BotCards { return this.botCards ??= new BotCards(this, this.ctx); }
  get briefedComponents(): ComponentKnowledge | null { return this.cards.briefedComponents; }
  set briefedComponents(told: ComponentKnowledge | null) { this.cards.briefedComponents = told; }

  /** Made on first use, from this bot: a fake `Object.create(Bot.prototype)` has one too. */
  private botContext: BotContext | null = null;
  get ctx(): BotContext { return this.botContext ??= new BotContext(this); }
  /** Made on first use too (M7-S44): it owns the approvals and the allow rules. */
  private botQuestions: BotQuestions | null = null;
  get questions(): BotQuestions { return this.botQuestions ??= new BotQuestions(this, this.ctx); }
  private botProgress: BotProgress | null = null;
  get progress(): BotProgress { return this.botProgress ??= new BotProgress(this, this.ctx); }
  private botTasks: BotTasks | null = null;
  get tasks(): BotTasks { return this.botTasks ??= new BotTasks(this, this.ctx); }
  private botGuests: BotGuests | null = null;
  get guests(): BotGuests { return this.botGuests ??= new BotGuests(this, this.ctx); }
  private botSettings: BotSettings | null = null;
  get settings(): BotSettings { return this.botSettings ??= new BotSettings(this, this.ctx); }
  /** Made on first use, from this bot (M7-S42). */
  private botRoutines: BotRoutines | null = null;
  get routines(): BotRoutines { return this.botRoutines ??= new BotRoutines(this, this.ctx); }
  private botRecords: BotRecords | null = null;
  get recordsBook(): BotRecords { return this.botRecords ??= new BotRecords(this, this.ctx); }
  private botSubagentRows: BotSubagentRows | null = null;
  get subagentRowBook(): BotSubagentRows { return this.botSubagentRows ??= new BotSubagentRows(this, this.ctx); }
  private botGroup: BotGroup | null = null;
  get group(): BotGroup { return this.botGroup ??= new BotGroup(this, this.ctx); }
  private botDelivery: BotDelivery | null = null;
  get delivery(): BotDelivery { return this.botDelivery ??= new BotDelivery(this, this.ctx); }
  private botViews: BotViews | null = null;
  get views(): BotViews { return this.botViews ??= new BotViews(this, this.ctx); }
  private botDecisions: BotDecisions | null = null;
  get decisions(): BotDecisions { return this.botDecisions ??= new BotDecisions(this, this.ctx); }
  private botWorkers: BotWorkers | null = null;
  get workers(): BotWorkers { return this.botWorkers ??= new BotWorkers(this, this.ctx); }
  private botRestart: BotRestart | null = null;
  get restarts(): BotRestart { return this.botRestart ??= new BotRestart(this, this.ctx); }
  private botHead: BotHead | null = null;
  get headRun(): BotHead { return this.botHead ??= new BotHead(this, this.ctx); }

  /** The turn under way and the queue behind it (M7-S52): made on first use, from this bot. */
  private turnControl: TurnControl | null = null;
  get turns(): TurnControl { return this.turnControl ??= new TurnControl(this, this.ctx); }
  /** The fields TurnControl owns, as this bot has always had them (`turn`, `queue`, `deferred` are read by BotContext). */
  get turn(): Turn | null { return this.turns.turn; }
  set turn(turn: Turn | null) { this.turns.turn = turn; }
  get queue(): Turn[] { return this.turns.queue; }
  set queue(queue: Turn[]) { this.turns.queue = queue; }
  get deferred(): Turn | null { return this.turns.deferred; }
  set deferred(turn: Turn | null) { this.turns.deferred = turn; }
  get finished(): Map<string, Status> { return this.turns.finished; }
  get draining() { return this.turns.draining; }
  private set draining(draining: TurnControl["draining"]) { this.turns.draining = draining; }
  get ignoreResults(): number { return this.turns.ignoreResults; }
  set ignoreResults(count: number) { this.turns.ignoreResults = count; }
  get paused() { return this.turns.paused; }
  set paused(paused: TurnControl["paused"]) { this.turns.paused = paused; }
  private get reportAsked(): Set<string> { return this.turns.reportAsked; }
  get pendingEnded(): string[] { return this.turns.pendingEnded; }
  set pendingEnded(ended: string[]) { this.turns.pendingEnded = ended; }
  get ending(): WeakSet<AgentHead> { return this.turns.ending; }
  get contextSent(): Set<string> { return this.turns.contextSent; }
  get steered(): Map<string, Turn> { return this.turns.steered; }
  get claudeMidTurn(): WeakSet<AgentHead> { return this.turns.claudeMidTurn; }
  private get inserting(): Map<string, Turn> { return this.turns.inserting; }
  get unbegun() { return this.turns.unbegun; }

  /** What a head says and what becomes of it (M7-S53): made on first use, from this bot. */
  private botHeadEvents: HeadEvents | null = null;
  get headEvents(): HeadEvents { return this.botHeadEvents ??= new HeadEvents(this, this.ctx); }

  constructor(/** Read by BotContext (M7-S41). */ public options: BotOptions) {
    const primary = options.primary;
    this.engine = options.engine ?? "claude";
    const storeDir = primary ? join(primary.profile.storeDir, `partner-${this.engine}`) : options.profile.storeDir;
    this.store = options.botStore ? options.botStore(storeDir) : new BotStore(storeDir);
    // A new session at every start: the app starting is a wake (1.x).
    this.session = { sessionId: randomUUID(), started: false };
    this.alwaysAllowed = (primary ?? this).store.loadAlwaysAllowed();
    this.recordsBook.unread = primary ? 0 : this.store.loadUnread();
    // Kept from trimming: the ones another bot owns now (their rows and steps are its to show).
    this.subagents = new SubagentBook(this.recordsBook.readList("subagents.json", readSubagent), () => new Set(this.options.agents?.retained(this.engine) ?? []));
    this.subagents.sink = (id, line) => { if (!this.readOnly) this.store.stageSubagentLine(id, line); };
    // Its app-managed workers' rows are the worker ledger's projection (`projectWorker`), never their end notices.
    this.subagents.workerProjection = true;
    this.subagents.loadSteps = (id) => this.store.readSubagentSteps(id).steps.slice(-500);
    if (!primary) {
      this.recordsBook.specList = this.recordsBook.readList("specs.json", readStoredSpec);
      const list = this.store.loadSettings().components;
      this.cards.componentList = Array.isArray(list) ? list.filter((name): name is string => typeof name === "string") : null;
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
      if (typeof saved === "string" && /^[0-9a-f-]{36}$/i.test(saved)) { this.headRun.sessionResumed(saved); }
    }
    this.conductor = new Conductor(this.headsSettings);
    this.recordsBook.load();
    this.workers.restoreAtStart();
    if (!options.deferStartup) this.activateStartup();
    if (!primary) {
      if (!this.readOnly) this.settings.saveHeads();
      for (const engine of this.headsSettings.engines) if (engine !== this.engine) this.makePartner(engine, true);
      this.cards.giveFirstComponents();
    }
  }

  activateStartup() {
    if (this.headRun.startupActive) return;
    this.headRun.startupActive = true;
    if (!this.problem && !this.options.primary) archiveAll(this.ctx.paths.archive, this.records);
    if (!this.options.primary) this.routines.setUpRoutines();
    for (const peer of this.peers) peer.activateStartup();
  }

  /** The bot whose chat this is (itself, or a partner's primary). Read by BotContext (M7-S41): it names `this` as the Bot itself. */
  get owner(): Bot {
    return this.options.primary ?? this;
  }

  private get chat(): ChatRecord[] { return this.ctx.chat; }
  get heads(): Heads { return this.ctx.heads; }
  private allowsEngineRoute(head: Engine, from?: Engine): boolean { return this.ctx.allowsEngineRoute(head, from); }
  private botFor(head: Engine): Bot | null { return this.ctx.botFor(head); }

  makePartner(onDemand?: Engine, restore?: boolean): Bot | null { return this.group.makePartner(onDemand, restore); }

  get id() { return this.ctx.id; }
  get profile() { return this.ctx.profile; }
  log(line: string) { this.ctx.log(line); }
  emit(event: Event) { this.ctx.emit(event); }

  fromPartner(partner: Bot, event: Event) { return this.recordsBook.fromPartner(partner, event); }
  persist(soon = false) { return this.recordsBook.persist(soon); }
  messageView(record: ChatRecord): MessageView { return this.recordsBook.messageView(record); }

  // ------------------------------------------------------------------------------------------
  // Component specs (1.x's `specs`, `editSpecs`)

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
  private set guestTurn(v: boolean) { this.guests.guestTurn = v; }
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

  lines(): readonly ChatRecord[] { return this.guests.lines(); }
  line(id: string): ChatRecord | null { return this.guests.line(id); }
  ignoreQuestion(id: string, at?: string): ResultOf<"chat.ignoreQuestion"> { return this.guests.ignoreQuestion(id, at); }
  settleAppQuestion(id: string, outcome: { chosen?: number; answer?: string }): void { return this.guests.settleAppQuestion(id, outcome); }
  openCopies(botId?: string): ChatRecord[] { return this.guests.openCopies(botId); }
  settleSubagent(id: string, settled: boolean): ResultOf<"subagent.settle"> { return this.guests.settleSubagent(id, settled); }

  agentFacts(nativeId: string) { return this.workers.agentFacts(nativeId); }

  findSubagent(key: string) { return this.workers.findSubagent(key); }

  get headEngines(): Engine[] { return this.workers.headEngines; }

  handoffMode(subagentId: string): "ask" | "steer" | "stop" { return this.workers.handoffMode(subagentId); }

  askForHandoff(subagentId: string, text: string): boolean { return this.workers.askForHandoff(subagentId, text); }

  stopForHandoff(subagentId: string): Promise<void> { return this.workers.stopForHandoff(subagentId); }

  /** Claude's app-managed workers (claude-workers.ts), made when first needed; they belong to this bot, not to its head process. */
  get claudeWorkerHost() { return this.workers.claudeWorkerHost; }
  set claudeWorkerHost(value: ClaudeWorkers | null) { this.workers.claudeWorkerHost = value; }

  ensureClaudeWorkers(): ClaudeWorkers { return this.workers.ensureClaudeWorkers(); }

  botTool(name: BotToolName, args: Record<string, unknown>, caller?: ToolCaller): Promise<unknown> { return this.workers.botTool(name, args, caller); }

  private workerReport(text: string, workerId?: string): boolean { return this.workers.workerReport(text, workerId); }

  workerNote(note: Pick<WorkerNote, "kind" | "name" | "message" | "files"> & { id?: string }, text: string): boolean { return this.workers.workerNote(note, text); }

  onWorkerOutput(item: CodexItem) { this.workers.onWorkerOutput(item); }

  private projectWorker(record: WorkerLedgerRecord, atStart?: boolean) { this.workers.projectWorker(record, atStart); }

  get workerHost(): WorkerHost | null { return this.workers.workerHost; }

  workerHostFor(nativeId: string, load?: boolean): WorkerHost | null { return this.workers.workerHostFor(nativeId, load); }

  syncWorkerOwners() { this.workers.syncWorkerOwners(); }

  private workerReported(item: Extract<CodexItem, { kind: "workerReport" }>) { this.workers.workerReported(item); }

  private workerNoted(item: Extract<CodexItem, { kind: "workerNote" }>) { this.workers.workerNoted(item); }

  /** A worker another bot owns asks for an approval: the owner's chat shows the card (the host's own standing rules still answer what they cover). */
  routeWorkerApproval(head: ApprovalAnswerer, item: Extract<StreamItem, { kind: "permission" }>): boolean { return this.questions.routeWorkerApproval(head, item); }

  results(): ResultView[] { return this.subagentRowBook.results(); }
  queueNote(note: string) { return this.subagentRowBook.queueNote(note); }

  // Its own components, moved to BotCards (M7-S43).
  get components(): string[] | null { return this.cards.components; }
  setComponentList(names: string[]) { this.cards.setComponentList(names); }

  get lastAsked(): string { return this.views.lastAsked; }

  addRoutine(cron: string, task: string): boolean { return this.routines.addRoutine(cron, task); }

  get awake(): boolean { return this.views.awake; }

  saveSubagents(progress = false, changed?: SubagentRecord) { return this.subagentRowBook.saveSubagents(progress, changed); }
  flushSubagents(progress = false) { return this.subagentRowBook.flushSubagents(progress); }

  // ------------------------------------------------------------------------------------------
  // Views

  get phase(): BotView["phase"] { return this.views.phase; }

  get working(): boolean { return this.views.working; }

  view(): BotView { return this.views.view(); }

  refresh() { this.views.refresh(); }

  updated() { this.views.updated(); }

  get shownTurn(): Turn | null { return this.views.shownTurn; }

  snapshot(): ChatSnapshot { return this.views.snapshot(); }

  history(before: string, bytes?: number, until?: string): ResultOf<"chat.history"> { return this.views.history(before, bytes, until); }

  taskOutput(messageId: string, taskId: string): Promise<ResultOf<"task.output">> { return this.views.taskOutput(messageId, taskId); }
  subagentView(id: string, who?: { owner: string; host: string | null }): ResultOf<"subagent.view"> { return this.views.subagentView(id, who); }

  // ------------------------------------------------------------------------------------------
  // Sending, and the turn

  send(text: string, opts: { replyTo?: string; to?: AnswerTarget; appNote?: string; decisionOwner?: Engine; files?: string[]; originals?: string[]; via?: string; onDelivery?: (delivered: boolean) => void; ids?: PresetTurnIds } = {}): ResultOf<"chat.send"> { return this.group.send(text, opts); }

  deliverTo(head: Engine, words: string, userId: string | null, extra?: Partial<Pick<Turn, "conducted" | "handoffId" | "about" | "origin" | "delivery" | "routine" | "released">> & { ids?: PresetTurnIds }): Turn { return this.group.deliverTo(head, words, userId, extra); }

  delivered(turn: Turn) { return this.group.delivered(turn); }

  newTurn(origin: Origin, words: string, userId: string | null, ids?: PresetTurnIds): Turn { return this.group.newTurn(origin, words, userId, ids); }

  // ------------------------------------------------------------------------------------------
  // Two heads: who reads a message to both first

  releaseClaim(words?: string, about?: string[]) { return this.group.releaseClaim(words, about); }

  private tell(head: Engine, note: string, about: string[]) { return this.group.tell(head, note, about); }

  hearNow(note: string, about: string[]): boolean { return this.group.hearNow(note, about); }

  conduct(actions: ConductorAction[]): void { return this.group.conduct(actions); }

  stopHandoff(id: string): ResultOf<"handoff.stop"> { return this.group.stopHandoff(id); }

  setAnswerWith(to: AnswerTarget): ResultOf<"heads.answerWith"> { return this.group.setAnswerWith(to); }

  setHeads(engines: Engine[]): Promise<ResultOf<"heads.set">> { return this.settings.setHeads(engines); }
  choices() { return this.settings.choices(); }
  applyEngineDefaults(change: { subagentModel?: string | null; subagentEffort?: string | null; codexWorkers?: Record<string, unknown> | undefined; agyWorkerModel?: string | null; agyWorkerEffort?: string | null }) { return this.settings.applyEngineDefaults(change); }
  settingsView(): BotSettingsView { return this.settings.settingsView(); }
  configure(change: { workerMachine?: string | null; agyModel?: string | null; agyWorkerModel?: string | null; agyWorkerEffort?: string | null; codexWorkers?: { model: string | null; effort: string | null; fast: boolean | null } | null; model?: string | null; effort?: string | null; subagentModel?: string | null; subagentEffort?: string | null; codexModel?: string | null; primary?: Engine | null; efforts?: Partial<Record<Engine, string | null>> }): BotSettingsView { return this.settings.configure(change); }
  becomeEngine(to: Engine) { return this.settings.becomeEngine(to); }
  get switchReady(): boolean { return this.settings.switchReady; }
  handOver(): Promise<void> { return this.settings.handOver(); }

  showAppReply(raw: string) { this.decisions.showAppReply(raw); }

  bumpUnread() { return this.recordsBook.bumpUnread(); }

  // ------------------------------------------------------------------------------------------
  // Shared decisions (a question handed over between the heads)

  identifyDecision(id: string) { this.decisions.identifyDecision(id); }

  associateDecision(record: ChatRecord, reference: string | null, turn: Turn) { this.decisions.associateDecision(record, reference, turn); }

  redrawQueued(turn: Turn) { this.decisions.redrawQueued(turn); }

  route(turn: Turn): Turn { return this.turns.route(turn); }

  private routeTurn(turn: Turn): Turn { return this.turns.routeTurn(turn); }

  insertDelivered(head: AgentHead, id: string) { this.turns.insertDelivered(head, id); }

  commandEnded(head: AgentHead, id: string, state: CommandState) { this.turns.commandEnded(head, id, state); }

  /** Makes `turn` the one under way and sends it (waking the bot if it sleeps). */
  begin(turn: Turn, head?: AgentHead) { this.turns.launch(turn, head); }

  folderMoved(reason: { told: string; shown: string }) { this.restarts.folderMoved(reason); }

  restartFor(reason: { told: string; shown: string } | null, modelSettings = false, folder = false) { this.restarts.request(reason, modelSettings, folder); }

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

  promptHash(): string { return this.restarts.promptHash(); }

  reloadPlugins() { this.restarts.reloadPlugins(); }

  /** The restart flags change only through these (M7-S58); BotRestart owns them. */
  consumeRestart(old: AgentHead) { return this.restarts.consumed(old); }
  restartEnded() { this.restarts.ended(); }
  dropPluginsOnlyRestart() { this.restarts.dropPluginsOnly(); }
  releaseRestart() { this.restarts.release(); }
  restartSwitchedInPlace(): string { return this.restarts.switchedInPlace(); }

  async deliver(turn: Turn, given?: AgentHead) { return this.delivery.deliver(turn, given); }
  attachmentPath(url: string, line?: string): string | null { return this.delivery.attachmentPath(url, line); }
  compose(turn: Turn, brief: boolean): string { return this.delivery.compose(turn, brief); }
  prompts(): BotPrompts { return this.delivery.prompts(); }

  ensureHead(): AgentHead { return this.headRun.ensureHead(); }

  newSession() { this.headRun.newSession(); }

  private backgroundTurn(head: AgentHead, origin?: "background" | "app"): Turn { return this.headEvents.backgroundTurn(head, origin); }

  onItem(head: AgentHead, item: CodexItem) { return this.headEvents.onItem(head, item); }

  /** Only app-owned coordinator records can update a coordinator's monitor chip (`monitorStateOf`: it runs on a bare object as `this` too). */
  monitorState(monitor: CommandMonitor) { monitorStateOf(this, monitor); }

  onSubagentItem(item: CodexItem): boolean { return (this.workers ?? new BotWorkers(this)).onSubagentItem(item); }
  subagentChanged(subagent: SubagentRecord | undefined, progress?: boolean, redrawLine?: boolean) { this.workers.subagentChanged(subagent, progress, redrawLine); }
  subagentEnded(id: string) { this.workers.subagentEnded(id); }

  emitSteps(turn: Turn) { return this.headEvents.emitSteps(turn); }

  finishTurn(turn: Turn, status: Status, error?: string) { return this.headEvents.finishTurn(turn, status, error); }

  private afterTurn() { return this.headEvents.afterTurn(); }

  clearUnbegun() { this.turns.clearUnbegun(); }

  next(): void { this.turns.next(); }

  async stop(turnId: string, { quitting = false } = {}): Promise<ResultOf<"turn.stop">> { return this.turns.stop(turnId, { quitting }); }

  drained(head: AgentHead) { this.turns.drained(head); }

  async await(turnId: string, signal: AbortSignal): Promise<ResultOf<"turn.await">> { return this.turns.await(turnId, signal); }

  onExit(head: AgentHead, exit: HeadExit) { return this.headEvents.onExit(head, exit); }

  // ------------------------------------------------------------------------------------------
  // The network (1.x's NetworkResume: `recordOutage`, `noteSubagentEnd`, `networkRestored`)

  networkRestored(now = Date.now()) { this.progress.networkRestored(now); }
  clearApiRetry() { this.progress.clearApiRetry(); }

  // ------------------------------------------------------------------------------------------
  // Background work (1.x's BackgroundTask: a chip in the reply, and what a wake is told was cut off)

  addBackgroundTask(id: string, kind: BackgroundKind, title: string) { (this.tasks ?? new BotTasks(this)).addBackgroundTask(id, kind, title); }
  endBackground(id: string, status: string, summary: string | null) { this.tasks.endBackground(id, status, summary); }

  get ownWorkRunning(): boolean { return this.tasks.ownWorkRunning; }

  checkSettingsHold() { this.restarts.checkSettingsHold(); }

  takeInterruptedNote(): string { return this.recordsBook.takeInterruptedNote(); }

  // ------------------------------------------------------------------------------------------
  // Quiet runs (1.x's `checkStall`, `noteProgress`)

  // ------------------------------------------------------------------------------------------
  // Sleeping

  clearIdle() { this.headRun.clearIdle(); }

  sleep(options: { tidyMs?: number } = {}): Promise<void> { return this.headRun.sleep(options); }

  maintenance(text: string, timeoutMs: number, head: AgentHead): Promise<string | null> { return this.headRun.maintenance(text, timeoutMs, head); }

  // ------------------------------------------------------------------------------------------
  // Routines (Routines.swift, ScheduledRoutines.swift; the clock is the core's, `Core.checkRoutines`)

  changeRoutine(args: Record<string, unknown>): ResultOf<"routines.change"> { return this.routines.changeRoutine(args); }
  checkRoutines(now?: number) { this.routines.checkRoutines(now); }

  // ------------------------------------------------------------------------------------------
  // Components and cards: moved to BotCards (M7-S43); one-line delegates keep every name

  get commandFolder(): string { return this.cards.commandFolder; }
  componentNote(): string { return this.cards.componentNote(); }
  static pluginCard(card: string): boolean { return BotCards.pluginCard(card); }

  // ------------------------------------------------------------------------------------------
  // Approvals and blocked calls (BotQuestions, M7-S44)

  ask(head: AgentHead, item: Extract<StreamItem, { kind: "permission" }>, turn: Turn | null) { return this.questions.ask(head, item, turn); }
  private tellReviewOutcome(approval: Approval, allowed: boolean, words?: string) { return this.questions.tellReviewOutcome(approval, allowed, words); }
  get allowRules(): string[] { return this.questions.allowRules; }
  /** Something only the app says, to this head: wakes it like a message (`Bot.appMessage`). */
  tellHead(text: string) {
    this.owner.deliverTo(this.engine, text, null, { origin: "app" });
  }

  /** The coordinator turn ended/stopped; a monitor or managed worker may still be waiting. */
  settleTurnApprovals() { this.questions.settleTurnApprovals(); }
  settle(id: string, answer: string, deny: boolean) { this.questions.settle(id, answer, deny); }
  /** A button on a question: an approval's action, or a bot's own question answered with the pick's label (`Bot.choose`). */
  choose(messageId: string, index: number, notes?: string): ResultOf<"chat.choose"> { return this.questions.choose(messageId, index, notes); }
  /** `Bot.answer`: the user answered a question in their own words instead of a button. */
  answer(messageId: string, text: string, files: string[] = [], picks?: QuestionPick[]): ResultOf<"chat.answer"> { return this.questions.answer(messageId, text, files, picks); }

  react(messageId: string, emoji: string, present: boolean): ResultOf<"chat.react"> { return this.recordsBook.react(messageId, emoji, present); }
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
    if (this.claimHold) { clearTimeout(this.claimHold.timer); this.claimHold.turn.resolve("stopped"); this.group.dropClaim(); }
    const partner = Promise.allSettled(this.peers.map(peer => peer.shutdown({ tidy }))).then(results => results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason);
    this.clearIdle();
    this.clearApiRetry();
    this.shuttingDown = true;
    // Messages still waiting never reached claude.
    for (const waiting of this.turns.dequeueAll()) { waiting.open = false; waiting.resolve("stopped"); }
    const held = this.settingsHold;
    if (held) {
      clearInterval(held.timer);
      this.settingsHold = null;
      const card = this.owner.records.find((record) => record.id === held.noticeId);
      if (card) { card.text = "Model or effort change was waiting for active work to finish; the app quit first, so the queued message was not sent."; this.owner.changed(card); }
    }
    if (this.deferred) { this.deferred.open = false; this.deferred.resolve("stopped"); this.turns.takeBack(); }
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
