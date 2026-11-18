// What the Routines panel says about a routine: its kind, its schedule in words, when it runs next, how it stands, and how a
// watch's last run went. Times are the viewer's own (the zone a routine was set in is shown beside it, never converted away).
import type { RoutineRow } from "../../../../Web/host/src/api";

export type Operation = "pause" | "resume" | "cancel";

/** Where a routine sits in the list: needs a look first, then what will run, what is paused, what is over. */
export type Group = "attention" | "active" | "paused" | "done";
export const GROUPS: readonly Group[] = ["attention", "active", "paused", "done"];
export const GROUP_LABEL: Record<Group, string> = { attention: "Needs a look", active: "Running", paused: "Paused", done: "Finished" };

/** The dot and word a status gets; `tone` picks its colour in the stylesheet. */
export type Tone = "ok" | "due" | "off" | "done" | "warn" | "bad";
export interface Standing { word: string; tone: Tone }

export function groupOf(routine: RoutineRow): Group {
  if (routine.status === "delivery_uncertain" || routine.watch?.state === "failing") return "attention";
  if (routine.status === "paused") return "paused";
  if (routine.status === "fired" || routine.status === "cancelled") return "done";
  return "active";
}

export function standing(routine: RoutineRow): Standing {
  switch (routine.status) {
    case "pending": case "enabled": return routine.watch?.state === "failing" ? { word: "Failing", tone: "bad" } : { word: routine.watch ? "Watching" : "Scheduled", tone: "ok" };
    case "due": return { word: "Due now", tone: "due" };
    case "paused": return { word: "Paused", tone: "off" };
    case "fired": return { word: "Ran", tone: "done" };
    case "cancelled": return { word: "Cancelled", tone: "done" };
    case "delivery_uncertain": return { word: "Not confirmed", tone: "warn" };
    default: return { word: routine.status.replace(/_/g, " "), tone: "off" };
  }
}

/** The kind to draw: a watch is its own thing (it runs a command and wakes the bot only when that fails). */
export function kindOf(routine: RoutineRow): "once" | "repeat" | "watch" {
  return routine.watch ? "watch" : routine.kind === "once" ? "once" : "repeat";
}
export const KIND_LABEL = { once: "Once", repeat: "Repeats", watch: "Watch" } as const;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (value: number) => String(value).padStart(2, "0");
const day = (time: Date) => new Date(time.getFullYear(), time.getMonth(), time.getDate()).getTime();

