// One worker model for every engine. A worker is an app-managed agent the coordinator started with
// `app_handoff`: a Codex worker thread (codex.ts), an Antigravity ACP worker (agy-workers.ts) or a Claude
// worker process (claude-workers.ts). Each engine keeps its own transport and journal (workers.json,
// claude-workers.json), but the bot, the agent registry, the Rail, the sub-bot hand-off and moves only see
// this interface, so a new engine plugs in by implementing `WorkerHost` and emitting the shared items below.
//
// Shared events (as `CodexItem`s, the bot's item stream): a run starts with `toolUse` (tool "Agent", parent
// null, id = task id) then `subagentStarted` (type `<engine>-worker`, background true) and `subagentRuntime`;
// its steps are `toolUse`/`toolResult` with `parent` = task id and `subagentText`; tokens are `subagentOutput`;
// a run ends with `subagentEnded`. Approvals are `permission` items with `workerId` and a request id
// `worker:<task id>:<run>:<engine's id>`, answered through `answer`.
//
// Owners. A worker belongs to the coordinator that started it until the app gives it to another bot
// (`setWorkerOwner`, the agent registry's owner move). From then on its host keeps running it exactly as before,
// but its run reports are not the coordinator's: the host emits them as `workerReport` items for the app to route
// to the owner, leaves them out of the coordinator's completion checks, and refuses the coordinator's own app tool
// calls on it (`movedTaskError`). `setWorkerOwner(id, null)` gives it back.
import type { Engine } from "../heads";
import type { CodexItem } from "./codex";
import type { WorkerAdapterKind } from "../worker-core/events";

// The report format lives in the shared worker core (worker-core/report.ts); these names stay importable from here.
export { ownedWorkerReport, workerReportText } from "../worker-core/report";

/** Where the worker physically runs (the registry's `AgentHostKind` for workers): the shared core's adapter kind. */
export type WorkerHostKind = WorkerAdapterKind;

/** A worker's state as every host reports it. */
export type WorkerState =
  | "running"        // a run is under way
  | "idle"           // a run ended and its report was handed over; a follow-up starts the next run
  | "reportPending"  // a run ended; its report has not reached the coordinator yet
  | "stopped"        // cancelled by the app or the coordinator
  | "failed"
  | "interrupted";   // it was running when its process (or the app) went away

export interface ProcessIdentity { pid: number; started: string }

/** The bot a worker was given to (the registry's owner), as its host keeps it in its journal. */
export interface WorkerOwner { botId: string; name: string; agentId: string }

export type WorkerOwnerResult = { ok: true } | { ok: false; reason: string };

/** What a coordinator's app tool call on a worker it no longer owns gets back. */
export const movedTaskError = (owner: string) => `This task now belongs to "${owner}"; the app routes its reports there. Do not message, wait for, cancel or checkpoint it.`;

/** Owners as journals keep them: three non-empty strings, else none. */
export function readWorkerOwner(value: unknown): WorkerOwner | undefined {
  const v = value as Partial<WorkerOwner> | null | undefined;
  return v && typeof v === "object" && typeof v.botId === "string" && v.botId && typeof v.name === "string" && typeof v.agentId === "string" && v.agentId
    ? { botId: v.botId, name: v.name.slice(0, 400), agentId: v.agentId } : undefined;
}

/** One worker, provider-neutral. */
export interface WorkerInfo {
  id: string;
  engine: Engine;
  name: string;
  run: number;
  state: WorkerState;
  /** Its own conversation: a Codex thread, an ACP session or a Claude session id (null: not known yet). */
  conversationId: string | null;
  /** Its own processes, when it has any (Codex threads live in the coordinator's app-server). */
  processes: ProcessIdentity[];
  /** The bot it was given to (null or absent: its coordinator's). */
  owner?: WorkerOwner | null;
}

/** What a follow-up did: joined the run under way (`steered`), or started the next run (`newRun`). */
export type WorkerSendResult =
  | { ok: true; how: "steered" | "newRun"; run: number }
  | { ok: false; reason: string; busy?: boolean };

