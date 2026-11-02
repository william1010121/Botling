// The only door spec/tests/datalock.spec.test.ts uses into the app's data-folder lock (spec/models/datalock).
// An interface: desktop/spec-adapters/datalock-adapter.ts implements it.
// A call runs one core's whole operation (a claim, a self-check, an exit); every file-system step it takes is
// reported to the step listener, which may call the driver again, so other cores act (or this one dies) between
// any two steps.

/** A step the real code took, named as the model's action. */
export interface DataLockEvent {
  core: string;
  step: "Try" | "Ident" | "Look" | "Break" | "Check" | "Leave";
}

/** What can be seen on disk: the folder at the data path (0 first, one more per swap), and per folder whose record its lock holds. */
export interface DataLockObservation {
  gen: number;
  lock: (string | null)[];
}

/** Where a core is after a call: it writes, waits to claim again, is on its way out, or was killed. */
export type DataLockOutcome = "writing" | "wait" | "exit" | "dead";

export interface DataLockDriver {
  /** Listens to every step any core takes (null: stop listening). */
  onStep(listener: ((event: DataLockEvent) => void) | null): void;
  /** A new core starts and claims the folder (Start, then its claim). */
  start(core: string): DataLockOutcome;
  /** A waiting core claims again (Retry, then its claim). */
  retry(core: string): DataLockOutcome;
  /** A writing core's self-check (and its claim back, when the lock went missing). */
  check(core: string): DataLockOutcome;
  /** A core on its way out exits and lets go (Leave). */
  leave(core: string): void;
  /** The core is killed now; one in the middle of a call stops at its next step. */
  crash(core: string): void;
  /** A killed core's pid goes to a process started after its record was written. */
  reuse(core: string): void;
  /** The folder at the path is renamed aside and replaced: by a copy that carries the lock, or a fresh one. */
  swap(copy: boolean): void;
  observe(): DataLockObservation;
}

export interface DataLockDriverOptions {
  cores: readonly string[];
  /** How many swaps observe() reports folders for. */
  maxSwap: number;
  /** An empty folder to work in. */
  root: string;
}
