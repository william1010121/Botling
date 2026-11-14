// The durable outbox (protocol v1 §11.1, §11.2, §11.4, §11.6, §13.2, §13.4): numbered commands per (originEpoch,
// target), the floor each send carries, and the delivery state of every item. Every change is written through the
// SerialWriter and reaches memory only once durable, so what the UI shows never runs ahead of the disk.
//
// Rules:
// - `n` starts at 1 per (originEpoch, target) and is gapless: it is taken when the item's write runs, and kept only if
//   the write succeeds.
// - `floor` = the smallest n still unresolved (waiting or held) in the item's (epoch, target) queue.
// - An outcome resolves an item once: applied → "delivered" (kept until the stream shows its entry, then removed);
//   refused / cancelled / skipped → "not sent" (kept until dismissed). Later copies of the outcome change nothing.
// - `refused{slot conflict}` (a cloned or reset origin, §11.4): the item moves to a new epoch (made once per conflict
//   wave: only a conflict on an item of the current epoch makes one) and is re-sent there. Only the refused item moves:
//   others of the old epoch may have been applied and keep their slots until their own outcome comes.
// - `cmd.retry{inc}` (D49): the item is re-sent once the owner's `srv:` stream is on that inc.
// - A `reset` marks delivered items whose outcome entry lies above the retired logId's kept seq as lost (D50).
import type { Command } from "../contract";
import { slotKey, type CmdBody, type Cursor, type LogId, type OriginEpoch, type Outcome, type Slot, type Target } from "../protocol";
import type { OutboxItem, RetiredLog, SerialWriter, StorageOp, StoredState } from "./storage";

export type ResolveResult =
  | { kind: "delivered"; item: OutboxItem }
  | { kind: "not sent"; item: OutboxItem }
  | { kind: "moved"; item: OutboxItem; from: Slot };

const unresolved = (item: OutboxItem) => item.state === "waiting" || item.state === "held";

