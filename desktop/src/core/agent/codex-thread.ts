// An app-managed Codex worker: one thread of the coordinator's app-server, run through the shared worker core
// (split out of codex.ts, M7-S10b; the coordinator `CodexSession` stays there).
import { CodexRequestTracker } from "../token-speed";
import { MONITOR_HANDBACK } from "./monitor-policy";
import { DEFAULT_SPEC_WRITERS, inSpec, maySpecWrite, shellWritesSpec, SPEC_DENIED } from "../spec-guard";
import { approveIsolatedGit, type IsolatedGitOwnership } from "./isolated-git";
import { codexAutoRiskConfig } from "./auto-risk-policy";
import { codexEffort, writableRootsConfig, type CodexItem, type CodexConfig, type Approval, WORKER_TOOLS, isolatedGitOwners, message, json, codexToolStarted } from "./codex-types";
import type { SubagentExecution } from "../subagents";
import { randomUUID } from "node:crypto";
import { codexTokens, minusTokens, noTokens, totalTokens, type TokenUsage } from "../usage";
import type { HandoffRequest, RecoverResult, RunEnd, RunHandle, WorkerAdapter, WorkerLedgerRecord } from "../worker-core";

/** A Codex tool call done: its result (words it said are not one). */
export function codexToolCompleted(item: any, changedFiles: Map<string, string[]>): { id: string; output: string; failed: boolean } | null {
  if (!item || typeof item.id !== "string") return null;
  const id = item.id;
  const status = item.status;
  switch (item.type) {
    case "commandExecution": {
      const failed = status !== "completed" || (typeof item.exitCode === "number" && item.exitCode !== 0);
      return { id, output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "", failed };
    }
    case "fileChange": {
      changedFiles.delete(id);
      const diffs = (Array.isArray(item.changes) ? item.changes : []).map((change: any) => change?.diff).filter((diff: unknown): diff is string => typeof diff === "string");
      return { id, output: diffs.join("\n"), failed: status !== "completed" };
    }
    case "mcpToolCall":
    case "dynamicToolCall": {
      if (item.type === "dynamicToolCall" && ["app_handoff", "app_send_message", "app_task_checkpoint"].includes(item.tool)) return null;
      const output = item.error != null ? json(item.error) : json(item.result ?? item.contentItems);
      return { id, output, failed: status === "failed" };
    }
    case "webSearch":
      return { id, output: json(item.results), failed: false };
    default:
      return null;
  }
}

/** Who answers a thread's escalations: Codex's own reviewer in auto mode, else the app ("user"). */
export const reviewerOf = (config: Pick<CodexConfig, "bypassPermissions" | "autoMode">) => (config.bypassPermissions || config.autoMode === false ? "user" : "auto_review");

/** The words a Codex message phase is, for the run's text blocks. */
const phaseOf = (phase: string | null): "commentary" | "final" | null => (phase === "commentary" ? "commentary" : phase ? "final" : null);

// ---------------------------------------------------------------------------------------------
// App-managed Codex workers (shared-core spec 4.2). Each is a thread of its coordinator's app-server. The adapter keeps
// only the protocol: thread/start|resume, turn/start|steer|interrupt, the worker's approvals and auto-accepted isolated
// Git requests, and the thread's tokens as differences; it turns the thread's notifications into the shared core's
// WorkerEvents. The worker's state, its text, how its run ended, its report and the approvals table are the core's.

/** What a Codex worker adapter uses of the app-server connection its coordinator owns. */
export interface CodexWire {
  /** A JSON-RPC request; `reply` gets its result or error. */
  request(method: string, params: Record<string, unknown>, reply: (result: any, error: any) => void): void;
  /** An answer to one of the app-server's requests. */
  write(value: Record<string, unknown>): void;
  /** Items a run shows beside its events (its runtime, its execution). */
  item(item: CodexItem): void;
}

export interface CodexWorkerOptions {
  /** The coordinator's settings, read when used (a hot switch changes them). */
  config: CodexConfig;
  wire: CodexWire;
  /** Codex's reviewer refused one of its calls: the card (CodexSession.reviewed). */
  reviewed?(params: any, worker: { id: string; name: string }): void;
  /** A manual override of the reviewer covers this exact retry, once. */
  allowedRetry?(key: string): boolean;
  /** Why a follow-up must wait (restart recovery still reads its thread), else null. */
  recovering?(id: string): string | null;
  /** Words its turn refused after the run had ended: they start the next run. */
  followUp?(id: string, text: string): void;
  /** Every worker's record (an isolated Git destination must be the worker's alone). */
  records?(): readonly WorkerLedgerRecord[];
  now?(): number;
}

