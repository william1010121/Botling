// The main bot's whiteboard, in three layers (the approved Whiteboard redesign):
//   A. The summary: four numbers (bots, tasks, what waits on you, what runs), two donuts (tasks
//      done / under way / waiting; bots active / waiting / asleep), where the open work is (bots
//      ranked by what waits on you and what is under way) and the tasks finished on each of the last
//      seven days across all bots (each bot's done-days.json, so pruned cards still count).
//   B. Two lanes: "Waiting on you" (each bot with something for you lists every item: a question,
//      your call, a tool approval, with its age and a button to answer it) and "Running" (bots at
//      work: their latest action and what comes next). A bot both at work and waiting on you shows
//      once, in Waiting, marked Running.
//   C. The rest on a shelf, "Idle & asleep": a pill each (name, a 7-day spark, its last update,
//      "N wk quiet" after three weeks), dimmed; "Show details" opens a list (kept per user).
// A card shows the bot's latest action (the newest entry on its task cards' timelines), not its
// memory paragraph. Pressed, a card (or a pill, a row) grows into the bot's report, read by scrolling:
// Summary, Your call, Results, Progress, What I did, My calls ("Decided"), Next. Everything is what
// the bots keep themselves; a part with nothing in it is left out. A bot may give its card a picture
// of its own (<whiteboard>): one of its components, drawn as a 1×1 or 2×1 Board tile on its Running
// card, in the same sandboxed component frame as the chat's (Web/src's `componentPage`, served by
// main as `card.page`); the report shows it too. That module is loaded only when a picture is drawn.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type BotView, type ComponentInfoView, type MessageView, type ResultView, type TaskView, type WaitingItemView, type WaitingView, type WhiteboardBotView, type WhiteboardPictureView, type WhiteboardView } from "../contract";
import type { Client } from "./client";
import { faceURL } from "./avatars";
import { Icon } from "./icons";
import { activeTasks, finishedTasks } from "./RightPanel";
import { dictionaries, type Lang } from "../../../Web/src/i18n";
import { en, type Key } from "../../../Web/src/locales/en";

/** The board's own words in `lang` (the chat page's dictionaries; English for anything missing). */
function say(lang: Lang | null | undefined, key: Key, values: Record<string, string | number> = {}): string {
  const word = dictionaries[lang ?? "en"]?.[key] ?? en[key];
  const text = typeof word === "string" ? word : values.n === 1 ? word[0] : word[1];
  return text.replace(/\{(\w+)\}/g, (mark, name: string) => (name in values ? String(values[name]) : mark));
}

type Look = "original" | "cute";

/** The main view of the main bot: the whiteboard unless you last picked Chat or Board (kept for the next start). */
export const CHOICE_KEY = "botling.mainWhiteboard";
export function useWhiteboardChoice(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(CHOICE_KEY) !== "0"; } catch { return true; } });
  const choose = useCallback((next: boolean) => {
    setOn(next);
    try { localStorage.setItem(CHOICE_KEY, next ? "1" : "0"); } catch { /* no storage: this session only */ }
  }, []);
  return [on, choose];
}

/** The Idle & asleep shelf: its details list open or not, kept for the next start. */
export const SHELF_KEY = "botling.whiteboardShelf";
export function useShelfOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(SHELF_KEY) === "1"; } catch { return false; } });
  const choose = useCallback((next: boolean) => {
    setOpen(next);
    try { localStorage.setItem(SHELF_KEY, next ? "1" : "0"); } catch { /* no storage: this session only */ }
  }, []);
  return [open, choose];
}

/** When the bot last did something: its chat's newest line or its newest task change (ms; null: never). */
export function lastActive(bot: BotView, data: WhiteboardBotView | undefined): number | null {
  const times = [bot.lastActivity, ...(data?.tasks ?? []).map((task) => task.updatedAt)].map((iso) => (iso ? Date.parse(iso) : NaN)).filter((at) => !Number.isNaN(at));
  return times.length ? Math.max(...times) : null;
}

/** What waits on you from one bot: its open questions or its memory's "Waiting on you" (as the right panel lists them). */
export const waitingFor = (bot: BotView, waiting: WaitingView): WaitingItemView[] => waiting.items.filter((item) => item.botId === bot.id);

/** Its tool approvals waiting: the bot's count, or more when the board's details (a moment newer) name more. */
const approvalCount = (bot: BotView, data: WhiteboardBotView | undefined) => Math.max(bot.approvals, data?.approvals?.length ?? 0);

/** How many things wait on you from the bot: those questions, its tasks waiting on you, its tool approvals. */
export function waitingCount(bot: BotView, waiting: WaitingView, data: WhiteboardBotView | undefined): number {
  return waitingFor(bot, waiting).length + (data?.tasks.filter((task) => task.state === "waiting" && task.name.trim()).length ?? 0) + approvalCount(bot, data);
}

export type AskKind = "question" | "call" | "approval";
/** One row of what waits on you, as the Waiting lane lists it. `open`: the chat that answers it; `count`: how many things the row stands for (approvals with no details share one row). */
export interface Ask { key: string; kind: AskKind; text: string; code: string | null; at: string | null; open: string; count: number }

/** How many things the rows stand for (what the pill, the lane and the number say). */
export const askCount = (asks: Ask[]) => asks.reduce((sum, ask) => sum + ask.count, 0);

/**
 * Every thing waiting on you from the bot, oldest first (the same as the report's "Your call" and
 * `waitingCount`): its open questions (a memory "Waiting on you" line is your call), its tasks
 * waiting on you, its tool approvals with what they would run (a count when the core gives none).
 */
