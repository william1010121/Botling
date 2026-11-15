// BotHead (M7-S51): the process of a bot and its session. Starting the head (`ensureHead`: which CLI, which session, a new one
// when its prompt changed), what a head starts with (`sessionStart`, `settingsTarget`), taking a new model or effort in place
// (`canSwitchInPlace`, `switchInPlace`), a new session (`newSession`), the reply line a turn writes (`place`), and sleeping:
// the idle timer, the tidy, `maintenance` and `internal` turns. It owns the fields of that state (`head`, `session`,
// `briefing`, `tidying`, `idleTimer`, `startedFresh` ...). It follows the bridge convention of `core/bot/context.ts`: the moved
// bodies are what they were in `Bot` and say `this.options`, `this.restartPending`, `this.onItem(...)`; the BRIDGE BLOCK below is
// every name it borrows, one forwarder each: the shared names through `ctx`, `Bot`'s own (and BotRestart's, through `Bot`) through
// `host`. A forwarder that sets another owner's field is allowed only until the refinement cards replace it by a named
// transition on the owner. `Bot` keeps a one-line delegate (and accessors for the fields) for every name moved here.
import { randomUUID } from "node:crypto";
import { ContractError } from "../../contract";
import { AGY_EXECUTION_BLOCKED } from "../agent/agy";
import { AgyAcpHead } from "../agent/agy-acp";
import { CLAUDE_AGENT_GUARD, CLAUDE_APP_SERVER, CLAUDE_APP_TOOLS, CLAUDE_ROUTINE_TOOLS, type ClaudeWorkers } from "../agent/claude-workers";
import { CodexHead, type CodexItem } from "../agent/codex";
import { ClaudeHead, type HeadExit } from "../agent/head";
import type { HotSettings } from "../agent/hot-settings";
import type { Bot } from "../bot";
import { isBotTool, type BotToolName, type ToolCaller } from "../bot-tools";
import type { SeenReactions } from "../briefing";
import type { ComponentKnowledge } from "../components/library";
import type { BotContext } from "./context";
import type { Engine, Heads } from "../heads";
import type { Outage } from "../network-resume";
import { isPlainOK, type BotPrompts } from "../prompts";
import type { BotSettingsView } from "../../contract";
import { newId, toSwiftDate, type ChatRecord } from "../store/records";
import type { BotStore, HeadState } from "../store/bot-store";
import type { SubagentRecord } from "../subagents";
import type { WorkerCoreFactory } from "../worker-core";
import { PROMPT_SESSION_DIVIDER, type AgentHead, type Approval, type BotOptions, type Origin, type PresetTurnIds, type SessionStart, type Turn } from "./types";
import { sleep } from "./view-functions";

export class BotHead {
  constructor(private readonly host: Bot, private readonly ctx: BotContext) {}