interface ThreadWorker {
  id: string;
  name: string;
  /** The run under way (null: none, or it was stopped). */
  run: RunHandle | null;
  thread: string | null;
  turnId: string | null;
  /** Its thread is open in this app-server (a resumed one is once its instructions are refreshed). */
  loaded: boolean;
  completedTurns: Set<string>;
  said: { text: string; phase: string | null }[];
  /** Words for the turn under way before its id is known (or refused by a turn that was ending). */
  messages: string[];
  /** The words its turn starts with once its thread is ready. */
  text: string;
  /** Its thread's token totals last seen (null: not known in this app-server yet). */
  tokens: TokenUsage | null;
  /** JSON-RPC calls of its own not answered yet. */
  calls: number;
  /** A stop waiting for the start requests of the run it stopped to be answered (their turn, if any, interrupted). */
  stopping?: (result: { cleaned: boolean }) => void;
  /**
   * The stopped run whose start request is still unanswered and no turn of which is known: it may yet begin a turn.
   * Until that run's own request is answered (or its turn is seen and interrupted, or the app-server goes away) no next
   * run may start. Bound to that run: nothing of another run (an old turn seen again) clears it.
   */
  isolating?: RunHandle;
  /** Calls not answered yet, by the run that made them. */
  pending: Map<RunHandle, number>;
  /** Its latest run (the one under way, or the last to end): a late reply of an earlier run is that run's, not this one's. */
  latest?: RunHandle;
  /** Tool calls without a result yet. */
  tools: Set<string>;
  /** After the user allowed a refused call: its next turn asks the app ("user"), the one after the reviewer again. */
  reviewerNext?: string;
  /** Stopped: a turn that starts now is interrupted at once. */
  cancelled: boolean;
  isolatedGit?: IsolatedGitOwnership;
  /** The effort its handoff asked for (null: the Codex workers' setting, else the coordinator's). */
  effort?: string | null;
  runtime?: { engine: "codex"; reasoningEffort: string | null; serviceTier: string | null };
  /** The model its thread runs on, as the app-server said (spec-guard.ts). */
  model?: string | null;
  /** The model its handoff asked for (null: the Codex workers' setting, else the coordinator's). */
  chosenModel?: string | null;
  /** Restart: the original turn had completed with these messages (adopted, nothing is sent). */
  adopt?: { said: { text: string; phase: string | null }[]; turn: string };
  /** Restart: the run continues the original one (its scope and Git grant stay). */
  continuing?: boolean;
}

interface WorkerApproval { worker: ThreadWorker; run: RunHandle; rpcId: unknown; kind: Approval["kind"]; turn: string | null }

export const decline = (rpcId: unknown, kind: Approval["kind"]) => ({ jsonrpc: "2.0", id: rpcId, result: typeof kind === "string" ? { decision: "decline" } : { permissions: {} } });

/** Codex's app-managed workers as the shared core's adapter (kind "codex-thread"). */
export class CodexThreadAdapter implements WorkerAdapter {
  readonly kind = "codex-thread" as const;
  readonly engine = "codex" as const;
  readonly steersRunning = true;
  /** After an explicit restart a resumed thread must be the very one it was. */
  strictResume = false;
  private workers = new Map<string, ThreadWorker>();
  private approvals = new Map<string, WorkerApproval>();
  private changedFiles = new Map<string, string[]>();
  private speed = new CodexRequestTracker();

  constructor(private o: CodexWorkerOptions) {}

  private now() { return this.o.now?.() ?? Date.now(); }

  private worker(record: Readonly<WorkerLedgerRecord>): ThreadWorker {
    let w = this.workers.get(record.id);
    if (!w) {
      w = { id: record.id, name: record.name, run: null, thread: record.conversationId, turnId: null, loaded: false, completedTurns: new Set(), said: [], messages: [], text: "", tokens: null, calls: 0, pending: new Map(), tools: new Set(), cancelled: false };
      this.workers.set(record.id, w);
    }
    w.thread ??= record.conversationId;
    w.isolatedGit = record.engineData.isolatedGit as IsolatedGitOwnership | undefined;
    w.effort = codexEffort(record.engineData.effort);
    w.chosenModel = typeof record.engineData.model === "string" && record.engineData.model ? record.engineData.model : null;
    return w;
  }

  /** The worker whose thread this is. */
  private ofThread(thread: unknown): ThreadWorker | undefined {
    return typeof thread === "string" ? [...this.workers.values()].find((w) => w.thread === thread) : undefined;
  }

