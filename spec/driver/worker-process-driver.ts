// The one door spec tests use into a Claude worker's process (spec/models/worker/WorkerProcess.tla). An interface
// only: the app side implements it in desktop/spec-adapters/worker-process-adapter.ts on the real ClaudeWorkerAdapter.
// One worker; every method is one action of the model (same name, lower camel case) and resolves once the app has
// done everything the action sets off (its microtasks are flushed). The outside world (the `claude` processes, their
// background work and Monitors, their turns, their trees, the clock) is the test's: the view reports it beside what
// the app did.
import type { View } from "../reference/worker-process";

export interface WorkerProcessSession {
  /** The core sends the next run's first words (a run of its own). */
  start(): Promise<void>;
  /** The core steers words into the run under way. */
  steer(): Promise<void>;
  /** The process ends a turn with its result: a report (`ok`, its own words), or an error. */
  result(ok: boolean): Promise<void>;
  /** While the run's report is kept for a Monitor, a turn begins in the process (a Monitor's event woke the model). */
  wakeTurn(): Promise<void>;
  /** The keep-alive timer runs out. */
  keepAliveFires(): Promise<void>;
  /** The process leaves a command running in the background. */
  bgStart(): Promise<void>;
  /** A background command started less than 6 hours ago ends. */
  bgEnd(): Promise<void>;
  /** Six hours pass: every background task running is old now (no Monitor is live by then). */
  age(): Promise<void>;
  /** The process starts a Monitor (a Monitor tool call on a command, or a Monitor on a socket or MCP server). */
  monStart(): Promise<void>;
  /** A live Monitor (started less than the background cap and a minute ago) ends. */
  monEnd(): Promise<void>;
  /** A Monitor past the cap and a minute, started less than 6 hours ago, ends. */
  oldEnd(): Promise<void>;
  /** The oldest live Monitor runs past the cap and a minute (the app's timers due by then fire). */
  monExpire(): Promise<void>;
  /** The grace a kept report waits for a Monitor's wake turn runs out. */
  graceFires(): Promise<void>;
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
  /** The app closes (its workers' adapter `close`); `tree`: as for stop. */
  appClose(tree: boolean): Promise<void>;
  view(): View;
  close(): Promise<void>;
}

export interface WorkerProcessDriver {
  open(): Promise<WorkerProcessSession>;
}
