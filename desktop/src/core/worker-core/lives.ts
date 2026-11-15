// The run life-cycle half of WorkerCore (M7-S83): launching a run, its events, its end, the report port callbacks and the
// slots. It owns `lives` (the run under way on each worker), `queued` (reports the port holds) and `activeReports`; the
// core keeps the records, the options, `closed`, the one-operation-per-worker rule (`exclusive`, `track`) and the app tools,
// and lends them through `LivesHost`.
import type { CodexItem, WorkerDependency } from "../agent/codex";
import { workerRunStarted } from "../agent/workers";
import { processStartTime } from "../process/kill-tree";
import { specTrace } from "../spec-trace";
import type { WorkerAdapter } from "./adapter";
import { classifyRun } from "./classify";
import type { WorkerCoreOptions } from "./core";
import type { RunEnd, RunHandle, WorkerEvent } from "./events";
import { MAX_PROCESSES, MAX_WORKER_RECORDS, trimRecords, type WorkerLedgerRecord } from "./ledger";
import { RunPipeline, type ControlEvent } from "./pipeline";
import { ownedWorkerReport, REPORT_LIMIT, reportTag, wireStatus, withDeniedNote, type WorkerReport } from "./report";
import { reportOwed } from "./status";

/** What the coordinator reads when it made no decision on a report after the allowed attempts (agy-workers.ts's words). */
export const UNRESOLVED_REPORT = "Worker report unresolved: no task/run checkpoint or same-task continuation after one reconciliation turn. Evidence retained; explicit decision required.";
/** The line put before a report whose run's processes could not be cleaned up. */
export const CLEANUP_FAILED_NOTE = "Worker process cleanup failed. Explicit recovery is required; no continuation permitted.";

/** The request id of a worker's approval card. */
export const workerRequestId = (id: string, run: number, nativeId: string) => `worker:${id}:${run}:${nativeId}`;

/** One run under way (or the latest, ended). */
export interface Live {
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

export type Maybe<T> = T | Promise<T>;
const then = <T, U>(value: Maybe<T>, next: (value: T) => Maybe<U>): Maybe<U> => (value instanceof Promise ? value.then(next) : next(value));
/** Exported as `whenDone`: a module that exports a name `then` is a thenable and `import()` would call it. */
export { then as whenDone };

export const noReport = (): WorkerLedgerRecord["report"] => ({ state: "none", text: null, status: null, attempts: 0 });

/** A record as spec/models/worker sees it. */
export const specView = (r: WorkerLedgerRecord) => ({
  id: r.id, status: r.status, run: r.run, report: r.report.state, attempts: r.report.attempts, cleanup: r.cleanup ?? "none",
  recovery: r.recovery === "required", owned: !!r.owner,
});
/** One step of spec/models/worker (an action of Worker.tla), for trace checking: no-op unless BOTLING_SPEC_TRACE is set. */
export const traceStep = (action: string, r: WorkerLedgerRecord, args: Record<string, unknown> = {}) => specTrace("worker", action, { ...args, ...specView(r) });

/** What the life-cycle half borrows from the core: the one place the records and the worker's one operation live. */
export interface LivesHost {
  readonly options: WorkerCoreOptions;
  readonly records: Map<string, WorkerLedgerRecord>;
  closed(): boolean;
  limit(): number;
  busy(): number;
  save(): void;
  now(): number;
  emit(item: CodexItem): void;
  adapterOf(r: Pick<WorkerLedgerRecord, "adapter">): WorkerAdapter | undefined;
  visible(r: WorkerLedgerRecord | undefined): boolean;
  exclusive<T>(id: string, op: () => Maybe<T>, busy: (() => T) | "wait"): Maybe<T>;
  track<T>(id: string, work: Promise<T>): Promise<T>;
}

export class WorkerLives {
  /** The run under way (or the latest, ended) on each worker. */
  lives = new Map<string, Live>();
  /** Reports the port queued: not handed over again until it begins or drops them. */
  queued = new Set<string>();
  /** Report turns under way (beginReport → finishReport), by task id: its run. */
  activeReports = new Map<string, number>();

  constructor(private host: LivesHost) {}

