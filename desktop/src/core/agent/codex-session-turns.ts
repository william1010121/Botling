// The turn and tool half of `CodexSession` (codex.ts): the coordinator's turns (start, learn, complete, next), report delivery,
// command monitors, the app-managed tools (`managedTool`), worker follow-ups and restart checks, and the items a turn is made of.
// Moved out of codex.ts as it was (M7-S73). `CodexSession` keeps the state both halves share and the views over its workers;
// this class reaches them through the bridge block below, one forwarder per name, over `CodexTurnsHost` (the shape
// `CodexSession` has, so no import cycle). Its own state (the call counter, tool receipts, the pending flag, the report
// hand-over flag and the next task id) is declared here.
import { CodexRequestTracker } from "../token-speed";
import { type ClaudeRestartOutcome } from '../claude-restart';
import { RESTART_NOTE } from '../restart-continuation';
import { monitorHandback } from "./monitor-policy";
import { isolatedGitOwnership, type IsolatedGitOwnership } from "./isolated-git";
import { type WorkerDependency, codexEffort, type CodexItem, type CodexOutput, type WorkerRecord, type CodexConfig, type Call, type Input, type Turn, type Approval, MAX_HANDOFF, isolatedGitOwners, shell, handbackFallback, firstLine, message, key, json, ADOPTED_RUN, syncResult } from "./codex-types";
import { type CodexThreadAdapter, codexToolCompleted } from "./codex-thread";
import { reply } from "./codex-head";
import { randomUUID } from "node:crypto";
import type { StreamItem } from "./stream";
import { movedTaskError, type WorkerInfo, type WorkerOwner, type WorkerSendResult } from "./workers";
import { type ComponentEditorAdapter } from "./component-editor";
import { isBotTool } from "../bot-tools";
import { EFFORTS_BY_ENGINE } from "../../contract/efforts";
import { readCodexModels, resolveCodexModel } from "./codex-models";
import { appRoutinesCall } from "../routines";
import { bounded, isActive as monitorActive, MONITOR_OUTPUT_LIMIT, monitorPayload, monitorSummary, type CommandMonitor } from "./monitors";
import { toSwiftDate } from "../store/records";
import { minusTokens, noTokens, totalTokens, type TokenUsage } from "../usage";
import { reportPayload, STOPPED_REPORT, wireStatus, type RunEnd, type WorkerCore, type WorkerReport } from "../worker-core";

/** What `CodexSessionTurns` borrows from `CodexSession`: its shared state, its views and the RPC half. */
export interface CodexTurnsHost {
  readonly config: CodexConfig;
  readonly core: WorkerCore;
  readonly threads: CodexThreadAdapter;
  readonly editor: ComponentEditorAdapter;
  readonly calls: Map<number, Call>;
  readonly completedTurns: Set<string>;
  readonly restartPending: Map<string, WorkerRecord>;
  readonly monitors: Map<string, CommandMonitor>;
  readonly changedFiles: Map<string, string[]>;
  readonly inbox: Input[];
  readonly out: CodexOutput[];
  readonly tokensTotal: TokenUsage;
  readonly finishing: boolean;
  readonly hasManagedWork: boolean;
  readonly monitorRecords: CommandMonitor[];
  readonly managed: boolean;
  threadId: string | null;
  turn: Turn | null;
  stopped: boolean;
  restartCoordinatorPending: boolean;
  report: { id: string; run: number } | null;
  activeMonitor: string | null;
  workerItem(item: CodexItem): CodexOutput;
  take(): CodexOutput[];
  turnSettings(params: Record<string, unknown>): void;
  nextReviewer(params: Record<string, unknown>): void;
  closeApprovals(matches: (approval: Approval) => boolean, deny?: boolean): CodexOutput[];
}

export class CodexSessionTurns {
  private nextId = 1;
  private tokensAtTurnStart: TokenUsage = noTokens();
  private toolReplies = new Map<string, { intent: string; response: Record<string, unknown> }>();
  private pending = false;
  /** A coordinator turn is ending: a report waits for next(), which decides what goes first. */
  private settling = false;
  /** The task id the next hand-off gets (its receipt is written before the core has made it). */
  nextTask: string | null = null;
  constructor(private readonly host: CodexTurnsHost) {}

