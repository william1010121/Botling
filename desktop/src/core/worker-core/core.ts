// The one worker state machine (shared-core spec 3.3). A WorkerCore holds a bot member's workers: it starts runs on
// its adapters, digests each run through a RunPipeline, classifies the end once (classifyRun), writes every state
// transition to its WorkerStore, and hands reports to the coordinator through a CoordinatorPort by the port's
// AckPolicy. It is the member's WorkerHost; the app tools (handoff, send, checkpoint, reconcile, cancel) have one
// implementation here for every coordinator.
//
//   new ──handoff──▶ running ──end──▶ done / failed / stopped (report pending)
//                       │ ──stopWorker / cancel──▶ stopped (no report)
//                       │ ──close (quit)──▶ interrupted (recovery required)
//   (loaded running) ──▶ interrupted (restart | crash, recovery required)
//   ended ──sendToWorker (recovered, cleanup not failed)──▶ running (next run)
//
// Reports: pending ──owner──▶ routed │ ──port "taken"──▶ delivered (policy none: acknowledged)
//          pending ──beginReport──▶ dispatching ──finishReport(ok)──▶ pending (2nd attempt) / unresolved (after 2)
//          dispatching ──finishReport(not ok) or restart──▶ dispatching (uncertain: app_reconcile_report decides)
//          delivered / dispatching in its turn ──checkpoint or same-task follow-up──▶ acknowledged
import { randomUUID } from "node:crypto";
import type { CodexItem, WorkerDependency } from "../agent/codex";
import { movedTaskError, workerRunStarted, type WorkerHost, type WorkerInfo, type WorkerOwner, type WorkerOwnerResult, type WorkerSendResult } from "../agent/workers";
import { processStartTime } from "../process/kill-tree";
import type { HandoffArgs, HandoffRequest, RecoverResult, WorkerAdapter } from "./adapter";
import { classifyRun, ENGINE_NAMES, INTERRUPTED_REPORT } from "./classify";
import type { RunEnd, RunHandle, WorkerAdapterKind, WorkerEvent } from "./events";
import { MAX_PROCESSES, MAX_WORKER_RECORDS, trimRecords, type WorkerLedgerRecord, type WorkerStore } from "./ledger";
import type { LegacySources } from "./migrate";
import { RunPipeline, type ControlEvent } from "./pipeline";
import { ownedWorkerReport, REPORT_LIMIT, reportTag, wireStatus, withDeniedNote, type AckPolicy, type WorkerReport } from "./report";
import { reportOwed, workerState, type WorkerStatus } from "./status";

/** The coordinator end of report delivery (Claude: an app message; Antigravity: a queued report prompt; Codex: a turn with the tool output). */
export interface CoordinatorPort {
  /** Claude: "none"; Codex, Antigravity: "checkpoint". */
  readonly ack: AckPolicy;
  /**
   * Hand the report to the coordinator now ("taken") or queue it ("queued": the port later calls beginReport and
   * finishReport around the turn that shows it). "busy": not now; the core tries again at redeliver().
   */
  deliver(report: WorkerReport, text: string): "taken" | "queued" | "busy";
}

/** Where the core's items go: the bot's one worker entry (`Bot.onWorkerOutput`), through the facade that made the core. */
export interface WorkerSink { item(item: CodexItem): void }

/**
 * How a facade makes its core. A bot injects one per member that keeps the member's ledger (<member store>/
 * worker-ledger.json, importing `legacy` once) and projects every transition; without one (tests, tools) the facade
 * keeps the store it was given.
 */
export type WorkerCoreFactory = (options: WorkerCoreOptions, legacy: LegacySources) => WorkerCore;

export interface WorkerCoreOptions {
  store: WorkerStore;
  port: CoordinatorPort;
  sink: WorkerSink;
  /** The first is the member's own kind (`workerHostKind`); a Codex member adds the component editor. */
  adapters: WorkerAdapter[];
  /** The coordinator's conversation now (a new worker's ownerSessionId, a run's execution.ownerSessionId). */
  ownerSessionId(): string;
  /** Workers at work at once (absent: no limit). More wait for a slot, listed at work with a line saying so. */
  maxRunning?(): number;
  log(line: string): void;
  /** Only the current conversation's workers are listed and take commands (Antigravity); default: all of the member's. */
  sessionScoped?: boolean;
  /** Ids the restart journal lists: found running at load, they were interrupted by a restart, not a crash. */
  restarted?(): ReadonlySet<string>;
  /** Why it closes: the app quits (default) or restarts (runs under way keep their adapter's `restartData`). */
  closeReason?(): "quit" | "restart";
  /** Emit `managedPending` items when whether anything is hosted changes (Codex and Antigravity heads use it to stay awake). */
  pendingSignal?: boolean;
  /** The coordinator's thread, for measurements that name none. */
  parentThreadId?(): string | null;
  now?(): number;
  newId?(): string;
  /** A process's start time (identity), for `process` events that carry none (default: process/kill-tree). */
  processStartTime?(pid: number): string | null;
  /**
   * A record's projected state changed (status, report, cleanup, end, owner): the bot's projections (subagents.json,
   * the chip, agents.json, the step) follow it. A copy; called after the ledger is written.
   */
  projected?(record: WorkerLedgerRecord): void;
}

export interface HandoffResult { accepted: true; task_id: string; run: number }
export interface MessageArgs { task_id?: unknown; run?: unknown; message?: unknown }
export interface MessageResult { task_id: string; run: number; status: "steered" | "accepted" }
export interface CheckpointArgs { task_id?: unknown; run?: unknown; outcome?: unknown; evidence?: unknown; dependency_task_id?: unknown }
export interface CheckpointResult { task_id: string; run: number; outcome: string; evidence: string; dependency_task_id?: string }
export interface ReconcileArgs { task_id?: unknown; run?: unknown; action?: unknown }
export interface ReconcileResult { task_id: string; run: number; action: "acknowledge" | "retry"; taskReplayed: false }