  /** A worker's thread asking an app tool (its task and run). */
  requester(thread: unknown): { id: string; run: number | null } | null {
    const w = this.ofThread(thread);
    return w ? { id: w.id, run: w.run?.run ?? null } : null;
  }

  private execution(w: ThreadWorker, run: RunHandle): SubagentExecution {
    return { run: run.run, ownerSessionId: this.o.config.ownerSession ?? null, threadId: w.thread, turnId: w.turnId };
  }

  /** One of its own calls: the reply is dropped once its run is over. */
  private call(w: ThreadWorker, run: RunHandle, method: string, params: Record<string, unknown>, reply: (result: any, error: any) => void) {
    this.count(w, run, 1);
    this.o.wire.request(method, params, (result, error) => {
      this.count(w, run, -1);
      if (w.run === run && !w.cancelled) return reply(result, error);
      // A call of a run that was stopped: a turn it started is that run's, never a later one's, and is interrupted now.
      if (method === "turn/start" && typeof result?.turn?.id === "string") this.isolate(w, result.turn.id, run);
      // That run's last request answered: nothing of it can start any more.
      if (w.isolating === run && !w.pending.has(run)) this.confirmed(w);
    });
  }

  private count(w: ThreadWorker, run: RunHandle, by: 1 | -1) {
    w.calls += by;
    const left = (w.pending.get(run) ?? 0) + by;
    if (left > 0) w.pending.set(run, left);
    else w.pending.delete(run);
  }

  /**
   * A turn of a stopped run: no later run takes its events, and it is interrupted. One seen before (an old turn, its
   * notice again) says nothing new. A new one is the run's being isolated (`run`, or the one that could start a turn
   * unseen) and confirms it.
   */
  private isolate(w: ThreadWorker, turn: string, run?: RunHandle) {
    if (w.completedTurns.has(turn)) return;
    w.completedTurns.add(turn);
    if (w.thread) this.o.wire.request("turn/interrupt", { threadId: w.thread, turnId: turn }, () => undefined);
    if (w.isolating && (!run || run === w.isolating)) this.confirmed(w);
  }

  /** The stopped run is isolated: its stop (if it still waits) is done, and a next run may start. */
  private confirmed(w: ThreadWorker) {
    w.isolating = undefined;
    const done = w.stopping;
    w.stopping = undefined;
    done?.({ cleaned: true });
  }

  private fail(w: ThreadWorker, run: RunHandle, error: string) {
    w.run = null;
    this.drop(w, () => true, false);
    run.emit({ type: "end", end: { how: "error", finalText: null, error, detail: "app-server" } });
  }

  prepare(request: HandoffRequest) {
    const isolatedGit = request.args.isolatedGit;
    const effort = codexEffort(request.args.effort);
    const model = typeof request.args.model === "string" && request.args.model ? request.args.model : null;
    return { engineData: { ...(isolatedGit ? { isolatedGit } : {}), ...(effort ? { effort } : {}), ...(model ? { model } : {}) } };
  }

  /** A worker's turn effort: its handoff's, else the Codex workers' setting, else the coordinator's. */
  private effortOf(record: Readonly<WorkerLedgerRecord>): string | null {
    return codexEffort(record.engineData.effort) ?? this.o.config.workerEffort ?? this.o.config.effort ?? null;
  }

  runtime(record: Readonly<WorkerLedgerRecord>) {
    return { reasoningEffort: this.workers.get(record.id)?.runtime?.reasoningEffort ?? this.effortOf(record) };
  }

  start(record: Readonly<WorkerLedgerRecord>, words: string, run: RunHandle) {
    const w = this.worker(record);
    Object.assign(w, { run, latest: run, cancelled: false, turnId: null, said: [], messages: [] });
    w.tools.clear();
    if (w.adopt) {
      // Completed before the app restarted: its answer is the run's, and nothing is sent again.
      const { said, turn } = w.adopt;
      delete w.adopt;
      for (const message of said) run.emit({ type: "textWhole", text: message.text, phase: phaseOf(message.phase) });
      this.end(w, run, { id: turn, status: "completed" }, said);
      return;
    }
    if (record.engineData.role !== undefined) {
      run.emit({ type: "end", end: { how: "error", finalText: null, error: "Unknown persisted worker role; no generic worker was substituted.", detail: "role" } });
      return;
    }
    if (w.continuing) delete w.continuing;
    else if (run.run > 1) {
      // A follow-up is a task of its own: the hand-off's Git grant does not carry over.
      w.isolatedGit = undefined;
      run.setEngineData({ isolatedGit: undefined, ownershipInstructions: words });
    }
    if (w.loaded && w.thread) this.startTurn(w, run, words);
    else { w.text = words; this.openThread(w, run); }
  }

