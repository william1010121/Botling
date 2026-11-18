// botling.pin-area, what the app only suggests (a new card, a merge): nothing happens until the user taps. Moved out of model.ts as it
// was (the file's size gate); model.ts re-exports it, so `import * as M from "./model"` still sees all of it.
import { MAX_LINKED, MAX_SUGGEST, MAX_TITLE, MAX_TURNS, SUGGEST_MS, SUGGEST_TEXT, addPin, fromMessage, isId, isRid, linkFrom, logLine, oneLine, remove, type Book, type Pin, type Refusal, type Suggest, type Turn } from "./model";

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
