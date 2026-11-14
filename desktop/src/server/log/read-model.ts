// The read models a log entry changes (`messages` and `cards`, protocol v1 §7.3), kept in the same transaction as the
// entry, so a `snap` read at `streams.head` always matches the log.
// - messages: `seq` is where the line sits (the entry that added it), `rev` the entry that last changed it.
// - cards: a line with buttons (a question, a question group, a tool approval) is a card; `cardId` = its line id (the
//   2.x messageId), `rev` = the seq of the entry that last changed it, `state` "open" while it can be answered and
//   "closed" after (picked, answered, ignored, or waiting for a called-in bot). The §11.5 basis checks
//   (src/server/slots/basis.ts) read it: an answer to a closed card, or to a newer revision than the front end showed,
//   is refused with `changed`. A removed line takes its card with it.
// The bot row (`bots`) and `lists` are written by their own owners (src/server/effects, src/server/botstore).
import { canonicalJson, interruptedLine, type Entry } from "../../protocol";
import type { MessageView } from "../../contract";
import type { Db } from "../store";

/** A line that is a card (it has buttons or questions to answer). */
export function isCard(message: MessageView): boolean {
  return !!message.choices?.length || !!message.questions?.length || !!message.approval;
}

/** Whether a card can still be answered (2.x `isOpenQuestion`, on the view). */
export function isOpenCard(message: MessageView): boolean {
  return isCard(message) && message.chosen == null && message.answer == null && message.ignoredAt == null && !message.queued;
}

export function applyReadModel(db: Db, entry: Entry): void {
  const body = entry.body as { botId?: string; message?: MessageView; messageId?: string };
  switch (entry.kind) {
    case "message.added":
    case "message.updated": {
      const message = body.message!;
      db.prepare(
        "INSERT INTO messages (botId, msgId, rev, seq, body) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT (botId, msgId) DO UPDATE SET rev = excluded.rev, body = excluded.body",
      ).run(body.botId!, message.id, entry.seq, entry.seq, canonicalJson(message));
      if (isCard(message)) {
        db.prepare(
          "INSERT INTO cards (botId, cardId, rev, state, body) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT (botId, cardId) DO UPDATE SET rev = excluded.rev, state = excluded.state, body = excluded.body",
        ).run(body.botId!, message.id, entry.seq, isOpenCard(message) ? "open" : "closed", canonicalJson(message));
      } else {
        db.prepare("DELETE FROM cards WHERE botId = ? AND cardId = ?").run(body.botId!, message.id);
      }
      return;
    }
    case "turn.interrupted": {
      // The reply line shows the interruption as the live path does (protocol/interrupted.ts), so a snap after the
      // restart matches what the window showed (M1 demo bug 5a). A reply that had no line yet stays without one.
      const interrupted = entry.body as { botId: string; turnId: string; messageId?: string; text: string };
      if (!interrupted.messageId) return;
      const row = db.prepare("SELECT body FROM messages WHERE botId = ? AND msgId = ?").get(interrupted.botId, interrupted.messageId);
      if (!row) return;
      const line = interruptedLine(JSON.parse(String(row.body)) as MessageView, interrupted, { id: interrupted.messageId, time: "" });
      db.prepare("UPDATE messages SET rev = ?, body = ? WHERE botId = ? AND msgId = ?").run(entry.seq, canonicalJson(line), interrupted.botId, interrupted.messageId);
      if (isCard(line)) db.prepare("UPDATE cards SET rev = ?, state = ?, body = ? WHERE botId = ? AND cardId = ?").run(entry.seq, isOpenCard(line) ? "open" : "closed", canonicalJson(line), interrupted.botId, interrupted.messageId);
      return;
    }
    case "message.removed":
      db.prepare("DELETE FROM messages WHERE botId = ? AND msgId = ?").run(body.botId!, body.messageId!);
      db.prepare("DELETE FROM cards WHERE botId = ? AND cardId = ?").run(body.botId!, body.messageId!);
      return;
    default:
      return;
  }
}