  private openThread(w: ThreadWorker, run: RunHandle) {
    const c = this.o.config;
    const params: Record<string, unknown> = {
      cwd: c.cwd, approvalPolicy: c.bypassPermissions ? "never" : "on-request", approvalsReviewer: reviewerOf(c), sandbox: c.bypassPermissions ? "danger-full-access" : "workspace-write",
      developerInstructions: `${c.workerInstructions ?? "Execute the assigned task yourself and return concrete evidence. Do not delegate."}\n\n${MONITOR_HANDBACK}${this.specNote(w)}`,
      // The workers write where the coordinator may, as in 1.x (`writable_roots`).
      config: { "features.multi_agent": false, "agents.enabled": false, ...codexAutoRiskConfig(c.autoMode, c.bypassPermissions), ...writableRootsConfig(c.writableRoots) },
    };
    const model = w.chosenModel ?? c.workerModel ?? c.model;
    if (model) params.model = model;
    // Fast mode: the priority service tier (`CodexWorkerDefaults.fast`).
    if (typeof c.workerFast === "boolean") params.serviceTier = c.workerFast ? "priority" : "default";
    const resumed = !!w.thread;
    // Tools are fixed when a thread starts: a resumed thread keeps the ones it started with.
    if (resumed) { params.threadId = w.thread; params.excludeTurns = true; }
    else params.dynamicTools = WORKER_TOOLS;
    this.call(w, run, resumed ? "thread/resume" : "thread/start", params, (result, error) => this.threadReady(w, run, resumed, result, error));
  }

  private threadReady(w: ThreadWorker, run: RunHandle, resumed: boolean, result: any, error: any) {
    const thread = result?.thread?.id;
    if (error || typeof thread !== "string") return this.fail(w, run, `Could not start worker session: ${message(error)}`);
    if (this.strictResume && resumed && thread !== w.thread) return this.fail(w, run, "Restart resume returned a different worker thread; no prompt was sent.");
    w.thread = thread;
    run.emit({ type: "session", conversationId: thread });
    if (!resumed) w.tokens = noTokens();
    else w.tokens = null;
    w.loaded = !resumed;
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
    w.runtime = { engine: "codex", reasoningEffort: text(result.reasoningEffort), serviceTier: text(result.serviceTier) };
    const model = text(result.model);
    if (model) w.model = model;
    this.o.wire.item({ kind: "subagentRuntime", id: w.id, runtime: w.runtime, ...(model ? { model } : {}) });
    this.o.wire.item({ kind: "subagentExecution", id: w.id, execution: this.execution(w, run) });
    if (!resumed) return this.startTurn(w, run, w.text);
    // Resume alone can leave the rollout's old developer policy in force: the current one is appended.
    const policy = `${this.o.config.workerInstructions ?? "Execute the assigned task yourself and do not delegate."}\n\n${MONITOR_HANDBACK}${this.specNote(w)}`;
    this.call(w, run, "thread/inject_items", { threadId: thread, items: [{ type: "message", role: "developer", content: [{ type: "input_text", text: policy }] }] }, (_result, refused) => {
      if (refused) return this.fail(w, run, `Could not refresh worker instructions: ${message(refused)}`);
      w.loaded = true;
      this.startTurn(w, run, w.text);
    });
  }

  private startTurn(w: ThreadWorker, run: RunHandle, text: string) {
    if (!w.thread) return;
    w.turnId = null;
    w.said = [];
    const params: Record<string, unknown> = { threadId: w.thread, input: [{ type: "text", text }] };
    const effort = w.effort ?? this.o.config.workerEffort ?? this.o.config.effort;
    if (effort) params.effort = effort;
    if (w.reviewerNext) {
      params.approvalsReviewer = w.reviewerNext;
      w.reviewerNext = w.reviewerNext === "user" ? "auto_review" : undefined;
    }
    this.call(w, run, "turn/start", params, (result, error) => {
      if (error) return this.fail(w, run, `Could not start worker turn: ${message(error)}`);
      const id = result?.turn?.id;
      if (typeof id !== "string") return;
      // The successful turn/start accepted this explicit override. Otherwise keep thread settings.
      if (effort) {
        w.runtime = { engine: "codex", reasoningEffort: effort, serviceTier: w.runtime?.serviceTier ?? null };
        this.o.wire.item({ kind: "subagentRuntime", id: w.id, runtime: w.runtime });
      }
      this.learnTurn(w, run, id);
    });
  }

