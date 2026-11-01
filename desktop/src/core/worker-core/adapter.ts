// What an engine keeps (shared-core spec 4.1): its processes and protocol. Everything about a worker's state, text,
// end, report and approvals table is the core's; an adapter only starts, steers, stops and answers, and translates its
// engine's output into `WorkerEvent`s on the run's handle.
import type { Engine } from "../heads";
import type { RunHandle, WorkerAdapterKind } from "./events";
import type { WorkerLedgerRecord } from "./ledger";

/**
 * The union of the three coordinators' app_handoff arguments (claude-workers.ts, codex-tools.json, agy-mcp.ts): the
 * schemas stay as they are, the core accepts any of their names.
 */
export interface HandoffArgs {
  /** The task (`prompt` and `task` are the Agent tool's and models' own names for it). */
  instructions?: unknown; prompt?: unknown; task?: unknown;
  /** A short name (`description`: the Agent tool's). */
  name?: unknown; description?: unknown;
  subagent_type?: unknown;
  model?: unknown;
  engine?: unknown;
  [key: string]: unknown;
}

/** What the core read from HandoffArgs, for `prepare`. */
export interface HandoffRequest { instructions: string; name: string; type: string | null; model: string | null; engine: string | null; args: HandoffArgs }

/** Whether an interrupted worker's old processes / turns are gone. "blocked" keeps follow-ups refused, with the reason. */
export type RecoverResult = { state: "clean" } | { state: "blocked"; reason: string };

export interface WorkerAdapter {
  readonly kind: WorkerAdapterKind;
  readonly engine: Engine;
  /** Whether a running worker takes words into its run (Claude stdin, Codex turn/steer); false: only between runs (ACP). */
  readonly steersRunning: boolean;
  /** The subagent type its workers are listed with (default `<engine>-worker`; the component editor: its own). */
  readonly subagentType?: string;
  /**
   * A handoff's engine-specific checks (agent definition, model name), before anything is recorded or emitted.
   * Throws the refusal (nothing started). Returns the new worker's initial engineData, and its engine when it is not
   * the adapter's own (an Antigravity coordinator's Codex worker runs over ACP too).
   */
  prepare?(request: HandoffRequest): { engine?: Engine; engineData?: Record<string, unknown> } | void;
  /**
   * Start run `run.run` with these words (spawn, resume, or reuse a kept-alive process). Errors throw (nothing
   * started: a handoff is refused, a follow-up answered with the error). Events it emits before it returns are held
   * and follow the run's opening items. A failure after it started is an `end` (how "error" or "exited").
   */
  start(record: Readonly<WorkerLedgerRecord>, words: string, run: RunHandle): void | Promise<void>;
  /** Words into the run under way. false: it cannot take them now (the core answers busy). */
  steer?(record: Readonly<WorkerLedgerRecord>, words: string): boolean;
  /** End the run's turn/process. Must NOT emit `end` (the core already decided "stopped"). Also called for a worker not at work (a cancel): end anything it keeps alive. */
  stop(record: Readonly<WorkerLedgerRecord>): Promise<{ cleaned: boolean }>;
  /** An approval's answer (nativeId = the engine's own request id). */
  answer(record: Readonly<WorkerLedgerRecord>, nativeId: string, allow: boolean, input: Record<string, unknown>, message?: string): void;
  /** After an interruption: are its old processes / turns gone? */
  recover(record: Readonly<WorkerLedgerRecord>): RecoverResult | Promise<RecoverResult>;
  /**
   * After a run's `end`, before its report goes out: end the run's processes if the engine does (Antigravity). While it
   * runs the record has cleanup "pending" (still at work for idle checks); not cleaned: cleanup "failed".
   */
  cleanup?(record: Readonly<WorkerLedgerRecord>): Promise<{ cleaned: boolean }>;
  /** Whether starting a run of this worker takes one of `maxRunning`'s slots (default true; Claude: not into a kept-alive process). */
  needsSlot?(record: Readonly<WorkerLedgerRecord>): boolean;
  /** The runtime a run's opening items show (`subagentRuntime`). */
  runtime?(record: Readonly<WorkerLedgerRecord>): { reasoningEffort: string | null; model?: string | null };
  /** What a run under way needs to go on after an explicit restart (kept in its engineData before it is interrupted). */
  restartData?(record: Readonly<WorkerLedgerRecord>): Record<string, unknown>;
  /** End every process (app quitting). */
  close(): Promise<void>;
}
