// Small writes the intent handlers, the effect worker and the event tap share, all inside a writer command: append an
// entry that fits one frame (fit.ts), make sure a bot has its stream and read-model row, and mark the bot's running turn
// in `bots.liveTurnId` (the §9.3 checkpoint row, which the `turn.stop` basis and recovery read).
import type { Entry, Slot, StreamId } from "../../protocol";
import { appendEntries, ensureStream, sameAsStored } from "../log";
import type { Db } from "../store";
import { fitBody } from "./fit";
import type { TxScope } from "./scope";

export const botStream = (botId: string): StreamId => `bot:${botId}` as StreamId;

export function serverStreamOf(tx: Db): StreamId {
  const row = tx.prepare("SELECT value FROM meta WHERE key = 'serverId'").get();
  if (!row) throw new Error("server.db has no serverId");
  return `srv:${String(row.value)}` as StreamId;
}

/** The bot's log stream and its `bots` row, made when missing. */
export function ensureBot(tx: Db, botId: string): StreamId {
  const stream = botStream(botId);
  ensureStream(tx, stream);
  tx.prepare("INSERT OR IGNORE INTO bots (botId) VALUES (?)").run(botId);
  return stream;
}

export function botKnown(tx: Db, botId: string): boolean {
  return !!tx.prepare("SELECT 1 FROM bots WHERE botId = ?").get(botId);
}

export interface AppendOptions {
  /**
   * Store nothing when the body is what the object's newest stored state already is (a redraw of the same bot, sub-agent
   * or line): returns null like a body that does not fit, without the log line.
   */
  skipSame?: boolean;
  slot?: Slot;
  now?: number;
  log?: (line: string) => void;
}

/**
 * Appends one entry, cut to fit one frame when needed (the whole text goes to `fulltext` in the same transaction).
 * Returns null only when nothing could make it fit (logged).
 */
export function appendFitted(scope: TxScope, tx: Db, stream: StreamId, kind: string, body: Record<string, unknown>, options: AppendOptions = {}): Entry | null {
  const fitted = fitBody(kind, body);
  if (fitted.dropped) {
    options.log?.(`${stream}: a ${kind} entry does not fit one frame even cut; not stored`);
    return null;
  }
  ensureStream(tx, stream);
  if (options.skipSame && sameAsStored(tx, stream, kind, fitted.body)) return null;
  const [entry] = appendEntries(tx, stream, [{ kind, body: fitted.body, ...(options.slot ? { slot: options.slot } : {}) }], options.now ? { now: options.now } : {});
  if (fitted.full !== null) {
    const message = body.message as { id?: string } | undefined;
    const key = kind.startsWith("message.") && message?.id ? message.id : `turn:${String(body.turnId)}`;
    tx.prepare("INSERT INTO fulltext (stream, key, seq, text) VALUES (?, ?, ?, ?) ON CONFLICT (stream, key) DO UPDATE SET seq = excluded.seq, text = excluded.text")
      .run(stream, key, entry.seq, fitted.full);
  }
  scope.touch(stream);
  return entry;
}

/** The whole text of a line (or "turn:<turnId>") whose entry was cut, or null. */
export function readFullText(db: Db, stream: string, key: string): string | null {
  const row = db.prepare("SELECT text FROM fulltext WHERE stream = ? AND key = ?").get(stream, key);
  return row ? String(row.text) : null;
}

/** `turnId` is the bot's running turn from now: its checkpoint starts empty (§9.3). */
export function markLive(tx: Db, botId: string, turnId: string, now: number): void {
  tx.prepare(
    "INSERT INTO bots (botId, liveTurnId, liveText, liveAt) VALUES (?, ?, '', ?) " +
    "ON CONFLICT (botId) DO UPDATE SET liveTurnId = excluded.liveTurnId, liveText = excluded.liveText, liveAt = excluded.liveAt",
  ).run(botId, turnId, now);
}

/** The turn ended: its checkpoint goes, if it is still that turn's. Returns the checkpoint text it held, or null. */
export function clearLive(tx: Db, botId: string, turnId: string): string | null {
  const row = tx.prepare("SELECT liveText FROM bots WHERE botId = ? AND liveTurnId = ?").get(botId, turnId);
  if (!row) return null;
  tx.prepare("UPDATE bots SET liveTurnId = NULL, liveText = NULL, liveAt = NULL WHERE botId = ? AND liveTurnId = ?").run(botId, turnId);
  return String(row.liveText ?? "");
}
