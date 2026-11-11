// The left column's worker list, as pure functions: a bot's app-managed workers indented under its row, each one
// item named by its worker name (status and time on a second line). Its sub bots' workers are in the same list,
// each labelled with its sub bot. Workers opened for the same job (the name the bot gave with app_handoff's `group`,
// else the turn that handed them off) are one job item, its workers listed only once it is clicked open; never across
// bots (a sub bot's job is its own item, beside the bot's). At most 3 items (a job counts 1), the rest "N more".
// A finished worker stays until it is seen: its bot's chat was open after it ended, or it was opened itself; then it is
// gone the next time the list draws (it shows, greyed, only while it is the one open). A job goes once every worker
// in it is done and seen. No blue dot on a worker or a job: the bot row's count is where news shows. "Settle down"
// moves a finished worker to the right column's Settled at once. The bot's count folds the whole list. What is seen,
// the first start (older workers count as seen), the fold and the opened jobs are kept in this window's storage.
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
  /** Jobs clicked open (`RailJob.key`). */
  jobsOpen?: ReadonlySet<string>;
}

export interface RailWorkerItem {
  kind: "worker";
  row: SubagentRowView;
  ownerId: string;
  /** The sub bot it belongs to (its label), null for the bot's own. */
  subBot: { id: string; name: string } | null;
  /** Its owner and job (`<owner>|<group id>`), or its row id when it was opened for no job. */
  groupKey: string;
  state: RailWorkerState;
  /** Ended and not seen yet. */
  unread: boolean;
  /** Ended and opened: greyed (it shows only while open). */
  viewed: boolean;
  /** Open in the main area now. */
  selected: boolean;
}

/** Several workers of one bot opened for one job: one item, its workers shown once it is clicked open. */
export interface RailJob {
  kind: "job";
  /** `<owner>|<group id>` (what keeps it open). */
  key: string;
  title: string;
  ownerId: string;
  subBot: RailWorkerItem["subBot"];
  /** Its workers, in the list's order. */
  members: RailWorkerItem[];
  open: boolean;
  /** The workers shown under it: none until opened, then at most 3 unless "all". */
  shown: RailWorkerItem[];
  more: number;
  /** Its "N more" was clicked and it has more than 3. */
  showingAll: boolean;
  /** One of its workers is open in the main area. */
  selected: boolean;
}

export type RailEntry = RailWorkerItem | RailJob;

export interface RailWorkerList {
  /** Every listed worker, its sub bots' included (the count on the bot row). */
  total: number;
  unread: number;
  folded: boolean;
  /** The items shown: none when folded, at most 3 unless "all". */
  items: RailEntry[];
  /** How many "N more" hides. */
  more: number;
  /** "N more" was clicked and there were more than 3. */
  showingAll: boolean;
}

const ended = (row: Pick<SubagentRowView, "startedAt" | "endedAt">) => row.endedAt ?? row.startedAt;
const stateOf = (status: SubagentRowView["status"]): RailWorkerState => (status === "completed" ? "done" : status);
const RANK: Record<string, number> = { unreadFailed: 0, unread: 1, running: 2, rest: 3 };

/** A bot's own items (labelled `subBot` when it is a sub bot under the listed one), unsorted; `all`: the gone ones too. */
function collect(bot: Pick<BotView, "id" | "name" | "subagentRows">, now: number, marks: RailMarks, subBot: RailWorkerItem["subBot"], all = false): RailWorkerItem[] {
  const items: RailWorkerItem[] = [];
  for (const row of workerRowsOf(bot)) {
    if (row.settled) continue;
    const state = stateOf(row.status);
    const selected = marks.watching?.botId === bot.id && marks.watching.id === row.id;
    const base = { kind: "worker" as const, row, ownerId: bot.id, subBot, groupKey: row.group ? `${bot.id}|${row.group.id}` : row.id, state, selected };
    if (state === "running") { items.push({ ...base, unread: false, viewed: false }); continue; }
    const unread = !marks.viewed.has(row.id) && ended(row) >= marks.since;
    const back = row.unsettledAt !== null && now - row.unsettledAt < LISTED_AFTER_ENDING_MS;
    if (!all && !unread && !selected && !back) continue;
    items.push({ ...base, unread: unread && !selected, viewed: !unread || selected });
  }
  return items;
}

/** Whether a worker is listed on its own (running, not seen yet, open, or brought back). */
const listed = (item: RailWorkerItem, now: number) =>
  item.state === "running" || item.unread || item.selected || (item.row.unsettledAt !== null && now - item.row.unsettledAt < LISTED_AFTER_ENDING_MS);

/**
 * Sorted items with one job's workers merged into one item where it first comes (two or more of them; one alone stays
 * a worker). A job is listed while any of its workers is, and then holds all its workers that are not settled.
 */
