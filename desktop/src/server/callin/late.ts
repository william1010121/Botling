// Given-up call-ins (M5-03a, D51, protocol v1 §15). When the host gives up on a call-in ("unreachable") it keeps the callId in
// `meta` (`callin:gaveup:<id>`, 7 days), so a `callin.reply` that comes later, even after a restart of this server, is known to
// be late: it is posted marked late and wakes nobody. A record is used up by the first reply that names it (the reply is
// consumed in the reply's own transaction), so a late line is posted at most once.
//
//   the key         built only from a callId that passes the id regex (`gaveUpKey`); anything else has no key, so a callId from
//                   the wire ("..", "a:b", "constructor") can never name or collide with another `meta` row.
//   bounded         a record lives `GAVEUP_KEEP_MS`; every write sweeps the expired and damaged ones and keeps at most
//                   `GAVEUP_MAX` (the oldest go first); a read of an expired record removes it.
//   fail closed     a row that is not what this file wrote (bad JSON, wrong types, no expiry) is removed and counts as unknown.
//   no gap          the record is in memory (`unsaved`) from the moment the host gives up, before its row is written, so a reply
//                   that overtakes the write is still late.
import type { TxScope } from "../effects";
import type { Db } from "../store";
import { cleanLine } from "./prompt";
import { CALLIN_NAME_LIMIT, cutUnits } from "./wire-text";

export const GAVEUP_PREFIX = "callin:gaveup:";
/** How long a given-up call-in is remembered (D51: a reply later than this is dropped). */
export const GAVEUP_KEEP_MS = 7 * 24 * 60 * 60_000;
/** The most records kept; more and the oldest are removed. */
export const GAVEUP_MAX = 500;
/** Same id rule as every id used as a key part (L-006). */
const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The `meta` key of a given-up call-in, or null when `callId` is not a legal id (nothing is ever keyed by it). */
export const gaveUpKey = (callId: string): string | null => (typeof callId === "string" && CALL_ID.test(callId) ? `${GAVEUP_PREFIX}${callId}` : null);

/** What the host keeps of a call-in it gave up on: only ids and one clean name (never the transcript, the ask or any text of B). */
export interface GaveUp {
  /** The server the ask went to (the reply must come from it). */
  server: string;
  /** The host chat. */
  hostBotId: string;
  guestBotId: string;
  guestName: string;
  at: number;
  until: number;
}

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A stored row as a record, or null when it is not exactly what `remember` writes. */
export function parseGaveUp(value: unknown): GaveUp | null {
  let raw: unknown = value;
  if (typeof value === "string") { try { raw = JSON.parse(value); } catch { return null; } }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { server, hostBotId, guestBotId, guestName, at, until } = raw as Record<string, unknown>;
  if (!isText(server, 200) || !isText(hostBotId, 200) || !isText(guestBotId, 200) || typeof guestName !== "string" || guestName.length > 400 || !isTime(at) || !isTime(until)) return null;
  return { server, hostBotId, guestBotId, guestName, at, until };
}

export interface GaveUpBookOptions {
  /** Where the records are written (none: memory only, nothing survives a restart). */
  scope: TxScope | null;
  now: () => number;
  keepMs?: number;
  max?: number;
  log: (line: string) => void;
}

export class GaveUpBook {
  /** Given up, not (or not yet) written: the reply handler reads these first. */
  private readonly unsaved = new Map<string, GaveUp>();
  private readonly keepMs: number;
  private readonly max: number;

  constructor(private readonly options: GaveUpBookOptions) {
    this.keepMs = options.keepMs ?? GAVEUP_KEEP_MS;
    this.max = Math.max(1, options.max ?? GAVEUP_MAX);
  }

  /** Records the give-up: in memory at once, then in `meta` (which also sweeps). False for a callId with no legal key. */
  async remember(callId: string, who: Pick<GaveUp, "server" | "hostBotId" | "guestBotId" | "guestName">): Promise<boolean> {
    const key = gaveUpKey(callId);
    if (!key) return false;
    const at = this.options.now();
    const record: GaveUp = { ...who, guestName: cutUnits(cleanLine(who.guestName, 200), CALLIN_NAME_LIMIT).trim(), at, until: at + this.keepMs };
    this.unsaved.set(callId, record);
    // Memory is bounded too, in case the writes keep failing.
    while (this.unsaved.size > this.max) this.unsaved.delete(this.unsaved.keys().next().value as string);
    try {
      await this.options.scope?.submit((tx) => {
        if (!this.unsaved.has(callId)) return; // a reply already used it up
        tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(record));
        this.sweep(tx, at);
      });
      if (this.options.scope) this.unsaved.delete(callId);
    } catch (error) {
      this.options.log(`callin: a given-up call-in could not be saved (${cleanLine(error instanceof Error ? error.message : String(error), 200)})`);
    }
    return true;
  }

  /** Removes the expired and damaged records, and the oldest ones beyond the cap. Runs inside a writer transaction. */
  sweep(tx: Db, now = this.options.now()): void {
    const live: Array<{ key: string; at: number }> = [];
    const remove = tx.prepare("DELETE FROM meta WHERE key = ?");
    for (const row of tx.prepare("SELECT key, value FROM meta WHERE key LIKE ?").all(`${GAVEUP_PREFIX}%`)) {
      const key = String(row.key);
      const record = parseGaveUp(row.value);
      if (!record || record.until <= now) remove.run(key);
      else live.push({ key, at: record.at });
    }
    live.sort((a, b) => a.at - b.at);
    for (const { key } of live.slice(0, Math.max(0, live.length - this.max))) remove.run(key);
  }

  /**
   * The record of a call-in this server gave up on, or null (unknown, expired, damaged). Runs inside the reply's transaction;
   * an expired or damaged row is removed here. The record is not used up yet (`consume`).
   */
  find(tx: Db, callId: string): GaveUp | null {
    const key = gaveUpKey(callId);
    if (!key) return null;
    const now = this.options.now();
    const memory = this.unsaved.get(callId);
    if (memory) return memory.until > now ? memory : (this.drop(tx, callId, key), null);
    const row = tx.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    if (!row) return null;
    const record = parseGaveUp(row.value);
    if (!record || record.until <= now) { this.drop(tx, callId, key); return null; }
    return record;
  }

  /** Uses the record up (inside the reply's transaction): no second reply for this callId is late. */
  consume(tx: Db, callId: string): void {
    const key = gaveUpKey(callId);
    if (key) this.drop(tx, callId, key);
  }

  private drop(tx: Db, callId: string, key: string): void {
    tx.prepare("DELETE FROM meta WHERE key = ?").run(key);
    const memory = this.unsaved.get(callId);
    if (!memory) return;
    this.unsaved.delete(callId);
    // The transaction did not commit after all: the reply is not used up.
    try { this.options.scope?.onRollback(() => { this.unsaved.set(callId, memory); }); } catch { /* outside a command: nothing to undo */ }
  }
}