  // The bridge: the names the moved bodies borrow from the core, one line each.
  private get options() { return this.host.options; }
  private get records() { return this.host.records; }
  private get closed() { return this.host.closed(); }
  private get limit() { return this.host.limit(); }
  private get busy() { return this.host.busy(); }
  private save() { this.host.save(); }
  private now() { return this.host.now(); }
  private emit(item: CodexItem) { this.host.emit(item); }
  private adapterOf(r: Pick<WorkerLedgerRecord, "adapter">) { return this.host.adapterOf(r); }
  private visible(r: WorkerLedgerRecord | undefined): r is WorkerLedgerRecord { return this.host.visible(r); }
  private exclusive<T>(id: string, op: () => Maybe<T>, busy: (() => T) | "wait"): Maybe<T> { return this.host.exclusive(id, op, busy); }
  private track<T>(id: string, work: Promise<T>): Promise<T> { return this.host.track(id, work); }

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
    traceStep("BeginReport", r);
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
    if (this.closed || !r || r.run !== run || r.report.state !== "dispatching" || !completed) { if (r) traceStep("FinishReport", r, { completed }); return; }
    this.undecided(r, "FinishReport", { completed });
  }

  /**
   * A hand-over whose outcome is unknown and that its coordinator cannot reconcile itself (Codex has no reconcile tool:
   * its report turn never started, or the app went away while it was being shown). It counts as one attempt without a
   * decision: shown once more, then unresolved. Never taken as acknowledged. False: no such uncertain report.
   */
  retryUncertain(id: string, run: number): boolean {
    const r = this.records.get(id);
    if (this.closed || !r || r.run !== run || r.report.state !== "dispatching" || this.activeReports.get(id) === run) return false;
    this.undecided(r, "RetryUncertain");
    return true;
  }

