// Work a bot's turn left running in the background (1.x's BackgroundTask.swift): a Bash call with
// `run_in_background`, an Agent call that was not told to wait, a Monitor. Kept in the reply of the
// turn that started it (chat.json's `backgroundTasks`, 1.x's format), so it shows how it ended even
// after the turn, or the app, is long gone, and so the bot can be told at its next wake what went
// away with its process before it reported (`interruptedNote`).
//
// Session-local scheduled work uses the same persisted format and interruption lifecycle as 1.x.
import { holdsScheduleAwake, isScheduled } from "./session-schedules";
import type { ChatRecord } from "./store/records";
import { fromSwiftDate, toSwiftDate } from "./store/records";
import { chipStatus } from "./worker-core/status";
import type { WorkerLedgerRecord } from "./worker-core/ledger";

export type BackgroundKind = "command" | "agent" | "monitor" | "wakeup" | "cron";
export type BackgroundStatus = "running" | "completed" | "failed" | "killed" | "stopped" | "interrupted";

/** One task, as 1.x writes it in chat.json (dates are Swift dates). */
export interface BackgroundTask {
  /** The tool call that started it. */
  id: string;
  kind: BackgroundKind;
  title: string;
  status: BackgroundStatus;
  startedAt: number;
  endedAt?: number;
  outputFile?: string;
  summary?: string;
  /** What it was started with (the command; the agent's task), shortened. */
  detail?: string;
  /** Cut off (stopped or interrupted), and its bot has been told so. */
  told?: boolean;
  fireAt?: number;
  schedule?: string;
  recurring?: boolean;
  jobID?: string;
  /** The subagent that started it (absent: the bot itself). */
  owner?: { id: string; label: string };
  [key: string]: unknown;
}

/** Running for longer than this, with no word, it no longer keeps its bot awake (1.x: 6 hours). */
const HOLDS_BOT_AWAKE_MS = 6 * 3600_000;

const ENDS: Record<string, "completed" | "failed" | "killed"> = {
  completed: "completed", done: "completed", failed: "failed", error: "failed",
  killed: "killed", stopped: "killed", cancelled: "killed", canceled: "killed",
};

/** 1.x's `TraceBook.shorten`: a summary kept short. */
function shorten(text: string, limit = 4_000): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** A task to keep: `detail` is shortened as 1.x does (600 characters). */
export function backgroundTask(id: string, kind: BackgroundKind, title: string, detail: string | undefined, now = toSwiftDate()): BackgroundTask {
  const task: BackgroundTask = { id, kind, title, status: "running", startedAt: now };
  if (detail) task.detail = detail.length > 600 ? `${detail.slice(0, 600)}…` : detail;
  return task;
}

const tasksOf = (record: ChatRecord): BackgroundTask[] | null =>
  Array.isArray(record.backgroundTasks) ? (record.backgroundTasks as BackgroundTask[]) : null;

/** `BackgroundTask.end`: how a `task_notification` says it ended; a watch that timed out or was stopped did its job. */
export function endTask(task: BackgroundTask, status: string, summary: string | null, now = toSwiftDate()) {
  task.status = ENDS[status.toLowerCase()] ?? "killed";
  if (task.kind === "monitor" && task.status === "killed") task.status = "completed";
  task.endedAt = now;
  if (task.kind === "monitor" && task.monitor && typeof task.monitor === "object" && "callback" in task.monitor && task.monitor.callback === "unknown") {
    // A native watch ended; its task notification is not a callback-consumption receipt.
    task.monitor = { ...task.monitor, execution: "ended" };
  }
  if (summary) task.summary = shorten(summary);
}

/** A background task reported back: the chip of the reply it belongs to says how it ended. The record changed, or null. */
export function endBackgroundTask(records: ChatRecord[], id: string, status: string, summary: string | null, now = toSwiftDate()): ChatRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const tasks = tasksOf(records[i]!);
    const task = tasks?.find((candidate) => candidate.id === id);
    if (!task) continue;
    if (task.status !== "running") return null;
    endTask(task, status, summary, now);
    return records[i]!;
  }
  return null;
}