  private learnTurn(w: ThreadWorker, run: RunHandle, id: string) {
    if (w.turnId || w.completedTurns.has(id)) return;
    w.turnId = id;
    this.o.wire.item({ kind: "subagentExecution", id: w.id, execution: this.execution(w, run) });
    const messages = w.messages;
    w.messages = [];
    for (const text of messages) this.steerCall(w, run, text, id);
  }

  private steerCall(w: ThreadWorker, run: RunHandle, text: string, turnId: string) {
    this.count(w, run, 1);
    this.o.wire.request("turn/steer", { threadId: w.thread ?? "", expectedTurnId: turnId, input: [{ type: "text", text }] }, (_result, error) => {
      this.count(w, run, -1);
      // Only the run that sent them: a run stopped meanwhile, or followed by another, drops its late words.
      if (!error || w.latest !== run || w.cancelled) return;
      // Its turn had just ended: the words go into its next turn (this run's), or, the run over, its next run.
      if (w.run === run) w.messages.push(text);
      else if (!w.run) this.o.followUp?.(w.id, text);
    });
  }

  steer(record: Readonly<WorkerLedgerRecord>, words: string): boolean {
    const w = this.workers.get(record.id);
    if (!w?.run || w.cancelled) return false;
    w.isolatedGit = undefined;
    const scope = typeof record.engineData.ownershipInstructions === "string" ? record.engineData.ownershipInstructions : record.instructions;
    w.run.setEngineData({ isolatedGit: undefined, ownershipInstructions: `${scope}\nFollow-up: ${words}` });
    if (w.turnId) this.steerCall(w, w.run, words, w.turnId);
    else w.messages.push(words);
    return true;
  }

  /** Ends its run's turn; its open approvals are declined. No end is emitted (the core decided "stopped"). */
  /**
   * Interrupts its turn: done at once when its turn is known (Codex ends it; its late events are dropped). When a start
   * request has no answer yet there is no turn to interrupt: the stop is done once those are answered (a turn one
   * started is interrupted then), so no next run starts while the old turn may still begin.
   */
  stop(record: Readonly<WorkerLedgerRecord>): { cleaned: boolean } | Promise<{ cleaned: boolean }> {
    const w = this.workers.get(record.id);
    // Its run already over: cancelled all the same, so a late steer error of that run starts no next run with its words.
    if (!w?.run) { if (w) { w.cancelled = true; w.messages = []; } return { cleaned: true }; }
    const run = w.run;
    const unsettled = !w.turnId && w.pending.has(run);
    this.interrupt(w);
    if (!unsettled) return { cleaned: true };
    w.isolating = run;
    // Not forever: an app-server that never answers leaves it not clean (blocked until the answer comes, or a restart).
    return new Promise((resolve) => {
      const settle = (result: { cleaned: boolean }) => { clearTimeout(timer); resolve(result); };
      const timer = setTimeout(() => { if (w.stopping === settle) { w.stopping = undefined; resolve({ cleaned: false }); } }, this.o.config.workerStopDeadlineMs ?? 15_000);
      timer.unref?.();
      w.stopping = settle;
    });
  }

  private interrupt(w: ThreadWorker) {
    const turn = w.turnId;
    if (turn) w.completedTurns.add(turn);
    w.run = null;
    w.cancelled = true;
    w.messages = [];
    this.drop(w, () => true, true);
    if (w.thread && turn) this.o.wire.request("turn/interrupt", { threadId: w.thread, turnId: turn }, () => undefined);
  }

  answer(record: Readonly<WorkerLedgerRecord>, nativeId: string, allow: boolean, _input: Record<string, unknown>, why?: string) {
    const approval = this.approvals.get(nativeId);
    if (!approval || approval.worker.id !== record.id) return;
    this.approvals.delete(nativeId);
    const w = approval.worker;
    if (w.run !== approval.run || !this.current(w, approval.turn)) return;
    const result = approval.kind === "command" || approval.kind === "fileChange"
      ? { decision: allow ? "accept" : "decline" }
      : allow ? { permissions: approval.kind.permissions, scope: "turn" } : { permissions: {} };
    this.o.wire.write({ jsonrpc: "2.0", id: approval.rpcId, result });
    // A refusal carries no words in Codex's protocol: why goes to the turn as a message.
    if (!allow && why && w.run) {
      const text = `(App: ${why})`;
      if (w.turnId) this.steerCall(w, w.run, text, w.turnId);
      else w.messages.push(text);
    }
  }

