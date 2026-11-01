// The one event stream every worker adapter speaks (shared-core spec 2.1). An adapter translates its engine's own
// protocol (claude stream-json, Codex app-server JSON-RPC, ACP) into these and hands them to `RunHandle.emit`; the
// core's `RunPipeline` turns them into the bot's items once, the same way for every engine.
import type { Engine } from "../heads";
import type { RequestEvent } from "../token-speed";
import type { RateLimits, TokenUsage } from "../usage";
import type { MeteredTurn } from "../token-flow-ledger";

export type { Engine };

/** Where a worker physically runs. workers.ts `WorkerHostKind` is an alias of this. */
export type WorkerAdapterKind = "claude-process" | "codex-thread" | "agy-acp" | "component-editor";

/** A measurement as an adapter sees it: the core stamps workerId / run / parentThreadId. */
export type AdapterMeasurement = Omit<MeteredTurn, "botId" | "head" | "taskId" | "workerId" | "run" | "parentThreadId">
  & { workerId?: string | null; parentThreadId?: string | null };

/** One normalized event of one run of one worker. Adapters emit ONLY these (through RunHandle.emit). */
export type WorkerEvent =
  /** The worker's own conversation is known (claude init, Codex thread id, ACP session id). */
  | { type: "session"; conversationId: string }
  /** A process of this run started (identity recorded for crash recovery). `started`: its start time when the adapter has it. */
  | { type: "process"; pid: number; started?: string }
  /** A chunk of the text block being written (claude text_delta, ACP agent_message_chunk). Cuts words and code spans. */
  | { type: "textDelta"; text: string }
  /** A whole message (claude assistantText, Codex agentMessage). phase "commentary": Codex words between tools. */
  | { type: "textWhole"; text: string; phase: "commentary" | "final" | null }
  /** The next text is a new block (claude textBlock). toolUse / toolResult / end also close the open block. */
  | { type: "textBreak" }
  | { type: "toolUse"; id: string; tool: string; title: string; detail: string; input: Record<string, unknown> }
  | { type: "toolResult"; id: string; output: string; failed: boolean }
  /** Tokens and dollars used since the adapter's previous usage event of this run: ALWAYS a delta, never a running total. */
  | { type: "usage"; tokens: TokenUsage; cost: number }
  /** One finished model request (token-speed.ts). The core sets scope = worker id. */
  | { type: "request"; request: Omit<RequestEvent, "scope"> }
  | { type: "measurement"; provider: "claude" | "codex"; measurement: AdapterMeasurement }
  /** An approval the engine asks. nativeId: the engine's own request id (the core builds worker:<task>:<run>:<nativeId>). */
  | { type: "permission"; nativeId: string; tool: string; summary: string; input: Record<string, unknown>; safetyCheck?: string; noAlways?: boolean }
  | { type: "permissionCancelled"; nativeId: string }
  | { type: "permissionDenied"; toolUseId: string; tool: string | null; reason: string; confirmed: boolean }
  | { type: "connectionLost" }
  | { type: "rateLimits"; engine: "claude" | "codex"; limits: RateLimits }
  /** The engine says this run's turn is over. Exactly one per run; later events of the run are dropped by the core. */
  | { type: "end"; end: RunEnd };

/** How the ENGINE says a turn ended. Stop / quit / crash never come from here (the core knows those itself). */
export interface RunEnd {
  how: "normal" | "error" | "cancelled" | "exited";
  /**
   * The engine's own final answer, when its protocol names one (claude result.result; Codex: the last non-commentary
   * agentMessage). null: the core uses the last text block it joined.
   */
  finalText: string | null;
  /** The engine's error words (how !== "normal"); stderr tail for "exited". */
  error: string | null;
  /** Engine code for logs only: claude subtype, Codex turn.status, ACP stopReason. classifyRun never reads it. */
  detail: string;
}

/** What an adapter is handed for one run. Events from a stale handle (an older run, or after the run ended) are ignored. */
export interface RunHandle {
  readonly workerId: string;
  readonly run: number;
  emit(event: WorkerEvent): void;
  /**
   * Merges engine-only data into the worker's record (`engineData`: a Codex turn id, a Claude model) and saves it.
   * Ignored once the handle is stale. The core never reads these keys.
   */
  setEngineData(patch: Record<string, unknown>): void;
}
