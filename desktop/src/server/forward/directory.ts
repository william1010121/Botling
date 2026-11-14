// Who owns a command's target (M3 step 9, protocol v1 §11.2 step 5, §14.1, §14.2; m3-brief §11 Q3).
//
//   srv:<id>   → the server `id` (this server, or a peer the roster names as a server)
//   bot:<id>   → this server when its engine has the bot; otherwise the peer
//                whose `srv:` table copy (server/replica) holds a live `bot:<id>` summary row
//   otherwise  → this server
//
// "This server" for a target nobody else claims keeps M1/M2's behaviour: the local slot engine decides it, and a bot it
// does not have is refused there with a stored outcome (`invalid`), so the front end shows "not sent" (Q3: a definite
// refusal, nothing applied, never held with no owner). A command is forwarded only to the owner named here, and an
// owner never forwards (owner-inbox.ts), so a command never loops. Ownership is fixed (§14.2), so a queue's slots all
// go the same way.
import type { Db } from "../store";

export interface DirectoryOptions {
  self: string;
  /** Committed state (a reader connection). */
  reader(): Db;
  /** The peer servers the roster names (any state: a stale or gone owner's commands wait in the queue). */
  peers(): readonly string[];
  /** True when this server's engine has the bot. */
  hasBot(botId: string): boolean;
}

export class Directory {
  constructor(private readonly options: DirectoryOptions) {}

  /** The owner of `target` when it is a peer; null when this server decides it. */
  peerOwner(target: string): string | null {
    const peers = this.options.peers();
    if (peers.length === 0) return null;
    if (target.startsWith("srv:")) {
      const id = target.slice(4);
      return id !== this.options.self && peers.includes(id) ? id : null;
    }
    if (!target.startsWith("bot:")) return null;
    const botId = target.slice(4);
    if (this.options.hasBot(botId)) return null;
    const db = this.options.reader();
    // (A `bot:` stream this server holds without the bot is not a claim: a refusal of an unknown bot made one.)
    for (const row of db.prepare("SELECT stream FROM rows WHERE key = ? AND deleted = 0 AND stream LIKE 'srv:%' ORDER BY stream").all(target)) {
      const owner = String(row.stream).slice(4);
      if (owner !== this.options.self && peers.includes(owner)) return owner;
    }
    return null;
  }
}
