// botling.pin-area, the pure part: what a pin (a card in the strip above the chat) is, how a bot's tag or the user's action changes
// it, and how a message that starts with @handle is routed into a card's own thread. No Botling API, no clock of its own (`now` is
// passed in), no DOM: host.ts keeps the books and the web part draws the view. Design and limits: ../DESIGN.md.

export type State = "run" | "wait" | "done";
/** Who vouches for a card's status line: the bot itself, the app (a worker's own report: Phase 2) or the user (a card they pinned by hand). */
export type Source = "bot" | "app" | "user";
export type Via = "at" | "auto";

/**
 * One exchange in a card's thread. `postedAt`: the line showed in the chat; `seenAt`: a turn of the bot began after that (the bot saw it);
 * `a` null: not answered yet. `via`: how it got here (typed @card, or Phase 2's automatic routing); `moved`: the user took it back to
 * the chat (Phase 2's 移回聊天), kept so the thread still shows where it went.
 */
export interface Turn { rid: string; q: string; a: string | null; qAt: number; postedAt: number | null; seenAt: number | null; aAt: number | null; via: Via; moved?: boolean }
export interface Update { at: number; state: State; status: string; source: Source }
export interface Step { done: number; total: number }
export interface Pin {
  id: string;
  /** The name the bot gave it (`<pin-card id="…">`): how the same bot finds its card again. */
  botKey?: string;
  origin: "user" | "bot";
  title: string;
  /** What follows @ to write into it: the title without spaces, one of its own in the bot's pins. */
  handle: string;
  state: State;
  status: string;
  /** The status line before the last rewrite ("原本：…"). */
  prev?: string;
  source: Source;
  step?: Step;
  /** When it began waiting for the user (the 「你不在時」digest and the ordering read it); only while `state` is "wait". */
  waitingSince?: number;
  thread: Turn[];
  updates: Update[];
  /** The message it was made from (a pin of a message). */
  msgRef?: string;
  createdAt: number;
  updatedAt: number;
  /** When the user last had the card open: anything newer than this is unread. */
  seenAt?: number;
}
/** A card taken off the strip, kept briefly so 釘回 puts it back. */
export interface Removed { pin: Pin; at: number; by: "user" | "seen" | "bot" }
export interface Book { seq: number; pins: Pin[]; removed: Removed[] }

export const MAX_PINS = 8;
/** Cards a bot made that still are not done: a bot cannot fill the strip. */
export const MAX_BOT_OPEN = 3;
export const MAX_TURNS = 50;
export const MAX_UPDATES = 50;
export const MAX_REMOVED = 3;
export const MAX_TITLE = 40;
export const MAX_STATUS = 120;
export const MAX_Q = 2_000;
export const MAX_A = 4_000;
/** Longest message routed into a card (the bot gets all of it; the thread keeps MAX_Q). */
export const MAX_ROUTED = 20_000;
/** A bot's book in storage.json (rewritten whole on every save), as JSON-escaped UTF-8 bytes; older answers go first when it is over. */
export const MAX_BOOK_BYTES = 600_000;
/** A bot may make a card for a run only when it takes at least this many minutes (or when it needs the user). */
export const MIN_RUN_MINUTES = 10;
const ID = /^p-\d{4,}$/;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const RID = /^[A-Za-z0-9_-]{1,64}$/;
const STATES: readonly State[] = ["run", "wait", "done"];
const SOURCES: readonly Source[] = ["bot", "app", "user"];