/** What the coordinator reads when it made no decision on a report after the allowed attempts (agy-workers.ts's words). */
export const UNRESOLVED_REPORT = "Worker report unresolved: no task/run checkpoint or same-task continuation after one reconciliation turn. Evidence retained; explicit decision required.";
/** The line put before a report whose run's processes could not be cleaned up. */
export const CLEANUP_FAILED_NOTE = "Worker process cleanup failed. Explicit recovery is required; no continuation permitted.";
export const CHECKPOINT_OUTCOMES = ["complete", "waiting_user", "waiting_dependency", "blocked"] as const;
const MAX_WORDS = 64_000;

/** The request id of a worker's approval card. */
export const workerRequestId = (id: string, run: number, nativeId: string) => `worker:${id}:${run}:${nativeId}`;

/** One run under way (or the latest, ended). */
interface Live {
  run: number;
  pipeline: RunPipeline;
  handle: RunHandle;
  approvals: Map<string, Record<string, unknown>>;
  /** Approvals the user denied in this run (the report's note, decision D2). */
  denied: number;
  /** Waiting for a slot (`maxRunning`): the words it starts with. */
  waiting?: { words: string };
  /** start() has not returned: events are held until it has (and the run's opening items are out). */
  starting: boolean;
  held: WorkerEvent[];
  /** The run is over (ended, stopped, interrupted): its events are dropped. */
  done: boolean;
}

type Maybe<T> = T | Promise<T>;
const then = <T, U>(value: Maybe<T>, next: (value: T) => Maybe<U>): Maybe<U> => (value instanceof Promise ? value.then(next) : next(value));

const firstText = (...values: unknown[]) => values.find((value): value is string => typeof value === "string" && !!value.trim());
const noReport = (): WorkerLedgerRecord["report"] => ({ state: "none", text: null, status: null, attempts: 0 });

export class WorkerCore implements WorkerHost {
  readonly workerHostKind: WorkerAdapterKind;
  readonly steersRunning: boolean;
  private records = new Map<string, WorkerLedgerRecord>();
  private lives = new Map<string, Live>();
  /** Reports the port queued: not handed over again until it begins or drops them. */
  private queued = new Set<string>();
  /** Report turns under way (beginReport → finishReport), by task id: its run. */
  private activeReports = new Map<string, number>();
  private closed = false;
  private lastPending: boolean | null = null;
  /** What each record last showed its projections (`projected`). */
  private shown = new Map<string, string>();
  /**
   * The operation under way on each worker, when it has not finished at once: a start, a stop and its cleanup, a
   * cancel, a recovery, a run's cleanup after its end. One at a time: a follow-up meanwhile is refused (busy), a stop
   * or cancel waits for it. So a run's cleanup is never cut short, overlapped by a next run, or applied to another run.
   */
  private ops = new Map<string, Promise<unknown>>();

  constructor(private options: WorkerCoreOptions) {
    const first = options.adapters[0];
    if (!first) throw new Error("A worker core needs at least one adapter.");
    this.workerHostKind = first.kind;
    this.steersRunning = first.steersRunning;
    const restarted = options.restarted?.() ?? new Set<string>();
    let changed = false;
    for (const record of options.store.load()) {
      if (record.status === "running") {
        // At work when the app went away: interrupted, never replayed.
        const by = restarted.has(record.id) ? "restart" : "crash";
        Object.assign(record, { status: "interrupted", interruptedBy: by, recovery: "required", endedAt: this.now(), report: { ...noReport(), text: INTERRUPTED_REPORT[by], status: "interrupted" } });
        delete record.cleanup;
        changed = true;
      } else if (record.cleanup === "pending") {
        // The app went away while it cleaned up: its processes must be checked before a follow-up.
        delete record.cleanup;
        record.recovery = "required";
        changed = true;
      }
      this.records.set(record.id, record);
    }
    if (changed) this.save();
  }

  private now() { return this.options.now?.() ?? Date.now(); }
  private save() {
    this.options.store.save([...this.records.values()]);
    this.signal();
    this.project(false);
  }

  /** Every record whose projected state changed since it was last shown (`all`: every record) goes to `projected`. */
  private project(all: boolean) {
    const projected = this.options.projected;
    if (!projected) return;
    for (const r of this.records.values()) {
      const key = JSON.stringify([r.run, r.status, r.report.state, r.report.status, r.report.text, r.cleanup ?? null, r.endedAt, r.owner?.botId ?? null]);
      if (!all && this.shown.get(r.id) === key) continue;
      this.shown.set(r.id, key);
      try { projected(structuredClone(r)); } catch (error) { this.options.log(`worker ${r.id}: projection failed: ${(error as Error).message}`); }
    }
  }

  /** Every record to `projected` once (the bot's projections at start, after an import or a restart). */
  projectAll(): void { this.project(true); }
  private emit(item: CodexItem) { this.options.sink.item(item); }
  private adapterOf(r: Pick<WorkerLedgerRecord, "adapter">) { return this.options.adapters.find((a) => a.kind === r.adapter); }
  private visible(r: WorkerLedgerRecord | undefined): r is WorkerLedgerRecord {
    return !!r && (!this.options.sessionScoped || r.ownerSessionId === this.options.ownerSessionId());
  }
  private find(id: unknown): WorkerLedgerRecord | undefined {
    const r = typeof id === "string" ? this.records.get(id) : undefined;
    return this.visible(r) ? r : undefined;
  }

  /** How many may be at work at once now. */
  private get limit(): number {
    const wanted = this.options.maxRunning?.();
    return wanted === undefined || !Number.isFinite(wanted) || wanted < 1 ? Infinity : Math.floor(wanted);
  }
  /** Workers at work now (one waiting for a slot is not). */
  private get busy(): number {
    return [...this.records.values()].filter((r) => r.status === "running" && !this.lives.get(r.id)?.waiting).length;
  }

