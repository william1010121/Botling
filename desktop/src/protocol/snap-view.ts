// Botling 3 wire protocol v1: what `snap.view` holds for a bot log stream (§8.4): the newest page of messages, the open
// cards and the bot's state, read in one transaction at the snap's `seq`. Older lines come by `history` pages.
// (`srv:` table streams have their own snap view, M2.)
import { z } from "zod";
import { MessageView } from "../contract";
import { Id, Seq } from "./ids";

/** The bot's read-model row (`bots`), with the 5 s live checkpoint of a running turn (§9.3). */
export const BotSnapState = z.strictObject({
  botId: Id,
  /** The stream's head the view was read at (same as `snap.seq`). */
  head: Seq,
  unread: z.number().int().nonnegative(),
  model: z.string().max(200).nullable(),
  settings: z.unknown().nullable(),
  live: z.strictObject({ turnId: Id, text: z.string(), at: z.number().int().nonnegative() }).nullable(),
});
export type BotSnapState = z.infer<typeof BotSnapState>;

/** An open card (approval, question) as the `cards` read model keeps it. */
export const SnapCard = z.strictObject({ cardId: Id, rev: z.number().int().nonnegative(), state: z.string().min(1).max(40), body: z.unknown() });
export type SnapCard = z.infer<typeof SnapCard>;

export const BotSnapView = z.strictObject({
  /** Null while the bot has no read-model row yet. */
  bot: BotSnapState.nullable(),
  /** The newest page, oldest first (cut by size so the snap fits one frame). */
  messages: z.array(MessageView).max(2_000),
  /** Whether older lines wait (`history{before: messages[0].id}`), and how many. */
  history: z.strictObject({ hasMore: z.boolean(), older: z.number().int().nonnegative() }),
  cards: z.array(SnapCard).max(500),
});
export type BotSnapView = z.infer<typeof BotSnapView>;
