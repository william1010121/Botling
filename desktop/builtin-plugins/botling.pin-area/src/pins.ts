// botling.pin-area, program part: the books of pins (one per bot, plugin storage `pins:<botId>`), what bots and the user do to them,
// and what each chat's page draws (`chat.setData`). The rules themselves are model.ts's; this file only reads the events, the
// tags and the hook, and keeps the books. Design and limits: ../DESIGN.md.
import type { BotlingApi } from "../../../../Web/host/src/api";
import * as M from "./model";
import * as D from "./digest";
import * as C from "./classify";
import { askHaiku, type Ask } from "./haiku";

export const PLUGIN = "botling.pin-area";
const INDEX = "pins:bots";
const PRESENCE = "presence";
const keyOf = (botId: string) => `pins:${botId}`;
/** A bot's tags this many times in a minute are enough: the rest are dropped (a loop of tags cannot churn the book). */
const TAGS_PER_MINUTE = 30;
const MAX_BOTS = 200;
const MAX_FOLLOWED = 2_000;
const MAX_ENDS = 50;
/** The presence (when the user was last seen) is written to storage at most this often; a digest opening or closing is written at once. */
const PRESENCE_SAVE_MS = 5 * 60_000;
/** What other bots wait on is read again when a sign of the user comes and it is older than this. */
const WAITING_FRESH_MS = 30_000;

type Params = Record<string, unknown>;
type Expose = (method: string, fn: (params: Params) => unknown) => () => void;

const botOf = (params: Params): string => {
  const id = params.botId;
  if (typeof id !== "string" || !id || id.length > 200) throw new Error("No bot.");
  return id;
};
const own = (attributes: Record<string, string>, name: string): string => (Object.hasOwn(attributes, name) ? attributes[name]! : "");

/** The classifier's model call: the claude CLI as Botling starts it (null: this Botling has none, and plain lines stay in the chat). */
const viaClaude = (api: BotlingApi): Ask | null =>
  typeof api.engines?.cli === "function"
    ? async (prompt) => {
        const cli = await api.engines.cli("claude");
        if (!cli) throw new Error("no claude");
        return askHaiku(cli, prompt);
      }
    : null;