/** Control characters escaped away (text of a bot or the user ends up in a prompt and a log): newlines and tabs stay. */
export function clean(value: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g, "").slice(0, max);
}
/** One clean line: newlines and runs of blanks become one space, and the brackets the card header uses are not allowed in. */
export function oneLine(value: unknown, max: number): string {
  return clean(value, max * 2).replace(/[〔〕]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
export const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
export const isKey = (value: unknown): value is string => typeof value === "string" && KEY.test(value);
export const isRid = (value: unknown): value is string => typeof value === "string" && RID.test(value);
export const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

// ---- reading what storage holds ----

function readStep(raw: unknown): Step | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { done, total } = raw as Record<string, unknown>;
  return stepOf(done, total) ?? undefined;
}
function stepOf(done: unknown, total: unknown): Step | null {
  if (typeof done !== "number" || typeof total !== "number" || !Number.isInteger(done) || !Number.isInteger(total)) return null;
  return total >= 1 && total <= 99 && done >= 0 && done <= total ? { done, total } : null;
}
function readTurn(raw: unknown): Turn | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (!isRid(t.rid) || typeof t.q !== "string") return null;
  const a = typeof t.a === "string" ? t.a.slice(0, MAX_A) : null;
  const time = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    rid: t.rid, q: t.q.slice(0, MAX_Q), a, qAt: num(t.qAt), postedAt: time(t.postedAt), seenAt: time(t.seenAt), aAt: a === null ? null : num(t.aAt),
    via: t.via === "auto" ? "auto" : "at", ...(t.moved === true ? { moved: true } : {}),
  };
}
function readUpdate(raw: unknown): Update | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const state = STATES.find((s) => s === u.state);
  const source = SOURCES.find((s) => s === u.source);
  if (!state || !source) return null;
  return { at: num(u.at), state, status: oneLine(u.status, MAX_STATUS), source };
}
export function readPin(raw: unknown): Pin | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const state = STATES.find((s) => s === p.state);
  const source = SOURCES.find((s) => s === p.source);
  const title = oneLine(p.title, MAX_TITLE);
  const handle = oneLine(p.handle, MAX_TITLE).replace(/\s+/g, "-");
  if (!isId(p.id) || !state || !source || !title || !handle || (p.origin !== "user" && p.origin !== "bot")) return null;
  const step = readStep(p.step);
  const seenSeen = typeof p.seenAt === "number" && Number.isFinite(p.seenAt) ? { seenAt: p.seenAt } : {};
  return {
    id: p.id, ...(isKey(p.botKey) ? { botKey: p.botKey } : {}), origin: p.origin, title, handle, state, status: oneLine(p.status, MAX_STATUS), ...(typeof p.prev === "string" && p.prev ? { prev: oneLine(p.prev, MAX_STATUS) } : {}),
    source, ...(step ? { step } : {}), ...(state === "wait" ? { waitingSince: num(p.waitingSince) } : {}),
    thread: (Array.isArray(p.thread) ? p.thread.slice(-MAX_TURNS) : []).map(readTurn).filter((x): x is Turn => !!x),
    updates: (Array.isArray(p.updates) ? p.updates.slice(-MAX_UPDATES) : []).map(readUpdate).filter((x): x is Update => !!x),
    ...(typeof p.msgRef === "string" && p.msgRef ? { msgRef: p.msgRef.slice(0, 200) } : {}), createdAt: num(p.createdAt), updatedAt: num(p.updatedAt), ...seenSeen,
  };
}
/** What storage holds, trimmed to a book: anything that is not a pin of the shape above is dropped (a hand-edited or older file). */
export function readBook(raw: unknown): Book {
  const book: Book = { seq: 0, pins: [], removed: [] };
  if (!raw || typeof raw !== "object") return book;
  const r = raw as Record<string, unknown>;
  book.seq = Math.max(0, Math.floor(num(r.seq)));
  const ids = new Set<string>();
  const take = (item: unknown): Pin | null => {
    const pin = readPin(item);
    if (!pin || ids.has(pin.id)) return null;
    ids.add(pin.id);
    book.seq = Math.max(book.seq, Number(pin.id.slice(2)));
    return pin;
  };
  for (const item of Array.isArray(r.pins) ? r.pins.slice(0, MAX_PINS) : []) { const pin = take(item); if (pin) book.pins.push(pin); }
  for (const item of Array.isArray(r.removed) ? r.removed.slice(-MAX_REMOVED) : []) {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : null;
    const pin = entry ? take(entry.pin) : null;
    if (!entry || !pin) continue;
    book.removed.push({ pin, at: num(entry.at), by: entry.by === "seen" || entry.by === "bot" ? entry.by : "user" });
  }
  return book;
}

