// Pages of a chat's history, cut by size. A chat snapshot carries only the newest page (about 1 MiB of
// what the renderer receives); older lines come with `chat.history`, a page at a time, when the reader
// scrolls up or jumps to a line that is not loaded.

/** About how much of a chat one page carries, in bytes of its JSON. */
export const PAGE_BYTES = 1024 * 1024;
/** A page always has at least this many lines, however big (the newest lines are what the whiteboard and the task chips read). */
export const MIN_PAGE_LINES = 6;
/** The most bytes one `chat.history` page may be asked for. */
export const MAX_PAGE_BYTES = 8 * 1024 * 1024;

export interface HistoryPage<V> {
  /** The views of `records[start, end)`, oldest first. */
  views: V[];
  /** Index of the first line the page holds (0: nothing older). */
  start: number;
}

/** The lines just before `end`, as many as fit in `bytes` (at least `min`), newest page of `records.slice(0, end)`. */
export function pageBack<R, V>(records: readonly R[], end: number, view: (record: R) => V, bytes = PAGE_BYTES, min = MIN_PAGE_LINES): HistoryPage<V> {
  const views: V[] = [];
  let total = 0;
  let start = end;
  while (start > 0) {
    const next = view(records[start - 1]!);
    const size = Buffer.byteLength(JSON.stringify(next));
    if (views.length >= min && total + size > bytes) break;
    views.push(next);
    total += size;
    start--;
  }
  return { views: views.reverse(), start };
}

/** The lines from `start` up to `end`, for a jump to a line that lies beyond the page. */
export function sliceViews<R, V>(records: readonly R[], start: number, end: number, view: (record: R) => V): HistoryPage<V> {
  return { views: records.slice(start, end).map(view), start };
}
