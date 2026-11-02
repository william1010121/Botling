// The whiteboard's own figures and wording, as functions (moved unchanged from the app page's Whiteboard.tsx):
// who waits on you, the lanes, the ranking, the week, the short lines on a card. Pure: the board's data in, text and
// numbers out. ui.tsx draws them.
import type { AskKind, Bot, Entry, Lanes, Picture, Task, Waiting, WaitingItem } from "./types";

export type { AskKind, Lanes };

/** When the bot last did something: its chat's newest line or its newest task change (ms; null: never). */
export function lastActive(bot: Bot, data: Entry | undefined): number | null {
  const times = [bot.lastActivity, ...(data?.tasks ?? []).map((task) => task.updatedAt)].map((iso) => (iso ? Date.parse(iso) : NaN)).filter((at) => !Number.isNaN(at));
  return times.length ? Math.max(...times) : null;
}

/** What waits on you from one bot: its open questions or its memory's "Waiting on you" (as the right panel lists them). */
export const waitingFor = (bot: Bot, waiting: Waiting): WaitingItem[] => waiting.items.filter((item) => item.botId === bot.id);

/** The tasks waiting on you from the bot that you have not acknowledged with Notify. */
const waitingTasks = (bot: Bot, waiting: Waiting, data: Entry | undefined) =>
  (data?.tasks ?? []).filter((task) => task.state === "waiting" && !(waiting.acked ?? []).includes(`${bot.id}-task:${task.id}`));

/** Its tool approvals waiting: the bot's count, or more when the board's details (a moment newer) name more. */
const approvalCount = (bot: Bot, data: Entry | undefined) => Math.max(bot.approvals, data?.approvals?.length ?? 0);

/** How many things wait on you from the bot: those questions, its tasks waiting on you, its tool approvals. */
export function waitingCount(bot: Bot, waiting: Waiting, data: Entry | undefined): number {
  return waitingFor(bot, waiting).length + waitingTasks(bot, waiting, data).filter((task) => task.name.trim()).length + approvalCount(bot, data);
}

/** One row of what waits on you, as the Waiting lane lists it. `open`: the chat that answers it; `count`: how many things the row stands for (approvals with no details share one row). */
export interface Ask { key: string; kind: AskKind; text: string; code: string | null; at: string | null; open: string; count: number; ack?: { botId: string; text: string } | null }

/** How many things the rows stand for (what the pill, the lane and the number say). */
export const askCount = (asks: Ask[]) => asks.reduce((sum, ask) => sum + ask.count, 0);

/**
 * Every thing waiting on you from the bot, oldest first (the same as the report's "Your call" and
 * `waitingCount`): its open questions (a memory "Waiting on you" line is your call), its tasks
 * waiting on you, its tool approvals with what they would run (a count when the core gives none).
 */
export function waitingAsks(bot: Bot, waiting: Waiting, data: Entry | undefined): Ask[] {
  const out: Ask[] = [];
  for (const item of waitingFor(bot, waiting)) {
    out.push({ key: `q:${item.messageId ?? item.text}`, kind: item.messageId ? "question" : "call", text: item.text, code: null, at: item.at ?? null, open: item.botId, count: 1, ack: item.messageId ? null : { botId: item.botId, text: item.text } });
  }
  for (const task of named(waitingTasks(bot, waiting, data))) {
    const why = task.blocked ?? task.now;
    out.push({ key: `t:${task.id}`, kind: "call", text: why ? `${task.name} · ${why}` : task.name, code: null,
      at: task.history?.findLast((event) => event.kind === "waiting")?.at ?? task.updatedAt, open: bot.id, count: 1, ack: { botId: bot.id, text: `task:${task.id}` } });
  }
  const listed = data?.approvals ?? [];
  listed.forEach((approval, index) => out.push({ key: `a:${index}`, kind: "approval", text: approval.tool, code: approval.text, at: approval.at, open: bot.id, count: 1 }));
  const rest = approvalCount(bot, data) - listed.length;
  if (rest > 0) out.push({ key: "a:rest", kind: "approval", text: `${rest}${listed.length ? " more" : ""} tool approval${rest === 1 ? "" : "s"} waiting`, code: null, at: null, open: bot.id, count: rest });
  const time = (ask: Ask) => (ask.at ? Date.parse(ask.at) : NaN);
  return out.map((ask, index) => ({ ask, index })).sort((a, b) => {
    const [x, y] = [time(a.ask), time(b.ask)];
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) === Number.isNaN(y) ? a.index - b.index : Number.isNaN(x) ? 1 : -1;
    return x - y || a.index - b.index;
  }).map(({ ask }) => ask);
}

