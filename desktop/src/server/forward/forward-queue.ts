// The forward queue in server.db (M3 step 9, protocol v1 §7.3, §11.2 steps 3–4 and 6, D58, D59): what a server that
// accepted a command for a target it does not own keeps until the owner answers.
//
//   forwardq   (origin, originEpoch, target, n, owner, cmdHash, envelope, heldAt)   one row per slot, the envelope as
//              the accepting server stated it (scope stamped, `inc` as the origin sent it: never re-stamped, D49)
//   fwdcancels (origin, originEpoch, target, n, owner, at)                          a cancel to forward (D59)
//
// Every function here runs inside the writer's transaction (`tx`) or reads a committed state (`db`); none keeps
// memory. The rules they carry:
//   - a row is committed before `held` is sent (the caller answers after the commit);
//   - a row goes only on that slot's `cmd.result` from the owner (`takeResult`), or on a `cmd.retry` (`takeRetry`):
//     the retried slot and every row above it in the same queue, in
//     one transaction (D58), each passed on as its own `cmd.retry`;
//   - a `fwdcancels` entry goes on that slot's `cancel.noted` or `cmd.result` from the owner, or with its row on a
//     `cmd.retry` (the front end re-sends both);
//   - a row that can never be sent (`failRow`: it does not parse, its frame is too large, the encoder throws) moves into
//     `forwarddead` with its reason in one transaction, and its cancel goes with it; the later rows of its queue then go
//     out with a `floor` above the dead slot (`holesOf`, forwarder.ts), so the owner never waits for a slot nobody sends.
import { queueKey, type CmdBody, type Slot } from "../../protocol";
import type { Db } from "../store";

/** One forward-queue row as read back. */
export interface ForwardRow {
  slot: Slot;
  owner: string;
  cmdHash: string;
  envelope: CmdBody;
  heldAt: number;
}

/** One fwdcancels entry. */
export interface ForwardCancel {
  slot: Slot;
  owner: string;
  at: number;
}

/** A row as read for sending: `envelope` is null when the stored text is not JSON (it can never be sent). */
export interface QueuedRow extends Omit<ForwardRow, "envelope"> {
  envelope: CmdBody | null;
  /** The stored envelope text exactly as it is in the table (what `failRow` compares and keeps). */
  raw: string;
}

/** One queue of what is waiting for an owner. `holes` are the dead slots (`forwarddead`) below a row still here. */
export interface OwnerQueue {
  key: string;
  rows: QueuedRow[];
  cancels: ForwardCancel[];
  holes: number[];
}

/** What is waiting for one owner, each queue in slot order (rows and cancels of one queue together). */
export interface OwnerWork {
  queues: OwnerQueue[];
}

/** The key prefix of a `ServerOrigin`'s unresolved submit in `meta` (`serverOrigin:<originEpoch>:<target>:<n>`). */
export const SERVER_ORIGIN_META_PREFIX = "serverOrigin:";

const slotOf = (row: Record<string, unknown>): Slot => ({
  origin: String(row.origin), originEpoch: String(row.originEpoch), target: String(row.target) as Slot["target"], n: Number(row.n),
}) as Slot;

/**
 * Commits `envelope` (scope already stated) for `owner`. A row of the same slot with the same command and `inc` stays
 * as it is; otherwise the envelope is replaced (a re-send under the owner's new `inc` after a `cmd.retry`, or a cloned
 * origin whose conflict only the owner may decide). Returns true when the row was written or changed.
 */
export function commitRow(tx: Db, envelope: CmdBody, cmdHash: string, owner: string, now: number): boolean {
  const { origin, originEpoch, target, n } = envelope.slot;
  const found = tx.prepare("SELECT owner, cmdHash, envelope FROM forwardq WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ?").get(origin, originEpoch, target, n);
  if (found && String(found.owner) === owner && String(found.cmdHash) === cmdHash && (JSON.parse(String(found.envelope)) as CmdBody).inc === envelope.inc) return false;
  tx.prepare(`INSERT INTO forwardq (origin, originEpoch, target, n, owner, cmdHash, envelope, heldAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (origin, originEpoch, target, n) DO UPDATE SET owner = excluded.owner, cmdHash = excluded.cmdHash, envelope = excluded.envelope, heldAt = excluded.heldAt`)
    .run(origin, originEpoch, target, n, owner, cmdHash, JSON.stringify(envelope), now);
  return true;
}