export function waitingAsks(bot: BotView, waiting: WaitingView, data: WhiteboardBotView | undefined): Ask[] {
  const out: Ask[] = [];
  for (const item of waitingFor(bot, waiting)) {
    out.push({ key: `q:${item.messageId ?? item.text}`, kind: item.messageId ? "question" : "call", text: item.text, code: null, at: item.at ?? null, open: item.groupId ?? item.botId, count: 1 });
  }
  for (const task of named(data?.tasks ?? []).filter((candidate) => candidate.state === "waiting")) {
    const why = task.blocked ?? task.now;
    out.push({ key: `t:${task.id}`, kind: "call", text: why ? `${task.name} · ${why}` : task.name, code: null,
      at: task.history?.findLast((event) => event.kind === "waiting")?.at ?? task.updatedAt, open: bot.id, count: 1 });
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
export function isRunning(bot: BotView, data: WhiteboardBotView | undefined): boolean {
  return bot.working || bot.subagents > 0 || !!bot.guest || (data?.tasks ?? []).some((task) => task.state === "running" && task.atWork);
}

/** Its state on the board: Running, Ready (awake, nothing to do) or Asleep. */
export function laneStatus(bot: BotView, data: WhiteboardBotView | undefined): { key: string; text: string } {
  if (isRunning(bot, data)) return { key: "working", text: "Running" };
  if (bot.phase !== "asleep") return { key: "awake", text: "Ready" };
  return { key: "asleep", text: "Asleep" };
}

export interface Lanes { waiting: BotView[]; running: BotView[]; quiet: BotView[] }

/**
 * The board's three lanes. Waiting on you: every bot (or group chat) with something for you, most
 * first. Running: bots at work with nothing for you, latest first. The rest (no group chats) on the
 * shelf: pinned first, then the ready ones, then by their last update. Each bot shows once.
 */
export function boardLanes(bots: BotView[], byBot: ReadonlyMap<string, WhiteboardBotView>, waiting: WaitingView, pinned: ReadonlySet<string> = new Set()): Lanes {
  const out: Lanes = { waiting: [], running: [], quiet: [] };
  const counts = new Map<string, number>();
  for (const bot of bots) {
    if (bot.role === "main") continue;
    const data = byBot.get(bot.id);
    const count = bot.role === "group" ? waitingFor(bot, waiting).length : waitingCount(bot, waiting, data);
    counts.set(bot.id, count);
    if (count > 0) out.waiting.push(bot);
    else if (bot.role === "group") continue;
    else if (isRunning(bot, data)) out.running.push(bot);
    else out.quiet.push(bot);
  }
  const recent = (bot: BotView) => lastActive(bot, byBot.get(bot.id)) ?? -Infinity;
  out.waiting.sort((a, b) => counts.get(b.id)! - counts.get(a.id)!);
  out.running.sort((a, b) => recent(b) - recent(a));
  const rank = (bot: BotView) => (pinned.has(bot.id) ? 0 : bot.phase !== "asleep" ? 1 : 2);
  out.quiet.sort((a, b) => rank(a) - rank(b) || recent(b) - recent(a));
  return out;
}

/** Where the open work is: bots with something waiting on you or under way, most waiting first. */
export function openRanking(bots: BotView[], byBot: ReadonlyMap<string, WhiteboardBotView>, waiting: WaitingView): { bot: BotView; waiting: number; active: number }[] {
  return bots.filter((bot) => bot.role !== "main")
    .map((bot) => ({ bot, waiting: bot.role === "group" ? waitingFor(bot, waiting).length : waitingCount(bot, waiting, byBot.get(bot.id)), active: taskCounts(byBot.get(bot.id)?.tasks ?? []).active }))
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
export function botWeek(data: WhiteboardBotView | undefined, now: number): number[] {
  if (data?.doneDays) {
    const byDay = new Map(data.doneDays.map((day) => [day.day, day.done]));
    return lastDays(now, 7).map((day) => byDay.get(day.key) ?? 0);
  }
  return doneByDay(data?.tasks ?? [], now).map((day) => day.count);
}

/** The board's "Tasks finished": each of the last seven days across the bots, this week's sum and last week's (null: not known). */
export function boardWeek(entries: (WhiteboardBotView | undefined)[], now: number): { days: { key: string; label: string; count: number; today: boolean }[]; week: number; lastWeek: number | null } {
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
export function quietWeeks(bot: BotView, data: WhiteboardBotView | undefined, now: number): number | null {
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
export function highlight(bot: BotView, data: WhiteboardBotView | undefined, waiting: WaitingView): string | null {
  const task = data ? activeTasks(named(data.tasks)).find((candidate) => candidate.state === "running" && candidate.now?.trim()) : undefined;
  for (const text of [data?.currentStatus[0], data?.inProgress[0], waiting.doing[bot.id], task?.now, bot.job]) {
    const line = shortLine(text);
    if (line) return line;
  }
  return null;
}

/** The card's line: the bot's latest action (✓ done, → now, ? waiting on you), else its short line. */
export function latestLine(bot: BotView, data: WhiteboardBotView | undefined, waiting: WaitingView): { kind: "done" | "now" | "waiting" | null; text: string } | null {
  if (data?.latest?.text.trim()) return { kind: data.latest.kind, text: data.latest.text };
  const line = highlight(bot, data, waiting);
  return line ? { kind: null, text: line } : null;
}

/** The bot in one line for the shelf's tooltip: what the core says (job, status, folder), else its job, else its folder. */
export function description(bot: BotView, data: WhiteboardBotView | undefined): string {
  return data?.description ?? bot.job?.split("\n")[0]?.trim() ?? bot.folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

/** The picture to draw on the card: one with data to show and its component at hand; else none. */
export function drawnPicture(data: WhiteboardBotView | undefined, components: Record<string, ComponentInfoView>): WhiteboardPictureView | null {
  const picture = data?.picture;
  if (!picture || !components[picture.name]) return null;
  if (picture.status === "approve" || picture.status === "failed" || picture.status === "empty") return null;
  return picture.data === "null" ? null : picture;
}

/** At most this many pictures are drawn at once (each is a frame of its own). */
export const MOST_PICTURES = 12;

const named = (tasks: TaskView[]) => tasks.filter((task) => task.name.trim().length > 0);

/** Tasks by state for the bar: waiting on you, under way, finished. */
export function taskCounts(tasks: TaskView[]): { waiting: number; active: number; done: number; total: number } {
  const shown = named(tasks);
  const waiting = shown.filter((task) => task.state === "waiting").length;
  const active = shown.filter((task) => task.state === "running" || task.state === "pending").length;
  const done = shown.filter((task) => task.state === "done" || task.state === "stopped").length;
  return { waiting, active, done, total: waiting + active + done };
}

/** Tasks finished on each of the last seven days, oldest first (by the time the card last changed). */
export function doneByDay(tasks: TaskView[], now: number): { day: string; count: number; today: boolean }[] {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, index) => {
    const from = new Date(start); from.setDate(start.getDate() - (6 - index));
    const to = new Date(from); to.setDate(from.getDate() + 1);
    return { from: from.getTime(), to: to.getTime(), day: index === 6 ? "Today" : from.toLocaleDateString("en-US", { month: "short", day: "numeric" }), today: index === 6 };
  });
  return days.map(({ from, to, day, today }) => ({ day, today, count: named(tasks).filter((task) => task.state === "done" && (() => { const at = Date.parse(task.updatedAt); return at >= from && at < to; })()).length }));
}

/** "Next": the memory's "In progress" lines, then what the tasks under way say comes next (no repeats). */
export function nextSteps(data: WhiteboardBotView): string[] {
  const out: string[] = [];
  for (const line of [...data.inProgress, ...activeTasks(named(data.tasks)).map((task) => task.next ?? "")]) {
    const text = line.trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out.slice(0, 10);
}

function shortTime(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === new Date(now - 86_400_000).toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const shortTimeOf = (at: number | null, now: number) => (at === null ? null : shortTime(new Date(at).toISOString(), now));

/**
 * Asks the core for the board's data now and every few seconds while it is shown. Each ask carries the
 * stamp of the board it has, and the core answers `same` (no bots) while nothing changed: the page then
 * neither compares nor redraws. Hidden windows pause polling and refresh when shown again; slow
 * replies cannot accumulate concurrent requests. A core without stamps is still compared by its text.
 */
function useWhiteboardData(client: Client, refreshMs: number): WhiteboardView | null {
  const [data, setData] = useState<WhiteboardView | null>(null);
  const last = useRef("");
  const stamp = useRef<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      if (!live || document.hidden || pending) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = true;
      void client.request({ type: "whiteboard.view", ...(stamp.current ? { since: stamp.current } : {}) }).then((view) => {
        if (!live || view.same) return;
        stamp.current = view.stamp;
        const text = view.stamp ? `stamp:${view.stamp}` : JSON.stringify(view);
        if (text === last.current) return;
        last.current = text;
        setData(view);
      }, () => {}).finally(() => {
        pending = false;
        if (live && !document.hidden && refreshMs > 0) timer = setTimeout(load, refreshMs);
      });
    };
    const visibility = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (!document.hidden && refreshMs > 0) load();
    };
    document.addEventListener("visibilitychange", visibility);
    load();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [client, refreshMs]);
  return data;
}

export interface WhiteboardProps {
  client: Client;
  bots: BotView[];
  waiting: WaitingView;
  /** The component library (for the bots' pictures). */
  components: Record<string, ComponentInfoView>;
  look: Look;
  now: number;
  /** The main bot's chat lines, for its latest reply on the board. */
  mainMessages: MessageView[];
  mainBotId: string;
  statusOf: (bot: BotView) => { key: string; text: string };
  onOpenChat: (botId: string) => void;
  onError: (failure: unknown) => void;
  /** How often the board asks again (ms); 0: only once (tests). */
  refreshMs?: number;
  /** Bots pinned to the top of the left column: first on the shelf. */
  pinned?: string[];
  /** The app's language, for the board's own words. */
  lang?: Lang | null;
}

/** A tooltip's place and words (the shelf's pills and rows, the ranking, the chart). */
interface Tip { x: number; y: number; content: ReactNode }

export function Whiteboard({ client, bots, waiting, components, look, now, mainMessages, mainBotId, statusOf, onOpenChat, onError, refreshMs = 5_000, pinned, lang }: WhiteboardProps) {
  const data = useWhiteboardData(client, refreshMs);
  const byBot = useMemo(() => new Map((data?.bots ?? []).map((entry) => [entry.botId, entry])), [data]);
  const pins = useMemo(() => new Set(pinned ?? []), [pinned]);
  const lanes = boardLanes(bots, byBot, waiting, pins);
  const [shelfOpen, setShelfOpen] = useShelfOpen();
  const [open, setOpen] = useState<{ botId: string; origin: string } | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const waitingLane = useRef<HTMLElement>(null);
  const openBot = open ? bots.find((bot) => bot.id === open.botId) ?? null : null;
  const cards = bots.filter((bot) => bot.role !== "main" && bot.role !== "group");
  // The first pictures on the Running lane are drawn; past MOST_PICTURES a card shows its line.
  const pictured = new Set(lanes.running.filter((bot) => drawnPicture(byBot.get(bot.id), components)).slice(0, MOST_PICTURES).map((bot) => bot.id));

  const press = (bot: BotView, element: HTMLElement) => {
    // The report grows out of the card: its scale starts at the card's place on the canvas.
    const box = canvas.current?.getBoundingClientRect();
    const at = element.getBoundingClientRect();
    const origin = box ? `${Math.round(at.left - box.left + at.width / 2)}px ${Math.round(at.top - box.top + at.height / 2)}px` : "50% 0";
    setTip(null);
    setOpen({ botId: bot.id, origin });
  };
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);
  const tipFor = (content: ReactNode) => ({
    onPointerEnter: (event: React.PointerEvent) => setTip({ x: event.clientX, y: event.clientY, content }),
    onPointerMove: (event: React.PointerEvent) => setTip((current) => (current ? { ...current, x: event.clientX, y: event.clientY } : current)),
    onPointerLeave: () => setTip(null),
  });
  const face = (bot: BotView) => faceURL(bot, look, { asleep: bot.phase === "asleep" && !bot.working, working: bot.working, waiting: bot.approvals > 0 });

  // Layer A's numbers.
  const asks = new Map(lanes.waiting.map((bot) => [bot.id, waitingAsks(bot, waiting, byBot.get(bot.id))]));
  const askTotal = [...asks.values()].reduce((sum, list) => sum + askCount(list), 0);
  const oldestAsk = Math.min(...[...asks.values()].flat().map((ask) => (ask.at ? Date.parse(ask.at) : NaN)).filter((at) => !Number.isNaN(at)));
  const counts = cards.reduce((sum, bot) => { const each = taskCounts(byBot.get(bot.id)?.tasks ?? []); return { waiting: sum.waiting + each.waiting, active: sum.active + each.active, done: sum.done + each.done, total: sum.total + each.total }; }, { waiting: 0, active: 0, done: 0, total: 0 });
  const waitingBots = cards.filter((bot) => asks.has(bot.id)).length;
  const runningBots = cards.filter((bot) => isRunning(bot, byBot.get(bot.id)));
  const alsoWaiting = runningBots.filter((bot) => asks.has(bot.id)).length;
  const activeBots = cards.filter((bot) => !asks.has(bot.id) && (isRunning(bot, byBot.get(bot.id)) || bot.phase !== "asleep")).length;
  const asleepBots = cards.length - waitingBots - activeBots;
  const ranking = openRanking(bots, byBot, waiting);
  const week = boardWeek(cards.map((bot) => byBot.get(bot.id)), now);

  return (
    <div className="whiteboard" aria-label="Whiteboard">
      <div className="wb-canvas" ref={canvas}>
        <div className="wb-board">
          <div className="wb-board-inner">
            <section className="wb-summary" aria-label="Summary">
              <Metric label="Bots" value={cards.length} sub={<><b>{activeBots}</b> active · {waitingBots} waiting · {asleepBots} asleep</>} />
              <Metric label="Tasks" value={counts.total} sub={<><b>{counts.done}</b> done{counts.total ? ` · ${Math.round((counts.done / counts.total) * 100)}%` : ""}</>} />
              <Metric kind="waiting" label="Waiting on you" value={askTotal} dot="waiting"
                sub={askTotal ? <>from <b>{lanes.waiting.length}</b> bot{lanes.waiting.length === 1 ? "" : "s"}{Number.isFinite(oldestAsk) ? ` · oldest ${ageWords(now - oldestAsk)}` : ""}</> : "Nothing for you"}
                onPress={askTotal ? () => waitingLane.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }) : undefined} />
              <Metric kind="running" label="Running" value={runningBots.length} dot="working"
                sub={<><b>{counts.active}</b> task{counts.active === 1 ? "" : "s"} under way{alsoWaiting ? ` · ${alsoWaiting} also waiting` : ""}</>} />
            </section>

            {cards.length > 0 && (
              <section className="wb-charts" aria-label="Charts">
                <div className="wb-panel">
                  <div className="wb-panel-head"><h3 className="wb-panel-title">At a glance</h3><span className="wb-panel-meta">Updated {shortTime(new Date(now).toISOString(), now)}</span></div>
                  <div className="wb-donuts">
                    <Donut label="tasks" total={counts.total} parts={[{ key: "done", label: "Done", value: counts.done }, { key: "active", label: "Under way", value: counts.active }, { key: "waiting", label: "Waiting", value: counts.waiting }]} />
                    <Donut label="bots" total={cards.length} parts={[{ key: "active", label: "Active", value: activeBots }, { key: "waiting", label: "Waiting", value: waitingBots }, { key: "asleep", label: "Asleep", value: asleepBots }]} />
                  </div>
                </div>
                <div className="wb-panel">
                  <div className="wb-panel-head"><h3 className="wb-panel-title">Where the open work is</h3><span className="wb-panel-meta">Open tasks + asks, by bot</span></div>
                  <OpenRanking rows={ranking} face={face} tipFor={tipFor} onPress={press} />
                  <div className="wb-panel-foot">
                    <span><i className="sw waiting" />Waiting on you</span><span><i className="sw active" />Under way</span>
                    {ranking.length > RANKED && <span>+{ranking.length - RANKED} more</span>}
                  </div>
                </div>
                <div className="wb-panel trend">
                  <div className="wb-panel-head"><h3 className="wb-panel-title">Tasks finished</h3><span className="wb-panel-meta">{weekRange(now)}</span></div>
                  <Trend week={week} tipFor={tipFor} />
                </div>
              </section>
            )}

            {lanes.waiting.length > 0 && (
              <section ref={waitingLane} className="wb-section lane-waiting" aria-label="Waiting on you" id="wb-lane-waiting">
                <h3 className="wb-section-title"><span className="lane-dot" aria-hidden="true" />Waiting on you
                  <span className="wb-section-meta"> · {askTotal} thing{askTotal === 1 ? "" : "s"} from {lanes.waiting.length} bot{lanes.waiting.length === 1 ? "" : "s"} · oldest first</span></h3>
                <div className="lane-grid">
                  {lanes.waiting.map((bot) => (
                    <WaitingCard key={bot.id} bot={bot} data={byBot.get(bot.id)} waiting={waiting} asks={asks.get(bot.id) ?? []} now={now} face={face(bot)}
                      onPress={(element) => (bot.role === "group" ? onOpenChat(bot.id) : press(bot, element))} onOpenChat={onOpenChat} />
                  ))}
                </div>
              </section>
            )}

            {lanes.running.length > 0 && (
              <section className="wb-section lane-running" aria-label="Running">
                <h3 className="wb-section-title"><span className="lane-dot blue" aria-hidden="true" />Running
                  <span className="wb-section-meta"> · {lanes.running.length} bot{lanes.running.length === 1 ? "" : "s"} · {lanes.running.reduce((sum, bot) => sum + taskCounts(byBot.get(bot.id)?.tasks ?? []).active, 0)} tasks under way</span></h3>
                <div className="lane-grid">
                  {lanes.running.map((bot) => (
                    <RunningCard key={bot.id} client={client} bot={bot} data={byBot.get(bot.id)} waiting={waiting} now={now} face={face(bot)} components={components}
                      picture={pictured.has(bot.id) ? drawnPicture(byBot.get(bot.id), components) : null} onPress={(element) => press(bot, element)} />
                  ))}
                </div>
              </section>
            )}

            {lanes.quiet.length > 0 && (
              <QuietShelf bots={lanes.quiet} byBot={byBot} waiting={waiting} now={now} face={face} open={shelfOpen} lang={lang}
                onToggle={() => setShelfOpen(!shelfOpen)} onPress={press} tipFor={tipFor} />
            )}

            <MainSummary bots={bots} look={look} messages={mainMessages} mainBotId={mainBotId} />
            {cards.length === 0 && <div className="wb-empty">No bots yet. Add a project or a bot of your own, and its card shows here.</div>}
          </div>
        </div>
        {open && openBot && (
          <div className="wb-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) setOpen(null); }}>
            <Report client={client} components={components} bot={openBot} data={byBot.get(openBot.id)} waiting={waiting} look={look} now={now} origin={open.origin} status={statusOf(openBot)}
              onAllow={(picture) => void client.request({ type: "whiteboard.allow", botId: openBot.id, command: picture.command!, folder: picture.folder! }).catch(onError)}
              onClose={() => setOpen(null)} onOpenChat={(id) => { setOpen(null); onOpenChat(id); }}
              onOpenResult={(result) => void client.request({ type: "result.open", botId: openBot.id, url: result.url }).catch(onError)} />
          </div>
        )}
      </div>
      {tip && (
        <div className="wb-tip" role="tooltip" style={{ left: Math.max(8, Math.min(tip.x + 12, (typeof window === "undefined" ? 1e4 : window.innerWidth) - 268)), top: tip.y + 16 }}>{tip.content}</div>
      )}
      <WhiteboardComposer client={client} mainBotId={mainBotId} onError={onError} />
    </div>
  );
}

