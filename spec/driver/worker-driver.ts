// The one door spec tests use into the app for the worker model (spec/models/worker). An interface only: the app
// side implements it in desktop/spec-adapters/worker-adapter.ts. Workers are slots 0..n-1 in handoff order. Every
// method is one action of the model (same name, lower camel case) and resolves once the app has done everything the
// action sets off without waiting on the engine or the coordinator (its microtasks are flushed).
import type { Ack, Chip, Report, Status } from "../reference/worker";

/** What the app shows of one worker: its ledger record, the chip projection, and what the test's engine and port saw. */
export interface WorkerView {
  status: Status;
  run: number;
  report: Report;
  attempts: number;
  cleanup: "none" | "pending" | "failed";
  recovery: boolean;
  owned: boolean;
  /** status.ts chipStatus of the record. */
  chip: Chip;
  /** An operation holds the worker (an answer from the engine is awaited). */
  busy: boolean;
  /** A process of a run the app ended is still alive (the engine's own account). */
  stale: boolean;
  /** Times the coordinator was shown this run's report (the port took it, or a report turn began). */
  shown: number;
}

/** Recorded claude stream-json output (spec/fixtures/worker-streams), played as a run's output. */
export interface WorkerStreams {
  /** A run that ends normally with a reply (End "done"). */
  done: string[];
  /** A run whose process dies before its report (End "failed"). */
  failed: string[];
}

export interface WorkerSession {
  handoff(w: number): Promise<void>;
  /** The engine's start of the worker's run returns. */
  startDone(w: number): Promise<void>;
  send(w: number): Promise<void>;
  steer(w: number): Promise<void>;
  /** The engine answers the recovery check: clean exactly when its old process is gone. */
  recoverDone(w: number): Promise<void>;
  stopWorker(w: number): Promise<void>;
  cancel(w: number): Promise<void>;
  /** The engine's stop answers: ok, the process tree is confirmed gone; not ok, it outlived the kill. */
  stopDone(w: number, ok: boolean): Promise<void>;
  /** The engine plays the run's recorded stream to its end. */
  end(w: number, v: "done" | "failed"): Promise<void>;
  /** A process of a run the app ended exits on its own. */
  exit(w: number): Promise<void>;
  /** The core offers pending reports again and the port answers this worker's with `how` (others: busy). */
  deliver(w: number, how: "taken" | "queued"): Promise<void>;
  beginReport(w: number): Promise<void>;
  finishReport(w: number, completed: boolean): Promise<void>;
  retryUncertain(w: number): Promise<void>;
  checkpoint(w: number): Promise<void>;
  setOwner(w: number): Promise<void>;
  /** The app goes away and starts again on the same ledger. */
  crash(): Promise<void>;
  /** null: no handoff yet. */
  view(w: number): WorkerView | null;
  close(): Promise<void>;
}

export interface WorkerSpecDriver {
  open(options: { ack: Ack; streams: WorkerStreams }): Promise<WorkerSession>;
}
