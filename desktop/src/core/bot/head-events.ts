// HeadEvents (M7-S53): what a head says and what becomes of it. The turn a head's words belong to (`backgroundTurn` for
// a turn claude starts by itself), each stream item it sends (`onItem`: init, usage, deltas, tool calls and results,
// permissions, the end of a turn, background work, schedules), the reply drawn so far (`showSoFar`), a monitored
// command that ended (`monitorEnded`), the steps and the end of a turn (`emitSteps`, `finishTurn`, `afterTurn`) and the
// head's process ending (`onExit`). It owns no field: it reads and writes the ones `Bot` keeps. It follows the bridge
// convention of `core/bot/context.ts`: the moved bodies are what they were in `Bot` and say `this.turn`, `this.records`,
// `this.finishTurn(...)`; the BRIDGE BLOCK below is every name they borrow, one forwarder each. The names every part of a
// bot shares go to `ctx`; the fields and methods of `Bot` itself go to `host`. `Bot` keeps a one-line delegate for every
// name moved here (`monitorState` is `monitorStateOf` below: monitor-policy.test.ts calls `Bot.prototype.monitorState` on a bare object as `this`).
import { isAgyConversationGone } from "../agent/agy-acp";
import type { CodexItem } from "../agent/codex";
import { monitorTask, type CommandMonitor } from "../agent/monitors";
import type { HeadExit } from "../agent/head";
import { commandEnded, ReplyText, type CommandState, type StreamItem } from "../agent/stream";
import type { ApprovalAnswerer, HostFacts } from "../agent-registry";
import { backgroundOutputFile } from "../background-work";
import type { BackgroundKind, BackgroundTask } from "../background-tasks";
import type { Bot, Status } from "../bot";
import { archiveLine } from "../briefing";
import type { CallInRelay } from "../call-in-work";
import { keepLineMedia } from "../chat-media";
import type { Event, MessageView } from "../../contract";
import type { Engine } from "../heads";
import { parseHeadTags } from "../heads";
import { headTurnContent, headTurnEnd } from "../head-turn";
import { connectionErrorLine, lostText, mentionsConnectionError } from "../network-resume";
import { apiGaveUpText, apiRetryDelays } from "../api-retry";
import { parseReply, unsupportedRequest, type BotRequest, type Display } from "../reply";
import { scheduleCall, scheduledTask, scheduleCancellation, type ScheduleCancellation } from "../session-schedules";
import { newId, toSwiftDate, type ChatRecord, type StepRecord } from "../store/records";
import type { BotStore, HeadState } from "../store/bot-store";
import { SUBAGENT_TOOLS, type SubagentBook, type SubagentRecord } from "../subagents";
import type { RequestEvent } from "../token-speed";
import { totalTokens } from "../usage";
import { costDelta, hasVisibleContent } from "../worker-core";
import type { BotContext } from "./context";
import { NEW_SESSION_DIVIDER, NO_LONGER_NEEDED, type AgentHead, type BotOptions, type Origin, type PresetTurnIds, type Turn } from "./types";
import { stepView, streamingText, subagentOf, union } from "./view-functions";

export class HeadEvents {
  constructor(private readonly host: Bot, private readonly ctx: BotContext) {}