/** "Today 14:30", "Tomorrow 09:00", "Thu 10:30" within the week, "Yesterday 08:15", else "Nov 25, 09:00". */
export function clock(at: number, now: number): string {
  const when = new Date(at);
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const days = Math.round((day(when) - day(new Date(now))) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${DAYS[when.getDay()]} ${time}`;
  return `${MONTHS[when.getMonth()]} ${when.getDate()}${when.getFullYear() === new Date(now).getFullYear() ? "" : `, ${when.getFullYear()}`}, ${time}`;
}

/** "in 21 h", "in 6 min", "4 min ago", "just now": how far a time is from now. */
export function distance(at: number, now: number): string {
  const gap = at - now;
  const span = Math.abs(gap);
  if (span < 45_000) return gap >= 0 ? "in a moment" : "just now";
  const text = span < 3_600_000 ? `${Math.round(span / 60_000)} min` : span < 86_400_000 * 2 ? `${Math.round(span / 3_600_000)} h` : `${Math.round(span / 86_400_000)} d`;
  return gap >= 0 ? `in ${text}` : `${text} ago`;
}

/** A zone that is not the system's, shortened to its city ("Asia/Taipei" -> "Taipei"); null for the system's. */
export function zoneName(routine: RoutineRow): string | null {
  if (routine.timezone === "system_local" || !routine.timezone) return null;
  return routine.timezone.split("/").pop()!.replace(/_/g, " ");
}

const EVERY = (count: number, unit: string) => (count === 1 ? `Every ${unit}` : unit === "min" ? `Every ${count} min` : `Every ${count} ${unit}s`);

/** Five cron fields in words for the common shapes (a step of ten minutes -> "Every 10 min"); the fields themselves otherwise. */
export function cronWords(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const step = (field: string) => /^\*\/(\d+)$/.exec(field)?.[1];
  const whole = (field: string) => /^\d+$/.test(field);
  const at = whole(hour) && whole(minute) ? `${pad(Number(hour))}:${pad(Number(minute))}` : null;
  if (dom === "*" && month === "*" && dow === "*") {
    if (minute === "*" && hour === "*") return "Every minute";
    if (step(minute) && hour === "*") return EVERY(Number(step(minute)), "min");
    if (whole(minute) && hour === "*") return minute === "0" ? "Every hour" : `Every hour at :${pad(Number(minute))}`;
    if (whole(minute) && step(hour)) return `${EVERY(Number(step(hour)), "hour")} at :${pad(Number(minute))}`;
    if (at) return `Every day ${at}`;
  }
  if (at && dom === "*" && month === "*") {
    if (dow === "1-5") return `Every weekday ${at}`;
    if (dow === "0,6" || dow === "6,0") return `Every weekend ${at}`;
    if (/^[0-7]$/.test(dow)) return `Every ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][Number(dow)]} ${at}`;
  }
  if (at && month === "*" && dow === "*" && whole(dom)) return `Monthly on day ${dom}, ${at}`;
  return cron;
}

/** How often it runs, in words: the app's own phrase ("Every weekday 08:15"), or a cron line spelled out. */
export function cadence(routine: RoutineRow): string {
  if (routine.kind === "once") return "One time";
  const looksLikeCron = /^[\d*/,-]+(\s+[\d*/,-]+){4}$/.test(routine.schedule.trim());
  return looksLikeCron ? cronWords(routine.schedule) : routine.schedule;
}

/** The next run, as a "Tomorrow 08:15" and a "in 21 h"; null when it will not run (paused, over). */
export function nextRun(routine: RoutineRow, now: number): { at: string; away: string } | null {
  const at = routine.next ? Date.parse(routine.next) : NaN;
  if (!Number.isFinite(at)) return null;
  return { at: clock(at, now), away: distance(at, now) };
}

/** What a one-time routine did, for the Finished list: when it was set to run. */
export function onceTime(routine: RoutineRow, now: number): string | null {
  const at = Date.parse(routine.schedule);
  return Number.isFinite(at) ? clock(at, now) : null;
}

/** A watch's last run: how it went and when ("Last run failed · exit 3 · 4 min ago"); "Not run yet" before the first. */
export function watchResult(routine: RoutineRow, now: number): { word: string; detail: string; tone: Tone } | null {
  const watch = routine.watch;
  if (!watch) return null;
  const ago = watch.lastRun && Number.isFinite(Date.parse(watch.lastRun)) ? distance(Date.parse(watch.lastRun), now) : null;
  if (watch.state === "never") return { word: "Not run yet", detail: "", tone: "off" };
  if (watch.state === "ok") return { word: "Last run OK", detail: ago ?? "", tone: "ok" };
  const why = watch.timedOut ? "timed out" : watch.exit === null ? "did not finish" : watch.exit === 0 ? "alert" : `exit ${watch.exit}`;
  return { word: "Last run failed", detail: [why, ago].filter(Boolean).join(" · "), tone: "bad" };
}

/** The buttons a routine in this state has. */
export function operationsFor(status: string): Operation[] {
  const out: Operation[] = [];
  if (status === "pending" || status === "enabled" || status === "due") out.push("pause");
  if (status === "paused") out.push("resume");
  if (status !== "fired" && status !== "cancelled" && status !== "delivery_uncertain") out.push("cancel");
  return out;
}
export const LABEL: Record<Operation, string> = { pause: "Pause", resume: "Resume", cancel: "Cancel" };

/** The one-line summary above the list ("5 running · 1 paused · 1 needs a look"). */
export function summary(routines: readonly RoutineRow[]): string {
  const count: Record<Group, number> = { attention: 0, active: 0, paused: 0, done: 0 };
  for (const routine of routines) count[groupOf(routine)] += 1;
  return [
    count.active && `${count.active} running`,
    count.paused && `${count.paused} paused`,
    count.attention && `${count.attention} need${count.attention === 1 ? "s" : ""} a look`,
    count.done && `${count.done} finished`,
  ].filter(Boolean).join(" · ");
}
