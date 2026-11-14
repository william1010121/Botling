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
type Engine = import("zod").infer<typeof import("../../contract").Engine>;
import type { Db, SqlRow } from "../store";

export type EffectKind = "turn" | "remove";
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
  send?: { text: string; replyTo?: string; to?: "both" | "claude" | "codex" | "agy" };
  /** A turn kept aside from the core (an answer's message, a routine's run): the head's message as the core made it. */
  words?: string;
  engine?: Engine;
  coreOrigin?: "user" | "app";
}

export interface RemovePayload { kind: "remove" }

export type EffectPayload = TurnPayload | RemovePayload;

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
