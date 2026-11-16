// botling.note, margin comments (旁註), program part: a question asked on a passage of the Note, the bot's answer, and the
// follow-ups, kept beside the Note and never in it (plugin storage `margin:<botId>`, not note.md, not note.db's cells).
// The question goes to the bot as a message of this plugin (api.bots.send without `as: "user"`: it needs no permission, the
// chat shows it as the Note's message and the bot answers there as usual); the answer is read back from the bot's reply
// (turnFinished) by the id the bot names on its first line, 〔回答 c-0001〕, else by the only question that was waiting.
// Design and limits: src/MARGIN.md (in src/ so the build does not ship it).
import type { BotlingApi } from "../../../../Web/host/src/api";

export const MAX_THREADS = 200;
export const MAX_TURNS = 50;
export const MAX_QUESTION = 4_000;
export const MAX_QUOTE = 4_000;
export const MAX_LABEL = 400;
export const MAX_ANSWER = 30_000;
/** A bot's book in storage.json (the plugin's one file, rewritten whole on every save): no new question past this many bytes. */
export const MAX_BOOK_BYTES = 1_000_000;
/** Questions waiting at once per bot: each may still bring an answer of MAX_ANSWER, so the book stays bounded past MAX_BOOK_BYTES. */
export const MAX_WAITING = 10;
const ID = /^c-\d{4,}$/;
const RID = /^[A-Za-z0-9_-]{1,64}$/;
const ANSWER_TAG = /〔回答 (c-\d{4,})〕/g;
const ASK_TAG = /^〔Note 旁註 (c-\d{4,})/;

export type Kind = "text" | "lines" | "cell";
export type Scope = "selection" | "cell" | "note";
export interface Anchor { cell: string; label: string; kind: Kind; scope: Scope; quote: string }
/** `a` null: the bot has not answered yet. `rid`: the frame's request id, so a retry never sends twice. */
export interface Turn { rid: string; q: string; a: string | null; qAt: number; aAt: number | null; seenAt: number | null; messageId?: string }
export interface Thread { id: string; anchor: Anchor; turns: Turn[]; folded: boolean; created: number; updated: number }
interface Book { seq: number; threads: Thread[] }

type Params = Record<string, unknown>;
type Expose = (method: string, fn: (params: Params) => unknown) => () => void;

/** Control characters escaped away (a quote or a question is the user's text, but it ends up in a prompt and a log): newlines and tabs stay. */
export function clean(value: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g, "").slice(0, max);
}
const oneLine = (value: unknown, max: number): string => clean(value, max).replace(/\s*\n\s*/g, " ").trim();
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const KINDS: readonly Kind[] = ["text", "lines", "cell"];
const SCOPES: readonly Scope[] = ["selection", "cell", "note"];

function readAnchor(raw: unknown): Anchor | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Params;
  const kind = KINDS.find((k) => k === a.kind);
  const scope = SCOPES.find((s) => s === a.scope);
  const quote = clean(a.quote, MAX_QUOTE);
  if (!kind || !scope || !quote.trim()) return null;
  const cell = typeof a.cell === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(a.cell) ? a.cell : "";
  return { cell, label: oneLine(a.label, MAX_LABEL), kind, scope, quote };
}

function readTurn(raw: unknown): Turn | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Params;
  if (typeof t.rid !== "string" || !RID.test(t.rid) || typeof t.q !== "string") return null;
  const a = typeof t.a === "string" ? t.a.slice(0, MAX_ANSWER) : null;
  return {
    rid: t.rid, q: t.q.slice(0, MAX_QUESTION), a, qAt: num(t.qAt), aAt: a === null ? null : num(t.aAt),
    seenAt: typeof t.seenAt === "number" ? t.seenAt : null, ...(typeof t.messageId === "string" ? { messageId: t.messageId.slice(0, 200) } : {}),
  };
}

