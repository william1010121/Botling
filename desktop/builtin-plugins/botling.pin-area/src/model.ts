// botling.pin-area, the pure part: what a pin (a card in the strip above the chat) is, how a bot's tag or the user's action changes
// it, and how a message that starts with @handle is routed into a card's own thread. No Botling API, no clock of its own (`now` is
// passed in), no DOM: host.ts keeps the books and the web part draws the view. Design and limits: ../DESIGN.md.

export type State = "run" | "wait" | "done";
/** Who vouches for a card's status line: the bot itself, the app (a worker's own report: Phase 2) or the user (a card they pinned by hand). */
export type Source = "bot" | "app" | "user";
export type Via = "at" | "auto" | "worker";
/** What a worker said into a card: its final report, a failed/stopped run, an interim note, or a question. */
export type WorkerKind = "final" | "failed" | "note" | "question";

/**
 * One exchange in a card's thread. `postedAt`: the line showed in the chat; `seenAt`: a turn of the bot began after that (the bot saw it);
 * `a` null: not answered yet. `via`: how it got here (typed @card, or Phase 2's automatic routing); `moved`: the user took it back to
 * the chat (Phase 2's 移回聊天), kept so the thread still shows where it went.
 */
export interface Turn {
  rid: string; q: string; a: string | null; qAt: number; postedAt: number | null; seenAt: number | null; aAt: number | null; via: Via; moved?: boolean;
  /** `via` "auto": the user's own line in the chat (it is folded behind the trace while the turn is in the card). `redirected`: the user chose this card with 改到…. */
  msgId?: string; redirected?: boolean;
  /** `via` "worker": the worker's task id and what it said (`a` holds the words, `q` is empty); `msgId` is then the bot's reply in the chat to it (folded behind a trace), `say` that reply. */
  worker?: string; wkind?: WorkerKind; say?: string;
}
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
  /** Workers (task ids) and sub bots (bot ids) the bot linked to this card: what they report lands in the status line (`applyNews`). */
  from?: string[];
  createdAt: number;
  updatedAt: number;
  /** When the user last had the card open: anything newer than this is unread. */
  seenAt?: number;
  /** When it became done (the hour after which it takes itself down); older books have none: its last change then. */
  doneAt?: number;
  /** Workers the app bound to it that have not ended yet (`bind`); with none and one end seen (`endedAt`), the card waits on nobody. */
  live?: string[];
  endedAt?: number;
  /** Marked 可能已過時 when its workers all ended and it said nothing for STALE_MS: the value is its `updatedAt` then, so any later change clears the mark. */
  stale?: number;
  /** Its workers all reported and it is still running: the bot is asked (next briefing) to mark it done or say what is left. Cleared by the bot's own word or done. */
  nudge?: true;
}
/** A card taken off the strip, kept briefly so 釘回 puts it back. */
export interface Removed {
  pin: Pin; at: number; by: "user" | "seen" | "bot" | "auto";
  /** Set when the card was merged into another (`mergeCards`): the card it went into, the turns and workers that were copied there (taken out again by 釘回). */
  merged?: { into: string; rids: string[]; from: string[] };
}
/**
 * What the app only suggests for a plain line of the user's, until they tap (`classify.ts`): a new card for it, or two cards that look like one thing.
 * Nothing moves by itself for these. `text`: the line (cut short); `card`/`card2`: the cards to merge (`card` stays).
 */
export interface Suggest { id: string; kind: "new" | "merge"; text: string; at: number; card?: string; card2?: string }
/** A guess of the automatic routing the user corrected (the bot is told, so it guesses better). `from`/`to`: a card id, or "chat". */
export interface Fix { text: string; from: string; to: string; at: number }
export interface Book { seq: number; pins: Pin[]; removed: Removed[]; fixes?: Fix[]; suggest?: Suggest[] }

