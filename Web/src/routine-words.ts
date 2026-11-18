// How a routine is put into words, one way for every place that shows one: the Routines panel (builtin-plugins/botling.routines),
// the sub bot menu (desktop/src/renderer/sub-bot-nav.ts) and the background-work row's tooltip (tasks.ts keeps its own, localized
// copy of the cron words; Web/test/routine-words.test.ts holds the two together in English). English only, pure, no DOM.
// Times are the viewer's own; the zone a routine was set in is named beside them, never converted away.

/** What these words need of a routine (a `RoutineView` of the contract, a `RoutineRow` of the plugin api). */
export interface RoutineLike {
  kind: "once" | "recurring" | "legacy";
  schedule: string;
  cron?: string | null;
  timezone: string;
  /** pending, due, paused, fired, cancelled, delivery_uncertain; enabled/paused for routines.cron. */
  status: string;
  next: string | null;
  /** When it last ran (ISO-8601) and how that went: "sent" is handed to the bot, which says nothing of how its work went. */
  lastRun?: string | null;
  lastResult?: "sent" | "ok" | "failed" | null;
  watch?: { command: string; state: "never" | "ok" | "failing"; lastRun: string | null; exit: number | null; timedOut: boolean };
}

/** Where a routine sits in a list: needs a look first, then what will run, what is paused, what is over. */
export type Group = "attention" | "active" | "paused" | "done";

/** The dot and word a status gets; `tone` picks its colour. */
export type Tone = "ok" | "due" | "off" | "done" | "warn" | "bad";
export interface Standing { word: string; tone: Tone }

export function groupOf(routine: RoutineLike): Group {
  if (routine.status === "delivery_uncertain" || routine.watch?.state === "failing") return "attention";
  if (routine.status === "paused") return "paused";
  if (routine.status === "fired" || routine.status === "cancelled") return "done";
  return "active";
}

export function standing(routine: RoutineLike): Standing {
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
export function kindOf(routine: RoutineLike): "once" | "repeat" | "watch" {
  return routine.watch ? "watch" : routine.kind === "once" ? "once" : "repeat";
}

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
export function zoneName(routine: Pick<RoutineLike, "timezone">): string | null {
  if (routine.timezone === "system_local" || !routine.timezone) return null;
  return routine.timezone.split("/").pop()!.replace(/_/g, " ");
}

/** A cron field's values (a star, "5", "1-5", "1,3", a star with a step), or null when it is not one. */
function values(field: string, low: number, high: number): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) return null;
    const from = match[1] === undefined ? low : Number(match[1]);
    const to = match[1] === undefined ? high : match[2] === undefined ? (match[3] === undefined ? from : high) : Number(match[2]);
    const step = match[3] === undefined ? 1 : Number(match[3]);
    if (step < 1 || from < low || to > high || from > to) return null;
    for (let value = from; value <= to; value += step) out.add(value);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Five cron fields in words, the same words the chat page's background-work row uses in English (Web/src/tasks.ts describeCron):
 * "Every 30 min", "Hourly at :07", "Daily 09:00", "Weekdays 09:00", "Every Mon, Thu 18:30", "10/22 09:00"; the fields themselves otherwise.
 */
