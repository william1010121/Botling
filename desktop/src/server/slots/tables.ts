// The slot tables of server.db (protocol v1 §7.3): `slots.next` per (origin, originEpoch, target), `receipts` and
// `cancels`. Every function takes the writer transaction (or a read connection) and is synchronous.
//
// A skip (§11.3, `floor` above `next`) stores one receipt row for the whole range: n = the first skipped slot,
// cmdHash = "skip:<last skipped n>", outcome {kind: "skipped"}, seq = the `cmd.skipped` entry. A slot below `next`
// without its own receipt is therefore found in the skip row with the greatest n at or below it. One row per range
// keeps a skip cheap however far `floor` jumps.
import { Outcome, type Slot } from "../../protocol";
import type { Db } from "../store";

export type QueueRef = Pick<Slot, "origin" | "originEpoch" | "target">;

export interface StoredReceipt {
  n: number;
  cmdHash: string;
  outcome: Outcome;
  seq: number | null;
}

const SKIP_PREFIX = "skip:";

export function readNext(tx: Db, q: QueueRef): number {
  const row = tx.prepare("SELECT next FROM slots WHERE origin = ? AND originEpoch = ? AND target = ?").get(q.origin, q.originEpoch, q.target);
  return row ? Number(row.next) : 1;
}

export function writeNext(tx: Db, q: QueueRef, next: number): void {
  tx.prepare("INSERT INTO slots (origin, originEpoch, target, next) VALUES (?, ?, ?, ?) ON CONFLICT (origin, originEpoch, target) DO UPDATE SET next = excluded.next")
    .run(q.origin, q.originEpoch, q.target, next);
}

export function writeReceipt(tx: Db, slot: Slot, cmdHash: string, outcome: Outcome, seq: number): void {
  tx.prepare("INSERT INTO receipts (origin, originEpoch, target, n, cmdHash, outcome, seq) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(slot.origin, slot.originEpoch, slot.target, slot.n, cmdHash, JSON.stringify(outcome), seq);
}

export function writeSkip(tx: Db, q: QueueRef, from: number, to: number, seq: number): void {
  writeReceipt(tx, { ...q, n: from }, `${SKIP_PREFIX}${to}`, { kind: "skipped" }, seq);
  tx.prepare("DELETE FROM cancels WHERE origin = ? AND originEpoch = ? AND target = ? AND n BETWEEN ? AND ?").run(q.origin, q.originEpoch, q.target, from, to);
}

/**
 * The stored outcome of slot `n` (below `next`): its own receipt, or the skip range that covers it. `skipped` is
 * true for a slot that a skip covered: it matches any command hash, since the slot never applied.
 */
export function findReceipt(tx: Db, slot: Slot): (StoredReceipt & { skipped: boolean }) | null {
  const row = tx.prepare("SELECT n, cmdHash, outcome, seq FROM receipts WHERE origin = ? AND originEpoch = ? AND target = ? AND n <= ? ORDER BY n DESC LIMIT 1")
    .get(slot.origin, slot.originEpoch, slot.target, slot.n);
  if (!row) return null;
  const hash = String(row.cmdHash);
  const receipt = { n: Number(row.n), cmdHash: hash, outcome: Outcome.parse(JSON.parse(String(row.outcome))), seq: row.seq === null ? null : Number(row.seq) };
  if (hash.startsWith(SKIP_PREFIX)) {
    const to = Number(hash.slice(SKIP_PREFIX.length));
    return slot.n <= to ? { ...receipt, skipped: true } : null;
  }
  return receipt.n === slot.n ? { ...receipt, skipped: false } : null;
}

export function isCancelled(tx: Db, slot: Slot): boolean {
  return !!tx.prepare("SELECT 1 FROM cancels WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ?").get(slot.origin, slot.originEpoch, slot.target, slot.n);
}

export function addCancel(tx: Db, slot: Slot): void {
  tx.prepare("INSERT OR IGNORE INTO cancels (origin, originEpoch, target, n) VALUES (?, ?, ?, ?)").run(slot.origin, slot.originEpoch, slot.target, slot.n);
}

export function removeCancel(tx: Db, slot: Slot): void {
  tx.prepare("DELETE FROM cancels WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ?").run(slot.origin, slot.originEpoch, slot.target, slot.n);
}
