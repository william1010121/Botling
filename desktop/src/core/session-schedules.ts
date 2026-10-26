// Claude's session-local schedules, ported from ScheduleCall/Result, TraceBook and BackgroundTask.
// These describe CLI-owned clocks; the app must never dispatch another copy of their work.
import { backgroundTask, type BackgroundTask } from "./background-tasks";
import { CronSchedule } from "./routines";
import { fromSwiftDate, toSwiftDate } from "./store/records";

export interface ScheduleCall { kind: "wakeup" | "cron"; title: string; prompt: string; cron?: string; recurring: boolean }
export interface ScheduleResult { fireAt?: number; jobID?: string; stopped: boolean }
export type ScheduleCancellation = { kind: "cron"; jobID: string } | { kind: "wakeup" };
const DAY = 24 * 3600_000;
const GRACE = 15 * 60_000;

export function scheduleCall(tool: string, input: Record<string, unknown>): ScheduleCall | null {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const line = prompt.split(/[\r\n]/).find(Boolean) ?? prompt;
  const short = line.length > 60 ? line.slice(0, 60) + "…" : line;
  if (tool === "ScheduleWakeup" && input.stop !== true) {
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    return { kind: "wakeup", title: reason || short, prompt, recurring: true };
  }
  if (tool === "CronCreate" && typeof input.cron === "string") {
    return { kind: "cron", title: short, prompt, cron: input.cron, recurring: typeof input.recurring === "boolean" ? input.recurring : true };
  }
  return null;
}

/** Only structured success results certify a schedule; never parse the model-facing words. */
export function scheduleResult(value: unknown): ScheduleResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const millis = typeof object.scheduledFor === "number" ? object.scheduledFor : object.nextFireAt;
  const fireAt = typeof millis === "number" && Number.isFinite(millis) && millis > 0 ? millis : undefined;
  const jobID = typeof object.id === "string" && object.id ? object.id : undefined;
  const stopped = object.stopped === true;
  return fireAt !== undefined || jobID || stopped || "scheduledFor" in object ? { fireAt, jobID, stopped } : null;
}

export function scheduledTask(id: string, call: ScheduleCall, result: ScheduleResult, now = Date.now()): BackgroundTask | null {
  const task = backgroundTask(id, call.kind, call.title, call.prompt, toSwiftDate(now));
  if (call.kind === "wakeup") {
    if (result.stopped || result.fireAt === undefined) return null;
    task.fireAt = toSwiftDate(result.fireAt);
  } else {
    if (!result.jobID) return null;
    task.jobID = result.jobID;
    task.schedule = call.cron;
    task.recurring = call.recurring;
    const fire = result.fireAt ?? (call.cron ? CronSchedule.parse(call.cron)?.nextTime(now, null) : null);
    if (fire != null) task.fireAt = toSwiftDate(fire);
  }
  return task;
}

export function scheduleCancellation(tool: string, result: ScheduleResult): ScheduleCancellation | null {
  if (tool === "CronDelete" && result.jobID) return { kind: "cron", jobID: result.jobID };
  return tool === "ScheduleWakeup" && result.stopped ? { kind: "wakeup" } : null;
}
export function matchesCancellation(task: BackgroundTask, cancellation: ScheduleCancellation): boolean {
  return task.status === "running" && task.kind === cancellation.kind && (cancellation.kind === "wakeup" || task.jobID === cancellation.jobID);
}

export const isScheduled = (task: BackgroundTask) => task.kind === "wakeup" || task.kind === "cron";
export function holdsScheduleAwake(task: BackgroundTask, now: number): boolean {
  if (task.status !== "running") return false;
  const started = fromSwiftDate(task.startedAt);
  if (task.kind === "wakeup") return now < fromSwiftDate(task.fireAt ?? task.startedAt) + GRACE;
  if (task.kind === "cron" && task.recurring === false && task.fireAt !== undefined) return now < fromSwiftDate(task.fireAt) + GRACE;
  return task.kind === "cron" && now - started < 7 * DAY;
}
export function scheduleDue(task: BackgroundTask): number | null {
  if (task.status !== "running") return null;
  if (task.kind === "wakeup") return fromSwiftDate(task.fireAt ?? task.startedAt);
  if (task.kind !== "cron") return null;
  return task.recurring === false ? task.fireAt === undefined ? null : fromSwiftDate(task.fireAt) : fromSwiftDate(task.startedAt) + 7 * DAY;
}
/** Called on agent activity, as in 1.x: a due one-shot fired when Claude is at work again. */
export function settleSchedules(tasks: BackgroundTask[], now: number): boolean {
  let changed = false;
  for (const task of tasks) {
    const due = scheduleDue(task);
    if (due === null || due > now) continue;
    const recurring = task.kind === "cron" && task.recurring !== false;
    task.status = "completed";
    task.endedAt = toSwiftDate(recurring ? due : Math.max(due, fromSwiftDate(task.startedAt)));
    task.summary = recurring ? "Expired (claude ends a recurring job after 7 days)." : "Fired.";
    changed = true;
  }
  return changed;
}
