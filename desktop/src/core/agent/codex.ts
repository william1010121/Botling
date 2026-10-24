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
//   writes only in its folder (`workspace-write`). 2.0 has no auto mode, so the reviewer is the user.
// - The head is a coordinator: shell and native subagents are off, and it hands execution to
//   app-managed workers with the app's dynamic tools (app_handoff, app_send_message,
//   app_task_checkpoint). Each worker is an independent Codex thread in the same app-server; its
//   record is kept in codex-threads/<session>.workers.json; when its turn ends, the app starts a
//   report turn on the coordinator with an `app_task_result` tool output.
// - The reply is the turn's last agent message that is not commentary; commentary is a step.
// - `interrupt` stops the turn (`turn/interrupt`).
//
// Not ported (2.0 gaps, see desktop/README.md): app_routines and app_monitor_* (answered with an
// error saying 2.0 cannot do them yet), the component-editor role, Codex's reviewer (auto mode),
// Codex's own native subagents (off in a coordinator anyway), rate limits and token usage,
// images in messages.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../durable/atomic";
import { processTreeAdapter, type ManagedProcess, type ProcessTreeAdapter, type TerminateResult } from "../process/tree";
import { childEnvironment } from "./runner";
import { activity, type StreamItem } from "./stream";
import type { HeadExit, HeadHandlers } from "./head";
import tools from "./codex-tools.json";

/** What a Codex head gives the bot besides claude's items. */
export type CodexItem =
  | StreamItem
  /** Words between tool calls (Codex's commentary): a step of the turn, not the reply. */
  | { kind: "stepText"; text: string }
  /** The app started a turn on the coordinator by itself (a worker's report). */
  | { kind: "backgroundTurn"; taskId: string | null }
  /** Workers at work or reports waiting: the bot must not sleep. */
  | { kind: "managedPending"; pending: boolean };

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
  restoredWorkers: WorkerRecord[];
}

type Call =
  | { kind: "initialize" | "thread" | "turn" | "interrupt" | "other" }
  | { kind: "coordinatorInstructions"; thread: string }
  | { kind: "workerInstructions"; task: string }
  | { kind: "steer"; input: Input }
  | { kind: "workerThread"; task: string }
  | { kind: "workerTurn"; task: string; run: number }
  | { kind: "workerSteer"; task: string; run: number; text: string };

interface Input { text: string; token: string }
interface Turn { id: string | null; waitingSteers: Input[]; interruptAsked: boolean; interruptSent: boolean; said: { text: string; phase: string | null }[] }
interface Approval { rpcId: unknown; kind: "command" | "fileChange" | { permissions: Record<string, unknown> }; thread: string | null }

interface Worker {
  id: string; name: string; instructions: string; ownershipInstructions?: string; role?: string;
  thread?: string; turnId: string | null; run: number; active: boolean; loaded: boolean; cancelled: boolean;
  messages: string[]; said: { text: string; phase: string | null }[]; completedTurns: Set<string>;
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

const NOT_YET = "Botling 2.0 cannot do this yet (routines and monitors are not ported). Tell the user in one sentence; do not try another way.";

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
  private inbox: Input[] = [];
  private approvals = new Map<string, Approval>();
  private changedFiles = new Map<string, string[]>();
  private finishing = false;
  private stopped = false;
  private workers = new Map<string, Worker>();
  private results: Result[] = [];
  private active: Result | null = null;
  private toolReplies = new Map<string, Record<string, unknown>>();
  private pending = false;

