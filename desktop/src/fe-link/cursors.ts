// Stream cursors on the front end (protocol v1 §8.3, §13.1, D50). Pure decisions; the link persists what they change.
//
// - A batch applies only within the cursor's logId, from `cursor.seq + 1`; entries ≤ cursor are dropped; a gap asks for
//   a re-`sub` from the cursor; a `prevHash` that does not match the cursor's hash drops the cache (re-`sub` with none).
// - A different logId is never compared by number: the reader moves to it only through a `reset` that lists the
//   reader's logId as retired (or when it has no cursor), then the `snap` of the new logId.
// - A batch, snap, reset target or `cmd.result` of a retired logId is dropped, whoever sends it.
// - Monotonic: a snap of the same logId older than the cursor is dropped.
import type { Cursor, LogId, MessageOf } from "../protocol";
import type { RetiredLog, StoredCursor } from "./storage";

type Batch = MessageOf<"batch">;
type Snap = MessageOf<"snap">;
type Reset = MessageOf<"reset">;

export type BatchDecision =
  | { kind: "apply"; entries: Batch["entries"]; cursor: StoredCursor }
  | { kind: "drop"; why: string }
  | { kind: "gap"; cursor: Cursor }
  | { kind: "mismatch" };

export class StreamCursors {
  private readonly cursors = new Map<string, StoredCursor>();
  private readonly retired = new Map<string, Map<LogId, number>>();
  /** Streams waiting for a snap: the logId a reset moved them to, or null after a sub with no cursor. */
  private readonly awaiting = new Map<string, LogId | null>();
  /** Streams whose last batch said more pages follow. */
  private readonly paging = new Set<string>();

  constructor(cursors: Record<string, StoredCursor>, retired: Record<string, RetiredLog[]>) {
    for (const [stream, cursor] of Object.entries(cursors)) this.cursors.set(stream, { ...cursor });
    for (const [stream, list] of Object.entries(retired)) this.retired.set(stream, new Map(list.map((old) => [old.logId, old.keptSeq])));
  }

  get(stream: string): StoredCursor | null {
    return this.cursors.get(stream) ?? null;
  }

  all(): Record<string, StoredCursor> {
    return Object.fromEntries([...this.cursors].map(([stream, cursor]) => [stream, { ...cursor }]));
  }

  isRetired(stream: string, logId: LogId): boolean {
    return this.retired.get(stream)?.has(logId) ?? false;
  }

  retiredOf(stream: string): RetiredLog[] {
    return [...(this.retired.get(stream) ?? [])].map(([logId, keptSeq]) => ({ logId, keptSeq }));
  }

  /** The logId the reader follows now: the one a reset moved it to (snap still to come), else its cursor's. */
  currentLogId(stream: string): LogId | null {
    const moved = this.awaiting.get(stream);
    return moved ?? this.cursors.get(stream)?.logId ?? null;
  }

  /** The cursor a `sub` (and `hello.cursors`) names. Null: send a snap. Marks a stream with none as waiting for it. */
  subCursor(stream: string): Cursor | null {
    this.paging.delete(stream);
    const cursor = this.cursors.get(stream);
    if (!cursor) { this.awaiting.set(stream, null); return null; }
    return { logId: cursor.logId, seq: cursor.seq };
  }

  /** Still catching up: a snap or catch-up pages are due on one of these streams. */
  catching(streams: Iterable<string>): boolean {
    for (const stream of streams) if (this.awaiting.has(stream) || this.paging.has(stream)) return true;
    return false;
  }

  onBatch(batch: Batch): BatchDecision {
    const { stream } = batch;
    if (this.isRetired(stream, batch.logId)) return { kind: "drop", why: "retired logId" };
    if (this.awaiting.has(stream)) return { kind: "drop", why: "waiting for a snap" };
    const cursor = this.cursors.get(stream);
    if (!cursor) return { kind: "drop", why: "no cursor" };
    if (batch.logId !== cursor.logId) return { kind: "drop", why: "another logId without a reset" };
    if (batch.to <= cursor.seq) return { kind: "drop", why: "already applied" };
    if (batch.from > cursor.seq + 1) return { kind: "gap", cursor: { logId: cursor.logId, seq: cursor.seq } };
    const before = batch.from === cursor.seq + 1 ? batch.prevHash : batch.entries[cursor.seq - batch.from].hash;
    if (cursor.hash !== null && before !== cursor.hash) return { kind: "mismatch" };
    const entries = batch.entries.filter((entry) => entry.seq > cursor.seq);
    const last = entries[entries.length - 1];
    const next: StoredCursor = { logId: cursor.logId, seq: last.seq, hash: last.hash };
    this.cursors.set(stream, next);
    if (batch.more) this.paging.add(stream);
    else this.paging.delete(stream);
    return { kind: "apply", entries, cursor: next };
  }

  /** True when the snap was taken (the cursor is now at it). */
  onSnap(snap: Snap): boolean {
    const { stream } = snap;
    if (this.isRetired(stream, snap.logId)) return false;
    const cursor = this.cursors.get(stream);
    const moved = this.awaiting.get(stream);
    const take = (moved !== undefined && moved !== null && moved === snap.logId)
      || (moved !== undefined && moved !== null ? false : !cursor || (cursor.logId === snap.logId && snap.seq >= cursor.seq));
    if (!take) return false;
    this.cursors.set(stream, { logId: snap.logId, seq: snap.seq, hash: snap.hash });
    this.awaiting.delete(stream);
    this.paging.delete(stream);
    return true;
  }

  /** The newly retired logIds when the reset was taken; null when dropped. The snap of `reset.logId` follows. */
  onReset(reset: Reset): RetiredLog[] | null {
    const { stream } = reset;
    if (this.isRetired(stream, reset.logId)) return null;
    const current = this.currentLogId(stream);
    if (current !== null && current !== reset.logId && !reset.retired.some((old) => old.logId === current)) return null;
    if (current === reset.logId) return null; // already on it
    let known = this.retired.get(stream);
    if (!known) this.retired.set(stream, (known = new Map()));
    const added: RetiredLog[] = [];
    for (const old of reset.retired) {
      if (!known.has(old.logId)) { known.set(old.logId, old.keptSeq); added.push({ logId: old.logId, keptSeq: old.keptSeq }); }
    }
    this.awaiting.set(stream, reset.logId);
    this.paging.delete(stream);
    return added;
  }

  /** The cache of the stream is gone (hash mismatch, or the caller lost it): the next sub asks for a snap. */
  drop(stream: string): void {
    this.cursors.delete(stream);
    this.paging.delete(stream);
    this.awaiting.delete(stream);
  }

  /** The session ended: nothing is due any more. */
  detach(): void {
    this.awaiting.forEach((moved, stream) => { if (moved === null) this.awaiting.delete(stream); });
    this.paging.clear();
  }
}