/** At work now: a turn under way, its subagents, a guest answering in its chat, or a task's subagent at work. */
export function isRunning(bot: Bot, data: Entry | undefined): boolean {
  return bot.working || bot.subagents > 0 || !!bot.guest || (data?.tasks ?? []).some((task) => task.state === "running" && task.atWork);
}

/** Its state on the board: Running, Ready (awake, nothing to do) or Asleep. */
export function laneStatus(bot: Bot, data: Entry | undefined): { key: string; text: string } {
  if (isRunning(bot, data)) return { key: "working", text: "Running" };
  if (bot.phase !== "asleep") return { key: "awake", text: "Ready" };
  return { key: "asleep", text: "Asleep" };
}


/**
 * The board's three lanes. Waiting on you: every bot with something for you, most
 * first. Running: bots at work with nothing for you, latest first. The rest on the
 * shelf: pinned first, then the ready ones, then by their last update. Each bot shows once.
 */
export function boardLanes(bots: Bot[], byBot: ReadonlyMap<string, Entry>, waiting: Waiting, pinned: ReadonlySet<string> = new Set()): Lanes {
  const out: Lanes = { waiting: [], running: [], quiet: [] };
  const counts = new Map<string, number>();
  for (const bot of bots) {
    if (bot.role === "main") continue;
    const data = byBot.get(bot.id);
    const count = waitingCount(bot, waiting, data);
    counts.set(bot.id, count);
    if (count > 0) out.waiting.push(bot);
    else if (isRunning(bot, data)) out.running.push(bot);
    else out.quiet.push(bot);
  }
  const recent = (bot: Bot) => lastActive(bot, byBot.get(bot.id)) ?? -Infinity;
  out.waiting.sort((a, b) => counts.get(b.id)! - counts.get(a.id)!);
  out.running.sort((a, b) => recent(b) - recent(a));
  const rank = (bot: Bot) => (pinned.has(bot.id) ? 0 : bot.phase !== "asleep" ? 1 : 2);
  out.quiet.sort((a, b) => rank(a) - rank(b) || recent(b) - recent(a));
  return out;
}

/** Where the open work is: bots with something waiting on you or under way, most waiting first. */
export function openRanking(bots: Bot[], byBot: ReadonlyMap<string, Entry>, waiting: Waiting): { bot: Bot; waiting: number; active: number }[] {
  return bots.filter((bot) => bot.role !== "main")
    .map((bot) => ({ bot, waiting: waitingCount(bot, waiting, byBot.get(bot.id)), active: taskCounts(byBot.get(bot.id)?.tasks ?? []).active }))
    .filter((row) => row.waiting + row.active > 0)
    .sort((a, b) => b.waiting - a.waiting || b.active - a.active);
}

/** A local day as the core names it (done-days.json): YYYY-MM-DD. */
export function dayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The last `days` days (oldest first) as their keys and midnight times. */
function lastDays(now: number, days: number): { key: string; from: number }[] {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - (days - 1 - index));
    const from = new Date(date); from.setHours(0, 0, 0, 0);
    return { key: dayKey(date.getTime()), from: from.getTime() };
  });
}

