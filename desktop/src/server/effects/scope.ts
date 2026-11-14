// The transaction scope of the intent and effect code: a wrapper around the store's `submit` that knows, while a
// writer command runs, which transaction it is (`tx`), which streams it appended to, and what must happen only once it
// committed (`afterCommit`). After the commit: readers of the touched streams are told (`LogHub.committed`), then the
// actions run in order. A command that fails (it threw, or the batch did not commit) runs none of them; its
// `onRollback` actions run instead.
//
// Synchronous code called from inside a command (the core's handlers in `Core.applyNow`, the event tap, the
// `deferTurn` hook) asks `scope.tx` to write into the command's own transaction instead of a new one.
import type { StreamId } from "../../protocol";
import type { Command, Db } from "../store";

export interface Submitter {
  submit<T>(command: Command<T>): Promise<T>;
}

interface Frame {
  tx: Db;
  streams: Set<StreamId>;
  actions: Array<() => void>;
  undo: Array<() => void>;
}

export class TxScope {
  private current: Frame | null = null;
  private readonly enters: Array<(tx: Db) => void> = [];

  constructor(
    private readonly store: Submitter,
    private readonly committed: (streams: ReadonlySet<StreamId>) => void = () => {},
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  /** The transaction of the writer command running now, or null outside one. */
  get tx(): Db | null {
    return this.current?.tx ?? null;
  }

  submit<T>(command: Command<T>): Promise<T> {
    let frame: Frame | null = null;
    return this.store.submit((tx, context) => {
      const outer = this.current;
      frame = { tx, streams: new Set(), actions: [], undo: [] };
      this.current = frame;
      try {
        for (const enter of this.enters) enter(tx);
        return command(tx, context);
      } finally {
        this.current = outer;
      }
    }).then((value) => {
      const done = frame!;
      if (done.streams.size) this.safely(() => this.committed(done.streams));
      for (const action of done.actions) this.safely(action);
      return value;
    }, (error: unknown) => {
      // The command's writes were rolled back (it threw, or its batch did not commit).
      if (frame) for (const undo of frame.undo) this.safely(undo);
      throw error;
    });
  }

  /**
   * Runs `enter` at the start of every command submitted through this scope, inside it (the event tap stores the
   * engine's events that arrived outside a command first, so every entry keeps the order the engine emitted it in).
   */
  onEnter(enter: (tx: Db) => void): void {
    this.enters.push(enter);
  }

  /** `stream` got entries in the running command. */
  touch(stream: StreamId): void {
    this.require("touch").streams.add(stream);
  }

  /** Runs `action` once the running command committed (never if it does not). */
  afterCommit(action: () => void): void {
    this.require("afterCommit").actions.push(action);
  }

  /** Runs `undo` if the running command's writes are rolled back instead (memory that assumed they would commit). */
  onRollback(undo: () => void): void {
    this.require("onRollback").undo.push(undo);
  }

  private require(what: string): Frame {
    if (!this.current) throw new Error(`TxScope.${what}: no writer command is running`);
    return this.current;
  }

  private safely(run: () => void): void {
    try { run(); } catch (error) { this.onError(error); }
  }
}