export const MAX_PINS = 8;
/** Cards a bot made that still are not done: a bot cannot fill the strip. */
export const MAX_BOT_OPEN = 3;
export const MAX_TURNS = 50;
export const MAX_UPDATES = 50;
export const MAX_REMOVED = 3;
/** Workers / sub bots one card may follow by a bot's tag (the oldest go over it); `MAX_LINKED` when the app binds them by their job name. */
export const MAX_FROM = 4;
export const MAX_LINKED = 12;
/** Longest worker report kept in a card's thread (the bot got all of it; a card shows this much). */
export const MAX_REPORT = 12_000;
/** A card whose workers all ended and that said nothing for this long is marked 可能已過時. */
export const STALE_MS = 20 * 60_000;
/** A card done for this long takes itself down (釘回 puts it back). */
export const DONE_CLOSE_MS = 60 * 60_000;
/** How long a card taken down by itself is still offered back on the strip. */
export const CLOSED_SHOW_MS = 24 * 3_600_000;
export const MAX_FIXES = 3;
/** Suggestions waiting for a tap (the oldest goes over it), and how long one stays. */
export const MAX_SUGGEST = 2;
export const SUGGEST_MS = 30 * 60_000;
const SUGGEST_TEXT = 80;
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
/** A worker's task id or a bot's id, as the app gives them. */
const FROM = /^[A-Za-z0-9_.:-]{1,100}$/;
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
export const isFrom = (value: unknown): value is string => typeof value === "string" && FROM.test(value);
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
  const a = typeof t.a === "string" ? t.a.slice(0, t.via === "worker" ? MAX_REPORT : MAX_A) : null;
  const wkind = (["final", "failed", "note", "question"] as const).find((kind) => kind === t.wkind);
  const time = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    rid: t.rid, q: t.q.slice(0, MAX_Q), a, qAt: num(t.qAt), postedAt: time(t.postedAt), seenAt: time(t.seenAt), aAt: a === null ? null : num(t.aAt),
    via: t.via === "auto" ? "auto" : t.via === "worker" && isFrom(t.worker) && wkind ? "worker" : "at", ...(t.moved === true ? { moved: true } : {}),
    ...(typeof t.msgId === "string" && t.msgId && t.msgId.length <= 200 ? { msgId: t.msgId } : {}), ...(t.redirected === true ? { redirected: true } : {}),
    ...(t.via === "worker" && isFrom(t.worker) && wkind ? { worker: t.worker, wkind, ...(typeof t.say === "string" && t.say ? { say: t.say.slice(0, MAX_A) } : {}) } : {}),
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
  const from = (Array.isArray(p.from) ? p.from : []).filter(isFrom).slice(0, MAX_LINKED);
  const seenSeen = typeof p.seenAt === "number" && Number.isFinite(p.seenAt) ? { seenAt: p.seenAt } : {};
  const at = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
  const live = (Array.isArray(p.live) ? p.live : []).filter(isFrom).slice(0, MAX_LINKED);
  return {
    id: p.id, ...(isKey(p.botKey) ? { botKey: p.botKey } : {}), origin: p.origin, title, handle, state, status: oneLine(p.status, MAX_STATUS), ...(typeof p.prev === "string" && p.prev ? { prev: oneLine(p.prev, MAX_STATUS) } : {}),
    source, ...(step ? { step } : {}), ...(state === "wait" ? { waitingSince: num(p.waitingSince) } : {}),
    thread: (Array.isArray(p.thread) ? p.thread.slice(-MAX_TURNS) : []).map(readTurn).filter((x): x is Turn => !!x),
    updates: (Array.isArray(p.updates) ? p.updates.slice(-MAX_UPDATES) : []).map(readUpdate).filter((x): x is Update => !!x),
    ...(typeof p.msgRef === "string" && p.msgRef ? { msgRef: p.msgRef.slice(0, 200) } : {}), createdAt: num(p.createdAt), updatedAt: num(p.updatedAt), ...seenSeen,
    ...(from.length ? { from } : {}),
    ...(state === "done" && at(p.doneAt) ? { doneAt: at(p.doneAt)! } : {}), ...(live.length ? { live } : {}), ...(at(p.endedAt) ? { endedAt: at(p.endedAt)! } : {}),
    ...(state !== "done" && at(p.stale) ? { stale: at(p.stale)! } : {}), ...(state === "run" && p.nudge === true ? { nudge: true as const } : {}),
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
    const merged = entry.merged && typeof entry.merged === "object" ? entry.merged as Record<string, unknown> : null;
    const into = merged && isId(merged.into) ? merged.into : "";
    book.removed.push({
      pin, at: num(entry.at), by: entry.by === "seen" || entry.by === "bot" || entry.by === "auto" ? entry.by : "user",
      ...(merged && into ? { merged: { into, rids: (Array.isArray(merged.rids) ? merged.rids : []).filter(isRid).slice(0, MAX_TURNS), from: (Array.isArray(merged.from) ? merged.from : []).filter(isFrom).slice(0, MAX_LINKED) } } : {}),
    });
  }
  const suggest = (Array.isArray(r.suggest) ? r.suggest : []).flatMap((item): Suggest[] => {
    const g = item && typeof item === "object" ? item as Record<string, unknown> : null;
    const text = g ? oneLine(g.text, SUGGEST_TEXT) : "";
    if (!g || !text || !isRid(g.id) || (g.kind !== "new" && g.kind !== "merge")) return [];
    if (g.kind === "merge" && !(isId(g.card) && isId(g.card2) && g.card !== g.card2)) return [];
    return [{ id: g.id, kind: g.kind, text, at: num(g.at), ...(g.kind === "merge" ? { card: g.card as string, card2: g.card2 as string } : {}) }];
  }).slice(-MAX_SUGGEST);
  if (suggest.length) book.suggest = suggest;
  const fixes = (Array.isArray(r.fixes) ? r.fixes : []).flatMap((item): Fix[] => {
    const f = item && typeof item === "object" ? item as Record<string, unknown> : null;
    const text = f ? oneLine(f.text, 30) : "";
    return f && text && typeof f.from === "string" && typeof f.to === "string" && (f.from === "chat" || isId(f.from)) && (f.to === "chat" || isId(f.to)) ? [{ text, from: f.from, to: f.to, at: num(f.at) }] : [];
  }).slice(-MAX_FIXES);
  if (fixes.length) book.fixes = fixes;
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
  if (state === "done" && pin.state !== "done") pin.doneAt = now;
  if (state !== "done") delete pin.doneAt;
  // the bot's own word on a card (or its being done) answers the nudge
  if (input.source === "bot" || state !== "run") delete pin.nudge;
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
    thread: [], updates: [], ...(input.msgRef ? { msgRef: input.msgRef.slice(0, 200) } : {}), createdAt: now, updatedAt: now, ...(input.state === "done" ? { doneAt: now } : {}),
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
  // a card that was merged away takes back what it gave: the turns and workers copied into the other card are taken out of it again
  const into = entry.merged ? book.pins.find((candidate) => candidate.id === entry.merged!.into) : undefined;
  if (entry.merged && into) {
    into.thread = into.thread.filter((turn) => !entry.merged!.rids.includes(turn.rid));
    if (into.from) into.from = into.from.filter((id) => !entry.merged!.from.includes(id));
    if (into.live) into.live = into.live.filter((id) => !entry.merged!.from.includes(id));
    into.updatedAt = now;
  }
  pin.handle = uniqueHandle(book, pin.title, pin.id);
  pin.updatedAt = now;
  // put back, a done card has its hour again (it would go away at once otherwise)
  if (pin.state === "done") pin.doneAt = now;
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
  const links = parseFrom(own(attributes, "worker"));
  if (found) {
    // a tag that only names a worker says nothing about the card: the line stays whoever's it was (an app report, say)
    const changed = state || status || step !== undefined ? applyUpdate(found, { ...(state ? { state } : {}), ...(status ? { status } : {}), source: "bot", ...(step !== undefined ? { step } : {}) }, now) : false;
    const linked = linkFrom(found, links);
    if (linked) found.updatedAt = now;
    return changed || linked ? "updated" : "unchanged";
  }
  if (!isKey(key)) return "dropped";
  const title = oneLine(own(attributes, "title"), MAX_TITLE) || oneLine(status, 24);
  if (!state || !status || !botMayMake(state, parseMinutes(own(attributes, "min")))) return "dropped";
  const made = addPin(book, { origin: "bot", title, status, state, source: "bot", botKey: key, ...(step ? { step } : {}) }, now);
  if ("pin" in made) linkFrom(made.pin, links);
  return "pin" in made ? "created" : "dropped";
}