function merged(everyone: RailWorkerItem[], now: number, marks: RailMarks): RailEntry[] {
  const byKey = new Map<string, RailWorkerItem[]>();
  for (const item of everyone) byKey.set(item.groupKey, [...(byKey.get(item.groupKey) ?? []), item]);
  const out: RailEntry[] = [];
  const done = new Set<string>();
  for (const item of everyone) {
    if (!listed(item, now) || done.has(item.groupKey)) continue;
    const members = byKey.get(item.groupKey)!;
    if (!item.row.group || members.length < 2) { out.push(item); continue; }
    done.add(item.groupKey);
    const open = marks.jobsOpen?.has(item.groupKey) ?? false;
    const all = marks.all.has(item.groupKey);
    const shown = !open ? [] : all ? members : members.slice(0, RAIL_WORKERS_AT_MOST);
    out.push({
      kind: "job", key: item.groupKey, title: item.row.group.title || item.row.title, ownerId: item.ownerId, subBot: item.subBot,
      members, open, shown, more: open ? members.length - shown.length : 0, showingAll: open && all && members.length > RAIL_WORKERS_AT_MOST, selected: members.some((member) => member.selected),
    });
  }
  return out;
}

/** Items in order: unread failures, other unread, running (newest first), then the open or brought-back ones. */
function sorted(items: RailWorkerItem[]): RailWorkerItem[] {
  const rank = (item: RailWorkerItem) => (item.unread ? (item.state === "failed" ? RANK.unreadFailed! : RANK.unread!) : item.state === "running" ? RANK.running! : RANK.rest!);
  const time = (item: RailWorkerItem) => (item.state === "running" ? item.row.startedAt : ended(item.row));
  return items.sort((a, b) => rank(a) - rank(b) || time(b) - time(a));
}

/** A bot's own workers listed on their own, in order (jobs not merged). */
export function railWorkerItems(bot: Pick<BotView, "id" | "name" | "subagentRows">, now: number, marks: RailMarks): RailWorkerItem[] {
  return sorted(collect(bot, now, marks, null));
}

/** A bot's own finished workers its chat being open counts as seen (not its sub bots': theirs are seen in their chats). */
export function seenInChat(bot: Pick<BotView, "subagentRows">, viewed: ReadonlySet<string>): string[] {
  return workerRowsOf(bot).filter((row) => row.status !== "running" && !viewed.has(row.id)).map((row) => row.id);
}

/** Its sub bots, theirs under each (depth-first, as the bots list orders them). */
function subBotsUnder(bot: BotView, bots: BotView[], depth = 0): BotView[] {
  if (depth >= 8) return [];
  return bots.filter((candidate) => candidate.parent === bot.id && candidate.id !== bot.id).flatMap((sub) => [sub, ...subBotsUnder(sub, bots, depth + 1)]);
}

/** The list under a bot row: its own workers and its sub bots' (labelled), sorted together, one job's merged, then capped. */
export function railWorkers(bot: BotView, bots: BotView[], now: number, marks: RailMarks): RailWorkerList {
  const items = merged(sorted([
    ...collect(bot, now, marks, null, true),
    ...subBotsUnder(bot, bots).flatMap((sub) => collect(sub, now, marks, { id: sub.id, name: sub.name }, true)),
  ]), now, marks);
  const workers = items.flatMap((entry) => (entry.kind === "job" ? entry.members : [entry]));
  const total = workers.length, unread = workers.filter((item) => item.unread).length;
  const folded = marks.folded.has(bot.id);
  if (folded) return { total, unread, folded, items: [], more: 0, showingAll: false };
  const all = marks.all.has(bot.id);
  const shown = all ? items : items.slice(0, RAIL_WORKERS_AT_MOST);
  return { total, unread, folded, items: shown, more: items.length - shown.length, showingAll: all && items.length > RAIL_WORKERS_AT_MOST };
}

