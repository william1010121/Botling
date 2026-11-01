import { CodexRequestTracker } from "../token-speed";
import { settingsChange, type HotSettings } from "./hot-settings";
import {claudeConfigFolder} from '../claude-files';
import {inspectClaudeRestart, type ClaudeRestartOutcome} from '../claude-restart';
import { RESTART_NOTE } from '../restart-continuation';
import { monitorHandback, MONITOR_HANDBACK } from "./monitor-policy";
import { TokenFlowMeter } from "../token-flow-meter";
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
import { approveIsolatedGit, isolatedGitOwnership, type IsolatedGitOwnership } from "./isolated-git";
/** A live worker or monitored command as the head reports it (what keeps a head from idling). */
export interface WorkerDependency { id: string; run: number; task: string; state: "running" | "reportQueued"; callback?: string; outcome?: string; taskTruncated: boolean }
import type { SubagentExecution } from "../subagents";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../durable/atomic";
import { processTreeAdapter, type ManagedProcess, type ProcessTreeAdapter, type TerminateResult } from "../process/tree";
import { childEnvironment } from "./runner";
import { codexLogsFile, codexRetryAt } from "./codex-retry-log";
import { cliStartError, resolveExecutable } from "../process/executable";
import { activity, type StreamItem } from "./stream";
import type { HeadExit, HeadHandlers } from "./head";
import { movedTaskError, type WorkerHost, type WorkerInfo, type WorkerOwner, type WorkerOwnerResult, type WorkerSendResult } from "./workers";
import { ComponentEditorAdapter, EditorTransport, type ComponentEditorAction, type ComponentEditorRoute } from "./component-editor";
import tools from "./codex-tools.json";
import { RoutineError, ScheduledRoutineStore } from "../routines";
import { bounded, isActive as monitorActive, loadMonitors, MONITOR_OUTPUT_LIMIT, monitorPayload, monitorSummary, reconcile, saveMonitors, type CommandMonitor } from "./monitors";
import { toSwiftDate } from "../store/records";
import { codexRateLimits, codexTokens, isEmptyLimits, minusTokens, noTokens, totalTokens, type TokenUsage } from "../usage";
import {
  CodexLegacyStore, INTERRUPTED_REPORT, reportPayload, STOPPED_REPORT, wireStatus, WorkerCore,
  type CodexJournal, type CoordinatorPort, type HandoffRequest, type RecoverResult, type RunEnd, type RunHandle, type WorkerAdapter, type WorkerLedgerRecord, type WorkerReport,
} from "../worker-core";

/** What a Codex head gives the bot besides claude's items. */
export type CodexItem =
  | StreamItem
  /** Words between tool calls (Codex's commentary): a step of the turn, not the reply. */
  | { kind: "stepText"; text: string }
  /** The app started a turn on the coordinator by itself (a worker's report). */
  | { kind: "backgroundTurn"; taskId: string | null }
  /** Workers at work or reports waiting: the bot must not sleep. */
  | { kind: "managedPending"; pending: boolean }
  /** A run report of a worker another bot owns (workers.ts `setWorkerOwner`): the app routes it to that bot, never to this coordinator. */
  | { kind: "workerReport"; id: string; run: number; engine: "claude" | "codex" | "agy"; status: string; report: string }
  /** A monitored command ended: its step (from an earlier turn) is done. */
  | { kind: "monitorState"; record: CommandMonitor }
  | { kind: "monitorEnded"; id: string; output: string; failed: boolean }
  /** `app_routines` changed the bot's routines. */
  | { kind: "routinesChanged" }
  /**
   * The coordinator's request was turned away and Codex will try again (`error` with willRetry:
   * "Reconnecting... 1/5"): rateLimited for HTTP 429, else connection. `retryAt` (ms) comes from
   * Codex's own log (codex-retry-log.ts) when the head finds it; null: not known (yet).
   */
  | { kind: "apiRetry"; thread: string; attempt: number; max: number; reason: "rateLimited" | "connection"; retryAt: number | null };

export type CodexOutput =
  | { kind: "write"; value: Record<string, unknown> }
  | { kind: "item"; item: CodexItem }
  | { kind: "thread"; id: string }
  | { kind: "close" }
  | { kind: "componentEditor"; action: ComponentEditorAction }
  | { kind: "recoverEditor"; task:string; run:number; session:string; checkpoint:string }
  | { kind: "failed"; message: string };

/** A worker as codex-threads/<session>.workers.json keeps it (`CodexManagedWorkerRecord`, 1.x's keys). */
export interface WorkerRecord {
  editorCheckpoint?: string;
  editorSessionConfirmed?: boolean;
  restartSafe?: boolean;
  restartTurn?: string;
  reportDispatching?: boolean;
  id: string;
  name: string;
  instructions: string;
  thread?: string;
  run: number;
  wasActive: boolean;
  reportPending: boolean;
  report?: string;
  status?: string;
  turn?: string;
  isolatedGit?: IsolatedGitOwnership;
  ownershipInstructions?: string;
  role?: string;
  /** The bot it was given to (workers.ts `setWorkerOwner`); absent: the coordinator's. */
  owner?: WorkerOwner;
}

export interface CodexConfig {
  cwd: string;
  /** The coordinator's developer instructions (Prompts.swift's system prompt for a Codex head). */
  instructions: string;
  /** What app-managed workers are told; null: not a coordinator (no app tools). */
  workerInstructions: string | null;
  /** Go on in this thread (`thread/resume`) instead of starting one. */
  resumeThread: string | null;
  model: string | null;
  workerModel: string | null;
  /** "low" … "xhigh". */
  effort: string | null;
  /** Workers' own effort and Fast mode (settings' Codex workers; null: as the coordinator / config.toml). */
  workerEffort?: string | null;
  workerFast?: boolean | null;
  restoredWorkers: WorkerRecord[];
  restartWorkers?: WorkerRecord[];
  strictResume?: boolean;
  restartTurn?: string;
  /** Core binds this only for its own Maintainer; tool arguments cannot supply it. */
  componentEditor?: ComponentEditorRoute | null;
  /** scheduled-routines.json for `app_routines` (null: none here). */
  routinesFile?: string | null;
  /** The bot session that owns its monitors. */
  ownerSession?: string;
  restoredMonitors?: CommandMonitor[];
  /** Auto mode (default on): Codex's own reviewer (`auto_review`) answers escalations; only its refusals become a card. */
  autoMode?: boolean;
  /** Explicit opt-in: no approval prompts and no Codex sandbox. */
  bypassPermissions?: boolean;
  /** More folders it may write besides `cwd` (1.x's `writableRoots`: the bot's `--add-dir` folders). */
  writableRoots?: string[];
}