// ---- worker and sub-bot news into a card ----

/** The ids a bot named in `worker="…"` (spaces or commas between), each checked; at most MAX_FROM. */
export function parseFrom(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter(isFrom))].slice(0, MAX_FROM);
}
/** Adds ids to the card's links (the oldest go when over MAX_FROM). True when something was added. */
export function linkFrom(pin: Pin, ids: string[], cap = MAX_FROM): boolean {
  const fresh = ids.filter((id) => !(pin.from ?? []).includes(id));
  if (!fresh.length) return false;
  pin.from = [...(pin.from ?? []), ...fresh].slice(-cap);
  return true;
}

// ---- a worker bound to a card by the job name its bot gave (app_handoff's `group`), and what it says into the card ----

/** A name as compared for a match: no case, no spaces or punctuation. */
const fold = (value: string): string => value.toLowerCase().replace(/[\s\-_·:：,，.。、/\\|()（）「」『』"'`]+/g, "");
/**
 * The open card a worker's job name points at: its p-0001 id, else its title, key or handle (exactly, ignoring case and punctuation),
 * else a title or key that contains the name or the name contains it (3 characters or more). The best kind of match wins; two cards
 * tied on it, or none, give null (the worker then stays in the chat). A done card is never bound.
 */
export function cardForGroup(book: Book, group: string): Pin | null {
  const raw = oneLine(group, 80);
  const wanted = fold(raw);
  if (!wanted) return null;
  const rank = (pin: Pin): number => {
    if (raw.toLowerCase() === pin.id) return 3;
    const names = [pin.title, pin.botKey ?? "", pin.handle].map(fold).filter(Boolean);
    if (names.includes(wanted)) return 2;
    return names.some((name) => Math.min(name.length, wanted.length) >= 3 && (name.includes(wanted) || wanted.includes(name))) ? 1 : 0;
  };
  const ranked = book.pins.filter((pin) => pin.state !== "done").map((pin) => ({ pin, rank: rank(pin) })).filter((item) => item.rank > 0);
  const best = Math.max(0, ...ranked.map((item) => item.rank));
  const top = ranked.filter((item) => item.rank === best);
  return top.length === 1 ? top[0]!.pin : null;
}
/** A worker the app bound to a card is now at work: the card is not waiting on nobody. */
export function workerLive(pin: Pin, workerId: string): void {
  if (!isFrom(workerId) || (pin.live ?? []).includes(workerId)) return;
  pin.live = [...(pin.live ?? []), workerId].slice(-MAX_LINKED);
}
/**
 * A worker this card follows ended a run (a note is not an end). When no bound worker is left at work, the card is waiting on nobody: a running card whose
 * last worker reported completed is nudged (the bot is asked to mark it done or say what is left, `briefing`). Does not touch `updatedAt`.
 */
export function workerEnded(pin: Pin, workerId: string, kind: NewsKind, now: number): boolean {
  let changed = false;
  if (pin.live?.includes(workerId)) { pin.live = pin.live.filter((id) => id !== workerId); if (!pin.live.length) delete pin.live; changed = true; }
  if (pin.endedAt === undefined) { pin.endedAt = now; changed = true; }
  if (kind === "completed" && pin.state === "run" && !pin.live?.length && !pin.nudge) { pin.nudge = true; changed = true; }
  return changed;
}
/** Whether a card shows 可能已過時 now: marked, and not changed since. */
export const isStale = (pin: Pin): boolean => pin.state !== "done" && pin.stale !== undefined && pin.updatedAt <= pin.stale;

/**
 * What time does to the cards: a card done for DONE_CLOSE_MS takes itself down (by "auto", 釘回 puts it back; a card the user pinned too);
 * a card that is not done, has seen a worker end, has none at work and has said nothing for STALE_MS is marked stale (so the strip says 可能已過時
 * and the next briefing tells the bot). Returns the ids taken down, and whether anything changed (the book must be saved then).
 */
export function sweep(book: Book, now: number): { changed: boolean; closed: string[] } {
  let changed = false;
  const closed: string[] = [];
  for (const pin of [...book.pins]) {
    if (pin.state === "done") {
      if (now - (pin.doneAt ?? pin.updatedAt) >= DONE_CLOSE_MS && remove(book, pin.id, now, "auto")) { closed.push(pin.id); changed = true; }
    } else if (pin.endedAt !== undefined && !pin.live?.length && now - pin.updatedAt >= STALE_MS && !isStale(pin)) {
      pin.stale = pin.updatedAt;
      changed = true;
    }
  }
  return { changed, closed };
}

/** The card that follows `workerId`, if any. */
export const cardOfWorker = (book: Book, workerId: string): Pin | null => book.pins.find((pin) => pin.from?.includes(workerId)) ?? null;

/**
 * What a worker said goes into the card's thread as a turn of its own (`via: "worker"`, no words of the user's), full length up to
 * MAX_REPORT. The same words of the same worker twice are one. Null: nothing was added.
 */
export function addWorkerTurn(pin: Pin, workerId: string, kind: WorkerKind, text: string, now: number): Turn | null {
  const words = clean(text, MAX_REPORT * 2).trim().slice(0, MAX_REPORT);
  if (!words || !isFrom(workerId)) return null;
  if (pin.thread.some((turn) => turn.via === "worker" && turn.worker === workerId && turn.wkind === kind && turn.a === words)) return null;
  const turn = addTurn(pin, `w${now.toString(36)}-${pin.thread.length}-${workerId.slice(0, 12).replace(/[^A-Za-z0-9_-]/g, "_")}`, "", now, "worker");
  turn.a = words;
  turn.aAt = now;
  turn.worker = workerId;
  turn.wkind = kind;
  return turn;
}
/** Every id a book's cards follow, by card: for the host's index. */
export function linksOf(book: Book): string[] {
  return book.pins.flatMap((pin) => pin.from ?? []);
}

export type NewsKind = "completed" | "failed" | "stopped" | "interrupted" | "reply";
const NEWS_WORDS: Record<NewsKind, { worker: string; bot: string }> = {
  completed: { worker: "worker 回報", bot: "sub bot 回覆" },
  failed: { worker: "worker 失敗", bot: "sub bot 失敗" },
  stopped: { worker: "worker 已停止", bot: "sub bot 已停止" },
  interrupted: { worker: "worker 中斷", bot: "sub bot 中斷" },
  reply: { worker: "worker 回報", bot: "sub bot 回覆" },
};
/** The first line with words in it, as one clean line. */
export function firstLine(text: string, max: number): string {
  const line = clean(text, 4_000).split("\n").map((l) => l.replace(/^[#>*\-\s`]+/, "").trim()).find((l) => l.length > 0) ?? "";
  return oneLine(line, max);
}
/**
 * What a worker's or a sub bot's report does to a card that follows it: the status line is rewritten in place (「原本」 keeps the one
 * before), source "app", and the change lands in "N 則更新". A done card takes nothing. A waiting card (it waits for the *user*) keeps its
 * words and state, and the news only goes into its log. A run that failed or was stopped turns a running card into a waiting one: the user may
 * have to decide. A report that completed is only the worker's account, so the card does not become "done" by it.
 */
export function applyNews(pin: Pin, news: { kind: NewsKind; from: "worker" | "bot"; text: string }, now: number): boolean {
  if (pin.state === "done") return false;
  const head = NEWS_WORDS[news.kind][news.from];
  const line = firstLine(news.text, 80);
  const status = oneLine(line && news.kind !== "stopped" ? `${head}：${line}` : head, MAX_STATUS);
  if (pin.state === "wait") {
    const last = pin.updates[pin.updates.length - 1];
    if (last && last.status === status && last.source === "app") return false;
    pin.updates.push({ at: now, state: pin.state, status, source: "app" });
    if (pin.updates.length > MAX_UPDATES) pin.updates.splice(0, pin.updates.length - MAX_UPDATES);
    pin.updatedAt = now;
    return true;
  }
  const failed = news.kind === "failed" || news.kind === "stopped" || news.kind === "interrupted";
  return applyUpdate(pin, { status, source: "app", ...(failed ? { state: "wait" as const } : {}) }, now);
}

/** What a worker's end is, as a thread entry. */
export const workerKindOf = (kind: NewsKind): WorkerKind => (kind === "completed" || kind === "reply" ? "final" : "failed");
/** A line in the card's 過程 log only (no change of state or words): a worker started, a note came. */
export function logLine(pin: Pin, status: string, now: number): boolean {
  const line = oneLine(status, MAX_STATUS);
  const last = pin.updates[pin.updates.length - 1];
  if (!line || (last && last.status === line && last.source === "app")) return false;
  pin.updates.push({ at: now, state: pin.state, status: line, source: "app" });
  if (pin.updates.length > MAX_UPDATES) pin.updates.splice(0, pin.updates.length - MAX_UPDATES);
  pin.updatedAt = now;
  return true;
}
/**
 * A worker at work sent a note (app_notify_owner) to a card that follows it: the words go into the thread, a line into the log. A question
 * makes a running card wait for the user (the user may have to answer). A done card keeps its state. True when anything changed.
 */
export function applyWorkerNote(pin: Pin, workerId: string, kind: "report" | "question", message: string, now: number): boolean {
  const turn = addWorkerTurn(pin, workerId, kind === "question" ? "question" : "note", message, now);
  const line = firstLine(message, 80);
  const head = kind === "question" ? "worker 問" : "worker 進度";
  const status = oneLine(line ? `${head}：${line}` : head, MAX_STATUS);
  if (kind === "question" && pin.state === "run") return applyUpdate(pin, { state: "wait", status, source: "app" }, now) || !!turn;
  return logLine(pin, status, now) || !!turn;
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
const waits = (turn: Turn): boolean => turn.a === null && !turn.moved;
/**
 * The turn the card's next answer goes to: the oldest unanswered one whose line is in the chat (answers come in the order the
 * questions were asked), else the oldest unanswered one. Two questions written into one card before an answer each get theirs.
 */
export const openTurn = (pin: Pin): Turn | undefined =>
  pin.thread.find((turn) => waits(turn) && turn.postedAt !== null) ?? pin.thread.find(waits);

/**
 * A `<pin-say id>` from the bot: the open turn of that card gets the answer. With no open turn (a second answer, or one the bot
 * offers by itself) it is a turn of its own, never dropped: the core has already taken it out of the chat. False: no such card.
 */
export function answerTurn(book: Book, id: string, body: string, now: number): boolean {
  if (!isId(id)) return false;
  const pin = book.pins.find((candidate) => candidate.id === id);
  const text = clean(body, MAX_A * 2).trim().slice(0, MAX_A);
  if (!pin || !text) return false;
  const turn = openTurn(pin) ?? addTurn(pin, `a${now.toString(36)}-${pin.thread.length}`, "", now);
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
    for (const turn of pin.thread) {
      if (waits(turn) && turn.postedAt !== null && turn.seenAt === null) { turn.seenAt = now; any = true; }
    }
  }
  return any;
}
/**
 * The user's line showed in the chat: the oldest open turn of that card with that header whose line had not shown yet. `msgId` (the line's id in the
 * chat) is kept for an automatic turn: that line folds behind the trace (`tracesOf`), as the line the bot moved did.
 */
export function markPosted(book: Book, id: string, now: number, msgId?: string): boolean {
  const pin = book.pins.find((candidate) => candidate.id === id);
  const turn = pin ? pin.thread.find((candidate) => waits(candidate) && candidate.postedAt === null) : undefined;
  if (!turn || turn.postedAt !== null) return false;
  turn.postedAt = now;
  if (turn.via === "auto" && msgId && msgId.length <= 200 && !lineUsed(book, msgId)) turn.msgId = msgId;
  return true;
}

// ---- automatic routing: a plain message the bot decides belongs to a card ----

/** The note appended to a plain message of a chat that has cards: the cards as they stand, so the bot can route and update them. */
export const BRIEF = "〔Pin 區現況〕";
const STATE_WORD: Record<State, string> = { wait: "等你", run: "進行中", done: "完成" };
const FIX_WORD = (book: Book, id: string): string => (id === "chat" ? "聊天" : `${id}「${book.pins.find((p) => p.id === id)?.title ?? book.removed.find((r) => r.pin.id === id)?.pin.title ?? "?"}」`);
/** The briefing for a bot's next plain message: one line per card (id, title, state, status), the last guesses the user corrected, and how to answer. "" with no cards. */
export function briefing(book: Book, now: number): string {
  if (!book.pins.length) return "";
  const lines = viewOf(book).pins.map((pin) => `${pin.id}「${oneLine(pin.title, MAX_TITLE)}」${STATE_WORD[pin.state]} · ${oneLine(pin.status, 60)}${pin.origin === "user" ? " · 使用者釘的" : ""}${pin.stale ? ` · 可能已過時（它的 worker 都結束了，${Math.max(1, Math.floor((now - pin.updatedAt) / 60_000))} 分鐘沒更新）` : ""}${pin.nudge ? " · worker 都回報完了但卡片還在進行中：做完請標 state=\"done\"，沒做完請寫還差什麼" : ""}`);
  const fixes = (book.fixes ?? []).filter((fix) => now - fix.at < 86_400_000);
  const corrected = fixes.map((fix) => `「${fix.text}」不是 ${FIX_WORD(book, fix.from)}，是 ${FIX_WORD(book, fix.to)}`);
  // the note goes out inside the user's message, which the core reads for @Name call-ins: a title like "@DAFAWU 看一下" must not call that bot in
  return `${BRIEF}\n${lines.join("\n")}${corrected.length ? `\n最近被使用者更正：${corrected.join("；")}` : ""}`.replace(/@/g, "＠")
    + `\n（以最後一則現況為準。）`;
}
/** A plain message with the briefing after it; the user's own words cannot fake the marker. */
export function withBriefing(text: string, brief: string): string {
  return `${text.split(BRIEF).join("〔 Pin 區現況 〕")}\n\n${brief}`;
}
/** The user's own words of a message that carries a briefing (the whole text when it has none). */
export function stripBriefing(text: string): string {
  const at = text.lastIndexOf(`\n\n${BRIEF}`);
  return at >= 0 ? text.slice(0, at) : text;
}
export const hasBriefing = (text: string): boolean => text.includes(`\n\n${BRIEF}`);
/** Messages that are not routed or briefed: a slash command or another plugin's 〔header〕 would break with words after it. */
export function briefable(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= MAX_ROUTED && !t.startsWith("/") && !t.startsWith("〔");
}

/** Where a turn is, anywhere in the book: the card (live or taken down) and the turn. */
export function findTurn(book: Book, rid: string): { pin: Pin; turn: Turn; removed: boolean } | null {
  for (const pin of book.pins) { const turn = pin.thread.find((t) => t.rid === rid); if (turn) return { pin, turn, removed: false }; }
  for (const entry of book.removed) { const turn = entry.pin.thread.find((t) => t.rid === rid); if (turn) return { pin: entry.pin, turn, removed: true }; }
  return null;
}
const lineUsed = (book: Book, msgId: string): boolean => [...book.pins, ...book.removed.map((entry) => entry.pin)].some((pin) => pin.thread.some((turn) => turn.msgId === msgId));

/**
 * The bot's `<pin-say id move="yes">answer</pin-say>`: the user's plain line (`line`, the one this turn answers) and the bot's answer go into the card
 * as one answered turn, `via: "auto"`. Null (nothing moves, the answer is only a chat reply): no such card, no words, or that line is already in a card.
 */
export function takeAuto(book: Book, id: string, line: { id: string; text: string; at: number }, answer: string, rid: string, now: number): Turn | null {
  const pin = isId(id) ? book.pins.find((candidate) => candidate.id === id) : undefined;
  const text = clean(answer, MAX_A * 2).trim().slice(0, MAX_A);
  const words = clean(line.text, MAX_ROUTED).trim();
  if (!pin || !text || !words || !line.id || lineUsed(book, line.id)) return null;
  const turn = addTurn(pin, rid, words, line.at, "auto");
  turn.q = clean(words, MAX_Q);
  turn.a = text;
  turn.aAt = now;
  turn.postedAt = line.at;
  turn.seenAt = now;
  turn.msgId = line.id;
  pin.updatedAt = now;
  return turn;
}
/** A `move` answer with no line left to move: its own turn in that card (no question), as `answerTurn` keeps an answer with nothing waiting. */
export function keepAnswer(book: Book, id: string, answer: string, now: number): boolean {
  const pin = isId(id) ? book.pins.find((candidate) => candidate.id === id) : undefined;
  const text = clean(answer, MAX_A * 2).trim().slice(0, MAX_A);
  if (!pin || !text) return false;
  const turn = addTurn(pin, `a${now.toString(36)}-${pin.thread.length}`, "", now);
  turn.a = text;
  turn.aAt = now;
  return true;
}
function addFix(book: Book, text: string, from: string, to: string, now: number): void {
  const line = oneLine(text, 30);
  if (!line) return;
  book.fixes = [...(book.fixes ?? []), { text: line, from, to, at: now }].slice(-MAX_FIXES);
}
/** 移回聊天: the turn stays in the card's data (so the chat can show its answer) but leaves its thread. False: not an automatic turn of a live card, or already back. */
export function moveBack(book: Book, rid: string, now: number): boolean {
  const hit = findTurn(book, rid);
  // a worker's report the bot's reply was folded for is taken back too (no guess of the bot's to correct: nothing is noted for it)
  if (!hit || hit.removed || (hit.turn.via !== "auto" && !(hit.turn.via === "worker" && hit.turn.msgId)) || hit.turn.moved) return false;
  hit.turn.moved = true;
  hit.pin.updatedAt = now;
  if (hit.turn.via === "auto") addFix(book, hit.turn.q, hit.pin.id, "chat", now);
  return true;
}
/**
 * The bot's reply in the chat to a worker's report (or note) turn: its message is folded behind a one-line trace (the full words are in the card), `say` is
 * what it said. It goes with the newest report of one of `workers` not yet filed with a reply; false when there is none.
 */
export function attachReply(book: Book, workers: string[], msgId: string, say: string, now: number): boolean {
  if (!msgId || msgId.length > 200 || lineUsed(book, msgId)) return false;
  let found: Turn | null = null;
  for (const pin of book.pins) for (const turn of pin.thread) {
    if (turn.via === "worker" && !turn.msgId && !turn.moved && turn.worker && workers.includes(turn.worker) && (!found || turn.aAt! >= found.aAt!)) found = turn;
  }
  if (!found) return false;
  found.msgId = msgId;
  const line = clean(say, MAX_A).trim();
  if (line) found.say = line;
  const pin = book.pins.find((candidate) => candidate.thread.includes(found!));
  if (pin) pin.updatedAt = now;
  return true;
}
/** 改到…: the turn, with its answer, goes to another live card. False: no such turn or card, the same card, or the turn is back in the chat. */
export function moveTo(book: Book, rid: string, to: string, now: number): boolean {
  const hit = findTurn(book, rid);
  const target = isId(to) ? book.pins.find((candidate) => candidate.id === to) : undefined;
  if (!hit || hit.removed || hit.turn.via !== "auto" || hit.turn.moved || !target || target === hit.pin) return false;
  hit.pin.thread = hit.pin.thread.filter((turn) => turn !== hit.turn);
  hit.turn.redirected = true;
  target.thread.push(hit.turn);
  target.thread.sort((a, b) => a.qAt - b.qAt);
  if (target.thread.length > MAX_TURNS) {
    const old = target.thread.findIndex((turn) => turn.a !== null && turn !== hit.turn);
    target.thread.splice(old >= 0 ? old : 0, 1);
  }
  hit.pin.updatedAt = now;
  target.updatedAt = now;
  addFix(book, hit.turn.q, hit.pin.id, target.id, now);
  return true;
}

/** What the chat draws for the lines the bot moved (`chat.decorate`): a one-line trace in place of the user's line, or, once moved back, the answer under it. */
export interface TraceData { kind: "moved" | "back"; rid: string; pin: string; title: string; q: string; a?: string; by: "bot" | "user"; /** The line is the bot's reply to a worker's report that went into the card (q: the report's first line). */ worker?: true }
export const MAX_TRACES = 120;
export function tracesOf(book: Book): { key: string; fold?: string[]; after?: string; data: TraceData }[] {
  const all: { pin: Pin; turn: Turn; live: boolean }[] = [];
  for (const pin of book.pins) for (const turn of pin.thread) if ((turn.via === "auto" || turn.via === "worker") && turn.msgId) all.push({ pin, turn, live: true });
  // a card taken down gives its lines back to the chat (its answers show there); 釘回 folds them again
  // (a card merged into another has its turns there already)
  for (const entry of book.removed) if (!entry.merged) for (const turn of entry.pin.thread) if ((turn.via === "auto" || turn.via === "worker") && turn.msgId) all.push({ pin: entry.pin, turn, live: false });
  return all.sort((a, b) => b.turn.qAt - a.turn.qAt).slice(0, MAX_TRACES).map(({ pin, turn, live }) => {
    const back = turn.moved === true || !live;
    const worker = turn.via === "worker";
    const shown = worker ? turn.say ?? turn.a : turn.a;
    const data: TraceData = {
      kind: back ? "back" : "moved", rid: turn.rid, pin: pin.id, title: pin.title, q: worker ? firstLine(turn.a ?? "", 60) : oneLine(turn.q, 60), by: turn.redirected ? "user" : "bot",
      ...(back && shown ? { a: clean(shown, 600) } : {}), ...(worker ? { worker: true as const } : {}),
    };
    return back ? { key: `mv-${turn.rid}`, after: turn.msgId!, data } : { key: `mv-${turn.rid}`, fold: [turn.msgId!], data };
  });
}

// ---- what the app only suggests (a new card, a merge): nothing happens until the user taps ----

/** The suggestions still worth showing: not older than SUGGEST_MS, and (a merge) both cards still on the strip. */
export const liveSuggest = (book: Book, now: number): Suggest[] =>
  (book.suggest ?? []).filter((item) => now - item.at < SUGGEST_MS
    && (item.kind === "new" || (book.pins.some((pin) => pin.id === item.card) && book.pins.some((pin) => pin.id === item.card2))));
const suggestView = (book: Book, now: number): SuggestView[] =>
  liveSuggest(book, now).map((item) => ({
    id: item.id, kind: item.kind, text: item.text,
    ...(item.kind === "merge" ? { title: book.pins.find((pin) => pin.id === item.card)?.title ?? "", title2: book.pins.find((pin) => pin.id === item.card2)?.title ?? "" } : {}),
  }));
/** Keeps a suggestion for the user to tap. False: the same one is already shown (so a second line about it does not stack another). */
export function addSuggest(book: Book, input: { kind: "new" | "merge"; text: string; card?: string; card2?: string }, rid: string, now: number): boolean {
  const text = oneLine(input.text, SUGGEST_TEXT);
  if (!text || !isRid(rid)) return false;
  if (input.kind === "merge" && !(isId(input.card) && isId(input.card2) && input.card !== input.card2)) return false;
  const kept = liveSuggest(book, now);
  const same = (item: Suggest) => item.kind === input.kind && (input.kind === "new" ? item.text === text : [item.card, item.card2].sort().join() === [input.card, input.card2].sort().join());
  if (kept.some(same)) { book.suggest = kept; return false; }
  book.suggest = [...kept, { id: rid, kind: input.kind, text, at: now, ...(input.kind === "merge" ? { card: input.card!, card2: input.card2! } : {}) }].slice(-MAX_SUGGEST);
  return true;
}
/** Takes one suggestion out of the book (tapped, or turned down); null when it is not (or no longer) there. */
export function takeSuggest(book: Book, id: string, now: number): Suggest | null {
  const item = liveSuggest(book, now).find((candidate) => candidate.id === id);
  if (!item) return null;
  book.suggest = (book.suggest ?? []).filter((candidate) => candidate.id !== id);
  if (!book.suggest.length) delete book.suggest;
  return item;
}
/** Card `dropId` goes into card `keepId`: its thread and workers are copied there, and it is taken down with a note of what to take back (釘回 undoes it). */
export function mergeCards(book: Book, keepId: string, dropId: string, now: number): Pin | null {
  const keep = book.pins.find((pin) => pin.id === keepId);
  const drop = book.pins.find((pin) => pin.id === dropId);
  if (!keep || !drop || keep === drop) return null;
  const have = new Set(keep.thread.map((turn) => turn.rid));
  const copies = drop.thread.filter((turn) => !have.has(turn.rid)).map((turn): Turn => ({ ...turn }));
  keep.thread = [...keep.thread, ...copies].sort((a, b) => a.qAt - b.qAt);
  while (keep.thread.length > MAX_TURNS) {
    const old = keep.thread.findIndex((turn) => turn.a !== null);
    keep.thread.splice(old >= 0 ? old : 0, 1);
  }
  const kept = new Set(keep.thread.map((turn) => turn.rid));
  const rids = copies.map((turn) => turn.rid).filter((rid) => kept.has(rid));
  const before = new Set(keep.from ?? []);
  linkFrom(keep, drop.from ?? [], MAX_LINKED);
  const from = (keep.from ?? []).filter((id) => !before.has(id));
  for (const id of drop.live ?? []) if (!keep.live?.includes(id)) keep.live = [...(keep.live ?? []), id];
  logLine(keep, `合併了「${oneLine(drop.title, MAX_TITLE)}」`, now);
  keep.updatedAt = now;
  remove(book, dropId, now, "user");
  const entry = book.removed.find((candidate) => candidate.pin === drop);
  if (entry) entry.merged = { into: keep.id, rids, from };
  return keep;
}
/** Tapping 「建立卡片」: a card of the user's for that line. Refused (nothing changes) when the strip is full or the line has no words. */
export function cardFromSuggestion(book: Book, item: Suggest, now: number): { pin: Pin } | { refused: Refusal } {
  const { title, status } = fromMessage(item.text);
  return addPin(book, { origin: "user", title, status, state: "run", source: "user" }, now);
}

// ---- what the page draws ----

export interface PinView {
  id: string; title: string; handle: string; origin: "user" | "bot"; state: State; status: string; prev?: string; source: Source; step?: Step;
  waitingSince?: number; unread: boolean; thread: Turn[]; updates: Update[]; createdAt: number; updatedAt: number;
  /** 可能已過時 (`isStale`), and the bot being asked to close the card (`nudge`). */
  stale?: true; nudge?: true;
}
/** `into`: the title of the card it was merged into (a merge; else the app put it away because it was done). */
export interface ClosedView { id: string; title: string; at: number; into?: string }
/** A suggestion as the strip draws it: for a merge the titles of the two cards (`card` stays). */
export interface SuggestView { id: string; kind: "new" | "merge"; text: string; title?: string; title2?: string }
/** `closed`: cards the app took down by itself lately (the strip offers 釘回). */
export interface BookView { v: 1; pins: PinView[]; closed?: ClosedView[]; suggest?: SuggestView[] }
const ORDER: Record<State, number> = { wait: 0, run: 1, done: 2 };

/** The cards the app took down by itself in the last day (newest last): the strip offers them back. */
export const closedOf = (book: Book, now: number): ClosedView[] =>
  book.removed.filter((entry) => (entry.by === "auto" || entry.merged) && now - entry.at < CLOSED_SHOW_MS).map((entry) => {
    const into = entry.merged ? book.pins.find((pin) => pin.id === entry.merged!.into)?.title : undefined;
    return { id: entry.pin.id, title: entry.pin.title, at: entry.at, ...(into ? { into } : {}) };
  });

/** The cards in the order the strip shows them: waiting, then running, then done (each oldest first so a row keeps its place). */
export function viewOf(book: Book, now?: number): BookView {
  const pins = [...book.pins].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.createdAt - b.createdAt);
  return {
    v: 1,
    pins: pins.map((pin) => ({
      id: pin.id, title: pin.title, handle: pin.handle, origin: pin.origin, state: pin.state, status: pin.status, ...(pin.prev ? { prev: pin.prev } : {}), source: pin.source,
      ...(pin.step ? { step: pin.step } : {}), ...(pin.waitingSince !== undefined ? { waitingSince: pin.waitingSince } : {}),
      unread: pin.updatedAt > (pin.seenAt ?? 0), thread: pin.thread.filter((turn) => !turn.moved), updates: pin.updates, createdAt: pin.createdAt, updatedAt: pin.updatedAt,
      ...(isStale(pin) ? { stale: true as const } : {}), ...(pin.nudge ? { nudge: true as const } : {}),
    })),
    ...(now !== undefined && closedOf(book, now).length ? { closed: closedOf(book, now) } : {}),
    ...(now !== undefined && suggestView(book, now).length ? { suggest: suggestView(book, now) } : {}),
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
