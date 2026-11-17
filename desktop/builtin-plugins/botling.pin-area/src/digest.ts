// botling.pin-area, the 「你不在時」 digest: the pure part. When the user comes back after being away, one block says what changed in this
// chat's cards meanwhile and what other bots wait on the user for. No Botling API, no clock of its own (`now` is passed in), no DOM:
// pins.ts keeps the presence and fetches the other bots' lines, ui.ts draws the view. Rule and limits: DESIGN.md "Phase 3".
import { oneLine, type Book, type BookView, type Pin, type Source, type State } from "./model";

/** No sign of the user (a message in any chat, or the chat page being used) for this long is "away". */
export const AWAY_MS = 30 * 60_000;
/** Other bots listed in the digest (one line each); the rest are counted. */
export const MAX_OTHER_BOTS = 6;
export const MAX_OTHER_TEXT = 90;
const MAX_NAME = 30;

/** The time the user was away: `from` their last sign of presence, `to` the moment they came back. `collapsed`: 看完了 was pressed (the one-line chip shows). */
export interface Away { from: number; to: number; collapsed: boolean }
/** `lastPresent`: the last sign of the user (0: none yet). `away`: the digest now open, if any. */
export interface Presence { lastPresent: number; away: Away | null }

const time = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

/** What storage holds, trimmed to a presence (anything else is none yet). */
export function readPresence(raw: unknown): Presence {
  const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const a = r.away && typeof r.away === "object" ? r.away as Record<string, unknown> : null;
  const from = a ? time(a.from) : 0;
  const to = a ? time(a.to) : 0;
  return { lastPresent: time(r.lastPresent), away: a && from > 0 && to > from ? { from, to, collapsed: a.collapsed === true } : null };
}

/**
 * A sign that the user is here (the page was used). After a gap of AWAY_MS or more a digest opens for that gap (a digest still open from
 * an earlier gap is replaced: they left again). `started`: a digest opened now. The clock going backwards is no gap.
 */
export function present(state: Presence, now: number): { presence: Presence; started: boolean } {
  const gap = now - state.lastPresent;
  if (state.lastPresent > 0 && gap >= AWAY_MS) return { presence: { lastPresent: now, away: { from: state.lastPresent, to: now, collapsed: false } }, started: true };
  return { presence: { lastPresent: now, away: state.away }, started: false };
}

/** The user sent a message (in any chat): the digest is gone, and that is a sign of presence. `cleared`: there was one. */
export function messaged(state: Presence, now: number): { presence: Presence; cleared: boolean } {
  return { presence: { lastPresent: now, away: null }, cleared: state.away !== null };
}

/** 看完了 (collapsed) and the chip's reopen (not). False: no digest open, or it is already so. */
export function collapse(state: Presence, collapsed: boolean): Presence | null {
  if (!state.away || state.away.collapsed === collapsed) return null;
  return { ...state, away: { ...state.away, collapsed } };
}

/** The length of the gap in the unit the title uses: minutes under an hour, hours under two days, else days (rounded, at least 1). */
export function spanOf(from: number, to: number): { unit: "min" | "hour" | "day"; n: number } {
  const minutes = Math.max(0, to - from) / 60_000;
  if (minutes < 60) return { unit: "min", n: Math.max(1, Math.round(minutes)) };
  const hours = minutes / 60;
  return hours < 48 ? { unit: "hour", n: Math.round(hours) } : { unit: "day", n: Math.round(hours / 24) };
}

// ---- what changed in this chat's cards ----

export interface DigestRow { id: string; title: string; state: State; status: string; source: Source; at: number; waitingSince?: number }
/** One line for a bot that waits on the user for something (`more`: how many more things it waits on; `messageId`: the line to go to, if it is a question in its chat). */
export interface OtherLine { botId: string; name: string; text: string; more: number; messageId?: string }
export interface DigestView {
  from: number; to: number; collapsed: boolean;
  counts: { wait: number; run: number; done: number };
  rows: DigestRow[];
  others: OtherLine[];
  /** Bots with something waiting that are not listed (over MAX_OTHER_BOTS). */
  othersMore: number;
}

/** When the card last changed: its newest log line (a state or status change, a worker's report) or the bot's newest answer in its thread. */
export function changedAt(pin: Pin): number {
  const logged = pin.updates.reduce((latest, update) => Math.max(latest, update.at), 0);
  const answered = pin.thread.reduce((latest, turn) => (turn.a !== null && turn.aAt !== null ? Math.max(latest, turn.aAt) : latest), 0);
  return Math.max(logged, answered);
}
const ORDER: Record<State, number> = { wait: 0, run: 1, done: 2 };

/** What the chat page draws for a bot: its cards, and the digest while one is open. */
export interface PinsView extends BookView { away?: DigestView }

/** The cards that changed while the user was away: waiting first (they ask something of the user), then running, then done; the newest change first in each. */
export function changedCards(book: Book, away: Pick<Away, "from">): DigestRow[] {
  return book.pins
    .map((pin) => ({ pin, at: changedAt(pin) }))
    .filter(({ at }) => at >= away.from)
    .sort((a, b) => ORDER[a.pin.state] - ORDER[b.pin.state] || b.at - a.at)
    .map(({ pin, at }): DigestRow => ({
      id: pin.id, title: pin.title, state: pin.state, status: pin.status, source: pin.source, at,
      ...(pin.state === "wait" && pin.waitingSince !== undefined ? { waitingSince: pin.waitingSince } : {}),
    }));
}

