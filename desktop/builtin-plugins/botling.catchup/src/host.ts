// Catch-up's program part: hears when you read a chat (`chatRead`), reads the chat (`chat.messages`), picks the
// few messages that matter (catchup.ts, pure rules: no model, no summary) and puts the fold in the chat as a
// message decoration (`chat.decorate`) for its web part to draw.
import type { BotlingApi, ChatData } from "../../../../Web/host/src/api";
import { CatchUps, catchUpSettings, type CatchUpChat, type ChatRecord } from "./catchup";
import { migrate, settingsReader } from "./migrate";

/** How much of a chat catch-up may look at: the newest lines, as many as the chat page holds. */
const LINES = 2_000;

/** A chat as catch-up reads it, up to and with the line `through` when it is given. */
export function catchUpChat(data: ChatData, through?: string | null): CatchUpChat {
  const records = data.messages as unknown as ChatRecord[];
  const end = through ? records.findIndex((record) => record.id === through) : -1;
  return { id: data.botId, name: data.name, records: end >= 0 ? records.slice(0, end + 1) : records, unread: data.unread };
}

export async function activate(api: BotlingApi) {
  const setting = settingsReader(api, await migrate(api));
  const settings = () => catchUpSettings(setting);
  const read = (botId: string) => api.chat.messages(botId, { limit: LINES });

  // Each change of a chat's fold is drawn once, from the chat as it is then.
  const pending = new Set<string>();
  const redraw = (botId: string) => {
    if (pending.has(botId)) return;
    pending.add(botId);
    queueMicrotask(async () => {
      pending.delete(botId);
      try { await api.chat.decorate(botId, catchUps.decorations(catchUpChat(await read(botId)))); } catch { /* the bot went away */ }
    });
  };

  const catchUps = new CatchUps({ settings, changed: redraw });

  // You came back to a chat: more than the threshold of unread replies keep their top few and fold the rest.
  api.subscriptions.push(api.events.on("chatRead", ({ botId, unread, through }) => {
    const now = settings();
    // A chat with no more unread lines than the threshold has no more replies than it either.
    if (!now.catchUpEnabled || unread <= now.catchUpThreshold) return;
    void read(botId).then((data) => catchUps.arrive({ ...catchUpChat(data, through), unread }), () => {});
  }));
}