  // ---- Bridge: the names borrowed from `Bot` and from the context (one line each) ----
  // Shared with every part of a bot (`ctx`):
  private get options(): BotOptions { return this.ctx.options; }
  private get store(): BotStore { return this.ctx.store; }
  private get engine(): Engine { return this.ctx.engine; }
  private get subagents(): SubagentBook { return this.ctx.subagents; }
  private get owner(): Bot { return this.ctx.owner; }
  private get id() { return this.ctx.id; }
  private get paths() { return this.ctx.paths; }
  private get sharesChat(): boolean { return this.ctx.sharesChat; }
  private log(line: string) { this.ctx.log(line); }
  private emit(event: Event) { this.ctx.emit(event); }
  // Fields of `Bot` it only reads:
  private get records(): ChatRecord[] { return this.host.records; }
  private get session(): HeadState { return this.host.session; }
  private get approvals(): Bot["approvals"] { return this.host.approvals; }
  private get claudeMidTurn(): WeakSet<AgentHead> { return this.host.claudeMidTurn; }
  private get draining(): Bot["draining"] { return this.host.draining; }
  private get ending(): WeakSet<AgentHead> { return this.host.ending; }
  private get managedHandbacks(): Set<string> { return this.host.workers.managedHandbacks; }
  private get managedTaskHandoffs(): Map<string, string> { return this.host.workers.managedTaskHandoffs; }
  private get outage(): Bot["outage"] { return this.host.outage; }
  private get restartRecovery(): boolean { return this.host.restartRecovery; }
  private get scheduleCalls(): Bot["scheduleCalls"] { return this.host.scheduleCalls; }
  private get sessionCost(): Bot["headRun"]["sessionCost"] { return this.host.headRun.sessionCost; }
  private get shuttingDown(): boolean { return this.host.shuttingDown; }
  private get steered(): Map<string, Turn> { return this.host.steered; }
  private get tidyFollowUp(): Bot["headRun"]["tidyFollowUp"] { return this.host.headRun.tidyFollowUp; }
  private get tidying(): boolean { return this.host.tidying; }
  private get toolCalls(): Bot["toolCalls"] { return this.host.toolCalls; }
  private get unbegun(): Bot["unbegun"] { return this.host.unbegun; }
  private get inHeadSubagents(): SubagentRecord[] { return this.host.tasks.inHeadSubagents; }
  private get lineMediaStore(): string { return this.host.delivery.lineMediaStore; }
  // Fields of `Bot` it writes (a setter for another owner's field: M7-S54 ... replace these by named transitions):
  // BotHead's transitions (M7-S57):
  private briefingDue() { this.host.headRun.briefingDue(); }
  private sessionStarted() { this.host.headRun.sessionStarted(); }
  private sessionRenamed(sessionId: string) { this.host.headRun.sessionRenamed(sessionId); }
  private get head(): AgentHead | null { return this.host.head; }
  private detach() { this.host.headRun.detach(); }
  private get ignoreResults(): number { return this.host.ignoreResults; }
  private get restarting(): AgentHead | null { return this.host.restarting; }
  private get retryingConnection(): boolean { return this.host.retryingConnection; }
  private get progress() { return this.host.progress; }
  private get tasks() { return this.host.tasks; }
  private get turn(): Turn | null { return this.host.turn; }
  private get turns() { return this.host.turns; }
  // Methods of `Bot`:
  private add(record: ChatRecord) { return this.host.add(record); }
  private addBackgroundTask(id: string, kind: BackgroundKind, title: string) { return this.host.addBackgroundTask(id, kind, title); }
  private addSubagentTask(ownerId: string, id: string, kind: BackgroundKind, title: string, detail: string) { return this.host.tasks.addSubagentTask(ownerId, id, kind, title, detail); }
  private afterReplyHooks(record: ChatRecord) { return this.host.views.afterReplyHooks(record); }
  private applyReactions(actions: { messageId: string; emoji: string; present: boolean }[]) { return this.host.recordsBook.applyReactions(actions); }
  private ask(head: AgentHead, item: Extract<StreamItem, { kind: "permission" }>, turn: Turn | null) { return this.host.ask(head, item, turn); }
  private associateDecision(record: ChatRecord, reference: string | null, turn: Turn) { return this.host.associateDecision(record, reference, turn); }
  private bumpUnread() { return this.host.bumpUnread(); }
  private cancelScheduled(cancellation: ScheduleCancellation, turn: Turn | null) { return this.host.tasks.cancelScheduled(cancellation, turn); }
  private changed(record: ChatRecord) { return this.host.changed(record); }
  private clearCodexRetry() { return this.host.progress.clearCodexRetry(); }
  private clearIdle() { return this.host.clearIdle(); }
  private clearUnbegun() { return this.host.clearUnbegun(); }
  private commandEnded(head: AgentHead, id: string, state: CommandState) { return this.host.commandEnded(head, id, state); }
  private deliver(turn: Turn, given?: AgentHead) { return this.host.deliver(turn, given); }
  private drained(head: AgentHead) { return this.host.drained(head); }
  private findTask(id: string): BackgroundTask | undefined { return this.host.tasks.findTask(id); }
  private handleRequests(requests: BotRequest[]): BotRequest[] { return this.host.decisions.handleRequests(requests); }
  private headStopped(head: Engine) { return this.host.group.headStopped(head); }
  private headWords(words: string) { return this.host.group.headWords(words); }
  private hostFacts(): HostFacts { return this.host.workers.hostFacts(); }
  private insertDelivered(head: AgentHead, id: string) { return this.host.insertDelivered(head, id); }
  private keepTasks(turn: Turn, record: ChatRecord | null) { return this.host.tasks.keepTasks(turn, record); }
  private messageView(record: ChatRecord): MessageView { return this.host.messageView(record); }
  private monitorState(monitor: CommandMonitor) { return this.host.monitorState(monitor); }
  private newSession() { return this.host.newSession(); }
  private newTurn(origin: Origin, words: string, userId: string | null, ids?: PresetTurnIds): Turn { return this.host.newTurn(origin, words, userId, ids); }
  private next(): void { return this.host.next(); }
  private noteCodexRetry(item: Extract<CodexItem, { kind: "apiRetry" }>) { return this.host.progress.noteCodexRetry(item); }
  private noteProgressOf(item: CodexItem) { return this.host.progress.noteProgressOf(item); }
  private noteRequest(event: RequestEvent) { return this.host.views.noteRequest(event); }
  private noteToolCall(item: Extract<StreamItem, { kind: "toolUse" }>) { return this.host.questions.noteToolCall(item); }
  private notice(text: string) { return this.host.notice(text); }
  private onItemPending(pending: boolean) { return this.host.workers.onItemPending(pending); }
  private onSubagentItem(item: CodexItem): boolean { return this.host.onSubagentItem(item); }
  private persist(soon?: boolean) { return this.host.persist(soon); }
  private place(turn: Turn): ChatRecord { return this.host.headRun.place(turn); }
  private placeSubagentTask(ownerId: string, task: BackgroundTask) { return this.host.tasks.placeSubagentTask(ownerId, task); }
  private recordOutage(found: { turnFailed?: boolean; subagents?: string[]; lostSession?: string | null }) { return this.host.progress.recordOutage(found); }
  private refreshScheduleDue() { return this.host.tasks.refreshScheduleDue(); }
  private relayFollowUp(turn: Turn, status: Status, record: ChatRecord | null, error?: string) { return this.host.workers.relayFollowUp(turn, status, record, error); }
  private relayIfCallInWork(turn: Turn, workerId: string | null | undefined, news: CallInRelay["news"]) { return this.host.workers.relayIfCallInWork(turn, workerId, news); }
  private remove(record: ChatRecord) { return this.host.remove(record); }
  private reportFinished(ids: string[]) { return this.host.turns.reportFinished(ids); }
  private retryApiLater(turn: Turn): boolean { return this.host.progress.retryApiLater(turn); }
  private routeWorkerApproval(head: ApprovalAnswerer, item: Extract<StreamItem, { kind: "permission" }>): boolean { return this.host.routeWorkerApproval(head, item); }
  private routinesEdited() { return this.host.routines.routinesEdited(); }
  private saveSubagents(progress?: boolean, changed?: SubagentRecord) { return this.host.saveSubagents(progress, changed); }
  private settle(id: string, answer: string, deny: boolean) { return this.host.settle(id, answer, deny); }
  private settleSessionSchedules() { return this.host.tasks.settleSessionSchedules(); }
  private settleTurnApprovals() { return this.host.settleTurnApprovals(); }
  private showDenial(denial: Extract<StreamItem, { kind: "permissionDenied" }>) { return this.host.questions.showDenial(denial); }
  private steeredStarted(head: AgentHead, next: Turn) { return this.host.turns.steeredStarted(head, next); }
  private stopTasks() { return this.host.tasks.stopTasks(); }
  private takeHandback(turn: Turn): boolean { return this.host.workers.takeHandback(turn); }
  private touchTask(id: string) { return this.host.tasks.touchTask(id); }
  private updated() { return this.host.updated(); }