  // ---- Bridge: the names borrowed from `Bot` (one line each) ----
  private get options(): BotOptions { return this.ctx.options; }
  private get store(): BotStore { return this.ctx.store; }
  private get engine(): Engine { return this.ctx.engine; }
  private get owner(): Bot { return this.ctx.owner; }
  private get profile() { return this.ctx.profile; }
  private get heads(): Heads { return this.ctx.heads; }
  private get sharesChat(): boolean { return this.ctx.sharesChat; }
  private requireEngineRoute(head: Engine, from?: Engine) { this.ctx.requireEngineRoute(head, from); }
  private log(line: string) { this.ctx.log(line); }
  private get readOnly(): boolean { return this.host.readOnly; }
  private get approvals(): Map<string, Approval> { return this.host.approvals; }
  private get draining() { return this.host.draining; }
  private get managedPending(): boolean { return this.host.managedPending; }
  private get outage(): Outage | null { return this.host.outage; }
  private get queue(): Turn[] { return this.host.queue; }
  private get shuttingDown(): boolean { return this.host.shuttingDown; }
  private get steered(): Map<string, Turn> { return this.host.steered; }
  private get allowRules(): string[] { return this.host.allowRules; }
  private get backgroundWorkRunning(): boolean { return this.host.backgroundWorkRunning; }
  private get inHeadSubagents(): SubagentRecord[] { return this.host.inHeadSubagents; }
  private get routineStorePath(): string | null { return this.host.routineStorePath; }
  private get workerCore(): WorkerCoreFactory { return this.host.workerCore; }
  private get turn(): Turn | null { return this.host.turn; }
  private set turn(v: Turn | null) { this.host.turn = v; }
  private get ignoreResults(): number { return this.host.ignoreResults; }
  private set ignoreResults(v: number) { this.host.ignoreResults = v; }
  private get switchTo(): Engine | null { return this.host.switchTo; }
  private set switchTo(v: Engine | null) { this.host.switchTo = v; }
  private get queuedNote(): string | null { return this.host.queuedNote; }
  private set queuedNote(v: string | null) { this.host.queuedNote = v; }
  private get reactionsSeen(): SeenReactions | null { return this.host.reactionsSeen; }
  private set reactionsSeen(v: SeenReactions | null) { this.host.reactionsSeen = v; }
  private get briefedComponents(): ComponentKnowledge | null { return this.host.briefedComponents; }
  private set briefedComponents(v: ComponentKnowledge | null) { this.host.briefedComponents = v; }
  private add(record: ChatRecord, options?: { archive?: boolean }) { this.host.add(record, options); }
  private becomeEngine(to: Engine) { this.host.becomeEngine(to); }
  private begin(turn: Turn, head?: AgentHead) { this.host.begin(turn, head); }
  private botTool(name: BotToolName, args: Record<string, unknown>, caller?: ToolCaller): Promise<unknown> { return this.host.botTool(name, args, caller); }
  private claudeWorkersOn(): boolean { return this.host.claudeWorkersOn(); }
  private ensureClaudeWorkers(): ClaudeWorkers { return this.host.ensureClaudeWorkers(); }
  private newTurn(origin: Origin, words: string, userId: string | null, ids?: PresetTurnIds): Turn { return this.host.newTurn(origin, words, userId, ids); }
  private next() { this.host.next(); }
  private onExit(head: AgentHead, exit: HeadExit) { this.host.onExit(head, exit); }
  private onItem(head: AgentHead, item: CodexItem) { this.host.onItem(head, item); }
  private onWorkerOutput(item: CodexItem) { this.host.onWorkerOutput(item); }
  private prompts(): BotPrompts { return this.host.prompts(); }
  private promptHash(): string { return this.host.promptHash(); }
  private routinesTool(args: Record<string, unknown>) { return this.host.routinesTool(args); }
  private settingsView(): BotSettingsView { return this.host.settingsView(); }
  private syncWorkerOwners() { this.host.syncWorkerOwners(); }
  private updated() { this.host.updated(); }
  // The restart state it reads and clears is BotRestart's (through `Bot`):
  private get restartPending(): boolean { return this.host.restartPending; }
  private set restartPending(v: boolean) { this.host.restartPending = v; }
  private get modelSettingsPending(): boolean { return this.host.modelSettingsPending; }
  private set modelSettingsPending(v: boolean) { this.host.modelSettingsPending = v; }
  private get folderPending(): boolean { return this.host.folderPending; }
  private set folderPending(v: boolean) { this.host.folderPending = v; }
  private get restartNonModel(): boolean { return this.host.restartNonModel; }
  private set restartNonModel(v: boolean) { this.host.restartNonModel = v; }
  private get restartForPluginsOnly(): boolean { return this.host.restartForPluginsOnly; }
  private set restartForPluginsOnly(v: boolean) { this.host.restartForPluginsOnly = v; }
  private get restartReason() { return this.host.restartReason; }
  private set restartReason(v) { this.host.restartReason = v; }
  private get settingsGeneration(): number { return this.host.settingsGeneration; }
  private get settingsHold() { return this.host.settingsHold; }
  private get restartRecovery(): boolean { return this.host.restartRecovery; }
  private get restartProviderTurn() { return this.host.restartProviderTurn; }
  private set restartProviderTurn(v) { this.host.restartProviderTurn = v; }
  private get restartWorkerRecords() { return this.host.restartWorkerRecords; }
  private set restartWorkerRecords(v) { this.host.restartWorkerRecords = v; }
  private get restartWorkersSince() { return this.host.restartWorkersSince; }
  private set restartWorkersSince(v) { this.host.restartWorkersSince = v; }

  // ---- Fields owned here (`Bot` reads and writes them through accessors) ----
  head: AgentHead | null = null;
  startupActive = false;
  /** Tidying memory.md before it sleeps. */
  tidying = false;
  session!: HeadState;
  /** The next head is a new session: its first message carries the wake briefing. */
  briefing = true;
  /** The plugins' Claude parts its process started with (1.x's `loadedPluginStamp`). */
  loadedPluginStamp: string[] | null = null;
  /** What its process has cost so far (claude's `total_cost_usd`, a running total; 1.x's `sessionCost`). */
  sessionCost = { last: 0 };
  idleTimer: NodeJS.Timeout | null = null;
  /** While tidying, a Codex worker's report turn on the memory update (`internalReply` kept open in 1.x). */
  tidyFollowUp: ((text: string) => void) | null = null;
  /** "Restart bot" on a claude head: its next start is a new session, whatever its prompt hash says. */
  freshSessionPending = false;
  /** ensureHead began a new session for the message being sent (its briefing says it all; no restart note). */
  startedFresh = false;

  /** A session handed over by the old core is resumed as it is once (a cut-off turn goes on exactly where it stopped). */
  adoptedSession = false;

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
  sessionStart(resume: boolean, prompts: BotPrompts): SessionStart {
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
  canSwitchInPlace(head: AgentHead): boolean {
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
  place(turn: Turn): ChatRecord {
    if (turn.record) return turn.record;
    const record: ChatRecord = { id: turn.messageId, role: "bot", text: "", date: toSwiftDate(), turnID: turn.id, state: "streaming", engine: this.engine };
    if (this.sharesChat) record.seenBy = [this.engine];
    turn.record = record;
    this.add(record, { archive: false });
    return record;
  }

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
}
