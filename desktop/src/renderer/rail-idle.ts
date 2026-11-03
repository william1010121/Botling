// The left column's Idle group, the two numbers on a bot row and the rows of a bot's status card: the pure part
// (App.tsx and Rail.tsx draw it). Only the user sends a bot to Idle (settings `idleBots`); nothing goes there by itself.
import { listedRows, MAINTAINER_BOT_ID, type BotView, type SubagentRowView, type WaitingView } from "../contract";

/** The main bot, Maintainer and sub bots (never a row of the column) cannot be sent to Idle. */
export function canIdle(bot: Pick<BotView, "id" | "role" | "parent">): boolean {
  return bot.role !== "main" && bot.id !== MAINTAINER_BOT_ID && !bot.parent;
}

/** The column split in two: its rows without the idle bots (railOrder, section heads recomputed), and the idle bots in the order sent. */
export function railSplit(bots: BotView[], pinned: string[], idle: string[]): { rows: ReturnType<typeof railOrder>; idle: BotView[] } {
  const away = idle.map((id) => bots.find((bot) => bot.id === id && canIdle(bot))).filter((bot): bot is BotView => !!bot);
  const kept = bots.filter((bot) => !away.includes(bot));
  return { rows: railOrder(kept, pinned.filter((id) => !away.some((bot) => bot.id === id))), idle: away };
}

/** The idle list after the clock (`away` true: send it) or the back arrow (false: restore it). */
export function idleList(idle: string[], botId: string, away: boolean): string[] {
  const rest = idle.filter((id) => id !== botId);
  return away ? [...rest, botId] : rest;
}

/** A bot's sub bots, theirs too (a sub bot of a sub bot), at most 8 deep. */
function descendants(botId: string, bots: BotView[], depth = 0): BotView[] {
  if (depth > 8) return [];
  return bots.filter((bot) => bot.parent === botId && bot.id !== botId).flatMap((sub) => [sub, ...descendants(sub.id, bots, depth + 1)]);
}

/** What waits on you from this one bot alone: its tool approvals and its open questions / "Waiting on you" lines. */
function ownNeeds(bot: BotView, waiting: WaitingView): number {
  return bot.approvals + waiting.items.filter((item) => item.botId === bot.id).length;
}

/**
 * A bot row's two numbers: blue, its unread lines (none while its chat is on screen); orange, what needs your decision
 * (approvals, questions, waiting items), its sub bots' included.
 */
export function botCounts(bot: BotView, bots: BotView[], waiting: WaitingView, shown: boolean): { unread: number; needsYou: number } {
  const needsYou = [bot, ...descendants(bot.id, bots)].reduce((sum, one) => sum + ownNeeds(one, waiting), 0);
  return { unread: shown ? 0 : bot.unread, needsYou };
}

/** The Idle row: how many bots it holds, and the orange number of all of theirs, so nothing waiting is missed. */
export function idleCounts(idle: BotView[], bots: BotView[], waiting: WaitingView): { bots: number; needsYou: number } {
  return { bots: idle.length, needsYou: idle.reduce((sum, bot) => sum + botCounts(bot, bots, waiting, true).needsYou, 0) };
}

export type PeekSubBot = {
  bot: BotView;
  /** waiting: it needs you (orange); running: it or one of its subagents is at work (blue); done: neither (grey). */
  state: "running" | "waiting" | "done";
  /** One line of what it is doing (what it waits for, when it waits). */
  doing: string;
  /** Since it was made (its row's start), or null when that is not known. */
  elapsedMs: number | null;
  /** Its own subagents, as the column listed them (running, or ended in the last 10 minutes; not settled). */
  agents: SubagentRowView[];
  /** Its row in the owner's list (for its "⋯"), if any. */
  row: SubagentRowView | null;
};

/** A bot's status card: one row per sub bot (theirs nested under them follow, as the bots list has them) and its own direct subagents. */
export function peekCard(bot: BotView, bots: BotView[], waiting: WaitingView, now: number): { subBots: PeekSubBot[]; agents: SubagentRowView[] } {
  const subBots = descendants(bot.id, bots).map((sub): PeekSubBot => {
    const owner = bots.find((candidate) => candidate.id === sub.parent) ?? bot;
    const row = owner.subagentRows.find((candidate) => candidate.subBot === sub.id) ?? null;
    const agents = listedRows(sub.subagentRows, now, null).filter((agent) => !agent.subBot);
    const asks = waiting.items.filter((item) => item.botId === sub.id);
    const needs = sub.approvals + asks.length;
    const state = needs > 0 ? "waiting" : sub.working || agents.some((agent) => agent.status === "running") ? "running" : "done";
    const doing = state === "waiting"
      ? asks[0]?.text ?? `${sub.approvals} approval${sub.approvals === 1 ? "" : "s"} waiting`
      : waiting.doing[sub.id] ?? sub.job ?? "";
    const elapsedMs = row && row.startedAt > 0 ? Math.max(0, (row.endedAt ?? now) - row.startedAt) : null;
    return { bot: sub, state, doing, elapsedMs, agents, row };
  });
  return { subBots, agents: listedRows(bot.subagentRows, now, null).filter((agent) => !agent.subBot) };
}

/** "38m", "2h 5m", "3d": an elapsed time as the card shows it. */
export function elapsedText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The left column's rows (1.x's RailView): the main bot and Maintainer, then the pinned ones in the order
 * they were pinned, then the rest — projects and bots together — the one with the newest line
 * first, as in Messages (`entries`, `RailLayout.pinnedFirst`).
 */
export function railOrder(all: BotView[], pinned: string[]): { bot: BotView; section: "main" | "pinned" | "rest" | null }[] {
  // A sub bot is not a row of the column: it is listed under its project bot (its status card) and opens from there.
  const bots = all.filter((bot) => !bot.parent);
  const main = bots.filter((bot) => bot.role === "main" || bot.id === MAINTAINER_BOT_ID).sort((a, b) => (a.role === "main" ? -1 : b.role === "main" ? 1 : 0));
  const top = pinned.map((id) => bots.find((bot) => bot.id === id && bot.role !== "main" && bot.id !== MAINTAINER_BOT_ID)).filter((bot): bot is BotView => !!bot);
  const when = (bot: BotView) => (bot.lastActivity ? Date.parse(bot.lastActivity) : -Infinity);
  const rest = bots.map((bot, offset) => ({ bot, offset }))
    .filter(({ bot }) => bot.role !== "main" && bot.id !== MAINTAINER_BOT_ID && !pinned.includes(bot.id))
    .sort((a, b) => when(b.bot) - when(a.bot) || a.offset - b.offset).map(({ bot }) => bot);
  return [
    ...main.map((bot) => ({ bot, section: null })),
    ...top.map((bot, index) => ({ bot, section: index === 0 ? "pinned" as const : null })),
    ...rest.map((bot, index) => ({ bot, section: index === 0 ? "rest" as const : null })),
  ];
}