  private signal() {
    if (!this.options.pendingSignal) return;
    const pending = this.hostedLive.length > 0;
    if (pending === this.lastPending) return;
    this.lastPending = pending;
    this.emit({ kind: "managedPending", pending });
  }

  /**
   * Runs `op` as the worker's one operation: now when none is under way (an op done at once holds nothing), else after
   * the one under way (`wait`) or not at all (`busy`'s answer).
   */
  private exclusive<T>(id: string, op: () => Maybe<T>, busy: (() => T) | "wait"): Maybe<T> {
    const current = this.ops.get(id);
    if (current) return busy === "wait" ? current.then(() => this.exclusive(id, op, busy)) : busy();
    const result = op();
    return result instanceof Promise ? this.track(id, result) : result;
  }

  /**
   * Work on this worker that has not finished: no other operation starts until it (and the one before it) has. The
   * promise it returns settles as `work` does, once the worker is free again (an awaited cancel, then a follow-up).
   */
  private track<T>(id: string, work: Promise<T>): Promise<T> {
    const previous = this.ops.get(id);
    const held: Promise<unknown> = (previous ? Promise.all([previous, work]) : work).catch(() => undefined);
    this.ops.set(id, held);
    return held.then(() => {
      if (this.ops.get(id) === held) this.ops.delete(id);
      return work;
    });
  }

  private static readonly BUSY: WorkerSendResult = { ok: false, busy: true, reason: "This worker is starting or stopping; try again in a moment." };

  // ------------------------------------------------------------------------------------------
  // WorkerHost

  listWorkers(): WorkerInfo[] {
    return [...this.records.values()].filter((r) => this.visible(r)).map((r) => ({
      id: r.id, engine: r.engine, name: r.name, run: r.run, state: workerState(r), conversationId: r.conversationId,
      processes: r.processes.map((p) => ({ ...p })), owner: r.owner ? { ...r.owner } : null,
    }));
  }

  /** One worker's record (a copy), whatever conversation started it. */
  get(id: string): WorkerLedgerRecord | undefined {
    const r = this.records.get(id);
    return r ? structuredClone(r) : undefined;
  }

  /** Every record (copies), oldest first: for a facade's own views. */
  all(): WorkerLedgerRecord[] { return [...this.records.values()].map((r) => structuredClone(r)); }

  sendToWorker(id: string, words: string): Maybe<WorkerSendResult> {
    const r = this.find(id);
    if (!r || this.closed) return { ok: false, reason: "No such worker." };
    if (typeof words !== "string" || !words.trim() || words.length > MAX_WORDS) return { ok: false, reason: `Message required (maximum ${MAX_WORDS} characters).` };
    const adapter = this.adapterOf(r);
    if (!adapter) return { ok: false, reason: "This worker's engine is not available here." };
    if (this.ops.has(r.id)) return WorkerCore.BUSY;
    if (r.status === "running") {
      const live = this.lives.get(r.id);
      if (live?.waiting) {
        // Still waiting for a slot: the words join the run it will start with.
        live.waiting.words = `${live.waiting.words}\n\n${words}`;
        return { ok: true, how: "steered", run: r.run };
      }
      if (!adapter.steersRunning || !adapter.steer) return { ok: false, busy: true, reason: `This ${ENGINE_NAMES[r.engine]} worker is at work and takes no messages until it reports.` };
      let steered = false;
      if (live && !live.starting && !live.done) {
        try { steered = adapter.steer(r, words); } catch (error) { this.options.log(`worker ${r.id}: steer failed: ${(error as Error).message}`); }
      }
      return steered ? { ok: true, how: "steered", run: r.run } : { ok: false, busy: true, reason: "This worker is starting or stopping; try again in a moment." };
    }
    if (r.cleanup === "pending") return { ok: false, busy: true, reason: "This worker is still cleaning up after its run; try again in a moment." };
    const run = r.run;
    return this.exclusive(r.id, () => then(this.recover(r, adapter), (blocker) => {
      if (blocker) return { ok: false, reason: blocker };
      if (this.closed || this.records.get(r.id) !== r || r.run !== run || r.status === "running") return WorkerCore.BUSY;
      return then(this.launch(r, words, false), (error): WorkerSendResult => (error ? { ok: false, reason: error } : { ok: true, how: "newRun", run: r.run }));
    }), () => WorkerCore.BUSY);
  }

  /**
   * After an explicit restart: the interrupted run goes on as the same run (its task id and run stay what the
   * coordinator was told), once its old processes are gone. Nothing is replayed: `words` say how to continue.
   */
  resumeRun(id: string, words: string): Maybe<WorkerSendResult> {
    const r = this.find(id);
    if (!r || this.closed) return { ok: false, reason: "No such worker." };
    if (r.status !== "interrupted" || r.interruptedBy !== "restart") return { ok: false, reason: "Only a run interrupted by a restart resumes as the same run." };
    if (typeof words !== "string" || !words.trim() || words.length > MAX_WORDS) return { ok: false, reason: `Message required (maximum ${MAX_WORDS} characters).` };
    const adapter = this.adapterOf(r);
    if (!adapter) return { ok: false, reason: "This worker's engine is not available here." };
    const run = r.run;
    return this.exclusive(r.id, () => then(this.recover(r, adapter), (blocker) => {
      if (blocker) return { ok: false, reason: blocker };
      if (this.closed || this.records.get(r.id) !== r || r.run !== run || r.status !== "interrupted") return WorkerCore.BUSY;
      return then(this.launch(r, words, false, true), (error): WorkerSendResult => (error ? { ok: false, reason: error } : { ok: true, how: "newRun", run: r.run }));
    }), () => WorkerCore.BUSY);
  }