/** What storage holds, trimmed to a book: anything that is not a thread of the shape below is dropped (a hand-edited or older file). */
export function readBook(raw: unknown): Book {
  const book: Book = { seq: 0, threads: [] };
  if (!raw || typeof raw !== "object") return book;
  const r = raw as Params;
  book.seq = Math.max(0, Math.floor(num(r.seq)));
  const seen = new Set<string>();
  for (const item of Array.isArray(r.threads) ? r.threads.slice(0, MAX_THREADS) : []) {
    if (!item || typeof item !== "object") continue;
    const t = item as Params;
    const anchor = readAnchor(t.anchor);
    const turns = (Array.isArray(t.turns) ? t.turns.slice(0, MAX_TURNS) : []).map(readTurn).filter((x): x is Turn => !!x);
    if (typeof t.id !== "string" || !ID.test(t.id) || seen.has(t.id) || !anchor || !turns.length) continue;
    seen.add(t.id);
    book.threads.push({ id: t.id, anchor, turns, folded: t.folded === true, created: num(t.created), updated: num(t.updated) });
    book.seq = Math.max(book.seq, Number(t.id.slice(2)));
  }
  return book;
}

const SCOPE_WORDS: Record<Scope, string> = { selection: "選取的那段文字", cell: "整個 cell", note: "整份 Note（要看就讀整份）" };

/** The message the bot gets for turn `index` of `thread`: where the question is from, the quote, the question and how to answer. */
export function askText(thread: Thread, index: number): string {
  const { anchor } = thread;
  const turn = thread.turns[index];
  const quote = `${anchor.label ? `> 〔${anchor.label}〕\n` : ""}${anchor.quote.split("\n").map((l) => (l.trim() ? `> ${l}` : ">")).join("\n")}`;
  const first = index === 0;
  return [
    first
      ? `〔Note 旁註 ${thread.id}〕使用者在 Note 上選了一段，直接在旁註裡問你。`
      : `〔Note 旁註 ${thread.id} · 追問〕使用者在同一則旁註裡接著問你。`,
    `引用：\n${quote}`,
    `範圍：${SCOPE_WORDS[anchor.scope]}${anchor.cell ? `（要看上下文，用 app_note_read 讀 #${anchor.cell}）` : ""}`,
    `問題：\n${turn.q}`,
    `怎麼回：第一行只寫 〔回答 ${thread.id}〕，下一行起直接回答（Markdown，精簡）。這個回答會掛在 Note 右側的旁註上，使用者在那裡讀；不要改 Note 的內容，除非問題裡明確要你改。`,
  ].join("\n\n");
}