/**
 * Tasks the bot finished on each of the last seven days, oldest first: from its done log (done-days.json,
 * which outlives pruned cards), else (an older core) from its done cards' last change.
 */
export function botWeek(data: Entry | undefined, now: number): number[] {
  if (data?.doneDays) {
    const byDay = new Map(data.doneDays.map((day) => [day.day, day.done]));
    return lastDays(now, 7).map((day) => byDay.get(day.key) ?? 0);
  }
  return doneByDay(data?.tasks ?? [], now).map((day) => day.count);
}

/** The board's "Tasks finished": each of the last seven days across the bots, this week's sum and last week's (null: not known). */
export function boardWeek(entries: (Entry | undefined)[], now: number): { days: { key: string; label: string; count: number; today: boolean }[]; week: number; lastWeek: number | null } {
  const days = lastDays(now, 14);
  const counts = days.map(() => 0);
  let known = false;
  for (const data of entries) {
    if (data?.doneDays) {
      known = true;
      const byDay = new Map(data.doneDays.map((day) => [day.day, day.done]));
      days.forEach((day, index) => { counts[index]! += byDay.get(day.key) ?? 0; });
    } else {
      botWeek(data, now).forEach((count, index) => { counts[7 + index]! += count; });
    }
  }
  const week = counts.slice(7).reduce((sum, count) => sum + count, 0);
  return {
    days: days.slice(7).map((day, index) => {
      const date = new Date(day.from);
      return { key: day.key, label: index === 6 ? "Today" : `${date.getMonth() + 1}/${date.getDate()}`, count: counts[7 + index]!, today: index === 6 };
    }),
    week,
    lastWeek: known ? counts.slice(0, 7).reduce((sum, count) => sum + count, 0) : null,
  };
}

/** Weeks since the bot last did anything, from three weeks on (null: sooner, or never). */
export function quietWeeks(bot: Bot, data: Entry | undefined, now: number): number | null {
  const at = lastActive(bot, data);
  if (at === null) return null;
  const days = (now - at) / 86_400_000;
  return days >= 21 ? Math.floor(days / 7) : null;
}