export function cronWords(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const step = (field: string) => /^\*\/(\d+)$/.exec(field)?.[1];
  const allDays = dom === "*" && month === "*" && dow === "*";
  if (minute === "*" && hour === "*" && allDays) return "Every minute";
  if (step(minute) && hour === "*" && allDays) return `Every ${step(minute)} min`;
  const minutes = values(minute, 0, 59);
  const hours = values(hour, 0, 23);
  if (!minutes || !hours || values(dom, 1, 31) === null || values(month, 1, 12) === null || values(dow, 0, 7) === null) return cron;
  if (minutes.length !== 1) return cron;
  if (hour === "*" && allDays) return `Hourly at :${pad(minutes[0]!)}`;
  if (step(hour) && allDays) return `Every ${step(hour)} h`;
  if (hours.length !== 1) return cron;
  const at = `${pad(hours[0]!)}:${pad(minutes[0]!)}`;
  if (dom === "*" && month === "*") {
    if (dow === "*") return `Daily ${at}`;
    if (dow === "1-5") return `Weekdays ${at}`;
    if (dow === "0,6" || dow === "6,0" || dow === "6-7") return `Weekends ${at}`;
    const days = [...new Set(values(dow, 0, 7)!.map((value) => value % 7))].sort((a, b) => a - b);
    return `Every ${days.map((value) => DAYS[value]).join(", ")} ${at}`;
  }
  const dates = values(dom, 1, 31)!;
  const months = values(month, 1, 12)!;
  if (dates.length === 1 && months.length === 1 && dow === "*") return `${months[0]}/${dates[0]} ${at}`;
  if (dates.length === 1 && month === "*" && dow === "*") return `Monthly on day ${dates[0]} ${at}`;
  return cron;
}

/** How often it runs, in words; a one-time routine is "One time". The cron fields win over the app's own phrase, so every place says it alike. */
export function cadence(routine: Pick<RoutineLike, "kind" | "schedule" | "cron">): string {
  if (routine.kind === "once") return "One time";
  const cron = routine.cron && routine.cron !== "@once" ? routine.cron : /^[\d*/,-]+(\s+[\d*/,-]+){4}$/.test(routine.schedule.trim()) ? routine.schedule : null;
  return cron ? cronWords(cron) : routine.schedule;
}

/** The next run, as a "Tomorrow 08:15" and a "in 21 h"; null when it will not run (paused, over). */
export function nextRun(routine: Pick<RoutineLike, "next">, now: number): { at: string; away: string } | null {
  const at = routine.next ? Date.parse(routine.next) : NaN;
  if (!Number.isFinite(at)) return null;
  return { at: clock(at, now), away: distance(at, now) };
}

/** What a one-time routine did, for a finished list: when it was set to run. */
export function onceTime(routine: Pick<RoutineLike, "schedule">, now: number): string | null {
  const at = Date.parse(routine.schedule);
  return Number.isFinite(at) ? clock(at, now) : null;
}

/** A watch's last run: how it went and when ("Last run failed · exit 3 · 4 min ago"); "Not run yet" before the first. */
export function watchResult(routine: Pick<RoutineLike, "watch">, now: number): { word: string; detail: string; tone: Tone } | null {
  const watch = routine.watch;
  if (!watch) return null;
  const ago = watch.lastRun && Number.isFinite(Date.parse(watch.lastRun)) ? distance(Date.parse(watch.lastRun), now) : null;
  if (watch.state === "never") return { word: "Not run yet", detail: "", tone: "off" };
  if (watch.state === "ok") return { word: "Last run OK", detail: ago ?? "", tone: "ok" };
  const why = watch.timedOut ? "timed out" : watch.exit === null ? "did not finish" : watch.exit === 0 ? "alert" : `exit ${watch.exit}`;
  return { word: "Last run failed", detail: [why, ago].filter(Boolean).join(" · "), tone: "bad" };
}

/**
 * The last-result line every routine has: a watch's own run, or the time the bot was last handed the task ("sent" says it was
 * handed over, never that the work went well). Null while a send is unconfirmed (its own note says so).
 */
export function lastLine(routine: RoutineLike, now: number): { word: string; detail: string; tone: Tone } | null {
  if (routine.watch) return watchResult(routine, now);
  if (routine.status === "delivery_uncertain") return null;
  const at = routine.lastRun ? Date.parse(routine.lastRun) : NaN;
  if (!Number.isFinite(at)) return { word: "Not run yet", detail: "", tone: "off" };
  const ago = distance(at, now);
  return routine.lastResult === "failed" ? { word: "Last run failed", detail: ago, tone: "bad" } : { word: routine.lastResult === "ok" ? "Last run OK" : "Last run sent to the bot", detail: ago, tone: routine.lastResult === "ok" ? "ok" : "done" };
}