// ---- what other bots wait on ----

/** What `workspace.waiting()` gives for one thing (a question in a chat, or a line of the bot's memory.md "Waiting on you"). */
export interface WaitingItem { botId: string; text: string; messageId?: string | null }
/** A line that says nothing waits (a section left with a placeholder). */
const NOTHING = /^[([（【]?\s*(none|nothing|n\/a|no|無|沒有|目前沒有|暫無|無待辦|沒有待辦)\s*[)\]）】]?[.。!！\s]*$/i;

/**
 * One line per bot (not this one) that waits on the user: the first thing it waits on, and how many more. Empty or "nothing" lines are no
 * item; a bot with only those has no line. Bots keep the order `waiting` gave; at most MAX_OTHER_BOTS are listed and the rest counted.
 * `names`: bot id to display name (a bot the app does not list is shown by its id).
 */
export function othersOf(items: readonly WaitingItem[], names: ReadonlyMap<string, string>, self: string): { lines: OtherLine[]; more: number } {
  const byBot = new Map<string, { texts: string[]; messageId?: string }>();
  for (const item of items) {
    if (!item || typeof item.botId !== "string" || !item.botId || item.botId === self) continue;
    const text = oneLine(item.text, MAX_OTHER_TEXT);
    if (!text || NOTHING.test(text) || !/[\p{L}\p{N}]/u.test(text)) continue;
    const entry = byBot.get(item.botId) ?? { texts: [] };
    if (!entry.texts.length && typeof item.messageId === "string" && item.messageId) entry.messageId = item.messageId;
    entry.texts.push(text);
    byBot.set(item.botId, entry);
  }
  const all = [...byBot].map(([botId, entry]): OtherLine => ({
    botId, name: oneLine(names.get(botId) ?? botId, MAX_NAME) || botId, text: entry.texts[0]!, more: entry.texts.length - 1, ...(entry.messageId ? { messageId: entry.messageId } : {}),
  }));
  return { lines: all.slice(0, MAX_OTHER_BOTS), more: Math.max(0, all.length - MAX_OTHER_BOTS) };
}

/** The digest this chat draws: null when there is nothing to say (no card changed and no other bot waits). */
export function digestOf(book: Book, away: Away, others: { lines: OtherLine[]; more: number }): DigestView | null {
  const rows = changedCards(book, away);
  if (!rows.length && !others.lines.length) return null;
  const counts = { wait: 0, run: 0, done: 0 };
  for (const row of rows) counts[row.state] += 1;
  return { from: away.from, to: away.to, collapsed: away.collapsed, counts, rows, others: others.lines, othersMore: others.more };
}

// ---- what the page reads ----

const text = (value: unknown, max: number): string => (typeof value === "string" ? oneLine(value, max) : "");
const count = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 999 ? value : 0);
const STATES: readonly State[] = ["wait", "run", "done"];
const SOURCES: readonly Source[] = ["bot", "app", "user"];

/** The digest as the page receives it (`chat.setData`): anything that is not of the shape above is dropped, so a wrong value draws nothing odd. */
export function readView(raw: unknown): DigestView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const from = time(r.from);
  const to = time(r.to);
  if (!from || to < from) return null;
  const c = r.counts && typeof r.counts === "object" ? r.counts as Record<string, unknown> : {};
  const rows = (Array.isArray(r.rows) ? r.rows.slice(0, 12) : []).flatMap((item): DigestRow[] => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : null;
    const state = row ? STATES.find((s) => s === row.state) : undefined;
    const source = row ? SOURCES.find((s) => s === row.source) : undefined;
    const id = row ? text(row.id, 20) : "";
    const title = row ? text(row.title, 40) : "";
    return row && state && source && id && title ? [{ id, title, state, status: text(row.status, 120), source, at: time(row.at), ...(typeof row.waitingSince === "number" && Number.isFinite(row.waitingSince) ? { waitingSince: row.waitingSince } : {}) }] : [];
  });
  const others = (Array.isArray(r.others) ? r.others.slice(0, MAX_OTHER_BOTS) : []).flatMap((item): OtherLine[] => {
    const line = item && typeof item === "object" ? item as Record<string, unknown> : null;
    const botId = line && typeof line.botId === "string" && line.botId.length <= 200 ? line.botId : "";
    const name = line ? text(line.name, MAX_NAME) : "";
    const body = line ? text(line.text, MAX_OTHER_TEXT) : "";
    return line && botId && name && body ? [{ botId, name, text: body, more: count(line.more), ...(typeof line.messageId === "string" && line.messageId && line.messageId.length <= 200 ? { messageId: line.messageId } : {}) }] : [];
  });
  return { from, to, collapsed: r.collapsed === true, counts: { wait: count(c.wait), run: count(c.run), done: count(c.done) }, rows, others, othersMore: count(r.othersMore) };
}
