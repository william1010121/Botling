// Navigation v5, sub bots: the "Sub bots" button left of Chat | Board | Review, its menu, the breadcrumb
// "‹ botling / Release ▾" shown in its place inside a sub bot, and ⌘[ / ⌘] between the two. The pure part
// (SubBotNav.tsx draws it). A sub bot is a room the user opened on purpose; it is never a row of the left column.
import type { BotView, RoutineView, WaitingView } from "../contract";
import { elapsedText } from "./rail-idle";

/** The status dot on a row's square face: blue at work, green an unread report, orange waits on you, red a problem, grey idle. */
export type SubBotDot = "working" | "new" | "asks" | "error" | "idle";
export type SubBotBadge = { kind: "asks" | "new" | "error" | "time"; text: string };

export interface SubBotRow {
  id: string;
  name: string;
  /** The letter on its square face. */
  initial: string;
  /** Which of the six face tints (styles.css `.sbn-face[data-tint]`), steady for a bot id. */
  tint: number;
  dot: SubBotDot;
  /** What it is for: its job's first line. */
  purpose: string | null;
  /** How it is now: its problem, what it asks, its progress line, or "Working · 1 worker". */
  status: string | null;
  /** The row's top-right word: asks / new / error, or how long it has been idle. */
  badge: SubBotBadge | null;
  /** When its soonest routine runs next (ms), and that routine's schedule ("Every day 09:00"); null: none will run. */
  next: number | null;
  schedule: string | null;
}

export type SubBotSection = { title: "Needs you" | "Pinned" | "Active" | "Scheduled" | "Idle"; rows: SubBotRow[] };

/** From this many sub bots on, the menu opens with a search box that filters names and purposes. */
export const SUB_BOT_SEARCH_FROM = 12;
const TINTS = 6;

/** A bot's own sub bots (not theirs), in the bots list's order. */
export function subBotsOf(botId: string, bots: BotView[]): BotView[] {
  return bots.filter((bot) => bot.parent === botId && bot.id !== botId);
}

