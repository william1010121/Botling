import { CodexRequestTracker } from "../token-speed";
import { settingsChange, type HotSettings } from "./hot-settings";
import { type ClaudeRestartOutcome } from '../claude-restart';
import { RESTART_NOTE } from '../restart-continuation';
import { monitorHandback } from "./monitor-policy";
import { codexAutoRiskConfig } from "./auto-risk-policy";
// A bot's Codex head: one long-lived `codex app-server` (JSON-RPC, one JSON object a line on
// stdio), ported from the Swift app's CodexAgentProcess.swift (checked against codex-cli 0.163.0).
//
// `CodexSession` is the protocol with no process of its own, so recorded lines can be replayed
// through it (test/unit/codex.test.ts): each call gives back what to write and which items it
// means for the bot — the same `StreamItem`s the claude head gives, plus a few of Codex's own.
// `CodexHead` runs it over a real (or fake) app-server process in its own process group.
//
// As in 1.x:
// - The thread starts (or resumes) with the approval policy and sandbox said explicitly, so the
//   user's own ~/.codex/config.toml does not decide what a bot may do: it asks (`on-request`) and
//   writes in its folder and its other folders (`workspace-write` with `writable_roots`). In auto
//   mode (default) Codex's own reviewer (`auto_review`) answers escalations for the head and its
//   workers; its refusals become a card, and an Allow lets that call through with the next turn asking
//   the app ("user") once. Without auto mode the reviewer is the user; the app accepts only validated,
//   explicitly owned isolated-worker Git requests automatically, one request at a time.
// - The head is a coordinator: shell and native subagents are off, and it hands execution to
//   app-managed workers with the app's dynamic tools (app_handoff, app_send_message,
//   app_task_checkpoint). Each worker is an independent Codex thread in the same app-server, run by
//   the shared worker core (worker-core/: its state, text, end, report and approvals) through
//   `CodexThreadAdapter`; its record is kept in codex-threads/<session>.workers.json; when its turn
//   ends, the app starts a report turn on the coordinator with an `app_task_result` tool output
//   (`CodexSession` is the core's CoordinatorPort).
// - The reply is the turn's last agent message that is not commentary; commentary is a step.
// - `interrupt` stops the turn (`turn/interrupt`).
//
// - `app_routines` changes this bot's routines (routines.ts's ScheduledRoutineStore, the same file the
//   app's clock reads); `app_monitor_*` run one command after an Allow once card and wake the
//   coordinator when it ends (`app_monitor_result`, monitors.ts), never replaying one after a restart.
//
// The Maintainer-only component-editor role uses the existing Claude definition/transport.
// Not ported (2.0 gaps, see desktop/README.md):
// Codex's own native subagents (off in a coordinator anyway),
// images in messages.
import { isolatedGitOwnership, type IsolatedGitOwnership } from "./isolated-git";
import { type WorkerDependency, codexEffort, type CodexItem, type CodexOutput, type WorkerRecord, type CodexConfig, writableRootsConfig, type Call, type Input, type Turn, type Approval, COORDINATOR_CONFIG, MANAGED_TOOLS, MAX_HANDOFF, isolatedGitOwners, shell, handbackFallback, firstLine, message, key, json, ADOPTED_RUN, syncResult, codexToolStarted } from "./codex-types";
export { type WorkerDependency, codexEffort, type CodexItem, type CodexOutput, type WorkerRecord, type CodexConfig, MANAGED_TOOLS, MANAGED_TOOL_SIGNATURE, WORKER_TOOLS, handbackFallback, firstLine, codexCommand, codexToolStarted } from "./codex-types";
import { CodexThreadAdapter, codexToolCompleted, reviewerOf, decline } from "./codex-thread";
export { codexToolCompleted, type CodexWire, type CodexWorkerOptions, CodexThreadAdapter } from "./codex-thread";
import { reply } from "./codex-head";
export { reply, CodexThreads, type CodexHeadConfig, CodexHead, codexWorkerHost } from "./codex-head";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { StreamItem } from "./stream";
import { movedTaskError, type WorkerInfo, type WorkerOwner, type WorkerSendResult } from "./workers";
import { ComponentEditorAdapter, EditorTransport } from "./component-editor";
import { isBotTool } from "../bot-tools";
import { EFFORTS_BY_ENGINE } from "../../contract/efforts";
import { readCodexModels, resolveCodexModel } from "./codex-models";
import { appRoutinesCall } from "../routines";
import { bounded, isActive as monitorActive, MONITOR_OUTPUT_LIMIT, monitorPayload, monitorSummary, reconcile, type CommandMonitor } from "./monitors";
import { toSwiftDate } from "../store/records";
import { codexRateLimits, codexTokens, isEmptyLimits, minusTokens, noTokens, totalTokens, type TokenUsage } from "../usage";
import {
  CodexLegacyStore, INTERRUPTED_REPORT, reportPayload, STOPPED_REPORT, toLegacyCodex, wireStatus, WorkerCore,
  type CodexJournal, type CoordinatorPort, type RunEnd,
  type WorkerCoreOptions, type WorkerReport} from "../worker-core";

export class CodexSession implements CoordinatorPort {
  private nextId = 1;
  private calls = new Map<number, Call>();
  threadId: string | null = null;
  private turn: Turn | null = null;
  private completedTurns = new Set<string>();
  /** The coordinator thread's tokens so far, and when the last turn ended (Phase 5c, 1.x's `tokensTotal`). */
  private tokensTotal: TokenUsage = noTokens();
  private tokensAtTurnStart: TokenUsage = noTokens();
  private inbox: Input[] = [];
  private approvals = new Map<string, Approval>();
  private changedFiles = new Map<string, string[]>();
  /** Commands the user allowed after Codex's reviewer refused them: asked again, they go through. */
  private allowedCommands = new Set<string>();
  /** The coordinator's next turn asks the app instead of the reviewer, once (1.x `reviewerNext`). */
  private reviewerNext: string | null = null;
  /** Reviewer refusals shown as cards: what was refused, and whose. */
  private reviews = new Map<string, { command: string; task: string | null; thread: string; cwd: string }>();
  private finishing = false;
  private stopped = false;
  /** Workers whose turn under way when the app restarted is being checked (thread/read, the editor's transcript). */
  private restartPending = new Map<string, WorkerRecord>();
  private restartCoordinatorPending = false;
  private toolReplies = new Map<string, { intent: string; response: Record<string, unknown> }>();
  private pending = false;
  private monitors = new Map<string, CommandMonitor>();
  private activeMonitor: string | null = null;
  /** A model switched to in place: every coordinator turn/start carries it (it holds for later turns too). */
  private turnModel: string | null = null;
  /**
   * Its app-managed workers (shared-core spec 3.3): their state, runs, reports and approvals. The Codex threads and the
   * Maintainer's component editor are its two adapters; codex-threads/<session>.workers.json stays their journal
   * (CodexLegacyStore over `journal`, which CodexHead saves) until the bot keeps one ledger.
   */
  readonly core: WorkerCore;
  readonly threads: CodexThreadAdapter;
  readonly editor: ComponentEditorAdapter;
  private journal: WorkerRecord[];
  /** What the core, the adapters and the report port said since the last call returned (in order). */
  private out: CodexOutput[] = [];
  /** The report turn under way: whose report the coordinator is shown now. */
  private report: { id: string; run: number } | null = null;
  /** A coordinator turn is ending: a report waits for next(), which decides what goes first. */
  private settling = false;
  /** The task id the next hand-off gets (its receipt is written before the core has made it). */
  private nextTask: string | null = null;

