// `snap` and `history` for bot log streams (protocol v1 §8.4): both read the read models in one read transaction, so
// a snap is exactly the state at its `seq` (WAL snapshot isolation, §7.2).
//
// Pages are cut by size like 2.x `chat.history` (core/history-page.ts), but also so that the whole message fits one
// frame (256 KiB, §5.2): a 2.x page (1 MiB) would not. The rest comes by `history` pages.
import { MAX_PAGE_BYTES, PAGE_BYTES } from "../../core/history-page";
import type { MessageView } from "../../contract";
import type { BotSnapView, MessageOf, SnapCard, StreamId } from "../../protocol";
import { FRAME_LIMIT } from "../../protocol/frame";
import type { Db } from "../store";
import { botIdOf, readStream, type StreamRow } from "./log-store";

/** Room left in a frame for the frame's own fields around a snap view or a history page. */
const FRAME_SLACK = 2 * 1024;

export class SnapTooLargeError extends Error {
  constructor(readonly stream: string, readonly bytes: number) {
    super(`snap of ${stream} needs ${bytes} bytes; a frame is at most ${FRAME_LIMIT}`);
    this.name = "SnapTooLargeError";
  }
}

/** Runs `read` inside one read transaction (unless the connection is already in one). */
export function inRead<T>(db: Db, read: () => T): T {
  if (db.inTransaction) return read();
  db.exec("BEGIN");
  try {
    return read();
  } finally {
    if (db.inTransaction) db.exec("COMMIT");
  }
}

interface Page { messages: MessageView[]; hasMore: boolean; older: number }

/**
 * The newest lines with seq below `beforeSeq`, oldest first, as many as fit in `bytes` (always at least one), plus
 * how many older lines remain.
 */
function pageBefore(db: Db, botId: string, beforeSeq: number, bytes: number): Page {
  const select = db.prepare("SELECT seq, body FROM messages WHERE botId = ? AND seq < ? ORDER BY seq DESC LIMIT 100");
  const picked: MessageView[] = [];
  let total = 0;
  let below = beforeSeq;
  let lowest = beforeSeq;
  outer: for (;;) {
    const rows = select.all(botId, below);
    if (!rows.length) break;
    for (const row of rows) {
      const text = String(row.body);
      const size = Buffer.byteLength(text);
      if (picked.length > 0 && total + size > bytes) break outer;
      picked.push(JSON.parse(text) as MessageView);
      total += size;
      lowest = Number(row.seq);
    }
    below = lowest;
  }
  const older = picked.length
    ? Number(db.prepare("SELECT count(*) AS n FROM messages WHERE botId = ? AND seq < ?").get(botId, lowest)!.n)
    : 0;
  return { messages: picked.reverse(), hasMore: older > 0, older };
}

function readBot(db: Db, botId: string, head: number): BotSnapView["bot"] {
  const row = db.prepare("SELECT botId, settings, unread, model, liveTurnId, liveText, liveAt FROM bots WHERE botId = ?").get(botId);
  if (!row) return null;
  return {
    botId: String(row.botId),
    head,
    unread: Number(row.unread),
    model: row.model == null ? null : String(row.model),
    settings: row.settings == null ? null : JSON.parse(String(row.settings)),
    live: row.liveTurnId == null ? null : { turnId: String(row.liveTurnId), text: String(row.liveText ?? ""), at: Number(row.liveAt ?? 0) },
  };
}

function readCards(db: Db, botId: string): SnapCard[] {
  return db.prepare("SELECT cardId, rev, state, body FROM cards WHERE botId = ? AND state = 'open' ORDER BY rev LIMIT 500").all(botId)
    .map((row) => ({ cardId: String(row.cardId), rev: Number(row.rev), state: String(row.state), body: JSON.parse(String(row.body)) }));
}

export interface Snap {
  frame: MessageOf<"snap">;
  row: StreamRow;
}

/** The snap of a bot stream at its head, or null when the stream does not exist. */
export function readSnap(db: Db, stream: StreamId): Snap | null {
  return inRead(db, () => {
    const row = readStream(db, stream);
    if (!row) return null;
    const botId = botIdOf(stream);
    if (!botId) throw new Error(`readSnap: ${stream} is not a bot stream`);
    const bot = readBot(db, botId, row.head);
    const cards = readCards(db, botId);
    const shell = { t: "snap", stream, logId: row.logId, seq: row.head, hash: row.headHash, view: { bot, cards, history: { hasMore: true, older: Number.MAX_SAFE_INTEGER }, messages: [] } };
    const budget = Math.min(PAGE_BYTES, FRAME_LIMIT - FRAME_SLACK - Buffer.byteLength(JSON.stringify(shell)));
    const page = pageBefore(db, botId, Number.MAX_SAFE_INTEGER, Math.max(0, budget));
    const view: BotSnapView = { bot, messages: page.messages, history: { hasMore: page.hasMore, older: page.older }, cards };
    const frame: MessageOf<"snap"> = { t: "snap", stream, logId: row.logId, seq: row.head, hash: row.headHash, view };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    if (bytes > FRAME_LIMIT) throw new SnapTooLargeError(stream, bytes);
    return { frame, row };
  });
}

/**
 * A page of lines older than message `before` (2.x `chat.history`), from the current incarnation; null when the
 * stream or the line is unknown (2.x answers `not_found`).
 */
export function readHistory(db: Db, req: MessageOf<"history">): MessageOf<"history.page"> | null {
  return inRead(db, () => {
    const row = readStream(db, req.stream);
    const botId = botIdOf(req.stream);
    if (!row || !botId) return null;
    const at = db.prepare("SELECT seq FROM messages WHERE botId = ? AND msgId = ?").get(botId, req.before);
    if (!at) return null;
    const shell = { t: "history.page", req: req.req, stream: req.stream, logId: row.logId, messages: [], hasMore: true, older: Number.MAX_SAFE_INTEGER };
    const budget = Math.min(req.bytes ?? PAGE_BYTES, MAX_PAGE_BYTES, FRAME_LIMIT - FRAME_SLACK - Buffer.byteLength(JSON.stringify(shell)));
    const page = pageBefore(db, botId, Number(at.seq), budget);
    return { t: "history.page", req: req.req, stream: req.stream, logId: row.logId, ...page };
  });
}
