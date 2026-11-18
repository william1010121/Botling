// botling.pin-area, what the strip draws (the view of a book) and the bookkeeping of a routed message. Moved out of model.ts as it was (the
// file's size gate); model.ts re-exports it, so `import * as M from "./model"` still sees all of it.
import { CLOSED_SHOW_MS, MAX_Q, clean, isStale, type Book, type Pin, type Source, type State, type Step, type Turn, type Update } from "./model";
import { suggestView } from "./model-suggest";

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
      unread: pin.updatedAt > (pin.seenAt ?? 0), thread: pin.thread, updates: pin.updates, createdAt: pin.createdAt, updatedAt: pin.updatedAt,
      ...(isStale(pin) ? { stale: true as const } : {}), ...(pin.nudge ? { nudge: true as const } : {}),
    })),
    ...(now !== undefined && closedOf(book, now).length ? { closed: closedOf(book, now) } : {}),
    ...(now !== undefined && suggestView(book, now).length ? { suggest: suggestView(book, now) } : {}),
  };
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