/** "2 days", "3 hours", "20 minutes": how long the oldest thing has waited. */
function ageWords(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  const [n, unit] = minutes < 60 ? [minutes, "minute"] : minutes < 48 * 60 ? [Math.floor(minutes / 60), "hour"] : [Math.floor(minutes / 1440), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function weekRange(now: number): string {
  const from = new Date(now); from.setDate(from.getDate() - 6);
  const day = (date: Date) => date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${day(from)} – ${day(new Date(now))}`;
}

type TipFor = (content: ReactNode) => Record<string, unknown>;

function Metric({ label, value, sub, kind, dot, onPress }: { label: string; value: number; sub: ReactNode; kind?: "waiting" | "running"; dot?: string; onPress?: () => void }) {
  const body = (
    <>
      <span className="wb-metric-l">{dot && <span className="now-dot" data-status={dot} aria-hidden="true" />}{label}</span>
      <span className="wb-metric-n">{value}</span>
      <span className="wb-metric-s">{sub}</span>
      {onPress && <span className="wb-metric-go" aria-hidden="true">Review ↓</span>}
    </>
  );
  const className = `wb-metric${kind ? ` ${kind}` : ""}${kind === "waiting" && value === 0 ? " none" : ""}`;
  return onPress
    ? <button type="button" className={className} data-metric={label} onClick={onPress} aria-label={`${value} waiting on you: review`}>{body}</button>
    : <div className={className} data-metric={label}>{body}</div>;
}

/** A ring of parts (done / under way / waiting; active / waiting / asleep) with the total in it and a legend. */
function Donut({ label, total, parts }: { label: string; total: number; parts: { key: string; label: string; value: number }[] }) {
  const radius = 40;
  const length = 2 * Math.PI * radius;
  const sum = parts.reduce((all, part) => all + part.value, 0);
  let at = 0;
  return (
    <div className="wb-donut" data-donut={label}>
      <svg width="104" height="104" viewBox="0 0 100 100" role="img" aria-label={`${label}: ${parts.map((part) => `${part.label} ${part.value}`).join(", ")}`}>
        <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--chip)" strokeWidth="11" />
        {sum > 0 && parts.filter((part) => part.value > 0).map((part) => {
          const span = (part.value / sum) * length;
          const shown = parts.filter((candidate) => candidate.value > 0).length > 1 ? Math.max(1.5, span - 2.5) : span;
          const arc = <circle key={part.key} className={`arc ${part.key}`} cx="50" cy="50" r={radius} fill="none" strokeWidth="11" strokeDasharray={`${shown} ${length - shown}`} strokeDashoffset={-at} transform="rotate(-90 50 50)" />;
          at += span;
          return arc;
        })}
        <text x="50" y="50" textAnchor="middle" fontSize="19" fontWeight="600" fill="var(--text)" className="wb-donut-n">{total}</text>
        <text x="50" y="64" textAnchor="middle" fontSize="9.5" fill="var(--faint)">{label}</text>
      </svg>
      <ul className="wb-legend">
        {parts.map((part) => <li key={part.key}><span className={`sw ${part.key}`} />{part.label}<span className="v">{part.value}</span></li>)}
      </ul>
    </div>
  );
}

const RANKED = 6;

/** Where the open work is: a stacked bar per bot (waiting on you, under way), the most first. */
function OpenRanking({ rows, face, tipFor, onPress }: { rows: ReturnType<typeof openRanking>; face: (bot: BotView) => string; tipFor: TipFor; onPress: (bot: BotView, element: HTMLElement) => void }) {
  const top = rows.slice(0, RANKED);
  const peak = Math.max(1, ...top.map((row) => row.waiting + row.active));
  if (!top.length) return <p className="wb-panel-empty">Nothing open right now.</p>;
  return (
    <ul className="wb-rank">
      {top.map(({ bot, waiting, active }) => (
        <li key={bot.id} data-bot={bot.id} onClick={(event) => onPress(bot, event.currentTarget)}
          {...tipFor(<><span className="tt">{bot.name}</span><br /><span className="ts">{waiting} waiting on you · {active} under way</span></>)}>
          <span className="wb-rank-name"><img src={face(bot)} alt="" />{bot.name}</span>
          <span className="wb-rank-track" aria-hidden="true">
            {waiting > 0 && <span className="fill-waiting" style={{ width: `${(waiting / peak) * 100}%` }} />}
            {active > 0 && <span className="fill-active" style={{ width: `${(active / peak) * 100}%` }} />}
          </span>
          <span className="wb-rank-v" aria-label={`${waiting} waiting on you, ${active} under way`}>{waiting > 0 && <><b>{waiting}</b> · </>}{active}</span>
        </li>
      ))}
    </ul>
  );
}

/** Tasks finished on each of the last seven days across the bots, this week's sum and the change from last week. */
function Trend({ week, tipFor }: { week: ReturnType<typeof boardWeek>; tipFor: TipFor }) {
  const peak = Math.max(1, ...week.days.map((day) => day.count));
  const change = week.lastWeek ? Math.round(((week.week - week.lastWeek) / week.lastWeek) * 100) : null;
  return (
    <div className="wb-trend">
      <div className="wb-trend-big">
        <b>{week.week}</b>
        <span>this week{week.lastWeek !== null && <> · {change !== null ? <span className={change >= 0 ? "up" : "down"}>{change >= 0 ? "↑" : "↓"} {Math.abs(change)}%</span> : null}{change !== null ? " vs" : ""} last week ({week.lastWeek})</>}</span>
      </div>
      <svg viewBox="0 0 700 80" preserveAspectRatio="none" role="img" aria-label={`Tasks finished per day: ${week.days.map((day) => `${day.label} ${day.count}`).join(", ")}`}>
        {week.days.map((day, index) => {
          const height = day.count ? Math.max(6, (day.count / peak) * 64) : 2;
          return (
            <g key={day.key}>
              <rect x={index * 100 + 18} y={80 - height} width="64" height={height} rx="4" className={day.today ? "today" : day.count ? "bar" : "empty"} />
              <rect className="hit" x={index * 100} y="0" width="100" height="80" {...tipFor(<><span className="tt">{day.label}</span><br /><span className="ts">{day.count} task{day.count === 1 ? "" : "s"} finished</span></>)} />
            </g>
          );
        })}
      </svg>
      <div className="wb-chart-days vals">{week.days.map((day) => <span key={day.key} className={day.today ? "today" : ""}>{day.count}</span>)}</div>
      <div className="wb-chart-days">{week.days.map((day) => <span key={day.key} className={day.today ? "today" : ""}>{day.label}</span>)}</div>
    </div>
  );
}

const MARK = { done: "✓", now: "→", waiting: "?" } as const;

/** The card's latest action line (one line or two). */
function Latest({ bot, data, waiting, one }: { bot: BotView; data: WhiteboardBotView | undefined; waiting: WaitingView; one?: boolean }) {
  const line = latestLine(bot, data, waiting);
  if (!line) return <span className={`wb-latest none${one ? " one" : ""}`}><span className="txt">Nothing written yet</span></span>;
  return (
    <span className={`wb-latest${one ? " one" : ""}`} data-kind={line.kind ?? "line"}>
      {line.kind && <span className={`mark ${line.kind}`} aria-hidden="true">{MARK[line.kind]}</span>}
      <span className="txt">{line.text}</span>
    </span>
  );
}

const KIND_LABEL: Record<AskKind, string> = { question: "Question", call: "Your call", approval: "Approval" };
const KIND_BUTTON: Record<AskKind, string> = { question: "Answer", call: "Decide", approval: "Review" };
/** A card lists at most this many asks; the rest are counted. */
const MOST_ASKS = 4;

/** A bot with something waiting on you: each item with its kind, age and a button to answer it in its chat. */
function WaitingCard({ bot, data, waiting, asks, now, face, onPress, onOpenChat }: {
  bot: BotView; data: WhiteboardBotView | undefined; waiting: WaitingView; asks: Ask[]; now: number; face: string;
  onPress: (element: HTMLElement) => void; onOpenChat: (botId: string) => void;
}) {
  const counts = taskCounts(data?.tasks ?? []);
  const status = bot.role === "group" ? { key: "", text: `${bot.members?.length ?? 0} bots` } : laneStatus(bot, data);
  const when = shortTime(bot.lastActivity, now);
  return (
    <article className="wb-card ask-card waiting" data-bot={bot.id} aria-label={`${bot.name}: ${askCount(asks)} waiting on you`}>
      <button type="button" className="wb-card-head wb-card-open" onClick={(event) => onPress(event.currentTarget)} title={bot.role === "group" ? `Open ${bot.name}` : `${bot.name}'s report`}>
        <img className="wb-face" src={face} alt="" />
        <span className="wb-card-name">{bot.name}</span>
        <span className="wb-pill">{askCount(asks)} waiting</span>
        <span className="wb-status"><span className="now-dot" data-status={status.key} aria-hidden="true" />{status.text}</span>
        {when && <span className="wb-card-time">{when}</span>}
      </button>
      <ul className="wb-asks">
        {asks.slice(0, MOST_ASKS).map((ask) => {
          const age = ageLabel(ask.at, now);
          return (
            <li key={ask.key} className={`wb-ask ${ask.kind}`} data-kind={ask.kind}>
              <span className="wb-ask-kind">{KIND_LABEL[ask.kind]}</span>
              {age && <span className="wb-ask-age">{age === "now" ? "just now" : `${age} ago`}</span>}
              <span className="wb-ask-text">{ask.code !== null ? <>{ask.text === "Bash" ? "Allow " : `Allow ${ask.text}: `}<code>{ask.code}</code></> : ask.text}</span>
              <button type="button" className="wb-ask-open" onClick={() => onOpenChat(ask.open)}>{KIND_BUTTON[ask.kind]}</button>
            </li>
          );
        })}
        {asks.length > MOST_ASKS && <li className="wb-ask-more">+{askCount(asks.slice(MOST_ASKS))} more in the report</li>}
      </ul>
      {bot.role !== "group" && (
        <span className="wb-card-foot">
          <Latest bot={bot} data={data} waiting={waiting} one />
          {counts.total > 0 && <span className="wb-foot-count"><b>{counts.done}</b>/{counts.total}</span>}
        </span>
      )}
      {counts.total > 0 && <StateBar counts={counts} />}
    </article>
  );
}

/** A bot at work: its latest action, what comes next, its tasks under way and one bar. */
function RunningCard({ client, bot, data, waiting, now, face, picture, components, onPress }: {
  client: Client; bot: BotView; data: WhiteboardBotView | undefined; waiting: WaitingView; now: number; face: string;
  picture: WhiteboardPictureView | null; components: Record<string, ComponentInfoView>; onPress: (element: HTMLElement) => void;
}) {
  const counts = taskCounts(data?.tasks ?? []);
  const next = data ? nextSteps(data)[0] : undefined;
  const when = shortTime(bot.lastActivity, now);
  const line = latestLine(bot, data, waiting);
  return (
    <button type="button" className={`wb-card run-card${picture ? ` pictured${picture.size === "2x1" ? " wide" : ""}` : ""}`} data-bot={bot.id} onClick={(event) => onPress(event.currentTarget)}
      aria-label={[`${bot.name}'s report`, "Running", line?.text].filter(Boolean).join(", ")}>
      <span className="wb-card-head">
        <img className="wb-face" src={face} alt="" />
        <span className="wb-card-name">{bot.name}</span>
        {when && <span className="wb-card-time">{when}</span>}
      </span>
      {picture && <PictureFrame client={client} picture={picture} info={components[picture.name]!} size={picture.size} title={`${bot.name}'s picture`} />}
      <Latest bot={bot} data={data} waiting={waiting} one />
      <span className="wb-next">{next ? `Next · ${next}` : ""}</span>
      <span className="wb-card-foot">
        <span className="wb-status"><span className="now-dot" data-status="working" aria-hidden="true" />{counts.active > 0 ? `${counts.active} under way` : "Running"}</span>
        {counts.total > 0 && <span className="wb-foot-count"><b>{counts.done}</b>/{counts.total} done</span>}
      </span>
      {counts.total > 0 && <StateBar counts={counts} />}
    </button>
  );
}

/** Tasks done on each of the last seven days, as a tiny bar chart. */
function Spark({ values, width, height }: { values: number[]; width: number; height: number }) {
  const peak = Math.max(1, ...values);
  const bar = 4;
  const gap = (width - bar * values.length) / Math.max(1, values.length - 1);
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {values.map((value, index) => {
        const tall = value ? Math.max(3, (value / peak) * height) : 2;
        return <rect key={index} x={(index * (bar + gap)).toFixed(1)} y={height - tall} width={bar} height={tall} rx="1" className={value ? (index === values.length - 1 ? "today" : "") : "zero"} />;
      })}
    </svg>
  );
}