  /** Clears an interruption or a failed cleanup once the adapter confirms its old processes are gone; else the reason it is blocked. */
  private recover(r: WorkerLedgerRecord, adapter: WorkerAdapter): Maybe<string | null> {
    if (r.recovery !== "required" && r.cleanup !== "failed") return null;
    let checked: Maybe<RecoverResult>;
    try { checked = adapter.recover(r); } catch (error) { return (error as Error).message; }
    const settle = (result: RecoverResult): string | null => {
      if (result.state === "blocked") return result.reason;
      delete r.recovery;
      delete r.cleanup;
      this.save();
      return null;
    };
    return checked instanceof Promise ? checked.then(settle, (error: Error) => error.message) : settle(checked);
  }

  /** Stops its run (after the operation under way, if any): false when it is not at work by then. */
  stopWorker(id: string): Promise<boolean> {
    const r = this.find(id);
    if (!r || this.closed) return Promise.resolve(false);
    return Promise.resolve(this.exclusive(r.id, () => {
      if (this.closed || this.records.get(r.id) !== r || r.status !== "running") return false;
      return then(this.stop(r), () => true);
    }, "wait"));
  }

  setWorkerOwner(id: string, owner: WorkerOwner | null): WorkerOwnerResult {
    const r = this.find(id);
    if (!r || this.closed) return { ok: false, reason: "No such worker." };
    if (owner && (r.report.state === "dispatching" || this.activeReports.has(r.id))) return { ok: false, reason: "Its report is being handed to its coordinator right now; try again in a moment." };
    if (owner) r.owner = { ...owner };
    else delete r.owner;
    // A report the coordinator has not settled goes to the owner instead.
    if (owner && r.status !== "running" && r.cleanup !== "pending" && (reportOwed(r.report.state) || r.report.state === "unresolved")) {
      r.report.state = "pending";
      this.queued.delete(r.id);
    }
    this.save();
    if (owner) this.deliver(r);
    return { ok: true };
  }

  /** An approval card's answer (`worker:<task>:<run>:<engine's request id>`). False: no such approval now. */
  answer(requestId: string, allow: boolean, input: Record<string, unknown>, message?: string): boolean {
    const match = /^worker:([^:]+):(\d+):(.+)$/.exec(requestId);
    if (!match || this.closed) return false;
    const r = this.records.get(match[1]!);
    const live = r ? this.lives.get(r.id) : undefined;
    const nativeId = match[3]!;
    if (!r || r.status !== "running" || r.run !== Number(match[2]) || !live || live.done || live.run !== r.run || !live.approvals.delete(nativeId)) return false;
    if (!allow) live.denied += 1;
    try { this.adapterOf(r)?.answer(r, nativeId, allow, input, message); } catch (error) { this.options.log(`worker ${r.id}: answer failed: ${(error as Error).message}`); }
    return true;
  }

  /**
   * The app is quitting (or the bot is removed): every run under way is interrupted (not replayed; a later follow-up
   * resumes its conversation once its processes are confirmed gone), then every adapter closes.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    const by = this.options.closeReason?.() ?? "quit";
    for (const r of this.records.values()) {
      if (r.status !== "running") continue;
      if (by === "restart") {
        try { Object.assign(r.engineData, this.adapterOf(r)?.restartData?.(r) ?? {}); } catch (error) { this.options.log(`worker ${r.id}: restart data: ${(error as Error).message}`); }
      }
      const live = this.lives.get(r.id);
      if (live) { live.done = true; live.waiting = undefined; live.pipeline.flush(); this.cancelApprovals(r, live); }
      const verdict = classifyRun({ end: null, reply: "", stoppedByApp: false, interruptedBy: by, requireReply: true, failedTools: 0 });
      Object.assign(r, { status: "interrupted", interruptedBy: by, recovery: "required", endedAt: this.now(), report: { ...noReport(), text: verdict.report, status: "interrupted" } });
      this.emit({ kind: "subagentEnded", id: r.id, status: wireStatus("interrupted"), summary: verdict.report });
    }
    this.closed = true;
    this.save();
    await Promise.allSettled(this.options.adapters.map((adapter) => adapter.close()));
  }

  // ------------------------------------------------------------------------------------------
  // App tools

  /** app_handoff: a new worker on `adapter`, its first run started. Throws the refusal (nothing recorded). */
  async handoff(kind: WorkerAdapterKind, args: HandoffArgs): Promise<HandoffResult> {
    if (this.closed) throw new Error("Workers are closed: the app is stopping.");
    const adapter = this.options.adapters.find((a) => a.kind === kind);
    if (!adapter) throw new Error(`No ${kind} workers here.`);
    const instructions = firstText(args.instructions, args.prompt, args.task) ?? "";
    if (!instructions.trim() || instructions.length > MAX_WORDS) throw new Error(`instructions required (maximum ${MAX_WORDS} characters).`);
    const named = firstText(args.name, args.description);
    const request: HandoffRequest = {
      instructions, name: named ? named.trim().slice(0, 200) : instructions.split("\n")[0]!.slice(0, 80),
      type: firstText(args.subagent_type)?.trim() ?? null, model: firstText(args.model)?.trim() ?? null,
      engine: typeof args.engine === "string" ? args.engine : null, args,
    };
    const prepared = adapter.prepare?.(request) ?? {};
    const r: WorkerLedgerRecord = {
      v: 3, id: this.options.newId?.() ?? randomUUID(), engine: prepared.engine ?? adapter.engine, adapter: kind, name: request.name, instructions,
      type: request.type, ownerSessionId: this.options.ownerSessionId(), run: 0, status: "new", report: noReport(), conversationId: null,
      processes: [], createdAt: this.now(), runStartedAt: null, endedAt: null, engineData: { ...(prepared.engineData ?? {}) },
    };
    this.records.set(r.id, r);
    // Room is made among the others: the worker being made is never the one forgotten (with none forgettable it is
    // kept as one more; the ledger keeps it too, as a running record).
    this.trim(r.id);
    const error = await this.launch(r, instructions, true);
    if (error) throw new Error(error);
    return { accepted: true, task_id: r.id, run: r.run };
  }

