// The host's durable "late line to post" rows (fu-callin-outbox, M5-03a F4 crash point 2). A late `callin.reply` uses its
// `callin:gaveup:` record up in the reply's own transaction (late.ts); the same transaction now also writes the line it owes
// as a `callin:late:<callId>` row in `meta`. The line is posted after the commit and the row is then deleted; a crash between
// the two leaves the row, and the next start posts it (`CallInHost.bindLate`). Posting is idempotent by callId
// (`Conversations.postLate` finds its own line in the chat), so a crash after the post and before the delete does not post twice.
//
//   exactly once    staged with the consume (both or neither), posted at most once per callId (the chat key), deleted after.
//   no wake         a row only ever reaches `postLate`, which never settles a wait and never takes the 2.x wake path.
//   bounded         a row lives until its give-up record's expiry (7 days); every write sweeps the expired and damaged
//                   ones and keeps at most `GAVEUP_MAX` (the oldest go first).
//   fail closed     a row that is not what this file wrote (bad JSON, wrong types, no expiry) is removed and posts nothing.
//   key             built only from a callId that passes the id regex (`gaveUpKey`), so wire text never names another row.
//   text            the cleaned reply (`cleanReply`) and one clean guest name: nothing else of B is kept (no transcript, no secrets).
import type { Db } from "../store";
import { GAVEUP_MAX, gaveUpKey } from "./late";

export const LATE_PREFIX = "callin:late:";

/** What the host owes the chat for one late reply. */
export interface LateRow {
  /** The host chat. */
  chatId: string;
  guestBotId: string;
  guestName: string;
  /** The cleaned reply text (never empty). */
  text: string;
  engine: string;
  /** When the row stops being worth posting (the give-up record's expiry). */
  until: number;
  at: number;
}

/** The `meta` key of a callId's late row, or null when `callId` is not a legal id. */
export const lateKey = (callId: string): string | null => (gaveUpKey(callId) ? `${LATE_PREFIX}${callId}` : null);

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A stored row as a `LateRow`, or null when it is not exactly what `stage` writes. */
export function parseLateRow(value: unknown): LateRow | null {
  let raw: unknown = value;
  if (typeof value === "string") { try { raw = JSON.parse(value); } catch { return null; } }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { chatId, guestBotId, guestName, text, engine, until, at } = raw as Record<string, unknown>;
  if (!isText(chatId, 200) || !isText(guestBotId, 200) || typeof guestName !== "string" || guestName.length > 400
    || typeof text !== "string" || !text.trim() || text.length > 1_000_000 || !isText(engine, 200) || !isTime(until) || !isTime(at)) return null;
  return { chatId, guestBotId, guestName, text, engine, until, at };
}

export class LateOutbox {
  /** Writes the row (inside the reply's transaction, with the consume) and sweeps. False for a callId with no legal key. */
  stage(tx: Db, callId: string, row: LateRow, now: number): boolean {
    const key = lateKey(callId);
    if (!key) return false;
    tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(row));
    this.sweep(tx, now);
    return true;
  }

  /** The rows still to post, oldest first (callId and row). Expired and damaged rows are removed here. */
  pending(tx: Db, now: number): Array<{ callId: string; row: LateRow }> {
    const live: Array<{ callId: string; row: LateRow }> = [];
    const remove = tx.prepare("DELETE FROM meta WHERE key = ?");
    for (const entry of tx.prepare("SELECT key, value FROM meta WHERE key LIKE ?").all(`${LATE_PREFIX}%`)) {
      const key = String(entry.key);
      const callId = key.slice(LATE_PREFIX.length);
      const row = lateKey(callId) === key ? parseLateRow(entry.value) : null;
      if (!row || row.until <= now) remove.run(key);
      else live.push({ callId, row });
    }
    return live.sort((a, b) => a.row.at - b.row.at);
  }

  /** Deletes the row of `callId` (after its line was posted). */
  drop(tx: Db, callId: string): void {
    const key = lateKey(callId);
    if (key) tx.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  /** Removes the expired and damaged rows, and the oldest ones beyond the cap. */
  sweep(tx: Db, now: number): void {
    const live = this.pending(tx, now);
    const remove = tx.prepare("DELETE FROM meta WHERE key = ?");
    for (const { callId } of live.slice(0, Math.max(0, live.length - GAVEUP_MAX))) remove.run(`${LATE_PREFIX}${callId}`);
  }
}
