// The chat-line read model (`messages`, protocol v1 §7.3), kept in the same transaction as the entry that changes it,
// so a `snap` read at `streams.head` always matches the log. `seq` is where the line sits (the entry that added it),
// `rev` the entry that last changed it. Cards, the bot row and lists are written by their own command handlers (step 6).
import { canonicalJson, type Entry } from "../../protocol";
import type { Db } from "../store";

export function applyReadModel(db: Db, entry: Entry): void {
  const body = entry.body as { botId?: string; message?: { id: string }; messageId?: string };
  switch (entry.kind) {
    case "message.added":
    case "message.updated": {
      const message = body.message!;
      db.prepare(
        "INSERT INTO messages (botId, msgId, rev, seq, body) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT (botId, msgId) DO UPDATE SET rev = excluded.rev, body = excluded.body",
      ).run(body.botId!, message.id, entry.seq, entry.seq, canonicalJson(message));
      return;
    }
    case "message.removed":
      db.prepare("DELETE FROM messages WHERE botId = ? AND msgId = ?").run(body.botId!, body.messageId!);
      return;
    default:
      return;
  }
}