  // ------------------------------------------------------------------------------------------
  // The bridge: what this half borrows from CodexSession, one forwarder per name (the whole interface between the halves)
  private get config() { return this.host.config; }
  private get core() { return this.host.core; }
  private get threads() { return this.host.threads; }
  private get editor() { return this.host.editor; }
  private get calls() { return this.host.calls; }
  private get completedTurns() { return this.host.completedTurns; }
  private get restartPending() { return this.host.restartPending; }
  private get monitors() { return this.host.monitors; }
  private get changedFiles() { return this.host.changedFiles; }
  private get inbox() { return this.host.inbox; }
  private get out() { return this.host.out; }
  private get tokensTotal() { return this.host.tokensTotal; }
  private get finishing() { return this.host.finishing; }
  private get hasManagedWork() { return this.host.hasManagedWork; }
  private get monitorRecords() { return this.host.monitorRecords; }
  private get managed() { return this.host.managed; }
  private get threadId() { return this.host.threadId; }
  private set threadId(value: string | null) { this.host.threadId = value; }
  private get turn() { return this.host.turn; }
  private set turn(value: Turn | null) { this.host.turn = value; }
  private get stopped() { return this.host.stopped; }
  private set stopped(value: boolean) { this.host.stopped = value; }
  private get restartCoordinatorPending() { return this.host.restartCoordinatorPending; }
  private set restartCoordinatorPending(value: boolean) { this.host.restartCoordinatorPending = value; }
  private get report() { return this.host.report; }
  private set report(value: { id: string; run: number } | null) { this.host.report = value; }
  private get activeMonitor() { return this.host.activeMonitor; }
  private set activeMonitor(value: string | null) { this.host.activeMonitor = value; }
  private workerItem(item: CodexItem) { return this.host.workerItem(item); }
  private take() { return this.host.take(); }
  private turnSettings(params: Record<string, unknown>) { this.host.turnSettings(params); }
  private nextReviewer(params: Record<string, unknown>) { this.host.nextReviewer(params); }
  private closeApprovals(matches: (approval: Approval) => boolean, deny = false) { return this.host.closeApprovals(matches, deny); }

  coordinatorReady(thread: string): CodexOutput[] {
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

  startTurn(input: Input): CodexOutput[] {
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

  learnTurn(id: string): CodexOutput[] {
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

  turnCompleted(finished: any): CodexOutput[] {
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
  evidence(shown: { id: string; run: number }): { name: string; task: string; status: string; report: string } | null {
    const r = this.core.get(shown.id);
    return r ? { name: r.name, task: r.id, status: wireStatus(r.report.status ?? "failed"), report: r.report.text ?? "" } : null;
  }

  /**
   * A report turn ended with no decision on its report: completed, cut short (interrupted, failed, no final answer: its
   * evidence also went to the chat) or never started. The coordinator has no reconcile tool, so each is one attempt
   * without a decision: shown once more, then unresolved (the core's rule). Never taken as handed over.
   */
  settleReport(shown: { id: string; run: number } | null, _completed: boolean): CodexOutput[] {
    if (!shown) return [];
    this.settling = true;
    try { this.core.finishReport(shown.id, shown.run, true); } catch { /* settled meanwhile */ } finally { this.settling = false; }
    return this.take();
  }

  /**
   * The coordinator end of report delivery (CoordinatorPort, checkpoint policy): a report is shown in an app turn of
   * its own with the `app_task_result` tool output, when the coordinator is free; else it waits in the core.
   */
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
  next(): CodexOutput[] {
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

  steerCall(input: Input, turnId: string): CodexOutput {
    return this.request("turn/steer", { threadId: this.threadId ?? "", expectedTurnId: turnId, input: [{ type: "text", text: input.text }] }, { kind: "steer", input });
  }

  request(method: string, params: Record<string, unknown>, call: Call): CodexOutput {
    const id = this.nextId++;
    this.calls.set(id, call);
    return { kind: "write", value: { jsonrpc: "2.0", id, method, params } };
  }

  item(item: CodexItem): CodexOutput {
    return { kind: "item", item };
  }

  /** A turn's end; `how` is how Codex ended it (classifyRun reads it: interrupted is "cancelled"). */
  result(ok: boolean, text: string, how: RunEnd["how"] = ok ? "normal" : "error"): CodexOutput {
    return this.item({ kind: "result", ok, text: ok ? text : "", error: ok ? "" : text, subtype: ok ? "success" : "error", how });
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

  approveMonitor(id: string, allow: boolean): CodexOutput[] {
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

  completeMonitor(id: string, result: any, error: any): CodexOutput[] {
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

  pendingChanged(): CodexOutput[] {
    const pending = this.hasManagedWork;
    if (pending === this.pending) return [];
    this.pending = pending;
    return [this.item({ kind: "managedPending", pending })];
  }

  managedTool(rpcId: unknown, params: any): CodexOutput[] {
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
  restartRun(id: string, words: string): CodexOutput[] {
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
  requests(method: string, params: any): CodexOutput[] {
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
  completed(item: any): CodexItem[] {
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