  /** The coordinator's own app tool calls name a worker it still owns, on its current run. */
  private owned(taskId: unknown, run: unknown): WorkerLedgerRecord {
    const r = this.find(taskId);
    if (!r) throw new Error("Unknown task_id. Use the task_id app_handoff returned.");
    if (r.owner) throw new Error(movedTaskError(r.owner.name));
    if (run !== undefined && run !== null && run !== r.run) throw new Error(`Stale run: this worker is on run ${r.run}.`);
    return r;
  }

  /**
   * app_send_message: steers the run under way where the engine can, else starts the next run. Under the checkpoint
   * policy a report the coordinator has not been shown, or whose hand-over is uncertain, must be settled first;
   * a same-task follow-up after it was shown settles it.
   */
  async message(args: MessageArgs): Promise<MessageResult> {
    if (this.closed) throw new Error("Workers are closed: the app is stopping.");
    const r = this.owned(args.task_id, args.run);
    if (this.options.port.ack === "checkpoint" && r.status !== "running" && this.activeReports.get(r.id) !== r.run
      && (r.report.state === "dispatching" || (r.report.state === "pending" && r.report.attempts === 0)))
      throw new Error("The prior worker report must be acknowledged before continuation.");
    const sent = await this.sendToWorker(r.id, typeof args.message === "string" ? args.message : "");
    if (!sent.ok) throw new Error(sent.reason);
    return { task_id: r.id, run: sent.run, status: sent.how === "steered" ? "steered" : "accepted" };
  }

  /** app_task_checkpoint: the coordinator's decision on a report it was shown. */
  checkpoint(args: CheckpointArgs): CheckpointResult {
    if (this.closed) throw new Error("Workers are closed: the app is stopping.");
    const r = this.owned(args.task_id, args.run);
    const during = this.activeReports.get(r.id) === r.run;
    const shown = during || r.report.state === "delivered" || r.report.state === "unresolved" || (r.report.state === "pending" && r.report.attempts > 0);
    if (r.status === "running" || r.cleanup === "pending" || !shown) throw new Error("No delivered report available for a checkpoint.");
    const outcome = String(args.outcome);
    if (!(CHECKPOINT_OUTCOMES as readonly string[]).includes(outcome) || typeof args.evidence !== "string" || !args.evidence.trim() || args.evidence.length > 16_000)
      throw new Error("Checkpoint outcome and concrete evidence required.");
    let dependency: string | undefined;
    if (outcome === "waiting_dependency") {
      const other = this.find(args.dependency_task_id);
      if (!other || other === r || other.status !== "running") throw new Error("Checkpoint needs another actively running dependency_task_id.");
      dependency = other.id;
    } else if (args.dependency_task_id !== undefined && args.dependency_task_id !== null && !(typeof args.dependency_task_id === "string" && !args.dependency_task_id.trim())) {
      // Models routinely fill an optional field with "" or null; that means "no dependency".
      throw new Error("dependency_task_id requires waiting_dependency.");
    }
    r.report.state = "acknowledged";
    r.report.checkpoint = { outcome, evidence: args.evidence, ...(dependency ? { dependencyTaskId: dependency } : {}) };
    this.activeReports.delete(r.id);
    this.queued.delete(r.id);
    this.save();
    return { task_id: r.id, run: r.run, outcome, evidence: args.evidence, ...(dependency ? { dependency_task_id: dependency } : {}) };
  }

  /** app_reconcile_report: settles a report whose hand-over is uncertain (no replay of the task itself). */
  reconcile(args: ReconcileArgs): ReconcileResult {
    if (this.closed) throw new Error("Workers are closed: the app is stopping.");
    const r = this.owned(args.task_id, args.run);
    if (r.status === "running" || r.cleanup === "pending" || r.report.state !== "dispatching") throw new Error("No uncertain report available for reconciliation.");
    if (args.action !== "acknowledge" && args.action !== "retry") throw new Error("Explicit report reconciliation action required.");
    if (this.activeReports.get(r.id) === r.run) throw new Error("Report turn is still active.");
    r.report.state = args.action === "acknowledge" ? "acknowledged" : "pending";
    if (args.action === "retry") r.report.attempts = 0;
    this.save();
    if (args.action === "retry") this.deliver(r);
    return { task_id: r.id, run: r.run, action: args.action, taskReplayed: false };
  }

  /**
   * app_cancel_task: stops the run under way (no report), or, for a worker not at work, drops a report the coordinator
   * has not settled and ends anything its adapter keeps alive. Throws when it is blocked (recovery, a failed cleanup).
   */
  async cancel(id: string, run?: number): Promise<{ status: WorkerStatus }> {
    if (this.closed) throw new Error("Workers are closed: the app is stopping.");
    const r = this.owned(id, run);
    // One operation at a time: taken before anything yields, so no follow-up starts a run this cancel could touch.
    return this.exclusive(r.id, () => this.cancelOp(r), "wait");
  }

  private cancelOp(r: WorkerLedgerRecord): Maybe<{ status: WorkerStatus }> {
    const finish = () => {
      if (r.cleanup === "failed") throw new Error("Worker cleanup incomplete; task remains blocked.");
      return { status: r.status };
    };
    if (this.closed || this.records.get(r.id) !== r) return finish();
    if (r.status === "running") return then(this.stop(r), finish);
    const adapter = this.adapterOf(r);
    if (!adapter) return finish();
    const run = r.run;
    return then(this.recover(r, adapter), (blocker) => {
      if (blocker) throw new Error(blocker);
      // Never a newer run's (none can start meanwhile, but this is the rule).
      if (this.records.get(r.id) !== r || r.run !== run || r.status === "running") return finish();
      if (r.report.state === "pending" || r.report.state === "delivered") r.report.state = "none";
      this.queued.delete(r.id);
      this.activeReports.delete(r.id);
      r.cleanup = "pending";
      this.save();
      return then(this.cleanUp(r, adapter), finish);
    });
  }

