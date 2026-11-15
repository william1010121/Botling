// The effect outbox rows of server.db (protocol v1 §7.3, §12): `effects (effectId, stream, botId, turnId, kind,
// payload, state, seq, startedAt, endedAt)`. Every function runs inside a writer command (or on a reader, for reads).
//
// States: queued → started → finished | interrupted, or queued → cancelled.
// - A `turn` row is a turn of the engine. It becomes `started` in the same transaction as its `turn.started` entry,
//   before the engine is asked to run it, so a turn is begun at most once; a crash while it is started makes it
//   `interrupted` at the next start (recovery.ts), never `queued` again. Rows the core began by itself (a call-in, a
//   worker's report) are written `started` when their `turn.started` event is stored, so a crash interrupts them too.
// - A `remove` row removes a bot through the core after the intent committed (the core's removal is asynchronous);
//   removing is idempotent, so a crash while it is started puts it back to `queued`.
// - A `callin` row is a guest's turn for a bot on another server (M5-02b): `queued` → `started` (the turn begins at most
//   once) → `finished` (answered) | `interrupted` (a crash: recovery.ts; the answer is "its machine restarted during the
//   answer", sent once at the next start), or `queued` → `cancelled` (the host gave up before it began).
type Engine = import("zod").infer<typeof import("../../contract").Engine>;
import { createHash } from "node:crypto";
import type { Db, SqlRow } from "../store";

export type EffectKind = "turn" | "remove" | "callin";
export type EffectState = "queued" | "started" | "finished" | "interrupted" | "cancelled";
/** Who asked for a turn: `chat.send`, another core-set command (an answer that became the user's message, a new bot's first turn), a routine's run, or the core itself. */
export type TurnOrigin = "chat" | "command" | "routine" | "core";

export interface TurnPayload {
  kind: "turn";
  origin: TurnOrigin;
  /** The reply's chat line. */
  replyId: string;
  /** The user's line it answers (chat.send, an answer); null for the app's own turns. */
  userId: string | null;
  /** chat.send: what the user sent (the core builds the head's message from it, plugins first). */
  send?: { text: string; replyTo?: string; to?: "both" | "claude" | "codex" | "agy"; files?: Array<{ id: string; name: string }> };
  /** A turn kept aside from the core (an answer's message, a routine's run): the head's message as the core made it. */
  words?: string;
  engine?: Engine;
  coreOrigin?: "user" | "app";
}

export interface RemovePayload { kind: "remove" }

/**
 * A call-in from another server (M5-02b): what `callin.ask` carried, keyed by (sender, guest, callId) so one call-in is
 * one row and at most one guest turn (D51). `replied`: the answer (or the failure) was handed to the server origin; set
 * in the same transaction that ends the row, so a call-in is answered once, never twice, across a crash.
 */
export interface CallInPayload {
  kind: "callin";
  callId: string;
  /** The sender: the host's server (slot.origin). */
  origin: string;
  host: { server: string; botId: string; name: string };
  transcript: string;
  asked: string;
  by: "user" | "bot";
  depth: number;
  replied: boolean;
}

export type EffectPayload = TurnPayload | RemovePayload | CallInPayload;

export interface EffectRow {
  effectId: string;
  stream: string;
  botId: string;
  turnId: string | null;
  kind: EffectKind;
  payload: EffectPayload;
  state: EffectState;
  /** The entry that queued it (`turn.queued`) or, for a turn the core began, its `turn.started`. Orders a bot's queue. */
  seq: number;
  startedAt: number | null;
  endedAt: number | null;
}

const COLUMNS = "effectId, stream, botId, turnId, kind, payload, state, seq, startedAt, endedAt";

function toRow(row: SqlRow): EffectRow {
  return {
    effectId: String(row.effectId),
    stream: String(row.stream),
    botId: String(row.botId),
    turnId: row.turnId == null ? null : String(row.turnId),
    kind: String(row.kind) as EffectKind,
    payload: JSON.parse(String(row.payload)) as EffectPayload,
    state: String(row.state) as EffectState,
    seq: Number(row.seq),
    startedAt: row.startedAt == null ? null : Number(row.startedAt),
    endedAt: row.endedAt == null ? null : Number(row.endedAt),
  };
}

export function insertEffect(tx: Db, row: EffectRow): void {
  tx.prepare(`INSERT INTO effects (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.effectId, row.stream, row.botId, row.turnId, row.kind, JSON.stringify(row.payload), row.state, row.seq, row.startedAt, row.endedAt,
  );
}

export function readEffect(db: Db, effectId: string): EffectRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM effects WHERE effectId = ?`).get(effectId);
  return row ? toRow(row) : null;
}

/** The (newest) turn row of a bot's turn. */
export function findTurnEffect(db: Db, botId: string, turnId: string): EffectRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM effects WHERE botId = ? AND turnId = ? ORDER BY seq DESC LIMIT 1`).get(botId, turnId);
  return row ? toRow(row) : null;
}

/** The effect row of one call-in: one id for one (sender, guest, callId), so the primary key makes a second one impossible. */
export function callInEffectId(origin: string, botId: string, callId: string): string {
  return `callin-${createHash("sha256").update(JSON.stringify([origin, botId, callId])).digest("hex")}`;
}

/** A row's payload replaced (the call-in's `replied` mark). Returns false when no row in `states` has that id. */
export function setEffectPayload(tx: Db, effectId: string, payload: EffectPayload, states: readonly EffectState[]): boolean {
  const marks = states.map(() => "?").join(", ");
  return Number(tx.prepare(`UPDATE effects SET payload = ? WHERE effectId = ? AND state IN (${marks})`).run(JSON.stringify(payload), effectId, ...states).changes) > 0;
}

/** Call-in rows of a bot that are queued or started (the owner takes only a few at once). */
export function openCallIns(db: Db, botId: string): number {
  return Number((db.prepare("SELECT COUNT(*) AS c FROM effects WHERE kind = 'callin' AND botId = ? AND state IN ('queued', 'started')").get(botId) as { c: number }).c);
}

/** Queued rows, each bot's in the order they were queued. */
export function queuedEffects(db: Db, limit: number): EffectRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM effects WHERE state = 'queued' ORDER BY stream, seq LIMIT ?`).all(limit).map(toRow);
}

export function effectsIn(db: Db, state: EffectState): EffectRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM effects WHERE state = ? ORDER BY stream, seq`).all(state).map(toRow);
}

/** Moves a row on; `startedAt` is set when it starts, `endedAt` when it ends. Returns false when the row is not in `from`. */
export function moveEffect(tx: Db, effectId: string, from: readonly EffectState[], to: EffectState, now: number): boolean {
  const marks = from.map(() => "?").join(", ");
  const where = `WHERE effectId = ? AND state IN (${marks})`;
  const result = to === "queued"
    ? tx.prepare(`UPDATE effects SET state = ?, startedAt = NULL ${where}`).run(to, effectId, ...from)
    : tx.prepare(`UPDATE effects SET state = ?, ${to === "started" ? "startedAt" : "endedAt"} = ? ${where}`).run(to, now, effectId, ...from);
  return Number(result.changes) > 0;
}
