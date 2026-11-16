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
import { movedTaskError, type WorkerHost, type WorkerInfo, type WorkerOwner, type WorkerOwnerResult, type WorkerSendResult } from "../agent/workers";
import { specTrace } from "../spec-trace";
import type { HandoffArgs, HandoffRequest, RecoverResult, WorkerAdapter } from "./adapter";
import { classifyRun, ENGINE_NAMES, INTERRUPTED_REPORT } from "./classify";
import type { WorkerAdapterKind, WorkerEvent } from "./events";
import type { WorkerLedgerRecord, WorkerStore } from "./ledger";
import { noReport, specView, traceStep, whenDone as then, WorkerLives, type Live, type Maybe } from "./lives";
import type { LegacySources } from "./migrate";
import { parseWorkerNote, wireStatus, workerNoteText, type AckPolicy, type WorkerNote, type WorkerReport } from "./report";
import { reportOwed, workerState, type WorkerStatus } from "./status";
import { readStartedBy, shownName, startedByLine, type StartedBy } from "./started-by";

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
  /** M7-O04 (F6): called around every app_handoff with the handoff itself as `run`; it may refuse (throw) or change `args`. Absent: `run`. */
  admit?(kind: WorkerAdapterKind, args: HandoffArgs, run: (startedBy?: StartedBy) => Promise<HandoffResult>): Promise<HandoffResult>;
  /** M7-O05 (item 5): called with every app_send_message once the worker is found. Undefined: not gated, the message goes on as the coordinator's own. Else the
   *  message was sent (a plugin's turn: only that plugin's own worker, through the plugin book) and this is its answer; it throws when the plugin's turn may not. */
  gateMessage?(taskId: string, words: string): Promise<{ run: number; how: string } | undefined>;
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
  now?(): number;
  newId?(): string;
  /** A process's start time (identity), for `process` events that carry none (default: process/kill-tree). */
  processStartTime?(pid: number): string | null;
  /**
   * A record's projected state changed (status, report, cleanup, end, owner): the bot's projections (subagents.json,
   * the chip, agents.json, the step) follow it. A copy; called after the ledger is written.
   */
  projected?(record: WorkerLedgerRecord): void;
  /**
   * A note from one of its workers' runs under way (app_notify_owner) for the coordinator that owns it: shown in its
   * chat and woken with `text` (the <app_worker_note> message). False: it cannot take it now. Absent: notes go nowhere.
   */
  note?(note: WorkerNote, text: string): boolean;
}

export interface HandoffResult { accepted: true; task_id: string; run: number }
export interface MessageArgs { task_id?: unknown; run?: unknown; message?: unknown }
export interface MessageResult { task_id: string; run: number; status: "steered" | "accepted" }
export interface CheckpointArgs { task_id?: unknown; run?: unknown; outcome?: unknown; evidence?: unknown; dependency_task_id?: unknown }
export interface CheckpointResult { task_id: string; run: number; outcome: string; evidence: string; dependency_task_id?: string }
export interface NotifyResult { task_id: string; run: number; kind: WorkerNote["kind"]; delivered: true; to: "owner" }
export interface ReconcileArgs { task_id?: unknown; run?: unknown; action?: unknown }
export interface ReconcileResult { task_id: string; run: number; action: "acknowledge" | "retry"; taskReplayed: false }

export { CLEANUP_FAILED_NOTE, UNRESOLVED_REPORT, workerRequestId } from "./lives";
export const CHECKPOINT_OUTCOMES = ["complete", "waiting_user", "waiting_dependency", "blocked"] as const;
const MAX_WORDS = 64_000;

const firstText = (...values: unknown[]) => values.find((value): value is string => typeof value === "string" && !!value.trim());