  constructor(readonly config: CodexConfig) {
    for (const record of config.restoredMonitors ?? []) {
      if (config.ownerSession && record.owner.toLowerCase() !== config.ownerSession.toLowerCase()) continue;
      this.monitors.set(record.id, reconcile(record));
    }
    const restored = config.restartWorkers ?? config.restoredWorkers;
    this.journal = restored.map((record) => ({ ...record }));
    const journal: CodexJournal = { folder: "", workers: () => this.journal, saveWorkers: (rows) => { this.journal = rows; } };
    const recovering = (id: string) => (this.restartPending.has(id) ? "Restart recovery is still checking this worker's original turn; try again in a moment." : null);
    this.threads = new CodexThreadAdapter({
      config, recovering, records: () => this.core.all(),
      wire: {
        request: (method, params, reply) => this.out.push(this.request(method, params, { kind: "adapter", reply })),
        write: (value) => this.out.push({ kind: "write", value }),
        item: (item) => this.out.push(this.workerItem(item)),
      },
      reviewed: (params, worker) => this.out.push(...this.reviewed(params, worker)),
      allowedRetry: (key) => this.allowedCommands.delete(key),
      followUp: (id, text) => { void this.core.sendToWorker(id, text); },
    });
    this.threads.strictResume = !!config.restartWorkers || config.restartRecovery !== undefined;
    this.editor = new ComponentEditorAdapter({
      route: () => this.config.componentEditor, recovering,
      act: (action) => this.out.push({ kind: "componentEditor", action }),
      item: (item) => this.out.push(this.workerItem(item)),
      ownerSessionId: () => this.config.ownerSession ?? null,
    });
    const options: WorkerCoreOptions = {
      store: new CodexLegacyStore(journal, config.ownerSession ?? ""), port: this, sink: { item: (item) => this.out.push(this.workerItem(item)) },
      adapters: [this.threads, this.editor], ownerSessionId: () => this.config.ownerSession ?? "", log: () => undefined,
      newId: () => { const id = this.nextTask ?? randomUUID().toLowerCase(); this.nextTask = null; return id; },
    };
    // The member's core lists only this conversation's workers (its ledger keeps every conversation's).
    this.core = config.workerCore?.({ ...options, sessionScoped: true }) ?? new WorkerCore(options);
    // After an explicit restart: the workers it interrupted (the ledger's), or the old restart journal's.
    const restarted = config.restartWorkers
      ?? (config.restartRecovery !== undefined
        ? this.core.all().filter((r) => r.status === "interrupted" && r.interruptedBy === "restart" && (r.endedAt ?? 0) >= config.restartRecovery!).map(toLegacyCodex) : []);
    for (const record of restarted) {
      if (record.wasActive && record.restartSafe && record.thread && ((!record.role && record.restartTurn) || (record.role === "component-editor" && record.editorCheckpoint)))
        this.restartPending.set(record.id, record);
    }
    // A report whose hand-over was under way when the app went away: whether the coordinator saw it is unknown, and it
    // has no reconcile tool. One attempt without a decision: shown once more (reconciliation_attempt says so), then
    // unresolved. Never taken as handed over.
    for (const record of this.core.all()) if (record.report.state === "dispatching" && !record.owner) this.core.retryUncertain(record.id, record.run);
  }

  /** A worker's item (the core's, its adapters', a restart check's): for the bot's worker entry. */
  private workerItem(item: CodexItem): CodexOutput {
    return { kind: "item", item, worker: true };
  }

  /** What the core, the adapters and the port said since the last call, in order. */
  private take(): CodexOutput[] {
    const out = this.out;
    this.out = [];
    return out;
  }

  private get managed() { return this.config.workerInstructions !== null; }

  // ------------------------------------------------------------------------------------------
  // From the bot

  start(): CodexOutput[] {
    return [this.request("initialize", { clientInfo: { name: "claudecodebot", title: "Botling", version: "1" }, capabilities: { experimentalApi: true } }, { kind: "initialize" })];
  }

  /** A message: a turn of its own (now, or once the one under way ends). */
  send(text: string, images: string[] = []): CodexOutput[] {
    const input: Input = { text, token: randomUUID(), ...(images.length ? { images } : {}) };
    if (!this.threadId || this.turn || this.restartCoordinatorPending) {
      this.inbox.push(input);
      return [];
    }
    return this.startTurn(input);
  }

  /**
   * Its model and effort from its next turn on, without a new thread: `turn/start` overrides them for that
   * turn and the ones after it; new workers start on them too. False (nothing changed): going back to the
   * default, which an override cannot say, or it is stopping.
   */
  applySettings(target: HotSettings): boolean {
    if (!this.canApplySettings(target)) return false;
    const change = settingsChange(target, this.config);
    if (change.model) { this.config.model = change.model; this.turnModel = change.model; }
    if (change.effort) this.config.effort = change.effort;
    return true;
  }

  canApplySettings(target: HotSettings): boolean {
    const change = settingsChange(target, this.config);
    return !this.stopped && !this.finishing && !("model" in change && !change.model) && !("effort" in change && !change.effort);
  }

  /** The coordinator's settings on a turn/start: its effort, and a model it was switched to in place. */
  private turnSettings(params: Record<string, unknown>) {
    if (this.turnModel) params.model = this.turnModel;
    if (this.config.effort) params.effort = this.config.effort;
  }

  /** Words that join the turn under way (`turn/steer`); false when no turn runs. */
  steer(text: string): { joined: boolean; out: CodexOutput[] } {
    const turn = this.turn;
    if (!turn || !this.threadId) return { joined: false, out: [] };
    const input = { text, token: randomUUID() };
    if (!turn.id) {
      turn.waitingSteers.push(input);
      return { joined: true, out: [] };
    }
    return { joined: true, out: [this.steerCall(input, turn.id)] };
  }

  interrupt(): CodexOutput[] {
    const turn = this.turn;
    if (!turn || turn.interruptAsked) return [];
    turn.interruptAsked = true;
    if (turn.id && this.threadId) {
      turn.interruptSent = true;
      return [this.request("turn/interrupt", { threadId: this.threadId, turnId: turn.id }, { kind: "interrupt" })];
    }
    return [];
  }

  /** A worker's approval (worker:<task>:<run>:<its own id>): the core's table, then its adapter. */
  answerWorker(requestId: string, allow: boolean, why?: string): { answered: boolean; out: CodexOutput[] } {
    const answered = !this.stopped && this.core.answer(requestId, allow, {}, why);
    return { answered, out: this.take() };
  }

  /** The app is quitting: workers at work are interrupted (resumable later, never replayed); the coordinator is left. */
  closeWorkers(): CodexOutput[] {
    void this.core.close();
    return [...this.take(), ...this.pendingChanged()];
  }

  answer(requestId: string, allow: boolean, why?: string): CodexOutput[] {
    if (requestId.startsWith("worker:")) return this.answerWorker(requestId, allow, why).out;
    if (requestId.startsWith("monitor:")) return this.approveMonitor(requestId.slice(8), allow);
    if (requestId.startsWith("codex-review:")) return this.answerReview(requestId, allow);
    const approval = this.approvals.get(requestId);
    if (!approval) return [];
    this.approvals.delete(requestId);
    if (!this.approvalCurrent(approval)) return [this.item({ kind: "permissionCancelled", requestId })];
    const result = approval.kind === "command" || approval.kind === "fileChange"
      ? { decision: allow ? "accept" : "decline" }
      : allow ? { permissions: approval.kind.permissions, scope: "turn" } : { permissions: {} };
    const out: CodexOutput[] = [{ kind: "write", value: { jsonrpc: "2.0", id: approval.rpcId, result } }];
    // A refusal carries no words in Codex's protocol: why goes to the turn as a message.
    if (!allow && why && this.turn?.id) out.push(this.steerCall({ text: `(App: ${why})`, token: randomUUID() }, this.turn.id));
    return out;
  }

  /** Stdin closes once the turn under way (and anything waiting) is done. */
  finish(): CodexOutput[] {
    this.finishing = true;
    return !this.turn && !this.inbox.length && !this.hasManagedWork ? [{ kind: "close" }] : [];
  }

  /**
   * The head goes away (the app quits, the bot stops): workers at work are interrupted with it (resumable later, never
   * replayed); an interrupt of the coordinator alone leaves them.
   */
  stop(): CodexOutput[] {
    const monitors = this.cancelMonitors();
    this.stopped = true;
    this.allowedCommands.clear();
    this.reviews.clear();
    this.inbox = [];
    const out = [...this.restartPending.keys()].map((id) => this.workerItem({ kind: "subagentEnded", id, status: "interrupted", summary: INTERRUPTED_REPORT.quit }));
    this.restartPending.clear();
    void this.core.close();
    return [...out, ...this.take(), ...this.closeApprovals(() => true, true), ...monitors, ...this.pendingChanged()];
  }

  // ------------------------------------------------------------------------------------------
  // From codex

  receive(line: string): CodexOutput[] {
    let value: any;
    try { value = JSON.parse(line); } catch { return []; }
    if (!value || typeof value !== "object") return [];
    const method = typeof value.method === "string" ? value.method : null;
    const params = value.params && typeof value.params === "object" ? value.params : {};
    if (method && value.id !== undefined) return [...this.serverRequest(method, value.id, params), ...this.take()];
    if (method) {
      // A worker's thread: its adapter turns it into the core's events.
      if (this.threads.receive(method, params)) return [...this.take(), ...this.pendingChanged()];
      const out=this.notification(method, params);
      out.push(...this.requests(method, params));
      return [...out, ...this.take()];
    }
    if (typeof value.id === "number") {
      const call = this.calls.get(value.id);
      if (!call) return [];
      this.calls.delete(value.id);
      const out = this.response(call, value.result ?? null, value.error ?? null);
      return [...out, ...this.take(), ...(call.kind === "adapter" ? this.pendingChanged() : [])];
    }
    return [];
  }

