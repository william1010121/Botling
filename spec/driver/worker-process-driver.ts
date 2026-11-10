// The one door spec tests use into a Claude worker's process (spec/models/worker/WorkerProcess.tla). An interface
// only: the app side implements it in desktop/spec-adapters/worker-process-adapter.ts on the real ClaudeWorkerAdapter.
// One worker; every method is one action of the model (same name, lower camel case) and resolves once the app has
// done everything the action sets off (its microtasks are flushed). The outside world (the `claude` processes, their
// background work, their trees, the clock) is the test's: the view reports it beside what the app did.
import type { View } from "../reference/worker-process";

export interface WorkerProcessSession {
  /** The core sends the next run's first words (a run of its own). */
  start(): Promise<void>;
  /** The core steers words into the run under way. */
  steer(): Promise<void>;
  /** The process ends the run's turn with a result. */
  result(): Promise<void>;
  /** The keep-alive timer runs out. */
  keepAliveFires(): Promise<void>;
  /** The process leaves a command running in the background. */
  bgStart(): Promise<void>;
  /** A background task started less than 6 hours ago ends. */
  bgEnd(): Promise<void>;
  /** Six hours pass: every background task running is old now. */
  age(): Promise<void>;
  /** The process's leader exits; `tree`: children of it outlive it. */
  procExit(tree: boolean): Promise<void>;
  /** The tree check (endTree) of the latest process that exited answers: killed and gone, or it outlived the kill. */
  treeChecked(ok: boolean): Promise<void>;
  /** The tree check of an earlier process answers, late. */
  olderChecked(): Promise<void>;
  /** What the latest exited process left behind ends on its own. */
  treeGone(): Promise<void>;
  /** The core stops the worker; `tree`: if a process is alive, its children outlive the kill's leader exit. */
  stop(tree: boolean): Promise<void>;
  view(): View;
  close(): Promise<void>;
}

export interface WorkerProcessDriver {
  open(): Promise<WorkerProcessSession>;
}
