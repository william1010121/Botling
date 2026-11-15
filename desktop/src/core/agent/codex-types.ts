// Codex head: the types, the tool tables and the small helpers `codex.ts` shares (moved out of codex.ts, M7-S10a).
import type { IsolatedGitOwnership } from "./isolated-git";
import { activity, type StreamItem } from "./stream";
import type { WorkerOwner } from "./workers";
import type { ComponentEditorAction, ComponentEditorRoute } from "./component-editor";
import { appTools, codexDynamicTools, workerAppTools } from "../app-tools/registry";
import type { BotToolName } from "../bot-tools";
import { EFFORTS_BY_ENGINE } from "../../contract/efforts";
import type { CodexModelEntry } from "./codex-models";
import type { CommandMonitor } from "./monitors";
import type { WorkerCore, WorkerCoreOptions } from "../worker-core";

/** A live worker or monitored command as the head reports it (what keeps a head from idling). */
export interface WorkerDependency { id: string; run: number; task: string; state: "running" | "reportQueued"; callback?: string; outcome?: string; taskTruncated: boolean }

/** `value` as a level Codex's `effort` takes; null: none, or one it does not take. */
export const codexEffort = (value: unknown): string | null => (EFFORTS_BY_ENGINE.codex as readonly unknown[]).includes(value) ? value as string : null;

/** What a Codex head gives the bot besides claude's items. */
export type CodexItem =
  | StreamItem
  /** Words between tool calls (Codex's commentary): a step of the turn, not the reply. */
  | { kind: "stepText"; text: string }
  /** The app started a turn on the coordinator by itself (a worker's report). */
  | { kind: "backgroundTurn"; taskId: string | null }
  /** Workers at work or reports waiting: the bot must not sleep. */
  | { kind: "managedPending"; pending: boolean }
  /** Antigravity read words offered into its turn (`AgyAcpHead.offerInsert`) with a tool result. */
  | { kind: "inserted"; id: string }
  /** A run report of a worker another bot owns (workers.ts `setWorkerOwner`): the app routes it to that bot, never to this coordinator. */
  | { kind: "workerReport"; id: string; run: number; engine: "claude" | "codex" | "agy"; status: string; report: string }
  /** A worker another bot owns sent a note (app_notify_owner): the app routes it to that bot, never to this coordinator. */
  | { kind: "workerNote"; id: string; run: number; engine: "claude" | "codex" | "agy"; noteKind: "report" | "question"; name: string; message: string; files: string[] }
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
  /** `worker`: one of its app-managed workers' items (the bot's worker entry), not the coordinator's. */
  | { kind: "item"; item: CodexItem; worker?: true }
  | { kind: "thread"; id: string }
  | { kind: "close" }
  | { kind: "componentEditor"; action: ComponentEditorAction }
  | { kind: "recoverEditor"; task:string; run:number; session:string; checkpoint:string }
  | { kind: "failed"; message: string }
  /** A browser tool call (any thread of this session): the head answers `rpcId` once main has. */
  | { kind: "browser"; rpcId: unknown; tool: BotToolName; args: Record<string, unknown>; worker?: boolean };

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
  /**
   * Plugins' skill folders (engine-skills.ts): given to the app-server with `skills/extraRoots/set` before the first thread,
   * so the coordinator and its workers load them as Codex skills. None: not asked.
   */
  skillRoots?: string[];
  /** The coordinator's developer instructions (Prompts.swift's system prompt for a Codex head). */
  instructions: string;
  /** What app-managed workers are told; null: not a coordinator (no app tools). */
  workerInstructions: string | null;
  /** Go on in this thread (`thread/resume`) instead of starting one. */
  resumeThread: string | null;
  model: string | null;
  workerModel: string | null;
  /** The models app_handoff's `model` may name (default: Codex's models cache; null: no list, a slug-shaped name is taken). */
  workerModels?: () => readonly CodexModelEntry[] | null;
  /** "low" … "xhigh". */
  effort: string | null;
  /** Workers' own effort and Fast mode (settings' Codex workers; null: as the coordinator / config.toml). */
  workerEffort?: string | null;
  workerFast?: boolean | null;
  restoredWorkers: WorkerRecord[];
  /** The restart journal's workers (written by a core before the worker ledger; read for one version). */
  restartWorkers?: WorkerRecord[];
  /** After an explicit restart (its time): workers the ledger says it interrupted are checked and resumed. */
  restartRecovery?: number;
  /** The member's core (Bot: its worker ledger and projections); absent: a core over `restoredWorkers`. */
  workerCore?: (options: WorkerCoreOptions) => WorkerCore;
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
  /** How long a worker's stop waits for its unanswered start requests before it gives up as not clean (default 15 s). */
  workerStopDeadlineMs?: number;
  /** Explicit opt-in: no approval prompts and no Codex sandbox. */
  bypassPermissions?: boolean;
  /** More folders it may write besides `cwd` (1.x's `writableRoots`: the bot's `--add-dir` folders). */
  writableRoots?: string[];
  /** Model families whose workers may write spec/ (settings.json `specWriters`; default ["opus"]). The coordinator is not restricted. */
  specWriters?: readonly string[];
}

