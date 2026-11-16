// What the summary rows' start needs from the `srv:` log: the newest `bot.updated` of some bots and the newest
// `settings.updated`. The stream keeps every `bot.updated` ever stored (one per change of a bot: 16,654 entries, 897 MB
// on a Mac after a day of use) and `entries` has no index on `kind`, so reading all of them to keep the last of each bot
// made every start read the whole stream: 4 s to 33 s (an 8 GB server.db). This reads newest first and stops at what it
// was asked for; asking for nothing reads nothing. Settings are a query of their own, newest first, and a server stores
// `settings.updated` often (on the 8.4 GB server.db the newest was 400 entries back: 0.36 s). The walk still reads the
// rows' pages, though: a stream with no readable settings entry is read to its start (18 s cold on that file), as before.
import type { BotView } from "../../contract";
import type { Db } from "../store";

const PAGE = 64;

export interface LatestFromEntries {
  bots: Map<string, BotView>;
  settings: Record<string, unknown> | null;
  /** How many `bot.updated` rows were read (a test and the log can see the cost). */
  rows: number;
}

/** The newest `bot.updated` view of each bot in `wantBots`, and the newest settings when `wantSettings`; a cut or unreadable entry is skipped. */
export function latestFromEntries(tx: Db, stream: string, wantBots: ReadonlySet<string>, wantSettings: boolean, page = PAGE): LatestFromEntries {
  const out: LatestFromEntries = { bots: new Map(), settings: null, rows: 0 };
  if (wantSettings) {
    // Newest first; a cut entry is skipped for the one before it.
    let before = Number.MAX_SAFE_INTEGER;
    while (out.settings === null) {
      const row = tx.prepare("SELECT seq, body FROM entries WHERE stream = ? AND seq < ? AND kind = 'settings.updated' ORDER BY seq DESC LIMIT 1").get(stream, before);
      if (!row) break;
      before = Number(row.seq);
      try {
        const settings = (JSON.parse(String(row.body)) as { settings?: Record<string, unknown> }).settings;
        if (settings) out.settings = settings;
      } catch { /* a cut entry: skipped */ }
    }
  }
  if (wantBots.size === 0) return out;
  const next = tx.prepare("SELECT seq, body FROM entries WHERE stream = ? AND seq < ? AND kind = 'bot.updated' ORDER BY seq DESC LIMIT ?");
  let before = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const rows = next.all(stream, before, page);
    out.rows += rows.length;
    for (const row of rows) {
      before = Number(row.seq);
      try {
        const bot = (JSON.parse(String(row.body)) as { bot?: BotView }).bot;
        if (bot?.id && wantBots.has(bot.id) && !out.bots.has(bot.id)) out.bots.set(bot.id, bot);
      } catch { /* a cut entry: skipped */ }
    }
    if (out.bots.size >= wantBots.size || rows.length < page) return out;
  }
}