/** Idle & asleep: a dimmed pill per bot; "Show details" opens a list instead (kept per user). */
function QuietShelf({ bots, byBot, waiting, now, face, open, lang, onToggle, onPress, tipFor }: {
  bots: BotView[]; byBot: ReadonlyMap<string, WhiteboardBotView>; waiting: WaitingView; now: number; face: (bot: BotView) => string; open: boolean; lang?: Lang | null;
  onToggle: () => void; onPress: (bot: BotView, element: HTMLElement) => void; tipFor: TipFor;
}) {
  const today = new Date(now).toDateString();
  const todayCount = bots.filter((bot) => { const at = lastActive(bot, byBot.get(bot.id)); return at !== null && new Date(at).toDateString() === today; }).length;
  const tip = (bot: BotView) => {
    const data = byBot.get(bot.id);
    const line = latestLine(bot, data, waiting);
    const about = description(bot, data);
    return <><span className="tt">{bot.name}</span> <span className="ts">· {bot.phase === "asleep" ? "Asleep" : "Ready"}</span>{about && <><br />{about}</>}
      {line && <><br /><span className="ts">{line.kind ? `${MARK[line.kind]} ` : ""}{line.text}</span></>}</>;
  };
  return (
    <section className={`wb-section lane-quiet${open ? " open" : ""}`} aria-label="Idle and asleep">
      <h3 className="wb-section-title">Idle &amp; asleep<span className="wb-section-meta"> · {bots.length} bot{bots.length === 1 ? "" : "s"}{todayCount ? ` · ${todayCount} today` : ""}</span>
        <button type="button" className="wb-section-act wb-shelf-toggle" aria-expanded={open} onClick={onToggle}>
          {say(lang, open ? "whiteboard.showLess" : "whiteboard.showDetails")}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={open ? "M2 6.5l3-3 3 3" : "M2 3.5l3 3 3-3"} /></svg>
        </button>
      </h3>
      {open ? (
        <div className="quiet-list" role="table" aria-label="Idle and asleep bots">
          <div className="quiet-row quiet-head" role="row"><span /><span>Bot</span><span className="a">Latest</span><span className="w">Tasks</span><span>Last 7 days</span><span className="t">Updated</span></div>
          {bots.map((bot) => {
            const data = byBot.get(bot.id);
            const counts = taskCounts(data?.tasks ?? []);
            const line = latestLine(bot, data, waiting);
            return (
              <div key={bot.id} role="row" tabIndex={0} className={`quiet-row${bot.phase !== "asleep" ? " ready" : ""}`} data-bot={bot.id}
                onClick={(event) => onPress(bot, event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter") onPress(bot, event.currentTarget); }} {...tipFor(tip(bot))}>
                <img src={face(bot)} alt="" />
                <span className="n">{bot.name}</span>
                <span className="a">{line ? `${line.kind ? `${MARK[line.kind]} ` : ""}${line.text}` : ""}</span>
                <span className="w">{counts.total ? `${counts.done}/${counts.total}` : "—"}</span>
                <Spark values={botWeek(data, now)} width={52} height={14} />
                <span className="t">{shortTimeOf(lastActive(bot, data), now)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="quiet-pills">
          {bots.map((bot) => {
            const data = byBot.get(bot.id);
            const weeks = quietWeeks(bot, data, now);
            const when = shortTimeOf(lastActive(bot, data), now);
            return (
              <button key={bot.id} type="button" className={`quiet-pill${bot.phase !== "asleep" ? " ready" : ""}`} data-bot={bot.id}
                aria-label={`${bot.name}, ${bot.phase === "asleep" ? "asleep" : "ready"}${when ? `, updated ${when}` : ""}: ${description(bot, data)}`}
                onClick={(event) => onPress(bot, event.currentTarget)} {...tipFor(tip(bot))}>
                <img src={face(bot)} alt="" /><span className="name">{bot.name}</span>
                <Spark values={botWeek(data, now)} width={30} height={12} />
                {when && <span className="when">{when}</span>}
                {weeks !== null && <span className="stale">· {weeks} wk quiet</span>}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** The bar along a card's foot: its tasks waiting on you, under way and finished. */
function StateBar({ counts }: { counts: ReturnType<typeof taskCounts> }) {
  const part = (count: number) => `${counts.total ? (count / counts.total) * 100 : 0}%`;
  return (
    <span className="wb-statebar" aria-hidden="true">
      {counts.waiting > 0 && <span className="waiting" style={{ width: part(counts.waiting) }} />}
      {counts.active > 0 && <span className="active" style={{ width: part(counts.active) }} />}
      {counts.done > 0 && <span className="done" style={{ width: part(counts.done) }} />}
    </span>
  );
}

/**
 * A bot's picture: its component as a Board tile (`componentPage`, surface "board", filling the
 * frame, read only), in a sandboxed frame main serves the page to (`card.page`). The chat page's
 * component broker is not here, so what the component posts (answers, saves) goes nowhere.
 */
function PictureFrame({ client, picture, info, size, title }: { client: Client; picture: WhiteboardPictureView; info: ComponentInfoView; size: string; title: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const images = JSON.stringify(picture.images ?? {});
  useEffect(() => {
    let live = true;
    void import("../../../Web/src/components").then(({ componentPage }) => {
      const page = componentPage(info.template, picture.data, JSON.parse(images) as Record<string, string>, size as `${number}x${number}`, "board", true, false);
      return client.request({ type: "card.page", html: page });
    }).then((result) => { if (live) setUrl(result.url); }, () => {});
    return () => { live = false; };
  }, [client, info.template, picture.data, images, size]);
  return (
    <span className={`wb-picture wb-picture-${size}`} aria-hidden={url ? undefined : true}>
      {url && <iframe className="wb-picture-frame" sandbox="allow-scripts" src={url} title={title} tabIndex={-1} />}
    </span>
  );
}

/** The main bot's latest reply (to what you asked in the board's input), at the board's end. */
function MainSummary({ bots, look, messages, mainBotId }: { bots: BotView[]; look: Look; messages: MessageView[]; mainBotId: string }) {
  const main = bots.find((bot) => bot.id === mainBotId);
  const reply = messages.findLast((message) => message.role === "bot" && message.text.trim());
  if (!main || !reply) return null;
  return (
    <section className="wb-main" aria-label="Main bot summary">
      <span className="wb-main-head"><img className="wb-face" src={faceURL(main, look, {})} alt="" />{main.name} · latest reply</span>
      <span className="wb-main-reply">{shortLine(reply.text, 2 * CARD_LINE_WIDTH)}</span>
    </section>
  );
}

const SECTIONS = [["sum", "Summary"], ["ask", "Your call"], ["made", "Results"], ["trend", "Progress"], ["log", "What I did"], ["decided", "My calls"], ["next", "Next"]] as const;
type ReportSection = (typeof SECTIONS)[number][0];

function Report({ client, components, bot, data, waiting, look, now, origin, status, onClose, onOpenChat, onOpenResult, onAllow }: {
  client: Client; components: Record<string, ComponentInfoView>;
  bot: BotView; data: WhiteboardBotView | undefined; waiting: WaitingView; look: Look; now: number; origin: string; status: { key: string; text: string };
  onClose: () => void; onOpenChat: (botId: string) => void; onOpenResult: (result: ResultView) => void; onAllow: (picture: WhiteboardPictureView) => void;
}) {
  const picture = drawnPicture(data, components);
  // Its picture's command waits for your OK: what would run where, and Allow.
  const asking = data?.picture?.status === "approve" && data.picture.command && data.picture.folder ? data.picture : null;
  const body = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const tasks = named(data?.tasks ?? []);
  const counts = taskCounts(tasks);
  const asks = waitingAsks(bot, waiting, data);
  const waitingTotal = askCount(asks);
  const done = finishedTasks(tasks, 12);
  const days = boardWeek([data], now).days.map(({ label, count, today }) => ({ day: label, count, today }));
  const peak = Math.max(1, ...days.map((day) => day.count));
  const next = data ? nextSteps(data) : [];
  const status0 = data?.currentStatus ?? [];
  const has: Record<ReportSection, boolean> = {
    sum: status0.length > 0 || counts.total > 0 || asks.length > 0 || !!picture || !!asking,
    ask: waitingTotal > 0,
    made: (data?.results.length ?? 0) > 0,
    trend: days.some((day) => day.count > 0),
    log: done.length > 0,
    decided: (data?.decided.length ?? 0) > 0,
    next: next.length > 0,
  };
  const shown = SECTIONS.filter(([id]) => has[id]);
  const [current, setCurrent] = useState<ReportSection | null>(shown[0]?.[0] ?? null);
  useLayoutEffect(() => { article.current?.focus({ preventScroll: true }); }, []);
  const jump = (id: ReportSection) => {
    setCurrent(id);
    const target = body.current?.querySelector<HTMLElement>(`[data-part="${id}"]`);
    if (target && body.current) body.current.scrollTop = target.offsetTop - body.current.offsetTop;
  };
  const when = shortTime(bot.lastActivity, now);
  return (
    <article ref={article} tabIndex={-1} className="wb-report" data-bot={bot.id} style={{ transformOrigin: origin }} aria-label={`${bot.name}'s report`}>
      <header className="wb-report-head">
        <div className="wb-report-top">
          <img className="wb-report-face" src={faceURL(bot, look, { asleep: bot.phase === "asleep" && !bot.working, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
          <span className="wb-report-title">
            <span className="wb-report-name">{bot.name}'s report</span>
            <span className="wb-report-sub"><span className="now-dot" data-status={status.key} aria-hidden="true" />{status.text}{when ? ` · ${when}` : ""}</span>
          </span>
          <button type="button" className="wb-report-chat" onClick={() => onOpenChat(bot.id)}>Open chat</button>
          <button type="button" className="wb-report-close" aria-label="Shrink back to the board" title="Back to the board (Esc)" onClick={onClose}><Icon name="xmark" size={13} /></button>
        </div>
        {shown.length > 1 && (
          <nav className="wb-toc" aria-label="Parts of the report">
            {shown.map(([id, label]) => (
              <button key={id} type="button" className={`wb-toc-chip${current === id ? " on" : ""}`} onClick={() => jump(id)}>
                {id === "ask" ? `${label} ${waitingTotal}` : label}
              </button>
            ))}
          </nav>
        )}
      </header>
      <div className="wb-report-body" ref={body}>
        {shown.length === 0 && <p className="wb-report-empty">{bot.name} has not written a status, tasks or results yet.</p>}
        {has.sum && (
          <section data-part="sum" className="wb-part">
            {picture && <PictureFrame client={client} picture={picture} info={components[picture.name]!} size="2x2" title={`${bot.name}'s picture`} />}
            {asking && (
              <div className="wb-picture-ask">
                <span className="wb-ask-text">Its picture comes from <code>{asking.command}</code>, run in {asking.folder}. It runs once you allow it.</span>
                <button type="button" className="wb-ask-open" onClick={() => onAllow(asking)}>Allow and run</button>
              </div>
            )}
            {status0.map((line, index) => <p key={index} className="wb-sum-line">{line}</p>)}
            <div className="wb-stats">
              <span className="wb-stat"><span className="wb-stat-n done">{counts.done}</span><span className="wb-stat-l">done</span></span>
              <span className="wb-stat"><span className="wb-stat-n active">{counts.active}</span><span className="wb-stat-l">under way</span></span>
              <span className="wb-stat"><span className="wb-stat-n waiting">{waitingTotal}</span><span className="wb-stat-l">waiting on you</span></span>
            </div>
          </section>
        )}
        {has.ask && (
          <section data-part="ask" className="wb-part">
            <h4 className="wb-part-title ask">Your call</h4>
            {asks.map((ask) => {
              const age = ageLabel(ask.at, now);
              return (
                <div key={ask.key} className={`wb-ask ${ask.kind}`} data-kind={ask.kind}>
                  <span className="wb-ask-kind">{KIND_LABEL[ask.kind]}</span>
                  {age && <span className="wb-ask-age">{age === "now" ? "just now" : `${age} ago`}</span>}
                  <span className="wb-ask-text">{ask.code !== null ? <>{ask.text === "Bash" ? "Allow " : `Allow ${ask.text}: `}<code>{ask.code}</code></> : ask.text}</span>
                  <button type="button" className="wb-ask-open" onClick={() => onOpenChat(ask.open)}>{KIND_BUTTON[ask.kind]}</button>
                </div>
              );
            })}
          </section>
        )}
        {has.made && (
          <section data-part="made" className="wb-part">
            <h4 className="wb-part-title made">What got made</h4>
            <div className="wb-results">
              {data!.results.map((result) => (
                <button key={`${result.label}\u0000${result.url}`} type="button" className="wb-result" title={result.url} onClick={() => onOpenResult(result)}>
                  <span className="wb-result-label">{result.label}</span><Icon name="arrowUpRight" size={12} />
                </button>
              ))}
            </div>
          </section>
        )}
        {has.trend && (
          <section data-part="trend" className="wb-part">
            <h4 className="wb-part-title">Tasks finished this week</h4>
            <div className="wb-chart">
              <svg width="100%" height="96" viewBox="0 0 700 96" preserveAspectRatio="none" role="img"
                aria-label={`Tasks finished per day: ${days.map((day) => `${day.day} ${day.count}`).join(", ")}`}>
                {days.map((day, index) => {
                  const height = day.count ? Math.max(6, (day.count / peak) * 86) : 2;
                  return <rect key={day.day} x={index * 100 + 15} y={92 - height} width="70" height={height} rx="4" className={day.today ? "today" : day.count ? "bar" : "empty"} />;
                })}
              </svg>
              <div className="wb-chart-days">{days.map((day) => <span key={day.day}>{day.day}{day.count ? ` · ${day.count}` : ""}</span>)}</div>
            </div>
          </section>
        )}
        {has.log && (
          <section data-part="log" className="wb-part">
            <h4 className="wb-part-title">What I did (newest first)</h4>
            {done.map((task) => (
              <span key={task.id} className="wb-log" data-task={task.id}>
                <span className="wb-log-when">{shortTime(task.updatedAt, now)}</span>
                <span className="wb-log-text">{task.state === "stopped" ? `${task.name} (stopped)` : task.name}</span>
              </span>
            ))}
          </section>
        )}
        {has.decided && (
          <section data-part="decided" className="wb-part">
            <h4 className="wb-part-title">Calls I made myself</h4>
            {data!.decided.map((line, index) => <span key={index} className="wb-line">{line}</span>)}
          </section>
        )}
        {has.next && (
          <section data-part="next" className="wb-part">
            <h4 className="wb-part-title">Next</h4>
            {next.map((line, index) => <span key={index} className="wb-line">{index + 1}. {line}</span>)}
          </section>
        )}
      </div>
    </article>
  );
}

/** The board's input: a message to the main bot ("how is everyone doing?"); its reply shows in the main bot's corner. */
function WhiteboardComposer({ client, mainBotId, onError }: { client: Client; mainBotId: string; onError: (failure: unknown) => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    void client.request({ type: "chat.send", botId: mainBotId, text: message }).then(() => setText(""), onError).finally(() => setSending(false));
  };
  return (
    <form className="wb-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
      <div className="wb-composer-box">
        <textarea className="wb-composer-input" rows={1} value={text} placeholder="Ask how everyone's doing…" aria-label="Message to the main bot"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
        <button type="submit" className="wb-composer-send" aria-label="Send" disabled={!text.trim() || sending}>↑</button>
      </div>
    </form>
  );
}