/** Commits a cancel for `owner` (whether or not this server holds the slot's row). True when it was new. */
export function commitCancel(tx: Db, slot: Slot, owner: string, now: number): boolean {
  const result = tx.prepare("INSERT INTO fwdcancels (origin, originEpoch, target, n, owner, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (origin, originEpoch, target, n) DO NOTHING")
    .run(slot.origin, slot.originEpoch, slot.target, slot.n, owner, now);
  return Number(result.changes) > 0;
}

/** Everything waiting for `owner`, each queue's rows and cancels in slot order. A row whose text is not JSON is still a row. */
export function ownerWork(db: Db, owner: string): OwnerWork {
  const queues = new Map<string, OwnerQueue>();
  const queueFor = (slot: Slot) => {
    const key = queueKey(slot);
    let queue = queues.get(key);
    if (!queue) queues.set(key, (queue = { key, rows: [], cancels: [], holes: [] }));
    return queue;
  };
  for (const row of db.prepare("SELECT origin, originEpoch, target, n, owner, cmdHash, envelope, heldAt FROM forwardq WHERE owner = ? ORDER BY origin, originEpoch, target, n").all(owner)) {
    const slot = slotOf(row);
    const raw = String(row.envelope);
    let envelope: CmdBody | null = null;
    try { envelope = JSON.parse(raw) as CmdBody; } catch { envelope = null; }
    queueFor(slot).rows.push({ slot, owner, cmdHash: String(row.cmdHash), envelope, raw, heldAt: Number(row.heldAt) });
  }
  for (const row of db.prepare("SELECT origin, originEpoch, target, n, at FROM fwdcancels WHERE owner = ? ORDER BY origin, originEpoch, target, n").all(owner)) {
    const slot = slotOf(row);
    queueFor(slot).cancels.push({ slot, owner, at: Number(row.at) });
  }
  // Dead slots only matter while a row of their queue sits above them (a later row can be stamped with an older floor).
  for (const row of db.prepare(`SELECT d.origin, d.originEpoch, d.target, d.n FROM forwarddead d WHERE d.owner = ? AND EXISTS (
    SELECT 1 FROM forwardq q WHERE q.origin = d.origin AND q.originEpoch = d.originEpoch AND q.target = d.target AND q.n > d.n)
    ORDER BY d.origin, d.originEpoch, d.target, d.n`).all(owner)) {
    queueFor(slotOf(row)).holes.push(Number(row.n));
  }
  return { queues: [...queues.values()] };
}

/**
 * Settles a row that can never be sent, in one transaction: it moves into `forwarddead` (raw envelope, why, when) and
 * its cancel goes. Only when the row is still the one that was read (same owner, command hash and envelope text): a
 * re-send that replaced it in the meantime is a new row, not this failure. Returns true when it moved.
 */
