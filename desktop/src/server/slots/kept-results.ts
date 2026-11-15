// Results the owner keeps for slots whose result does not fit one `cmd.applied` entry (N2, 2026-11-15).
//
// A legacy command's handler runs before the deciding transaction (`plugins.call` runs the plugin's method), so a
// result too large for the log cannot turn into a refusal: the command ran. The slot settles `applied` with a small
// `KeptResultMarker` instead of the result (in the log entry, the receipt, `cmd.result` and the front end's outbox), and
// the whole result goes into `slot_results` in the same transaction as the receipt. The front end that sent the slot
// fetches it with a `slot.result` req (session-core), answered by the req path, which cuts a large answer into
// `res.part`s. Protocol v1's rule for big things holds: the log carries a reference, the bytes go another way (§8.5).
//
// Only the newest few are kept (a plugin panel that loads big data on every open must not grow server.db for ever): at
// most `rows` rows and `bytes` bytes, oldest first out. A result is fetched once, right after its outcome arrives, so
// a short window is enough; a later fetch of a dropped one is answered "no longer kept", never with other bytes.
import type { KeptResultMarker, Slot } from "../../protocol";
import type { Db } from "../store";

/** The largest result kept, as JSON in UTF-8 bytes (a `res` may carry at most 64 Mi characters of JSON: well above). */
export const KEPT_RESULT_MAX_BYTES = 16 * 1024 * 1024;
/** How many kept results stay, and how many bytes of them in all. */
export const KEPT_RESULTS_LIMITS = { rows: 32, bytes: 64 * 1024 * 1024 } as const;

export interface KeptLimits { rows: number; bytes: number }

/**
 * Keeps `result` for `slot` (in `tx`, the slot's deciding transaction) and returns the marker the outcome carries
 * instead. A result over `KEPT_RESULT_MAX_BYTES` (or one JSON cannot write) is not kept: its marker says so.
 */
export function keepResult(tx: Db, slot: Slot, result: unknown, limits: KeptLimits = KEPT_RESULTS_LIMITS): KeptResultMarker {
  const json = JSON.stringify(result);
  if (json === undefined) return { resultKept: { bytes: 0, kept: false } };
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > KEPT_RESULT_MAX_BYTES || bytes > limits.bytes) return { resultKept: { bytes, kept: false } };
  tx.prepare("DELETE FROM slot_results WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ?").run(slot.origin, slot.originEpoch, slot.target, slot.n);
  tx.prepare("INSERT INTO slot_results (origin, originEpoch, target, n, bytes, result) VALUES (?, ?, ?, ?, ?, ?)")
    .run(slot.origin, slot.originEpoch, slot.target, slot.n, bytes, json);
  prune(tx, limits);
  return { resultKept: { bytes, kept: true } };
}

/** The result kept for `slot`, or `found: false` when none is (never kept, or dropped since). */
export function keptResult(tx: Db, slot: Slot): { found: true; result: unknown } | { found: false } {
  const row = tx.prepare("SELECT result FROM slot_results WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ?").get(slot.origin, slot.originEpoch, slot.target, slot.n);
  if (!row) return { found: false };
  return { found: true, result: JSON.parse(String(row.result)) };
}

/** Drops the oldest rows beyond `limits` (the newest row always fits: `keepResult` checked its size). */
function prune(tx: Db, limits: KeptLimits): void {
  const rows = tx.prepare("SELECT id, bytes FROM slot_results ORDER BY id DESC").all();
  let count = 0;
  let total = 0;
  const drop = tx.prepare("DELETE FROM slot_results WHERE id = ?");
  for (const row of rows) {
    count += 1;
    total += Number(row.bytes);
    if (count > limits.rows || total > limits.bytes) drop.run(row.id);
  }
}
