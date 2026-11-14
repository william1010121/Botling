// The phone and browser front end's durable storage (protocol v1 §13.2, D45): one IndexedDB database whose name starts
// with `botling3-` (the 3.x page's own storage names, beside the 2.x page's).
//
// D45: every `write` is one `readwrite` transaction over all stores with `{ durability: "strict" }`, and it resolves only
// on that transaction's `complete` (WebKit fires it after the commit, for a strict transaction after a full checkpoint;
// Chromium flushes before it). So an item counts as in the outbox only after `complete`, and a write is all or nothing:
// an operation that throws, or a request that fails, aborts the transaction and the promise rejects with none applied.
// Never the synchronous web key-value store (a SIGKILL lost it in 5 of 5 M0 runs). Pure TypeScript over the DOM IndexedDB API: no Node
// built-ins, no Electron, no core; exported from fe-link/index.ts so the page can use it.
import type { Slot } from "../protocol";
import { emptyState, type FeStorage, type OutboxItem, type RetiredLog, type StorageOp, type StoredCursor, type StoredState } from "./storage";

/** Every IndexedDB database of Botling 3 starts with this. */
export const IDB_PREFIX = "botling3-";
/** The front end's outbox, counters, cursors and retired logIds. */
export const DEFAULT_IDB_NAME = `${IDB_PREFIX}fe`;
const VERSION = 1;

const META = "meta";
const COUNTERS = "counters";
const OUTBOX = "outbox";
const CURSORS = "cursors";
const RETIRED = "retired";
const STORES = [META, COUNTERS, OUTBOX, CURSORS, RETIRED];
const EPOCH_KEY = "epoch";

const slotKey = (slot: Slot): IDBValidKey => [slot.originEpoch, slot.target, slot.n];

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("fe storage: request failed"));
  });
}

export interface IdbFeStorageOptions {
  /** The database name (default `botling3-fe`); must start with `botling3-`. */
  name?: string;
  /** The IndexedDB factory (default `globalThis.indexedDB`). */
  factory?: IDBFactory;
}

export class IdbFeStorage implements FeStorage {
  private closed = false;

  private constructor(private readonly db: IDBDatabase, readonly name: string) {
    // A delete or upgrade from another tab must not wait on this connection: close it, later writes reject.
    db.onversionchange = () => { this.closed = true; db.close(); };
  }

  static async open(options: IdbFeStorageOptions = {}): Promise<IdbFeStorage> {
    const name = options.name ?? DEFAULT_IDB_NAME;
    if (!name.startsWith(IDB_PREFIX)) throw new Error(`fe storage: IndexedDB name ${JSON.stringify(name)} does not start with ${IDB_PREFIX}`);
    const factory = options.factory ?? globalThis.indexedDB;
    if (!factory) throw new Error("fe storage: IndexedDB is not available");
    const req = factory.open(name, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of [META, COUNTERS, CURSORS, RETIRED]) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX);
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("fe storage: open failed"));
      req.onblocked = () => reject(new Error(`fe storage: opening ${name} is blocked by another connection`));
    });
    return new IdbFeStorage(db, name);
  }

  /** Deletes a Botling 3 database (a wiped storage; the next open makes a new origin epoch, D32). */
  static async wipe(name = DEFAULT_IDB_NAME, factory: IDBFactory = globalThis.indexedDB): Promise<void> {
    if (!name.startsWith(IDB_PREFIX)) throw new Error(`fe storage: IndexedDB name ${JSON.stringify(name)} does not start with ${IDB_PREFIX}`);
    await request(factory.deleteDatabase(name) as IDBRequest<unknown>);
  }

  async load(): Promise<StoredState> {
    this.assertOpen();
    const tx = this.db.transaction(STORES, "readonly");
    const keysAndValues = async (store: string) => {
      const s = tx.objectStore(store);
      const [keys, values] = await Promise.all([request(s.getAllKeys()), request(s.getAll())]);
      return keys.map((key, i) => [key, values[i]] as const);
    };
    const [epoch, counters, items, cursors, retired] = await Promise.all([
      request(tx.objectStore(META).get(EPOCH_KEY)),
      keysAndValues(COUNTERS),
      request(tx.objectStore(OUTBOX).getAll()) as Promise<OutboxItem[]>,
      keysAndValues(CURSORS),
      keysAndValues(RETIRED),
    ]);
    const state = emptyState();
    state.epoch = typeof epoch === "string" ? epoch : null;
    for (const [target, next] of counters) state.counters[String(target)] = Number(next);
    state.items = items; // key order: epoch, target, n (as the SQLite storage's ORDER BY)
    for (const [stream, cursor] of cursors) state.cursors[String(stream)] = cursor as StoredCursor;
    for (const [stream, list] of retired) state.retired[String(stream)] = list as RetiredLog[];
    return state;
  }

  write(ops: readonly StorageOp[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        this.assertOpen();
        tx = this.db.transaction(STORES, "readwrite", { durability: "strict" });
      } catch (error) {
        reject(error);
        return;
      }
      let failure: unknown = null;
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("fe storage: transaction aborted"));
      tx.onerror = () => { failure ??= tx.error; };
      try {
        const meta = tx.objectStore(META);
        const counters = tx.objectStore(COUNTERS);
        const outbox = tx.objectStore(OUTBOX);
        const cursors = tx.objectStore(CURSORS);
        // Retired logIds are read, merged and written once per stream, after the reads, in operation order.
        const retired = new Map<string, RetiredLog[]>();
        for (const op of ops) {
          switch (op.op) {
            case "epoch":
              meta.put(op.epoch, EPOCH_KEY);
              counters.clear();
              break;
            case "counter":
              counters.put(op.next, op.target);
              break;
            case "put":
              outbox.put(op.item, slotKey(op.item.slot));
              break;
            case "delete":
              outbox.delete(slotKey(op.slot));
              break;
            case "cursor":
              if (op.cursor) cursors.put({ logId: op.cursor.logId, seq: op.cursor.seq, hash: op.cursor.hash }, op.stream);
              else cursors.delete(op.stream);
              break;
            case "retired": {
              const list = retired.get(op.stream) ?? [];
              list.push(...op.retired.map((old) => ({ logId: old.logId, keptSeq: old.keptSeq })));
              retired.set(op.stream, list);
              break;
            }
            default:
              throw new Error(`fe storage: unknown operation ${JSON.stringify((op as { op?: unknown }).op)}`);
          }
        }
        const store = tx.objectStore(RETIRED);
        for (const [stream, added] of retired) {
          const get = store.get(stream);
          get.onsuccess = () => {
            try {
              const list: RetiredLog[] = Array.isArray(get.result) ? get.result : [];
              for (const old of added) if (!list.some((known) => known.logId === old.logId)) list.push(old);
              store.put(list, stream);
            } catch (error) {
              failure ??= error;
              tx.abort();
            }
          };
        }
      } catch (error) {
        failure = error;
        try { tx.abort(); } catch { /* already finished */ }
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("fe storage: closed");
  }
}