  private response(call: Call, result: any, error: any): CodexOutput[] {
    switch (call.kind) {
      case "restartCoordinatorRead": {
        this.restartCoordinatorPending=false;
        if(this.stopped)return [];
        const turns=result?.thread?.turns;
        const turn=Array.isArray(turns)?turns.find((t:any)=>t.id===call.turn):null;
        const uncertain=turn?.status==="interrupted" && (!Array.isArray(turn.items) || turn.items.some((i:any)=>
          !["agentMessage","reasoning","plan","contextCompaction"].includes(i.type) && !["completed","failed","declined"].includes(i.status)));
        if(error || result?.thread?.id!==this.threadId || !turn || turns.at(-1)?.id!==call.turn || uncertain || !["completed","interrupted"].includes(turn.status)){
          this.inbox.shift();
          return [this.result(false,"Restart continuation paused: the original coordinator turn outcome is unconfirmed. No prompt was replayed."),...this.next()];
        }
        if(turn.status==="completed"){
          this.inbox.shift();
          const report=Array.isArray(turn.items)?turn.items.findLast((i:any)=>i.type==="agentMessage"&&i.phase!=="commentary")?.text:null;
          return [this.result(!!report,report||"The original turn completed without a recoverable final report; it was not replayed."),...this.next()];
        }
        return this.inbox.length?this.startTurn(this.inbox.shift()!):this.next();
      }
      case "restartWorkerRead": {
        const record = this.restartPending.get(call.task);
        this.restartPending.delete(call.task);
        const worker = this.core.get(call.task);
        if (!worker || !record || worker.status !== "interrupted" || this.stopped) return this.pendingChanged();
        const turns=result?.thread?.turns;
        const turn=Array.isArray(turns)?turns.find((t:any)=>t.id===call.turn):null;
        const unresolvedItems = turn?.status === "interrupted" && (!Array.isArray(turn.items) || turn.items.some((item:any) =>
          !["agentMessage", "reasoning", "plan", "contextCompaction"].includes(item.type)
          && !["completed", "failed", "declined"].includes(item.status)));
        if(error || result?.thread?.id!==worker.conversationId || !turn || turns.at(-1)?.id!==call.turn || unresolvedItems || !["completed","interrupted"].includes(turn.status)){
          return [this.item({kind:"subagentEnded",id:worker.id,status:"interrupted",summary:"Restart recovery could not confirm the original worker turn outcome. No task was replayed; reconcile this task and thread."}),...this.pendingChanged()];
        }
        if(turn.status==="completed"){
          this.threads.adopt(worker.id,(turn.items??[]).filter((i:any)=>i.type==="agentMessage").map((i:any)=>({text:i.text??"",phase:i.phase??null})),call.turn);
          return [...this.restartRun(worker.id,ADOPTED_RUN),...this.pendingChanged()];
        }
        this.threads.continueAfterRestart(worker.id);
        return [...this.restartRun(worker.id,RESTART_NOTE+"\nOriginal assignment (scope remains unchanged):\n"+(record.ownershipInstructions??record.instructions)),...this.pendingChanged()];
      }
      case "initialize": {
        if (error) return [{ kind: "failed", message: message(error) }];
        const initialized: CodexOutput = { kind: "write", value: { jsonrpc: "2.0", method: "initialized" } };
        const roots = this.config.skillRoots ?? [];
        // The plugins' skills first, so the thread starts with them (the answer, or a refusal, starts it).
        if (roots.length) return [initialized, this.request("skills/extraRoots/set", { extraRoots: [...roots] }, { kind: "skillRoots" })];
        return [initialized, this.startThread()];
      }
      case "skillRoots":
        // An app-server that does not know the method (an older Codex): the thread starts without the plugins' skills.
        return [this.startThread()];
      case "thread": {
        const thread = result?.thread?.id;
        if (error || typeof thread !== "string") return [{ kind: "failed", message: message(error) }];
        if(this.config.strictResume && thread!==this.config.resumeThread)return [{kind:"failed",message:"Restart resume returned a different thread. No prompt was sent."}];
        if (this.config.resumeThread && this.managed) return [this.refreshInstructions(this.config.instructions, thread, { kind: "coordinatorInstructions", thread })];
        return this.coordinatorReady(thread);
      }
      case "coordinatorInstructions":
        if (error) return [{ kind: "failed", message: `Could not refresh coordinator instructions: ${message(error)}` }];
        return this.coordinatorReady(call.thread);
      case "monitorCommand":
        return this.completeMonitor(call.id, result, error);
      case "turn": {
        const monitor = this.activeMonitor ? this.monitors.get(this.activeMonitor) : undefined;
        if (monitor) monitor.wake = error ? "uncertain" : "delivered";
        if (error) {
          // The turn never started: its message gets an error reply, and the next goes.
          this.turn = null;
          const shown = this.report;
          const evidence = shown ? this.evidence(shown) : null;
          const text = monitor ? `Monitor callback could not start: ${json(monitorPayload(monitor))}\n${message(error)}`
            : evidence ? handbackFallback(evidence, message(error)) : message(error);
          this.report = null;
          this.activeMonitor = null;
          return [this.result(false, text), ...this.settleReport(shown, false), ...this.next()];
        }
        const id = result?.turn?.id;
        return typeof id === "string" ? this.learnTurn(id) : [];
      }
      case "steer":
        // A steer the turn did not take (it had just ended): it goes as a turn of its own.
        if (!error) return [];
        if (!this.turn) return this.startTurn(call.input);
        this.inbox.push(call.input);
        return [];
      case "adapter":
        call.reply(result, error);
        return [];
      default:
        return [];
    }
  }

  private notification(method: string, params: any): CodexOutput[] {
    // Codex's own limits (not a thread's): kept apart from Claude's (`.codexRateLimits`).
    if (method === "account/rateLimits/updated") {
      if (!params.rateLimits || typeof params.rateLimits !== "object") return [];
      const limits = codexRateLimits(params.rateLimits);
      return isEmptyLimits(limits) ? [] : [this.item({ kind: "rateLimits", engine: "codex", limits })];
    }
    // Another thread that is not one of its workers' (they went to their adapter): not this coordinator's.
    const thread = typeof params.threadId === "string" ? params.threadId : null;
    if (thread && this.threadId && thread !== this.threadId) return [];
    switch (method) {
      case "item/autoApprovalReview/completed":
        return this.reviewed(params, null);
      case "turn/started": {
        const id = params.turn?.id;
        return typeof id === "string" ? this.learnTurn(id) : [];
      }
      case "item/started": {
        const step = codexToolStarted(params.item, this.changedFiles);
        return step ? [this.item({ kind: "toolUse", ...step, parent: null })] : [];
      }
      case "item/completed":
        return this.completed(params.item).map((item) => this.item(item));
      case "serverRequest/resolved": {
        return this.resolveApproval(params);
      }
      case "turn/completed":
        return params.turn ? this.turnCompleted(params.turn) : [];
      case "error":
        return this.retrying(params);
      case "thread/tokenUsage/updated":
        if (params.tokenUsage?.total && typeof params.tokenUsage.total === "object") this.tokensTotal = codexTokens(params.tokenUsage.total);
        return [];
      default:
        return [];
    }
  }

  /** An `error` Codex will retry on the coordinator's turn (one it gives up on ends the turn: `turn/completed`). */
  private retrying(params: any): CodexOutput[] {
    if (params.willRetry !== true || !this.threadId || params.threadId !== this.threadId) return [];
    const error = params.error && typeof params.error === "object" ? params.error : {};
    const count = /(\d+)\s*\/\s*(\d+)/.exec(typeof error.message === "string" ? error.message : "");
    const info = error.codexErrorInfo;
    const variant = info && typeof info === "object" ? Object.values(info)[0] as { httpStatusCode?: unknown } | undefined : undefined;
    const limited = variant?.httpStatusCode === 429 || info === "rateLimitExceeded" || info === "serverOverloaded";
    return [this.item({
      kind: "apiRetry", thread: this.threadId, attempt: count ? Number(count[1]) : 1, max: count ? Number(count[2]) : 0,
      reason: limited ? "rateLimited" : "connection", retryAt: null,
    })];
  }

