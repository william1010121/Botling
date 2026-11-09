// Catch-up's program part: hears when you read a chat (`chatRead`) and when you post a line
// (`messagePosted`), reads the chat (`chat.messages`), has the summaries written by the claude or codex
// CLI as Botling starts it (`engines.cli`, the isolated one-shot call catchup.ts builds), and puts them
// in the chat as message decorations (`chat.decorate`) for its web part to draw.
import type { BotlingApi, ChatData } from "../../../../Web/host/src/api";
import {
  CatchUpCache, CatchUps, catchUpSettings, ExpandedRanges, claudeSummarizer, codexSummarizer, engineSummarizer, SUMMARY_ENGINE_NAMES, SummaryFailure,
  type CatchUpChat, type ChatRecord, type Summarizer,
} from "./catchup";
import { migrate, settingsReader, summariesFile } from "./migrate";
import { appLanguage } from "./util";

/** How much of a chat a summary may look at: the newest lines, as many as the chat page holds. */
const LINES = 2_000;

/** A chat as the summaries read it, up to and with the line `through` when it is given. */
export function catchUpChat(data: ChatData, through?: string | null): CatchUpChat {
  const records = data.messages as unknown as ChatRecord[];
  const end = through ? records.findIndex((record) => record.id === through) : -1;
  return { id: data.botId, name: data.name, records: end >= 0 ? records.slice(0, end + 1) : records, unread: data.unread };
}

export async function activate(api: BotlingApi) {
  const setting = settingsReader(api, await migrate(api));
  const settings = () => catchUpSettings(setting);
  /** A summarizer that asks Botling for the engine's CLI each time (it can change while Botling runs). */
  const viaCli = (engine: "claude" | "codex", make: typeof codexSummarizer): Summarizer => async (prompt, model, language, which) => {
    const cli = await api.engines.cli(engine);
    if (!cli) throw new SummaryFailure(`${SUMMARY_ENGINE_NAMES[engine]} is not available for summaries.`);
    return make({ file: cli.file, prefixArgs: cli.args, env: cli.env })(prompt, model, language, which);
  };
  const read = (botId: string) => api.chat.messages(botId, { limit: LINES });

  // Each change of a chat's summaries is drawn once, from the chat as it is then.
  const pending = new Set<string>();
  const redraw = (botId: string) => {
    if (pending.has(botId)) return;
    pending.add(botId);
    queueMicrotask(async () => {
      pending.delete(botId);
      try { await api.chat.decorate(botId, catchUps.decorations(catchUpChat(await read(botId)))); } catch { /* the bot went away */ }
    });
  };

  const catchUps = new CatchUps({
    cache: new CatchUpCache(summariesFile(api)),
    summarizer: engineSummarizer({ codex: viaCli("codex", codexSummarizer), claude: viaCli("claude", claudeSummarizer) }),
    settings,
    language: () => appLanguage(api.settings.app("language")),
    changed: redraw,
    expanded: new ExpandedRanges(api.storage),
  });

  // You came back to a chat: more than the threshold of unread replies fold into a summary (`arrive(at:)`).
  api.subscriptions.push(api.events.on("chatRead", ({ botId, unread, through }) => {
    const now = settings();
    // A chat with no more unread lines than the threshold has no more replies than it either.
    if (!now.catchUpEnabled || unread <= now.catchUpThreshold) return;
    void read(botId).then((data) => catchUps.arrive({ ...catchUpChat(data, through), unread }), () => {});
  }));
  // Your line closes an interval: it may be summarized by itself (`summarizeClosedInterval`).
  api.subscriptions.push(api.events.on("messagePosted", ({ botId, role, id }) => {
    if (role !== "user" || !settings().intervalSummaryEnabled) return;
    void read(botId).then((data) => catchUps.closedInterval(catchUpChat(data, id), id), () => {});
  }));

  // The card's Retry, and the footer's "Summarize N replies".
  api.ui.expose("retry", async (params) => {
    const { botId, key } = (params ?? {}) as { botId?: unknown; key?: unknown };
    if (typeof botId !== "string") return { started: false };
    return { started: catchUps.retry(catchUpChat(await read(botId)), typeof key === "string" && key ? key : undefined) };
  });
  // The card's "Show original messages": the card goes and its lines show where they are, for good.
  api.ui.expose("expand", async (params) => {
    const { botId, key } = (params ?? {}) as { botId?: unknown; key?: unknown };
    if (typeof botId !== "string" || typeof key !== "string" || !key) return { expanded: false };
    return { expanded: catchUps.expand(catchUpChat(await read(botId)), key) };
  });
  api.ui.expose("interval", async (params) => {
    const { botId, userMessageId } = (params ?? {}) as { botId?: unknown; userMessageId?: unknown };
    if (typeof botId !== "string" || typeof userMessageId !== "string") return { started: false };
    return { started: catchUps.interval(catchUpChat(await read(botId)), userMessageId) };
  });
}