  // ---- Moved from `Bot` ----
  /** Claude started a turn of its own (a background subagent told it something; `app`: the other head's words it answers). */
  backgroundTurn(head: AgentHead, origin: "background" | "app" = "background"): Turn {
    // While tidying, the app's own turns (a Codex worker's report on the memory file) are the tidy's.
    const turn = this.newTurn(this.tidying ? "tidy" : origin, "", null);
    if (this.tidying) turn.onReply = (text) => this.tidyFollowUp?.(text);
    turn.head = head;
    turn.sent = true;
    this.turns.start(turn);
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
      if (!this.retryingConnection) { this.progress.retryingStarted(); this.updated(); }
      return;
    }
    // Codex waiting on a retry is no step either; the bot shows it until the turn moves on.
    if (item.kind === "apiRetry") return this.noteCodexRetry(item);
    if (!subagentOf(item) && item.kind !== "managedPending" && item.kind !== "rateLimits") this.clearCodexRetry();
    if (item.kind === "connectionLost") {
      if (item.parent) this.host.workers.lostToNetwork(item.parent);
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
      if (!this.session.started) { this.sessionStarted(); save = true; }
      if (item.sessionId && item.sessionId !== this.session.sessionId && /^[0-9a-f-]{36}$/i.test(item.sessionId)) { this.sessionRenamed(item.sessionId); save = true; }
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
      if (item.state === "started") this.turns.midTurnStarted(head);
      // claude begins a turn: the one set aside is under way after all (or another first, whose result tells).
      if (item.state === "started" && this.unbegun?.head === head) this.clearUnbegun();
      const steered = this.steered.get(item.id);
      if (steered) {
        if (item.state === "started") { this.turns.steerSettled(item.id); if (!mid) this.steeredStarted(head, steered); }
        return;
      }
      // The other head's words, read too late for the turn they were meant for: claude answers them
      // in a turn of its own, the app's (its words show; <no-reply/> shows nothing). A message of
      // ours sent after them but not begun yet waits for that turn to end.
      if (item.state !== "started" || !this.turns.contextSettled(item.id) || mid || this.ignoreResults || this.draining) return;
      const waiting = this.turn;
      if (waiting && (!waiting.open || waiting.head !== head || waiting.reply.text || waiting.steps.length || waiting.record)) return;
      if (waiting) this.turns.setAside(waiting);
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
      if (call) this.tasks.scheduleCalled(item.id, call);
    }
    if (item.kind === "scheduleResult" && item.parent) {
      const call = this.scheduleCalls.get(item.id);
      this.tasks.scheduleSettled(item.id);
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
    if (item.kind === "result") this.turns.midTurnEnded(head);
    else this.turns.midTurnStarted(head);
    // Output of a turn: claude began the one set aside after all.
    if (item.kind !== "result" && this.unbegun?.head === head) this.clearUnbegun();
    // The tail of a turn that was cut off: it belongs to nobody.
    if (this.ignoreResults > 0) {
      if (item.kind === "permission") head.answer(item.requestId, false, item.input, "Not now: that turn has ended.");
      if (item.kind === "result") this.turns.ignoredArrived();
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
      this.tasks.scheduleSettled(item.id);
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
        if (call) this.tasks.scheduleCalled(item.id, call);
        // The words claude said before this call: the other head hears them now.
        const said = turn.reply.text.slice(turn.told).trim();
        if (said && turn.origin !== "tidy") { turn.told = turn.reply.text.length; this.headWords(streamingText(said)); }
        const isSubagent = SUBAGENT_TOOLS.has(item.tool);
        turn.steps.push({ id: item.id, kind: isSubagent ? "subagent" : "tool", tool: item.tool, title: item.title, detail: item.detail, failed: false, done: false });
        this.emitSteps(turn);
        return;
      }
      case "toolResult": {
        this.tasks.scheduleSettled(item.id);
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
          this.progress.apiRetriesReset();
          turn.reply = new ReplyText();
          this.finishTurn(turn, "failed", apiGaveUpText(apiRetryDelays().length, item.error || item.text));
          return;
        }
        if (turn.origin !== "tidy") this.progress.apiRetriesReset();
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
  showSoFar(turn: Turn) {
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

  /** A monitored command ended: its step, in the reply of the turn that started it, is done. */
  monitorEnded(id: string, output: string, failed: boolean) {
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

  emitSteps(turn: Turn) {
    if (turn.origin === "tidy" || turn !== this.turn) return;
    this.emit({ type: "turn.steps", botId: this.id, turnId: turn.id, messageId: turn.messageId, steps: turn.steps.slice(-500).map((step) => stepView(step, this.subagents)) });
  }

  finishTurn(turn: Turn, status: Status, error?: string) {
    if (this.unbegun?.turn === turn) this.clearUnbegun();
    if (!turn.open) return;
    turn.open = false;
    if (this.turn === turn) this.turns.close();
    this.clearCodexRetry();
    if (turn.origin === "tidy") {
      if (turn.callIn) this.updated();
      turn.onReply?.(status === "done" ? turn.reply.text : "");
      this.turns.recordFinished(turn.id, status);
      turn.resolve(status);
      this.settleTurnApprovals();
      return; // sleep() goes on from here.
    }
    const raw = turn.reply.text;
    const parsed = parseReply(raw);
    // A hand-off to the other head is the app's, not the chat's.
    const tags = status === "done" ? parseHeadTags(parsed.body) : { body: parsed.body, handoff: null };
    const ended = turn.origin === "background" ? [...this.turns.takeEnded(), ...turn.ended] : turn.ended;
    if (status === "done") this.applyReactions(parsed.reactions);
    if (status === "done" && parsed.pluginTags) this.options.pluginTags?.(this.owner, parsed.pluginTags);
    // Nothing for the user, whoever started the turn: no bubble (`headTurnContent` says what the head keeps out).
    const content = headTurnContent({ status, origin: turn.origin, sharesChat: this.sharesChat, raw, parsed, body: tags.body, handoff: !!tags.handoff, steps: turn.steps.length, error: error ?? null });
    // A turn cut off with no words of its own (`steeredNow`) shows nothing either: an interrupted reply has no bubble.
    if (!hasVisibleContent(content) || (status === "stopped" && !tags.body.trim())) {
      if (turn.record) this.remove(turn.record);
      this.keepTasks(turn, null);
      this.emit({ type: "turn.finished", botId: this.id, turnId: turn.id, messageId: turn.messageId, status, text: "" });
      this.turns.recordFinished(turn.id, status);
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
        this.owner.cards.drewComponents((parsed.displays as Display[]).map((display) => display.name));
      }
      this.associateDecision(record, parsed.decisionReference, turn);
      // <show id="tests"> updates that card in place; a reply that is only that shows no line of its own.
      if (record.displays?.some((display) => (display as Display).id)) {
        record.text = text;
        if (this.owner.cards.updateCards(record) && !turn.steps.length) {
          if (!fresh) this.remove(record);
          this.emit({ type: "turn.finished", botId: this.id, turnId: turn.id, messageId: turn.messageId, status, text: "" });
          this.turns.recordFinished(turn.id, status);
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
    this.turns.recordFinished(turn.id, status);
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
      this.turns.clearEnded();
    }
    this.relayFollowUp(turn, status, record, error);
    this.afterTurn();
    // The other head hears the reply; a hand-off in it goes on (`headReplied`).
    // A bot with one head may hand work to the other CLI too (1.x: `sharesChat || tags.handoff`): its
    // other head is made for it (`makePartner`), and the reply comes back.
    if (status === "done" && (this.sharesChat || tags.handoff)) this.owner.group.headReplied(record, this.engine, tags.handoff, this.takeHandback(turn), turn.handoffId);
    else if (this.sharesChat) this.headStopped(this.engine);
    this.next();
  }

  /** claude waits on nothing once its turn ended: no approval stays open. */
  afterTurn() {
    this.settleTurnApprovals();
    this.updated();
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
    this.detach();
    this.progress.retryingEnded();
    this.progress.codexRetryEnded();
    this.clearIdle();
    this.turns.ignoreNone();
    // Paused work went with the process (1.x drops `pausedWork` when the process exits).
    this.turns.endPause();
    this.turns.forgetSent();
    for (const [id, approval] of [...this.approvals]) if (approval.head === head) this.settle(id, NO_LONGER_NEEDED, false);
    // Its subagents (and Codex's workers) run inside its process: they went with it.
    this.host.workers.managedEnded();
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
    const deferred = this.turns.takeBack();
    if (deferred?.open) this.finishTurn(deferred, "failed", `The agent exited (${why}) before it began this message.`);
    // What it left running in the background went with its process.
    this.stopTasks();
    this.log(`head exited (${why})${exit.expected ? "" : " unexpectedly"}`);
    if (exit.expected && this.restarting === head) {
      // Ended to start again before a message: the same session goes on (`--resume`).
      this.host.restartEnded();
    } else if (this.restartRecovery || (exit.expected && this.engine === "agy")) {
      // agy resumes by its actual conversation ID after cancel, sleep or shutdown.
      this.briefingDue();
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
        this.briefingDue();
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
}

/**
 * The monitor chip of a monitored command that changed (`Bot.monitorState`, moved here in M7-S60). A function of the host, not a
 * method of HeadEvents: monitor-policy.test.ts and bot-private-names.test.ts call `Bot.prototype.monitorState` on a bare object as
 * `this`, and a class instance cannot be made from one. Only app-owned coordinator records can update a coordinator's chip.
 */
export function monitorStateOf(host: Bot, monitor: CommandMonitor) {
  if (monitor.owner.toLowerCase() !== host.session.sessionId.toLowerCase()) return;
  const task = monitorTask(monitor);
  if (!task) return;
  // Correlate to its existing coordinator step, never to descendants or a later reply.
  if (host.turn?.steps.some(step => step.id === monitor.id && step.tool === "Monitor")) {
    const tasks = host.turn.tasks ??= [];
    const index = tasks.findIndex(candidate => candidate.id === monitor.id);
    if (index < 0) tasks.push(task); else tasks[index] = task;
    host.emitSteps(host.turn);
    return;
  }
  const record = host.records.findLast(record => record.engine === "codex" && record.steps?.some(step => step.id === monitor.id && step.tool === "Monitor"));
  if (!record) return;
  const tasks = Array.isArray(record.backgroundTasks) ? record.backgroundTasks as BackgroundTask[] : [];
  const index = tasks.findIndex(candidate => candidate.id === monitor.id);
  if (index < 0) tasks.push(task); else tasks[index] = task;
  record.backgroundTasks = tasks;
  host.changed(record);
}
