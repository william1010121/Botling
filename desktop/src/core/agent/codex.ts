import { type HotSettings } from "./hot-settings";
import { type ClaudeRestartOutcome } from '../claude-restart';
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
import { type WorkerDependency, type CodexItem, type CodexOutput, type WorkerRecord, type CodexConfig, type Call, type Input, type Turn, type Approval } from "./codex-types";
export { type WorkerDependency, codexEffort, type CodexItem, type CodexOutput, type WorkerRecord, type CodexConfig, MANAGED_TOOLS, MANAGED_TOOL_SIGNATURE, WORKER_TOOLS, handbackFallback, firstLine, codexCommand, codexToolStarted } from "./codex-types";
import { CodexThreadAdapter } from "./codex-thread";
export { codexToolCompleted, type CodexWire, type CodexWorkerOptions, CodexThreadAdapter } from "./codex-thread";
export { reply, CodexThreads, type CodexHeadConfig, CodexHead, codexWorkerHost } from "./codex-head";
import { CodexSessionRpc } from "./codex-session-rpc";
import { CodexSessionTurns } from "./codex-session-turns";
import { randomUUID } from "node:crypto";
import type { StreamItem } from "./stream";
import { type WorkerInfo, type WorkerOwner, type WorkerSendResult } from "./workers";
import { ComponentEditorAdapter } from "./component-editor";
import { isActive as monitorActive, reconcile, type CommandMonitor } from "./monitors";
import { noTokens, type TokenUsage } from "../usage";
import { CodexLegacyStore, toLegacyCodex, WorkerCore, type CodexJournal, type CoordinatorPort, type RunEnd, type WorkerCoreOptions, type WorkerReport } from "../worker-core";

export class CodexSession implements CoordinatorPort {
  calls = new Map<number, Call>();
  threadId: string | null = null;
  turn: Turn | null = null;
  completedTurns = new Set<string>();
  /** The coordinator thread's tokens so far, and when the last turn ended (Phase 5c, 1.x's `tokensTotal`). */
  tokensTotal: TokenUsage = noTokens();
  inbox: Input[] = [];
  changedFiles = new Map<string, string[]>();
  finishing = false;
  stopped = false;
  /** Workers whose turn under way when the app restarted is being checked (thread/read, the editor's transcript). */
  restartPending = new Map<string, WorkerRecord>();
  restartCoordinatorPending = false;
  monitors = new Map<string, CommandMonitor>();
  activeMonitor: string | null = null;
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
  out: CodexOutput[] = [];
  /** The report turn under way: whose report the coordinator is shown now. */
  report: { id: string; run: number } | null = null;
  /** The RPC half: what the bot sends in and what codex sends back (codex-session-rpc.ts). */
  private readonly rpc = new CodexSessionRpc(this);
  /** The turn and tool half: the coordinator's turns, reports, monitors and managed tools (codex-session-turns.ts). */
  private readonly turns = new CodexSessionTurns(this);

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
      allowedRetry: (key) => this.rpc.allowedCommands.delete(key),
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
      newId: () => { const id = this.turns.nextTask ?? randomUUID().toLowerCase(); this.turns.nextTask = null; return id; },
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

  // The RPC half (from the bot, from codex) is CodexSessionRpc; these forward to it so every caller stays as it was.
  workerItem(item: CodexItem): CodexOutput { return this.rpc.workerItem(item); }
  take(): CodexOutput[] { return this.rpc.take(); }
  get managed() { return this.rpc.managed; }
  turnSettings(params: Record<string, unknown>) { this.rpc.turnSettings(params); }
  nextReviewer(params: Record<string, unknown>) { this.rpc.nextReviewer(params); }
  private reviewed(params: any, worker: { id: string; name: string } | null): CodexOutput[] { return this.rpc.reviewed(params, worker); }
  closeApprovals(matches: (approval: Approval) => boolean, deny = false): CodexOutput[] { return this.rpc.closeApprovals(matches, deny); }
  start(): CodexOutput[] { return this.rpc.start(); }
  send(text: string, images: string[] = []): CodexOutput[] { return this.rpc.send(text, images); }
  applySettings(target: HotSettings): boolean { return this.rpc.applySettings(target); }
  canApplySettings(target: HotSettings): boolean { return this.rpc.canApplySettings(target); }
  steer(text: string): { joined: boolean; out: CodexOutput[] } { return this.rpc.steer(text); }
  interrupt(): CodexOutput[] { return this.rpc.interrupt(); }
  answerWorker(requestId: string, allow: boolean, why?: string): { answered: boolean; out: CodexOutput[] } { return this.rpc.answerWorker(requestId, allow, why); }
  closeWorkers(): CodexOutput[] { return this.rpc.closeWorkers(); }
  answer(requestId: string, allow: boolean, why?: string): CodexOutput[] { return this.rpc.answer(requestId, allow, why); }
  finish(): CodexOutput[] { return this.rpc.finish(); }
  stop(): CodexOutput[] { return this.rpc.stop(); }
  receive(line: string): CodexOutput[] { return this.rpc.receive(line); }