  constructor(readonly config: CodexConfig) {
    for (const record of config.restoredWorkers) {
      this.workers.set(record.id, {
        id: record.id, name: record.name, instructions: record.instructions, ownershipInstructions: record.ownershipInstructions, role: record.role,
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
  send(text: string): CodexOutput[] {
    const input = { text, token: randomUUID() };
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
    const approval = this.approvals.get(requestId);
    if (!approval) return [];
    this.approvals.delete(requestId);
    const result = approval.kind === "command" || approval.kind === "fileChange"
      ? { decision: allow ? "accept" : "decline" }
      : allow ? { permissions: approval.kind.permissions, scope: "turn" } : { permissions: {} };
    const out: CodexOutput[] = [{ kind: "write", value: { jsonrpc: "2.0", id: approval.rpcId, result } }];
    // A refusal carries no words in Codex's protocol: why goes to the turn as a message.
    if (!allow && why) {
      const worker = approval.thread && approval.thread !== this.threadId ? [...this.workers.values()].find((w) => w.thread === approval.thread) : undefined;
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
    this.stopped = true;
    this.inbox = [];
    return this.cancelWorkers();
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
      case "turn": {
        if (error) {
          // The turn never started: its message gets an error reply, and the next goes.
          this.turn = null;
          const text = this.active ? handbackFallback(this.active, message(error)) : message(error);
          this.active = null;
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
        return typeof id === "string" ? this.learnWorkerTurn(call.task, id) : [];
      }
      case "workerSteer": {
        const worker = this.workers.get(call.task);
        if (!error || !worker || worker.cancelled) return [];
        if (worker.active) { worker.messages.push(call.text); return []; }
        return this.messageWorker(call.task, call.text);
      }
      default:
        return [];
    }
  }

  private notification(method: string, params: any): CodexOutput[] {
    const thread = typeof params.threadId === "string" ? params.threadId : null;
    if (thread && this.threadId && thread !== this.threadId) {
      const worker = [...this.workers.values()].find((w) => w.thread === thread);
      return worker ? this.workerLine(method, params, worker) : [];
    }
    switch (method) {
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
        const id = params.requestId === undefined ? null : key(params.requestId);
        if (!id || !this.approvals.delete(id)) return [];
        return [this.item({ kind: "permissionCancelled", requestId: id })];
      }
      case "turn/completed":
        return params.turn ? this.turnCompleted(params.turn) : [];
      default:
        return [];
    }
  }

  private serverRequest(method: string, rpcId: unknown, params: any): CodexOutput[] {
    const id = key(rpcId);
    if (method === "item/tool/call") return this.managedTool(rpcId, params);
    const thread = typeof params.threadId === "string" ? params.threadId : null;
    const reason = typeof params.reason === "string" && params.reason ? params.reason : "";
    switch (method) {
      case "item/commandExecution/requestApproval": {
        this.approvals.set(id, { rpcId, kind: "command", thread });
        let summary = typeof params.command === "string" ? params.command : "";
        if (reason) summary += (summary ? "\n\n" : "") + reason;
        return [this.item({ kind: "permission", requestId: id, tool: "Bash", summary, input: {} })];
      }
      case "item/fileChange/requestApproval": {
        this.approvals.set(id, { rpcId, kind: "fileChange", thread });
        const files = typeof params.itemId === "string" ? this.changedFiles.get(params.itemId) ?? [] : [];
        let summary = files.join("\n");
        if (typeof params.grantRoot === "string" && params.grantRoot) summary += (summary ? "\n" : "") + params.grantRoot;
        if (reason) summary += (summary ? "\n\n" : "") + reason;
        return [this.item({ kind: "permission", requestId: id, tool: "Edit", summary, input: {} })];
      }
      case "item/permissions/requestApproval": {
        const asked = params.permissions && typeof params.permissions === "object" ? params.permissions : {};
        this.approvals.set(id, { rpcId, kind: { permissions: asked }, thread });
        const summary = [reason, JSON.stringify(asked, Object.keys(asked).sort())].filter(Boolean).join("\n\n");
        return [this.item({ kind: "permission", requestId: id, tool: "Permissions", summary, input: {} })];
      }
      case "mcpServer/elicitation/request":
        // A form the app cannot show: declined, so nothing waits on it.
        return [{ kind: "write", value: { jsonrpc: "2.0", id: rpcId, result: { action: "decline" } } }];
      default:
        // Bots ask in the chat (<choices>); anything else is not the app's to answer.
        return [{ kind: "write", value: { jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: "Not supported by Botling." } } }];
    }
  }

  // ------------------------------------------------------------------------------------------
  // Turns

  private startThread(): CodexOutput {
    const params: Record<string, unknown> = {
      cwd: this.config.cwd, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", developerInstructions: this.config.instructions,
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
    const params: Record<string, unknown> = { threadId: this.threadId, input: [{ type: "text", text: input.text }] };
    if (this.managed) params.environments = [];
    if (this.config.effort) params.effort = this.config.effort;
    return [this.request("turn/start", params, { kind: "turn" })];
  }

  private learnTurn(id: string): CodexOutput[] {
    const turn = this.turn;
    if (!turn || turn.id) return [];
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
    if (current.id && typeof finished.id === "string" && finished.id !== current.id) return [];
    this.turn = null;
    const handback = this.active;
    this.active = null;
    const out: CodexOutput[] = [];
    const final = current.said.findLast((said) => said.phase !== "commentary")?.text.trim() ?? "";
    switch (finished.status) {
      case "interrupted":
        // Stopped by the app (`interrupt`): an error result the bot does not show.
        out.push(this.result(false, handback ? handbackFallback(handback, "The summary turn was interrupted.") : current.interruptAsked ? "" : "Codex stopped this turn."));
        break;
      case "failed": {
        const reason = typeof finished.error?.message === "string" ? finished.error.message : "Codex failed.";
        out.push(this.result(false, handback ? handbackFallback(handback, reason) : reason));
        break;
      }
      default:
        if (handback && !final) {
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
      return record;
    }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  get hasManagedWork(): boolean {
    return [...this.workers.values()].some((worker) => worker.active) || this.results.length > 0;
  }

  /** Workers at work now (for the bot's view and tests). */
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
    if (tool === "app_routines" || tool?.startsWith("app_monitor_")) {
      response = reply({ error: NOT_YET }, false);
    } else if (tool === "app_handoff" && typeof args.instructions === "string" && args.instructions.trim()) {
      if (args.role !== undefined) {
        const denied = reply({ error: "The requested component-editor role is unavailable to this coordinator. Only the app-created Maintainer can use it; no generic worker was launched." }, false);
        this.toolReplies.set(id, denied);
        return [{ kind: "write", value: denied }];
      }
      const task = randomUUID().toLowerCase();
      const name = typeof args.name === "string" && args.name ? args.name : firstLine(args.instructions);
      this.workers.set(task, { id: task, name, instructions: args.instructions, turnId: null, run: 1, active: true, loaded: false, cancelled: false, messages: [], said: [], completedTurns: new Set() });
      out.push(
        this.item({ kind: "toolUse", id: task, tool: "Agent", title: `Delegate ${name}`, detail: args.instructions, parent: null, input: { description: name, prompt: args.instructions, subagent_type: "codex-worker", run_in_background: true } }),
        this.item({ kind: "subagentStarted", id: task, description: name, type: "codex-worker", prompt: args.instructions, background: true }),
        ...this.startWorkerThread(task),
      );
      response = reply({ task_id: task, status: "accepted", message: "This task is accepted and owned by its worker. Continue any other independent, authorized handoffs and required report decisions in the current dispatch phase, then finish the turn. app_task_result will arrive when this worker finishes." }, true);
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
      cwd: this.config.cwd, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write",
      developerInstructions: this.config.workerInstructions ?? "Execute the assigned task yourself and return concrete evidence. Do not delegate.",
      config: { "features.multi_agent": false, "agents.enabled": false },
    };
    const model = this.config.workerModel ?? this.config.model;
    if (model) params.model = model;
    if (worker.thread) {
      params.threadId = worker.thread;
      params.excludeTurns = true;
      return [this.request("thread/resume", params, { kind: "workerThread", task })];
    }
    return [this.request("thread/start", params, { kind: "workerThread", task })];
  }

  private workerThreadReady(task: string, result: any, error: any): CodexOutput[] {
    const worker = this.workers.get(task);
    if (!worker?.active || worker.cancelled || this.stopped) return [];
    const thread = result?.thread?.id;
    if (error || typeof thread !== "string") return this.failWorker(task, `Could not start worker session: ${message(error)}`);
    const resumed = !!worker.thread;
    worker.thread = thread;
    worker.loaded = !resumed;
    if (resumed) return [this.refreshInstructions(this.config.workerInstructions ?? "Execute the assigned task yourself and do not delegate.", thread, { kind: "workerInstructions", task })];
    return this.startWorkerTurn(task, worker.instructions);
  }

  private startWorkerTurn(task: string, text: string): CodexOutput[] {
    const worker = this.workers.get(task);
    if (!worker?.thread || worker.cancelled || this.stopped) return [];
    worker.turnId = null;
    worker.said = [];
    const params: Record<string, unknown> = { threadId: worker.thread, input: [{ type: "text", text }] };
    if (this.config.effort) params.effort = this.config.effort;
    return [this.request("turn/start", params, { kind: "workerTurn", task, run: worker.run })];
  }

  private learnWorkerTurn(task: string, id: string): CodexOutput[] {
    const worker = this.workers.get(task);
    if (!worker?.active || worker.turnId || worker.completedTurns.has(id) || worker.cancelled) return [];
    worker.turnId = id;
    const messages = worker.messages;
    worker.messages = [];
    return messages.map((text) => this.workerSteerCall(worker, text, id));
  }

  private workerSteerCall(worker: Worker, text: string, turnId: string): CodexOutput {
    return this.request("turn/steer", { threadId: worker.thread ?? "", expectedTurnId: turnId, input: [{ type: "text", text }] }, { kind: "workerSteer", task: worker.id, run: worker.run, text });
  }

  private messageWorker(task: string, text: string): CodexOutput[] {
    const worker = this.workers.get(task);
    if (!worker || this.stopped) return [];
    if (worker.active) {
      worker.ownershipInstructions = `${worker.ownershipInstructions ?? worker.instructions}\nFollow-up: ${text}`;
      if (worker.turnId) return [this.workerSteerCall(worker, text, worker.turnId)];
      worker.messages.push(text);
      return [];
    }
    this.results = this.results.filter((result) => result.task !== task);
    worker.run += 1;
    worker.active = true;
    worker.cancelled = false;
    worker.instructions = text;
    delete worker.ownershipInstructions;
    worker.turnId = null;
    const out: CodexOutput[] = [this.item({ kind: "subagentStarted", id: task, description: worker.name, type: "codex-worker", prompt: text, background: true })];
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
        worker.turnId = null;
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
          return this.startWorkerTurn(task, text);
        }
        worker.active = false;
        this.results.push({ task, name: worker.name, thread: worker.thread, turn: id, run: worker.run, status, report, reconciliationAttempt: 0, reconciled: false });
        const out: CodexOutput[] = [this.item({ kind: "subagentEnded", id: task, status: status === "interrupted" ? "killed" : status, summary: report })];
        if (!this.turn) out.push(...this.next());
        out.push(...this.pendingChanged());
        return out;
      }
      case "serverRequest/resolved": {
        const id = params.requestId === undefined ? null : key(params.requestId);
        if (!id || !this.approvals.delete(id)) return [];
        return [this.item({ kind: "permissionCancelled", requestId: id })];
      }
      default:
        return [];
    }
  }

  private failWorker(task: string, report: string): CodexOutput[] {
    const worker = this.workers.get(task);
    if (!worker?.active) return [];
    worker.active = false;
    worker.turnId = null;
    worker.messages = [];
    this.results.push({ task, name: worker.name, thread: worker.thread, run: worker.run, status: "failed", report, reconciliationAttempt: 0, reconciled: false });
    const out: CodexOutput[] = [this.item({ kind: "subagentEnded", id: task, status: "failed", summary: report })];
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
      worker.cancelled = true;
      worker.messages = [];
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
    this.session = new CodexSession({
      cwd: config.cwd, instructions: config.instructions, workerInstructions: config.workerInstructions, resumeThread,
      model: config.model ?? null, workerModel: config.workerModel ?? null, effort: config.effort ?? null,
      restoredWorkers: config.workerInstructions ? config.threads.workers(config.sessionId) : [],
    });
    this.savedWorkers = JSON.stringify(this.session.workerRecords);
  }

  get pid() {
    return this.process?.pid ?? -1;
  }

  start() {
    const managed = this.adapter.spawn(this.config.command, [...(this.config.prefixArgs ?? []), "app-server"], { cwd: this.config.cwd, env: childEnvironment(this.config.env) });
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
    child.once("error", (error) => report(null, null, `Could not start ${this.config.command}: ${error.message}`));
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

  send(text: string, _uuid?: string) {
    this.perform(this.session.send(text));
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
