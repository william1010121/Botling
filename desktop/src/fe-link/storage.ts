// What the front end keeps durably (protocol v1 §13.2): the outbox, the origin epoch and its per-target counters, the
// stream cursors and every retired logId it was told of (§8.3, D50). Caches (snapshots, entries) are not here: they may
// be lost at any time and are rebuilt from the server.
//
// The storage interface is the one rule M2's phone storage must keep too: `write` resolves only once its operations are
// durable, all of them or none (D45: the IndexedDB storage resolves on its strict transaction's `complete`; the desktop
// storage after SQLite's COMMIT with `synchronous = FULL` and `fullfsync`). An item counts as in the outbox only after
// its write resolved. Pure TypeScript: no Node built-ins, no Electron, no core.
import type { Command } from "../contract";
import type { Cursor, LogId, OriginEpoch, Outcome, Slot } from "../protocol";

/** An outbox item's stored state. "delivered" and "not sent" items stay until settled or dismissed (§11.6, §13.4). */
export type ItemState = "waiting" | "held" | "delivered" | "not sent";

export interface OutboxItem {
  slot: Slot;
  cmd: Command;
  /** The bot cursor the front end showed, for acts on visible things (§11.5). */
  basis?: Cursor;
  createdAt: number;
  state: ItemState;
  /** The server that stored it (`held{at}`, §11.2). */
  heldAt?: string;
  outcome?: Outcome;
  /** The owner's incarnation and entry the outcome came from (`cmd.result{logId, seq}` or an outcome entry, D50). */
  from?: { logId: LogId; seq: number | null };
  /** A `cmd.retry` named this owner incarnation: re-send only once the owner's `srv:` stream is on it (D49). */
  retryInc?: LogId;
  /** The user asked to cancel it (`cancel{slot}` is sent again on every attach while it is unresolved). */
  cancel?: true;
  /** Delivered, then lost when the owner was restored: its outcome entry lies above the retired logId's kept seq (D50). */
  lost?: true;
  /** The slot it had before a slot conflict moved it to a newer epoch (§11.4). */
  movedFrom?: Slot;
}

/** A reader's position with the hash of the entry at it (the batch `prevHash` check, §8.1). */
export interface StoredCursor extends Cursor {
  hash: string | null;
}

export interface RetiredLog {
  logId: LogId;
  keptSeq: number;
}

export interface StoredState {
  /** Null in a fresh (or wiped) storage: the front end then makes a new epoch (§11.1, D32). */
  epoch: OriginEpoch | null;
  /** The next `n` per target, for the current epoch. */
  counters: Record<string, number>;
  items: OutboxItem[];
  cursors: Record<string, StoredCursor>;
  retired: Record<string, RetiredLog[]>;
}

export type StorageOp =
  /** A new counter store: sets the epoch and clears every counter. Items of older epochs stay. */
  | { op: "epoch"; epoch: OriginEpoch }
  | { op: "counter"; target: string; next: number }
  | { op: "put"; item: OutboxItem }
  | { op: "delete"; slot: Slot }
  | { op: "cursor"; stream: string; cursor: StoredCursor | null }
  /** Adds retired logIds of a stream (never removed: a reader never goes back to one, D50). */
  | { op: "retired"; stream: string; retired: RetiredLog[] };

export interface FeStorage {
  load(): Promise<StoredState>;
  /** Applies the operations atomically; resolves only once they are durable. A rejection means none was applied. */
  write(ops: readonly StorageOp[]): Promise<void>;
  close(): Promise<void>;
}

export function emptyState(): StoredState {
  return { epoch: null, counters: {}, items: [], cursors: {}, retired: {} };
}

const itemKey = (slot: Slot) => `${slot.originEpoch}\u0000${slot.target}\u0000${slot.n}`;

/** Applies operations to a plain state (the in-memory storage, and a check for other implementations). */
export function applyOps(state: StoredState, ops: readonly StorageOp[]): StoredState {
  const next: StoredState = structuredClone(state);
  const items = new Map(next.items.map((item) => [itemKey(item.slot), item]));
  for (const op of ops) {
    switch (op.op) {
      case "epoch": next.epoch = op.epoch; next.counters = {}; break;
      case "counter": next.counters[op.target] = op.next; break;
      case "put": items.set(itemKey(op.item.slot), structuredClone(op.item)); break;
      case "delete": items.delete(itemKey(op.slot)); break;
      case "cursor":
        if (op.cursor) next.cursors[op.stream] = { ...op.cursor };
        else delete next.cursors[op.stream];
        break;
      case "retired": {
        const list = next.retired[op.stream] ?? (next.retired[op.stream] = []);
        for (const old of op.retired) if (!list.some((known) => known.logId === old.logId)) list.push({ ...old });
        break;
      }
    }
  }
  next.items = [...items.values()];
  return next;
}

/**
 * Storage in memory, for tests. The same instance handed to a new link is a "restart" with the disk kept; a new
 * instance is a wiped storage. `gate` lets a test hold writes (not durable yet) or fail them.
 */
export class MemoryFeStorage implements FeStorage {
  private state: StoredState = emptyState();
  writes = 0;
  gate: (() => Promise<void>) | null = null;

  async load(): Promise<StoredState> {
    return structuredClone(this.state);
  }

  async write(ops: readonly StorageOp[]): Promise<void> {
    if (this.gate) await this.gate();
    else await Promise.resolve();
    this.state = applyOps(this.state, ops);
    this.writes += 1;
  }

  async close(): Promise<void> {}

  /** What is durable now (tests). */
  snapshot(): StoredState {
    return structuredClone(this.state);
  }
}

/**
 * Runs storage steps one at a time, in order. A step decides its operations when its turn comes (so decisions see every
 * earlier committed step), writes them, and changes memory (`commit`) only after the write is durable.
 */
export class SerialWriter {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: FeStorage) {}

  run<T>(step: () => { ops: StorageOp[]; commit: () => T } | null): Promise<T | undefined> {
    const result = this.tail.then(async () => {
      const decided = step();
      if (!decided) return undefined;
      if (decided.ops.length) await this.storage.write(decided.ops);
      return decided.commit();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Resolves when every step queued so far has finished. */
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}
