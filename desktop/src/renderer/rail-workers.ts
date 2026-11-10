// The left column's worker list, as pure functions: a bot's app-managed workers indented under its row, each one
// item named by its worker name (status and time on a second line). Its sub bots' workers are in the same list,
// each labelled with its sub bot. At most 3, the rest "N more". A finished worker stays, marked unread, until you
// open it; once viewed it is gone the next time the list draws (it shows, greyed, only while it is the one open),
// and "Settle down" moves it to the right column's Settled at once. A failed one stays the same way. The bot's count
// folds the whole list. What is viewed, the first start (older workers count as viewed) and the fold are kept in
// this window's storage.
// The list is collected, sorted, then capped; items carry `groupKey` (one per worker today) so several workers
// started for the same job can later be merged into one item between the sort and the cap.
import { LISTED_AFTER_ENDING_MS, type BotView, type SubagentRowView } from "../contract";
import { workerRowsOf } from "./worker-panel";

export const RAIL_WORKERS_AT_MOST = 3;

export type Lang = "en" | "zh-Hant";
export type RailWorkerState = "running" | "done" | "failed" | "stopped";

export interface RailMarks {
  /** Workers you opened after they ended (ids). */
  viewed: ReadonlySet<string>;
  /** Workers that ended before this time count as viewed (the list's first start). */
  since: number;
  /** The worker open in the main area, and its owner. */
  watching: { botId: string; id: string } | null;
  /** Bots whose whole list is folded (from the count on the bot row). */
  folded: ReadonlySet<string>;
  /** Bots whose "N more" was clicked (every item shows). */
  all: ReadonlySet<string>;
}

export interface RailWorkerItem {
  row: SubagentRowView;
  ownerId: string;
  /** The sub bot it belongs to (its label), null for the bot's own. */
  subBot: { id: string; name: string } | null;
  /** What merges items into one later (several workers for one job); its row id today. */
  groupKey: string;
  state: RailWorkerState;
  /** Ended and not opened yet: the blue dot. */
  unread: boolean;
  /** Ended and opened: greyed (it shows only while open). */
  viewed: boolean;
  /** Open in the main area now. */
  selected: boolean;
}

export interface RailWorkerList {
  /** Every listed worker, its sub bots' included (the count on the bot row). */
  total: number;
  unread: number;
  folded: boolean;
  /** The items shown: none when folded, at most 3 unless "all". */
  items: RailWorkerItem[];
  /** How many "N more" hides. */
  more: number;
  /** "N more" was clicked and there were more than 3. */
  showingAll: boolean;
}

const ended = (row: Pick<SubagentRowView, "startedAt" | "endedAt">) => row.endedAt ?? row.startedAt;
const stateOf = (status: SubagentRowView["status"]): RailWorkerState => (status === "completed" ? "done" : status);
const RANK: Record<string, number> = { unreadFailed: 0, unread: 1, running: 2, rest: 3 };

/** A bot's own items (labelled `subBot` when it is a sub bot under the listed one), unsorted. */
function collect(bot: Pick<BotView, "id" | "name" | "subagentRows">, now: number, marks: RailMarks, subBot: RailWorkerItem["subBot"]): RailWorkerItem[] {
  const items: RailWorkerItem[] = [];
  for (const row of workerRowsOf(bot)) {
    if (row.settled) continue;
    const state = stateOf(row.status);
    const selected = marks.watching?.botId === bot.id && marks.watching.id === row.id;
    const base = { row, ownerId: bot.id, subBot, groupKey: row.id, state, selected };
    if (state === "running") { items.push({ ...base, unread: false, viewed: false }); continue; }
    const unread = !marks.viewed.has(row.id) && ended(row) >= marks.since;
    const back = row.unsettledAt !== null && now - row.unsettledAt < LISTED_AFTER_ENDING_MS;
    if (!unread && !selected && !back) continue;
    items.push({ ...base, unread: unread && !selected, viewed: !unread || selected });
  }
  return items;
}

/** Items in order: unread failures, other unread, running (newest first), then the open or brought-back ones. */
function sorted(items: RailWorkerItem[]): RailWorkerItem[] {
  const rank = (item: RailWorkerItem) => (item.unread ? (item.state === "failed" ? RANK.unreadFailed! : RANK.unread!) : item.state === "running" ? RANK.running! : RANK.rest!);
  const time = (item: RailWorkerItem) => (item.state === "running" ? item.row.startedAt : ended(item.row));
  return items.sort((a, b) => rank(a) - rank(b) || time(b) - time(a));
}

/** A bot's own items, in order. */
export function railWorkerItems(bot: Pick<BotView, "id" | "name" | "subagentRows">, now: number, marks: RailMarks): RailWorkerItem[] {
  return sorted(collect(bot, now, marks, null));
}

/** Its sub bots, theirs under each (depth-first, as the bots list orders them). */
function subBotsUnder(bot: BotView, bots: BotView[], depth = 0): BotView[] {
  if (depth >= 8) return [];
  return bots.filter((candidate) => candidate.parent === bot.id && candidate.id !== bot.id).flatMap((sub) => [sub, ...subBotsUnder(sub, bots, depth + 1)]);
}

