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
//   writes only in its folder (`workspace-write`). In auto mode (default) Codex's own reviewer
//   (`auto_review`) answers escalations for the head and its workers; its refusals become a card, and
//   an Allow lets that call through with the next turn asking the app ("user") once. Without auto
//   mode the reviewer is the user; the app accepts only validated, explicitly owned isolated-worker
//   Git requests automatically, one request at a time.
// - The head is a coordinator: shell and native subagents are off, and it hands execution to
//   app-managed workers with the app's dynamic tools (app_handoff, app_send_message,
//   app_task_checkpoint). Each worker is an independent Codex thread in the same app-server; its
//   record is kept in codex-threads/<session>.workers.json; when its turn ends, the app starts a
//   report turn on the coordinator with an `app_task_result` tool output.
// - The reply is the turn's last agent message that is not commentary; commentary is a step.
// - `interrupt` stops the turn (`turn/interrupt`).
//
// - `app_routines` changes this bot's routines (routines.ts's ScheduledRoutineStore, the same file the
//   app's clock reads); `app_monitor_*` run one command after an Allow once card and wake the
//   coordinator when it ends (`app_monitor_result`, monitors.ts), never replaying one after a restart.
//
// Not ported (2.0 gaps, see desktop/README.md): the component-editor role,
// Codex's own native subagents (off in a coordinator anyway),
// images in messages.
import { approveIsolatedGit, isolatedGitOwnership, type IsolatedGitOwnership } from "./isolated-git";
import type { WorkerDependency } from "../promise-check";
import type { SubagentExecution } from "../subagents";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../durable/atomic";
import { processTreeAdapter, type ManagedProcess, type ProcessTreeAdapter, type TerminateResult } from "../process/tree";
import { childEnvironment } from "./runner";
import { cliStartError, resolveExecutable } from "../process/executable";
import { activity, type StreamItem } from "./stream";
import type { HeadExit, HeadHandlers } from "./head";
import tools from "./codex-tools.json";
import { RoutineError, ScheduledRoutineStore } from "../routines";
import { bounded, isActive as monitorActive, loadMonitors, MONITOR_OUTPUT_LIMIT, monitorPayload, monitorSummary, reconcile, saveMonitors, type CommandMonitor } from "./monitors";
import { toSwiftDate } from "../store/records";
import { codexRateLimits, codexTokens, isEmptyLimits, minusTokens, noTokens, totalTokens, type TokenUsage } from "../usage";

/** What a Codex head gives the bot besides claude's items. */
export type CodexItem =
  | StreamItem
  /** Words between tool calls (Codex's commentary): a step of the turn, not the reply. */
  | { kind: "stepText"; text: string }
  /** The app started a turn on the coordinator by itself (a worker's report). */
  | { kind: "backgroundTurn"; taskId: string | null }
  /** Workers at work or reports waiting: the bot must not sleep. */
  | { kind: "managedPending"; pending: boolean }
  /** A monitored command ended: its step (from an earlier turn) is done. */
  | { kind: "monitorEnded"; id: string; output: string; failed: boolean }
  /** `app_routines` changed the bot's routines. */
  | { kind: "routinesChanged" };

export type CodexOutput =
  | { kind: "write"; value: Record<string, unknown> }
  | { kind: "item"; item: CodexItem }
  | { kind: "thread"; id: string }
  | { kind: "close" }
  | { kind: "failed"; message: string };

/** A worker as codex-threads/<session>.workers.json keeps it (`CodexManagedWorkerRecord`, 1.x's keys). */
export interface WorkerRecord {
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
  /** scheduled-routines.json for `app_routines` (null: none here). */
  routinesFile?: string | null;
  /** The bot session that owns its monitors. */
  ownerSession?: string;
  restoredMonitors?: CommandMonitor[];
  /** Auto mode (default on): Codex's own reviewer (`auto_review`) answers escalations; only its refusals become a card. */
  autoMode?: boolean;
}

type Call =
  | { kind: "initialize" | "thread" | "turn" | "interrupt" | "other" }
  | { kind: "coordinatorInstructions"; thread: string }
  | { kind: "workerInstructions"; task: string }
  | { kind: "steer"; input: Input }
  | { kind: "workerThread"; task: string }
  | { kind: "workerTurn"; task: string; run: number }
  | { kind: "workerSteer"; task: string; run: number; text: string }
  | { kind: "monitorCommand"; id: string };

interface Input { text: string; token: string; images?: string[] }
interface Turn { id: string | null; waitingSteers: Input[]; interruptAsked: boolean; interruptSent: boolean; said: { text: string; phase: string | null }[] }
interface Approval {
  rpcId: unknown;
  kind: "command" | "fileChange" | { permissions: Record<string, unknown> };
  thread: string;
  turn: string | null;
  worker?: { task: string; run: number };
}

interface Worker {
  runtime?: { engine: "codex"; reasoningEffort: string | null; serviceTier: string | null };
  id: string; name: string; instructions: string; ownershipInstructions?: string; role?: string; isolatedGit?: IsolatedGitOwnership;
  thread?: string; turnId: string | null; run: number; active: boolean; loaded: boolean; cancelled: boolean;
  messages: string[]; said: { text: string; phase: string | null }[]; completedTurns: Set<string>;
  /** After the user allowed a refused call: its next turn asks the app ("user"), the one after the reviewer again. */
  reviewerNext?: string;
  /** Its thread's tokens so far, and at the start of the run under way (Phase 5c). */
  tokens?: TokenUsage; tokensAtRunStart?: TokenUsage;
}

interface Result {
  task: string; name: string; thread?: string; turn?: string; run: number; status: string; report: string;
  reconciliationAttempt: number; reconciled: boolean;
}

const resultPayload = (result: Result) => ({
  task_id: result.task, name: result.name, thread_id: result.thread ?? null, turn_id: result.turn ?? null, run: result.run,
  status: result.status, report: result.report, completion_scope: "worker_turn", objective_status: "unverified",
  reconciliation_attempt: result.reconciliationAttempt,
});