/** How long ago, short: "now", "20m", "3h", "2d". */
export function ageLabel(at: string | null | undefined, now: number): string | null {
  const time = at ? Date.parse(at) : NaN;
  if (Number.isNaN(time)) return null;
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

/** How wide a card's line may be, in half-width columns (a CJK character is two): one short sentence, as the approved design's cards. */
export const CARD_LINE_WIDTH = 44;

const wideChar = (char: string) => (char.codePointAt(0) ?? 0) >= 0x2e80;
/** A text's width in half-width columns (a CJK or full-width character counts two). */
export const lineWidth = (text: string) => [...text].reduce((sum, char) => sum + (wideChar(char) ? 2 : 1), 0);

/**
 * One short line from what a bot wrote: markdown marks taken off, its first sentence only, cut to
 * `width` columns with "…". A memory paragraph never goes on a card whole; the report has it all.
 */
export function shortLine(text: string | null | undefined, width = CARD_LINE_WIDTH): string | null {
  const plain = (text ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`/g, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim();
  if (!plain) return null;
  const end = plain.search(/[。！？]|[.!?](?=\s|$)/);
  const sentence = end >= 0 ? plain.slice(0, end + 1).trim() : plain;
  if (lineWidth(sentence) <= width) return sentence;
  let out = "";
  let used = 0;
  for (const char of sentence) {
    const step = wideChar(char) ? 2 : 1;
    if (used + step > width - 1) break;
    out += char;
    used += step;
  }
  return `${out.trimEnd().replace(/[，、,;；:：]$/, "")}…`;
}

/**
 * A short line when the bot has no latest action (no task cards): the first sentence of "Current
 * status", else of "In progress", else what the bot or its running task does now, else its job.
 */
export function highlight(bot: Bot, data: Entry | undefined, waiting: Waiting): string | null {
  const task = data ? activeTasks(named(data.tasks)).find((candidate) => candidate.state === "running" && candidate.now?.trim()) : undefined;
  for (const text of [data?.currentStatus[0], data?.inProgress[0], waiting.doing[bot.id], task?.now, bot.job]) {
    const line = shortLine(text);
    if (line) return line;
  }
  return null;
}

/** The card's line: the bot's latest action (✓ done, → now, ? waiting on you), else its short line. */
export function latestLine(bot: Bot, data: Entry | undefined, waiting: Waiting): { kind: "done" | "now" | "waiting" | null; text: string } | null {
  if (data?.latest?.text.trim()) return { kind: data.latest.kind, text: data.latest.text };
  const line = highlight(bot, data, waiting);
  return line ? { kind: null, text: line } : null;
}

/** The bot in one line for the shelf's tooltip: what the core says (job, status, folder), else its job, else its folder. */
export function description(bot: Bot, data: Entry | undefined): string {
  return data?.description ?? bot.job?.split("\n")[0]?.trim() ?? bot.folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

/** Tasks waiting, then under way (most recent first), as the right panel lists them (`activeTasks`). */
export function activeTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => task.state === "pending" || task.state === "running" || task.state === "waiting")
    .sort((a, b) => ((a.state === "waiting" ? 1 : 0) - (b.state === "waiting" ? 1 : 0)) || (new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
}

/** The latest finished tasks (`finishedTasks`). */
export function finishedTasks(tasks: Task[], limit = 3): Task[] {
  return tasks.filter((task) => task.state === "done" || task.state === "stopped")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, limit);
}

/** The picture to draw on the card: one with data to show (the core finds its component when the tile is drawn); else none. */
export function drawnPicture(data: Entry | undefined): Picture | null {
  const picture = data?.picture;
  if (!picture) return null;
  if (picture.status === "approve" || picture.status === "failed" || picture.status === "empty") return null;
  return picture.data === "null" ? null : picture;
}

/** At most this many pictures are drawn at once (each is a frame of its own). */
export const MOST_PICTURES = 12;

export const named = (tasks: Task[]) => tasks.filter((task) => task.name.trim().length > 0);

/** Tasks by state for the bar: waiting on you, under way, finished. */
export function taskCounts(tasks: Task[]): { waiting: number; active: number; done: number; total: number } {
  const shown = named(tasks);
  const waiting = shown.filter((task) => task.state === "waiting").length;
  const active = shown.filter((task) => task.state === "running" || task.state === "pending").length;
  const done = shown.filter((task) => task.state === "done" || task.state === "stopped").length;
  return { waiting, active, done, total: waiting + active + done };
}

/** Tasks finished on each of the last seven days, oldest first (by the time the card last changed). */
export function doneByDay(tasks: Task[], now: number): { day: string; count: number; today: boolean }[] {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, index) => {
    const from = new Date(start); from.setDate(start.getDate() - (6 - index));
    const to = new Date(from); to.setDate(from.getDate() + 1);
    return { from: from.getTime(), to: to.getTime(), day: index === 6 ? "Today" : from.toLocaleDateString("en-US", { month: "short", day: "numeric" }), today: index === 6 };
  });
  return days.map(({ from, to, day, today }) => ({ day, today, count: named(tasks).filter((task) => task.state === "done" && (() => { const at = Date.parse(task.updatedAt); return at >= from && at < to; })()).length }));
}

/** "Next": the memory's "In progress" lines, then what the tasks under way say comes next (no repeats). */
export function nextSteps(data: Entry): string[] {
  const out: string[] = [];
  for (const line of [...data.inProgress, ...activeTasks(named(data.tasks)).map((task) => task.next ?? "")]) {
    const text = line.trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out.slice(0, 10);
}

export function shortTime(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === new Date(now - 86_400_000).toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export const shortTimeOf = (at: number | null, now: number) => (at === null ? null : shortTime(new Date(at).toISOString(), now));

