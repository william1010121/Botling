// botling.pin-area, program part: the books of pins (one per bot, plugin storage `pins:<botId>`), what bots and the user do to them,
// and what each chat's page draws (`chat.setData`). The rules themselves are model.ts's; this file only reads the events, the
// tags and the hook, and keeps the books. Design and limits: ../DESIGN.md.
import type { BotlingApi } from "../../../../Web/host/src/api";
import * as M from "./model";

export const PLUGIN = "botling.pin-area";
const INDEX = "pins:bots";
const keyOf = (botId: string) => `pins:${botId}`;
/** A bot's tags this many times in a minute are enough: the rest are dropped (a loop of tags cannot churn the book). */
const TAGS_PER_MINUTE = 30;
const MAX_BOTS = 200;

type Params = Record<string, unknown>;
type Expose = (method: string, fn: (params: Params) => unknown) => () => void;

const botOf = (params: Params): string => {
  const id = params.botId;
  if (typeof id !== "string" || !id || id.length > 200) throw new Error("No bot.");
  return id;
};
const own = (attributes: Record<string, string>, name: string): string => (Object.hasOwn(attributes, name) ? attributes[name]! : "");

export function activatePins(api: BotlingApi, expose: Expose, now: () => number = Date.now) {
  const load = (botId: string): M.Book => M.readBook(typeof api.storage?.get === "function" ? api.storage.get(keyOf(botId)) : null);

  // The bots that have a book (events of other bots cost nothing); kept in storage so a restart still hears the answers.
  const bots = new Set<string>();
  try {
    const kept = typeof api.storage?.get === "function" ? api.storage.get(INDEX) : null;
    for (const id of Array.isArray(kept) ? kept.slice(0, MAX_BOTS) : []) if (typeof id === "string" && id && id.length <= 200) bots.add(id);
  } catch { /* no index: the first pin of a bot adds it again */ }
  const track = (botId: string, on: boolean) => {
    if (on === bots.has(botId)) return;
    if (on && bots.size >= MAX_BOTS) return;
    if (on) bots.add(botId); else bots.delete(botId);
    try { api.storage.set(INDEX, [...bots]); } catch { /* kept in memory only */ }
  };

  /** What the chat of `botId` draws from now on. A chat the app does not know (a bot that was removed) just takes nothing. */
  const publish = (botId: string, book = load(botId)) => {
    try { void Promise.resolve(api.chat.setData(botId, M.viewOf(book) as never)).catch(() => {}); } catch { /* no page to draw it */ }
  };
  const save = (botId: string, book: M.Book) => {
    if (typeof api.storage?.set !== "function") throw new Error("unavailable: storage");
    M.fit(book);
    api.storage.set(keyOf(botId), book);
    track(botId, book.pins.length > 0 || book.removed.length > 0);
    publish(botId, book);
  };

  // ---- which turn of the bot an answer can belong to ----
  const turnStart = new Map<string, number>();
  const lastBotLine = new Map<string, { text: string; at: number }>();
  const tagTimes = new Map<string, number[]>();
  const allowed = (botId: string): boolean => {
    const at = now();
    const times = (tagTimes.get(botId) ?? []).filter((time) => at - time < 60_000);
    if (times.length >= TAGS_PER_MINUTE) { tagTimes.set(botId, times); return false; }
    times.push(at);
    tagTimes.set(botId, times);
    if (tagTimes.size > MAX_BOTS * 2) tagTimes.clear();
    return true;
  };
  let counter = 0;
  const ridOf = () => `r${now().toString(36)}-${(counter++).toString(36)}`;

  const subs = [
    // the bot's turn began: what was in the chat before it has been seen
    api.events.on("turnStarted", ({ botId }) => {
      if (!bots.has(botId)) return;
      turnStart.set(botId, now());
      const book = load(botId);
      if (M.markSeen(book, now())) save(botId, book);
    }),
    api.events.on("messagePosted", ({ botId, role, text }) => {
      if (!bots.has(botId)) return;
      if (role === "bot") { lastBotLine.set(botId, { text: String(text ?? ""), at: now() }); return; }
      const asked = M.parseAsk(String(text ?? ""));
      if (!asked) return;
      const book = load(botId);
      if (M.markPosted(book, asked.id, now())) save(botId, book);
    }),
    // a reply with no <pin-say>: the one card waiting for an answer takes it
    api.events.on("turnFinished", ({ botId, ok, reply }) => {
      if (!bots.has(botId)) return;
      try {
        const line = lastBotLine.get(botId);
        const started = turnStart.get(botId) ?? 0;
        const text = String(reply || (line && line.at >= started ? line.text : "") || "").trim();
        // a reply that still carries the tag is the tag's to answer, not the fallback's
        if (!ok || !text || text.includes("<pin-say")) return;
        const book = load(botId);
        if (M.answerOnlyWaiting(book, text, started, now()) !== null) save(botId, book);
      } catch (error) {
        console.error("botling.pin-area: answer", error);
      }
    }),

    // what a bot writes: its own cards, and the answers in a card's thread. Only the bot that wrote the tag is touched (tag.bot).
    api.replyTags.on("pin-card", (tag) => {
      const botId = tag.bot.id;
      if (!allowed(botId)) return;
      try {
        const book = load(botId);
        const outcome = M.applyCardTag(book, tag.attributes, tag.body, now());
        if (outcome === "created" || outcome === "updated" || outcome === "unpinned") save(botId, book);
      } catch (error) {
        console.error("botling.pin-area: pin-card", error);
      }
    }),
    api.replyTags.on("pin-say", (tag) => {
      const botId = tag.bot.id;
      if (!allowed(botId)) return;
      try {
        const book = load(botId);
        if (M.answerTurn(book, own(tag.attributes, "id").trim(), tag.body, now())) save(botId, book);
      } catch (error) {
        console.error("botling.pin-area: pin-say", error);
      }
    }),

    // "@card words" from the main input box or the card's own: written into the card's thread, sent to the bot with the card's header
    api.hooks.beforeSend((message) => {
      const botId = message.bot.id;
      if (!bots.has(botId)) return;
      const book = load(botId);
      const hit = M.route(book, message.text);
      if (!hit || hit.rest.length > M.MAX_ROUTED) return;
      const at = now();
      if (M.pruneUnposted(book, at)) save(botId, book);
      // the same words again, at once: one send
      if (M.isDuplicate(hit.pin, hit.rest, at)) return false;
      M.addTurn(hit.pin, ridOf(), hit.rest, at);
      save(botId, book);
      return M.askText(hit.pin, M.clean(hit.rest, M.MAX_ROUTED));
    }),
  ];

  // a chat that already has pins draws them again after a restart (what chat.setData holds lives in the app)
  for (const botId of bots) publish(botId);

  const find = (book: M.Book, id: unknown): M.Pin => {
    const pin = M.isId(id) ? book.pins.find((candidate) => candidate.id === id) : undefined;
    if (!pin) throw new Error("這張卡已經不在了。");
    return pin;
  };

  const methods = [
    // a chat with no data yet asks for it (the page does, once)
    expose("view", (params) => {
      const botId = botOf(params);
      const book = load(botId);
      publish(botId, book);
      return M.viewOf(book);
    }),
    // the user pins a message (any message: theirs or a bot's)
    expose("pinMessage", (params) => {
      const botId = botOf(params);
      const book = load(botId);
      const messageId = typeof params.messageId === "string" ? params.messageId.slice(0, 200) : "";
      const dup = messageId ? book.pins.find((pin) => pin.msgRef === messageId) : undefined;
      if (dup) return { id: dup.id, duplicate: true };
      const { title, status } = M.fromMessage(String(params.text ?? ""));
      const made = M.addPin(book, { origin: "user", title, status, state: "run", source: "user", ...(messageId ? { msgRef: messageId } : {}) }, now());
      if ("refused" in made) throw new Error(made.refused === "full" ? `最多釘 ${M.MAX_PINS} 張，先取消一張。` : "這則訊息沒有可以釘的字。");
      save(botId, book);
      return { id: made.pin.id };
    }),
    // the user takes a card down; a done card the user looked at and closed goes by itself (`by: "seen"`, only a done one)
    expose("unpin", (params) => {
      const botId = botOf(params);
      const book = load(botId);
      const pin = find(book, params.id);
      const by = params.by === "seen" ? "seen" : "user";
      if (by === "seen" && pin.state !== "done") throw new Error("這張卡還沒做完。");
      M.remove(book, pin.id, now(), by);
      save(botId, book);
      return { removed: { id: pin.id, title: pin.title }, by };
    }),
    // 釘回: the card comes back as it was
    expose("repin", (params) => {
      const botId = botOf(params);
      const book = load(botId);
      const id = M.isId(params.id) ? params.id : "";
      const pin = M.restore(book, id, now());
      if (!pin) throw new Error("釘不回去了（已滿，或這張卡已經過期）。");
      save(botId, book);
      return { id: pin.id };
    }),
    // the card was open: what it says is read
    expose("seen", (params) => {
      const botId = botOf(params);
      const book = load(botId);
      const pin = find(book, params.id);
      if (pin.updatedAt <= (pin.seenAt ?? 0)) return { unchanged: true };
      pin.seenAt = pin.updatedAt;
      save(botId, book);
      return { seen: true };
    }),
  ];
  return [...subs, ...methods];
}