  recover(record: Readonly<WorkerLedgerRecord>): RecoverResult {
    if (this.workers.get(record.id)?.isolating) return { state: "blocked", reason: "Its stopped run's start request has not been answered yet, so its old turn may still begin; it cannot start again until that is known (or the app-server restarts)." };
    // Its turns lived in an app-server that is gone; only a restart's own check of the thread can hold it back.
    const waiting = this.o.recovering?.(record.id);
    return waiting ? { state: "blocked", reason: waiting } : { state: "clean" };
  }

  async close() {
    for (const w of this.workers.values()) {
      if (w.run) this.interrupt(w);
      // A stop still waiting for its start requests' answers never gets them now: not known to be clean.
      if (w.stopping) { const done = w.stopping; w.stopping = undefined; done({ cleaned: false }); }
    }
  }

  /** The app-server went away: every run under way ends with it, and every thread must be resumed again. */
  exited(reason: string) {
    for (const w of this.workers.values()) {
      w.loaded = false;
      // Its turns went with it: a stop waiting for one is done (nothing of the old run can start).
      w.calls = 0;
      w.pending.clear();
      this.confirmed(w);
      const run = w.run;
      if (!run) continue;
      w.run = null;
      this.drop(w, () => true, false);
      run.emit({ type: "end", end: { how: "exited", finalText: null, error: reason, detail: "app-server exited" } });
    }
  }

  /** Restart: its next run adopts the original turn's completed answer. */
  adopt(id: string, said: { text: string; phase: string | null }[], turn: string) {
    const w = this.workers.get(id) ?? this.blank(id);
    w.adopt = { said, turn };
  }

  /** Restart: its next run continues the original one. */
  continueAfterRestart(id: string) { (this.workers.get(id) ?? this.blank(id)).continuing = true; }

  private blank(id: string): ThreadWorker {
    const w: ThreadWorker = { id, name: "", run: null, thread: null, turnId: null, loaded: false, completedTurns: new Set(), said: [], messages: [], text: "", tokens: null, calls: 0, pending: new Map(), tools: new Set(), cancelled: false };
    this.workers.set(id, w);
    return w;
  }

  /** After the user allowed a refused call: its next turn asks the app once. */
  askAppNext(id: string) { const w = this.workers.get(id); if (w) w.reviewerNext = "user"; }

  /** Its turn under way (a restart snapshot). */
  turnOf(id: string): string | null { return this.workers.get(id)?.turnId ?? null; }

  /** Kept for an explicit restart: whether its turn can be resumed, and which turn. */
  restartData(record: Readonly<WorkerLedgerRecord>) { return { restartSafe: this.restartSafe(record.id), restartTurn: this.turnOf(record.id) ?? undefined }; }

  /** Whether an app restart now could resume it: a known turn and nothing unanswered or half-done. */
  restartSafe(id: string): boolean {
    const w = this.workers.get(id);
    return !!w?.run && !w.cancelled && !!w.turnId && !w.calls && !w.tools.size && !w.messages.length && ![...this.approvals.values()].some((a) => a.worker === w);
  }

  private current(w: ThreadWorker, turn: string | null): boolean {
    return !!w.run && !w.cancelled && (!turn || !w.completedTurns.has(turn)) && (!w.turnId || !turn || w.turnId === turn);
  }

  /** Forgets its approvals that match (declining them to Codex when `deny`); the core cancels their cards. */
  private drop(w: ThreadWorker, matches: (approval: WorkerApproval) => boolean, deny: boolean, notify = false) {
    for (const [nativeId, approval] of this.approvals) {
      if (approval.worker !== w || !matches(approval)) continue;
      this.approvals.delete(nativeId);
      if (deny) this.o.wire.write(decline(approval.rpcId, approval.kind));
      if (notify) approval.run.emit({ type: "permissionCancelled", nativeId });
    }
  }

  /** Whether this worker's model may not write spec/ (spec-guard.ts); unknown counts as not. */
  private specLocked(w: ThreadWorker): boolean {
    const c = this.o.config;
    return !maySpecWrite(w.model ?? w.chosenModel ?? c.workerModel ?? c.model, c.specWriters ?? DEFAULT_SPEC_WRITERS);
  }

  private specNote(w: ThreadWorker): string {
    return this.specLocked(w) ? `\n\n${SPEC_DENIED}` : "";
  }

