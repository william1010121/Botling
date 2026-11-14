// The 5 s checkpoint of a running turn's text (protocol v1 §9.3): `bots.liveTurnId / liveText / liveAt`, a small
// update through the single writer, never an entry and never replicated. After a crash the effect outbox (§12) reads
// it and appends `turn.interrupted{turnId, text: checkpoint}`, so at most ~5 s of text is missing.
// The row helpers run inside a writer transaction (or a reader, for the reads); the sink wraps them for LiveChannel.
import type { Command, Db } from "../store";

export interface LiveCheckpoint {
  botId: string;
  turnId: string;
  /** The turn's text so far: every finished segment followed by the current one. */
  text: string;
  /** When it was taken (the live clock's `now()`). */
  at: number;
}

/** Where LiveChannel puts checkpoints. Calls may be slow but must take effect in the order made (the writer is FIFO). */
export interface CheckpointSink {
  write(checkpoint: LiveCheckpoint): Promise<void>;
  /** The turn ended (its entries carry the text now): drop its checkpoint, if it is still that turn's. */
  clear(botId: string, turnId: string): Promise<void>;
}

/** Upserts the bot's checkpoint row (inside a writer transaction). */
export function writeCheckpoint(db: Db, checkpoint: LiveCheckpoint): void {
  db.prepare(
    "INSERT INTO bots (botId, liveTurnId, liveText, liveAt) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT (botId) DO UPDATE SET liveTurnId = excluded.liveTurnId, liveText = excluded.liveText, liveAt = excluded.liveAt",
  ).run(checkpoint.botId, checkpoint.turnId, checkpoint.text, checkpoint.at);
}

/** Clears the checkpoint if it still belongs to `turnId` (a newer turn's is kept). Returns whether it cleared one. */
export function clearCheckpoint(db: Db, botId: string, turnId: string): boolean {
  const result = db.prepare("UPDATE bots SET liveTurnId = NULL, liveText = NULL, liveAt = NULL WHERE botId = ? AND liveTurnId = ?").run(botId, turnId);
  return Number(result.changes) > 0;
}

export function readCheckpoint(db: Db, botId: string): LiveCheckpoint | null {
  const row = db.prepare("SELECT liveTurnId, liveText, liveAt FROM bots WHERE botId = ? AND liveTurnId IS NOT NULL").get(botId);
  if (!row) return null;
  return { botId, turnId: String(row.liveTurnId), text: String(row.liveText ?? ""), at: Number(row.liveAt ?? 0) };
}

/** Every checkpoint left in the store: at start, these are the turns a crash interrupted (§12 recovery reads them). */
export function listCheckpoints(db: Db): LiveCheckpoint[] {
  return db.prepare("SELECT botId, liveTurnId, liveText, liveAt FROM bots WHERE liveTurnId IS NOT NULL ORDER BY botId").all().map((row) => ({
    botId: String(row.botId), turnId: String(row.liveTurnId), text: String(row.liveText ?? ""), at: Number(row.liveAt ?? 0),
  }));
}

/** A sink that writes through the store's single writer (each write its own small command, batched by group commit). */
export function storeCheckpointSink(store: { submit<T>(command: Command<T>): Promise<T> }): CheckpointSink {
  return {
    write: (checkpoint) => store.submit((db) => writeCheckpoint(db, checkpoint)),
    clear: async (botId, turnId) => { await store.submit((db) => clearCheckpoint(db, botId, turnId)); },
  };
}