export function randomEpoch(): OriginEpoch {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Outbox {
  private epochValue: OriginEpoch;
  private counters: Map<string, number>;
  private readonly items = new Map<string, OutboxItem>();

  private constructor(
    private readonly origin: string,
    state: StoredState & { epoch: OriginEpoch },
    private readonly writer: SerialWriter,
    private readonly newEpoch: () => OriginEpoch,
    private readonly now: () => number,
  ) {
    this.epochValue = state.epoch;
    this.counters = new Map(Object.entries(state.counters));
    for (const item of state.items) this.items.set(slotKey(item.slot), item);
  }

  /** Opens the outbox on loaded state; a storage with no epoch (fresh or wiped) gets a new one first (D32). */
  static async open(options: { origin: string; state: StoredState; writer: SerialWriter; newEpoch?: () => OriginEpoch; now: () => number }): Promise<Outbox> {
    const newEpoch = options.newEpoch ?? randomEpoch;
    let state = options.state;
    if (!state.epoch) {
      const epoch = newEpoch();
      await options.writer.run(() => ({ ops: [{ op: "epoch", epoch }], commit: () => undefined }));
      state = { ...state, epoch, counters: {} };
    }
    return new Outbox(options.origin, state as StoredState & { epoch: OriginEpoch }, options.writer, newEpoch, options.now);
  }

  get epoch(): OriginEpoch { return this.epochValue; }

  /** The next n for a target in the current epoch. */
  nextN(target: Target): number { return this.counters.get(target) ?? 1; }

  get(key: string): OutboxItem | null { return this.items.get(key) ?? null; }

  list(): OutboxItem[] {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt || (a.slot.originEpoch < b.slot.originEpoch ? -1 : a.slot.originEpoch > b.slot.originEpoch ? 1 : 0) || a.slot.n - b.slot.n);
  }

  /** Unresolved items, each (epoch, target) queue in slot order, older queues first (what is (re-)sent). */
  unresolved(): OutboxItem[] {
    const queues = new Map<string, OutboxItem[]>();
    for (const item of this.items.values()) {
      if (!unresolved(item)) continue;
      const key = `${item.slot.originEpoch}\u0000${item.slot.target}`;
      const list = queues.get(key);
      if (list) list.push(item); else queues.set(key, [item]);
    }
    const ordered = [...queues.values()].map((list) => list.sort((a, b) => a.slot.n - b.slot.n));
    ordered.sort((a, b) => Math.min(...a.map((i) => i.createdAt)) - Math.min(...b.map((i) => i.createdAt)));
    return ordered.flat();
  }

  floor(item: OutboxItem): number {
    let floor = item.slot.n;
    for (const other of this.items.values()) {
      if (unresolved(other) && other.slot.originEpoch === item.slot.originEpoch && other.slot.target === item.slot.target && other.slot.n < floor) floor = other.slot.n;
    }
    return floor;
  }

  envelope(item: OutboxItem, inc: LogId): CmdBody {
    return { slot: item.slot, floor: this.floor(item), inc, cmd: item.cmd, ...(item.basis ? { basis: item.basis } : {}) } as CmdBody;
  }

  /** Writes a new item; resolves with it once durable (only then does it count as in the outbox, D45). */
  async submit(target: Target, cmd: Command, basis?: Cursor): Promise<OutboxItem> {
    const item = await this.writer.run(() => {
      const n = this.nextN(target);
      const slot: Slot = { origin: this.origin, originEpoch: this.epochValue, target, n };
      const created: OutboxItem = { slot, cmd, ...(basis ? { basis } : {}), createdAt: this.now(), state: "waiting" };
      return {
        ops: [{ op: "put", item: created }, { op: "counter", target, next: n + 1 }],
        commit: () => { this.items.set(slotKey(slot), created); this.counters.set(target, n + 1); return created; },
      };
    });
    return item!;
  }

  /** A new epoch for new slots (welcome.next says the owner is past this store's counters, §11.4). */
  rotateEpoch(): Promise<OriginEpoch | undefined> {
    return this.writer.run(() => {
      const epoch = this.newEpoch();
      return { ops: [{ op: "epoch", epoch }], commit: () => { this.epochValue = epoch; this.counters = new Map(); return epoch; } };
    });
  }

  held(slot: Slot, at: string): Promise<OutboxItem | undefined> {
    return this.change(slot, (item) => (item.state === "waiting" ? { ...item, state: "held", heldAt: at } : null));
  }

  retry(slot: Slot, inc: LogId): Promise<OutboxItem | undefined> {
    return this.change(slot, (item) => (unresolved(item) && item.retryInc !== inc ? { ...item, retryInc: inc } : null));
  }

  requestCancel(slot: Slot): Promise<OutboxItem | undefined> {
    return this.change(slot, (item) => (unresolved(item) && !item.cancel ? { ...item, cancel: true } : null));
  }

  /** The slot's outcome (from `cmd.result` or an outcome entry). Undefined when it changes nothing. */
  resolve(slot: Slot, outcome: Outcome, from: { logId: LogId; seq: number | null }): Promise<ResolveResult | undefined> {
    return this.writer.run(() => {
      const key = slotKey(slot);
      const item = this.items.get(key);
      if (!item || !unresolved(item)) return null;
      if (outcome.kind === "refused" && outcome.reason === "slot conflict") {
        const ops: StorageOp[] = [];
        let epoch = this.epochValue;
        let counters = this.counters;
        if (item.slot.originEpoch === epoch) {
          epoch = this.newEpoch();
          counters = new Map();
          ops.push({ op: "epoch", epoch });
        }
        const n = counters.get(slot.target) ?? 1;
        const moved: OutboxItem = { slot: { ...item.slot, originEpoch: epoch, n }, cmd: item.cmd, ...(item.basis ? { basis: item.basis } : {}), createdAt: item.createdAt, state: "waiting", ...(item.cancel ? { cancel: true as const } : {}), movedFrom: item.slot };
        ops.push({ op: "delete", slot: item.slot }, { op: "put", item: moved }, { op: "counter", target: slot.target, next: n + 1 });
        return {
          ops,
          commit: (): ResolveResult => {
            this.epochValue = epoch;
            counters.set(slot.target, n + 1);
            this.counters = counters;
            this.items.delete(key);
            this.items.set(slotKey(moved.slot), moved);
            return { kind: "moved", item: moved, from: item.slot };
          },
        };
      }
      const { retryInc: _retry, heldAt: _held, ...rest } = item;
      const done: OutboxItem = { ...rest, ...(item.heldAt ? { heldAt: item.heldAt } : {}), state: outcome.kind === "applied" ? "delivered" : "not sent", outcome, from };
      return { ops: [{ op: "put", item: done }], commit: (): ResolveResult => { this.items.set(key, done); return { kind: done.state === "delivered" ? "delivered" : "not sent", item: done }; } };
    });
  }

  /** Slots `from`…`to` of a queue were skipped by the owner (a `cmd.skipped` entry, §11.3). */
  skipped(queue: { originEpoch: OriginEpoch; target: Target }, from: number, to: number, at: { logId: LogId; seq: number }): Promise<OutboxItem[] | undefined> {
    return this.writer.run(() => {
      const changed: OutboxItem[] = [];
      for (const item of this.items.values()) {
        if (item.slot.originEpoch !== queue.originEpoch || item.slot.target !== queue.target || item.slot.n < from || item.slot.n > to) continue;
        if (unresolved(item)) {
          const { retryInc: _r, ...rest } = item;
          changed.push({ ...rest, state: "not sent", outcome: { kind: "skipped" }, from: at });
        } else if (item.state === "delivered" && !item.lost) {
          changed.push({ ...item, lost: true });
        }
      }
      if (!changed.length) return null;
      return { ops: changed.map((item) => ({ op: "put" as const, item })), commit: () => { for (const item of changed) this.items.set(slotKey(item.slot), item); return changed; } };
    });
  }

  /** A reset retired logIds of a target stream: delivered items above the kept seq were lost (D50). */
  markLost(target: Target, retired: RetiredLog[]): Promise<OutboxItem[] | undefined> {
    return this.writer.run(() => {
      const kept = new Map(retired.map((old) => [old.logId, old.keptSeq]));
      const changed: OutboxItem[] = [];
      for (const item of this.items.values()) {
        if (item.slot.target !== target || item.state !== "delivered" || item.lost || !item.from || item.from.seq === null) continue;
        const keptSeq = kept.get(item.from.logId);
        if (keptSeq !== undefined && item.from.seq > keptSeq) changed.push({ ...item, lost: true });
      }
      if (!changed.length) return null;
      return { ops: changed.map((item) => ({ op: "put" as const, item })), commit: () => { for (const item of changed) this.items.set(slotKey(item.slot), item); return changed; } };
    });
  }

  /**
   * Delivered items that already left the outbox (settled: their line was shown), whose outcome entry a reset of
   * `target` has now taken away (above the retired logId's kept seq, D50): written back as "delivered, then lost", so
   * the UI can say so (M3 step 11; the line itself is gone with the snap). Items the outbox holds are left to markLost.
   */
  reviveLost(target: Target, retired: RetiredLog[], settled: OutboxItem[]): Promise<OutboxItem[] | undefined> {
    return this.writer.run(() => {
      const kept = new Map(retired.map((old) => [old.logId, old.keptSeq]));
      const back: OutboxItem[] = [];
      for (const item of settled) {
        if (item.slot.target !== target || this.items.has(slotKey(item.slot)) || !item.from || item.from.seq === null) continue;
        const keptSeq = kept.get(item.from.logId);
        if (keptSeq !== undefined && item.from.seq > keptSeq) back.push({ ...item, state: "delivered", lost: true });
      }
      if (!back.length) return null;
      return { ops: back.map((item) => ({ op: "put" as const, item })), commit: () => { for (const item of back) this.items.set(slotKey(item.slot), item); return back; } };
    });
  }

  /**
   * Removes delivered items whose outcome entry the reader now has (the entry took the pending item's place, §13.4), or
   * every delivered item of the target when `all` (the stream is not followed, so nothing will show the entry).
   */
  settle(target: Target, cursor: Cursor | null, all = false): Promise<OutboxItem[] | undefined> {
    return this.writer.run(() => {
      const gone = [...this.items.values()].filter((item) => item.slot.target === target && item.state === "delivered" && !item.lost && item.from
        && (all || (cursor !== null && item.from.logId === cursor.logId && item.from.seq !== null && item.from.seq <= cursor.seq)));
      if (!gone.length) return null;
      return { ops: gone.map((item) => ({ op: "delete" as const, slot: item.slot })), commit: () => { for (const item of gone) this.items.delete(slotKey(item.slot)); return gone; } };
    });
  }

  /** The UI is done with a resolved item ("not sent", or "delivered, then lost"). */
  dismiss(slot: Slot): Promise<boolean | undefined> {
    return this.writer.run(() => {
      const item = this.items.get(slotKey(slot));
      if (!item || unresolved(item)) return null;
      return { ops: [{ op: "delete", slot }], commit: () => this.items.delete(slotKey(slot)) };
    });
  }

  private change(slot: Slot, edit: (item: OutboxItem) => OutboxItem | null): Promise<OutboxItem | undefined> {
    return this.writer.run(() => {
      const item = this.items.get(slotKey(slot));
      const changed = item ? edit(item) : null;
      if (!changed) return null;
      return { ops: [{ op: "put", item: changed }], commit: () => { this.items.set(slotKey(slot), changed); return changed; } };
    });
  }
}