  // ------------------------------------------------------------------------------------------
  // Coordinator port callbacks

  /** The port is about to show this report in a coordinator turn. False: it is not to be shown (moved, settled, stale, too many attempts). */
  beginReport(id: string, run: number): boolean {
    const r = this.records.get(id);
    if (this.closed || !r || r.owner || r.run !== run || r.report.state !== "pending" || r.status === "running" || r.cleanup === "pending" || r.report.attempts >= 2) return false;
    this.queued.delete(id);
    r.report.state = "dispatching";
    this.activeReports.set(id, run);
    this.save();
    return true;
  }

  /**
   * The turn that showed the report ended. Not completed: the hand-over is uncertain and stays so (never replayed
   * automatically; app_reconcile_report decides). Completed without a decision: shown once more, then unresolved.
   */
  finishReport(id: string, run: number, completed: boolean): void {
    if (this.activeReports.get(id) !== run) return;
    this.activeReports.delete(id);
    const r = this.records.get(id);
    if (this.closed || !r || r.run !== run || r.report.state !== "dispatching" || !completed) return;
    this.undecided(r);
  }

  /**
   * A hand-over whose outcome is unknown and that its coordinator cannot reconcile itself (Codex has no reconcile tool:
   * its report turn never started, or the app went away while it was being shown). It counts as one attempt without a
   * decision: shown once more, then unresolved. Never taken as acknowledged. False: no such uncertain report.
   */
  retryUncertain(id: string, run: number): boolean {
    const r = this.records.get(id);
    if (this.closed || !r || r.run !== run || r.report.state !== "dispatching" || this.activeReports.get(id) === run) return false;
    this.undecided(r);
    return true;
  }

  /** A delivery attempt that ended without the coordinator's decision: shown once more, then unresolved. */
  private undecided(r: WorkerLedgerRecord) {
    r.report.attempts += 1;
    if (r.report.attempts < 2) {
      r.report.state = "pending";
      this.save();
      this.deliver(r);
      return;
    }
    r.report.state = "unresolved";
    this.save();
    this.emit({ kind: "subagentEnded", id: r.id, status: "failed", summary: UNRESOLVED_REPORT });
  }

  /** Reports that did not reach the coordinator (it was busy, or the app stopped first): handed over again, once each. */
  redeliver(): void {
    for (const r of this.records.values()) if (this.visible(r) && !this.queued.has(r.id)) this.deliver(r);
  }

  /**
   * Every worker it runs or still owes a report to the coordinator, whoever owns it: the head stays awake for these. An
   * unresolved report is not one: the coordinator was shown it and decided nothing, and waiting would keep it awake for good.
   */
  get hostedLive(): string[] {
    return [...this.records.values()].filter((r) => this.visible(r) && (r.status === "running" || !!r.cleanup || (!r.owner && reportOwed(r.report.state)))).map((r) => r.id);
  }

  /** What the coordinator still waits for (its own workers only): runs under way and reports it has not been shown or decided on (an unresolved one is not waited for). */
  get completionDependencies(): WorkerDependency[] {
    return [...this.records.values()].filter((r) => this.visible(r) && !r.owner).flatMap((r): WorkerDependency[] => {
      const task = typeof r.engineData.ownershipInstructions === "string" ? r.engineData.ownershipInstructions : r.instructions;
      if (r.status === "running" || r.cleanup === "pending") return [{ id: r.id, run: r.run, task, state: "running", callback: "app_task_result", taskTruncated: false }];
      if (reportOwed(r.report.state))
        return [{ id: r.id, run: r.run, task, state: "reportQueued", callback: "app_task_result", ...(r.report.status ? { outcome: wireStatus(r.report.status) } : {}), taskTruncated: false }];
      return [];
    });
  }

  /** Workers at work now. */
  get running(): string[] { return [...this.records.values()].filter((r) => r.status === "running").map((r) => r.id); }

  // ------------------------------------------------------------------------------------------
  // Runs

  /** Starts its next run (now, or when a slot frees). An error text: nothing started (a new worker is forgotten, a follow-up undone). */
  private launch(r: WorkerLedgerRecord, words: string, fresh: boolean, sameRun = false): Maybe<string | null> {
    const adapter = this.adapterOf(r)!;
    const before = structuredClone(r);
    // Counted before this worker is at work itself.
    const wait = (adapter.needsSlot?.(r) ?? true) && this.busy >= this.limit;
    if (sameRun) r.segment = (r.segment ?? 0) + 1;
    else { r.run += 1; delete r.segment; }
    Object.assign(r, { status: "running", report: noReport(), runStartedAt: this.now(), endedAt: null });
    delete r.interruptedBy;
    this.queued.delete(r.id);
    this.activeReports.delete(r.id);
    const live = this.newLive(r);
    if (wait) live.waiting = { words };
    this.save();
    if (wait) {
      this.opening(r, adapter, words);
      this.emit({ kind: "subagentText", parent: r.id, text: `Waiting for a free worker slot (${this.limit} at work at once); it starts when another worker finishes.` });
      return null;
    }
    const undo = () => {
      if (fresh) this.records.delete(r.id);
      else { Object.assign(r, before); r.engineData = before.engineData; if (before.segment === undefined) delete r.segment; }
      if (this.lives.get(r.id) === live) this.lives.delete(r.id);
      this.save();
    };
    return this.begin(r, live, adapter, words, true, undo);
  }

