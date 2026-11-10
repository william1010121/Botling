// The one door spec/tests/relayed-card.spec.test.ts uses into the app's option cards of a called-in bot and the
// user's answers on them. Bots and chats are named as in the model (spec/models/callin/RelayedCard.tla): P, a bot
// with a chat, and S, its sub bot, which P calls in with @. Cards are numbered from 1 in the order S asked them.
import type { Chat, Kind, View } from "../reference/relayed-card";

export interface RelayedCardSession {
  /** S asks the next card: a guest line in P's chat, or a reply in its own chat relayed into P's. */
  ask(kind: Kind): Promise<void>;
  /** The user answers card `k` on its line in `chat` (a pick, words or a question group's picks, as the card has). */
  answer(k: number, chat: Chat): Promise<void>;
  /** The user takes back the `i`-th message (from 1) waiting in S's queue. */
  drop(i: number): Promise<void>;
  /** The user ignores card `k` on its line in `chat`. */
  ignore(k: number, chat: Chat): Promise<void>;
  /** A user line in S's own chat: a turn of its own begins. */
  work(): Promise<void>;
  /** S's turn under way ends. */
  endTurn(): Promise<void>;
  /** S is removed (not during a call-in). */
  remove(): Promise<void>;
  /** What the app shows now. */
  view(): View;
  close(): Promise<void>;
}

export interface RelayedCardDriver {
  open(): Promise<RelayedCardSession>;
}
