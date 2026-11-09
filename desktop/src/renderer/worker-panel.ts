// Navigation v5's workers badge, its menu and a watched worker's "Ask <owner>", as pure functions: which rows are workers, Running → Today → Earlier,
// the room's owner family (the room expanded, its parent and sibling sub bots folded), the badge's four looks,
// the log's "Files changed" and the words "Ask <owner>" sends to the owner bot. All from the rows the bots
// already carry (`subagentRows`: subagents.json, the worker ledger, Codex worker records); nothing is stored.
import type { BotView, StepView, SubagentRowView, SubagentView } from "../contract";

export const EARLIER_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

/** A bot's workers: its rows without the sub bot rows (a sub bot is a room of its own, not a worker). */
export function workerRowsOf(bot: Pick<BotView, "subagentRows">): SubagentRowView[] {
  return bot.subagentRows.filter((row) => !row.subBot);
}

/** Local midnight before `now`. */
export function startOfDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

type Timed = Pick<SubagentRowView, "status" | "startedAt" | "endedAt">;
const ended = (row: Timed) => row.endedAt ?? row.startedAt;

export function sectionedWorkers<T extends Timed>(rows: T[], now: number): { running: T[]; today: T[]; earlier: T[] } {
  const midnight = startOfDay(now), cutoff = now - EARLIER_DAYS * DAY_MS;
  const running = rows.filter((row) => row.status === "running").sort((a, b) => b.startedAt - a.startedAt);
  const done = rows.filter((row) => row.status !== "running").sort((a, b) => ended(b) - ended(a));
  return {
    running,
    today: done.filter((row) => ended(row) >= midnight),
    earlier: done.filter((row) => ended(row) < midnight && ended(row) >= cutoff),
  };
}

/** The room's owners: the room itself, then (folded) its parent and sibling sub bots, or its own sub bots. */
export function workerFamily(bot: BotView, bots: BotView[]): { room: BotView; others: BotView[] } {
  const rootId = bot.parent ?? bot.id;
  const root = bots.find((candidate) => candidate.id === rootId);
  const subs = bots.filter((candidate) => candidate.parent === rootId && candidate.id !== bot.id);
  return { room: bot, others: [...(root && root.id !== bot.id ? [root] : []), ...subs] };
}

export type Tone = "running" | "failed" | "today";

/** A folded owner's line ("1 running", "1 failed", "3 today"); empty when it had no worker running or today. */
export function ownerSummary(rows: Timed[], now: number): { text: string; tone: Tone }[] {
  const { running, today } = sectionedWorkers(rows, now);
  const failed = today.filter((row) => row.status === "failed").length;
  const rest = today.length - failed;
  return [
    ...(running.length ? [{ text: `${running.length} running`, tone: "running" as const }] : []),
    ...(failed ? [{ text: `${failed} failed`, tone: "failed" as const }] : []),
    ...(rest ? [{ text: `${rest} today`, tone: "today" as const }] : []),
  ];
}

/** The worker shown in the main area (the chat's place), when the watched subagent is one of the shown bot's workers. */
export function watchedWorker(bot: Pick<BotView, "subagentRows"> | null, watched: Pick<SubagentView, "id"> | null): SubagentRowView | null {
  if (!bot || !watched) return null;
  return workerRowsOf(bot).find((row) => row.id === watched.id) ?? null;
}

/**
 * The workers menu after the shown chat or watched subagent changes: closed, unless ⌘⇧W asked for it on the way
 * (a watched worker going back to its owner's chat with the menu open), and only for the chat now shown.
 */
export function workersMenuAfterMove(pending: string | null, shown: string | undefined): string | null {
  return pending !== null && pending === shown ? pending : null;
}

export interface Badge { tone: Tone; count: string; extra: string | null; tip: string }

/**
 * The "<owner>'s workers" badge: hidden with no worker today; an unseen failure first ("1 failed · 2 running"),
 * else running ("2 running"), else greyed "5 today". It counts the room's own workers only.
 */
export function workersBadge(rows: (Timed & Pick<SubagentRowView, "id">)[], now: number, seen: ReadonlySet<string>): Badge | null {
  const { running, today } = sectionedWorkers(rows, now);
  if (!running.length && !today.length) return null;
  const failed = today.filter((row) => row.status === "failed");
  const unseen = failed.filter((row) => !seen.has(row.id)).length;
  const done = today.length - failed.length;
  const tip = [running.length ? `${running.length} running` : "", done ? `${done} done today` : "", failed.length ? `${failed.length} failed` : ""].filter(Boolean).join(" · ");
  if (unseen) return { tone: "failed", count: `${unseen} failed`, extra: running.length ? `${running.length} running` : null, tip };
  if (running.length) return { tone: "running", count: `${running.length} running`, extra: null, tip };
  return { tone: "today", count: `${today.length} today`, extra: null, tip };
}

const FILE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** The files a worker edited or wrote (its Edit/Write steps' paths; a Codex file change lists one per line), once each. */
export function filesChanged(steps: StepView[]): string[] {
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.kind !== "tool" || step.failed || !step.tool || !FILE_EDIT_TOOLS.has(step.tool) || !step.detail) continue;
    for (const line of step.detail.split("\n")) if (line.trim()) seen.add(line.trim());
  }
  return [...seen];
}

/** A path short enough for the panel: its last three parts. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join("/") : path;
}

/** What "Ask <owner>" sends to the owner bot as your message: the worker named, so the owner knows which one. */
export function askOwnerText(worker: { title: string; id: string; agentId?: string }, question: string): string {
  const ids = worker.agentId ? `${worker.id}, agent ${worker.agentId}` : worker.id;
  return `About your worker "${worker.title}" (${ids}): ${question.trim()}`;
}

const SEEN_KEY = "botling.seenFailedWorkers";

/** Failed workers whose log you opened (this browser only: the badge stops shouting about them). */
export function readSeenFailed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch { return new Set(); }
}

export function writeSeenFailed(seen: ReadonlySet<string>): void {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200))); } catch { /* storage refused: seen only until reload */ }
}

/** "4m", "2h", or the clock time for an ended worker. */
export function elapsed(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export type AskWorker = { id: string; title: string; agentId?: string };

/**
 * "Ask <owner>" puts this in the owner's input box as a reference, in the chat page's reply bar (who / preview / ×):
 * the words you then send go to the owner wrapped by `askOwnerText`, never to the worker.
 */
export function askReference(worker: AskWorker, ownerName: string): { id: string; who: string; preview: string } {
  return { id: `worker:${worker.id}`, who: `About ${worker.title}`, preview: `${ownerName}’s worker · your words go to ${ownerName}, not the worker` };
}

/** Whether "Ask <owner>" can go, and the line above the button that says what happens. */
export function askState(owner: Pick<BotView, "name" | "working"> | null, name = owner?.name ?? "Its owner"): { ok: boolean; note: string } {
  if (!owner) return { ok: false, note: `${name} is gone, so nobody can pass this on.` };
  if (owner.working) return { ok: true, note: `${owner.name} is mid-turn. It reads your note at its next step.` };
  return { ok: true, note: `Workers take instructions only from ${owner.name}.` };
}