  /** Calls the adapter's start; then the run's opening items (if `opening`) and the events it emitted meanwhile. */
  private begin(r: WorkerLedgerRecord, live: Live, adapter: WorkerAdapter, words: string, opening: boolean, undo: (() => void) | null): Maybe<string | null> {
    live.starting = true;
    const started = (): null => {
      live.starting = false;
      const held = live.held;
      live.held = [];
      if (live.done) return null;
      // Identity first (a Claude session known up front shows in the opening items), then the run's own events.
      for (const event of held) if (event.type === "session" || event.type === "process") live.pipeline.feed(event);
      if (opening) this.opening(r, adapter, words);
      for (const event of held) if (event.type !== "session" && event.type !== "process") this.onEvent(r.id, live, event);
      return null;
    };
    const failed = (error: unknown): string | null => {
      live.starting = false;
      live.held = [];
      const message = (error as Error)?.message || String(error);
      if (live.done) return null;
      if (undo) { live.done = true; undo(); this.startWaiting(); return message; }
      // A run that waited for a slot was already shown at work: it fails like any run.
      live.pipeline.feed({ type: "end", end: { how: "error", finalText: null, error: `The worker could not start: ${message}`, detail: "start" } });
      return null;
    };
    let result: void | Promise<void>;
    try { result = adapter.start(r, words, live.handle); } catch (error) { return failed(error); }
    return result instanceof Promise ? result.then(started, failed) : started();
  }

  private opening(r: WorkerLedgerRecord, adapter: WorkerAdapter, words: string) {
    const runtime = adapter.runtime?.(r) ?? { reasoningEffort: null };
    for (const item of workerRunStarted({ id: r.id, engine: r.engine, name: r.name, run: r.run, conversationId: r.conversationId, ownerSessionId: this.options.ownerSessionId() }, words, runtime, adapter.subagentType))
      this.emit(item);
  }

  private newLive(r: WorkerLedgerRecord): Live {
    const run = r.run;
    const live = {} as Live;
    const current = () => this.records.get(r.id) === r && this.lives.get(r.id) === live;
    Object.assign(live, {
      run, approvals: new Map(), denied: 0, starting: false, held: [], done: false,
      handle: {
        workerId: r.id, run,
        emit: (event: WorkerEvent) => this.onEvent(r.id, live, event),
        setEngineData: (patch: Record<string, unknown>) => {
          if (!current() || this.closed) return;
          Object.assign(r.engineData, patch);
          this.save();
        },
      },
      pipeline: new RunPipeline(
        { workerId: r.id, run, segment: r.segment, engine: r.engine, conversationId: () => r.conversationId, parentThreadId: () => this.options.parentThreadId?.() ?? null },
        (item) => this.emit(item),
        { control: (event) => this.control(r, live, event), ended: (end) => this.ended(r, live, end) },
      ),
    } satisfies Live);
    this.lives.set(r.id, live);
    return live;
  }

  private onEvent(id: string, live: Live, event: WorkerEvent) {
    if (this.closed || this.lives.get(id) !== live || live.done) return;
    if (live.starting) { live.held.push(event); return; }
    live.pipeline.feed(event);
  }

  private control(r: WorkerLedgerRecord, live: Live, event: ControlEvent) {
    switch (event.type) {
      case "session":
        if (event.conversationId && event.conversationId !== r.conversationId) { r.conversationId = event.conversationId; this.save(); }
        return;
      case "process": {
        const started = event.started ?? (this.options.processStartTime ?? processStartTime)(event.pid);
        if (!started || !Number.isSafeInteger(event.pid) || event.pid <= 0) { this.options.log(`worker ${r.id}: no identity for process ${event.pid}`); return; }
        r.processes = [...r.processes, { pid: event.pid, started }].slice(-MAX_PROCESSES);
        this.save();
        return;
      }
      case "permission":
        if (live.approvals.has(event.nativeId)) { this.options.log(`worker ${r.id}: duplicate approval ${event.nativeId} ignored`); return; }
        live.approvals.set(event.nativeId, structuredClone(event.input));
        this.emit({
          kind: "permission", requestId: workerRequestId(r.id, live.run, event.nativeId), tool: event.tool, summary: event.summary, input: { ...event.input }, workerId: r.id,
          ...(event.safetyCheck ? { safetyCheck: event.safetyCheck } : {}), ...(event.noAlways ? { noAlways: true } : {}),
        });
        return;
      case "permissionCancelled":
        if (live.approvals.delete(event.nativeId)) this.emit({ kind: "permissionCancelled", requestId: workerRequestId(r.id, live.run, event.nativeId) });
        return;
    }
  }

  private cancelApprovals(r: WorkerLedgerRecord, live: Live) {
    for (const nativeId of live.approvals.keys()) this.emit({ kind: "permissionCancelled", requestId: workerRequestId(r.id, live.run, nativeId) });
    live.approvals.clear();
  }

  /** The engine ended the run: classified once; its report goes out (after the adapter's cleanup, if it has one). */
  private ended(r: WorkerLedgerRecord, live: Live, end: RunEnd) {
    live.done = true;
    const verdict = classifyRun(live.pipeline.facts({ stoppedByApp: false, interruptedBy: null, requireReply: true }));
    const text = (verdict.status === "done" || verdict.status === "failed" ? withDeniedNote(verdict.report, live.denied) : verdict.report).slice(0, REPORT_LIMIT);
    this.cancelApprovals(r, live);
    Object.assign(r, { status: verdict.status, endedAt: this.now(), report: { state: "pending", text, status: verdict.status, attempts: 0 } });
    this.options.log(`worker ${r.id} run ${r.run}: ${verdict.status} (${verdict.reason}; engine ${end.how}${end.detail ? ` ${end.detail}` : ""})`);
    const adapter = this.adapterOf(r);
    if (!adapter?.cleanup) {
      this.save();
      this.reported(r);
      return;
    }
    r.cleanup = "pending";
    this.save();
    void this.track(r.id, adapter.cleanup(r).then((result) => result.cleaned, () => false).then((cleaned) => {
      if (this.records.get(r.id) !== r || this.lives.get(r.id) !== live) return;
      delete r.cleanup;
      if (cleaned) this.save();
      else this.cleanupFailed(r);
      this.reported(r);
    }));
  }