/** Codex's `sandbox_workspace_write.writable_roots` for these folders (none: nothing to add). */
function writableRootsConfig(roots: readonly string[] | undefined): Record<string, unknown> {
  return roots?.length ? { sandbox_workspace_write: { writable_roots: [...roots] } } : {};
}

type Call =
  | { kind: "initialize" | "thread" | "turn" | "interrupt" | "other" }
  | { kind: "coordinatorInstructions"; thread: string }
  | { kind: "steer"; input: Input }
  | { kind: "restartCoordinatorRead"; turn: string }
  | { kind: "restartWorkerRead"; task: string; turn: string }
  | { kind: "monitorCommand"; id: string }
  /** A worker adapter's own request (CodexWire). */
  | { kind: "adapter"; reply: (result: any, error: any) => void };

interface Input { text: string; token: string; images?: string[] }
interface Turn { id: string | null; waitingSteers: Input[]; interruptAsked: boolean; interruptSent: boolean; said: { text: string; phase: string | null }[] }
interface Approval {
  rpcId: unknown;
  kind: "command" | "fileChange" | { permissions: Record<string, unknown> };
  thread: string;
  turn: string | null;
}

/** Codex's coordinator: no shell, no native subagents, no web search (`coordinatorConfig`). */
const COORDINATOR_CONFIG = { "features.multi_agent": false, "agents.enabled": false, "features.shell_tool": false, web_search: "disabled" };
export const MANAGED_TOOLS = tools as Record<string, unknown>[];
/** The longest hand-off the worker core takes. */
const MAX_HANDOFF = 64_000;
/** Changing the tools needs a new coordinator thread (tools are fixed when a thread starts). */
export const MANAGED_TOOL_SIGNATURE = JSON.stringify(MANAGED_TOOLS);
// All bot sessions in this app share destination claims. A second session must never adopt
// another worker's grant just because its branch/worktree names happen to match.
const isolatedGitOwners = new Map<string, string>();
/** The subagent type of the Maintainer's component editor. */
const EDITOR_TYPE = "ccb-core:component-editor";

/** The shell a monitored command runs in (1.x: zsh on macOS). */
const shell = (command: string): string[] => (process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : process.platform === "darwin" ? ["/bin/zsh", "-c", command] : ["/bin/sh", "-c", command]);

/** `CodexSession.handbackFallback`: worker evidence kept, fenced so its tags are not the app's. */
export function handbackFallback(result: { name: string; task: string; status: string; report: string }, reason: string): string {
  const evidence = `Reason: ${reason}\nWorker: ${result.name}\nTask: ${result.task}\nStatus: ${result.status}\n\n${result.report}`;
  const longest = Math.max(0, ...(evidence.match(/~+/g) ?? []).map((run) => run.length));
  const fence = "~".repeat(Math.max(3, longest + 1));
  return `The coordinator could not summarize a worker result. The original evidence is preserved below.\n\n${fence}text\n${evidence}\n${fence}`;
}

export function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((part) => part.length) ?? text;
  return [...line].length > 60 ? `${[...line].slice(0, 60).join("")}…` : line;
}

const message = (error: unknown) => (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : "Codex did not answer.");
const key = (id: unknown) => String(id);
const json = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
};

/** The words a restarted worker's run shows when it adopts the answer its original turn completed with before the restart. */
const ADOPTED_RUN = "(App: this worker's turn completed before the app restarted; its answer is reported as it was. Nothing was sent to it again.)";

/** A worker core result its sync adapters already have (a promise would mean an adapter that is not: `pending` instead). */
const syncResult = <T>(value: T | Promise<T>, pending: T): T => (value instanceof Promise ? pending : value);

/** What it ran, without the shell wrapping it when Codex parsed it (`CodexSession.command`). */
export function codexCommand(item: Record<string, any>): string {
  const actions = (Array.isArray(item.commandActions) ? item.commandActions : []).map((a: any) => a?.command).filter((c: unknown): c is string => typeof c === "string");
  if (actions.length === 1) return actions[0]!;
  return typeof item.command === "string" ? item.command : actions.join(" && ");
}

/** A Codex tool call starting (a step): what it ran or changed. `changedFiles` keeps a patch's paths for its approval card. */
export function codexToolStarted(item: any, changedFiles: Map<string, string[]>): { id: string; tool: string; title: string; detail: string; input: Record<string, unknown> } | null {
  if (!item || typeof item.id !== "string") return null;
  const id = item.id;
  switch (item.type) {
    case "commandExecution": {
      const command = codexCommand(item);
      return { id, tool: "Bash", title: activity("Bash", { command }), detail: command, input: { command } };
    }
    case "fileChange": {
      const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.map((change) => change?.path).filter((path): path is string => typeof path === "string");
      changedFiles.set(id, paths);
      const adds = changes.length > 0 && changes.every((change) => change?.kind?.type === "add");
      const tool = adds ? "Write" : "Edit";
      let title = activity(tool, paths[0] ? { file_path: paths[0] } : {});
      if (paths.length > 1) title += ` +${paths.length - 1}`;
      return { id, tool, title, detail: paths.join("\n"), input: {} };
    }
    case "mcpToolCall": {
      const server = String(item.server ?? ""), tool = String(item.tool ?? "");
      return { id, tool: `mcp__${server}__${tool}`, title: `${server} ${tool}`, detail: json(item.arguments), input: {} };
    }
    case "dynamicToolCall": {
      // The app's own tools show as their own steps (a hand-off as its subagent row).
      const tool = String(item.tool ?? "tool");
      if (tool === "app_handoff" || tool === "app_send_message" || tool === "app_task_checkpoint") return null;
      return { id, tool, title: tool, detail: json(item.arguments), input: {} };
    }
    case "webSearch": {
      const query = String(item.query ?? "");
      return { id, tool: "WebSearch", title: activity("WebSearch", { query }), detail: query, input: {} };
    }
    default:
      return null;
  }
}

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
const reviewerOf = (config: Pick<CodexConfig, "bypassPermissions" | "autoMode">) => (config.bypassPermissions || config.autoMode === false ? "user" : "auto_review");

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
  /** Items a run shows beside its events (its runtime, its execution, the token-flow dispatch). */
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
  /** Tool calls without a result yet. */
  tools: Set<string>;
  /** After the user allowed a refused call: its next turn asks the app ("user"), the one after the reviewer again. */
  reviewerNext?: string;
  /** Stopped: a turn that starts now is interrupted at once. */
  cancelled: boolean;
  isolatedGit?: IsolatedGitOwnership;
  runtime?: { engine: "codex"; reasoningEffort: string | null; serviceTier: string | null };
  /** Restart: the original turn had completed with these messages (adopted, nothing is sent). */
  adopt?: { said: { text: string; phase: string | null }[]; turn: string };
  /** Restart: the run continues the original one (its scope and Git grant stay). */
  continuing?: boolean;
}