  private serverRequest(method: string, rpcId: unknown, params: any): CodexOutput[] {
    if (method === "item/tool/call") return this.managedTool(rpcId, params);
    // A worker's approvals are its adapter's (through the core's table).
    if (this.threads.serverRequest(method, rpcId, params)) return [];
    const reason = typeof params.reason === "string" && params.reason ? params.reason : "";
    switch (method) {
      case "item/commandExecution/requestApproval": {
        // A manual override covers one retry in its exact thread and working directory.
        const retryKey = JSON.stringify([params.threadId, params.cwd, params.command]);
        const current = this.approvalCurrent({ rpcId, kind: "command", thread: params.threadId, turn: params.turnId ?? null });
        if (current && params.environmentId === "local" && !params.networkApprovalContext
          && (params.kind === undefined || params.kind === "command")
          && (!Array.isArray(params.availableDecisions) || params.availableDecisions.includes("accept"))
          && this.allowedCommands.delete(retryKey)) {
          return [{ kind: "write", value: { jsonrpc: "2.0", id: rpcId, result: { decision: "accept" } } }];
        }
        let summary = typeof params.command === "string" ? params.command : "";
        if (reason) summary += (summary ? "\n\n" : "") + reason;
        return this.askApproval(rpcId, "command", params, "Bash", summary);
      }
      case "item/fileChange/requestApproval": {
        const files = typeof params.itemId === "string" ? this.changedFiles.get(params.itemId) ?? [] : [];
        let summary = files.join("\n");
        if (typeof params.grantRoot === "string" && params.grantRoot) summary += (summary ? "\n" : "") + params.grantRoot;
        if (reason) summary += (summary ? "\n\n" : "") + reason;
        return this.askApproval(rpcId, "fileChange", params, "Edit", summary);
      }
      case "item/permissions/requestApproval": {
        const asked = params.permissions && typeof params.permissions === "object" ? params.permissions : {};
        const summary = [reason, JSON.stringify(asked, Object.keys(asked).sort())].filter(Boolean).join("\n\n");
        return this.askApproval(rpcId, { permissions: asked }, params, "Permissions", summary);
      }
      case "mcpServer/elicitation/request":
        // A form the app cannot show: declined, so nothing waits on it.
        return [{ kind: "write", value: { jsonrpc: "2.0", id: rpcId, result: { action: "decline" } } }];
      default:
        // Bots ask in the chat (<choices>); anything else is not the app's to answer.
        return [{ kind: "write", value: { jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: "Not supported by Botling." } } }];
    }
  }

  private get reviewer(): string { return reviewerOf(this.config); }

  private nextReviewer(params: Record<string, unknown>) {
    if (!this.reviewerNext) return;
    params.approvalsReviewer = this.reviewerNext;
    this.reviewerNext = this.reviewerNext === "user" ? "auto_review" : null;
  }

  /** Codex's reviewer refused a call: a card with its reason (1.x `reviewed`). Allow lets it through next time. */
  private reviewed(params: any, worker: { id: string; name: string } | null): CodexOutput[] {
    const review = params.review && typeof params.review === "object" ? params.review : {};
    if (review.status === "approved") return [];
    const action = params.action && typeof params.action === "object" ? params.action : {};
    const command = typeof action.command === "string" ? action.command
      : Array.isArray(action.argv) ? action.argv.filter((a: unknown) => typeof a === "string").join(" ") : "";
    const what = command || (typeof action.type === "string" ? action.type : "a call");
    const risk = typeof review.riskLevel === "string" ? `[${review.riskLevel} risk] ` : "";
    const why = typeof review.rationale === "string" && review.rationale ? review.rationale
      : review.status === "denied" ? "Auto review denied this action."
      : `Auto review did not approve this action (${typeof review.status === "string" ? review.status : "unknown result"}). No automatic approval was granted.`;
    const requestId = `codex-review:${randomUUID()}`;
    this.reviews.set(requestId, { command, task: worker?.id ?? null,
      thread: typeof params.threadId === "string" ? params.threadId : "", cwd: typeof action.cwd === "string" ? action.cwd : "" });
    // The bot shows it as auto mode's blocked-call card (the reason apart from the call) and tells the head after the pick.
    const input = { reviewRefused: true, reason: `${risk}${why}`.trim(), ...(worker ? { worker: worker.name || worker.id } : {}) };
    return [this.item({ kind: "permission", requestId, tool: action.type === "applyPatch" ? "Edit" : "Bash", summary: what, input, ...(worker ? { workerId: worker.id } : {}) })];
  }

  private answerReview(requestId: string, allow: boolean): CodexOutput[] {
    const review = this.reviews.get(requestId);
    if (!review) return [];
    this.reviews.delete(requestId);
    if (!allow || this.stopped) return [];
    if (review.command && review.thread && review.cwd) this.allowedCommands.add(JSON.stringify([review.thread, review.cwd, review.command]));
    // The next turn of the refused call's thread asks the app (which accepts the allowed call), once.
    if (this.config.autoMode !== false) { if (review.task) this.threads.askAppNext(review.task); else this.reviewerNext = "user"; }
    return [];
  }

  private approvalCurrent(approval: Approval): boolean {
    if (this.stopped) return false;
    return approval.thread === this.threadId && !!this.turn
      && (!approval.turn || !this.completedTurns.has(approval.turn))
      && !this.turn.interruptAsked && (!this.turn.id || !approval.turn || this.turn.id === approval.turn);
  }

  private askApproval(rpcId: unknown, kind: Approval["kind"], params: any, tool: string, summary: string): CodexOutput[] {
    const thread = typeof params.threadId === "string" ? params.threadId : "";
    const turn = typeof params.turnId === "string" ? params.turnId : this.turn?.id ?? null;
    const approval: Approval = { rpcId, kind, thread, turn };
    if (!this.approvalCurrent(approval)) return [this.declineApproval(approval)];
    if ([...this.approvals.values()].some((pending) => pending.rpcId === rpcId && pending.thread === thread && pending.turn === turn)) return [];
    // UI decisions use a fresh local identity, never a reusable/string-coerced RPC id.
    const requestId = `codex-approval:${randomUUID()}`;
    this.approvals.set(requestId, approval);
    return [this.item({ kind: "permission", requestId, tool, summary, input: {} })];
  }

  private declineApproval(approval: Approval): CodexOutput {
    return { kind: "write", value: { jsonrpc: "2.0", id: approval.rpcId,
      result: typeof approval.kind === "string" ? { decision: "decline" } : { permissions: {} } } };
  }

  /** Terminal owner cleanup removes unanswered requests only; accepted decisions are already gone. */
  private closeApprovals(matches: (approval: Approval) => boolean, deny = false): CodexOutput[] {
    const out: CodexOutput[] = [];
    for (const [requestId, approval] of this.approvals) {
      if (!matches(approval)) continue;
      this.approvals.delete(requestId);
      if (deny) out.push(this.declineApproval(approval));
      out.push(this.item({ kind: "permissionCancelled", requestId }));
    }
    return out;
  }

  private resolveApproval(params: any): CodexOutput[] {
    return this.closeApprovals((approval) => approval.rpcId === params.requestId && approval.thread === params.threadId
      && (typeof params.turnId !== "string" || approval.turn === params.turnId));
  }

  // ------------------------------------------------------------------------------------------
  // Turns

  private startThread(): CodexOutput {
    const params: Record<string, unknown> = {
      cwd: this.config.cwd, approvalPolicy: this.config.bypassPermissions ? "never" : "on-request", approvalsReviewer: this.reviewer, sandbox: this.config.bypassPermissions ? "danger-full-access" : "workspace-write", developerInstructions: this.config.instructions,
    };
    params.config = codexAutoRiskConfig(this.config.autoMode, this.config.bypassPermissions);
    if (this.managed) {
      params.environments = [];
      params.dynamicTools = MANAGED_TOOLS;
      params.config = { ...COORDINATOR_CONFIG, ...codexAutoRiskConfig(this.config.autoMode, this.config.bypassPermissions) };
    }
    if (this.config.model) params.model = this.config.model;
    // Its other folders are writable too, as in 1.x (`sandbox_workspace_write.writable_roots`).
    if (this.config.writableRoots?.length) params.config = { ...(params.config as Record<string, unknown> | undefined), ...writableRootsConfig(this.config.writableRoots) };
    if (this.config.resumeThread) {
      // Tools are fixed when a thread starts; resume cannot change them.
      delete params.dynamicTools;
      delete params.environments;
      params.threadId = this.config.resumeThread;
      params.excludeTurns = true;
      return this.request("thread/resume", params, { kind: "thread" });
    }
    return this.request("thread/start", params, { kind: "thread" });
  }

  /** Resume alone can leave the rollout's old developer policy in force: the current one is appended. */
  private refreshInstructions(text: string, thread: string, call: Call): CodexOutput {
    return this.request("thread/inject_items", { threadId: thread, items: [{ type: "message", role: "developer", content: [{ type: "input_text", text }] }] }, call);
  }

  private coordinatorReady(thread: string): CodexOutput[] {
    if (this.stopped) return [];
    this.threadId = thread;
    const out: CodexOutput[] = [{ kind: "thread", id: thread }];
    for(const record of this.restartPending.values()) {
      if(record.role==="component-editor")out.push({kind:"recoverEditor",task:record.id,run:record.run,session:record.thread!,checkpoint:record.editorCheckpoint!});
      else out.push(this.request("thread/read",{threadId:record.thread,includeTurns:true},{kind:"restartWorkerRead",task:record.id,turn:record.restartTurn!}));
    }
    if(this.config.restartTurn){
      this.restartCoordinatorPending=true;
      out.push(this.request("thread/read",{threadId:thread,includeTurns:true},{kind:"restartCoordinatorRead",turn:this.config.restartTurn}));
    }
    else if (this.inbox.length) out.push(...this.startTurn(this.inbox.shift()!));
    else out.push(...this.next());
    out.push(...this.pendingChanged());
    return out;
  }

  private startTurn(input: Input): CodexOutput[] {
    if (!this.threadId) {
      this.inbox.unshift(input);
      return [];
    }
    this.turn = { id: null, waitingSteers: [], interruptAsked: false, interruptSent: false, said: [] };
    // Pictures go along as `localImage` items (CodexSession.items), after the words.
    const params: Record<string, unknown> = { threadId: this.threadId, input: [{ type: "text", text: input.text }, ...(input.images ?? []).map((path) => ({ type: "localImage", path }))] };
    if (this.managed) params.environments = [];
    this.turnSettings(params);
    this.nextReviewer(params);
    return [this.request("turn/start", params, { kind: "turn" })];
  }

  private learnTurn(id: string): CodexOutput[] {
    const turn = this.turn;
    if (!turn || turn.id || this.completedTurns.has(id)) return [];
    turn.id = id;
    const out = turn.waitingSteers.map((input) => this.steerCall(input, id));
    turn.waitingSteers = [];
    if (turn.interruptAsked && !turn.interruptSent && this.threadId) {
      turn.interruptSent = true;
      out.push(this.request("turn/interrupt", { threadId: this.threadId, turnId: id }, { kind: "interrupt" }));
    }
    return out;
  }

  private turnCompleted(finished: any): CodexOutput[] {
    const current = this.turn;
    if (!current) return [];
    if (typeof finished.id === "string" && this.completedTurns.has(finished.id)) return [];
    if (current.id && typeof finished.id === "string" && finished.id !== current.id) return [];
    if (typeof finished.id === "string") this.completedTurns.add(finished.id);
    this.turn = null;
    const handback = this.report;
    this.report = null;
    // The report it was shown, and whether the coordinator decided on it in this turn (a checkpoint or a follow-up).
    const shown = handback ? this.core.get(handback.id) : undefined;
    const evidence = handback ? this.evidence(handback) : null;
    const undecided = !!shown && shown.run === handback!.run && shown.report.state === "dispatching";
    const monitor = this.activeMonitor ? this.monitors.get(this.activeMonitor) ?? null : null;
    this.activeMonitor = null;
    const out: CodexOutput[] = this.closeApprovals((approval) => approval.thread === this.threadId
      && (!approval.turn || approval.turn === finished.id));
    // What this turn used: the thread's tokens since the last turn ended (`tokensAtTurnStart`).
    const used = minusTokens(this.tokensTotal, this.tokensAtTurnStart);
    this.tokensAtTurnStart = this.tokensTotal;
    if (totalTokens(used) > 0) out.push(this.item({ kind: "usage", totalCost: 0, tokens: used }));
    const final = current.said.findLast((said) => said.phase !== "commentary")?.text.trim() ?? "";
    switch (finished.status) {
      case "interrupted":
        // Stopped by the app (`interrupt`): an error result the bot does not show.
        out.push(this.result(false, monitor ? `Monitor continuation was interrupted: ${json(monitorPayload(monitor))}`
          : evidence ? handbackFallback(evidence, "The summary turn was interrupted.") : current.interruptAsked ? "" : "Codex stopped this turn.", "cancelled"));
        break;
      case "failed": {
        const reason = typeof finished.error?.message === "string" ? finished.error.message : "Codex failed.";
        out.push(this.result(false, monitor ? `Monitor continuation failed: ${json(monitorPayload(monitor))}\n${reason}` : evidence ? handbackFallback(evidence, reason) : reason));
        break;
      }
      default:
        if (monitor && !reply(current.said)) {
          out.push(this.result(true, `Monitor result: ${json(monitorPayload(monitor))}`));
        } else if (evidence && !final) {
          out.push(this.result(false, handbackFallback(evidence, "The summary ended without a final answer.")));
        } else if (evidence && undecided && !this.stopped) {
          if (shown!.report.attempts === 0) {
            // One event-driven decision turn, never a timer or an execution retry. As in 1.x the
            // turn that recorded no decision says nothing; the next one decides.
            out.push(this.item({ kind: "stepText", text: "Worker turn ended; reconciling acceptance and next owner action." }));
            out.push(this.result(true, ""));
          } else {
            out.push(this.result(false, handbackFallback(evidence, "No acceptance checkpoint or next owner action was recorded after one reconciliation. The user objective remains unverified; no automatic retry is scheduled.")));
          }
        } else {
          out.push(this.result(true, reply(current.said)));
        }
    }
    if (undecided) out.push(...this.settleReport(handback, finished.status === "completed" && !!final && !this.stopped));
    out.push(...this.next());
    return out;
  }

  /** What a report turn's fallback keeps of the report it showed. */
  private evidence(shown: { id: string; run: number }): { name: string; task: string; status: string; report: string } | null {
    const r = this.core.get(shown.id);
    return r ? { name: r.name, task: r.id, status: wireStatus(r.report.status ?? "failed"), report: r.report.text ?? "" } : null;
  }

  /**
   * A report turn ended with no decision on its report: completed, cut short (interrupted, failed, no final answer: its
   * evidence also went to the chat) or never started. The coordinator has no reconcile tool, so each is one attempt
   * without a decision: shown once more, then unresolved (the core's rule). Never taken as handed over.
   */
  private settleReport(shown: { id: string; run: number } | null, _completed: boolean): CodexOutput[] {
    if (!shown) return [];
    this.settling = true;
    try { this.core.finishReport(shown.id, shown.run, true); } catch { /* settled meanwhile */ } finally { this.settling = false; }
    return this.take();
  }

  /**
   * The coordinator end of report delivery (CoordinatorPort, checkpoint policy): a report is shown in an app turn of
   * its own with the `app_task_result` tool output, when the coordinator is free; else it waits in the core.
   */
  readonly ack = "checkpoint" as const;
  deliver(report: WorkerReport): "taken" | "queued" | "busy" {
    if (this.settling || this.turn || this.stopped || !this.threadId || this.restartCoordinatorPending || this.inbox.length) return "busy";
    if (!this.core.beginReport(report.id, report.run)) return "busy";
    const r = this.core.get(report.id)!;
    this.report = { id: report.id, run: report.run };
    this.turn = { id: null, waitingSteers: [], interruptAsked: false, interruptSent: false, said: [] };
    const payload = reportPayload(report, { name: r.name, threadId: r.conversationId, turnId: typeof r.engineData.turn === "string" ? r.engineData.turn : null, reconciliationAttempt: r.report.attempts });
    const params: Record<string, unknown> = {
      threadId: this.threadId, input: [], toolOutput: { name: "app_task_result", namespace: null, output: JSON.stringify(payload, null, 2) }, environments: [],
    };
    this.turnSettings(params);
    this.nextReviewer(params);
    this.out.push(this.item({ kind: "backgroundTurn", taskId: report.id }), this.request("turn/start", params, { kind: "turn" }));
    return "queued";
  }

  /** workers.ts `setWorkerOwner`: a report already waiting for the coordinator goes to the owner (`workerReport`). */
  setWorkerOwner(task: string, owner: WorkerOwner | null): { ok: true; out: CodexOutput[] } | { ok: false; reason: string } {
    const set = this.core.setWorkerOwner(task, owner);
    if (!set.ok) return set;
    return { ok: true, out: [...this.take(), ...this.pendingChanged()] };
  }

  /** The next waiting message's turn, a monitor's wake, a worker's report, or the end once `finish` asked for it. */
  private next(): CodexOutput[] {
    if(this.restartCoordinatorPending)return [];
    if (this.turn) return [];
    if (this.inbox.length) return this.startTurn(this.inbox.shift()!);
    const waking = [...this.monitors.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).find((monitor) => monitor.wake === "pending");
    if (waking && this.threadId && !this.stopped) {
      this.activeMonitor = waking.id;
      waking.wake = "dispatching";
      this.turn = { id: null, waitingSteers: [], interruptAsked: false, interruptSent: false, said: [] };
      const params: Record<string, unknown> = {
        threadId: this.threadId, input: [], toolOutput: { name: "app_monitor_result", namespace: null, output: JSON.stringify(monitorPayload(waking), null, 2) }, environments: [],
      };
      this.turnSettings(params);
      this.nextReviewer(params);
      return [this.item({ kind: "backgroundTurn", taskId: null }), this.request("turn/start", params, { kind: "turn" }), ...this.pendingChanged()];
    }
    // Reports waiting in the core: routed to their owner, or the first shown in a turn of its own (`deliver`).
    if (this.threadId && !this.stopped) this.core.redeliver();
    const out = this.take();
    if (this.turn) return [...out, ...this.pendingChanged()];
    return this.finishing && !this.hasManagedWork ? [...out, { kind: "close" }] : out;
  }

  private steerCall(input: Input, turnId: string): CodexOutput {
    return this.request("turn/steer", { threadId: this.threadId ?? "", expectedTurnId: turnId, input: [{ type: "text", text: input.text }] }, { kind: "steer", input });
  }

  private request(method: string, params: Record<string, unknown>, call: Call): CodexOutput {
    const id = this.nextId++;
    this.calls.set(id, call);
    return { kind: "write", value: { jsonrpc: "2.0", id, method, params } };
  }

  private item(item: CodexItem): CodexOutput {
    return { kind: "item", item };
  }

  /** A turn's end; `how` is how Codex ended it (classifyRun reads it: interrupted is "cancelled"). */
  private result(ok: boolean, text: string, how: RunEnd["how"] = ok ? "normal" : "error"): CodexOutput {
    return this.item({ kind: "result", ok, text: ok ? text : "", error: ok ? "" : text, subtype: ok ? "success" : "error", how });
  }

  // ------------------------------------------------------------------------------------------
  // App-managed workers

  /** For codex-threads/<session>.workers.json: follow-ups work after the app-server is recreated. */
  /** This conversation's workers in the old journal's shape (the restart snapshot, and the journal of a core of its own). */
  get workerRecords(): WorkerRecord[] {
    if (!this.config.workerCore) {
      // A restart snapshot's own keys are not the journal's.
      return this.journal.map(({ restartSafe: _safe, restartTurn: _turn, ...record }) => record);
    }
    const session = this.config.ownerSession ?? "";
    return this.core.all().filter((r) => r.ownerSessionId === session).map(toLegacyCodex)
      .map(({ restartSafe: _safe, restartTurn: _turn, ...record }) => record).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  get restartTurn(): string | undefined { return this.turn?.id ?? undefined; }

  get restartBlocker(): string | undefined {
    if([...this.monitors.values()].some(m=>monitorActive(m)||m.wake==="dispatching"||m.wake==="uncertain"))
      return "A monitored command or its callback has an unconfirmed outcome. Reconcile the original monitor; it was not replayed.";
    return undefined;
  }

  get restartWorkers(): WorkerRecord[] {
    const records = new Map(this.core.all().map((r) => [r.id, r]));
    return this.workerRecords.map((record) => {
      const r = records.get(record.id);
      const editor = r?.adapter === "component-editor";
      const safe = r?.status === "running" && (editor ? this.editor.restartSafe(r) : this.threads.restartSafe(r.id));
      return { ...record, restartTurn: r && !editor ? this.threads.turnOf(r.id) ?? undefined : undefined, restartSafe: !!safe };
    });
  }

  /** Workers at work, reports the coordinator has not been shown, restart checks and monitors: the bot must not sleep. */
  get hasManagedWork(): boolean {
    // A report shown in the turn under way keeps the bot awake through that turn (as in 1.x), not as pending work.
    const workers = this.core.hostedLive.some((id) => {
      const r = this.core.get(id);
      return !!r && (r.status === "running" || !!r.cleanup || (!r.owner && r.report.state === "pending"));
    });
    return workers || this.restartPending.size > 0 || [...this.monitors.values()].some((monitor) => monitorActive(monitor) || monitor.wake === "pending");
  }

  /** For codex-threads/<session>.monitors.json, by id. */
  get monitorRecords(): CommandMonitor[] {
    return [...this.monitors.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((monitor) => ({ ...monitor }));
  }

  // ------------------------------------------------------------------------------------------
  // Command monitors and routines

  private monitorTool(tool: string, args: any): { payload: unknown; success: boolean; out: CodexOutput[] } {
    const command = typeof args.command === "string" ? args.command : null;
    if (tool === "app_monitor_start" && command !== null && command.trim() && Buffer.byteLength(command) <= 16_384 && !command.includes("\0")) {
      // Keep every unacknowledged report; prune only settled history.
      if (this.monitors.size >= 128) {
        const oldest = [...this.monitors.values()].filter((m) => !monitorActive(m) && (m.wake === "delivered" || m.wake === "suppressed")).sort((a, b) => a.createdAt - b.createdAt)[0];
        if (oldest) this.monitors.delete(oldest.id);
      }
      if (this.monitors.size >= 128 || [...this.monitors.values()].filter(monitorActive).length >= 16) {
        return { payload: { error: "Monitor limit reached; cancel active monitors or resolve pending results." }, success: false, out: [] };
      }
      const id = randomUUID().toLowerCase();
      const record: CommandMonitor = { id, owner: (this.config.ownerSession ?? "").toUpperCase(), ownerRole: "coordinator", threadId: this.threadId ?? undefined, turnId: this.turn?.id ?? undefined, command, cwd: this.config.cwd, state: "awaitingApproval", stdout: "", stderr: "", detail: "", wake: "none", createdAt: toSwiftDate() };
      this.monitors.set(id, record);
      return {
        payload: monitorPayload(record), success: true, out: [
          this.item({ kind: "toolUse", id, tool: "Monitor", title: `Monitor ${firstLine(command)}`, detail: command, parent: null, input: { command } }),
          this.item({ kind: "permission", requestId: `monitor:${id}`, tool: "Monitored command", summary: `${command}\n\nWorking directory: ${record.cwd}\nWorkspace sandbox; network disabled. Completion wakes this Codex bot once.`, input: {} }),
          ...this.pendingChanged(),
        ],
      };
    }
    const monitorId = typeof args.monitor_id === "string" ? args.monitor_id : null;
    if (tool === "app_monitor_status") {
      if (monitorId !== null) {
        const record = this.monitors.get(monitorId);
        return record ? { payload: monitorPayload(record), success: true, out: [] } : { payload: { error: "Unknown monitor_id for this owner." }, success: false, out: [] };
      }
      return { payload: { monitors: this.monitorRecords.map(monitorSummary) }, success: true, out: [] };
    }
    if (tool === "app_monitor_cancel" && monitorId !== null && this.monitors.has(monitorId)) {
      const out = this.cancelMonitors(new Set([monitorId]));
      return { payload: monitorPayload(this.monitors.get(monitorId)!), success: true, out };
    }
    return { payload: { error: "Invalid monitor arguments. Use command (nonempty, at most 16384 bytes), or an owned monitor_id." }, success: false, out: [] };
  }

  private approveMonitor(id: string, allow: boolean): CodexOutput[] {
    const record = this.monitors.get(id);
    if (this.stopped || !record || record.state !== "awaitingApproval") return [];
    if (!allow) return this.cancelMonitors(new Set([id]));
    record.state = "running";
    // Standalone command/exec does not inherit the thread's sandbox: it is said explicitly, so the
    // user's own full-access or network settings never take over.
    return [
      this.request("command/exec", {
        command: shell(record.command), cwd: record.cwd, processId: id, disableTimeout: true, outputBytesCap: MONITOR_OUTPUT_LIMIT,
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [...new Set([this.config.cwd, ...(this.config.writableRoots ?? [])])].sort(), networkAccess: false },
      }, { kind: "monitorCommand", id }),
      ...this.pendingChanged(),
    ];
  }

  private completeMonitor(id: string, result: any, error: any): CodexOutput[] {
    const record = this.monitors.get(id);
    if (!record || (record.state !== "running" && record.state !== "cancelling") || this.stopped) return [];
    const exit = typeof result?.exitCode === "number" ? result.exitCode : null;
    if (exit === null) delete record.exitCode; else record.exitCode = exit;
    record.stdout = bounded(typeof result?.stdout === "string" ? result.stdout : "");
    record.stderr = bounded(typeof result?.stderr === "string" ? result.stderr : "");
    const cancelled = record.state === "cancelling";
    record.state = cancelled ? "cancelled" : !error && exit === 0 ? "succeeded" : "failed";
    record.detail = error ? bounded(message(error)) : exit === null ? "No exit status was returned." : "";
    record.endedAt = toSwiftDate();
    record.wake = cancelled ? "suppressed" : "pending";
    const out: CodexOutput[] = [this.item({ kind: "monitorEnded", id, output: json(monitorPayload(record)), failed: record.state !== "succeeded" })];
    if (!this.turn) out.push(...this.next());
    out.push(...this.pendingChanged());
    return out;
  }

  /** Cancels monitors (all, or `ids`) and suppresses their wake; a running one is asked to end (`command/exec/terminate`). */
  cancelMonitors(ids?: Set<string>): CodexOutput[] {
    const out: CodexOutput[] = [];
    for (const record of this.monitorRecords) {
      if (ids && !ids.has(record.id)) continue;
      const monitor = this.monitors.get(record.id)!;
      if (!monitorActive(monitor) && monitor.wake !== "pending") continue;
      monitor.wake = "suppressed";
      if (!monitorActive(monitor) || monitor.state === "cancelling") continue;
      const running = monitor.state === "running";
      monitor.state = running ? "cancelling" : "cancelled";
      if (running) delete monitor.endedAt; else monitor.endedAt = toSwiftDate();
      monitor.detail = "Cancellation requested; completion wake suppressed. Side effects may have occurred. Termination is unconfirmed until a terminal result arrives.";
      if (running) {
        out.push(this.request("command/exec/terminate", { processId: monitor.id }, { kind: "other" }));
      } else {
        out.push(this.item({ kind: "permissionCancelled", requestId: `monitor:${monitor.id}` }));
        out.push(this.item({ kind: "monitorEnded", id: monitor.id, output: "Monitor cancelled before execution; wake suppressed.", failed: true }));
      }
    }
    return [...out, ...this.pendingChanged()];
  }

  /** `app_routines`: this bot's schedules, through the same store as the app's clock. */
  private routinesTool(args: Record<string, unknown>): { payload: unknown; success: boolean } {
    return appRoutinesCall(this.config.routinesFile, args);
  }

  /**
   * Execution and queued callbacks in this live runtime, for the completion judge (`completionWorkerDependencies`);
   * persisted flags and cards cannot establish liveness.
   */
  get completionDependencies(): WorkerDependency[] {
    if (this.stopped) return [];
    // The core's (its own workers: runs under way and reports waiting), less the report shown right now.
    const workers = this.core.completionDependencies.filter((dependency) => this.core.get(dependency.id)?.report.state !== "dispatching");
    const commands = [...this.monitors.values()].flatMap((monitor): WorkerDependency[] => {
      if (monitor.state !== "running" && monitor.wake !== "pending") return [];
      return [{ id: monitor.id, run: 1, task: monitor.command, state: monitor.state === "running" ? "running" : "reportQueued", callback: "app_monitor_result",
        ...(monitor.state === "running" ? {} : { outcome: monitor.state }), taskTruncated: false }];
    });
    return [...workers, ...commands];
  }

  /** Workers at work now (for the bot's view and tests). */
  get runningWorkers(): string[] {
    return this.core.running;
  }

  /** Its workers, provider-neutral (workers.ts). */
  get workerInfos(): WorkerInfo[] {
    return this.core.listWorkers();
  }

  /** A follow-up for one worker (workers.ts `sendToWorker`): joined into its turn at work, else its next run. */
  sendToWorker(task: string, text: string): { result: WorkerSendResult; out: CodexOutput[] } {
    if (this.stopped) return { result: { ok: false, reason: "No such worker." }, out: [] };
    const result = syncResult(this.core.sendToWorker(task, text), { ok: false, reason: "This worker is starting or stopping; try again in a moment.", busy: true });
    return { result, out: [...this.take(), ...this.pendingChanged()] };
  }

  private pendingChanged(): CodexOutput[] {
    const pending = this.hasManagedWork;
    if (pending === this.pending) return [];
    this.pending = pending;
    return [this.item({ kind: "managedPending", pending })];
  }

  private managedTool(rpcId: unknown, params: any): CodexOutput[] {
    const id = key(rpcId);
    const reply = (payload: unknown, success: boolean) => ({ jsonrpc: "2.0", id: rpcId, result: { success, contentItems: [{ type: "inputText", text: json(payload) }] } });
    const tool = typeof params.tool === "string" ? params.tool : null;
    let args: any = params.arguments;
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = null; } }
    if (!args || typeof args !== "object") args = {};
    if (tool && isBotTool(tool)) {
      // The bot tools (the user's browser pane, the Note): the coordinator's or a worker's call, answered by the bot.
      return [{ kind: "browser", rpcId, tool, args, ...(params.threadId !== this.threadId ? { worker: true } : {}) }];
    }
    if (tool === "app_notify_owner") {
      // A worker's note to its owner (never the coordinator's tool): its run goes on.
      const requester = params.threadId !== this.threadId ? this.threads.requester(params.threadId) : null;
      if (!requester) return [{ kind: "write", value: reply({ error: "Only an app-managed worker can use app_notify_owner." }, false) }];
      try { return [{ kind: "write", value: reply({ ...this.core.notifyOwner(requester.id, args), message: "Sent to your owner. Keep working; an answer, if any, joins this run as a message." }, true) }]; }
      catch (error) { return [{ kind: "write", value: reply({ error: (error as Error).message }, false) }]; }
    }
    if (tool?.startsWith("app_monitor_") && params.threadId !== this.threadId) {
      const requester = this.threads.requester(params.threadId);
      const response = reply(monitorHandback(tool, args, { task_id: requester?.id ?? null, run: requester?.run ?? null, owner_session_id: this.config.ownerSession?.toLowerCase() ?? null,
        requester_thread_id: params.threadId ?? null, requester_turn_id: params.turnId ?? null, cwd: this.config.cwd }), false);
      return [{ kind: "write", value: response }];
    }
    if (!this.threadId || !this.managed || this.stopped || (this.finishing && tool !== "app_task_checkpoint") || params.threadId !== this.threadId) {
      const response = reply({ error: "App handoff tools are available only to the active coordinator." }, false);
      return [{ kind: "write", value: response }];
    }
    if (tool === "app_monitor_start" && (!this.turn || params.turnId !== this.turn.id)) {
      return [{ kind: "write", value: reply({ error: "A monitor must be created by the current owning Codex turn." }, false) }];
    }
    // RPC IDs alone are not identities. Session/thread/turn own a receipt; altered
    // call identity or intent under that key is a collision, never another execution.
    const cacheKey = JSON.stringify([this.config.ownerSession ?? null, this.threadId, params.turnId ?? null, rpcId]);
    const intent = JSON.stringify([tool, params.callId ?? null, args]);
    const known = this.toolReplies.get(cacheKey);
    if (known) return [{ kind: "write", value: known.intent === intent ? known.response
      : reply({ error: "RPC identity was reused with different tool intent; nothing was executed." }, false) }];
    const out: CodexOutput[] = [];
    let response: Record<string, unknown>;
    const owned = (tool === "app_send_message" || tool === "app_task_checkpoint" || tool === "app_cancel_task") && typeof args.task_id === "string" ? this.core.get(args.task_id)?.owner : undefined;
    if (owned) {
      response = reply({ error: movedTaskError(owned.name) }, false);
    } else if (tool === "app_routines") {
      const handled = this.routinesTool(args);
      response = reply(handled.payload, handled.success);
      if (handled.success) {
        out.push(
          this.item({ kind: "toolUse", id, tool: "app_routines", title: `Routines: ${typeof args.operation === "string" ? args.operation : ""}`, detail: json(args), parent: null, input: {} }),
          this.item({ kind: "toolResult", id, output: json(handled.payload), failed: false, parent: null, launch: null }),
        );
        if (args.operation !== "list") out.push(this.item({ kind: "routinesChanged" }));
      }
    } else if (tool?.startsWith("app_monitor_")) {
      const handled = this.monitorTool(tool, args);
      response = reply(handled.payload, handled.success);
      out.push(...handled.out);
    } else if (tool === "app_handoff" && typeof args.instructions === "string" && args.instructions.trim()) {
      if (args.role !== undefined && (args.role !== "component-editor" || !this.config.componentEditor?.launch)) {
        const denied = reply({ error: this.config.componentEditor?.error ?? "The requested component-editor role is unavailable to this coordinator. Only the app-created Maintainer can use it; no generic worker was launched." }, false);
        this.toolReplies.set(cacheKey, { intent, response: denied });
        return [{ kind: "write", value: denied }];
      }
      if (args.instructions.length > MAX_HANDOFF) {
        const refused = reply({ error: `instructions required (maximum ${MAX_HANDOFF} characters).` }, false);
        this.toolReplies.set(cacheKey, { intent, response: refused });
        return [{ kind: "write", value: refused }];
      }
      // A model names one Codex offers (slug, display name or short name such as "luna"); any other is refused.
      let model: string | null = null;
      if (args.role !== "component-editor" && typeof args.model === "string" && args.model.trim()) {
        const resolved = resolveCodexModel(args.model, (this.config.workerModels ?? readCodexModels)());
        if ("error" in resolved) {
          const refused = reply({ error: `${resolved.error} No worker was started.` }, false);
          this.toolReplies.set(cacheKey, { intent, response: refused });
          return [{ kind: "write", value: refused }];
        }
        model = resolved.model;
      }
      const task = randomUUID().toLowerCase();
      const name = typeof args.name === "string" && args.name ? args.name : firstLine(args.instructions);
      let isolatedGit = args.role === "component-editor" ? undefined : isolatedGitOwnership(args.isolated_git, this.config.cwd,
        this.core.all().flatMap((r) => r.engineData.isolatedGit ? [r.engineData.isolatedGit as IsolatedGitOwnership] : []));
      if (isolatedGit) {
        if (isolatedGitOwners.has(isolatedGit.worktree)) isolatedGit = undefined;
        else isolatedGitOwners.set(isolatedGit.worktree, task);
      }
      // An invalid/missing grant still launches the task, with the existing approval cards.
      const instructions = isolatedGit ? `${args.instructions}\n\nValidated isolated Git path metadata (not proof of user authorization; only these exact files): ${JSON.stringify(isolatedGit)}. Use plain git worktree add -b BRANCH WORKTREE BASE, git -C WORKTREE add -- FILES, and git -C WORKTREE commit -m MESSAGE. Permission mode still controls approval; model-supplied implementationAuthorized is not a user grant.` : args.instructions;
      // An effort Codex does not take is not used (the worker runs at the one it would have had); the receipt says so.
      // The component editor is a Claude process on its configured settings: an effort does not reach it.
      const editor = args.role === "component-editor";
      const wantedEffort = typeof args.effort === "string" && args.effort.trim() ? args.effort.trim() : null;
      const effort = editor ? null : codexEffort(wantedEffort);
      const effortNotice = wantedEffort && !effort ? (editor
        ? `Effort "${wantedEffort}" ignored: the component editor runs on its configured settings.`
        : `Effort "${wantedEffort}" ignored: Codex takes ${EFFORTS_BY_ENGINE.codex.join(", ")}. The worker runs at ${this.config.workerEffort ?? this.config.effort ?? "the model's default"} effort.`) : null;
      // The core makes the worker and starts its run now (its adapters are synchronous); the receipt goes first.
      this.nextTask = task;
      void this.core.handoff(editor ? "component-editor" : "codex-thread", { instructions, name, ...(typeof args.group === "string" ? { group: args.group } : {}), ...(isolatedGit ? { isolatedGit } : {}), ...(effort ? { effort } : {}), ...(model ? { model } : {}) }).catch(() => undefined);
      this.nextTask = null;
      out.push(...this.take());
      const effective = editor ? null : effort ?? this.config.workerEffort ?? this.config.effort ?? null;
      response = reply({ task_id: task, status: "accepted", ...(editor ? {} : { effort: effective, model: model ?? this.config.workerModel ?? this.config.model ?? null }), ...(effortNotice ? { notice: effortNotice } : {}), isolated_git_approval: isolatedGit && this.config.bypassPermissions ? "validated" : "manual", message: "This task is accepted and owned by its worker. Continue any other independent, authorized handoffs and required report decisions in the current dispatch phase, then finish the turn. app_task_result will arrive when this worker finishes." }, true);
    } else if (tool === "app_send_message" && typeof args.task_id === "string" && typeof args.message === "string" && args.message && this.core.get(args.task_id)) {
      // Into its turn at work, else its next run (a report the coordinator was not shown yet is dropped, as before).
      // Not the core's `message()`: its checkpoint rule refuses a follow-up until an unshown or uncertain report is
      // settled (Antigravity's contract, which has app_reconcile_report), while a Codex coordinator's follow-up
      // supersedes a report it has not been shown (1.x's contract; it has no reconcile tool); and `message()` is async,
      // where this answers the tool call with the outputs it causes. Owner and task checks are the same (above).
      const { result, out: sent } = this.sendToWorker(args.task_id, args.message);
      out.push(...sent);
      response = result.ok ? reply({ task_id: args.task_id, status: result.how === "steered" ? "queued" : "accepted" }, true) : reply({ error: result.reason }, false);
    } else if (tool === "app_task_checkpoint") {
      // The coordinator's decision on a report it was shown (the core's checks).
      try {
        const done = this.core.checkpoint(args);
        out.push(
          this.item({ kind: "toolUse", id, tool: "app_task_checkpoint", title: `Task checkpoint: ${done.outcome}`, detail: json(args), parent: null, input: {} }),
          this.item({ kind: "toolResult", id, output: done.evidence.trim(), failed: false, parent: null, launch: null }),
        );
        response = reply({ task_id: done.task_id, outcome: done.outcome, recorded: true }, true);
      } catch (error) {
        response = reply({ error: (error as Error).message }, false);
      }
    } else {
      response = reply({ error: "Invalid app tool arguments or unknown task_id. Use app_handoff to create a task, then app_send_message with its task_id." }, false);
    }
    this.toolReplies.set(cacheKey, { intent, response });
    // The receipt goes first, so slow thread startup never keeps the model waiting.
    return [{ kind: "write", value: response }, ...out, ...this.pendingChanged()];
  }

  /**
   * A restart check came back: its interrupted run goes on as the same run (continued or adopted). A worker from an old
   * restart journal (no ledger record of the restart) starts its next run instead.
   */
  private restartRun(id: string, words: string): CodexOutput[] {
    const same = this.core.get(id)?.interruptedBy === "restart";
    const sent = syncResult(same ? this.core.resumeRun(id, words) : this.core.sendToWorker(id, words), { ok: false, reason: "Restart recovery could not resume this worker." });
    const out = this.take();
    if (!sent.ok) out.push(this.workerItem({ kind: "subagentEnded", id, status: "interrupted", summary: `Restart recovery could not resume this worker: ${sent.reason}` }));
    return out;
  }

  /** CodexHead read the editor's transcript after a restart (`recoverEditor` output). */
  recoverEditor(task: string, run: number, outcome: ClaudeRestartOutcome): CodexOutput[] {
    const record = this.restartPending.get(task);
    this.restartPending.delete(task);
    const worker = this.core.get(task);
    if (!worker || !record || worker.run !== run || worker.status !== "interrupted" || this.stopped) return this.pendingChanged();
    if (outcome.state === "blocked") return [this.workerItem({ kind: "subagentEnded", id: task, status: "interrupted", summary: outcome.reason }), ...this.pendingChanged()];
    if (outcome.state === "completed") {
      this.editor.adopt(task, outcome.report);
      return [...this.restartRun(task, ADOPTED_RUN), ...this.pendingChanged()];
    }
    this.editor.continueAfterRestart(task);
    return [...this.restartRun(task, `${RESTART_NOTE}\nOriginal assignment (unchanged scope):\n${record.ownershipInstructions ?? record.instructions}`), ...this.pendingChanged()];
  }

  /** The editor's Claude process started (EditorTransport). */
  componentEditorStarted(task: string, run: number, pid = 0): CodexOutput[] {
    this.editor.started(task, run, pid);
    return this.take();
  }

  /** The editor's Claude events belong to its task/run, never to the coordinator's reply. */
  componentEditorItem(task: string, run: number, item: StreamItem): CodexOutput[] {
    if (this.stopped) return [];
    this.editor.item(task, run, item);
    return [...this.take(), ...this.pendingChanged()];
  }

  componentEditorFailed(task: string, run: number, reason: string, fresh = false): CodexOutput[] {
    if (this.stopped) return [];
    this.editor.failed(task, run, reason, fresh);
    return [...this.take(), ...this.pendingChanged()];
  }

  /**
   * Words for a worker that is at work now (the sub-bot hand-off's wrap-up request): joined into its turn
   * (`turn/steer`) like any follow-up. A worker not at work gets nothing: this never starts a new run.
   */
  wrapUpWorker(task: string, text: string): CodexOutput[] {
    if (this.stopped || !this.core.running.includes(task)) return [];
    return this.sendToWorker(task, text).out;
  }

  /** One finished model request per `thread/tokenUsage/updated` of the coordinator's (workers': their adapter's). */
  private speed = new CodexRequestTracker();
  private requests(method: string, params: any): CodexOutput[] {
    if (typeof params.threadId !== "string" || params.threadId !== this.threadId) return [];
    return this.speed.observe(null, method, params, Date.now()).map(request => this.item({ kind: "request", request }));
  }

  /** Stops workers (all, or these): their turns end and no report is made. A restart check of one is dropped. */
  cancelWorkers(ids?: Set<string>): CodexOutput[] {
    const out: CodexOutput[] = [];
    for (const id of [...this.restartPending.keys()]) {
      if (ids && !ids.has(id)) continue;
      this.restartPending.delete(id);
      out.push(this.workerItem({ kind: "subagentEnded", id, status: "stopped", summary: STOPPED_REPORT }));
    }
    for (const id of this.core.running) if (!ids || ids.has(id)) void this.core.stopWorker(id);
    return [...out, ...this.take(), ...this.pendingChanged()];
  }

  /** The app-server went away: its workers' runs end with it (their reports wait for the next head). */
  exited(reason: string): CodexOutput[] {
    this.stopped = true;
    this.threads.exited(reason.trim() || "The Codex app-server ended while this worker was at work.");
    return this.take();
  }

  // ------------------------------------------------------------------------------------------
  // Items

  /** An item of the coordinator's turn done: words it said (commentary is a step, the final answer the reply), or a tool's result. */
  private completed(item: any): CodexItem[] {
    if (item?.type === "agentMessage" && typeof item.id === "string") {
      const text = typeof item.text === "string" ? item.text : "";
      const phase = typeof item.phase === "string" ? item.phase : null;
      this.turn?.said.push({ text, phase });
      const words = text.trim();
      return phase === "commentary" && words ? [{ kind: "stepText", text: words }] : [];
    }
    const result = codexToolCompleted(item, this.changedFiles);
    return result ? [{ kind: "toolResult", ...result, parent: null, launch: null }] : [];
  }
}

export type { HeadExit } from "./head";
