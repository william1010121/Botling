// The one door spec/tests/callin.spec.test.ts uses into the app's @ routing and call-ins.
// Bots are named as in the model (spec/models/callin): top bots with chats, sub bots under one of them.
import type { CallinView } from "../reference/callin";

export interface CallinDriver {
  /** Top bots (each with a chat others can be called into) and each sub bot's parent. */
  readonly top: string[];
  readonly parent: Record<string, string>;
  /** Your line in `chat`'s chat, naming `to` with @ (null: nobody). */
  userLine(chat: string, to: string | null): Promise<void>;
  /** `chat`'s bot ends its turn with a reply whose line starts "@to body" (null: no @). Returns the reply's id. */
  botReply(chat: string, to: string | null, body: string): Promise<string>;
  /** The reply `id` in `chat` is heard again. */
  rehear(chat: string, id: string): Promise<void>;
  /** `bot`'s own turn ends with nothing to show. */
  ownEnd(bot: string): Promise<void>;
  /** The sub bot is removed. */
  remove(sub: string): Promise<void>;
  /** The bot answering a call-in in `chat` replies. */
  answer(chat: string): Promise<void>;
  /** The bot answering a call-in in `chat` fails its turn (`empty`: ends it with nothing to show, which a bot's @ counts as no answer). */
  noAnswer(chat: string, empty?: boolean): Promise<void>;
  /** What the app shows now. */
  view(): CallinView;
  /** The model name of an app bot id (for trace lines), or null. */
  nameOf(id: string): string | null;
  close(): Promise<void>;
}

export interface CallinDriverOptions {
  /** The folder for the app's data (bot-mentions.json, chats). */
  dataDir: string;
}