interface WorkerApproval { worker: ThreadWorker; run: RunHandle; rpcId: unknown; kind: Approval["kind"]; turn: string | null }

const decline = (rpcId: unknown, kind: Approval["kind"]) => ({ jsonrpc: "2.0", id: rpcId, result: typeof kind === "string" ? { decision: "decline" } : { permissions: {} } });

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
  private meter = new TokenFlowMeter();

  constructor(private o: CodexWorkerOptions) {}

  private now() { return this.o.now?.() ?? Date.now(); }

  private worker(record: Readonly<WorkerLedgerRecord>): ThreadWorker {
    let w = this.workers.get(record.id);
    if (!w) {
      w = { id: record.id, name: record.name, run: null, thread: record.conversationId, turnId: null, loaded: false, completedTurns: new Set(), said: [], messages: [], text: "", tokens: null, calls: 0, tools: new Set(), cancelled: false };
      this.workers.set(record.id, w);
    }
    w.thread ??= record.conversationId;
    w.isolatedGit = record.engineData.isolatedGit as IsolatedGitOwnership | undefined;
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
    w.calls += 1;
    this.o.wire.request(method, params, (result, error) => {
      w.calls -= 1;
      if (w.run === run && !w.cancelled) reply(result, error);
    });
  }

  private fail(w: ThreadWorker, run: RunHandle, error: string) {
    w.run = null;
    this.drop(w, () => true, false);
    run.emit({ type: "end", end: { how: "error", finalText: null, error, detail: "app-server" } });
  }

  prepare(request: HandoffRequest) {
    const isolatedGit = request.args.isolatedGit;
    return { engineData: isolatedGit ? { isolatedGit } : {} };
  }

  runtime(record: Readonly<WorkerLedgerRecord>) {
    return { reasoningEffort: this.workers.get(record.id)?.runtime?.reasoningEffort ?? this.o.config.workerEffort ?? this.o.config.effort ?? null };
  }

  start(record: Readonly<WorkerLedgerRecord>, words: string, run: RunHandle) {
    const w = this.worker(record);
    Object.assign(w, { run, cancelled: false, turnId: null, said: [], messages: [] });
    w.tools.clear();
    this.o.wire.item({ kind: "measurementDispatch", workerId: record.id, run: run.run });
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
      developerInstructions: `${c.workerInstructions ?? "Execute the assigned task yourself and return concrete evidence. Do not delegate."}\n\n${MONITOR_HANDBACK}`,
      // The workers write where the coordinator may, as in 1.x (`writable_roots`).
      config: { "features.multi_agent": false, "agents.enabled": false, ...codexAutoRiskConfig(c.autoMode, c.bypassPermissions), ...writableRootsConfig(c.writableRoots) },
    };
    const model = c.workerModel ?? c.model;
    if (model) params.model = model;
    // Fast mode: the priority service tier (`CodexWorkerDefaults.fast`).
    if (typeof c.workerFast === "boolean") params.serviceTier = c.workerFast ? "priority" : "default";
    const resumed = !!w.thread;
    if (resumed) { params.threadId = w.thread; params.excludeTurns = true; }
    this.call(w, run, resumed ? "thread/resume" : "thread/start", params, (result, error) => this.threadReady(w, run, resumed, result, error));
  }

  private threadReady(w: ThreadWorker, run: RunHandle, resumed: boolean, result: any, error: any) {
    const thread = result?.thread?.id;
    if (error || typeof thread !== "string") return this.fail(w, run, `Could not start worker session: ${message(error)}`);
    if (this.strictResume && resumed && thread !== w.thread) return this.fail(w, run, "Restart resume returned a different worker thread; no prompt was sent.");
    w.thread = thread;
    run.emit({ type: "session", conversationId: thread });
    if (!resumed) { this.meter.fresh(thread); w.tokens = noTokens(); }
    else w.tokens = null;
    w.loaded = !resumed;
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
    w.runtime = { engine: "codex", reasoningEffort: text(result.reasoningEffort), serviceTier: text(result.serviceTier) };
    const model = text(result.model);
    this.o.wire.item({ kind: "subagentRuntime", id: w.id, runtime: w.runtime, ...(model ? { model } : {}) });
    this.o.wire.item({ kind: "subagentExecution", id: w.id, execution: this.execution(w, run) });
    if (!resumed) return this.startTurn(w, run, w.text);
    // Resume alone can leave the rollout's old developer policy in force: the current one is appended.
    const policy = `${this.o.config.workerInstructions ?? "Execute the assigned task yourself and do not delegate."}\n\n${MONITOR_HANDBACK}`;
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
    const effort = this.o.config.workerEffort ?? this.o.config.effort;
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
    if (w.thread) this.meter.begin(w.thread, id);
    this.o.wire.item({ kind: "subagentExecution", id: w.id, execution: this.execution(w, run) });
    const messages = w.messages;
    w.messages = [];
    for (const text of messages) this.steerCall(w, run, text, id);
  }

  private steerCall(w: ThreadWorker, run: RunHandle, text: string, turnId: string) {
    w.calls += 1;
    this.o.wire.request("turn/steer", { threadId: w.thread ?? "", expectedTurnId: turnId, input: [{ type: "text", text }] }, (_result, error) => {
      w.calls -= 1;
      if (!error || w.cancelled) return;
      // The turn had just ended: the words go into its next turn (this run's), or the next run.
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
  async stop(record: Readonly<WorkerLedgerRecord>) {
    const w = this.workers.get(record.id);
    if (w?.run) this.interrupt(w);
    return { cleaned: true };
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
    // Its turns lived in an app-server that is gone; only a restart's own check of the thread can hold it back.
    const waiting = this.o.recovering?.(record.id);
    return waiting ? { state: "blocked", reason: waiting } : { state: "clean" };
  }

  async close() {
    for (const w of this.workers.values()) if (w.run) this.interrupt(w);
  }

  /** The app-server went away: every run under way ends with it, and every thread must be resumed again. */
  exited(reason: string) {
    for (const w of this.workers.values()) {
      w.loaded = false;
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
    const w: ThreadWorker = { id, name: "", run: null, thread: null, turnId: null, loaded: false, completedTurns: new Set(), said: [], messages: [], text: "", tokens: null, calls: 0, tools: new Set(), cancelled: false };
    this.workers.set(id, w);
    return w;
  }

  /** After the user allowed a refused call: its next turn asks the app once. */
  askAppNext(id: string) { const w = this.workers.get(id); if (w) w.reviewerNext = "user"; }

  /** Its turn under way (a restart snapshot). */
  turnOf(id: string): string | null { return this.workers.get(id)?.turnId ?? null; }

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

  // From the app-server

  /** One of the app-server's requests on a worker's thread (its approvals). False: not a worker's. */
  serverRequest(method: string, rpcId: unknown, params: any): boolean {
    const w = this.ofThread(params.threadId);
    if (!w) return false;
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
    // Metadata only; routing below remains authoritative.
    if ((!w.turnId || !supplied || w.turnId === supplied) && (run || method === "thread/tokenUsage/updated")) this.meter.observe(method, params);
    if (run) for (const { scope: _scope, ...request } of this.speed.observe(w.id, method, params, this.now())) run.emit({ type: "request", request });
    switch (method) {
      case "turn/started": {
        const id = params.turn?.id;
        if (typeof id !== "string") return true;
        if (w.cancelled && w.thread) this.o.wire.request("turn/interrupt", { threadId: w.thread, turnId: id }, () => undefined);
        else if (run) this.learnTurn(w, run, id);
        return true;
      }
      case "item/started":
      case "item/completed": {
        const item = params.item;
        if (!run || !item || typeof item !== "object") return true;
        if (typeof params.turnId === "string" && w.turnId && params.turnId !== w.turnId) return true;
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
    const snapshot = w.thread ? this.meter.snapshot(w.thread) : null;
    if (snapshot && (!params.turnId || params.turnId === snapshot.turnId)) run.emit({ type: "measurement", provider: "codex", measurement: snapshot });
  }

  private turnCompleted(w: ThreadWorker, turn: any) {
    const run = w.run;
    const id = turn?.id;
    if (!run || w.cancelled || typeof id !== "string" || w.completedTurns.has(id) || (w.turnId && w.turnId !== id)) return;
    w.completedTurns.add(id);
    const measured = w.thread ? this.meter.finish(w.thread, id) : null;
    if (measured) run.emit({ type: "measurement", provider: "codex", measurement: measured });
    const gap = this.meter.takeMissing();
    if (gap) run.emit({ type: "measurement", provider: "codex", measurement: gap });
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

export class CodexSession implements CoordinatorPort {
  private nextId = 1;
  private calls = new Map<number, Call>();
  threadId: string | null = null;
  private turn: Turn | null = null;
  private completedTurns = new Set<string>();
  /** The coordinator thread's tokens so far, and when the last turn ended (Phase 5c, 1.x's `tokensTotal`). */
  private tokensTotal: TokenUsage = noTokens();
  private readonly usageMeter = new TokenFlowMeter();
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
  /** The workers' dollars so far: the bot reads a usage item's cost as a running total of its head. */
  private workerCost = 0;

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
        item: (item) => this.out.push(this.item(item)),
      },
      reviewed: (params, worker) => this.out.push(...this.reviewed(params, worker)),
      allowedRetry: (key) => this.allowedCommands.delete(key),
      followUp: (id, text) => { void this.core.sendToWorker(id, text); },
    });
    this.threads.strictResume = !!config.restartWorkers;
    this.editor = new ComponentEditorAdapter({
      route: () => this.config.componentEditor, recovering,
      act: (action) => this.out.push({ kind: "componentEditor", action }),
      item: (item) => this.out.push(this.item(item)),
      ownerSessionId: () => this.config.ownerSession ?? null,
    });
    this.core = new WorkerCore({
      store: new CodexLegacyStore(journal, config.ownerSession ?? ""), port: this, sink: { item: (item) => this.sink(item) },
      adapters: [this.threads, this.editor], ownerSessionId: () => this.config.ownerSession ?? "", log: () => undefined,
      parentThreadId: () => this.threadId,
      newId: () => { const id = this.nextTask ?? randomUUID().toLowerCase(); this.nextTask = null; return id; },
    });
    for (const record of config.restartWorkers ?? []) {
      if (record.wasActive && record.restartSafe && record.thread && ((!record.role && record.restartTurn) || (record.role === "component-editor" && record.editorCheckpoint)))
        this.restartPending.set(record.id, record);
    }
    // A report whose hand-over was under way when the app went away: delivery is uncertain, and the coordinator is never
    // woken for it twice (it has no reconcile tool), so it counts as handed over.
    for (const record of this.core.all()) {
      if (record.report.state !== "dispatching" || record.owner) continue;
      try { this.core.reconcile({ task_id: record.id, run: record.run, action: "acknowledge" }); } catch { /* not the coordinator's to settle */ }
    }
  }

  /** The core's item, as the bot reads it today. */
  private sink(item: CodexItem) {
    if (item.kind === "usage") {
      this.workerCost += item.totalCost;
      item = { ...item, totalCost: this.workerCost };
    } else if ((item.kind === "toolUse" && item.parent === null) || item.kind === "subagentStarted") {
      // A run's opening items name its type by engine; the Maintainer's editor has its own (an editor, not a Claude worker).
      const editor = this.core.get(item.id)?.adapter === "component-editor";
      if (item.kind === "toolUse" && editor) item = { ...item, input: { ...item.input, subagent_type: EDITOR_TYPE } };
      if (item.kind === "subagentStarted") item = { ...item, ...(editor ? { type: EDITOR_TYPE } : {}), execution: { ...item.execution, ownerSessionId: item.execution?.ownerSessionId || null } as SubagentExecution };
    }
    this.out.push(this.item(item));
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

  answer(requestId: string, allow: boolean, why?: string): CodexOutput[] {
    // A worker's approval (worker:<task>:<run>:<its own id>): the core's table, then its adapter.
    if (requestId.startsWith("worker:")) {
      if (!this.stopped) this.core.answer(requestId, allow, {}, why);
      return this.take();
    }
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
    const out = [...this.restartPending.keys()].map((id) => this.item({ kind: "subagentEnded", id, status: "interrupted", summary: INTERRUPTED_REPORT.quit }));
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
    // Metadata only; routing and permission decisions below remain authoritative. (Workers' threads: their adapter's.)
    if (method && typeof params.threadId === "string" && params.threadId === this.threadId) {
      const suppliedTurn = params.turnId ?? (method === "turn/started" ? params.turn?.id : null);
      if ((!this.turn?.id || !suppliedTurn || this.turn.id === suppliedTurn) && (this.turn || method === "thread/tokenUsage/updated")) this.usageMeter.observe(method, params);
    }
    if (method && value.id !== undefined) return [...this.serverRequest(method, value.id, params), ...this.take()];
    if (method) {
      // A worker's thread: its adapter turns it into the core's events.
      if (this.threads.receive(method, params)) return [...this.take(), ...this.pendingChanged()];
      const out=this.notification(method, params);
      out.push(...this.requests(method, params));
      if(method === "thread/tokenUsage/updated" && params.threadId === this.threadId) {
        const snapshot=this.usageMeter.snapshot(params.threadId);
        if(snapshot && (!params.turnId || params.turnId===snapshot.turnId)) out.push(this.item({kind:"measurement",measurement:{...snapshot,workerId:null,run:null,parentThreadId:null}}));
      }
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
      case "initialize":
        if (error) return [{ kind: "failed", message: message(error) }];
        return [{ kind: "write", value: { jsonrpc: "2.0", method: "initialized" } }, this.startThread()];
      case "thread": {
        const thread = result?.thread?.id;
        if (error || typeof thread !== "string") return [{ kind: "failed", message: message(error) }];
        if(this.config.strictResume && thread!==this.config.resumeThread)return [{kind:"failed",message:"Restart resume returned a different thread. No prompt was sent."}];
        if (!this.config.resumeThread) this.usageMeter.fresh(thread);
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
    if (this.threadId) { this.usageMeter.begin(this.threadId, id); if (this.report) this.usageMeter.coordination(this.threadId); }
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
    const measured = this.threadId && current.id ? this.usageMeter.finish(this.threadId, current.id) : null;
    if (totalTokens(used) > 0 || measured) out.push(this.item({ kind: "usage", totalCost: 0, tokens: used,
      ...(measured ? { measurement: { ...measured, workerId: null, run: null, parentThreadId: null } } : {}) }));
    const gap = this.usageMeter.takeMissing();
    if (gap) out.push(this.item({ kind: "measurement", measurement: { ...gap, workerId: null, run: null, parentThreadId: null } }));
    const final = current.said.findLast((said) => said.phase !== "commentary")?.text.trim() ?? "";
    switch (finished.status) {
      case "interrupted":
        // Stopped by the app (`interrupt`): an error result the bot does not show.
        out.push(this.result(false, monitor ? `Monitor continuation was interrupted: ${json(monitorPayload(monitor))}`
          : evidence ? handbackFallback(evidence, "The summary turn was interrupted.") : current.interruptAsked ? "" : "Codex stopped this turn."));
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
   * A report turn ended with no decision on its report. Completed: shown once more (then unresolved, the core's rule).
   * Cut short (interrupted, failed, no final answer): its evidence went to the chat instead, and, as the coordinator
   * has no reconcile tool, the report counts as handed over (never shown twice).
   */
  private settleReport(shown: { id: string; run: number } | null, completed: boolean): CodexOutput[] {
    if (!shown) return [];
    this.settling = true;
    try {
      this.core.finishReport(shown.id, shown.run, completed);
      if (!completed && this.core.get(shown.id)?.report.state === "dispatching") this.core.reconcile({ task_id: shown.id, run: shown.run, action: "acknowledge" });
    } catch { /* settled meanwhile */ } finally { this.settling = false; }
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

  private result(ok: boolean, text: string): CodexOutput {
    return this.item({ kind: "result", ok, text: ok ? text : "", error: ok ? "" : text, subtype: ok ? "success" : "error" });
  }

  // ------------------------------------------------------------------------------------------
  // App-managed workers

  /** For codex-threads/<session>.workers.json: follow-ups work after the app-server is recreated. */
  get workerRecords(): WorkerRecord[] {
    // A restart snapshot's own keys are not the journal's.
    return this.journal.map(({ restartSafe: _safe, restartTurn: _turn, ...record }) => record);
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
    if (!this.config.routinesFile) return { payload: { error: "Routine storage is unavailable for this session. Open this bot in Botling and retry; do not write cron or schedule state as a workaround." }, success: false };
    try {
      return { payload: new ScheduledRoutineStore(this.config.routinesFile).perform(args), success: true };
    } catch (error) {
      return { payload: { error: error instanceof RoutineError ? error.message : `Routine storage failed: ${(error as Error).message}` }, success: false };
    }
  }

  /**
   * Execution and queued callbacks in this live runtime, for the completion judge (`completionWorkerDependencies`);
   * persisted flags and cards cannot establish liveness.
   */
  get completionDependencies(): WorkerDependency[] {
    if (this.stopped) return [];
    // The core's (its own workers: runs under way and reports waiting), less the report shown right now.
    const workers = this.core.completionDependencies.filter((dependency) => {
      const state = this.core.get(dependency.id)?.report.state;
      return state !== "dispatching" && state !== "unresolved";
    });
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
      // The core makes the worker and starts its run now (its adapters are synchronous); the receipt goes first.
      this.nextTask = task;
      void this.core.handoff(args.role === "component-editor" ? "component-editor" : "codex-thread", { instructions, name, ...(isolatedGit ? { isolatedGit } : {}) }).catch(() => undefined);
      this.nextTask = null;
      out.push(...this.take());
      response = reply({ task_id: task, status: "accepted", isolated_git_approval: isolatedGit && this.config.bypassPermissions ? "validated" : "manual", message: "This task is accepted and owned by its worker. Continue any other independent, authorized handoffs and required report decisions in the current dispatch phase, then finish the turn. app_task_result will arrive when this worker finishes." }, true);
    } else if (tool === "app_send_message" && typeof args.task_id === "string" && typeof args.message === "string" && args.message && this.core.get(args.task_id)) {
      // Into its turn at work, else its next run (a report the coordinator was not shown yet is dropped, as before).
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

  /** A restart check came back: the worker's next run continues (or adopts) its original one. */
  private restartRun(id: string, words: string): CodexOutput[] {
    const sent = syncResult(this.core.sendToWorker(id, words), { ok: false, reason: "Restart recovery could not resume this worker." });
    const out = this.take();
    if (!sent.ok) out.push(this.item({ kind: "subagentEnded", id, status: "interrupted", summary: `Restart recovery could not resume this worker: ${sent.reason}` }));
    return out;
  }

  /** CodexHead read the editor's transcript after a restart (`recoverEditor` output). */
  recoverEditor(task: string, run: number, outcome: ClaudeRestartOutcome): CodexOutput[] {
    const record = this.restartPending.get(task);
    this.restartPending.delete(task);
    const worker = this.core.get(task);
    if (!worker || !record || worker.run !== run || worker.status !== "interrupted" || this.stopped) return this.pendingChanged();
    if (outcome.state === "blocked") return [this.item({ kind: "subagentEnded", id: task, status: "interrupted", summary: outcome.reason }), ...this.pendingChanged()];
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
      out.push(this.item({ kind: "subagentEnded", id, status: "stopped", summary: STOPPED_REPORT }));
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

/** The reply: the last message that is not commentary (the final answer); else the last one. */
export function reply(said: { text: string; phase: string | null }[]): string {
  return (said.findLast((s) => s.phase !== "commentary") ?? said.at(-1))?.text ?? "";
}

// ---------------------------------------------------------------------------------------------
// Which Codex thread each bot session is (`CodexThreads`): codex names its threads itself, while a
// bot names its session (a UUID) before it starts. Under <core>/codex-threads/, as 1.x.

export class CodexThreads {
  constructor(readonly folder: string) {}

  private file(session: string, suffix = "") {
    return join(this.folder, session.toLowerCase() + suffix);
  }

  thread(session: string): string | null {
    try {
      const text = readFileSync(this.file(session), "utf8").trim();
      return text || null;
    } catch {
      return null;
    }
  }

  save(thread: string, session: string) {
    mkdirSync(this.folder, { recursive: true });
    const old = this.thread(session);
    if (old && old !== thread) {
      // The old transcript stays findable when a tool change needed a new coordinator.
      const lineage = this.file(session, ".previous-threads");
      const known = existsSync(lineage) ? readFileSync(lineage, "utf8") : "";
      if (!known.split("\n").includes(old)) writeFileAtomic(lineage, `${known}${old}\n`);
    }
    writeFileAtomic(this.file(session), thread);
  }

  isManaged(session: string, thread: string): boolean {
    try {
      const stamp = JSON.parse(readFileSync(this.file(session, ".managed"), "utf8"));
      return stamp?.thread === thread && stamp?.tools === MANAGED_TOOL_SIGNATURE;
    } catch {
      return false;
    }
  }

  markManaged(thread: string, session: string) {
    mkdirSync(this.folder, { recursive: true });
    writeFileAtomic(this.file(session, ".managed"), JSON.stringify({ thread, tools: MANAGED_TOOL_SIGNATURE }));
  }

  workers(session: string): WorkerRecord[] {
    try {
      const value = JSON.parse(readFileSync(this.file(session, ".workers.json"), "utf8"));
      return Array.isArray(value) ? value.filter((row) => row && typeof row.id === "string" && typeof row.name === "string" && typeof row.instructions === "string" && typeof row.run === "number") : [];
    } catch {
      return [];
    }
  }

  saveWorkers(records: WorkerRecord[], session: string) {
    mkdirSync(this.folder, { recursive: true });
    writeFileAtomic(this.file(session, ".workers.json"), JSON.stringify(records));
  }
}

// ---------------------------------------------------------------------------------------------
// The process

export interface CodexHeadConfig {
  restartWorkers?: WorkerRecord[];
  strictResume?: boolean;
  restartTurn?: string;
  /** `codex`, or the fake app-server's interpreter for tests. */
  command: string;
  prefixArgs?: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /** The bot's session (a UUID): the thread it names is kept in `threads`. */
  sessionId: string;
  resume: boolean;
  threads: CodexThreads;
  instructions: string;
  workerInstructions: string | null;
  model?: string | null;
  workerModel?: string | null;
  effort?: string | null;
  workerEffort?: string | null;
  workerFast?: boolean | null;
  /** The bot's scheduled-routines.json, for `app_routines` (null: none). */
  routinesFile?: string | null;
  /** Codex's own reviewer answers escalations (default on). */
  autoMode?: boolean;
  /** Explicit opt-in: no approval prompts and no Codex sandbox. */
  bypassPermissions?: boolean;
  /** More folders it may write (its `--add-dir` folders; 1.x's `writableRoots`). */
  writableRoots?: string[];
  componentEditor?: ComponentEditorRoute | null;
  /** Register the separate Claude process with the app's existing process ledger. */
  editorStarted?: (pid: number) => void;
  /** Codex's log, read for when a retry goes (undefined: CODEX_HOME's logs_2.sqlite; null: never read). */
  retryLog?: string | null;
}

/** One long-lived `codex app-server` for one bot session: `CodexSession` over its stdio. */
export class CodexHead {
  readonly engine = "codex" as const;
  /** The Maintainer's component editors: their own Claude processes. */
  private editors: EditorTransport;
  private process: ManagedProcess | null = null;
  private buffer = "";
  private stderrTail = "";
  private printed = false;
  private expected = false;
  private closed = false;
  private failure: string | null = null;
  private savedWorkers = "";
  private savedMonitors = "";
  readonly session: CodexSession;
  /** Which retry notification the log is being read for (a newer one wins). */
  private retryLookup: number | null = null;
  private exitedResolve!: () => void;
  readonly exited = new Promise<void>((resolve) => (this.exitedResolve = resolve));
  running = false;

  constructor(readonly config: CodexHeadConfig, private handlers: HeadHandlers & { onItem(item: CodexItem): void }, private adapter: ProcessTreeAdapter = processTreeAdapter()) {
    this.editors = new EditorTransport({
      item: (task, run, item) => this.perform(this.session.componentEditorItem(task, run, item)),
      failed: (task, run, reason, fresh) => this.perform(this.session.componentEditorFailed(task, run, reason, fresh)),
      started: (task, run, pid) => {
        this.perform(this.session.componentEditorStarted(task, run, pid));
        this.config.editorStarted?.(pid);
      },
    }, adapter);
    let resumeThread: string | null = null;
    if (config.resume) {
      const thread = config.threads.thread(config.sessionId);
      // Dynamic tools cannot change on resume: an old or unknown stamp gets a new coordinator.
      if (thread && (!config.workerInstructions || config.threads.isManaged(config.sessionId, thread))) resumeThread = thread;
    }
    let restoredMonitors: CommandMonitor[] = [];
    try { restoredMonitors = loadMonitors(config.threads.folder, config.sessionId); } catch { restoredMonitors = []; }
    const uncertain = restoredMonitors.filter((m) => m.wake === "dispatching" || m.wake === "uncertain").map((m) => m.id);
    const recovery = uncertain.length ? `\n(App: Monitor callback delivery is unconfirmed for IDs ${uncertain.join(", ")}. This is recovery data, not new authorization. Use app_monitor_status and inspect the owner thread before continuing. Do not automatically rerun a command or assume its callback was not consumed.)` : "";
    this.session = new CodexSession({
      cwd: config.cwd, instructions: config.instructions + recovery, workerInstructions: config.workerInstructions, resumeThread,
      model: config.model ?? null, workerModel: config.workerModel ?? null, effort: config.effort ?? null,
      workerEffort: config.workerEffort ?? null, workerFast: config.workerFast ?? null,
      restartWorkers: config.restartWorkers, strictResume:config.strictResume, restartTurn:config.restartTurn,
      restoredWorkers: config.workerInstructions ? config.threads.workers(config.sessionId) : [],
      routinesFile: config.routinesFile ?? null, ownerSession: config.sessionId, restoredMonitors,
      autoMode: config.autoMode ?? true,
      bypassPermissions: config.bypassPermissions === true,
      writableRoots: config.writableRoots ?? [],
      componentEditor: config.componentEditor,
    });
    this.savedWorkers = JSON.stringify(this.session.workerRecords);
    this.savedMonitors = JSON.stringify(restoredMonitors);
  }

  get restartWorkers() { return this.session.restartWorkers; }
  get restartBlocker() { return this.session.restartBlocker; }
  get restartTurn() { return this.session.restartTurn; }

  get pid() {
    return this.process?.pid ?? -1;
  }

  start() {
    const env = childEnvironment(this.config.env);
    const managed = this.adapter.spawn(resolveExecutable(this.config.command, env), [...(this.config.prefixArgs ?? []), "app-server"], { cwd: this.config.cwd, env });
    this.process = managed;
    this.running = true;
    const child = managed.child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.read(chunk));
    child.stderr.on("data", (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-8_000); });
    child.stdin.on("error", () => { /* EPIPE once it exited */ });
    let reported = false;
    const report = (code: number | null, signal: NodeJS.Signals | null, extra = "") => {
      if (reported) return;
      reported = true;
      this.running = false;
      this.closed = true;
      if (this.buffer.trim()) this.line(this.buffer.trim());
      this.buffer = "";
      this.stopEditors();
      this.exitedResolve();
      const why = [this.failure, this.stderrTail.trim(), extra].filter(Boolean).join("\n");
      // Its workers' turns went with it: their runs end (failed), and their reports wait in the journal for the next head.
      this.perform(this.session.exited(why));
      this.handlers.onExit({ code: this.failure ? 1 : code, signal, stderr: why, expected: this.expected, silent: !this.printed });
    };
    child.once("error", (error) => report(null, null, cliStartError("codex", this.config.command, error)));
    child.once("close", (code, signal) => report(code, signal));
    this.perform(this.session.start());
  }

  /**
   * When the retry goes, from Codex's log (read-only, codex-retry-log.ts): a few tries over about
   * 25 s, as codex 0.163.0 writes its log rows in batches (seen about 10 s late). Found: the same
   * item again with `retryAt` (the bot takes it only while that attempt is still the one it shows).
   */
  private findRetryTime(item: Extract<CodexItem, { kind: "apiRetry" }>) {
    const file = this.config.retryLog === undefined ? codexLogsFile(childEnvironment(this.config.env)) : this.config.retryLog;
    if (!file) return;
    const since = Date.now() - 2_000;
    const lookup = this.retryLookup = (this.retryLookup ?? 0) + 1;
    const look = (waits: number[]) => {
      const [wait, ...later] = waits;
      if (wait === undefined) return;
      setTimeout(() => {
        if (this.closed || this.retryLookup !== lookup) return;
        void codexRetryAt({ file, thread: item.thread, attempt: item.attempt, since }).then((at) => {
          if (this.closed || this.retryLookup !== lookup) return;
          if (at === null) return look(later);
          this.handlers.onItem({ ...item, retryAt: at });
        });
      }, wait).unref?.();
    };
    look([500, 3_000, 4_000, 4_000, 4_000, 8_000]);
  }

  private read(chunk: string) {
    this.printed = true;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.line(line);
    }
  }

  private line(line: string) {
    this.perform(this.session.receive(line));
  }

  /** Does what the session says, in order (writes keep their order). Worker records are saved first. */
  private perform(outputs: CodexOutput[]) {
    const records = this.session.workerRecords;
    const text = JSON.stringify(records);
    if (text !== this.savedWorkers && this.config.workerInstructions) {
      this.config.threads.saveWorkers(records, this.config.sessionId);
      this.savedWorkers = text;
    }
    // A monitor's state is written before what it leads to is done (its command, its wake).
    const monitors = this.session.monitorRecords;
    const monitorText = JSON.stringify(monitors);
    const monitorsChanged = monitorText !== this.savedMonitors;
    if (monitorsChanged) {
      saveMonitors(this.config.threads.folder, this.config.sessionId, monitors);
      this.savedMonitors = monitorText;
    }
    for (const output of outputs) {
      switch (output.kind) {
        case "write":
          if (!this.closed && this.process) this.process.child.stdin.write(`${JSON.stringify(output.value)}\n`);
          break;
        case "item":
          this.handlers.onItem(output.item);
          if (output.item.kind === "apiRetry") this.findRetryTime(output.item);
          break;
        case "thread":
          this.config.threads.save(output.id, this.config.sessionId);
          if (this.config.workerInstructions) this.config.threads.markManaged(output.id, this.config.sessionId);
          this.handlers.onItem({ kind: "init", sessionId: this.config.sessionId });
          break;
        case "recoverEditor": {
          const launch=this.config.componentEditor?.launch;
          const outcome=launch?inspectClaudeRestart({cwd:launch.cwd,configDir:claudeConfigFolder({...process.env,...launch.env}),sessionId:output.session,checkpoint:output.checkpoint}):{state:'blocked' as const,reason:'Original component-editor definition is unavailable; no replacement was created.'};
          this.perform(this.session.recoverEditor(output.task,output.run,outcome));
          break;
        }
        case "componentEditor":
          this.performEditor(output.action);
          break;
        case "close":
          this.stopEditors();
          this.closeInput();
          break;
        case "failed":
          this.failure = output.message;
          this.stopEditors();
          this.closeInput();
          void this.process?.terminate({ graceMs: 1_000 });
          break;
      }
    }
    if (monitorsChanged) for (const record of monitors) this.handlers.onItem({ kind: "monitorState", record });
  }

  private stopEditors() {
    this.editors.stopAll();
  }

  private performEditor(action: ComponentEditorAction) {
    this.editors.perform(action);
  }

  private closeInput() {
    if (this.closed || !this.process) return;
    this.closed = true;
    this.process.child.stdin.end();
  }

  send(text: string, _uuid?: string, images: string[] = []) {
    this.perform(this.session.send(text, images));
  }

  canApplySettings(target: HotSettings): boolean {
    return !this.closed && this.running && this.session.canApplySettings(target);
  }

  /** Its model and effort from its next turn on, in this same thread (`CodexSession.applySettings`). */
  async applySettings(target: HotSettings): Promise<boolean> {
    if (this.closed || !this.running || !this.session.applySettings(target)) return false;
    if ("model" in target) this.config.model = this.session.config.model;
    if ("effort" in target) this.config.effort = this.session.config.effort;
    return true;
  }

  /** Words for the turn under way (`turn/steer`); false when it has none. */
  steer(text: string): boolean {
    const { joined, out } = this.session.steer(text);
    this.perform(out);
    return joined;
  }

  answer(requestId: string, allow: boolean, _input: Record<string, unknown>, message?: string) {
    this.perform(this.session.answer(requestId, allow, allow ? undefined : message));
  }

  /** Forward only the rules the app has already approved to its existing Claude children. */
  allow(rules: string[]) {
    const launch = this.config.componentEditor?.launch;
    if (!launch) return;
    launch.allowRules = [...rules];
    this.editors.allow(rules);
  }

  interrupt(): string {
    this.perform(this.session.interrupt());
    return "";
  }

  /** Workers at work now. */
  get workers(): string[] {
    return this.session.runningWorkers;
  }

  /** The live worker and monitor snapshot the completion judge reads. */
  get completionDependencies(): WorkerDependency[] {
    return this.session.completionDependencies;
  }

  cancelWorkers(ids?: Set<string>) {
    this.perform(this.session.cancelWorkers(ids));
  }

  // WorkerHost (workers.ts): a worker is a thread of this app-server; the coordinator's Stop leaves it be.
  private workerHostImpl?: WorkerHost;
  private get workerHost(): WorkerHost { return this.workerHostImpl ??= codexWorkerHost(this.session, (out) => this.perform(out), () => !this.closed && this.running); }
  readonly workerHostKind = "codex-thread" as const;
  readonly steersRunning = true;
  listWorkers(): WorkerInfo[] { return this.workerHost.listWorkers(); }
  sendToWorker(id: string, text: string): WorkerSendResult { return this.workerHost.sendToWorker(id, text) as WorkerSendResult; }
  stopWorker(id: string): Promise<boolean> { return this.workerHost.stopWorker(id); }
  setWorkerOwner(id: string, owner: WorkerOwner | null): WorkerOwnerResult { return this.workerHost.setWorkerOwner(id, owner); }

  /** The sub-bot hand-off's wrap-up request to one worker at work (false: it is not at work, nothing was sent). */
  messageRunningWorker(id: string, text: string): boolean {
    if (!this.session.runningWorkers.includes(id)) return false;
    this.perform(this.session.wrapUpWorker(id, text));
    return true;
  }

  /** Stdin closes once the turn under way and its workers' reports are done (going to sleep). */
  finish() {
    this.expected = true;
    this.perform(this.session.finish());
  }

  async terminate(graceMs = 1_500): Promise<TerminateResult> {
    this.expected = true;
    this.perform(this.session.stop());
    this.stopEditors();
    this.closeInput();
    const results = await Promise.all([...this.editors.ending, ...(this.process ? [this.process.terminate({ graceMs })] : [])]);
    return { killed: [...new Set(results.flatMap(result => result.killed))], forced: results.some(result => result.forced) };
  }
}

/** Codex's workers as a WorkerHost (workers.ts): `perform` carries the session's outputs to the app-server. */
export function codexWorkerHost(session: CodexSession, perform: (out: CodexOutput[]) => void, alive: () => boolean = () => true): WorkerHost {
  return {
    workerHostKind: "codex-thread",
    steersRunning: true,
    listWorkers: () => session.workerInfos,
    sendToWorker(id, text) {
      if (!alive()) return { ok: false, reason: "Its Codex head is not running; the worker went with its process." };
      const { result, out } = session.sendToWorker(id, text);
      perform(out);
      return result;
    },
    async stopWorker(id) {
      if (!session.runningWorkers.includes(id)) return false;
      perform(session.cancelWorkers(new Set([id])));
      return true;
    },
    setWorkerOwner(id, owner) {
      const set = session.setWorkerOwner(id, owner);
      if (!set.ok) return set;
      perform(set.out);
      return { ok: true };
    },
  };
}

export type { HeadExit };