  // The turn and tool half (coordinator turns, reports, monitors, managed tools, worker follow-ups) is CodexSessionTurns; these forward to it.
  coordinatorReady(thread: string): CodexOutput[] { return this.turns.coordinatorReady(thread); }
  startTurn(input: Input): CodexOutput[] { return this.turns.startTurn(input); }
  learnTurn(id: string): CodexOutput[] { return this.turns.learnTurn(id); }
  turnCompleted(finished: any): CodexOutput[] { return this.turns.turnCompleted(finished); }
  evidence(shown: { id: string; run: number }): { name: string; task: string; status: string; report: string } | null { return this.turns.evidence(shown); }
  settleReport(shown: { id: string; run: number } | null, completed: boolean): CodexOutput[] { return this.turns.settleReport(shown, completed); }
  readonly ack = "checkpoint" as const;
  deliver(report: WorkerReport): "taken" | "queued" | "busy" { return this.turns.deliver(report); }
  setWorkerOwner(task: string, owner: WorkerOwner | null): { ok: true; out: CodexOutput[] } | { ok: false; reason: string } { return this.turns.setWorkerOwner(task, owner); }
  next(): CodexOutput[] { return this.turns.next(); }
  steerCall(input: Input, turnId: string): CodexOutput { return this.turns.steerCall(input, turnId); }
  request(method: string, params: Record<string, unknown>, call: Call): CodexOutput { return this.turns.request(method, params, call); }
  item(item: CodexItem): CodexOutput { return this.turns.item(item); }
  result(ok: boolean, text: string, how?: RunEnd["how"]): CodexOutput { return this.turns.result(ok, text, how); }
  approveMonitor(id: string, allow: boolean): CodexOutput[] { return this.turns.approveMonitor(id, allow); }
  completeMonitor(id: string, result: any, error: any): CodexOutput[] { return this.turns.completeMonitor(id, result, error); }
  cancelMonitors(ids?: Set<string>): CodexOutput[] { return this.turns.cancelMonitors(ids); }
  get completionDependencies(): WorkerDependency[] { return this.turns.completionDependencies; }
  get runningWorkers(): string[] { return this.turns.runningWorkers; }
  get workerInfos(): WorkerInfo[] { return this.turns.workerInfos; }
  sendToWorker(task: string, text: string): { result: WorkerSendResult; out: CodexOutput[] } { return this.turns.sendToWorker(task, text); }
  pendingChanged(): CodexOutput[] { return this.turns.pendingChanged(); }
  managedTool(rpcId: unknown, params: any): CodexOutput[] { return this.turns.managedTool(rpcId, params); }
  restartRun(id: string, words: string): CodexOutput[] { return this.turns.restartRun(id, words); }
  recoverEditor(task: string, run: number, outcome: ClaudeRestartOutcome): CodexOutput[] { return this.turns.recoverEditor(task, run, outcome); }
  componentEditorStarted(task: string, run: number, pid = 0): CodexOutput[] { return this.turns.componentEditorStarted(task, run, pid); }
  componentEditorItem(task: string, run: number, item: StreamItem): CodexOutput[] { return this.turns.componentEditorItem(task, run, item); }
  componentEditorFailed(task: string, run: number, reason: string, fresh = false): CodexOutput[] { return this.turns.componentEditorFailed(task, run, reason, fresh); }
  wrapUpWorker(task: string, text: string): CodexOutput[] { return this.turns.wrapUpWorker(task, text); }
  requests(method: string, params: any): CodexOutput[] { return this.turns.requests(method, params); }
  cancelWorkers(ids?: Set<string>): CodexOutput[] { return this.turns.cancelWorkers(ids); }
  exited(reason: string): CodexOutput[] { return this.turns.exited(reason); }
  completed(item: any): CodexItem[] { return this.turns.completed(item); }

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
}

export type { HeadExit } from "./head";