/** Codex's coordinator: no shell, no native subagents, no web search (`coordinatorConfig`). */
const COORDINATOR_CONFIG = { "features.multi_agent": false, "agents.enabled": false, "features.shell_tool": false, web_search: "disabled" };
export const MANAGED_TOOLS = tools as Record<string, unknown>[];
/** Changing the tools needs a new coordinator thread (tools are fixed when a thread starts). */
export const MANAGED_TOOL_SIGNATURE = JSON.stringify(MANAGED_TOOLS);
// All bot sessions in this app share destination claims. A second session must never adopt
// another worker's grant just because its branch/worktree names happen to match.
const isolatedGitOwners = new Map<string, string>();

/** The shell a monitored command runs in (1.x: zsh on macOS). */
const shell = (command: string): string[] => (process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : process.platform === "darwin" ? ["/bin/zsh", "-c", command] : ["/bin/sh", "-c", command]);

/** `CodexSession.handbackFallback`: worker evidence kept, fenced so its tags are not the app's. */
export function handbackFallback(result: Pick<Result, "name" | "task" | "status" | "report">, reason: string): string {
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

/** What it ran, without the shell wrapping it when Codex parsed it (`CodexSession.command`). */
export function codexCommand(item: Record<string, any>): string {
  const actions = (Array.isArray(item.commandActions) ? item.commandActions : []).map((a: any) => a?.command).filter((c: unknown): c is string => typeof c === "string");
  if (actions.length === 1) return actions[0]!;
  return typeof item.command === "string" ? item.command : actions.join(" && ");
}

export class CodexSession {
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
  private reviews = new Map<string, { command: string; task: string | null }>();
  private finishing = false;
  private stopped = false;
  private workers = new Map<string, Worker>();
  private results: Result[] = [];
  private active: Result | null = null;
  private toolReplies = new Map<string, Record<string, unknown>>();
  private pending = false;
  private monitors = new Map<string, CommandMonitor>();
  private activeMonitor: string | null = null;

  constructor(readonly config: CodexConfig) {
    for (const record of config.restoredMonitors ?? []) {
      if (config.ownerSession && record.owner.toLowerCase() !== config.ownerSession.toLowerCase()) continue;
      this.monitors.set(record.id, reconcile(record));
    }
    for (const record of config.restoredWorkers) {
      this.workers.set(record.id, {
        id: record.id, name: record.name, instructions: record.instructions, ownershipInstructions: record.ownershipInstructions, role: record.role, isolatedGit: record.isolatedGit,
        thread: record.thread, turnId: null, run: record.run, active: false, loaded: false, cancelled: false, messages: [], said: [], completedTurns: new Set(),
      });
      if (record.reportPending && record.report !== undefined && record.status) {
        this.results.push({ task: record.id, name: record.name, thread: record.thread, turn: record.turn, run: record.run, status: record.status, report: record.report, reconciliationAttempt: 0, reconciled: false });
      } else if (record.wasActive) {
        this.results.push({ task: record.id, name: record.name, thread: record.thread, run: record.run, status: "interrupted", report: "The app stopped before this worker completed. Send a message to the same task_id to resume its session.", reconciliationAttempt: 0, reconciled: false });
      }
    }
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
    if (!this.threadId || this.turn) {
      this.inbox.push(input);
      return [];
    }
    return this.startTurn(input);
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
    if (!allow && why) {
      const worker = approval.worker ? this.workers.get(approval.worker.task) : undefined;
      if (worker) out.push(...this.messageWorker(worker.id, `(App: ${why})`));
      else if (this.turn?.id) out.push(this.steerCall({ text: `(App: ${why})`, token: randomUUID() }, this.turn.id));
    }
    return out;
  }

  /** Stdin closes once the turn under way (and anything waiting) is done. */
  finish(): CodexOutput[] {
    this.finishing = true;
    return !this.turn && !this.inbox.length && !this.hasManagedWork ? [{ kind: "close" }] : [];
  }

  /** The app stops: workers are cancelled (an interrupt of the coordinator alone leaves them). */
  stop(): CodexOutput[] {
    const monitors = this.cancelMonitors();
    this.stopped = true;
    this.inbox = [];
    return [...this.cancelWorkers(), ...this.closeApprovals(() => true, true), ...monitors];
  }

  // ------------------------------------------------------------------------------------------
  // From codex

  receive(line: string): CodexOutput[] {
    let value: any;
    try { value = JSON.parse(line); } catch { return []; }
    if (!value || typeof value !== "object") return [];
    const method = typeof value.method === "string" ? value.method : null;
    const params = value.params && typeof value.params === "object" ? value.params : {};
    if (method && value.id !== undefined) return this.serverRequest(method, value.id, params);
    if (method) return this.notification(method, params);
    if (typeof value.id === "number") {
      const call = this.calls.get(value.id);
      if (!call) return [];
      this.calls.delete(value.id);
      return this.response(call, value.result ?? null, value.error ?? null);
    }
    return [];
  }

  private response(call: Call, result: any, error: any): CodexOutput[] {
    switch (call.kind) {
      case "initialize":
        if (error) return [{ kind: "failed", message: message(error) }];
        return [{ kind: "write", value: { jsonrpc: "2.0", method: "initialized" } }, this.startThread()];
      case "thread": {
        const thread = result?.thread?.id;
        if (error || typeof thread !== "string") return [{ kind: "failed", message: message(error) }];
        if (this.config.resumeThread && this.managed) return [this.refreshInstructions(this.config.instructions, thread, { kind: "coordinatorInstructions", thread })];
        return this.coordinatorReady(thread);
      }
      case "coordinatorInstructions":
        if (error) return [{ kind: "failed", message: `Could not refresh coordinator instructions: ${message(error)}` }];
        return this.coordinatorReady(call.thread);
      case "workerInstructions": {
        if (error) return this.failWorker(call.task, `Could not refresh worker instructions: ${message(error)}`);
        const worker = this.workers.get(call.task);
        if (!worker?.active || worker.cancelled || this.stopped) return [];
        worker.loaded = true;
        return this.startWorkerTurn(call.task, worker.instructions);
      }
      case "monitorCommand":
        return this.completeMonitor(call.id, result, error);
      case "turn": {
        const monitor = this.activeMonitor ? this.monitors.get(this.activeMonitor) : undefined;
        if (monitor) monitor.wake = error ? "uncertain" : "delivered";
        if (error) {
          // The turn never started: its message gets an error reply, and the next goes.
          this.turn = null;
          const text = monitor ? `Monitor callback could not start: ${json(monitorPayload(monitor))}\n${message(error)}`
            : this.active ? handbackFallback(this.active, message(error)) : message(error);
          this.active = null;
          this.activeMonitor = null;
          return [this.result(false, text), ...this.next()];
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
      case "workerThread":
        return this.workerThreadReady(call.task, result, error);
      case "workerTurn": {
        const worker = this.workers.get(call.task);
        if (!worker || worker.run !== call.run || !worker.active || worker.cancelled || this.stopped) return [];
        if (error) return this.failWorker(call.task, `Could not start worker turn: ${message(error)}`);
        const id = result?.turn?.id;
        if (typeof id !== "string") return [];
        const effort = this.config.workerEffort ?? this.config.effort;
        // The successful turn/start accepted this explicit override. Otherwise keep thread settings.
        const metadata: CodexOutput[] = [];
        if (effort) {
          worker.runtime = { engine: "codex", reasoningEffort: effort, serviceTier: worker.runtime?.serviceTier ?? null };
          metadata.push(this.item({ kind: "subagentRuntime", id: call.task, runtime: worker.runtime }));
        }
        return [...metadata, ...this.learnWorkerTurn(call.task, id)];
      }
      case "workerSteer": {
        const worker = this.workers.get(call.task);
        if (!error || !worker || worker.run !== call.run || worker.cancelled || this.stopped) return [];
        if (worker.active) { worker.messages.push(call.text); return []; }
        return this.messageWorker(call.task, call.text);
      }
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
    const thread = typeof params.threadId === "string" ? params.threadId : null;
    if (thread && this.threadId && thread !== this.threadId) {
      const worker = [...this.workers.values()].find((w) => w.thread === thread);
      return worker ? this.workerLine(method, params, worker) : [];
    }
    switch (method) {
      case "item/autoApprovalReview/completed":
        return this.reviewed(params, null);
      case "turn/started": {
        const id = params.turn?.id;
        return typeof id === "string" ? this.learnTurn(id) : [];
      }
      case "item/started": {
        const step = this.started(params.item);
        return step ? [this.item(step)] : [];
      }
      case "item/completed":
        return this.completed(params.item).map((item) => this.item(item));
      case "serverRequest/resolved": {
        return this.resolveApproval(params);
      }
      case "turn/completed":
        return params.turn ? this.turnCompleted(params.turn) : [];
      case "thread/tokenUsage/updated":
        if (params.tokenUsage?.total && typeof params.tokenUsage.total === "object") this.tokensTotal = codexTokens(params.tokenUsage.total);
        return [];
      default:
        return [];
    }
  }

  private serverRequest(method: string, rpcId: unknown, params: any): CodexOutput[] {
    if (method === "item/tool/call") return this.managedTool(rpcId, params);
    const reason = typeof params.reason === "string" && params.reason ? params.reason : "";
    switch (method) {
      case "item/commandExecution/requestApproval": {
        // A call the user allowed after the reviewer refused it (1.x `allowedCommands`).
        if (this.allowedCommands.size && (params.kind === undefined || params.kind === "command")
          && [params.command, codexCommand(params)].some((c) => typeof c === "string" && this.allowedCommands.has(c))) {
          return [{ kind: "write", value: { jsonrpc: "2.0", id: rpcId, result: { decision: "accept" } } }];
        }
        // Keep the automatic path independent of manual-card correlation: lifecycle handling
        // owns local permission.requestId; this immediate RPC answer preserves rpcId's type.
        const workerThread = typeof params.threadId === "string" ? params.threadId : null;
        const worker = workerThread && workerThread !== this.threadId ? [...this.workers.values()].find((w) => w.thread === workerThread) : undefined;
        const ownership = worker?.isolatedGit;
        const exclusive = ownership && ![...this.workers.values()].some((w) => w !== worker && w.isolatedGit
          && (w.isolatedGit.worktree === ownership.worktree || w.isolatedGit.branch === ownership.branch));
        if (!this.stopped && worker?.active && !worker.cancelled && worker.turnId && params.turnId === worker.turnId
          && !worker.completedTurns.has(worker.turnId)
          && (params.kind === undefined || params.kind === "command") // never stdin to a running process
          && params.environmentId === "local" && !params.networkApprovalContext
          && (!Array.isArray(params.availableDecisions) || params.availableDecisions.includes("accept"))
          && exclusive && isolatedGitOwners.get(ownership.worktree) === worker.id
          && approveIsolatedGit(ownership, this.config.cwd, params)) {
          // One request only: never acceptForSession / execpolicy amendments / wider permissions.
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

  private get reviewer(): string { return this.config.autoMode === false ? "user" : "auto_review"; }

  private nextReviewer(params: Record<string, unknown>) {
    if (!this.reviewerNext) return;
    params.approvalsReviewer = this.reviewerNext;
    this.reviewerNext = this.reviewerNext === "user" ? "auto_review" : null;
  }

  /** Codex's reviewer refused a call: a card with its reason (1.x `reviewed`). Allow lets it through next time. */
  private reviewed(params: any, worker: Worker | null): CodexOutput[] {
    const review = params.review;
    if (!review || review.status !== "denied") return [];
    const action = params.action && typeof params.action === "object" ? params.action : {};
    const command = typeof action.command === "string" ? action.command
      : Array.isArray(action.argv) ? action.argv.filter((a: unknown) => typeof a === "string").join(" ") : "";
    const what = command || (typeof action.type === "string" ? action.type : "a call");
    const risk = typeof review.riskLevel === "string" ? `[${review.riskLevel} risk] ` : "";
    const why = typeof review.rationale === "string" ? review.rationale : "";
    const requestId = `codex-review:${randomUUID()}`;
    this.reviews.set(requestId, { command, task: worker?.id ?? null });
    const summary = `${what}\n\nCodex's reviewer refused this: ${risk}${why}`.trim();
    return [this.item({ kind: "permission", requestId, tool: action.type === "applyPatch" ? "Edit" : "Bash", summary, input: {}, ...(worker ? { workerId: worker.id } : {}) })];
  }

  private answerReview(requestId: string, allow: boolean): CodexOutput[] {
    const review = this.reviews.get(requestId);
    if (!review) return [];
    this.reviews.delete(requestId);
    if (!allow || this.stopped) return [];
    if (review.command) this.allowedCommands.add(review.command);
    const worker = review.task ? this.workers.get(review.task) : undefined;
    // The next turn of the refused call's thread asks the app (which accepts the allowed call), once.
    if (this.config.autoMode !== false) { if (worker) worker.reviewerNext = "user"; else this.reviewerNext = "user"; }
    return [];
  }

  private approvalCurrent(approval: Approval): boolean {
    if (this.stopped) return false;
    if (approval.worker) {
      const worker = this.workers.get(approval.worker.task);
      return !!worker?.active && !worker.cancelled && worker.run === approval.worker.run
        && (!approval.turn || !worker.completedTurns.has(approval.turn))
        && worker.thread === approval.thread && (!worker.turnId || !approval.turn || worker.turnId === approval.turn);
    }
    return approval.thread === this.threadId && !!this.turn
      && (!approval.turn || !this.completedTurns.has(approval.turn))
      && !this.turn.interruptAsked && (!this.turn.id || !approval.turn || this.turn.id === approval.turn);
  }

  private askApproval(rpcId: unknown, kind: Approval["kind"], params: any, tool: string, summary: string): CodexOutput[] {
    const thread = typeof params.threadId === "string" ? params.threadId : "";
    const worker = [...this.workers.values()].find((candidate) => candidate.thread === thread);
    const turn = typeof params.turnId === "string" ? params.turnId : (worker ? worker.turnId : this.turn?.id ?? null);
    const approval: Approval = { rpcId, kind, thread, turn, ...(worker ? { worker: { task: worker.id, run: worker.run } } : {}) };
    if (!this.approvalCurrent(approval)) return [this.declineApproval(approval)];
    if ([...this.approvals.values()].some((pending) => pending.rpcId === rpcId && pending.thread === thread && pending.turn === turn)) return [];
    // UI decisions use a fresh local identity, never a reusable/string-coerced RPC id.
    const requestId = `codex-approval:${randomUUID()}`;
    this.approvals.set(requestId, approval);
    return [this.item({ kind: "permission", requestId, tool, summary, input: {}, ...(worker ? { workerId: worker.id } : {}) })];
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
      cwd: this.config.cwd, approvalPolicy: "on-request", approvalsReviewer: this.reviewer, sandbox: "workspace-write", developerInstructions: this.config.instructions,
    };
    if (this.managed) {
      params.environments = [];
      params.dynamicTools = MANAGED_TOOLS;
      params.config = COORDINATOR_CONFIG;
    }
    if (this.config.model) params.model = this.config.model;
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
    if (this.inbox.length) out.push(...this.startTurn(this.inbox.shift()!));
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
    if (this.config.effort) params.effort = this.config.effort;
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
    const handback = this.active;
    this.active = null;
    const monitor = this.activeMonitor ? this.monitors.get(this.activeMonitor) ?? null : null;
    this.activeMonitor = null;
    const out: CodexOutput[] = this.closeApprovals((approval) => !approval.worker && approval.thread === this.threadId
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
          : handback ? handbackFallback(handback, "The summary turn was interrupted.") : current.interruptAsked ? "" : "Codex stopped this turn."));
        break;
      case "failed": {
        const reason = typeof finished.error?.message === "string" ? finished.error.message : "Codex failed.";
        out.push(this.result(false, monitor ? `Monitor continuation failed: ${json(monitorPayload(monitor))}\n${reason}` : handback ? handbackFallback(handback, reason) : reason));
        break;
      }
      default:
        if (monitor && !reply(current.said)) {
          out.push(this.result(true, `Monitor result: ${json(monitorPayload(monitor))}`));
        } else if (handback && !final) {
          out.push(this.result(false, handbackFallback(handback, "The summary ended without a final answer.")));
        } else if (handback && !handback.reconciled && !this.stopped) {
          if (handback.reconciliationAttempt === 0) {
            // One event-driven decision turn, never a timer or an execution retry. As in 1.x the
            // turn that recorded no decision says nothing; the next one decides.
            handback.reconciliationAttempt = 1;
            this.results.unshift(handback);
            out.push(this.item({ kind: "stepText", text: "Worker turn ended; reconciling acceptance and next owner action." }));
            out.push(this.result(true, ""));
          } else {
            out.push(this.result(false, handbackFallback(handback, "No acceptance checkpoint or next owner action was recorded after one reconciliation. The user objective remains unverified; no automatic retry is scheduled.")));
          }
        } else {
          out.push(this.result(true, reply(current.said)));
        }
    }
    out.push(...this.next());
    return out;
  }

  /** The next waiting message's turn, a worker's report, or the end once `finish` asked for it. */
  private next(): CodexOutput[] {
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
      if (this.config.effort) params.effort = this.config.effort;
      this.nextReviewer(params);
      return [this.item({ kind: "backgroundTurn", taskId: null }), this.request("turn/start", params, { kind: "turn" }), ...this.pendingChanged()];
    }
    if (this.results.length && this.threadId && !this.stopped) {
      const result = this.results.shift()!;
      this.active = result;
      this.turn = { id: null, waitingSteers: [], interruptAsked: false, interruptSent: false, said: [] };
      const params: Record<string, unknown> = {
        threadId: this.threadId, input: [],
        toolOutput: { name: "app_task_result", namespace: null, output: JSON.stringify(resultPayload(result), null, 2) },
        environments: [],
      };
      if (this.config.effort) params.effort = this.config.effort;
      this.nextReviewer(params);
      return [this.item({ kind: "backgroundTurn", taskId: result.task }), this.request("turn/start", params, { kind: "turn" }), ...this.pendingChanged()];
    }
    return this.finishing && !this.hasManagedWork ? [{ kind: "close" }] : [];
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
    return [...this.workers.values()].map((worker) => {
      const result = this.results.find((r) => r.task === worker.id && r.run === worker.run) ?? (this.active?.task === worker.id && this.active.run === worker.run ? this.active : undefined);
      const record: WorkerRecord = { id: worker.id, name: worker.name, instructions: worker.instructions, run: worker.run, wasActive: worker.active, reportPending: !!result };
      if (worker.thread) record.thread = worker.thread;
      if (result) { record.report = result.report; record.status = result.status; if (result.turn) record.turn = result.turn; }
      if (worker.ownershipInstructions) record.ownershipInstructions = worker.ownershipInstructions;
      if (worker.role) record.role = worker.role;
      if (worker.isolatedGit) record.isolatedGit = worker.isolatedGit;
      return record;
    }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  get hasManagedWork(): boolean {
    return [...this.workers.values()].some((worker) => worker.active) || this.results.length > 0
      || [...this.monitors.values()].some((monitor) => monitorActive(monitor) || monitor.wake === "pending");
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
      const record: CommandMonitor = { id, owner: (this.config.ownerSession ?? "").toUpperCase(), command, cwd: this.config.cwd, state: "awaitingApproval", stdout: "", stderr: "", detail: "", wake: "none", createdAt: toSwiftDate() };
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
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [this.config.cwd], networkAccess: false },
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

  /** Workers at work now (for the bot's view and tests). */
  /**
   * Execution and queued callbacks in this live runtime, for the completion judge (`completionWorkerDependencies`);
   * persisted flags and cards cannot establish liveness.
   */
  get completionDependencies(): WorkerDependency[] {
    if (this.stopped) return [];
    const running = [...this.workers.values()].filter((worker) => worker.active && !worker.cancelled)
      .map((worker): WorkerDependency => ({ id: worker.id, run: worker.run, task: worker.ownershipInstructions ?? worker.instructions, state: "running", callback: "app_task_result", taskTruncated: false }));
    const queued = this.results.flatMap((result): WorkerDependency[] => {
      const worker = this.workers.get(result.task);
      if (!worker || worker.active || worker.run !== result.run) return [];
      return [{ id: worker.id, run: worker.run, task: worker.ownershipInstructions ?? worker.instructions, state: "reportQueued", callback: "app_task_result", outcome: result.status, taskTruncated: false }];
    });
    const commands = [...this.monitors.values()].flatMap((monitor): WorkerDependency[] => {
      if (monitor.state !== "running" && monitor.wake !== "pending") return [];
      return [{ id: monitor.id, run: 1, task: monitor.command, state: monitor.state === "running" ? "running" : "reportQueued", callback: "app_monitor_result",
        ...(monitor.state === "running" ? {} : { outcome: monitor.state }), taskTruncated: false }];
    });
    return [...running, ...queued, ...commands];
  }

  get runningWorkers(): string[] {
    return [...this.workers.values()].filter((worker) => worker.active && !worker.cancelled).map((worker) => worker.id);
  }

  private pendingChanged(): CodexOutput[] {
    const pending = this.hasManagedWork;
    if (pending === this.pending) return [];
    this.pending = pending;
    return [this.item({ kind: "managedPending", pending })];
  }

  private managedTool(rpcId: unknown, params: any): CodexOutput[] {
    const id = key(rpcId);
    const known = this.toolReplies.get(id);
    if (known) return [{ kind: "write", value: known }];
    const reply = (payload: unknown, success: boolean) => ({ jsonrpc: "2.0", id: rpcId, result: { success, contentItems: [{ type: "inputText", text: json(payload) }] } });
    const tool = typeof params.tool === "string" ? params.tool : null;
    if (!this.managed || this.stopped || (this.finishing && tool !== "app_task_checkpoint") || params.threadId !== this.threadId) {
      const response = reply({ error: "App handoff tools are available only to the active coordinator." }, false);
      this.toolReplies.set(id, response);
      return [{ kind: "write", value: response }];
    }
    let args: any = params.arguments;
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = null; } }
    if (!args || typeof args !== "object") args = {};
    const out: CodexOutput[] = [];
    let response: Record<string, unknown>;
    if (tool === "app_routines") {
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
      const handled = tool === "app_monitor_start" && (!this.turn || params.turnId !== this.turn.id)
        ? { payload: { error: "A monitor must be created by the current owning Codex turn." }, success: false, out: [] }
        : this.monitorTool(tool, args);
      response = reply(handled.payload, handled.success);
      out.push(...handled.out);
    } else if (tool === "app_handoff" && typeof args.instructions === "string" && args.instructions.trim()) {
      if (args.role !== undefined) {
        const denied = reply({ error: "The requested component-editor role is unavailable to this coordinator. Only the app-created Maintainer can use it; no generic worker was launched." }, false);
        this.toolReplies.set(id, denied);
        return [{ kind: "write", value: denied }];
      }
      const task = randomUUID().toLowerCase();
      const name = typeof args.name === "string" && args.name ? args.name : firstLine(args.instructions);
      let isolatedGit = isolatedGitOwnership(args.isolated_git, this.config.cwd,
        [...this.workers.values()].flatMap((w) => w.isolatedGit ? [w.isolatedGit] : []));
      if (isolatedGit) {
        if (isolatedGitOwners.has(isolatedGit.worktree)) isolatedGit = undefined;
        else isolatedGitOwners.set(isolatedGit.worktree, task);
      }
      // An invalid/missing grant still launches the task, with the existing approval cards.
      const instructions = isolatedGit ? `${args.instructions}\n\nApp-validated isolated Git ownership (only these exact files): ${JSON.stringify(isolatedGit)}. Use plain git worktree add -b BRANCH WORKTREE BASE, git -C WORKTREE add -- FILES, and git -C WORKTREE commit -m MESSAGE. Other operations still require normal approval.` : args.instructions;
      this.workers.set(task, { id: task, name, instructions, isolatedGit, turnId: null, run: 1, active: true, loaded: false, cancelled: false, messages: [], said: [], completedTurns: new Set() });
      out.push(
        this.item({ kind: "toolUse", id: task, tool: "Agent", title: `Delegate ${name}`, detail: args.instructions, parent: null, input: { description: name, prompt: args.instructions, subagent_type: "codex-worker", run_in_background: true } }),
        this.item({ kind: "subagentStarted", id: task, description: name, type: "codex-worker", prompt: args.instructions, background: true, execution: this.workerExecution(this.workers.get(task)!) }),
        ...this.startWorkerThread(task),
      );
      response = reply({ task_id: task, status: "accepted", isolated_git_approval: isolatedGit ? "validated" : "manual", message: "This task is accepted and owned by its worker. Continue any other independent, authorized handoffs and required report decisions in the current dispatch phase, then finish the turn. app_task_result will arrive when this worker finishes." }, true);
    } else if (tool === "app_send_message" && typeof args.task_id === "string" && typeof args.message === "string" && args.message && this.workers.has(args.task_id)) {
      const queued = this.workers.get(args.task_id)!.active;
      out.push(...this.messageWorker(args.task_id, args.message));
      const active = this.active;
      if (active && active.task === args.task_id) active.reconciled = true;
      response = reply({ task_id: args.task_id, status: queued ? "queued" : "accepted" }, true);
    } else if (tool === "app_task_checkpoint") {
      const task = typeof args.task_id === "string" ? args.task_id : null;
      const outcome = typeof args.outcome === "string" ? args.outcome : "";
      const evidence = typeof args.evidence === "string" ? args.evidence.trim() : "";
      const dependency = typeof args.dependency_task_id === "string" ? args.dependency_task_id : null;
      const ok = task && this.active?.task === task && ["complete", "waiting_user", "waiting_dependency", "blocked"].includes(outcome) && evidence
        && (outcome !== "waiting_dependency" || (dependency !== task && !!dependency && this.workers.get(dependency)?.active === true));
      if (ok) {
        this.active!.reconciled = true;
        out.push(
          this.item({ kind: "toolUse", id, tool: "app_task_checkpoint", title: `Task checkpoint: ${outcome}`, detail: json(args), parent: null, input: {} }),
          this.item({ kind: "toolResult", id, output: evidence, failed: false, parent: null, launch: null }),
        );
        response = reply({ task_id: task, outcome, recorded: true }, true);
      } else {
        response = reply({ error: "Checkpoint requires the active report task_id, a valid outcome and concrete evidence. A dependency must be another actively running app task; otherwise assign an owner, request exact user input, or report a concrete blocker." }, false);
      }
    } else {
      response = reply({ error: "Invalid app tool arguments or unknown task_id. Use app_handoff to create a task, then app_send_message with its task_id." }, false);
    }
    this.toolReplies.set(id, response);
    // The receipt goes first, so slow thread startup never keeps the model waiting.
    return [{ kind: "write", value: response }, ...out, ...this.pendingChanged()];
  }

  private startWorkerThread(task: string): CodexOutput[] {
    const worker = this.workers.get(task)!;
    const params: Record<string, unknown> = {
      cwd: this.config.cwd, approvalPolicy: "on-request", approvalsReviewer: this.reviewer, sandbox: "workspace-write",
      developerInstructions: this.config.workerInstructions ?? "Execute the assigned task yourself and return concrete evidence. Do not delegate.",
      config: { "features.multi_agent": false, "agents.enabled": false },
    };
    const model = this.config.workerModel ?? this.config.model;
    if (model) params.model = model;
    // Fast mode: the priority service tier (`CodexWorkerDefaults.fast`).
    if (typeof this.config.workerFast === "boolean") params.serviceTier = this.config.workerFast ? "priority" : "default";
    if (worker.thread) {
      params.threadId = worker.thread;
      params.excludeTurns = true;
      return [this.request("thread/resume", params, { kind: "workerThread", task })];
    }
    return [this.request("thread/start", params, { kind: "workerThread", task })];
  }

  private workerExecution(worker: Worker): SubagentExecution {
    return { run: worker.run, ownerSessionId: this.config.ownerSession ?? null, threadId: worker.thread ?? null, turnId: worker.turnId };
  }

  private workerThreadReady(task: string, result: any, error: any): CodexOutput[] {
    const worker = this.workers.get(task);
    if (!worker?.active || worker.cancelled || this.stopped) return [];
    const thread = result?.thread?.id;
    if (error || typeof thread !== "string") return this.failWorker(task, `Could not start worker session: ${message(error)}`);
    const resumed = !!worker.thread;
    worker.thread = thread;
    worker.loaded = !resumed;
    const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
    worker.runtime = { engine: "codex", reasoningEffort: text(result.reasoningEffort), serviceTier: text(result.serviceTier) };
    const model = text(result.model);
    const metadata = this.item({ kind: "subagentRuntime", id: task, runtime: worker.runtime, ...(model ? { model } : {}) });
    const execution = this.item({ kind: "subagentExecution", id: task, execution: this.workerExecution(worker) });
    if (resumed) return [metadata, execution, this.refreshInstructions(this.config.workerInstructions ?? "Execute the assigned task yourself and do not delegate.", thread, { kind: "workerInstructions", task })];
    return [metadata, execution, ...this.startWorkerTurn(task, worker.instructions)];
  }

  private startWorkerTurn(task: string, text: string): CodexOutput[] {
    const worker = this.workers.get(task);
    if (!worker?.thread || worker.cancelled || this.stopped) return [];
    worker.turnId = null;
    worker.said = [];
    const params: Record<string, unknown> = { threadId: worker.thread, input: [{ type: "text", text }] };
    const effort = this.config.workerEffort ?? this.config.effort;
    if (effort) params.effort = effort;
    if (worker.reviewerNext) {
      params.approvalsReviewer = worker.reviewerNext;
      worker.reviewerNext = worker.reviewerNext === "user" ? "auto_review" : undefined;
    }
    return [this.request("turn/start", params, { kind: "workerTurn", task, run: worker.run })];
  }

  private learnWorkerTurn(task: string, id: string): CodexOutput[] {
    const worker = this.workers.get(task);
    if (!worker?.active || worker.turnId || worker.completedTurns.has(id) || worker.cancelled) return [];
    worker.turnId = id;
    const messages = worker.messages;
    worker.messages = [];
    return [this.item({ kind: "subagentExecution", id: task, execution: this.workerExecution(worker) }), ...messages.map((text) => this.workerSteerCall(worker, text, id))];
  }

  private workerSteerCall(worker: Worker, text: string, turnId: string): CodexOutput {
    return this.request("turn/steer", { threadId: worker.thread ?? "", expectedTurnId: turnId, input: [{ type: "text", text }] }, { kind: "workerSteer", task: worker.id, run: worker.run, text });
  }

  private messageWorker(task: string, text: string): CodexOutput[] {
    const worker = this.workers.get(task);
    if (!worker || this.stopped) return [];
    if (worker.active) {
      delete worker.isolatedGit;
      worker.ownershipInstructions = `${worker.ownershipInstructions ?? worker.instructions}\nFollow-up: ${text}`;
      if (worker.turnId) return [this.workerSteerCall(worker, text, worker.turnId)];
      worker.messages.push(text);
      return [];
    }
    this.results = this.results.filter((result) => result.task !== task);
    delete worker.isolatedGit;
    worker.run += 1;
    worker.active = true;
    worker.cancelled = false;
    worker.instructions = text;
    delete worker.ownershipInstructions;
    worker.turnId = null;
    const out: CodexOutput[] = [this.item({ kind: "subagentStarted", id: task, description: worker.name, type: "codex-worker", prompt: text, background: true, execution: this.workerExecution(worker) })];
    out.push(...(worker.loaded ? this.startWorkerTurn(task, text) : this.startWorkerThread(task)));
    out.push(...this.pendingChanged());
    return out;
  }

  private workerLine(method: string, params: any, worker: Worker): CodexOutput[] {
    const task = worker.id;
    switch (method) {
      case "turn/started": {
        const id = params.turn?.id;
        if (typeof id !== "string") return [];
        if (worker.cancelled || this.stopped) return [this.request("turn/interrupt", { threadId: worker.thread ?? "", turnId: id }, { kind: "interrupt" })];
        return this.learnWorkerTurn(task, id);
      }
      case "item/started":
      case "item/completed": {
        const item = params.item;
        if (!worker.active || worker.cancelled || !item || typeof item !== "object") return [];
        if (typeof params.turnId === "string" && worker.turnId && params.turnId !== worker.turnId) return [];
        if (method === "item/started") {
          const step = this.started(item, task);
          return step ? [this.item(step)] : [];
        }
        if (item.type === "agentMessage") {
          const text = typeof item.text === "string" ? item.text : "";
          worker.said.push({ text, phase: typeof item.phase === "string" ? item.phase : null });
          return text ? [this.item({ kind: "subagentText", parent: task, text })] : [];
        }
        return this.completed(item, task).map((step) => this.item(step));
      }
      case "turn/completed": {
        const ended = params.turn;
        const id = ended?.id;
        if (!worker.active || worker.cancelled || typeof id !== "string" || worker.completedTurns.has(id) || (worker.turnId && worker.turnId !== id)) return [];
        worker.completedTurns.add(id);
        const closed = this.closeApprovals((approval) => approval.worker?.task === task && approval.worker.run === worker.run
          && (!approval.turn || approval.turn === id));
        worker.turnId = null;
        const usage = this.workerUsage(worker);
        let status: string = typeof ended.status === "string" ? ended.status : "failed";
        const said = worker.said.findLast((s) => s.phase !== "commentary")?.text.trim() ?? "";
        let report = status === "failed" ? (typeof ended.error?.message === "string" ? ended.error.message : said || "Worker failed.") : said;
        if (status === "completed" && !said) {
          status = "failed";
          report = "Worker turn ended without a final evidence report. Ask the same task_id for the missing result.";
        }
        // A rejected steer can have queued a message while the old turn was ending.
        if (worker.messages.length) {
          const text = worker.messages.join("\n\n");
          worker.messages = [];
          worker.run += 1;
          worker.instructions = text;
          return [...closed, ...usage, this.item({ kind: "subagentStarted", id: task, description: worker.name, type: "codex-worker", prompt: text, background: true,
            execution: { ...this.workerExecution(worker), turnId: null }, previousRunEnd: { status: status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped", result: report } }), ...this.startWorkerTurn(task, text)];
        }
        worker.active = false;
        this.results.push({ task, name: worker.name, thread: worker.thread, turn: id, run: worker.run, status, report, reconciliationAttempt: 0, reconciled: false });
        const out: CodexOutput[] = [...closed, ...usage, this.item({ kind: "subagentEnded", id: task, status: status === "interrupted" ? "killed" : status, summary: report })];
        if (!this.turn) out.push(...this.next());
        out.push(...this.pendingChanged());
        return out;
      }
      case "item/autoApprovalReview/completed":
        return this.reviewed(params, worker);
      case "serverRequest/resolved": {
        return this.resolveApproval(params);
      }
      case "thread/tokenUsage/updated": {
        if (params.tokenUsage?.total && typeof params.tokenUsage.total === "object") worker.tokens = codexTokens(params.tokenUsage.total);
        const tokens = params.tokenUsage?.total?.outputTokens;
        return worker.thread && typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0
          ? [this.item({ kind: "subagentOutput", id: task, counter: `thread:${worker.thread}`, tokens })] : [];
      }
      default:
        return [];
    }
  }

  /** What a worker's run used since it started (or since the last count). */
  private workerUsage(worker: Worker): CodexOutput[] {
    const now = worker.tokens ?? noTokens();
    const used = minusTokens(now, worker.tokensAtRunStart ?? noTokens());
    worker.tokensAtRunStart = now;
    return totalTokens(used) > 0 ? [this.item({ kind: "usage", totalCost: 0, tokens: used })] : [];
  }

  private failWorker(task: string, report: string): CodexOutput[] {
    const worker = this.workers.get(task);
    if (!worker?.active) return [];
    worker.active = false;
    if (worker.turnId) worker.completedTurns.add(worker.turnId);
    worker.turnId = null;
    worker.messages = [];
    this.results.push({ task, name: worker.name, thread: worker.thread, run: worker.run, status: "failed", report, reconciliationAttempt: 0, reconciled: false });
    const out: CodexOutput[] = [...this.closeApprovals((approval) => approval.worker?.task === task), this.item({ kind: "subagentEnded", id: task, status: "failed", summary: report })];
    if (!this.turn) out.push(...this.next());
    out.push(...this.pendingChanged());
    return out;
  }

  /** Stops workers (all, or these): their turns are interrupted and no report is made. */
  cancelWorkers(ids?: Set<string>): CodexOutput[] {
    const out: CodexOutput[] = [];
    if (ids) {
      this.results = this.results.filter((result) => !ids.has(result.task));
      if (this.active && ids.has(this.active.task)) this.active = null;
    } else {
      this.results = [];
      this.active = null;
    }
    for (const worker of this.workers.values()) {
      if (!worker.active || (ids && !ids.has(worker.id))) continue;
      worker.active = false;
      if (worker.turnId) worker.completedTurns.add(worker.turnId);
      worker.cancelled = true;
      worker.messages = [];
      out.push(...this.closeApprovals((approval) => approval.worker?.task === worker.id, true));
      if (worker.thread && worker.turnId) out.push(this.request("turn/interrupt", { threadId: worker.thread, turnId: worker.turnId }, { kind: "interrupt" }));
      out.push(this.item({ kind: "subagentEnded", id: worker.id, status: "killed", summary: "Stopped by the app." }));
    }
    out.push(...this.pendingChanged());
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // Items

  /** A tool call starting, as a step. */
  private started(item: any, parent: string | null = null): StreamItem | null {
    if (!item || typeof item.id !== "string") return null;
    const id = item.id;
    switch (item.type) {
      case "commandExecution": {
        const command = codexCommand(item);
        return { kind: "toolUse", id, tool: "Bash", title: activity("Bash", { command }), detail: command, parent, input: { command } };
      }
      case "fileChange": {
        const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
        const paths = changes.map((change) => change?.path).filter((path): path is string => typeof path === "string");
        this.changedFiles.set(id, paths);
        const adds = changes.length > 0 && changes.every((change) => change?.kind?.type === "add");
        const tool = adds ? "Write" : "Edit";
        let title = activity(tool, paths[0] ? { file_path: paths[0] } : {});
        if (paths.length > 1) title += ` +${paths.length - 1}`;
        return { kind: "toolUse", id, tool, title, detail: paths.join("\n"), parent, input: {} };
      }
      case "mcpToolCall": {
        const server = String(item.server ?? ""), tool = String(item.tool ?? "");
        return { kind: "toolUse", id, tool: `mcp__${server}__${tool}`, title: `${server} ${tool}`, detail: json(item.arguments), parent, input: {} };
      }
      case "dynamicToolCall": {
        // The app's own tools show as their own steps (a hand-off as its subagent row).
        const tool = String(item.tool ?? "tool");
        if (tool === "app_handoff" || tool === "app_send_message" || tool === "app_task_checkpoint") return null;
        return { kind: "toolUse", id, tool, title: tool, detail: json(item.arguments), parent, input: {} };
      }
      case "webSearch": {
        const query = String(item.query ?? "");
        return { kind: "toolUse", id, tool: "WebSearch", title: activity("WebSearch", { query }), detail: query, parent, input: {} };
      }
      default:
        return null;
    }
  }

  /** An item done: a tool call's result, or words it said. */
  private completed(item: any, parent: string | null = null): CodexItem[] {
    if (!item || typeof item.id !== "string") return [];
    const id = item.id;
    const status = item.status;
    switch (item.type) {
      case "agentMessage": {
        const text = typeof item.text === "string" ? item.text : "";
        const phase = typeof item.phase === "string" ? item.phase : null;
        this.turn?.said.push({ text, phase });
        // Words between tool calls are a step; the final answer is the reply.
        const words = text.trim();
        return phase === "commentary" && words ? [{ kind: "stepText", text: words }] : [];
      }
      case "commandExecution": {
        const failed = status !== "completed" || (typeof item.exitCode === "number" && item.exitCode !== 0);
        return [{ kind: "toolResult", id, output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "", failed, parent, launch: null }];
      }
      case "fileChange": {
        this.changedFiles.delete(id);
        const diffs = (Array.isArray(item.changes) ? item.changes : []).map((change: any) => change?.diff).filter((diff: unknown): diff is string => typeof diff === "string");
        return [{ kind: "toolResult", id, output: diffs.join("\n"), failed: status !== "completed", parent, launch: null }];
      }
      case "mcpToolCall":
      case "dynamicToolCall": {
        if (item.type === "dynamicToolCall" && ["app_handoff", "app_send_message", "app_task_checkpoint"].includes(item.tool)) return [];
        const output = item.error != null ? json(item.error) : json(item.result ?? item.contentItems);
        return [{ kind: "toolResult", id, output, failed: status === "failed", parent, launch: null }];
      }
      case "webSearch":
        return [{ kind: "toolResult", id, output: json(item.results), failed: false, parent, launch: null }];
      default:
        return [];
    }
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
}

/** One long-lived `codex app-server` for one bot session: `CodexSession` over its stdio. */
export class CodexHead {
  readonly engine = "codex" as const;
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
  private exitedResolve!: () => void;
  readonly exited = new Promise<void>((resolve) => (this.exitedResolve = resolve));
  running = false;

  constructor(readonly config: CodexHeadConfig, private handlers: HeadHandlers & { onItem(item: CodexItem): void }, private adapter: ProcessTreeAdapter = processTreeAdapter()) {
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
      restoredWorkers: config.workerInstructions ? config.threads.workers(config.sessionId) : [],
      routinesFile: config.routinesFile ?? null, ownerSession: config.sessionId, restoredMonitors,
      autoMode: config.autoMode ?? true,
    });
    this.savedWorkers = JSON.stringify(this.session.workerRecords);
    this.savedMonitors = JSON.stringify(restoredMonitors);
  }

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
      this.exitedResolve();
      const why = [this.failure, this.stderrTail.trim(), extra].filter(Boolean).join("\n");
      this.handlers.onExit({ code: this.failure ? 1 : code, signal, stderr: why, expected: this.expected, silent: !this.printed });
    };
    child.once("error", (error) => report(null, null, cliStartError("codex", this.config.command, error)));
    child.once("close", (code, signal) => report(code, signal));
    this.perform(this.session.start());
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
    if (monitorText !== this.savedMonitors) {
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
          break;
        case "thread":
          this.config.threads.save(output.id, this.config.sessionId);
          if (this.config.workerInstructions) this.config.threads.markManaged(output.id, this.config.sessionId);
          this.handlers.onItem({ kind: "init", sessionId: this.config.sessionId });
          break;
        case "close":
          this.closeInput();
          break;
        case "failed":
          this.failure = output.message;
          this.closeInput();
          void this.process?.terminate({ graceMs: 1_000 });
          break;
      }
    }
  }

  private closeInput() {
    if (this.closed || !this.process) return;
    this.closed = true;
    this.process.child.stdin.end();
  }

  send(text: string, _uuid?: string, images: string[] = []) {
    this.perform(this.session.send(text, images));
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

  /** Stdin closes once the turn under way and its workers' reports are done (going to sleep). */
  finish() {
    this.expected = true;
    this.perform(this.session.finish());
  }

  async terminate(graceMs = 1_500): Promise<TerminateResult> {
    this.expected = true;
    this.perform(this.session.stop());
    this.closeInput();
    if (!this.process) return { killed: [], forced: false };
    return this.process.terminate({ graceMs });
  }
}

export type { HeadExit };