/** The list under a bot row: its own workers and its sub bots' (labelled), sorted together, then capped. */
export function railWorkers(bot: BotView, bots: BotView[], now: number, marks: RailMarks): RailWorkerList {
  const items = sorted([
    ...collect(bot, now, marks, null),
    ...subBotsUnder(bot, bots).flatMap((sub) => collect(sub, now, marks, { id: sub.id, name: sub.name })),
  ]);
  const total = items.length, unread = items.filter((item) => item.unread).length;
  const folded = marks.folded.has(bot.id);
  if (folded) return { total, unread, folded, items: [], more: 0, showingAll: false };
  const all = marks.all.has(bot.id);
  const shown = all ? items : items.slice(0, RAIL_WORKERS_AT_MOST);
  return { total, unread, folded, items: shown, more: total - shown.length, showingAll: all && total > RAIL_WORKERS_AT_MOST };
}

// Words (the shell's language; English for anything else).
const WORDS = {
  en: {
    running: "Running", done: "Done", failed: "Failed", stopped: "Stopped", viewed: "Viewed",
    more: (n: number) => `${n} more`, fewer: "Show fewer", settle: "Settle down", settleHint: "Settle down: move to Settled in the right column",
    ran: (t: string) => `ran ${t}`, minutes: (m: number) => `${m}m`, hours: (h: number, m: number) => `${h}h ${m}m`,
    fold: (name: string) => `Fold ${name}’s workers`, unfold: (name: string, n: number) => `Show ${name}’s ${n} worker${n === 1 ? "" : "s"}`,
    unread: (n: number) => `${n} finished, not viewed yet`, ofSubBot: (name: string) => `of the sub bot ${name}`, moreLabel: (name: string, n: number) => `Show ${n} more of ${name}’s workers`,
  },
  "zh-Hant": {
    running: "進行中", done: "做完", failed: "失敗", stopped: "已停止", viewed: "已看過",
    more: (n: number) => `還有 ${n} 個`, fewer: "收合", settle: "收起", settleHint: "收起：移到右側欄的「已收起」",
    ran: (t: string) => `跑了 ${t}`, minutes: (m: number) => `${m} 分`, hours: (h: number, m: number) => `${h} 小時 ${m} 分`,
    fold: (name: string) => `折起 ${name} 的 worker`, unfold: (name: string, n: number) => `展開 ${name} 的 ${n} 個 worker`,
    unread: (n: number) => `${n} 個做完還沒看`, ofSubBot: (name: string) => `sub bot ${name} 的`, moreLabel: (name: string, n: number) => `顯示 ${name} 其餘 ${n} 個 worker`,
  },
} as const;

export type RailWords = (typeof WORDS)["en"];
export const railWords = (lang: string | null | undefined): RailWords => (lang === "zh-Hant" ? WORDS["zh-Hant"] : WORDS.en) as RailWords;

export function duration(ms: number, lang: string | null | undefined): string {
  const w = railWords(lang);
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 60 ? w.minutes(minutes) : w.hours(Math.floor(minutes / 60), minutes % 60);
}

/** An item's second line after its state: how long so far (running), how long it ran (unread), nothing once viewed. */
export function railWorkerTime(item: RailWorkerItem, now: number, lang: string | null | undefined): string {
  if (item.state === "running") return duration(now - item.row.startedAt, lang);
  if (item.viewed) return "";
  return railWords(lang).ran(duration(ended(item.row) - item.row.startedAt, lang));
}

/** An item's state word ("Done", or "Viewed" once opened). */
export function railStateWord(item: RailWorkerItem, lang: string | null | undefined): string {
  const w = railWords(lang);
  if (item.viewed && item.state !== "running") return `${w[item.state]} · ${w.viewed}`;
  return w[item.state];
}

// Kept in this window's storage (it survives a restart; storage refused: only until reload).
const VIEWED_KEY = "botling.railWorkers.viewed";
const SINCE_KEY = "botling.railWorkers.since";
const FOLD_KEY = "botling.railWorkers.fold";

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
function readJSON(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; }
}
function writeJSON(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage refused */ }
}

export function readViewedWorkers(): Set<string> {
  return new Set(strings(readJSON(VIEWED_KEY)));
}

/** Marks a worker viewed; the kept set, newest last (at most 500). */
export function markViewed(id: string): Set<string> {
  const viewed = readViewedWorkers();
  if (viewed.has(id)) return viewed;
  const next = [...viewed, id].slice(-500);
  writeJSON(VIEWED_KEY, next);
  return new Set(next);
}

/** The list's first start (kept): workers that ended before it count as viewed. */
export function readRailSince(now: number): number {
  const kept = readJSON(SINCE_KEY);
  if (typeof kept === "number" && Number.isFinite(kept)) return kept;
  writeJSON(SINCE_KEY, now);
  return now;
}

export interface RailFold { folded: string[] }

export function readRailFold(): RailFold {
  const kept = readJSON(FOLD_KEY) as Partial<RailFold> | null;
  return { folded: strings(kept?.folded) };
}

/** Folds or unfolds a bot's list; the kept fold. */
export function toggleRailFold(botId: string): RailFold {
  const list = readRailFold().folded;
  const next = { folded: list.includes(botId) ? list.filter((id) => id !== botId) : [...list, botId].slice(-200) };
  writeJSON(FOLD_KEY, next);
  return next;
}