/** Drops the oldest answered turns, then the oldest log lines, and the oldest removed cards, until the book fits MAX_BOOK_BYTES (an open turn is never dropped). */
export function fit(book: Book): Book {
  let guard = 0;
  while (bytesOf(book) > MAX_BOOK_BYTES && guard++ < 10_000) {
    if (book.removed.length) { book.removed.shift(); continue; }
    let victim: { pin: Pin; index: number } | null = null;
    for (const pin of book.pins) {
      const index = pin.thread.findIndex((turn) => turn.a !== null);
      if (index >= 0 && (!victim || pin.thread.length > victim.pin.thread.length)) victim = { pin, index };
    }
    if (victim) { victim.pin.thread.splice(victim.index, 1); continue; }
    const logged = book.pins.reduce<Pin | null>((most, pin) => (pin.updates.length > (most?.updates.length ?? 0) ? pin : most), null);
    if (logged) { logged.updates.shift(); continue; }
    break;
  }
  return book;
}

// ---- names ----

/** What follows @ to write into a card: the title with its spaces made "-" (no "@", no brackets). */
export function handleOf(title: string): string {
  return oneLine(title, MAX_TITLE).replace(/[@]/g, "").replace(/\s+/g, "-").slice(0, MAX_TITLE) || "card";
}
/** A handle no other card of the book has (compared without case). */
export function uniqueHandle(book: Book, title: string, except?: string): string {
  const taken = new Set(book.pins.filter((pin) => pin.id !== except).map((pin) => pin.handle.toLowerCase()));
  const base = handleOf(title);
  let handle = base;
  for (let n = 2; taken.has(handle.toLowerCase()); n++) handle = `${base.slice(0, MAX_TITLE - String(n).length - 1)}-${n}`;
  return handle;
}
export const nextId = (book: Book): string => `p-${String(book.seq + 1).padStart(4, "0")}`;

// ---- changing a card ----

export interface UpdateInput { state?: State; status?: string; source: Source; step?: Step | null }
/**
 * The one way a card's state and status line change (a bot's tag now; a worker's report in Phase 2 goes through it too, with
 * source "app"). The old status line becomes `prev` when the words change; every real change is logged for "N 則更新".
 * Returns whether anything changed (the same words again are no update).
 */
export function applyUpdate(pin: Pin, input: UpdateInput, now: number): boolean {
  const state = input.state ?? pin.state;
  const status = input.status !== undefined && input.status !== "" ? oneLine(input.status, MAX_STATUS) : pin.status;
  const step = input.step === undefined ? pin.step : input.step ?? undefined;
  const sameStep = (step?.done ?? -1) === (pin.step?.done ?? -1) && (step?.total ?? -1) === (pin.step?.total ?? -1);
  if (state === pin.state && status === pin.status && sameStep && input.source === pin.source) return false;
  if (status !== pin.status) pin.prev = pin.status || undefined;
  if (pin.prev === undefined) delete pin.prev;
  if (state === "wait" && pin.state !== "wait") pin.waitingSince = now;
  if (state !== "wait") delete pin.waitingSince;
  pin.state = state;
  pin.status = status;
  pin.source = input.source;
  if (step) pin.step = step; else delete pin.step;
  pin.updatedAt = now;
  pin.updates.push({ at: now, state, status, source: input.source });
  if (pin.updates.length > MAX_UPDATES) pin.updates.splice(0, pin.updates.length - MAX_UPDATES);
  return true;
}

export type Refusal = "full" | "bot-quota" | "empty" | "not-worth-it";
export interface NewPin { origin: "user" | "bot"; title: string; status: string; state: State; source: Source; botKey?: string; step?: Step; msgRef?: string }

/** A bot makes a card only for a run that takes at least MIN_RUN_MINUTES, or for something that waits for the user. */
export function botMayMake(state: State, minutes: number): boolean {
  return state === "wait" || (state === "run" && minutes >= MIN_RUN_MINUTES);
}