function tintOf(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % TINTS;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (value: number) => String(value).padStart(2, "0");
/** When a routine runs next, in the viewer's time: "today 18:00", "tomorrow 09:00", "Thu 10:30" within the week, else "Nov 20 09:00". */
export function whenText(at: number, now: number): string {
  const when = new Date(at);
  const clock = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const day = (time: Date) => new Date(time.getFullYear(), time.getMonth(), time.getDate()).getTime();
  const days = Math.round((day(when) - day(new Date(now))) / 86_400_000);
  if (days <= 0) return `today ${clock}`;
  if (days === 1) return `tomorrow ${clock}`;
  if (days < 7) return `${DAYS[when.getDay()]} ${clock}`;
  return `${MONTHS[when.getMonth()]} ${when.getDate()} ${clock}`;
}

/** Its routine that runs soonest (enabled, with a next run), or null. */
function soonest(routines: readonly RoutineView[]): { at: number; schedule: string } | null {
  let best: { at: number; schedule: string } | null = null;
  for (const routine of routines) {
    const at = routine.next ? Date.parse(routine.next) : NaN;
    if (routine.status !== "enabled" || !Number.isFinite(at)) continue;
    if (!best || at < best.at) best = { at, schedule: routine.schedule };
  }
  return best;
}

/** One row of the menu, from the sub bot, what waits on you, and its routines (read from its own routines.cron). */
export function subBotRow(bot: BotView, waiting: WaitingView, now: number, routines: readonly RoutineView[] = []): SubBotRow {
  const asks = waiting.items.filter((item) => item.botId === bot.id);
  const needs = bot.approvals + asks.length;
  const dot: SubBotDot = bot.problem ? "error" : needs > 0 ? "asks" : bot.unread > 0 ? "new" : bot.working || bot.subagents > 0 ? "working" : "idle";
  const purpose = bot.job?.split("\n").map((line) => line.trim()).find(Boolean) ?? null;
  const doing = waiting.doing[bot.id] ?? null;
  const status = dot === "error" ? bot.problem
    : dot === "asks" ? (asks[0] ? `“${asks[0].text}”` : `${plural(bot.approvals, "approval")} waiting`)
    : doing ?? (bot.working || bot.subagents > 0 ? ["Working", bot.subagents > 0 ? plural(bot.subagents, "worker") : null].filter(Boolean).join(" · ") : null);
  const since = bot.lastActivity ? Date.parse(bot.lastActivity) : NaN;
  const badge: SubBotBadge | null = dot === "asks" ? { kind: "asks", text: "asks" } : dot === "new" ? { kind: "new", text: "new" }
    : dot === "error" ? { kind: "error", text: "error" } : dot === "idle" && Number.isFinite(since) ? { kind: "time", text: elapsedText(Math.max(0, now - since)) } : null;
  const initial = bot.name.trim().charAt(0).toUpperCase() || "?";
  const next = soonest(routines);
  // Idle with a routine coming: it says when it wakes instead of how long it slept.
  if (dot === "idle" && next) {
    return { id: bot.id, name: bot.name, initial, tint: tintOf(bot.id), dot, purpose, status: `Next ${whenText(next.at, now)}`,
      badge: { kind: "time", text: `⟳ ${next.schedule}` }, next: next.at, schedule: next.schedule };
  }
  return { id: bot.id, name: bot.name, initial, tint: tintOf(bot.id), dot, purpose, status, badge, next: next?.at ?? null, schedule: next?.schedule ?? null };
}

const needsYou = (row: SubBotRow) => row.dot === "asks" || row.dot === "error";
/**
 * The menu's sections: Needs you (asks, errors), Pinned (in your order), Active (at work, new reports),
 * Scheduled (idle with a routine coming, soonest first), Idle; empty ones left out. One that needs you stays in Needs you.
 */
export function subBotSections(rows: SubBotRow[], pinned: readonly string[] = []): SubBotSection[] {
  const pins = pinned.map((id) => rows.find((row) => row.id === id)).filter((row): row is SubBotRow => !!row && !needsYou(row));
  const rest = rows.filter((row) => !pins.includes(row));
  const sections: SubBotSection[] = [
    { title: "Needs you", rows: rest.filter(needsYou) },
    { title: "Pinned", rows: pins },
    { title: "Active", rows: rest.filter((row) => row.dot === "working" || row.dot === "new") },
    { title: "Scheduled", rows: rest.filter((row) => row.dot === "idle" && row.next !== null).sort((a, b) => a.next! - b.next!) },
    { title: "Idle", rows: rest.filter((row) => row.dot === "idle" && row.next === null) },
  ];
  return sections.filter((section) => section.rows.length > 0);
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
/** The rows whose name or purpose holds the query (ignoring case and accents). */
export function filterSubBotRows(rows: SubBotRow[], query: string): SubBotRow[] {
  const wanted = fold(query.trim());
  if (!wanted) return rows;
  return rows.filter((row) => fold(row.name).includes(wanted) || (row.purpose !== null && fold(row.purpose).includes(wanted)));
}

export type SubBotsButton =
  | { kind: "none" }
  | { kind: "one"; row: SubBotRow; hint: SubBotBadge | null }
  | { kind: "many"; count: number; stack: SubBotRow[]; hint: SubBotBadge | null };

/** The hint beside the button, the most urgent first: errors, then asks, then new reports. */
function buttonHint(rows: SubBotRow[]): SubBotBadge | null {
  for (const kind of ["error", "asks", "new"] as const) {
    const count = rows.filter((row) => row.dot === kind).length;
    if (count > 0) return { kind, text: `${count} ${kind}` };
  }
  return null;
}

/** The button: absent with no sub bots (the header as before), the name of the only one, else "Sub bots · N" with three faces. */
export function subBotsButton(rows: SubBotRow[]): SubBotsButton {
  if (rows.length === 0) return { kind: "none" };
  const hint = buttonHint(rows);
  if (rows.length === 1) return { kind: "one", row: rows[0]!, hint };
  return { kind: "many", count: rows.length, stack: rows.slice(0, 3), hint };
}

export type HeaderNav =
  | { kind: "none" }
  | { kind: "subBots"; rows: SubBotRow[] }
  | { kind: "crumb"; parent: BotView; current: SubBotRow; rows: SubBotRow[] };

/** The header's left side for the bot on screen: its Sub bots button, or inside a sub bot the way back to its project bot. */
export function headerNav(bot: BotView, bots: BotView[], waiting: WaitingView, now: number, routines: Readonly<Record<string, readonly RoutineView[]>> = {}): HeaderNav {
  const rowOf = (sub: BotView) => subBotRow(sub, waiting, now, routines[sub.id]);
  if (bot.parent) {
    const parent = bots.find((candidate) => candidate.id === bot.parent);
    if (!parent) return { kind: "none" };
    const rows = subBotsOf(parent.id, bots).map(rowOf);
    return { kind: "crumb", parent, current: rows.find((row) => row.id === bot.id) ?? rowOf(bot), rows };
  }
  const rows = subBotsOf(bot.id, bots).map(rowOf);
  return rows.length ? { kind: "subBots", rows } : { kind: "none" };
}

/** The sub bot last shown under each project bot (for ⌘]). */
export type LastRooms = Readonly<Record<string, string>>;

/** The rooms after showing `bot`: a sub bot becomes its project bot's last one; anything else leaves them as they are. */
export function rememberRoom(last: LastRooms, bot: BotView): LastRooms {
  if (!bot.parent || last[bot.parent] === bot.id) return last;
  return { ...last, [bot.parent]: bot.id };
}

/** ⌘[ (back): from a sub bot to its project bot. ⌘] (forward): from a project bot to the sub bot last shown. Null: nowhere to go. */
export function roomStep(direction: "back" | "forward", bot: BotView, bots: BotView[], last: LastRooms): string | null {
  if (direction === "back") return bot.parent && bots.some((candidate) => candidate.id === bot.parent) ? bot.parent : null;
  if (bot.parent) return null;
  const target = last[bot.id];
  return target && bots.some((candidate) => candidate.id === target && candidate.parent === bot.id) ? target : null;
}

/** Pin a sub bot (at the end of your order), or unpin it. */
export function togglePinned(pinned: readonly string[], id: string): string[] {
  return pinned.includes(id) ? pinned.filter((other) => other !== id) : [...pinned, id];
}

/** The pinned order after dragging `id` to place `to` (clamped); unknown ids leave it as it was. */
export function movePinned(pinned: readonly string[], id: string, to: number): string[] {
  const from = pinned.indexOf(id);
  if (from < 0) return [...pinned];
  const rest = pinned.filter((other) => other !== id);
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, id);
  return rest;
}

/** ⌘⇧N: the N-th pinned sub bot of the project bot on screen (inside a sub bot: of its project bot), or null. */
export function pinnedTarget(n: number, bot: BotView, bots: BotView[], pinned: readonly string[]): string | null {
  const project = bot.parent ?? bot.id;
  const mine = pinned.filter((id) => bots.some((candidate) => candidate.id === id && candidate.parent === project));
  return mine[n - 1] ?? null;
}

/** Where you left each project bot for one of its sub bots: its newest line then, and that sub bot's name. */
export type LeaveMarks = Readonly<Record<string, { after: string; name: string }>>;
type Room = { id: string; parent?: string | null; lastId: string | null };

/**
 * The marks after leaving `from` for `to`. Project bot → its sub bot: remember its newest line (shown on the way back).
 * Project bot → anywhere else: forget. Between its sub bots, or back: kept. Sub bot → elsewhere: its project's mark goes.
 */
export function leaveMark(marks: LeaveMarks, from: Room, to: Pick<BotView, "id" | "name" | "parent">): LeaveMarks {
  if (from.id === to.id) return marks;
  if (!from.parent) {
    if (to.parent === from.id && from.lastId) return { ...marks, [from.id]: { after: from.lastId, name: to.name } };
    if (!(from.id in marks)) return marks;
    const { [from.id]: _gone, ...rest } = marks;
    return rest;
  }
  if (to.id === from.parent || to.parent === from.parent || !(from.parent in marks)) return marks;
  const { [from.parent]: _gone, ...rest } = marks;
  return rest;
}

/** "New while you were in Release" over the first line that came after the mark, unless it is your own; else null. */
export function newSinceMark(mark: { after: string; name: string } | undefined, lines: readonly { id: string; role: string }[]): { messageID: string; text: string } | null {
  if (!mark) return null;
  const at = lines.findIndex((line) => line.id === mark.after);
  if (at < 0) return null;
  const first = lines.slice(at + 1).find((line) => line.role !== "user" && line.role !== "divider");
  return first ? { messageID: first.id, text: `New while you were in ${mark.name}` } : null;
}

/** The id of the "New while you were in X" divider line (styled by `.row.divider[data-id^="new-since:"]`). */
export const NEW_SINCE_PREFIX = "new-since:";

/** The chat's lines with that divider put in before its line. */
export function withNewSince<T extends { id: string; role: string }>(lines: T[], mark: { messageID: string; text: string } | null, divider: (id: string, text: string) => T): T[] {
  if (!mark) return lines;
  const at = lines.findIndex((line) => line.id === mark.messageID);
  if (at <= 0) return lines;
  return [...lines.slice(0, at), divider(`${NEW_SINCE_PREFIX}${mark.messageID}`, mark.text), ...lines.slice(at)];
}

/** How long the row you came back from keeps its ring: 600 ms, or a still 1.2 s ring with Reduce motion. */
export function flashMs(reducedMotion: boolean): number {
  return reducedMotion ? 1200 : 600;
}

/** "+ New sub bot…": the line sent to the project bot, which opens sub bots when asked (its sub-bot rule). */
export function newSubBotAsk(name: string, purpose: string): string {
  return `Please open a new sub bot named "${name.trim().replace(/"/g, "'")}" for this: ${purpose.trim()}`;
}