/** Codex's `sandbox_workspace_write.writable_roots` for these folders (none: nothing to add). */
export function writableRootsConfig(roots: readonly string[] | undefined): Record<string, unknown> {
  return roots?.length ? { sandbox_workspace_write: { writable_roots: [...roots] } } : {};
}

export type Call =
  | { kind: "initialize" | "skillRoots" | "thread" | "turn" | "interrupt" | "other" }
  | { kind: "coordinatorInstructions"; thread: string }
  | { kind: "steer"; input: Input }
  | { kind: "restartCoordinatorRead"; turn: string }
  | { kind: "restartWorkerRead"; task: string; turn: string }
  | { kind: "monitorCommand"; id: string }
  /** A worker adapter's own request (CodexWire). */
  | { kind: "adapter"; reply: (result: any, error: any) => void };

export interface Input { text: string; token: string; images?: string[] }
export interface Turn { id: string | null; waitingSteers: Input[]; interruptAsked: boolean; interruptSent: boolean; said: { text: string; phase: string | null }[] }
export interface Approval {
  rpcId: unknown;
  kind: "command" | "fileChange" | { permissions: Record<string, unknown> };
  thread: string;
  turn: string | null;
}

/** Codex's coordinator: no shell, no native subagents, no web search (`coordinatorConfig`). */
export const COORDINATOR_CONFIG = { "features.multi_agent": false, "agents.enabled": false, "features.shell_tool": false, web_search: "disabled" };
export const MANAGED_TOOLS: Record<string, unknown>[] = codexDynamicTools(appTools("codex"));
/** The longest hand-off the worker core takes. */
export const MAX_HANDOFF = 64_000;
/** Changing the tools needs a new coordinator thread (tools are fixed when a thread starts). */
export const MANAGED_TOOL_SIGNATURE = JSON.stringify(MANAGED_TOOLS);
/** A worker thread's one dynamic tool: app_notify_owner (fixed when its thread starts, like the coordinator's). */
export const WORKER_TOOLS: Record<string, unknown>[] = codexDynamicTools(workerAppTools("codex"));
// All bot sessions in this app share destination claims. A second session must never adopt
// another worker's grant just because its branch/worktree names happen to match.
export const isolatedGitOwners = new Map<string, string>();
/** The subagent type of the Maintainer's component editor. */

/** The shell a monitored command runs in (1.x: zsh on macOS). */
export const shell = (command: string): string[] => (process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : process.platform === "darwin" ? ["/bin/zsh", "-c", command] : ["/bin/sh", "-c", command]);

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

export const message = (error: unknown) => (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : "Codex did not answer.");
export const key = (id: unknown) => String(id);
export const json = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
};

/** The words a restarted worker's run shows when it adopts the answer its original turn completed with before the restart. */
export const ADOPTED_RUN = "(App: this worker's turn completed before the app restarted; its answer is reported as it was. Nothing was sent to it again.)";

/**
 * A worker core result its sync adapters already have (a promise would mean an adapter that is not: `pending` instead).
 * The core's app tools may be async (handoff, message, cancel), but CodexSession answers each JSON-RPC line with the
 * outputs it causes, in order: its two adapters start, steer and recover synchronously, so a follow-up's result (and the
 * writes it queued) are there when the call returns. A tool call's receipt is written first and the core's work follows
 * in the same outputs; `handoff` is not awaited for the receipt (its task id is chosen up front, `nextTask`).
 */
export const syncResult = <T>(value: T | Promise<T>, pending: T): T => (value instanceof Promise ? pending : value);

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