/**
 * A host of app-managed workers. Every method addresses one worker by its task id; nothing here touches the
 * coordinator's own turn. In particular the coordinator's Stop (`interrupt`) never stops a worker: only
 * `stopWorker` (or the app quitting) does.
 */
export interface WorkerHost {
  readonly workerHostKind: WorkerHostKind;
  /** Whether a running worker takes words into its run (Codex `turn/steer`, Claude stdin); false: only between runs (ACP). */
  readonly steersRunning: boolean;
  /** Every worker it knows, newest last. */
  listWorkers(): WorkerInfo[];
  /** A follow-up: steers a running worker where the engine can, else starts its next run on an idle one. */
  sendToWorker(id: string, text: string): WorkerSendResult | Promise<WorkerSendResult>;
  /** Stops one worker; false when there is no such worker or it is not at work. No report is made. */
  stopWorker(id: string): Promise<boolean>;
  /**
   * Gives the worker to another bot (`owner`) or back to its coordinator (null). Never stops, restarts or re-prompts it.
   * With an owner, a report already waiting for the coordinator is pulled out and emitted as `workerReport`; refused only
   * while a report of it is being handed to the coordinator at this moment.
   */
  setWorkerOwner(id: string, owner: WorkerOwner | null): WorkerOwnerResult;
  /**
   * An approval card's answer (request id `worker:<task id>:<run>:<engine's id>`); false when no such approval is
   * open. Optional until every host is a WorkerCore (S4b makes it required).
   */
  answer?(requestId: string, allow: boolean, input: Record<string, unknown>, message?: string): boolean;
  /** Ends every worker's process (the app quitting): one at work is interrupted, never replayed. Optional until S4b. */
  close?(): Promise<void>;
}

export const isWorkerHost = (value: unknown): value is WorkerHost =>
  !!value && typeof value === "object" && typeof (value as WorkerHost).workerHostKind === "string"
  && typeof (value as WorkerHost).listWorkers === "function" && typeof (value as WorkerHost).sendToWorker === "function"
  && typeof (value as WorkerHost).setWorkerOwner === "function";

/** The subagent type a worker of this engine is listed with (`codex-worker`, `agy-worker`, `claude-worker`). */
export const workerType = (engine: Engine) => `${engine}-worker`;

/** Whether a subagent record of this type is an app-managed worker (any engine; the Maintainer's component editor too). */
export const isWorkerType = (type: string | null | undefined) =>
  type === "codex-worker" || type === "agy-worker" || type === "claude-worker" || type === "ccb-core:component-editor";

/** The host kind of a subagent record held by a head of `engine`: a worker's own, else the head's. */
export function workerHostKindFor(type: string | null | undefined, engine: Engine): WorkerHostKind | null {
  if (type === "claude-worker") return "claude-process";
  if (!isWorkerType(type)) return null;
  return engine === "agy" ? "agy-acp" : engine === "codex" ? "codex-thread" : null;
}

/** A worker host that runs each worker in its own process: the coordinator's sleep, restart or Stop leaves it be. */
export const ownProcessWorker = (type: string | null | undefined) => type === "claude-worker";

/** The items that open a worker's run (shared by every host that builds them itself). */
export function workerRunStarted(w: { id: string; engine: Engine; name: string; run: number; conversationId: string | null; ownerSessionId: string }, text: string, runtime: { reasoningEffort: string | null; model?: string | null }): CodexItem[] {
  const type = workerType(w.engine);
  return [
    { kind: "toolUse", id: w.id, tool: "Agent", title: `Delegate ${w.name}`, detail: text, parent: null, input: { description: w.name, prompt: text, subagent_type: type, run_in_background: true } },
    { kind: "subagentStarted", id: w.id, description: w.name, type, prompt: text, background: true, execution: { run: w.run, ownerSessionId: w.ownerSessionId, threadId: w.conversationId, turnId: null } },
    { kind: "subagentRuntime", id: w.id, runtime: { engine: w.engine, reasoningEffort: runtime.reasoningEffort }, ...(runtime.model ? { model: runtime.model } : {}) },
  ];
}