/**
 * A worker's chip as its ledger record says (worker-core status.ts `chipStatus`), whatever it said before: unlike
 * `endBackgroundTask`, no first-writer-wins. `summary` null keeps the one it has. The record changed, or null.
 */
export function projectBackgroundTask(records: ChatRecord[], id: string, worker: Pick<WorkerLedgerRecord, "status" | "report" | "cleanup" | "adapter">, summary: string | null, now = toSwiftDate()): ChatRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const task = tasksOf(records[i]!)?.find((candidate) => candidate.id === id);
    if (!task) continue;
    const status = chipStatus(worker);
    const shorter = summary ? shorten(summary) : task.summary;
    if (task.status === status && task.summary === shorter) return null;
    task.status = status;
    if (status === "running") delete task.endedAt;
    else task.endedAt ??= now;
    if (shorter) task.summary = shorter;
    return records[i]!;
  }
  return null;
}

/**
 * The process that ran them went away (`stopped`), or the app quit while they ran (`interrupted`, seen
 * at the next launch): whatever had not reported never will. The records that changed.
 */
export function stopBackgroundTasks(records: ChatRecord[], status: "stopped" | "interrupted", now = toSwiftDate()): ChatRecord[] {
  const changed: ChatRecord[] = [];
  for (const record of records) {
    const tasks = tasksOf(record);
    if (!tasks?.some((task) => task.status === "running")) continue;
    for (const task of tasks) if (task.status === "running") { task.status = status; task.endedAt = now; }
    changed.push(record);
  }
  return changed;
}

/** Background work still going that its bot started not too long ago (sleeping would end it). */
export function hasBackgroundWorkRunning(records: ChatRecord[], now = Date.now()): boolean {
  return records.some((record) => tasksOf(record)?.some((task) => task.status === "running" && (isScheduled(task) ? holdsScheduleAwake(task, now) : now - fromSwiftDate(task.startedAt) < HOLDS_BOT_AWAKE_MS)));
}

const twoDigits = (value: number) => String(value).padStart(2, "0");

/** 1.x's `.dateTime.month(.twoDigits).day(.twoDigits).hour(.twoDigits).minute(.twoDigits)`: "10/26, 13:05". */
function started(swiftDate: number): string {
  const date = new Date(fromSwiftDate(swiftDate));
  return `${twoDigits(date.getMonth() + 1)}/${twoDigits(date.getDate())}, ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

/**
 * 1.x's `Bot.interruptedNote`: background work the bot started that went away before it reported (the
 * app quit, its process ended), for its wake-up: what it was, so it can start it again. Null when none.
 */
export function interruptedNote(records: ChatRecord[]): string | null {
  const tasks = records.flatMap((record) => tasksOf(record) ?? []).filter((task) => (task.status === "stopped" || task.status === "interrupted") && task.told !== true);
  if (!tasks.length) return null;
  const lines = tasks.map((task) => {
    const kind = task.kind === "command" ? "background command" : task.kind === "agent" ? "background subagent" : task.kind === "monitor" ? "Monitor"
      : task.kind === "wakeup" ? "scheduled wake-up (ScheduleWakeup)" : `cron job (CronCreate ${task.schedule ?? ""})`;
    const why = task.status === "interrupted" ? "killed when the app restarted" : "stopped when your previous session ended";
    let line = `- ${kind} "${task.title}" (started ${started(task.startedAt)}, ${why})`;
    if (task.detail) line += `: ${task.detail.replaceAll("\n", " ")}`;
    return line;
  });
  return "(App: This background work of yours never finished: it went away with its process before it reported. Nothing of it is running now. Start again whatever still needs doing; leave out what no longer matters.)\n" + lines.join("\n");
}

/** Marks every cut-off task as told (1.x's `markCutOffTasksTold`). The records that changed. */
export function markCutOffTasksTold(records: ChatRecord[]): ChatRecord[] {
  const changed: ChatRecord[] = [];
  for (const record of records) {
    const tasks = tasksOf(record);
    if (!tasks?.some((task) => (task.status === "stopped" || task.status === "interrupted") && task.told !== true)) continue;
    for (const task of tasks) if (task.status === "stopped" || task.status === "interrupted") task.told = true;
    changed.push(record);
  }
  return changed;
}