/** Adds a card; at the limit the oldest done card makes room first. A refusal says why, the book is untouched. */
export function addPin(book: Book, input: NewPin, now: number): { pin: Pin } | { refused: Refusal } {
  const title = oneLine(input.title, MAX_TITLE);
  if (!title) return { refused: "empty" };
  if (input.origin === "bot" && book.pins.filter((pin) => pin.origin === "bot" && pin.state !== "done").length >= MAX_BOT_OPEN) return { refused: "bot-quota" };
  let room = book.pins.length < MAX_PINS;
  if (!room) {
    const oldDone = book.pins.filter((pin) => pin.state === "done").sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (oldDone) { remove(book, oldDone.id, now, "seen"); room = true; }
  }
  if (!room) return { refused: "full" };
  const id = nextId(book);
  book.seq += 1;
  const pin: Pin = {
    id, ...(input.botKey ? { botKey: input.botKey } : {}), origin: input.origin, title, handle: uniqueHandle(book, title), state: input.state,
    status: oneLine(input.status, MAX_STATUS), source: input.source, ...(input.step ? { step: input.step } : {}), ...(input.state === "wait" ? { waitingSince: now } : {}),
    thread: [], updates: [], ...(input.msgRef ? { msgRef: input.msgRef.slice(0, 200) } : {}), createdAt: now, updatedAt: now,
  };
  pin.updates.push({ at: now, state: pin.state, status: pin.status, source: pin.source });
  book.pins.push(pin);
  return { pin };
}

/** Takes a card off the strip, keeping it for 釘回. */
export function remove(book: Book, id: string, now: number, by: Removed["by"]): Pin | null {
  const pin = book.pins.find((candidate) => candidate.id === id);
  if (!pin) return null;
  book.pins = book.pins.filter((candidate) => candidate !== pin);
  book.removed.push({ pin, at: now, by });
  if (book.removed.length > MAX_REMOVED) book.removed.splice(0, book.removed.length - MAX_REMOVED);
  return pin;
}

/** Puts a removed card back (釘回). Refused when the strip is full; if its handle is someone else's by now, it gets a new one. */
export function restore(book: Book, id: string, now: number): Pin | null {
  const entry = book.removed.find((candidate) => candidate.pin.id === id);
  if (!entry || book.pins.length >= MAX_PINS) return null;
  book.removed = book.removed.filter((candidate) => candidate !== entry);
  const pin = entry.pin;
  pin.handle = uniqueHandle(book, pin.title, pin.id);
  pin.updatedAt = now;
  book.pins.push(pin);
  return pin;
}

// ---- what a bot writes ----

/** "2/4" or "2 / 4" as a step; anything else is none. */
export function parseStep(value: unknown): Step | null {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(String(value ?? ""));
  return m ? stepOf(Number(m[1]), Number(m[2])) : null;
}
export function parseState(value: unknown): State | null {
  return STATES.find((state) => state === String(value ?? "").trim().toLowerCase()) ?? null;
}
/** The minutes a bot says a run takes (an integer; anything else is 0). */
export function parseMinutes(value: unknown): number {
  const text = String(value ?? "").trim();
  return /^\d{1,5}$/.test(text) ? Number(text) : 0;
}
const own = (attributes: Record<string, string>, name: string): string => (Object.hasOwn(attributes, name) ? attributes[name]! : "");
export const truthy = (value: string): boolean => /^(yes|true|1)$/i.test(value.trim());

export type CardOutcome = "created" | "updated" | "unpinned" | "unchanged" | "dropped";
/**
 * One `<pin-card …>status</pin-card>` from a bot, applied to that bot's own book. A card is found by the bot's key (`id`) or, for a
 * card the user pinned, by its p-0001 id as the header of the user's message gave it. The bot's text is cleaned here, once.
 */