export function failRow(tx: Db, row: Pick<QueuedRow, "slot" | "owner" | "cmdHash" | "raw">, reason: string, now: number): boolean {
  const { origin, originEpoch, target, n } = row.slot;
  const found = tx.prepare("SELECT heldAt FROM forwardq WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ? AND owner = ? AND cmdHash = ? AND envelope = ?")
    .get(origin, originEpoch, target, n, row.owner, row.cmdHash, row.raw);
  if (!found) return false;
  tx.prepare("INSERT OR REPLACE INTO forwarddead (origin, originEpoch, target, n, owner, cmdHash, envelope, heldAt, failedAt, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(origin, originEpoch, target, n, row.owner, row.cmdHash, row.raw, Number(found.heldAt), now, reason);
  tx.prepare("DELETE FROM forwardq WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ?").run(origin, originEpoch, target, n);
  tx.prepare("DELETE FROM fwdcancels WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ?").run(origin, originEpoch, target, n);
  return true;
}

/** The slot numbers a `ServerOrigin` of this server still holds unresolved for one queue (its `meta` entries; a `cmd.retry` row is not in `forwardq`). */
export function serverOriginPending(db: Db, slot: Pick<Slot, "origin" | "originEpoch" | "target">): number[] {
  const prefix = `${SERVER_ORIGIN_META_PREFIX}${slot.originEpoch}:${slot.target}:`;
  const out: number[] = [];
  for (const row of db.prepare("SELECT key FROM meta WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix)) {
    const n = Number(String(row.key).slice(prefix.length));
    if (Number.isSafeInteger(n) && n >= 1) out.push(n);
  }
  return out;
}

/** The owner's `cmd.result` for `slot`: its row and its cancel go. Returns what was there. */
export function takeResult(tx: Db, slot: Slot, owner: string): { row: boolean; cancel: boolean } {
  const row = tx.prepare("DELETE FROM forwardq WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ? AND owner = ?").run(slot.origin, slot.originEpoch, slot.target, slot.n, owner);
  const cancel = tx.prepare("DELETE FROM fwdcancels WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ? AND owner = ?").run(slot.origin, slot.originEpoch, slot.target, slot.n, owner);
  return { row: Number(row.changes) > 0, cancel: Number(cancel.changes) > 0 };
}

/** The owner's `cancel.noted` for `slot`: the cancel goes, the row stays (it goes only on `cmd.result`). */
export function takeNoted(tx: Db, slot: Slot, owner: string): boolean {
  const cancel = tx.prepare("DELETE FROM fwdcancels WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ? AND owner = ?").run(slot.origin, slot.originEpoch, slot.target, slot.n, owner);
  return Number(cancel.changes) > 0;
}

/**
 * The owner's `cmd.retry{slot}` (D49, D58): slot n and every row above it in the same queue go, in this one
 * transaction, with their cancels; returns the slots of the rows that went (each is passed on as a `cmd.retry`). Also
 * rows above n that already carry the owner's new `inc`: they can never apply without n (the owner holds them ahead in
 * memory at most), so keeping them would leave a durable row waiting for a slot that, once the front end's storage is
 * wiped, nobody sends again (v1 §11.2 step 7). A front end that still holds them re-sends them.
 */
export function takeRetry(tx: Db, slot: Slot, owner: string): Slot[] {
  const gone: Slot[] = [];
  const rows = tx.prepare("SELECT n FROM forwardq WHERE origin = ? AND originEpoch = ? AND target = ? AND n >= ? AND owner = ? ORDER BY n")
    .all(slot.origin, slot.originEpoch, slot.target, slot.n, owner);
  const dropRow = tx.prepare("DELETE FROM forwardq WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ?");
  const dropCancel = tx.prepare("DELETE FROM fwdcancels WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ?");
  for (const row of rows) {
    const n = Number(row.n);
    dropRow.run(slot.origin, slot.originEpoch, slot.target, n);
    dropCancel.run(slot.origin, slot.originEpoch, slot.target, n);
    gone.push({ ...slot, n });
  }
  // The retried slot's own cancel goes even when its row was gone already (the front end re-sends both).
  dropCancel.run(slot.origin, slot.originEpoch, slot.target, slot.n);
  return gone;
}

/** Drops every waiting row and cancel for a revoked `owner` (§4.6), returning the deleted rows in slot order. */
export function dropOwner(tx: Db, owner: string): ForwardRow[] {
  const rows = tx.prepare("SELECT origin, originEpoch, target, n, owner, cmdHash, envelope, heldAt FROM forwardq WHERE owner = ? ORDER BY origin, originEpoch, target, n").all(owner)
    .map((row) => ({
      slot: slotOf(row),
      owner: String(row.owner),
      cmdHash: String(row.cmdHash),
      envelope: JSON.parse(String(row.envelope)) as CmdBody,
      heldAt: Number(row.heldAt),
    }));
  if (rows.length) tx.prepare("DELETE FROM forwardq WHERE owner = ?").run(owner);
  tx.prepare("DELETE FROM fwdcancels WHERE owner = ?").run(owner);
  return rows;
}

/** Rows and cancels waiting, in all and for the oldest (status, tests). */
export function queueStats(db: Db): { rows: number; cancels: number; oldestHeldAt: number | null } {
  const rows = db.prepare("SELECT COUNT(*) AS n, MIN(heldAt) AS oldest FROM forwardq").get();
  const cancels = db.prepare("SELECT COUNT(*) AS n FROM fwdcancels").get();
  return { rows: Number(rows?.n ?? 0), cancels: Number(cancels?.n ?? 0), oldestHeldAt: rows?.oldest == null ? null : Number(rows.oldest) };
}

/** True when `logId` is a retired incarnation of `stream` this server knows of (D50). */
export function isRetired(db: Db, stream: string, logId: string): boolean {
  return !!db.prepare("SELECT 1 AS x FROM retired WHERE stream = ? AND logId = ?").get(stream, logId);
}
