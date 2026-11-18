// A Claude worker's process state (`Proc`) and the two helpers that let go of what it keeps back. Moved out of
// claude-workers.ts as it was (the file's size gate); nothing here runs by itself.
import { BACKGROUND_WAIT_CAP_MS } from "./background-cap";
import type { RunHandle, WorkerLedgerRecord } from "../worker-core";
import type { HeadConfig } from "./head";
import type { StreamItem } from "./stream";
import type { ClaudeStreamEvents } from "./claude-worker-events";
import type { ClaudeWorkerHead } from "./claude-workers";

/** A worker's process and the run under way in it; everything else about the worker is the core's. */
export interface Proc {
  head?: ClaudeWorkerHead;
  /**
   * The process tree it must see gone before another process takes its session: the head's, kept after its leader
   * exits until the whole tree is confirmed gone (`endTree`).
   */
  tree?: ClaudeWorkerHead;
  /** The run under way (undefined: between runs, or stopped). */
  run?: RunHandle;
  /** The worker's record as the core keeps it (read only here). */
  record?: Readonly<WorkerLedgerRecord>;
  /** Words steered into the run whose turn has not started yet (command_lifecycle). */
  queued: Set<string>;
  /** Its stream as WorkerEvents (text blocks, spend), the same as the component editor's. */
  stream: ClaudeStreamEvents;
  settle?: ReturnType<typeof setTimeout>;
  pendingResult?: Extract<StreamItem, { kind: "result" }>;
  keepAlive?: ReturnType<typeof setTimeout>;
  /** The effort its process was started with (`--effort`; a run into the kept-alive process goes on at it). */
  effort?: string | null;
  /** The model its process was started with (`--model`; a run into the kept-alive process goes on with it). */
  model?: string | null;
  /** The config a run started with, for its opening items (null: it went into the kept-alive process). */
  opening?: { run: number; base: HeadConfig | null };
  /** What its process left running in the background (a command, a Monitor, an agent), by tool call. */
  background: Map<string, { kind: "command" | "monitor" | "agent"; title: string; since: number }>;
  /** The tool calls of its Monitor tool: a Monitor on a command starts a background shell task, told apart by its call. */
  monitorCalls?: Set<string>;
  /**
   * Its turn's report, kept back while its Monitor lives (2026-11-18): the run stays at work, its row says "Monitor running",
   * and the Monitor's wake turn goes on in the same run. The run ends with its next report once no Monitor lives, or when
   * the Monitor runs past its 50-minute cap, or its process ends.
   */
  monitorHold?: {
    result: Extract<StreamItem, { kind: "result" }>; timer?: ReturnType<typeof setTimeout>;
    /** A turn is under way since that report (the Monitor's wake turn, or a steered one): its result ends the run, not the timer. */
    turn?: boolean;
    /** What the timer waits for: the oldest live Monitor's cap, or the grace for a wake turn. */
    on?: "cap" | "grace";
  };
  /**
   * The oldest Monitor's cap ran out while a turn was under way (WorkerProcess.tla `capped`): the run's report has been
   * let go, only that turn's result is awaited. No Monitor, old or new, holds it again in this run, not after an API
   * retry either.
   */
  capped?: boolean;
  /**
   * The text of a good report that a later failure would otherwise take with it (a failed wake turn, or an API retry
   * that waits): carried to the run's end, where it goes out with the report that follows or with the failure.
   */
  carried?: string;
  /** Its head once the app closed its input (`finish`): nothing more can be written to it; it ends after its background work. */
  finishing?: ClaudeWorkerHead;
  finishingSince?: number;
  /** A run whose words wait for the finishing process to end: then a new process (`--resume`) takes them all. */
  held?: { run: RunHandle; record: Readonly<WorkerLedgerRecord>; words: string[]; since: number };
  /** How often the run under way was tried again after an API error that passes (api-retry.ts). */
  apiRetries?: number;
  /** The wait before the next try: the run stays at work, its row says so. */
  apiRetry?: ReturnType<typeof setTimeout>;
}

/** The report kept back for a Monitor is let go (the run ended or was stopped). */
export function clearHold(proc: Proc) {
  if (proc.monitorHold?.timer) clearTimeout(proc.monitorHold.timer);
  proc.monitorHold = undefined;
}

/** What a run's failure says of the good report it would have taken with it (the core puts the error first, then this). */
export const earlierReportText = (text: string) => `Its earlier report, held back for its Monitor:\n\n${text}`;

/** No try waits any more (the run ended, was stopped, or other words go on with it). */
export function clearApiRetry(proc: Proc) {
  if (proc.apiRetry) { clearTimeout(proc.apiRetry); proc.apiRetry = undefined; }
}

/** Background work started longer ago than this no longer keeps a worker's process past its keep-alive (the bots' rule). */
export const BACKGROUND_HOLDS_MS = 6 * 3600_000;
/** A Monitor holds its worker's report back no longer than the background cap (background-cap.ts) and a minute. */
export const MONITOR_HOLD_MS = BACKGROUND_WAIT_CAP_MS + 60_000;
/** After its last Monitor ended, the model is woken by it: the report waits this long for that turn to start (BOTLING_MONITOR_GRACE_MS: tests). */
export const monitorWakeGraceMs = () => { const ms = Number(process.env.BOTLING_MONITOR_GRACE_MS); return Number.isFinite(ms) && ms > 0 ? ms : 30_000; };

export const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