  /** An approval request that writes into spec/: a command that clearly does, or a patch with a path there. */
  private writesSpec(method: string, params: any): boolean {
    const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : this.o.config.cwd;
    if (method === "item/commandExecution/requestApproval") {
      const command = typeof params.command === "string" ? params.command : Array.isArray(params.command) ? params.command.join(" ") : "";
      return !!command && shellWritesSpec(command, cwd);
    }
    if (method !== "item/fileChange/requestApproval") return false;
    const files = typeof params.itemId === "string" ? this.changedFiles.get(params.itemId) ?? [] : [];
    return [...files, ...(typeof params.grantRoot === "string" ? [params.grantRoot] : [])].some((path) => inSpec(path, cwd));
  }

  // From the app-server

  /** One of the app-server's requests on a worker's thread (its approvals). False: not a worker's. */
  serverRequest(method: string, rpcId: unknown, params: any): boolean {
    const w = this.ofThread(params.threadId);
    if (!w) return false;
    if (this.specLocked(w) && this.writesSpec(method, params)) {
      // Declined without a card: no answer of the user's lets a worker not on a spec writer's model write spec/.
      this.o.wire.write(decline(rpcId, method === "item/fileChange/requestApproval" ? "fileChange" : "command"));
      return true;
    }
    const reason = typeof params.reason === "string" && params.reason ? params.reason : "";
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const turn = typeof params.turnId === "string" ? params.turnId : null;
        const current = this.current(w, turn);
        const plain = params.environmentId === "local" && !params.networkApprovalContext && (params.kind === undefined || params.kind === "command") // never stdin to a running process
          && (!Array.isArray(params.availableDecisions) || params.availableDecisions.includes("accept"));
        // A manual override covers one retry in its exact thread and working directory.
        if (current && plain && this.o.allowedRetry?.(JSON.stringify([params.threadId, params.cwd, params.command]))) {
          this.o.wire.write({ jsonrpc: "2.0", id: rpcId, result: { decision: "accept" } });
          return true;
        }
        const ownership = w.isolatedGit;
        const exclusive = ownership && !(this.o.records?.() ?? []).some((r) => {
          const other = r.engineData.isolatedGit as IsolatedGitOwnership | undefined;
          return r.id !== w.id && !!other && (other.worktree === ownership.worktree || other.branch === ownership.branch);
        });
        if (this.o.config.bypassPermissions === true && current && w.turnId && turn === w.turnId && plain
          && exclusive && isolatedGitOwners.get(ownership.worktree) === w.id && approveIsolatedGit(ownership, this.o.config.cwd, params)) {
          // One request only: never acceptForSession / execpolicy amendments / wider permissions.
          this.o.wire.write({ jsonrpc: "2.0", id: rpcId, result: { decision: "accept" } });
          return true;
        }
        let summary = typeof params.command === "string" ? params.command : "";
        if (reason) summary += (summary ? "\n\n" : "") + reason;
        this.ask(w, rpcId, "command", params, "Bash", summary);
        return true;
      }
      case "item/fileChange/requestApproval": {
        const files = typeof params.itemId === "string" ? this.changedFiles.get(params.itemId) ?? [] : [];
        let summary = files.join("\n");
        if (typeof params.grantRoot === "string" && params.grantRoot) summary += (summary ? "\n" : "") + params.grantRoot;
        if (reason) summary += (summary ? "\n\n" : "") + reason;
        this.ask(w, rpcId, "fileChange", params, "Edit", summary);
        return true;
      }
      case "item/permissions/requestApproval": {
        const asked = params.permissions && typeof params.permissions === "object" ? params.permissions : {};
        this.ask(w, rpcId, { permissions: asked }, params, "Permissions", [reason, JSON.stringify(asked, Object.keys(asked).sort())].filter(Boolean).join("\n\n"));
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * An approval card through the core. Its native id is a fresh local identity, never the RPC id: Codex reuses those, and
   * a stale card must never answer a later request.
   */
  private ask(w: ThreadWorker, rpcId: unknown, kind: Approval["kind"], params: any, tool: string, summary: string) {
    const turn = typeof params.turnId === "string" ? params.turnId : w.turnId;
    if (!w.run || !this.current(w, turn)) { this.o.wire.write(decline(rpcId, kind)); return; }
    if ([...this.approvals.values()].some((open) => open.rpcId === rpcId && open.worker === w && open.turn === turn)) return;
    const nativeId = randomUUID();
    this.approvals.set(nativeId, { worker: w, run: w.run, rpcId, kind, turn });
    w.run.emit({ type: "permission", nativeId, tool, summary, input: {} });
  }

  /** A notification on a worker's thread. False: not a worker's. */
  receive(method: string, params: any): boolean {
    const w = this.ofThread(params.threadId);
    if (!w) return false;
    const run = w.run;
    const supplied = params.turnId ?? (method === "turn/started" ? params.turn?.id : null);
    if (run) for (const { scope: _scope, ...request } of this.speed.observe(w.id, method, params, this.now())) run.emit({ type: "request", request });
    switch (method) {
      case "turn/started": {
        const id = params.turn?.id;
        if (typeof id !== "string") return true;
        if (w.cancelled) this.isolate(w, id);
        else if (run) this.learnTurn(w, run, id);
        return true;
      }
      case "item/started":
      case "item/completed": {
        const item = params.item;
        if (!run || !item || typeof item !== "object") return true;
        // Another turn's (a stopped run's, even before this run's turn is known): never this run's.
        if (typeof params.turnId === "string" && (w.completedTurns.has(params.turnId) || (w.turnId && params.turnId !== w.turnId))) return true;
        if (method === "item/started") {
          const step = codexToolStarted(item, this.changedFiles);
          if (step) { w.tools.add(step.id); run.emit({ type: "toolUse", ...step }); }
          return true;
        }
        if (item.type === "agentMessage") {
          const text = typeof item.text === "string" ? item.text : "";
          const phase = typeof item.phase === "string" ? item.phase : null;
          w.said.push({ text, phase });
          run.emit({ type: "textWhole", text, phase: phaseOf(phase) });
          return true;
        }
        const result = codexToolCompleted(item, this.changedFiles);
        if (result) { w.tools.delete(result.id); run.emit({ type: "toolResult", ...result }); }
        return true;
      }
      case "turn/completed":
        this.turnCompleted(w, params.turn);
        return true;
      case "item/autoApprovalReview/completed":
        this.o.reviewed?.(params, { id: w.id, name: w.name });
        return true;
      case "serverRequest/resolved":
        for (const [nativeId, approval] of this.approvals) {
          if (approval.rpcId !== params.requestId || approval.worker !== w || (typeof params.turnId === "string" && approval.turn !== params.turnId)) continue;
          this.approvals.delete(nativeId);
          approval.run.emit({ type: "permissionCancelled", nativeId });
        }
        return true;
      case "thread/tokenUsage/updated":
        if (run) this.tokenUsage(w, run, params);
        return true;
      default:
        return true;
    }
  }

  /** What the thread used since the last update (the totals' difference; a resumed thread's first update: its last request). */
  private tokenUsage(w: ThreadWorker, run: RunHandle, params: any) {
    const total = params.tokenUsage?.total;
    if (total && typeof total === "object" && Number.isSafeInteger(total.outputTokens) && total.outputTokens >= 0) {
      const now = codexTokens(total);
      const last = params.tokenUsage?.last;
      const used = w.tokens ? minusTokens(now, w.tokens) : last && typeof last === "object" ? codexTokens(last) : noTokens();
      w.tokens = now;
      if (totalTokens(used) > 0 && Object.values(used).every((count) => count >= 0)) run.emit({ type: "usage", tokens: used, cost: 0 });
    }
  }

  private turnCompleted(w: ThreadWorker, turn: any) {
    const run = w.run;
    const id = turn?.id;
    if (!run || w.cancelled || typeof id !== "string" || w.completedTurns.has(id) || (w.turnId && w.turnId !== id)) return;
    w.completedTurns.add(id);
    w.turnId = null;
    if (w.messages.length) {
      // Words a steer could not put into the turn as it ended: they are this run's, in a turn of their own.
      this.drop(w, (approval) => !approval.turn || approval.turn === id, false, true);
      const text = w.messages.join("\n\n");
      w.messages = [];
      this.startTurn(w, run, text);
      return;
    }
    this.end(w, run, turn, w.said);
  }

  /** Its run's end as Codex says it: the last message that is not commentary is its final answer. */
  private end(w: ThreadWorker, run: RunHandle, turn: { id: string; status?: unknown; error?: any }, said: { text: string; phase: string | null }[]) {
    w.run = null;
    this.drop(w, () => true, false);
    run.setEngineData({ turn: turn.id });
    const final = said.findLast((s) => s.phase !== "commentary")?.text.trim() || null;
    const status = typeof turn.status === "string" ? turn.status : "failed";
    const end: RunEnd = status === "completed" ? { how: "normal", finalText: final, error: null, detail: status }
      : status === "interrupted" ? { how: "cancelled", finalText: final, error: "Codex interrupted the worker's turn.", detail: status }
        : { how: "error", finalText: final, error: typeof turn.error?.message === "string" ? turn.error.message : "Worker failed.", detail: status };
    run.emit({ type: "end", end });
  }
}