export class WorkerCore implements WorkerHost {
  readonly workerHostKind: WorkerAdapterKind;
  readonly steersRunning: boolean;
  private records = new Map<string, WorkerLedgerRecord>();
  /** The run life-cycle half (lives.ts): it owns `lives`, `queued` and `activeReports`; these are read-only views of them. */
  private runs: WorkerLives;
  private get lives() { return this.runs.lives; }
  private get queued() { return this.runs.queued; }
  private get activeReports() { return this.runs.activeReports; }
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
    this.runs = new WorkerLives({
      options, records: this.records, closed: () => this.closed, limit: () => this.limit, busy: () => this.busy, save: () => this.save(), now: () => this.now(),
      emit: (item) => this.emit(item), adapterOf: (r) => this.adapterOf(r), visible: (r) => this.visible(r),
      exclusive: (id, op, busy) => this.exclusive(id, op, busy), track: (id, work) => this.track(id, work),
    });
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
    specTrace("worker", "Crash", { workers: [...this.records.values()].map(specView) });
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
      id: r.id, engine: r.engine, name: shownName(r), run: r.run, state: workerState(r), conversationId: r.conversationId,
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

  /** `from`: who is speaking, as the worker's own view shows it ("owner" for the host path, "coordinator" for app_send_message; the view names both by the owner bot). */
  sendToWorker(id: string, words: string, from = "owner", via?: StartedBy): Maybe<WorkerSendResult> {
    const r = this.find(id);
    if (!r || this.closed) return { ok: false, reason: "No such worker." };
    if (typeof words !== "string" || !words.trim() || words.length > MAX_WORDS) return { ok: false, reason: `Message required (maximum ${MAX_WORDS} characters).` };
    // A plugin's message says who sent it (after the size check: the largest legal message stays legal).
    const by = via ? readStartedBy(via) : null;
    if (via && !by) return { ok: false, reason: "A message's sender must be a plugin name and a hash." };
    if (by) words = `${startedByLine(by)}\n\n${words}`;
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
      if (steered) {
        traceStep("Steer", r);
        // The worker's own view shows the line, once, for every engine (adapters never do).
        if (live) this.onEvent(r.id, live, { type: "userText", text: words, from });
      }
      return steered ? { ok: true, how: "steered", run: r.run } : { ok: false, busy: true, reason: "This worker is starting or stopping; try again in a moment." };
    }
    if (r.cleanup === "pending") return { ok: false, busy: true, reason: "This worker is still cleaning up after its run; try again in a moment." };
    const run = r.run;
    // Spec trace: with a recovery to wait for, Send is the step that asks for it and RecoverDone the one that launches.
    const recovering = r.recovery === "required" || r.cleanup === "failed";
    return this.exclusive(r.id, () => {
      if (recovering) traceStep("Send", r);
      return then(this.recover(r, adapter), (blocker) => {
        if (blocker) { if (recovering) traceStep("RecoverDone", r); return { ok: false, reason: blocker }; }
        if (this.closed || this.records.get(r.id) !== r || r.run !== run || r.status === "running") return WorkerCore.BUSY;
        return then(this.launch(r, words, false, false, recovering ? "RecoverDone" : "Send"), (error): WorkerSendResult => (error ? { ok: false, reason: error } : { ok: true, how: "newRun", run: r.run }));
      });
    }, () => WorkerCore.BUSY);
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
      return then(this.launch(r, words, false, true, "Resume"), (error): WorkerSendResult => (error ? { ok: false, reason: error } : { ok: true, how: "newRun", run: r.run }));
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
  /**
   * Stops the run under way now (after the operation under way, if any). False when it is not at work by then, or the
   * run it was asked for has been followed by another meanwhile (that one is not this stop's).
   */
  stopWorker(id: string): Promise<boolean> {
    const r = this.find(id);
    if (!r || this.closed) return Promise.resolve(false);
    const run = r.run;
    // Spec trace: asked while an operation holds the worker, it runs later as RunQueued.
    const waits = this.ops.has(r.id);
    const stopping = Promise.resolve(this.exclusive(r.id, () => {
      const step = waits ? "RunQueued" : "StopWorker";
      if (this.closed || this.records.get(r.id) !== r || r.run !== run || r.status !== "running") { traceStep(step, r); return false; }
      return then(this.stop(r, step), () => true);
    }, "wait"));
    if (waits) traceStep("StopWorker", r);
    return stopping;
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
    if (owner) traceStep("SetOwner", r);
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
  handoff(kind: WorkerAdapterKind, args: HandoffArgs, startedBy?: StartedBy): Promise<HandoffResult> {
    return this.options.admit ? this.options.admit(kind, args, (by) => this.handoffNow(kind, args, by ?? startedBy)) : this.handoffNow(kind, args, startedBy);
  }

  private async handoffNow(kind: WorkerAdapterKind, args: HandoffArgs, startedBy?: StartedBy): Promise<HandoffResult> {
    if (this.closed) throw new Error("Workers are closed: the app is stopping.");
    const adapter = this.options.adapters.find((a) => a.kind === kind);
    if (!adapter) throw new Error(`No ${kind} workers here.`);
    const given = firstText(args.instructions, args.prompt, args.task) ?? "";
    if (!given.trim() || given.length > MAX_WORDS) throw new Error(`instructions required (maximum ${MAX_WORDS} characters).`);
    // Not from `args` (the coordinator's own words): only the host that checked the plugin passes who it is.
    const by = startedBy ? readStartedBy(startedBy) : null;
    if (startedBy && !by) throw new Error("A worker's starter must be a plugin name and a hash. Nothing was started.");
    // A plugin's instructions say who sent them, as its messages do (after the size check: the largest legal instructions stay legal).
    const instructions = by ? `${startedByLine(by)}\n\n${given}` : given;
    const named = firstText(args.name, args.description);
    const request: HandoffRequest = {
      instructions, name: named ? named.trim().slice(0, 200) : given.split("\n")[0]!.slice(0, 80),
      type: firstText(args.subagent_type)?.trim() ?? null, model: firstText(args.model)?.trim() ?? null,
      engine: typeof args.engine === "string" ? args.engine : null, args,
    };
    const prepared = adapter.prepare?.(request) ?? {};
    const r: WorkerLedgerRecord = {
      v: 3, id: this.options.newId?.() ?? randomUUID(), engine: prepared.engine ?? adapter.engine, adapter: kind, name: request.name, instructions,
      type: request.type, ownerSessionId: this.options.ownerSessionId(), run: 0, status: "new", report: noReport(), conversationId: null,
      processes: [], createdAt: this.now(), runStartedAt: null, endedAt: null, engineData: { ...(prepared.engineData ?? {}) },
    };
    const group = firstText(args.group)?.trim().slice(0, 80);
    if (group) r.group = group;
    if (by) r.startedBy = by;
    this.records.set(r.id, r);
    // Room is made among the others: the worker being made is never the one forgotten (with none forgettable it is
    // kept as one more; the ledger keeps it too, as a running record).
    this.trim(r.id);
    const error = await this.exclusive(r.id, () => this.launch(r, instructions, true, false, "Handoff"), "wait");
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
    const words = typeof args.message === "string" ? args.message : "";
    // A plugin's turn (M7-O05): the gate sent it, or refused it; no other turn is gated.
    const gated = await this.options.gateMessage?.(r.id, words);
    if (gated) return { task_id: r.id, run: gated.run, status: gated.how === "steered" ? "steered" : "accepted" };
    const sent = await this.sendToWorker(r.id, words, "coordinator");
    if (!sent.ok) throw new Error(sent.reason);
    return { task_id: r.id, run: sent.run, status: sent.how === "steered" ? "steered" : "accepted" };
  }

  /**
   * app_notify_owner from worker `id`'s run under way: its owner (the coordinator, or the bot it was moved to) gets the
   * note now; the run goes on. Only a worker at work can send one; nothing about the record changes.
   */
  notifyOwner(id: string, args: Record<string, unknown>): NotifyResult {
    const r = this.records.get(id);
    if (!r) throw new Error("Only an app-managed worker can notify its owner.");
    if (r.status !== "running" || !this.lives.has(r.id)) throw new Error("This worker's run is not under way: say it in your final report instead.");
    const note: WorkerNote = { id: r.id, run: r.run, engine: r.engine, name: r.name, ...parseWorkerNote(args) };
    if (r.owner) {
      // Another bot owns it: the app routes the note there (the coordinator never sees it).
      this.emit({ kind: "workerNote", id: note.id, run: note.run, engine: note.engine, noteKind: note.kind, name: note.name, message: note.message, files: note.files });
    } else {
      let taken = false;
      try { taken = this.options.note?.(note, workerNoteText(note)) ?? false; }
      catch (error) { this.options.log(`worker ${r.id}: note not delivered: ${(error as Error).message}`); }
      if (!taken) throw new Error("Your owner cannot take a note right now. Nothing was sent; say it in your final report instead.");
    }
    return { task_id: note.id, run: note.run, kind: note.kind, delivered: true, to: "owner" };
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
    traceStep("Checkpoint", r);
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
    traceStep("Reconcile", r, { action: args.action });
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
    // The run it is for is fixed now. It waits for the operation under way, then checks again: a cancel that run has
    // been followed by another meanwhile is stale and refused, never applied to the newer run.
    const target = r.run;
    // Spec trace: asked while an operation holds the worker, it runs later as RunQueued.
    const waits = this.ops.has(r.id);
    const cancelling = this.exclusive(r.id, () => {
      const step = waits ? "RunQueued" : "Cancel";
      if (this.closed) throw new Error("Workers are closed: the app is stopping.");
      try { this.owned(id, target); } catch (error) { traceStep(step, r); throw error; }
      return this.cancelOp(r, step);
    }, "wait");
    if (waits) traceStep("Cancel", r);
    return cancelling;
  }

  /** `step`: the spec action this cancel is (Cancel, or RunQueued when it waited for the worker). */
  private cancelOp(r: WorkerLedgerRecord, step: string): Maybe<{ status: WorkerStatus }> {
    const finish = () => {
      if (r.cleanup === "failed") throw new Error("Worker cleanup incomplete; task remains blocked.");
      return { status: r.status };
    };
    if (this.closed || this.records.get(r.id) !== r) { traceStep(step, r); return finish(); }
    if (r.status === "running") return then(this.stop(r, step), finish);
    const adapter = this.adapterOf(r);
    if (!adapter) { traceStep(step, r); return finish(); }
    const run = r.run;
    const recovering = r.recovery === "required" || r.cleanup === "failed";
    if (recovering) traceStep(step, r);
    return then(this.recover(r, adapter), (blocker) => {
      if (blocker) { if (recovering) traceStep("RecoverDone", r); throw new Error(blocker); }
      // Never a newer run's (none can start meanwhile, but this is the rule).
      if (this.records.get(r.id) !== r || r.run !== run || r.status === "running") return finish();
      if (r.report.state === "pending" || r.report.state === "delivered") r.report.state = "none";
      this.queued.delete(r.id);
      this.activeReports.delete(r.id);
      r.cleanup = "pending";
      this.save();
      traceStep(recovering ? "RecoverDone" : step, r);
      return then(this.cleanUp(r, adapter), finish);
    });
  }

  // ------------------------------------------------------------------------------------------
  // The run life-cycle half lives in lives.ts (WorkerLives); these are its one-line delegates.

  beginReport(id: string, run: number): boolean { return this.runs.beginReport(id, run); }
  finishReport(id: string, run: number, completed: boolean): void { this.runs.finishReport(id, run, completed); }
  retryUncertain(id: string, run: number): boolean { return this.runs.retryUncertain(id, run); }
  redeliver(): void { this.runs.redeliver(); }
  get hostedLive(): string[] { return this.runs.hostedLive; }
  get completionDependencies(): WorkerDependency[] { return this.runs.completionDependencies; }
  get running(): string[] { return this.runs.running; }
  slotsChanged(): void { this.runs.slotsChanged(); }
  private launch(r: WorkerLedgerRecord, words: string, fresh: boolean, sameRun: boolean, step: string) { return this.runs.launch(r, words, fresh, sameRun, step); }
  private onEvent(id: string, live: Live, event: WorkerEvent) { this.runs.onEvent(id, live, event); }
  private cancelApprovals(r: WorkerLedgerRecord, live: Live) { this.runs.cancelApprovals(r, live); }
  private deliver(r: WorkerLedgerRecord) { this.runs.deliver(r); }
  private stop(r: WorkerLedgerRecord, step: string) { return this.runs.stop(r, step); }
  private cleanUp(r: WorkerLedgerRecord, adapter: WorkerAdapter | undefined) { return this.runs.cleanUp(r, adapter); }
  private trim(making: string) { this.runs.trim(making); }
}
