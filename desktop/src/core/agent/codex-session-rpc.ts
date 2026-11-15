// The RPC half of `CodexSession` (codex.ts): what the bot sends in (start, send, answer, stop...) and what codex sends back
// (receive: responses, notifications, server requests, approvals and reviews). Moved out of codex.ts as it was (M7-S72).
// `CodexSession` keeps the state both halves share and the turn and tool half; this class reaches them through the bridge
// block below, one forwarder per name, over `CodexSessionHost` (the shape `CodexSession` has, so no import cycle).
import { settingsChange, type HotSettings } from "./hot-settings";
import { RESTART_NOTE } from '../restart-continuation';
import { codexAutoRiskConfig } from "./auto-risk-policy";
import { type CodexItem, type CodexOutput, type WorkerRecord, type CodexConfig, type Call, type Input, type Turn, type Approval, COORDINATOR_CONFIG, MANAGED_TOOLS, handbackFallback, message, json, ADOPTED_RUN, codexToolStarted, writableRootsConfig } from "./codex-types";
import { type CodexThreadAdapter, reviewerOf } from "./codex-thread";
import { randomUUID } from "node:crypto";
import { monitorPayload, type CommandMonitor } from "./monitors";
import { codexRateLimits, codexTokens, isEmptyLimits, type TokenUsage } from "../usage";
import { INTERRUPTED_REPORT, type RunEnd, type WorkerCore } from "../worker-core";

/** What `CodexSessionRpc` borrows from `CodexSession`: its shared state and the turn and tool half. */
export interface CodexSessionHost {
  readonly config: CodexConfig;
  readonly core: WorkerCore;
  readonly threads: CodexThreadAdapter;
  readonly threadId: string | null;
  readonly calls: Map<number, Call>;
  readonly restartPending: Map<string, WorkerRecord>;
  readonly monitors: Map<string, CommandMonitor>;
  readonly changedFiles: Map<string, string[]>;
  readonly completedTurns: Set<string>;
  readonly hasManagedWork: boolean;
  out: CodexOutput[];
  turn: Turn | null;
  inbox: Input[];
  stopped: boolean;
  finishing: boolean;
  restartCoordinatorPending: boolean;
  report: { id: string; run: number } | null;
  activeMonitor: string | null;
  tokensTotal: TokenUsage;
  request(method: string, params: Record<string, unknown>, call: Call): CodexOutput;
  startTurn(input: Input): CodexOutput[];
  steerCall(input: Input, turnId: string): CodexOutput;
  pendingChanged(): CodexOutput[];
  item(item: CodexItem): CodexOutput;
  requests(method: string, params: any): CodexOutput[];
  result(ok: boolean, text: string, how?: RunEnd["how"]): CodexOutput;
  next(): CodexOutput[];
  restartRun(id: string, words: string): CodexOutput[];
  coordinatorReady(thread: string): CodexOutput[];
  completeMonitor(id: string, result: any, error: any): CodexOutput[];
  approveMonitor(id: string, allow: boolean): CodexOutput[];
  cancelMonitors(ids?: Set<string>): CodexOutput[];
  evidence(shown: { id: string; run: number }): { name: string; task: string; status: string; report: string } | null;
  settleReport(shown: { id: string; run: number } | null, completed: boolean): CodexOutput[];
  learnTurn(id: string): CodexOutput[];
  completed(item: any): CodexItem[];
  turnCompleted(finished: any): CodexOutput[];
  managedTool(rpcId: unknown, params: any): CodexOutput[];
}

export class CodexSessionRpc {
  private approvals = new Map<string, Approval>();
  /** Commands the user allowed after Codex's reviewer refused them: asked again, they go through. */
  readonly allowedCommands = new Set<string>();
  /** The coordinator's next turn asks the app instead of the reviewer, once (1.x `reviewerNext`). */
  private reviewerNext: string | null = null;
  /** Reviewer refusals shown as cards: what was refused, and whose. */
  private reviews = new Map<string, { command: string; task: string | null; thread: string; cwd: string }>();
  /** A model switched to in place: every coordinator turn/start carries it (it holds for later turns too). */
  private turnModel: string | null = null;
  constructor(private readonly host: CodexSessionHost) {}