  /** A delivery attempt that ended without the coordinator's decision: shown once more, then unresolved. `step`: its spec action. */
  private undecided(r: WorkerLedgerRecord, step: string, args: Record<string, unknown> = {}) {
    r.report.attempts += 1;
    if (r.report.attempts < 2) {
      r.report.state = "pending";
      this.save();
      traceStep(step, r, args);
      this.deliver(r);
      return;
    }
    r.report.state = "unresolved";
    this.save();
    traceStep(step, r, args);
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

  /**
   * Starts its next run (now, or when a slot frees). An error text: nothing started (a new worker is forgotten, a
   * follow-up undone). `step`: the spec action that launches it.
   */
  launch(r: WorkerLedgerRecord, words: string, fresh: boolean, sameRun: boolean, step: string): Maybe<string | null> {
    const adapter = this.adapterOf(r)!;
    const before = structuredClone(r);
    // Those already waiting go first if the limit was raised since (settings.json is read each time).
    this.startWaiting();
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
    traceStep(step, r);
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
      traceStep("StartDone", r);
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
    for (const item of workerRunStarted({ id: r.id, engine: r.engine, name: r.name, ...(r.group ? { group: r.group } : {}), run: r.run, conversationId: r.conversationId, ownerSessionId: this.options.ownerSessionId() }, words, runtime, adapter.subagentType))
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
        { workerId: r.id, run, segment: r.segment, engine: r.engine, conversationId: () => r.conversationId },
        (item) => this.emit(item),
        { control: (event) => this.control(r, live, event), ended: (end) => this.ended(r, live, end) },
      ),
    } satisfies Live);
    this.lives.set(r.id, live);
    return live;
  }

  onEvent(id: string, live: Live, event: WorkerEvent) {
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

  cancelApprovals(r: WorkerLedgerRecord, live: Live) {
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
      traceStep("End", r, { v: verdict.status });
      this.reported(r);
      return;
    }
    r.cleanup = "pending";
    this.save();
    traceStep("End", r, { v: verdict.status });
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

  deliver(r: WorkerLedgerRecord) {
    if (this.closed || r.report.state !== "pending" || r.status === "running" || r.cleanup === "pending" || this.queued.has(r.id)) return;
    const report: WorkerReport = { id: r.id, run: r.run, engine: r.engine, status: r.report.status ?? "failed", text: r.report.text ?? "" };
    if (r.owner) {
      // Another bot owns it: the app routes the report there (the coordinator never sees it).
      r.report.state = "routed";
      this.save();
      traceStep("Route", r);
      this.emit(ownedWorkerReport({ id: r.id, run: r.run, engine: r.engine, status: wireStatus(report.status), report: report.text }));
      return;
    }
    let taken: "taken" | "queued" | "busy";
    try { taken = this.options.port.deliver(report, reportTag(report, this.options.port.ack)); } catch (error) {
      this.options.log(`worker ${r.id}: report delivery failed: ${(error as Error).message}`);
      taken = "busy";
    }
    // A port may begin the report turn before it returns: then it is no longer waiting in the port's queue.
    if (taken === "queued") { if (r.report.state === "pending") { this.queued.add(r.id); traceStep("Deliver", r, { how: "queued" }); } return; }
    if (taken !== "taken") return;
    r.report.attempts += 1;
    r.report.state = this.options.port.ack === "none" ? "acknowledged" : "delivered";
    this.save();
    traceStep("Deliver", r, { how: "taken" });
  }

  /** Stops its run: no report is made; its adapter ends the run's turn/process. `step`: the spec action that stops it. */
  stop(r: WorkerLedgerRecord, step: string): Maybe<void> {
    const live = this.lives.get(r.id);
    const facts = live ? live.pipeline.facts({ stoppedByApp: true, interruptedBy: null, requireReply: true }) : { end: null, reply: "", stoppedByApp: true, interruptedBy: null, requireReply: true, failedTools: 0 };
    const verdict = classifyRun(facts);
    if (live) { live.done = true; live.waiting = undefined; live.pipeline.flush(); this.cancelApprovals(r, live); }
    // Stopped, but not over until its processes are: no next run starts while they may still be alive.
    Object.assign(r, { status: "stopped", endedAt: this.now(), cleanup: "pending", report: { ...noReport(), text: verdict.report, status: "stopped" } });
    this.save();
    traceStep(step, r);
    this.emit({ kind: "subagentEnded", id: r.id, status: wireStatus("stopped"), summary: verdict.report });
    return then(this.cleanUp(r, this.adapterOf(r)), () => this.startWaiting());
  }

  /**
   * The adapter's cleanup of this run (`cleanup` is "pending" while it runs): cleared when it is done, failed when it
   * could not be. Its result belongs to the run it was started for, never to a later one.
   */
  cleanUp(r: WorkerLedgerRecord, adapter: WorkerAdapter | undefined): Maybe<void> {
    const run = r.run;
    const settle = (cleaned: boolean) => {
      if (this.records.get(r.id) !== r || r.run !== run || r.cleanup !== "pending") return;
      if (cleaned) { delete r.cleanup; this.save(); }
      else this.cleanupFailed(r);
      traceStep("StopDone", r, { ok: cleaned });
    };
    let stopped: Maybe<{ cleaned: boolean }>;
    try { stopped = adapter?.stop(r) ?? { cleaned: true }; } catch { stopped = { cleaned: false }; }
    // An adapter done at once settles it now (a follow-up right after the stop finds it clean).
    if (!(stopped instanceof Promise)) return settle(stopped.cleaned);
    return stopped.then((result) => result.cleaned, () => false).then(settle);
  }

  /** The limit may have changed (Settings): waiting workers start if there is room now; none at work is stopped. */
  slotsChanged(): void { this.startWaiting(); }

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
      // Through the worker's one operation (a start may be asynchronous): still this run's when it begins, or nothing.
      void this.exclusive(r.id, () => (this.records.get(r.id) === r && this.lives.get(r.id) === live && !live.done && r.status === "running"
        ? this.begin(r, live, adapter, words, false, null) : null), "wait");
    }
  }

  trim(making: string) {
    if (this.records.size <= MAX_WORKER_RECORDS) return;
    const kept = trimRecords([...this.records.values()], MAX_WORKER_RECORDS, (id) => { const live = this.lives.get(id); return id === making || (!!live && !live.done); });
    const keep = new Set(kept.map((r) => r.id));
    for (const id of [...this.records.keys()]) if (!keep.has(id)) { this.records.delete(id); this.lives.delete(id); }
  }
}