export function applyCardTag(book: Book, attributes: Record<string, string>, body: string, now: number): CardOutcome {
  const key = own(attributes, "id").trim();
  if (!isKey(key) && !isId(key)) return "dropped";
  const found = book.pins.find((pin) => pin.botKey === key || pin.id === key);
  if (truthy(own(attributes, "unpin"))) {
    // a bot takes down only the cards it made itself; the user's pins stay until the user takes them down
    if (!found || found.origin !== "bot") return "dropped";
    remove(book, found.id, now, "bot");
    return "unpinned";
  }
  const state = own(attributes, "state") ? parseState(own(attributes, "state")) : null;
  if (own(attributes, "state") && !state) return "dropped";
  const stepText = own(attributes, "step");
  const step = stepText ? parseStep(stepText) : undefined;
  const status = oneLine(body, MAX_STATUS);
  if (found) {
    const changed = applyUpdate(found, { ...(state ? { state } : {}), ...(status ? { status } : {}), source: "bot", ...(step !== undefined ? { step } : {}) }, now);
    return changed ? "updated" : "unchanged";
  }
  if (!isKey(key)) return "dropped";
  const title = oneLine(own(attributes, "title"), MAX_TITLE) || oneLine(status, 24);
  if (!state || !status || !botMayMake(state, parseMinutes(own(attributes, "min")))) return "dropped";
  const made = addPin(book, { origin: "bot", title, status, state, source: "bot", botKey: key, ...(step ? { step } : {}) }, now);
  return "pin" in made ? "created" : "dropped";
}

// ---- the user's messages into a card ----

/** The first words of a message that name a card: "@handle rest" (the handle or the p-0001 id); null when it names none or says nothing after it. */
export function route(book: Book, text: string): { pin: Pin; rest: string } | null {
  const m = /^\s*@([^\s@]{1,40})(?=\s|$)[ \t]*\n?[ \t]*([\s\S]*)$/.exec(text);
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const rest = m[2]!.trim();
  if (!rest) return null;
  const pin = book.pins.find((candidate) => candidate.handle.toLowerCase() === name || candidate.id === name);
  return pin ? { pin, rest } : null;
}

/** The footer every routed message ends with: how the bot answers (the web part shows the bubble without it, so its words are fixed here). */
export const footer = (id: string): string => `（Pin 卡片：回覆請用 <pin-say id="${id}">…</pin-say>，會放進這張卡的對話串，不會顯示在聊天裡。）`;
/** What the bot gets for a message written into a card. */
export function askText(pin: Pin, text: string): string {
  return `〔Pin ${pin.id} · ${pin.title}〕\n${text}\n\n${footer(pin.id)}`;
}
const ASKED = /^〔Pin (p-\d{4,}) · ([^〕\n]*)〕\n([\s\S]*)\n\n（Pin 卡片：[^）]*）$/;
/** The header of a routed message: its card's id, title and the user's own words; null for any other text. */
export function parseAsk(text: string): { id: string; title: string; text: string } | null {
  const m = ASKED.exec(text);
  return m ? { id: m[1]!, title: m[2]!, text: m[3]! } : null;
}

/** Writes the user's words into the card's thread as a new turn (nothing sent here). */
export function addTurn(pin: Pin, rid: string, text: string, now: number, via: Via = "at"): Turn {
  const turn: Turn = { rid, q: clean(text, MAX_Q), a: null, qAt: now, postedAt: null, seenAt: null, aAt: null, via };
  pin.thread.push(turn);
  if (pin.thread.length > MAX_TURNS) {
    // the oldest answered turn goes; an open one is never dropped
    const old = pin.thread.findIndex((candidate) => candidate.a !== null);
    pin.thread.splice(old >= 0 ? old : 0, 1);
  }
  pin.updatedAt = now;
  return turn;
}
export const openTurn = (pin: Pin): Turn | undefined => {
  const last = pin.thread[pin.thread.length - 1];
  return last && last.a === null && !last.moved ? last : undefined;
};

/** A `<pin-say id>` from the bot: the open turn of that card gets the answer. False: the card or an open turn is not there. */
export function answerTurn(book: Book, id: string, body: string, now: number): boolean {
  if (!isId(id)) return false;
  const pin = book.pins.find((candidate) => candidate.id === id);
  const turn = pin ? openTurn(pin) : undefined;
  const text = clean(body, MAX_A * 2).trim().slice(0, MAX_A);
  if (!pin || !turn || !text) return false;
  turn.a = text;
  turn.aAt = now;
  pin.updatedAt = now;
  return true;
}