  /** A run's end is out: subagentEnded, the report's delivery, and a waiting run may take the slot. */
  private reported(r: WorkerLedgerRecord) {
    this.emit({ kind: "subagentEnded", id: r.id, status: wireStatus(r.report.status ?? "failed"), summary: r.report.text ?? "" });
    this.deliver(r);
    this.startWaiting();
  }

  private cleanupFailed(r: WorkerLedgerRecord) {
    r.cleanup = "failed";
    r.recovery = "required";
    if (r.report.status && r.report.status !== "stopped" && r.report.status !== "interrupted") {
      r.report.status = "failed";
      r.report.text = r.report.text ? `${CLEANUP_FAILED_NOTE}\n${r.report.text}`.slice(0, REPORT_LIMIT) : CLEANUP_FAILED_NOTE;
    }
    this.save();
  }

  private deliver(r: WorkerLedgerRecord) {
    if (this.closed || r.report.state !== "pending" || r.status === "running" || r.cleanup === "pending" || this.queued.has(r.id)) return;
    const report: WorkerReport = { id: r.id, run: r.run, engine: r.engine, status: r.report.status ?? "failed", text: r.report.text ?? "" };
    if (r.owner) {
      // Another bot owns it: the app routes the report there (the coordinator never sees it).
      r.report.state = "routed";
      this.save();
      this.emit(ownedWorkerReport({ id: r.id, run: r.run, engine: r.engine, status: wireStatus(report.status), report: report.text }));
      return;
    }
    let taken: "taken" | "queued" | "busy";
    try { taken = this.options.port.deliver(report, reportTag(report, this.options.port.ack)); } catch (error) {
      this.options.log(`worker ${r.id}: report delivery failed: ${(error as Error).message}`);
      taken = "busy";
    }
    // A port may begin the report turn before it returns: then it is no longer waiting in the port's queue.
    if (taken === "queued") { if (r.report.state === "pending") this.queued.add(r.id); return; }
    if (taken !== "taken") return;
    r.report.attempts += 1;
    r.report.state = this.options.port.ack === "none" ? "acknowledged" : "delivered";
    this.save();
  }

  /** Stops its run: no report is made; its adapter ends the run's turn/process. */
  private stop(r: WorkerLedgerRecord): Maybe<void> {
    const live = this.lives.get(r.id);
    const facts = live ? live.pipeline.facts({ stoppedByApp: true, interruptedBy: null, requireReply: true }) : { end: null, reply: "", stoppedByApp: true, interruptedBy: null, requireReply: true, failedTools: 0 };
    const verdict = classifyRun(facts);
    if (live) { live.done = true; live.waiting = undefined; live.pipeline.flush(); this.cancelApprovals(r, live); }
    // Stopped, but not over until its processes are: no next run starts while they may still be alive.
    Object.assign(r, { status: "stopped", endedAt: this.now(), cleanup: "pending", report: { ...noReport(), text: verdict.report, status: "stopped" } });
    this.save();
    this.emit({ kind: "subagentEnded", id: r.id, status: wireStatus("stopped"), summary: verdict.report });
    return then(this.cleanUp(r, this.adapterOf(r)), () => this.startWaiting());
  }

  /**
   * The adapter's cleanup of this run (`cleanup` is "pending" while it runs): cleared when it is done, failed when it
   * could not be. Its result belongs to the run it was started for, never to a later one.
   */
  private cleanUp(r: WorkerLedgerRecord, adapter: WorkerAdapter | undefined): Maybe<void> {
    const run = r.run;
    const settle = (cleaned: boolean) => {
      if (this.records.get(r.id) !== r || r.run !== run || r.cleanup !== "pending") return;
      if (cleaned) { delete r.cleanup; this.save(); }
      else this.cleanupFailed(r);
    };
    let stopped: Maybe<{ cleaned: boolean }>;
    try { stopped = adapter?.stop(r) ?? { cleaned: true }; } catch { stopped = { cleaned: false }; }
    // An adapter done at once settles it now (a follow-up right after the stop finds it clean).
    if (!(stopped instanceof Promise)) return settle(stopped.cleaned);
    return stopped.then((result) => result.cleaned, () => false).then(settle);
  }

  /** Workers waiting for a slot start, oldest first, while there is room. */
  private startWaiting() {
    if (this.closed) return;
    for (const r of this.records.values()) {
      if (this.busy >= this.limit) return;
      const live = this.lives.get(r.id);
      if (!live?.waiting || r.status !== "running" || live.done) continue;
      const { words } = live.waiting;
      live.waiting = undefined;
      const adapter = this.adapterOf(r);
      if (!adapter) { live.pipeline.feed({ type: "end", end: { how: "error", finalText: null, error: "This worker's engine is not available here.", detail: "start" } }); continue; }
      void this.begin(r, live, adapter, words, false, null);
    }
  }

  private trim(making: string) {
    if (this.records.size <= MAX_WORKER_RECORDS) return;
    const kept = trimRecords([...this.records.values()], MAX_WORKER_RECORDS, (id) => { const live = this.lives.get(id); return id === making || (!!live && !live.done); });
    const keep = new Set(kept.map((r) => r.id));
    for (const id of [...this.records.keys()]) if (!keep.has(id)) { this.records.delete(id); this.lives.delete(id); }
  }
}