/** `ask`: the model call for the lines of the user's no @card names (tests give a fake one; null: none, so no line is sorted). */
export function activatePins(api: BotlingApi, expose: Expose, now: () => number = Date.now, ask: Ask | null = viaClaude(api)) {
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

  // ---- 「你不在時」: when the user was last here, the digest open now, and what other bots wait on (read again from the app, never from files) ----
  let presence = D.readPresence(typeof api.storage?.get === "function" ? api.storage.get(PRESENCE) : null);
  let presenceSaved = now();
  const savePresence = (force: boolean) => {
    const at = now();
    if (!force && at - presenceSaved < PRESENCE_SAVE_MS) return;
    presenceSaved = at;
    try { api.storage.set(PRESENCE, presence); } catch { /* kept in memory only */ }
  };
  const waiting = { at: 0, items: [] as D.WaitingItem[], names: new Map<string, string>() };
  /** `workspace.waiting()` and the bots' names. A failure leaves nothing (a line that may be stale is worse than none). */
  const refreshWaiting = async (): Promise<void> => {
    try {
      const [list, said] = await Promise.all([
        typeof api.workspace?.bots === "function" ? api.workspace.bots() : [],
        typeof api.workspace?.waiting === "function" ? api.workspace.waiting() : { items: [] },
      ]);
      waiting.names = new Map(list.map((bot): [string, string] => [bot.id, bot.name]));
      waiting.items = (Array.isArray(said?.items) ? said.items : []).filter((item) => item && typeof item.botId === "string" && typeof item.text === "string");
    } catch {
      waiting.names = new Map();
      waiting.items = [];
    }
    waiting.at = now();
  };
  const digestFor = (botId: string, book: M.Book): D.DigestView | null =>
    presence.away ? D.digestOf(book, presence.away, D.othersOf(waiting.items, waiting.names, botId)) : null;
  /** What the chat draws for a bot: its cards, and the digest while one is open. */
  const viewFor = (botId: string, book: M.Book): D.PinsView => {
    const away = digestFor(botId, book);
    return { ...M.viewOf(book, now()), ...(away ? { away } : {}) };
  };

  /** What the chat of `botId` draws from now on. A chat the app does not know (a bot that was removed) just takes nothing. */
  const decorated = new Set<string>();
  const published = new Set<string>();
  const publish = (botId: string, book = load(botId)) => {
    if (published.size < MAX_BOTS) published.add(botId);
    try { void Promise.resolve(api.chat.setData(botId, viewFor(botId, book) as never)).catch(() => {}); } catch { /* no page to draw it */ }
    // the traces of lines the bot moved into cards (a chat with none and none before is not asked at all)
    const traces = M.tracesOf(book);
    if (!traces.length && !decorated.has(botId)) return;
    if (traces.length) decorated.add(botId); else decorated.delete(botId);
    try { void Promise.resolve(api.chat.decorate(botId, traces as never)).catch(() => {}); } catch { /* no page to draw it */ }
  };
  const save = (botId: string, book: M.Book) => {
    if (typeof api.storage?.set !== "function") throw new Error("unavailable: storage");
    M.fit(book);
    api.storage.set(keyOf(botId), book);
    track(botId, book.pins.length > 0 || book.removed.length > 0);
    reindex(botId, book);
    publish(botId, book);
  };

  /**
   * What time does to the cards (`M.sweep`): done for an hour takes itself down, workers all ended and 20 minutes of silence marks 可能已過時.
   * Run when the page asks, before a briefing, and once a minute for every bot that has cards. Saves (and so draws) only what changed.
   */
  const sweepBook = (botId: string): boolean => {
    try {
      const book = load(botId);
      const swept = M.sweep(book, now());
      if (swept.changed) save(botId, book);
      return swept.changed;
    } catch (error) {
      console.error("botling.pin-area: sweep", error);
      return false;
    }
  };

  // ---- what a card follows: a worker's task id (its end is `workerDone`) or a sub bot's id (its replies), by the bot whose card follows it ----
  const followers = new Map<string, string>();
  const reindex = (botId: string, book: M.Book) => {
    for (const [id, owner] of followers) if (owner === botId) followers.delete(id);
    for (const id of M.linksOf(book)) if (followers.size < MAX_FOLLOWED) followers.set(id, botId);
  };
  for (const id of bots) reindex(id, load(id));
  /** The ends of workers just seen, so a card that names a worker after it ended still gets its report. */
  const ends = new Map<string, { botId: string; kind: M.NewsKind; text: string }>();
  const news = (botId: string, id: string, item: { kind: M.NewsKind; from: "worker" | "bot"; text: string }): boolean => {
    const book = load(botId);
    const pins = book.pins.filter((pin) => pin.from?.includes(id));
    let any = false;
    for (const pin of pins) {
      if (M.applyNews(pin, item, now())) any = true;
      // a worker's own report goes into the card in full (even a card already done keeps it), not only its first line
      if (item.from === "worker" && M.addWorkerTurn(pin, id, M.workerKindOf(item.kind), item.text, now())) any = true;
      // its end: the card is not waiting on that worker any more (a card whose last worker reported is nudged to be closed)
      if (item.from === "worker" && M.workerEnded(pin, id, item.kind, now())) any = true;
    }
    if (any) save(botId, book);
    return any;
  };
  /** A worker began a run for a job its bot named: the open card that name points at follows it from now on (none, or two alike: it stays in the chat). */
  const bind = (botId: string, workerId: string, group: string): void => {
    const book = load(botId);
    if (M.cardOfWorker(book, workerId)) return;
    const pin = M.cardForGroup(book, group);
    if (!pin) return;
    M.linkFrom(pin, [workerId], M.MAX_LINKED);
    M.workerLive(pin, workerId);
    M.logLine(pin, `worker 開工：${group}`, now());
    save(botId, book);
    // it may have ended before this was heard (the events of one run come close together)
    const ended = ends.get(workerId);
    if (ended && ended.botId === botId) news(botId, workerId, { kind: ended.kind, from: "worker", text: ended.text });
  };
  /** The worker reports (final or a note) a bot's turn carries, and the card ids they went into: the bot's reply is folded behind one line of trace. */
  const carried = new Map<string, string[]>();
  // A sub bot is followed only by the card of the bot it works under: its parent is checked now, not when the card was made.
  const parents = { at: 0, byId: new Map<string, string | null>() };
  const parentOf = async (id: string): Promise<string | null> => {
    if (now() - parents.at > 60_000 || !parents.byId.has(id)) {
      const list = typeof api.workspace?.bots === "function" ? await api.workspace.bots() : [];
      parents.byId = new Map(list.map((bot): [string, string | null] => [bot.id, bot.parent]));
      parents.at = now();
    }
    return parents.byId.get(id) ?? null;
  };

  // ---- which turn of the bot an answer can belong to ----
  const turnStart = new Map<string, number>();
  // The plain line of the user that carried a briefing (the one a `move="yes"` answer is about), and the one the running turn answers.
  const lastLine = new Map<string, { id: string; text: string; at: number }>();
  const turnLine = new Map<string, { id: string; text: string; at: number }>();
  const lastBotLine = new Map<string, { text: string; at: number }>();
  /** Bots that used <pin-say> in the turn now running: the rest of that reply is meant for the chat, not for a waiting card. */
  const saidInTurn = new Set<string>();
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

  /**
   * The user's words written into a card as a new turn, and what the bot is sent for it (the card's header). `via` "auto": the app chose the card, so the
   * line gets a trace with 移回聊天 / 改到…. False: the same words just went (a double send). The book is read again here: it may have changed meanwhile.
   */
  const writeInto = (botId: string, pinId: string, words: string, via: M.Via): string | false | undefined => {
    const book = load(botId);
    const pin = book.pins.find((candidate) => candidate.id === pinId);
    if (!pin) return undefined;
    const at = now();
    if (M.pruneUnposted(book, at)) save(botId, book);
    // the same words again, at once: one send
    if (M.isDuplicate(pin, words, at)) return false;
    M.addTurn(pin, ridOf(), words, at, via);
    save(botId, book);
    return M.askText(pin, M.clean(words, M.MAX_ROUTED));
  };

  /** The newest lines of the chat as the classifier reads them: the user's and the bot's words, without a briefing or a card's header, nothing the app wrote. */
  const recentLines = async (botId: string): Promise<C.Recent[]> => {
    try {
      const data = await api.chat.messages(botId, { limit: 12 });
      const lines: C.Recent[] = [];
      for (const record of data.messages as unknown as { role?: unknown; text?: unknown }[]) {
        if ((record.role !== "user" && record.role !== "bot") || typeof record.text !== "string") continue;
        const own = record.role === "user" ? (M.parseAsk(record.text)?.text ?? M.stripBriefing(record.text)) : record.text;
        if (own.trim() && !own.startsWith("<app_")) lines.push({ who: record.role, text: own });
      }
      return lines.slice(-C.RECENT_LINES);
    } catch {
      return [];
    }
  };
  /** Bots whose line is being sorted now: a second line meanwhile goes to the chat unsorted (the order of the user's lines is kept). */
  const sorting = new Set<string>();
  /**
   * A plain line of a chat that has cards, asked of the small model (no tools): assign (written into the card like an @card, with an automatic turn the user can
   * take back), new or merge (only suggested; the user taps), or chat. Any failure, a slow answer or a low confidence leaves the line in the chat, with the briefing.
   */
  const sortLine = async (botId: string, text: string): Promise<string | false | undefined> => {
    sorting.add(botId);
    const plain = (): string | undefined => {
      const brief = M.briefing(load(botId), now());
      return brief ? M.withBriefing(text, brief) : undefined;
    };
    try {
      const book = load(botId);
      const verdict = C.parseVerdict(await ask!(C.classifyPrompt(book, await recentLines(botId), text)));
      // after the waits: the book as it is now decides (a card may be gone, the user may have written into it)
      const fresh = load(botId);
      const decision = C.decide(fresh, verdict);
      if (decision.kind === "assign" && text.length <= M.MAX_ROUTED) {
        const sent = writeInto(botId, decision.pin.id, text, "auto");
        if (sent !== undefined) return sent;
      } else if (decision.kind === "new" || decision.kind === "merge") {
        const made = M.addSuggest(fresh, decision.kind === "new" ? { kind: "new", text } : { kind: "merge", text, card: decision.keep.id, card2: decision.drop.id }, ridOf(), now());
        if (made) save(botId, fresh);
      }
      return plain();
    } catch (error) {
      console.error("botling.pin-area: sort", error instanceof Error ? error.message : "failed");
      return plain();
    } finally {
      sorting.delete(botId);
    }
  };

  const subs = [
    // the bot's turn began: what was in the chat before it has been seen
    api.events.on("turnStarted", ({ botId, reports }) => {
      if (!bots.has(botId)) return;
      turnStart.set(botId, now());
      // the line that was in the chat before this turn began is the one it answers; a line that comes while it runs waits for the next turn
      const line = lastLine.get(botId);
      if (line) { turnLine.set(botId, line); lastLine.delete(botId); } else turnLine.delete(botId);
      saidInTurn.delete(botId);
      if (reports?.length) carried.set(botId, reports.filter(M.isFrom).slice(0, 8)); else carried.delete(botId);
      const book = load(botId);
      if (M.markSeen(book, now())) save(botId, book);
    }),
    api.events.on("messagePosted", ({ botId, role, text, id }) => {
      // the user wrote something, in any chat: the digest is gone
      if (role === "user") {
        const sent = D.messaged(presence, now());
        presence = sent.presence;
        savePresence(sent.cleared);
        if (sent.cleared) for (const other of published) publish(other);
      }
      // a sub bot a card follows spoke: its reply goes into that card (the parent is checked first)
      if (role === "bot" && followers.has(botId) && followers.get(botId) !== botId) void subBotNews(botId, String(text ?? ""));
      if (!bots.has(botId)) return;
      if (role === "bot") {
        lastBotLine.set(botId, { text: String(text ?? ""), at: now() });
        // the bot's reply to a worker's report that a card holds in full: one line of trace in the chat, the words kept with it
        const workers = carried.get(botId);
        if (workers?.length && typeof id === "string" && id) {
          carried.delete(botId);
          const book = load(botId);
          if (M.attachReply(book, workers, id, String(text ?? ""), now())) save(botId, book);
        }
        return;
      }
      if (M.hasBriefing(String(text ?? "")) && typeof id === "string" && id) lastLine.set(botId, { id, text: M.stripBriefing(String(text)), at: now() });
      const asked = M.parseAsk(String(text ?? ""));
      if (!asked) return;
      const book = load(botId);
      if (M.markPosted(book, asked.id, now(), typeof id === "string" ? id : undefined)) save(botId, book);
    }),
    // a reply with no <pin-say>: the one card waiting for an answer takes it
    api.events.on("turnFinished", ({ botId, ok, reply }) => {
      if (!bots.has(botId)) return;
      turnLine.delete(botId);
      carried.delete(botId);
      try {
        const line = lastBotLine.get(botId);
        const started = turnStart.get(botId) ?? 0;
        const text = String(reply || (line && line.at >= started ? line.text : "") || "").trim();
        // the core hands the tags over before the turn ends and takes them out of `reply`: a turn that had one is the tag's
        const said = saidInTurn.delete(botId);
        if (!ok || !text || said || text.includes("<pin-say")) return;
        const book = load(botId);
        if (M.answerOnlyWaiting(book, text, started, now()) !== null) save(botId, book);
      } catch (error) {
        console.error("botling.pin-area: answer", error);
      }
    }),

    // a worker ended a run: a card of that bot that follows it gets the news (a worker of another bot's is not heard: the event's bot is the book)
    api.events.on("workerDone", ({ botId, workerId, status, report }) => {
      try {
        if (typeof workerId !== "string" || !M.isFrom(workerId)) return;
        const kind: M.NewsKind = status === "completed" ? "completed" : status === "failed" ? "failed" : status === "stopped" ? "stopped" : "interrupted";
        if (ends.size >= MAX_ENDS) ends.delete(ends.keys().next().value!);
        ends.delete(workerId);
        ends.set(workerId, { botId, kind, text: String(report ?? "") });
        if (bots.has(botId)) news(botId, workerId, { kind, from: "worker", text: String(report ?? "") });
      } catch (error) {
        console.error("botling.pin-area: workerDone", error);
      }
    }),

    // a worker began a run for a named job: the card of that name follows it
    api.events.on("workerStarted", ({ botId, workerId, group }) => {
      try {
        if (!bots.has(botId) || typeof workerId !== "string" || !M.isFrom(workerId) || typeof group !== "string" || !group.trim()) return;
        bind(botId, workerId, group);
      } catch (error) {
        console.error("botling.pin-area: workerStarted", error);
      }
    }),
    // a worker at work sent its owner a note: it goes into the card that follows it (thread and 過程 log)
    api.events.on("workerNote", ({ botId, workerId, kind, message }) => {
      try {
        if (!bots.has(botId) || typeof workerId !== "string" || !M.isFrom(workerId) || followers.get(workerId) !== botId) return;
        const book = load(botId);
        const pin = M.cardOfWorker(book, workerId);
        if (pin && M.applyWorkerNote(pin, workerId, kind === "question" ? "question" : "report", String(message ?? ""), now())) save(botId, book);
      } catch (error) {
        console.error("botling.pin-area: workerNote", error);
      }
    }),

    // what a bot writes: its own cards, and the answers in a card's thread. Only the bot that wrote the tag is touched (tag.bot).
    api.replyTags.on("pin-card", (tag) => {
      const botId = tag.bot.id;
      if (!allowed(botId)) return;
      try {
        const book = load(botId);
        const before = new Set(M.linksOf(book));
        const outcome = M.applyCardTag(book, tag.attributes, tag.body, now());
        if (outcome === "created" || outcome === "updated" || outcome === "unpinned") save(botId, book);
        // a worker that already ended before the card named it: its report is not lost
        for (const id of M.linksOf(book)) {
          const ended = before.has(id) ? undefined : ends.get(id);
          if (ended && ended.botId === botId) news(botId, id, { kind: ended.kind, from: "worker", text: ended.text });
        }
      } catch (error) {
        console.error("botling.pin-area: pin-card", error);
      }
    }),
    api.replyTags.on("pin-say", (tag) => {
      const botId = tag.bot.id;
      if (bots.has(botId)) saidInTurn.add(botId);
      if (!allowed(botId)) return;
      try {
        const book = load(botId);
        const id = own(tag.attributes, "id").trim();
        if (M.truthy(own(tag.attributes, "move"))) {
          // the bot judged that the user's plain line belongs to this card: the line and this answer go into it (once per line)
          const line = turnLine.get(botId);
          if (line && M.takeAuto(book, id, line, tag.body, ridOf(), now())) { turnLine.delete(botId); save(botId, book); }
          // no line left to move (none behind this turn, or it moved already): the core has taken the tag out of the reply, so the
          // answer is kept in that card as its own turn, never dropped
          else if (M.keepAnswer(book, id, tag.body, now())) save(botId, book);
          return;
        }
        if (M.answerTurn(book, id, tag.body, now())) save(botId, book);
      } catch (error) {
        console.error("botling.pin-area: pin-say", error);
      }
    }),

    // "@card words" from the main input box or the card's own: written into the card's thread, sent to the bot with the card's header.
    // A plain line of a chat that has cards is sorted by the small model (`sortLine`): into a card like an @card, or it stays in the chat.
    api.hooks.beforeSend((message) => {
      const botId = message.bot.id;
      if (!bots.has(botId)) return;
      sweepBook(botId);
      const book = load(botId);
      const hit = M.route(book, message.text);
      if (!hit && M.briefable(message.text)) {
        const brief = M.briefing(book, now());
        if (!brief) return undefined;
        if (!ask || message.text.trim().length < C.MIN_LINE || sorting.has(botId)) return M.withBriefing(message.text, brief);
        return sortLine(botId, message.text);
      }
      if (!hit || hit.rest.length > M.MAX_ROUTED) return;
      return writeInto(botId, hit.pin.id, hit.rest, "at");
    }),
  ];

  async function subBotNews(subId: string, text: string): Promise<void> {
    try {
      const owner = followers.get(subId);
      if (!owner || owner === subId || !M.isFrom(subId) || !text.trim()) return;
      if ((await parentOf(subId)) !== owner) return;
      // after the await: the card may be gone or no longer follow it
      if (followers.get(subId) !== owner) return;
      news(owner, subId, { kind: "reply", from: "bot", text });
    } catch (error) {
      console.error("botling.pin-area: sub bot", error);
    }
  }

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
      sweepBook(botId);
      const book = load(botId);
      publish(botId, book);
      return viewFor(botId, book);
    }),
    // the page was used (it says so at most once a minute): after a gap of 30 minutes or more the digest opens, for every chat
    expose("touch", async (params) => {
      const botId = botOf(params);
      for (const other of bots) sweepBook(other);
      const seen = D.present(presence, now());
      presence = seen.presence;
      savePresence(seen.started);
      if (!presence.away) return { away: false };
      // a new digest, or one that has been open a while: the other bots' lines are read again, and every chat draws what is true now
      // (a message sent meanwhile has already taken the digest away: `presence` is read again by `publish`)
      if (seen.started || now() - waiting.at > WAITING_FRESH_MS) {
        await refreshWaiting();
        for (const other of new Set([...published, botId])) publish(other);
      }
      return { away: presence.away !== null };
    }),
    // 看完了 (the digest folds to its one-line chip) and the chip's reopen: one state for every chat
    expose("collapse", (params) => {
      const next = D.collapse(presence, params.collapsed !== false);
      if (!next) return { unchanged: true };
      presence = next;
      savePresence(true);
      for (const other of published) publish(other);
      return { collapsed: next.away?.collapsed ?? false };
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
    // a suggestion of the app's was tapped (a new card for the line, or the two cards merged); it is taken out of the book first, so a double tap does it once
    expose("acceptSuggest", (params) => {
      const botId = botOf(params);
      const book = load(botId);
      const id = M.isRid(params.id) ? params.id : "";
      const item = M.takeSuggest(book, id, now());
      if (!item) return { unchanged: true };
      if (item.kind === "merge") {
        const kept = M.mergeCards(book, item.card ?? "", item.card2 ?? "", now());
        save(botId, book);
        if (!kept) throw new Error("這兩張卡已經變了，沒有合併。");
        return { merged: kept.id, closed: item.card2 };
      }
      const made = M.cardFromSuggestion(book, item, now());
      save(botId, book);
      if ("refused" in made) throw new Error(made.refused === "full" ? `最多釘 ${M.MAX_PINS} 張，先取消一張。` : "這句沒有可以釘的字。");
      return { id: made.pin.id };
    }),
    // 不用: the suggestion goes away
    expose("dismissSuggest", (params) => {
      const botId = botOf(params);
      const book = load(botId);
      if (!M.takeSuggest(book, M.isRid(params.id) ? params.id : "", now())) return { unchanged: true };
      save(botId, book);
      return { dismissed: true };
    }),
    // 移回聊天: the line the bot moved is the chat's again (its answer shows there, once); the bot is told by the next briefing
    expose("moveBack", (params) => {
      const botId = botOf(params);
      const book = load(botId);
      const rid = M.isRid(params.rid) ? params.rid : "";
      if (!M.moveBack(book, rid, now())) return { unchanged: true };
      save(botId, book);
      return { moved: "chat" };
    }),
    // 改到…: the line and its answer go to another card
    expose("moveTo", (params) => {
      const botId = botOf(params);
      const book = load(botId);
      const rid = M.isRid(params.rid) ? params.rid : "";
      const to = M.isId(params.to) ? params.to : "";
      if (!M.moveTo(book, rid, to, now())) return { unchanged: true };
      save(botId, book);
      return { moved: to };
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
  // once a minute, for the bots that have cards (the clock is the host's; a minute is as fine as the 20 minutes and the hour it counts)
  const timer = setInterval(() => { for (const botId of [...bots]) sweepBook(botId); }, 60_000);
  (timer as { unref?: () => void }).unref?.();
  return [...subs, ...methods, () => clearInterval(timer)];
}