// Words (the shell's language; English for anything else).
const WORDS = {
  en: {
    running: "Running", done: "Done", failed: "Failed", stopped: "Stopped", viewed: "Viewed",
    waiting: { command: "Waiting for background command: ", monitor: "Waiting for Monitor: ", agent: "Waiting for background agent: ", process: "Waiting for its earlier process to end" },
    more: (n: number) => `${n} more`, fewer: "Show fewer", settle: "Settle down", settleHint: "Settle down: move to Settled in the right column",
    ran: (t: string) => `ran ${t}`, minutes: (m: number) => `${m}m`, hours: (h: number, m: number) => `${h}h ${m}m`,
    fold: (name: string) => `Fold ${name}’s workers`, unfold: (name: string, n: number) => `Show ${name}’s ${n} worker${n === 1 ? "" : "s"}`,
    unread: (n: number) => `${n} finished, not viewed yet`, failedCount: (n: number) => `${n} failed`, workers: (n: number) => `${n} worker${n === 1 ? "" : "s"}`, sep: " · ",
    openJob: (title: string, n: number) => `Show the ${n} workers of ${title}`, closeJob: (title: string) => `Fold ${title}`, ofSubBot: (name: string) => `of the sub bot ${name}`, onMachine: (name: string, connected: boolean) => `on ${name}${connected ? "" : " (not connected)"}`, moreLabel: (name: string, n: number) => `Show ${n} more of ${name}’s workers`,
  },
  "zh-Hant": {
    running: "進行中", done: "做完", failed: "失敗", stopped: "已停止", viewed: "已看過",
    waiting: { command: "等背景指令：", monitor: "等 Monitor：", agent: "等背景 agent：", process: "等它先前的行程結束" },
    more: (n: number) => `還有 ${n} 個`, fewer: "收合", settle: "收起", settleHint: "收起：移到右側欄的「已收起」",
    ran: (t: string) => `跑了 ${t}`, minutes: (m: number) => `${m} 分`, hours: (h: number, m: number) => `${h} 小時 ${m} 分`,
    fold: (name: string) => `折起 ${name} 的 worker`, unfold: (name: string, n: number) => `展開 ${name} 的 ${n} 個 worker`,
    unread: (n: number) => `${n} 個做完還沒看`, failedCount: (n: number) => `${n} 失敗`, workers: (n: number) => `${n} 個`, sep: "・",
    openJob: (title: string, n: number) => `展開 ${title} 的 ${n} 個 worker`, closeJob: (title: string) => `收合 ${title}`, ofSubBot: (name: string) => `sub bot ${name} 的`, onMachine: (name: string, connected: boolean) => `在 ${name}${connected ? "" : "（未連線）"}`, moreLabel: (name: string, n: number) => `顯示 ${name} 其餘 ${n} 個 worker`,
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
  // Its words waiting (its process finishing background work): how long they have waited.
  if (item.state === "running" && item.row.waitingOn) return duration(now - item.row.waitingOn.since, lang);
  if (item.state === "running") return duration(now - item.row.startedAt, lang);
  if (item.viewed) return "";
  return railWords(lang).ran(duration(ended(item.row) - item.row.startedAt, lang));
}

/** A job's second line: how many failed (if any), how many workers, how long since the first started (to its last end). */
export function railJobMeta(job: RailJob, now: number, lang: string | null | undefined): string {
  const parts = railJobParts(job, now, lang);
  return [parts.failed, parts.rest].filter(Boolean).join(railWords(lang).sep);
}

/** A job's mark: running while one runs (its failures show on the second line), then failed if one failed, else done. */
export function railJobState(job: RailJob): RailWorkerState {
  if (job.members.some((item) => item.state === "running")) return "running";
  return job.members.some((item) => item.state === "failed") ? "failed" : "done";
}

/** A job's second line in parts: the failures (red, absent when none), then how many and how long. */
export function railJobParts(job: RailJob, now: number, lang: string | null | undefined): { failed: string | null; rest: string } {
  const w = railWords(lang);
  const failed = job.members.filter((item) => item.state === "failed").length;
  const start = Math.min(...job.members.map((item) => item.row.startedAt));
  const end = job.members.some((item) => item.state === "running") ? now : Math.max(...job.members.map((item) => ended(item.row)));
  return { failed: failed ? w.failedCount(failed) : null, rest: [w.workers(job.members.length), duration(end - start, lang)].join(w.sep) };
}

/** An item's state word ("Done", or "Viewed" once opened). */
export function railStateWord(item: RailWorkerItem, lang: string | null | undefined): string {
  const w = railWords(lang);
  const on = item.state === "running" ? item.row.waitingOn : undefined;
  if (on) return on.kind === "process" ? w.waiting.process : `${w.waiting[on.kind]}${on.title}`;
  if (item.viewed && item.state !== "running") return `${w[item.state]} · ${w.viewed}`;
  return w[item.state];
}

// Kept in this window's storage (it survives a restart; storage refused: only until reload).
const VIEWED_KEY = "botling.railWorkers.viewed";
const SINCE_KEY = "botling.railWorkers.since";
const FOLD_KEY = "botling.railWorkers.fold";
const JOBS_KEY = "botling.railWorkers.jobsOpen";

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

/** Marks workers viewed; the kept set, newest last (at most 500). */
export function markViewed(...ids: string[]): Set<string> {
  const viewed = readViewedWorkers();
  const fresh = ids.filter((id) => !viewed.has(id));
  if (!fresh.length) return viewed;
  const next = [...viewed, ...new Set(fresh)].slice(-500);
  writeJSON(VIEWED_KEY, next);
  return new Set(next);
}

/** The jobs clicked open (kept). */
export function readOpenJobs(): Set<string> {
  return new Set(strings(readJSON(JOBS_KEY)));
}

/** Opens or folds a job; the kept set (at most 200). */
export function toggleOpenJob(key: string): Set<string> {
  const list = [...readOpenJobs()];
  const next = list.includes(key) ? list.filter((id) => id !== key) : [...list, key].slice(-200);
  writeJSON(JOBS_KEY, next);
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
