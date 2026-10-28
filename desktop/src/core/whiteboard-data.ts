// What the main bot's whiteboard needs besides a bot's memory and task cards (pure; Bot and the
// server call these):
//   - its done log (done-days.json): when each task became done, kept for DONE_DAYS days, so the
//     board's "Tasks finished" chart and week-over-week change survive tasks.json dropping old cards
//     (TaskBook keeps 100). A card closed by the user (`manuallyCompletedAt`) is counted apart.
//   - its latest action: the newest entry on any task card's timeline (else the newest card).
//   - its one-line description for the board's tooltip.
//   - a pending tool approval's command, from the approval card's text.
import type { TaskView } from "../contract";
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

/** When a done card became done (ms): closed by the user, else its last "done" on the timeline, else its last change. */
export function doneAt(card: TaskCard): DoneEntry {
  if (card.manuallyCompletedAt !== undefined) return { at: fromSwiftDate(card.manuallyCompletedAt), manual: true };
  const event = card.history?.findLast((entry) => entry.kind === "done" || entry.kind === "complete");
  return { at: fromSwiftDate(event?.at ?? card.updatedAt), manual: false };
}

/**
 * Brings the log up to the cards: a shown card that is done and not logged yet is added; one logged
 * that is open again leaves (it is logged anew when it is done again); entries older than DONE_DAYS
 * go. A card gone from tasks.json stays logged. True when the log changed.
 */
export function recordDone(log: DoneLog, cards: TaskCard[], now: number): boolean {
  let changed = false;
  for (const card of shownTasks(cards)) {
    if (card.state === "done") {
      if (!log[card.id]) { log[card.id] = doneAt(card); changed = true; }
    } else if (log[card.id]) {
      delete log[card.id];
      changed = true;
    }
  }
  const oldest = dayStart(now, DONE_DAYS - 1);
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

export interface LatestAction { kind: "done" | "now" | "waiting"; text: string; at: string }

const clip = (text: string, limit = 400) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/**
 * The bot's latest action: the newest entry on its task cards' timelines (a task done, what it is
 * doing now, what it waits on you for); a card with no timeline counts by its last change. Null: no tasks.
 */
export function latestAction(tasks: TaskView[]): LatestAction | null {
  let best: { at: number; action: LatestAction } | null = null;
  const consider = (at: string, action: Omit<LatestAction, "at">) => {
    const time = Date.parse(at);
    if (Number.isNaN(time) || !action.text.trim()) return;
    if (!best || time >= best.at) best = { at: time, action: { ...action, text: clip(action.text.trim()), at } };
  };
  for (const task of tasks.filter((candidate) => candidate.name.trim())) {
    const history = task.history ?? [];
    if (!history.length) {
      const kind = task.state === "done" || task.state === "stopped" ? "done" : task.state === "waiting" ? "waiting" : "now";
      const text = kind === "waiting" ? task.blocked ?? task.name : kind === "now" ? task.now ?? task.name : task.state === "stopped" ? `${task.name} (stopped)` : task.name;
      consider(task.updatedAt, { kind, text });
      continue;
    }
    for (const event of history) {
      switch (event.kind) {
        case "done": case "complete": consider(event.at, { kind: "done", text: task.name }); break;
        case "stopped": consider(event.at, { kind: "done", text: `${task.name} (stopped)` }); break;
        case "waiting": consider(event.at, { kind: "waiting", text: event.text ?? task.blocked ?? task.name }); break;
        case "now": consider(event.at, { kind: "now", text: event.text ?? task.name }); break;
        // Started, your reply, a subagent sent: the task is under way.
        default: consider(event.at, { kind: "now", text: task.name }); break;
      }
    }
  }
  return (best as { action: LatestAction } | null)?.action ?? null;
}

/** The bot in one line, for the board's tooltip: its job, else its memory's first "Current status" line, else its folder's name. */
export function botDescription(job: string | null | undefined, status: string | undefined, folder: string): string | null {
  const first = (text: string | null | undefined) => (text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const line = first(job) || first(status) || (folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "");
  return line ? clip(line) : null;
}

/** What a tool approval card asks to run: the text in its fence (`permissionText`), else its first line. */
export function approvalSummary(text: string): string {
  const fenced = /^(~{3,})\n([\s\S]*?)\n\1\s*$/m.exec(text);
  const body = fenced?.[2] ?? text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  return clip(body.trim().replace(/\s+/g, " "));
}