/**
 * A reply with no `<pin-say>`: the one card waiting for an answer (across the bot's cards) takes it when its message was in the chat
 * before this turn began. Two waiting, or none: nothing is guessed.
 */
export function answerOnlyWaiting(book: Book, reply: string, startedAt: number, now: number): string | null {
  const waiting = book.pins.filter((pin) => openTurn(pin));
  if (waiting.length !== 1) return null;
  const pin = waiting[0]!;
  const turn = openTurn(pin)!;
  if ((turn.postedAt ?? turn.qAt) > startedAt) return null;
  return answerTurn(book, pin.id, reply, now) ? pin.id : null;
}

/** The bot's turn began: every open turn whose line was already in the chat has been seen by the bot. */
export function markSeen(book: Book, now: number): boolean {
  let any = false;
  for (const pin of book.pins) {
    const turn = openTurn(pin);
    if (turn && turn.postedAt !== null && turn.seenAt === null) { turn.seenAt = now; any = true; }
  }
  return any;
}
/** The user's line showed in the chat: the open turn of that card with that header. */
export function markPosted(book: Book, id: string, now: number): boolean {
  const pin = book.pins.find((candidate) => candidate.id === id);
  const turn = pin ? openTurn(pin) : undefined;
  if (!turn || turn.postedAt !== null) return false;
  turn.postedAt = now;
  return true;
}

// ---- what the page draws ----

export interface PinView {
  id: string; title: string; handle: string; origin: "user" | "bot"; state: State; status: string; prev?: string; source: Source; step?: Step;
  waitingSince?: number; unread: boolean; thread: Turn[]; updates: Update[]; createdAt: number; updatedAt: number;
}
export interface BookView { v: 1; pins: PinView[] }
const ORDER: Record<State, number> = { wait: 0, run: 1, done: 2 };

/** The cards in the order the strip shows them: waiting, then running, then done (each oldest first so a row keeps its place). */
export function viewOf(book: Book): BookView {
  const pins = [...book.pins].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.createdAt - b.createdAt);
  return {
    v: 1,
    pins: pins.map((pin) => ({
      id: pin.id, title: pin.title, handle: pin.handle, origin: pin.origin, state: pin.state, status: pin.status, ...(pin.prev ? { prev: pin.prev } : {}), source: pin.source,
      ...(pin.step ? { step: pin.step } : {}), ...(pin.waitingSince !== undefined ? { waitingSince: pin.waitingSince } : {}),
      unread: pin.updatedAt > (pin.seenAt ?? 0), thread: pin.thread, updates: pin.updates, createdAt: pin.createdAt, updatedAt: pin.updatedAt,
    })),
  };
}

/** A pin from a message the user chose: its first line is the status, its first words the title. */
export function fromMessage(text: string): { title: string; status: string } {
  const lines = clean(text, 2_000).split("\n").map((line) => line.replace(/^[#>*\-\s]+/, "").trim()).filter(Boolean);
  const first = lines[0] ?? "";
  return { title: oneLine(first, 24) || "釘選", status: oneLine(first, MAX_STATUS) || "釘選" };
}

/** Lines a routed message has waited to show in the chat before its turn is dropped (it was stopped or never sent). */
export const UNPOSTED_MS = 120_000;
/** The same words to the same card again within this long are a double send. */
export const DUPLICATE_MS = 3_000;
/** A message that was routed but never showed in the chat (another plugin stopped it, the send failed) is not waiting for an answer. */
export function pruneUnposted(book: Book, now: number): boolean {
  let any = false;
  for (const pin of book.pins) {
    const before = pin.thread.length;
    pin.thread = pin.thread.filter((turn) => turn.a !== null || turn.postedAt !== null || now - turn.qAt < UNPOSTED_MS);
    if (pin.thread.length !== before) any = true;
  }
  return any;
}
/** Whether `text` to this card is the very turn just written (a double send). */
export function isDuplicate(pin: Pin, text: string, now: number): boolean {
  const last = pin.thread[pin.thread.length - 1];
  return !!last && last.q === clean(text, MAX_Q) && now - last.qAt < DUPLICATE_MS;
}