  // ------------------------------------------------------------------------------------------
  // The bridge: what this half borrows from CodexSession, one forwarder per name (the whole interface between the halves)
  private get config() { return this.host.config; }
  private get core() { return this.host.core; }
  private get threads() { return this.host.threads; }
  private get threadId() { return this.host.threadId; }
  private get calls() { return this.host.calls; }
  private get restartPending() { return this.host.restartPending; }
  private get monitors() { return this.host.monitors; }
  private get changedFiles() { return this.host.changedFiles; }
  private get completedTurns() { return this.host.completedTurns; }
  private get hasManagedWork() { return this.host.hasManagedWork; }
  private get out() { return this.host.out; }
  private set out(value: CodexOutput[]) { this.host.out = value; }
  private get turn() { return this.host.turn; }
  private set turn(value: Turn | null) { this.host.turn = value; }
  private get inbox() { return this.host.inbox; }
  private set inbox(value: Input[]) { this.host.inbox = value; }
  private get stopped() { return this.host.stopped; }
  private set stopped(value: boolean) { this.host.stopped = value; }
  private get finishing() { return this.host.finishing; }
  private set finishing(value: boolean) { this.host.finishing = value; }
  private get restartCoordinatorPending() { return this.host.restartCoordinatorPending; }
  private set restartCoordinatorPending(value: boolean) { this.host.restartCoordinatorPending = value; }
  private get report() { return this.host.report; }
  private set report(value: { id: string; run: number } | null) { this.host.report = value; }
  private get activeMonitor() { return this.host.activeMonitor; }
  private set activeMonitor(value: string | null) { this.host.activeMonitor = value; }
  private get tokensTotal() { return this.host.tokensTotal; }
  private set tokensTotal(value: TokenUsage) { this.host.tokensTotal = value; }
  private request(method: string, params: Record<string, unknown>, call: Call) { return this.host.request(method, params, call); }
  private startTurn(input: Input) { return this.host.startTurn(input); }
  private steerCall(input: Input, turnId: string) { return this.host.steerCall(input, turnId); }
  private pendingChanged() { return this.host.pendingChanged(); }
  private item(item: CodexItem) { return this.host.item(item); }
  private requests(method: string, params: any) { return this.host.requests(method, params); }
  private result(ok: boolean, text: string, how?: RunEnd["how"]) { return this.host.result(ok, text, how); }
  private next() { return this.host.next(); }
  private restartRun(id: string, words: string) { return this.host.restartRun(id, words); }
  private coordinatorReady(thread: string) { return this.host.coordinatorReady(thread); }
  private completeMonitor(id: string, result: any, error: any) { return this.host.completeMonitor(id, result, error); }
  private approveMonitor(id: string, allow: boolean) { return this.host.approveMonitor(id, allow); }
  private cancelMonitors(ids?: Set<string>) { return this.host.cancelMonitors(ids); }
  private evidence(shown: { id: string; run: number }) { return this.host.evidence(shown); }
  private settleReport(shown: { id: string; run: number } | null, completed: boolean) { return this.host.settleReport(shown, completed); }
  private learnTurn(id: string) { return this.host.learnTurn(id); }
  private completed(item: any) { return this.host.completed(item); }
  private turnCompleted(finished: any) { return this.host.turnCompleted(finished); }
  private managedTool(rpcId: unknown, params: any) { return this.host.managedTool(rpcId, params); }

  /** A worker's item (the core's, its adapters', a restart check's): for the bot's worker entry. */
  workerItem(item: CodexItem): CodexOutput {
    return { kind: "item", item, worker: true };
  }

  /** What the core, the adapters and the port said since the last call, in order. */
  take(): CodexOutput[] {
    const out = this.out;
    this.out = [];
    return out;
  }

  get managed() { return this.config.workerInstructions !== null; }

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
  turnSettings(params: Record<string, unknown>) {
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

  nextReviewer(params: Record<string, unknown>) {
    if (!this.reviewerNext) return;
    params.approvalsReviewer = this.reviewerNext;
    this.reviewerNext = this.reviewerNext === "user" ? "auto_review" : null;
  }

  /** Codex's reviewer refused a call: a card with its reason (1.x `reviewed`). Allow lets it through next time. */
  reviewed(params: any, worker: { id: string; name: string } | null): CodexOutput[] {
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
  closeApprovals(matches: (approval: Approval) => boolean, deny = false): CodexOutput[] {
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
}
