// A bot's task history (`workspace.taskHistory`, plugin-extraction.md §4.3), plain data any plugin may
// read: its done log (done-days.json), when each task became done, kept for DONE_DAYS days, so a chart of
// finished tasks and the week-over-week change survive tasks.json dropping old cards (TaskBook keeps
// 100). A card closed by the user (`manuallyCompletedAt`) is counted apart. Pure; Bot keeps the log.
import { shownTasks, type TaskCard } from "./tasks";
import { fromSwiftDate } from "./store/records";

/** How many days of finished tasks the done log keeps (this week and last). */
export const DONE_DAYS = 14;

/** One finished task: when it became done (ms) and whether the user closed it by hand. */
export interface DoneEntry { at: number; manual: boolean }
/** Finished tasks by task id. */
export type DoneLog = Record<string, DoneEntry>;

/** The log as kept on disk; anything unreadable in it is left out. */
export function readDoneLog(value: unknown): DoneLog {
  const out: DoneLog = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const tasks = (value as { tasks?: unknown }).tasks;
  if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) return out;
  for (const [id, entry] of Object.entries(tasks as Record<string, unknown>)) {
    const raw = entry as { at?: unknown; manual?: unknown } | null;
    if (raw && typeof raw.at === "number" && Number.isFinite(raw.at)) out[id] = { at: raw.at, manual: raw.manual === true };
  }
  return out;
}

export const doneLogFile = (log: DoneLog) => ({ v: 1, tasks: log });

/** Local midnight `days` days before `now`'s day (0: today's). */
function dayStart(now: number, days: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.getTime();
}

/** A local day as the board names it: YYYY-MM-DD. */
export function dayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * When a done card became done (ms) and how: closed by the user (its `manuallyCompletedAt`), else its
 * last "done" on the timeline; `known` is false when only its last change tells (a card with no timeline).
 */
export function doneAt(card: TaskCard): DoneEntry & { known: boolean } {
  if (card.manuallyCompletedAt !== undefined) return { at: fromSwiftDate(card.manuallyCompletedAt), manual: true, known: true };
  const event = card.history?.findLast((entry) => entry.kind === "done" || entry.kind === "complete");
  return event ? { at: fromSwiftDate(event.at), manual: false, known: true } : { at: fromSwiftDate(card.updatedAt), manual: false, known: false };
}

/**
 * Brings the log up to the cards, idempotently (one entry per task id): a shown done card is logged
 * with when and how it was finished, and an entry follows its card when that changes (a done card you
 * close by hand becomes manual, at the close); a card guessed from its last change keeps its first
 * guess. One logged that is open again leaves (it is logged anew when done again). Nothing older than
 * DONE_DAYS is added, and older entries go. A card gone from tasks.json stays logged. True when the log changed.
 */
export function recordDone(log: DoneLog, cards: TaskCard[], now: number): boolean {
  let changed = false;
  const oldest = dayStart(now, DONE_DAYS - 1);
  for (const card of shownTasks(cards)) {
    const logged = log[card.id];
    if (card.state !== "done") {
      if (logged) { delete log[card.id]; changed = true; }
      continue;
    }
    const { known, ...entry } = doneAt(card);
    if (entry.at < oldest) {
      if (logged) { delete log[card.id]; changed = true; }
      continue;
    }
    if (!logged || (known && (logged.at !== entry.at || logged.manual !== entry.manual))) { log[card.id] = entry; changed = true; }
  }
  for (const [id, entry] of Object.entries(log)) if (entry.at < oldest) { delete log[id]; changed = true; }
  return changed;
}

export interface DoneDay { day: string; done: number; manual: number }

/** Tasks finished on each of the last DONE_DAYS days, oldest first; `manual`: of them, closed by the user. */
export function doneDays(log: DoneLog, now: number, days = DONE_DAYS): DoneDay[] {
  const out = Array.from({ length: days }, (_, index) => ({ from: dayStart(now, days - 1 - index), day: "", done: 0, manual: 0 }));
  for (const row of out) row.day = dayKey(row.from + 12 * 3_600_000);
  for (const entry of Object.values(log)) {
    const row = out.findLast((candidate) => entry.at >= candidate.from);
    if (!row || entry.at >= dayStart(now, -1)) continue;
    row.done++;
    if (entry.manual) row.manual++;
  }
  return out.map(({ day, done, manual }) => ({ day, done, manual }));
}

/** The last `days` days of the log (1 to DONE_DAYS; not a number: all it keeps), oldest first. */
export function taskHistory(log: DoneLog, now: number, days: number): DoneDay[] {
  const count = Number.isFinite(days) ? Math.min(DONE_DAYS, Math.max(1, Math.floor(days))) : DONE_DAYS;
  return doneDays(log, now, count);
}
