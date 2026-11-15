// BotRestart (M7-S51): when and how its head starts again, and the core hot swap. A restart that waits for its next message
// (`restartFor`, `restartBeforeNextMessage`, `folderMoved`, `restartNow`, `reloadPlugins`), the held message while its own work
// runs (`holdForSettings` ... `checkSettingsHold`), the plugin stamp and prompt hash a head is compared by, and the hand-over
// to a new core: `holdForSwap`, `swapEntries`, `restartEntries`, `restartPaused`, `adoptRestart`, `adoptSwap`. It owns the
// fields of that state (`restartPending`, `settingsHold`, `swapHold`, `restartRecovery` ...). It follows the bridge convention
// of `core/bot/context.ts`: the moved bodies are what they were in `Bot` and say `this.owner`, `this.head`, `this.next()`;
// the BRIDGE BLOCK below is every name it borrows, one forwarder each: the shared names through `ctx`, `Bot`'s own through
// `host`. `Bot` keeps a one-line delegate (and accessors for the fields) for every name moved here.
import { ContractError } from "../../contract";
import { createHash } from "node:crypto";
import { nativeRestartContext } from "../claude-restart";
import { claudeConfigFolder } from "../claude-files";
import { CodexHead } from "../agent/codex";
import { ClaudeHead } from "../agent/head";
import { ownProcessWorker } from "../agent/workers";
import type { Bot } from "../bot";
import type { BotContext } from "./context";
import { displayName, type Engine } from "../heads";
import { CONTINUE_NOTE, type SwapEntry } from "../hot-swap";
import { PLUGINS_RESTART, type AgentHead, type BotOptions, type Origin, type Turn } from "./types";
import { RESEND_WAITING, RESTART_NOTE, restartPausedNotice, type RestartEntry } from "../restart-continuation";
import { newId, toSwiftDate, type ChatRecord } from "../store/records";
import type { BotStore } from "../store/bot-store";
import type { SubagentBook } from "../subagents";
import type { WorkerLedgerRecord } from "../worker-core";

export class BotRestart {
  constructor(private readonly host: Bot, private readonly ctx: BotContext) {}

  // ---- Bridge: the names borrowed from `Bot` (one line each) ----
  private get options(): BotOptions { return this.ctx.options; }
  private get store(): BotStore { return this.ctx.store; }
  private get subagents(): SubagentBook { return this.ctx.subagents; }
  private get engine(): Engine { return this.ctx.engine; }
  private get owner(): Bot { return this.ctx.owner; }
  private get members(): Bot[] { return this.ctx.members; }
  private get partner(): Bot | null { return this.ctx.partner; }
  private get peers(): Bot[] { return this.ctx.peers; }
  private botFor(head: Engine): Bot | null { return this.ctx.botFor(head); }
  private log(line: string) { this.ctx.log(line); }
  private get head(): AgentHead | null { return this.host.head; }
  private get loadedPluginStamp(): string[] | null { return this.host.loadedPluginStamp; }
  private get tidying(): boolean { return this.host.tidying; }
  private get claimHold() { return this.host.claimHold; }
  private get deferred(): Turn | null { return this.host.deferred; }
  private get guestTurn(): boolean { return this.host.guestTurn; }
  private get managedPending(): boolean { return this.host.managedPending; }
  private get queue(): Turn[] { return this.host.queue; }
  private get switching(): boolean { return this.host.switching; }
  private get turn(): Turn | null { return this.host.turn; }
  private get paused() { return this.host.paused; }
  private get ownWorkRunning(): boolean { return this.host.ownWorkRunning; }
  private ownWorkWords(): string { return this.host.ownWorkWords(); }
  private appNotice(text: string, choices?: { label: string; recommended?: boolean; detail?: string }[], onPick?: (index: number) => void): string { return this.host.appNotice(text, choices, onPick); }
  private deliverTo(...args: Parameters<Bot["deliverTo"]>): Turn { return this.host.deliverTo(...args); }
  private next() { this.host.next(); }
  private persist(soon?: boolean) { this.host.persist(soon); }
  private prompts() { return this.host.prompts(); }
  private updated() { this.host.updated(); }

  // ---- Fields owned here (`Bot` reads and writes them through accessors) ----
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
  settingsGeneration = 0;
  /**
   * Your message waits for this head's own work (its subagents, workers, background tasks) to finish, so a
   * model or effort change that needs a restart can be applied first; it is sent then, never on the old
   * settings. `noticeId`: the chat card that says so.
   */
  settingsHold: { noticeId: string; timer: ReturnType<typeof setInterval> } | null = null;
  /** Why it starts again before its next message (1.x's `RestartReason`): what it is told, what its divider says. */
  restartReason: { told: string; shown: string } | null = null;
  /** The restart waiting is only for plugins: when they changed back, it is not needed (1.x's `pendingRestartForPluginsOnly`). */
  restartForPluginsOnly = false;
  /** A head ended for such a restart: its session carries on. */
  restarting: AgentHead | null = null;
  /** The core is being swapped: no turn begins (hot-swap.ts). */
  swapHold = false;
  restartRecovery = false;
  restartProviderTurn?: string;
  restartWorkerRecords?: import('../agent/codex').WorkerRecord[];
  /** The restart's time: its next Codex head checks and resumes the workers its ledger says that restart interrupted. */
  restartWorkersSince?: number;

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


  /** The prompt hash head.json kept for this session (the old core wrote it): none for an older file or another session. */
  savedPromptHash(sessionId: string): { promptHash?: string } {
    const saved = this.store.loadHead();
    return saved?.sessionId === sessionId && saved.promptHash ? { promptHash: saved.promptHash } : {};
  }

  /** A hash of the system prompt this head's session would be created with now (engine differences included). */
  promptHash(): string {
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

  /** `turn` (your message) waits for this head's own work to finish before its model/effort restart; a card says so. */
  holdForSettings(turn: Turn) {
    this.host.turns.enqueueFirst(turn);
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
  releaseSettingsHold(): boolean {
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
    this.host.turns.endPause();
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
    const peers = (this.host as Bot & { readonly peers?: Bot[] }).peers;
    return [this.host, ...(peers ?? (this.partner ? [this.partner] : []))].flatMap(bot => {
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
        bot.turns.enqueue(turn);
      }
      if (!bot.turn) bot.next();
      this.log(`restart ${entry.botId}: the ${waiting.length} message(s) that waited were sent at the user's pick`);
    });
  }

  adoptRestart(entry: RestartEntry) {
    const bot=this.host.retainRestartIdentity(entry);
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
}
