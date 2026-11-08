// Navigation v5, sub bots: the "Sub bots" button left of Chat | Board | Review, its menu, the breadcrumb
// "‹ botling / Release ▾" shown in its place inside a sub bot, and ⌘[ / ⌘] between the two. The pure part
// (SubBotNav.tsx draws it). A sub bot is a room the user opened on purpose; it is never a row of the left column.
import type { BotView, WaitingView } from "../contract";
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
}

export type SubBotSection = { title: "Needs you" | "Active" | "Idle"; rows: SubBotRow[] };

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

/** One row of the menu, from the sub bot and what waits on you. */
export function subBotRow(bot: BotView, waiting: WaitingView, now: number): SubBotRow {
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
  return { id: bot.id, name: bot.name, initial, tint: tintOf(bot.id), dot, purpose, status, badge };
}

/** The menu's sections: Needs you (asks, errors), Active (at work, new reports), Idle; empty ones left out. */
export function subBotSections(rows: SubBotRow[]): SubBotSection[] {
  const sections: SubBotSection[] = [
    { title: "Needs you", rows: rows.filter((row) => row.dot === "asks" || row.dot === "error") },
    { title: "Active", rows: rows.filter((row) => row.dot === "working" || row.dot === "new") },
    { title: "Idle", rows: rows.filter((row) => row.dot === "idle") },
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
export function headerNav(bot: BotView, bots: BotView[], waiting: WaitingView, now: number): HeaderNav {
  if (bot.parent) {
    const parent = bots.find((candidate) => candidate.id === bot.parent);
    if (!parent) return { kind: "none" };
    const rows = subBotsOf(parent.id, bots).map((sub) => subBotRow(sub, waiting, now));
    return { kind: "crumb", parent, current: rows.find((row) => row.id === bot.id) ?? subBotRow(bot, waiting, now), rows };
  }
  const rows = subBotsOf(bot.id, bots).map((sub) => subBotRow(sub, waiting, now));
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