/** The ids a reply names (〔回答 c-0001〕), and the reply without those tags. */
export function splitReply(text: string): { ids: string[]; body: string } {
  const ids = [...new Set(text.match(ANSWER_TAG)?.map((tag) => tag.slice(4, -1)) ?? [])];
  // a tag the bot wrapped in Markdown (**〔回答 c-0001〕**, `…`) leaves its marks on the first line: that line goes too
  const body = clean(text.replace(ANSWER_TAG, ""), MAX_ANSWER * 2).replace(/^[ \t*_`~]*\n/, "").trim();
  return { ids, body: body.slice(0, MAX_ANSWER) };
}

const botOf = (params: Params): string => {
  const id = params.botId;
  if (typeof id !== "string" || !id || id.length > 200) throw new Error("No bot.");
  return id;
};
const keyOf = (botId: string) => `margin:${botId}`;

export function activateMargin(api: BotlingApi, expose: Expose, now: () => number = Date.now) {
  const load = (botId: string): Book => {
    const raw = typeof api.storage?.get === "function" ? api.storage.get(keyOf(botId)) : null;
    return readBook(raw);
  };
  const save = (botId: string, book: Book) => {
    if (typeof api.storage?.set !== "function") throw new Error("unavailable: storage");
    api.storage.set(keyOf(botId), book);
  };
  const changed = (botId: string) => api.ui.emit("marginChanged", { botId }, { botId });
  const open = (turn: Turn | undefined) => !!turn && turn.a === null;
  const view = (thread: Thread) => ({ ...thread, answering: open(thread.turns[thread.turns.length - 1]) });
  const find = (book: Book, id: unknown): Thread => {
    const thread = typeof id === "string" && ID.test(id) ? book.threads.find((t) => t.id === id) : undefined;
    if (!thread) throw new Error("這則旁註已經不在了。");
    return thread;
  };

  // ---- the bot's turns: which question a reply answers ----
  const turnStart = new Map<string, number>(); // botId -> when its latest turn began
  const lastBotLine = new Map<string, { text: string; at: number; id: string }>();
  // the bots with a question waiting (events of other bots cost nothing); kept in storage so a restart still hears the answer
  const INDEX = "margin:bots";
  const bots = new Set<string>();
  try {
    const kept = typeof api.storage?.get === "function" ? api.storage.get(INDEX) : null;
    for (const id of Array.isArray(kept) ? kept.slice(0, 200) : []) if (typeof id === "string" && id && id.length <= 200) bots.add(id);
  } catch { /* no index: the first list or ask of a bot adds it again */ }
  const track = (botId: string, on: boolean) => {
    if (on === bots.has(botId)) return;
    if (on) bots.add(botId); else bots.delete(botId);
    try { api.storage.set(INDEX, [...bots]); } catch { /* kept in memory only */ }
  };
  const waiting = (book: Book) => book.threads.filter((t) => open(t.turns[t.turns.length - 1]));

  // The question's own line showed in the chat: from then on a turn that begins is one that can answer it.
  const seen = (botId: string, text: string) => {
    const tag = ASK_TAG.exec(text);
    if (!tag || !bots.has(botId)) return;
    const book = load(botId);
    const thread = book.threads.find((t) => t.id === tag[1]);
    const turn = thread?.turns[thread.turns.length - 1];
    if (!thread || !open(turn) || turn!.seenAt !== null) return;
    turn!.seenAt = now();
    try { save(botId, book); } catch { /* the turn then falls back to when the question was sent */ }
  };

  const answered = (botId: string, reply: string, started: number): void => {
    const { ids, body } = splitReply(reply);
    if (!body) return;
    const book = load(botId);
    const hit = new Set<string>();
    const fill = (thread: Thread) => {
      const turn = thread.turns[thread.turns.length - 1];
      if (!open(turn)) return;
      turn.a = body;
      turn.aAt = now();
      thread.updated = turn.aAt;
      hit.add(thread.id);
    };
    for (const thread of book.threads) if (ids.includes(thread.id)) fill(thread);
    if (!hit.size && !ids.length) {
      // no id named: the one question waiting, when its line was in the chat before this turn began
      const list = waiting(book);
      const only = list.length === 1 ? list[0] : null;
      const turn = only?.turns[only.turns.length - 1];
      if (only && turn && (turn.seenAt ?? turn.qAt) <= started) fill(only);
    }
    if (!hit.size) return;
    save(botId, book);
    track(botId, waiting(book).length > 0);
    changed(botId);
  };

  const subs = [
    api.events.on("turnStarted", ({ botId }) => { if (bots.has(botId)) turnStart.set(botId, now()); }),
    api.events.on("messagePosted", ({ botId, role, text, id }) => {
      if (!bots.has(botId)) return;
      if (role === "bot") lastBotLine.set(botId, { text: String(text ?? ""), at: now(), id });
      else seen(botId, String(text ?? ""));
    }),
    api.events.on("turnFinished", ({ botId, ok, reply }) => {
      if (!bots.has(botId)) return;
      try {
        const line = lastBotLine.get(botId);
        const started = turnStart.get(botId) ?? 0;
        const text = String(reply || (line && line.at >= started ? line.text : "") || "").trim();
        if (ok && text) answered(botId, text, started);
      } catch (error) {
        console.error("botling.note: margin answer", error);
      }
    }),
  ];

  // a question that was waiting when the app restarted can still be answered: its bot is listened for again on the first ask or list
  const watch = (botId: string, book: Book) => track(botId, waiting(book).length > 0);

  const methods = [
    expose("marginList", (params) => {
      const botId = botOf(params);
      const book = load(botId);
      watch(botId, book);
      return { threads: book.threads.map(view) };
    }),
    expose("marginAsk", async (params) => {
      const botId = botOf(params);
      const rid = typeof params.rid === "string" && RID.test(params.rid) ? params.rid : "";
      if (!rid) throw new Error("沒有這次提問的編號。");
      const q = clean(params.question, MAX_QUESTION).trim();
      if (!q) throw new Error("問題是空的。");
      const book = load(botId);
      // a retry of a request that already went (a double tap, a repeated call): the same answer, nothing sent again
      const dup = book.threads.find((t) => t.turns.some((x) => x.rid === rid));
      if (dup) return { thread: view(dup), duplicate: true };
      if (new TextEncoder().encode(JSON.stringify(book)).length > MAX_BOOK_BYTES) throw new Error("旁註存得太多了，請先刪掉幾則。");
      if (waiting(book).length >= MAX_WAITING) throw new Error(`同時在等的旁註最多 ${MAX_WAITING} 則，等回答回來再問。`);
      const at = now();
      let thread: Thread;
      if (params.id !== undefined) {
        thread = find(book, params.id);
        if (open(thread.turns[thread.turns.length - 1])) throw new Error("上一個問題還在回答中，等它回來再追問。");
        if (thread.turns.length >= MAX_TURNS) throw new Error("這則旁註的追問太多了，請另開一則。");
        thread.turns.push({ rid, q, a: null, qAt: at, aAt: null, seenAt: null });
        thread.updated = at;
        thread.folded = false;
      } else {
        const anchor = readAnchor(params.anchor);
        if (!anchor) throw new Error("沒有可以掛旁註的引用。");
        if (book.threads.length >= MAX_THREADS) throw new Error(`旁註最多 ${MAX_THREADS} 則，請先刪掉幾則。`);
        book.seq += 1;
        thread = { id: `c-${String(book.seq).padStart(4, "0")}`, anchor, turns: [{ rid, q, a: null, qAt: at, aAt: null, seenAt: null }], folded: false, created: at, updated: at };
        book.threads.push(thread);
      }
      const turn = thread.turns[thread.turns.length - 1];
      save(botId, book);
      track(botId, true);
      changed(botId);
      let sent: { messageId?: unknown } | null | undefined;
      try {
        sent = await api.bots.send(botId, askText(thread, thread.turns.length - 1));
      } catch (error) {
        // not sent: nothing is waiting for an answer
        const book2 = load(botId);
        const t2 = book2.threads.find((t) => t.id === thread.id);
        if (t2) {
          t2.turns = t2.turns.filter((x) => x.rid !== turn.rid);
          if (!t2.turns.length) book2.threads = book2.threads.filter((t) => t !== t2);
        }
        save(botId, book2);
        track(botId, waiting(book2).length > 0);
        changed(botId);
        throw new Error(`沒能把問題送給 bot：${oneLine((error as Error)?.message ?? error, 200)}`);
      }
      // sent: from here a failure must not undo the turn (a retry would send the question twice)
      try {
        const now2 = load(botId);
        const mine = now2.threads.find((t) => t.id === thread.id)?.turns.find((x) => x.rid === rid);
        if (mine && sent?.messageId) { mine.messageId = String(sent.messageId).slice(0, 200); save(botId, now2); }
      } catch { /* the message id is only a note */ }
      const done = load(botId);
      return { thread: view(done.threads.find((t) => t.id === thread.id) ?? thread) };
    }),
    expose("marginFold", (params) => {
      const botId = botOf(params);
      const book = load(botId);
      find(book, params.id).folded = params.folded === true;
      save(botId, book);
      return { saved: true };
    }),
    expose("marginDelete", (params) => {
      const botId = botOf(params);
      const book = load(botId);
      const thread = find(book, params.id);
      book.threads = book.threads.filter((t) => t !== thread);
      save(botId, book);
      track(botId, waiting(book).length > 0);
      changed(botId);
      return { deleted: true };
    }),
    // stop waiting for an answer that is not coming: the unanswered question goes (the thread too when it was the only one)
    expose("marginCancel", (params) => {
      const botId = botOf(params);
      const book = load(botId);
      const thread = find(book, params.id);
      if (open(thread.turns[thread.turns.length - 1])) thread.turns.pop();
      if (!thread.turns.length) book.threads = book.threads.filter((t) => t !== thread);
      save(botId, book);
      track(botId, waiting(book).length > 0);
      changed(botId);
      return { cancelled: true };
    }),
  ];
  return [...subs, ...methods];
}
