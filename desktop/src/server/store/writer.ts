// The single writer of server.db (protocol v1 §7.2, D41).
//
// - Group commit with no timer: when a command arrives and no commit is running or scheduled, a drain is scheduled
//   with `setImmediate`, i.e. right after the I/O callbacks of the current event-loop turn. A lone command therefore
//   commits at once, and every command that arrived in the same turn shares its transaction. The drain takes every
//   command already waiting, up to `maxBatch` (64), into one BEGIN IMMEDIATE … COMMIT and never waits for more.
//   `setImmediate` is a yield to the event loop, not a delay: nothing here calls setTimeout or setInterval.
//   (Not a microtask: a caller that awaits each command in a loop would then chain microtasks forever and starve
//   every I/O callback, the online backup's completion included.)
// - The commit in flight is the batch window: commands submitted while a batch runs (from a command, a hook, or I/O
//   that queued up while the synchronous commit blocked the event loop) wait in the queue, and the next drain takes
//   them all.
// - Each command runs inside its own SAVEPOINT; a command that throws rolls back to it and fails alone.
// - Every promise settles only after COMMIT returned. With synchronous = FULL and fullfsync = ON (connection.ts) COMMIT
//   returns once the WAL is flushed, so a resolved command is durable. If COMMIT itself fails, every command of the
//   batch is rejected with StoreCommitError and nothing of the batch is kept.
import type { Db } from "./sqlite";

export interface CommandContext {
  /** 1-based number of the transaction this command runs in. */
  batch: number;
  /** 0-based position of the command inside that transaction. */
  index: number;
}

/** A command must be synchronous: it runs inside the transaction and its effects are what commits. */
export type Command<T> = (db: Db, context: CommandContext) => T;

export interface BatchInfo {
  batch: number;
  size: number;
  failed: number;
  committed: boolean;
  /** Milliseconds from BEGIN to the end of COMMIT. */
  ms: number;
}

export interface WriterOptions {
  maxBatch?: number;
  /** Called after each transaction ends (committed or not), before the promises settle. */
  onBatch?: (info: BatchInfo) => void;
  /** Test seam: runs after the last command of a batch, before COMMIT. */
  beforeCommit?: (batch: number) => void;
}

export class StoreCommitError extends Error {
  constructor(readonly cause: unknown) {
    super(`server.db: commit failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "StoreCommitError";
  }
}

export class WriterClosedError extends Error {
  constructor() { super("server.db writer is closed"); this.name = "WriterClosedError"; }
}

interface Pending {
  run: Command<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export const MAX_BATCH = 64;

export class Writer {
  private readonly queue: Pending[] = [];
  private readonly maxBatch: number;
  private scheduled = false;
  private running = false;
  private closed = false;
  private batches = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly db: Db, private readonly options: WriterOptions = {}) {
    this.maxBatch = Math.max(1, Math.min(options.maxBatch ?? MAX_BATCH, MAX_BATCH));
  }

  get queued(): number { return this.queue.length; }
  get committing(): boolean { return this.running; }
  get batchCount(): number { return this.batches; }

  submit<T>(run: Command<T>): Promise<T> {
    if (this.closed) return Promise.reject(new WriterClosedError());
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run, resolve: resolve as (value: unknown) => void, reject });
      if (!this.running && !this.scheduled) {
        this.scheduled = true;
        setImmediate(() => this.drain());
      }
    });
  }

  /** Resolves once the queue is empty and no batch is running. */
  idle(): Promise<void> {
    if (!this.running && !this.scheduled && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Refuses new commands and resolves after everything already submitted has settled. */
  async close(): Promise<void> {
    this.closed = true;
    await this.idle();
  }

  private drain(): void {
    this.scheduled = false;
    if (this.running || this.queue.length === 0) return this.notifyIdle();
    this.running = true;
    const batch = this.queue.splice(0, this.maxBatch);
    const number = ++this.batches;
    const outcomes: Array<{ ok: true; value: unknown } | { ok: false; error: unknown }> = [];
    const started = performance.now();
    let commitError: unknown = null;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      batch.forEach((pending, index) => outcomes.push(this.runOne(pending, { batch: number, index })));
      this.options.beforeCommit?.(number);
      this.db.exec("COMMIT");
    } catch (error) {
      commitError = error;
      try { if (this.db.inTransaction) this.db.exec("ROLLBACK"); } catch { /* the connection reports its own state */ }
    }
    const failed = commitError ? batch.length : outcomes.filter((outcome) => !outcome.ok).length;
    try {
      this.options.onBatch?.({ batch: number, size: batch.length, failed, committed: !commitError, ms: performance.now() - started });
    } catch { /* an observer must not break acknowledgements */ }
    this.running = false;
    batch.forEach((pending, index) => {
      if (commitError) return pending.reject(new StoreCommitError(commitError));
      const outcome = outcomes[index];
      if (outcome.ok) pending.resolve(outcome.value);
      else pending.reject(outcome.error);
    });
    if (this.queue.length > 0) {
      this.scheduled = true;
      setImmediate(() => this.drain());
    } else {
      this.notifyIdle();
    }
  }

  private runOne(pending: Pending, context: CommandContext): { ok: true; value: unknown } | { ok: false; error: unknown } {
    this.db.exec("SAVEPOINT cmd");
    try {
      const value = pending.run(this.db, context);
      if (value && typeof (value as PromiseLike<unknown>).then === "function") {
        (value as Promise<unknown>).then(undefined, () => {}); // never left unhandled
        throw new TypeError("a server.db command must be synchronous (it returned a promise)");
      }
      if (!this.db.inTransaction) throw new StoreCommitError(new Error("a command ended the transaction"));
      this.db.exec("RELEASE cmd");
      return { ok: true, value };
    } catch (error) {
      // A command that ended the transaction itself breaks the batch: rethrow so the whole batch fails.
      if (!this.db.inTransaction) throw error;
      this.db.exec("ROLLBACK TO cmd");
      this.db.exec("RELEASE cmd");
      return { ok: false, error };
    }
  }

  private notifyIdle(): void {
    if (this.running || this.scheduled || this.queue.length) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
