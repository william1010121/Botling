// Routines, ported from the Swift app's Routines.swift and ScheduledRoutines.swift:
//
// - `routines.cron` in the bot's working folder: one job per line in crontab format
//   ("15 8 * * * Daily summary: …"), which the bot edits itself; a leading # pauses a job. They run
//   in the system's local time. A job is due when its latest time today has passed and it has not
//   run since (bot.json `routineRuns`, 1.x's key); a job seen for the first time starts from now.
// - `scheduled-routines.json` beside it: app-owned schedules (Codex's `app_routines` tool and the
//   app's own UI): once (`at`, an instant) or recurring (`cron` in an IANA time zone). Each change is
//   a short locked read/modify/atomic-write transaction (durable/atomic.ts, as Phase 0's removed JobStore);
//   persistence precedes dispatch: a job is written `claimed` before it is handed to the bot and
//   `fired`/`pending` after, so a crash in between leaves it `claimed` — shown as
//   `delivery_uncertain` and never sent again. Corrupt state is reported, never read as empty.
//
// Routines run only while the app runs (decided for 2.0); a once job missed while it was closed
// runs at the next check, a recurring one catches up only today, in its saved time zone.
//
// The file format is 1.x's (Swift JSONEncoder: dates as seconds since 2001-01-01, nil keys left
// out), so either app can read the other's file. 2.0 locks with its own lock file
// (`scheduled-routines.json.botling2.lock`, not 1.x's flock).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock, writeFileAtomic } from "./durable/atomic";
import { fromSwiftDate, toSwiftDate } from "./store/records";

// ------------------------------------------------------------------------------------------------
// Time in a zone

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Whether `zone` is an IANA time zone this runtime knows ("Asia/Taipei", "UTC"). */
export function isTimeZone(zone: string): boolean {
  if (!zone || typeof zone !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The system's own zone (what `TimeZone.current.identifier` is in 1.x). */
export const localZone = (): string => process.env.TZ && isTimeZone(process.env.TZ) ? process.env.TZ : Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Calendar fields of an instant in `zone` (null: the system's local time). */
export function localParts(ms: number, zone: string | null): LocalParts {
  if (zone === null) {
    const date = new Date(ms);
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes(), weekday: date.getDay() };
  }
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    formatters.set(zone, format);
  }
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), weekday: WEEKDAYS[parts.weekday!] ?? 0 };
}

const MINUTE = 60_000;
const floorMinute = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;
const sameDay = (a: LocalParts, b: LocalParts) => a.year === b.year && a.month === b.month && a.day === b.day;

// ------------------------------------------------------------------------------------------------
// CronSchedule

/**
 * The five time fields of a crontab line: minute, hour, day of month, month, day of week.
 * `*`, numbers, ranges `1-5`, lists `1,3,5`, steps `*\/15` or `0-30/10`; day of week 0–7 (0 and 7
 * Sunday). When both day of month and day of week are restricted, either matching is enough.
 */
export class CronSchedule {
  private constructor(
    readonly text: string,
    private minutes: Set<number>, private hours: Set<number>, private days: Set<number>, private months: Set<number>, private weekdays: Set<number>,
    private daysRestricted: boolean, private weekdaysRestricted: boolean,
  ) {}

  static parse(text: string): CronSchedule | null {
    const fields = text.split(/\s+/).filter(Boolean);
    if (fields.length !== 5) return null;
    const minutes = values(fields[0]!, 0, 59);
    const hours = values(fields[1]!, 0, 23);
    const days = values(fields[2]!, 1, 31);
    const months = values(fields[3]!, 1, 12);
    const weekdays = values(fields[4]!, 0, 7);
    if (!minutes || !hours || !days || !months || !weekdays) return null;
    if (weekdays.has(7)) weekdays.add(0);
    return new CronSchedule(fields.join(" "), minutes, hours, days, months, weekdays, fields[2] !== "*", fields[4] !== "*");
  }

  private dayMatches(parts: LocalParts): boolean {
    const day = this.days.has(parts.day);
    const weekday = this.weekdays.has(parts.weekday);
    if (this.daysRestricted && this.weekdaysRestricted) return day || weekday;
    if (this.daysRestricted) return day;
    if (this.weekdaysRestricted) return weekday;
    return true;
  }

  matches(ms: number, zone: string | null): boolean {
    const parts = localParts(ms, zone);
    return this.minutes.has(parts.minute) && this.hours.has(parts.hour) && this.months.has(parts.month) && this.dayMatches(parts);
  }

  /** The latest minute at or before `now` on `now`'s local day when this runs (`lastTime(atOrBefore:notBefore: startOfDay)`). */
  lastTimeToday(now: number, zone: string | null): number | null {
    const today = localParts(now, zone);
    let minute = floorMinute(now);
    for (let guard = 0; guard < 2_000; guard++) {
      const parts = localParts(minute, zone);
      if (!sameDay(parts, today)) return null;
      if (!this.months.has(parts.month) || !this.dayMatches(parts)) return null; // The whole day cannot match.
      if (!this.hours.has(parts.hour)) { minute -= (parts.minute + 1) * MINUTE; continue; }
      if (this.minutes.has(parts.minute)) return minute;
      minute -= MINUTE;
    }
    return null;
  }

  /** The first minute after `after` when this runs, within a year; null when none. */
  nextTime(after: number, zone: string | null): number | null {
    let time = floorMinute(after) + MINUTE;
    const limit = after + 366 * 24 * 3600_000;
    while (time <= limit) {
      const parts = localParts(time, zone);
      if (!this.months.has(parts.month) || !this.dayMatches(parts)) { time += ((23 - parts.hour) * 60 + (60 - parts.minute)) * MINUTE; continue; }
      if (!this.hours.has(parts.hour)) { time += (60 - parts.minute) * MINUTE; continue; }
      if (this.minutes.has(parts.minute)) return time;
      time += MINUTE;
    }
    return null;
  }

  /** `HH:mm` when it runs once a day at one time; null otherwise. */
  get dailyTime(): { hour: number; minute: number } | null {
    if (this.minutes.size !== 1 || this.hours.size !== 1) return null;
    return { hour: [...this.hours][0]!, minute: [...this.minutes][0]! };
  }

  /** "Every day 08:15", "Weekdays 09:00", or the cron fields (English: 2.0's page is in English). */
  get description(): string {
    const fields = this.text.split(" ");
    const time = this.dailyTime;
    if (!time || fields[2] !== "*" || fields[3] !== "*") return this.text;
    const clock = `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
    switch (fields[4]) {
      case "*": return `Every day ${clock}`;
      case "1-5": return `Weekdays ${clock}`;
      case "0,6": case "6,0": case "6-7": return `Weekends ${clock}`;
      default: {
        const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        return `${[...this.weekdays].filter((day) => day !== 7).sort((a, b) => a - b).map((day) => names[day]).join(", ")} ${clock}`;
      }
    }
  }
}

function values(field: string, low: number, high: number): Set<number> | null {
  const result = new Set<number>();
  for (const part of field.split(",")) {
    const pieces = part.split("/");
    if (pieces.length > 2) return null;
    const step = pieces.length === 2 ? int(pieces[1]!) : 1;
    if (step === null || step <= 0) return null;
    let from: number, to: number;
    const head = pieces[0]!;
    if (head === "*") { from = low; to = high; }
    else if (head.includes("-")) {
      const [a, b] = head.split("-");
      const x = int(a ?? ""), y = int(b ?? "");
      if (x === null || y === null || x > y || x < low || y > high || head.split("-").length !== 2) return null;
      from = x; to = y;
    } else {
      const single = int(head);
      if (single === null || single < low || single > high) return null;
      from = single; to = pieces.length === 2 ? high : single;
    }
    for (let value = from; value <= to; value += step) result.add(value);
  }
  return result.size ? result : null;
}

const int = (text: string): number | null => (/^\d+$/.test(text) ? Number(text) : null);

// ------------------------------------------------------------------------------------------------
// routines.cron

export interface Routine {
  /** "<cron> <task>": what makes it the same job across edits elsewhere. */
  id: string;
  schedule: CronSchedule;
  /** As written: "Name: what to do", or "Name: @file". */
  task: string;
  /** A line starting with # is paused. */
  enabled: boolean;
}

export function routine(schedule: CronSchedule, task: string, enabled = true): Routine {
  return { id: `${schedule.text} ${task}`, schedule, task, enabled };
}

/** Where "Name: what to do" divides: the first full-width "：", or ":" followed by a space or the end. */
function nameEnd(task: string): { name: string; rest: string } | null {
  const chars = [...task];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    const next = chars[i + 1];
    if (char === "：" || (char === ":" && (next === undefined || /\s/.test(next)))) {
      const name = chars.slice(0, i).join("").trim();
      return name ? { name, rest: chars.slice(i + 1).join("") } : null;
    }
  }
  return null;
}

export function routineTitle(task: string): string {
  const parts = nameEnd(task);
  if (parts) return parts.name;
  const chars = [...task];
  return chars.length > 16 ? `${chars.slice(0, 16).join("")}…` : task;
}

export function routineInstruction(task: string): string {
  const parts = nameEnd(task);
  return parts ? parts.rest.trim() : task;
}

/** `@path`: a file the bot should open and follow. */
export function routineFile(task: string): string | null {
  const text = routineInstruction(task);
  if (!text.startsWith("@")) return null;
  const path = text.slice(1).trim();
  return path || null;
}

const routineLine = (job: Routine) => `${job.enabled ? "" : "#"}${job.schedule.text} ${job.task}`;

/** `15 8 * * * Daily summary: …`, with an optional leading # for paused; plain comments are not jobs. */
export function parseRoutine(line: string): Routine | null {
  let text = line.trim();
  let enabled = true;
  if (text.startsWith("#")) {
    enabled = false;
    text = text.slice(1).trim();
  }
  const match = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(text);
  if (!match) return null;
  const schedule = CronSchedule.parse(match.slice(1, 6).join(" "));
  const task = match[6]!.trim();
  if (!schedule || !task) return null;
  return routine(schedule, task, enabled);
}

export const ROUTINE_HEADER = [
  "# Routines: one job per line, crontab format.",
  "# minute hour day month weekday  Name: what to do (a one-line prompt, or @file-path to follow that file)",
  "# A leading # pauses a job; deleting the whole line removes it.",
];

export const DAILY_SUMMARY = "15 8 * * * Daily summary: Read each project's memory file; list what is waiting on the user first, then one line of current status per project, 5 lines at most. Do not wake the managers.";

export class RoutineError extends Error {}

/** A bot's routines.cron (`RoutineFile`): comments and blank lines are kept as they are. */
export class RoutineFile {
  constructor(readonly file: string) {}

  get exists(): boolean {
    return existsSync(this.file);
  }

  private lines(): string[] {
    let text: string;
    try { text = readFileSync(this.file, "utf8"); } catch { return []; }
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  }

  private write(lines: string[]) {
    writeFileAtomic(this.file, `${lines.join("\n")}\n`);
  }

  load(): Routine[] {
    return this.lines().map(parseRoutine).filter((job): job is Routine => job !== null);
  }

  /** Writes the file with its header and `jobs` when it is not there yet. */
  create(jobs: string[]) {
    if (this.exists) return;
    this.write([...ROUTINE_HEADER, ...jobs]);
  }

  add(job: Routine) {
    this.write([...this.lines(), routineLine(job)]);
  }

  /** Checked change for the app's tools (`update(id:operation:)`): cancel removes the line, pause/resume set its #. */
  update(id: string, operation: string) {
    let text: string;
    try { text = readFileSync(this.file, "utf8"); } catch (error) { throw new RoutineError(`Cannot read routines.cron: ${(error as Error).message}`); }
    let found = false;
    const changed = text.split("\n").flatMap((line) => {
      const job = parseRoutine(line);
      if (!job || job.id !== id) return [line];
      found = true;
      if (operation === "cancel") return [];
      return [routineLine({ ...job, enabled: operation === "resume" })];
    });
    if (!found) throw new RoutineError("Unknown legacy routine id. Call list to refresh IDs after cron edits.");
    writeFileAtomic(this.file, changed.join("\n"));
  }
}

// ------------------------------------------------------------------------------------------------
// scheduled-routines.json

export type ScheduledKind = "once" | "recurring";
export type ScheduledState = "pending" | "paused" | "claimed" | "fired" | "cancelled";

/** One app-owned schedule, with 1.x's keys (`ScheduledRoutine`); dates are Swift dates. `fired` means handed to the bot, never success. */
export interface ScheduledRoutine {
  id: string;
  kind: ScheduledKind;
  task: string;
  at?: number;
  cron?: string;
  timezone: string;
  state: ScheduledState;
  createdAt: number;
  baseline: number;
  lastClaim?: number;
  dispatchedAt?: number;
  requestID: string;
}

/** When it is due at `now` (ms): the occurrence it would claim, or null (`dueTime(at:)`). */
export function dueTime(job: ScheduledRoutine, now: number): number | null {
  if (job.state !== "pending") return null;
  if (job.kind === "once") {
    if (job.at === undefined) return null;
    const at = fromSwiftDate(job.at);
    return at <= now ? at : null;
  }
  const schedule = job.cron ? CronSchedule.parse(job.cron) : null;
  if (!schedule || !isTimeZone(job.timezone)) return null;
  const time = schedule.lastTimeToday(now, job.timezone);
  if (time === null) return null;
  const since = fromSwiftDate(Math.max(job.lastClaim ?? job.baseline, job.baseline));
  return time > since ? time : null;
}

/** `status(at:)`: a claim that never got its confirmation is `delivery_uncertain`. */
export function routineStatus(job: ScheduledRoutine, now: number): string {
  if (job.state === "claimed") return "delivery_uncertain";
  return dueTime(job, now) === null ? job.state : "due";
}

/** ISO8601DateFormatter's default: seconds, Z. */
const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");

export function routinePayload(job: ScheduledRoutine, now: number): Record<string, unknown> {
  const result: Record<string, unknown> = { id: job.id, kind: job.kind, task: job.task, timezone: job.timezone, status: routineStatus(job, now), request_id: job.requestID };
  if (job.at !== undefined) result.at = iso(fromSwiftDate(job.at));
  if (job.cron !== undefined) result.cron = job.cron;
  if (job.dispatchedAt !== undefined) result.dispatched_at = iso(fromSwiftDate(job.dispatchedAt));
  return result;
}

/** The scheduled routine's job as a Routine (its task and schedule), for its divider and prompt. */
export function scheduledRoutine(job: ScheduledRoutine): Routine {
  return routine(CronSchedule.parse(job.cron ?? "* * * * *")!, job.task);
}

function valid(job: unknown): job is ScheduledRoutine {
  if (!job || typeof job !== "object") return false;
  const j = job as Record<string, unknown>;
  const date = (key: string, required = false) => (j[key] === undefined ? !required : typeof j[key] === "number" && Number.isFinite(j[key]));
  return typeof j.id === "string" && !!j.id && typeof j.requestID === "string" && !!j.requestID && typeof j.task === "string" && !!j.task
    && typeof j.timezone === "string" && isTimeZone(j.timezone)
    && ["pending", "paused", "claimed", "fired", "cancelled"].includes(j.state as string)
    && date("createdAt", true) && date("baseline", true) && date("lastClaim") && date("dispatchedAt") && date("at")
    && (j.kind === "once" ? j.at !== undefined && j.cron === undefined : j.kind === "recurring" && j.at === undefined && typeof j.cron === "string" && CronSchedule.parse(j.cron) !== null);
}

/** Swift JSONEncoder (`.prettyPrinted, .sortedKeys`): keys sorted, nil keys left out. */
function encode(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(sort(value), null, 2);
}

/** A short, locked read/modify/atomic-write transaction (`ScheduledRoutineStore`), shared by the UI, the scheduler and Codex. */
export class ScheduledRoutineStore {
  constructor(readonly file: string) {}

  /** routines.cron beside it. */
  get cronFile(): RoutineFile {
    return new RoutineFile(join(dirname(this.file), "routines.cron"));
  }

  private transaction<T>(body: (jobs: ScheduledRoutine[]) => T): T {
    mkdirSync(dirname(this.file), { recursive: true });
    return withFileLock(`${this.file}.botling2`, () => {
      let document: { version: number; routines: ScheduledRoutine[] };
      if (existsSync(this.file)) {
        let value: any;
        try { value = JSON.parse(readFileSync(this.file, "utf8")); } catch (error) {
          throw new RoutineError(`Cannot read routine state. Preserve scheduled-routines.json and check its data/storage before retrying: ${(error as Error).message}`);
        }
        if (!value || typeof value !== "object" || !Array.isArray(value.routines)) throw new RoutineError("Invalid routine state. Preserve scheduled-routines.json for recovery; no schedules were changed or dispatched.");
        if (value.version !== 1) throw new RoutineError("Unsupported routine state version. Update Botling before changing schedules.");
        const routines = value.routines as unknown[];
        if (!routines.every(valid) || new Set(routines.map((job) => job.id)).size !== routines.length || new Set(routines.map((job) => job.requestID)).size !== routines.length) {
          throw new RoutineError("Invalid routine state. Preserve scheduled-routines.json for recovery; no schedules were changed or dispatched.");
        }
        document = { version: 1, routines: routines.map((job) => ({ ...job })) };
      } else {
        document = { version: 1, routines: [] };
      }
      const before = encode(document);
      const result = body(document.routines);
      const after = encode(document);
      if (after !== before) writeFileAtomic(this.file, after);
      return result;
    });
  }

  load(): ScheduledRoutine[] {
    return this.transaction((jobs) => jobs.map((job) => ({ ...job })));
  }

  /** Persistence precedes dispatch: a crash after this leaves `claimed`, never a retry. */
  claim(id: string, now: number): ScheduledRoutine | null {
    return this.transaction((jobs) => {
      const job = jobs.find((candidate) => candidate.id === id);
      const occurrence = job ? dueTime(job, now) : null;
      if (!job || occurrence === null) return null;
      job.state = "claimed";
      job.lastClaim = toSwiftDate(occurrence);
      return { ...job };
    });
  }

  didDispatch(id: string, now: number) {
    this.transaction((jobs) => {
      const job = jobs.find((candidate) => candidate.id === id);
      if (!job || job.state !== "claimed") return;
      job.dispatchedAt = toSwiftDate(now);
      job.state = job.kind === "once" ? "fired" : "pending";
    });
  }

  /** The same interface for Codex's `app_routines` tool and the app's UI (`perform`). */
  perform(args: Record<string, unknown>, now: number = Date.now()): Record<string, unknown> {
    const operation = typeof args.operation === "string" ? args.operation : "";
    if (operation === "list") {
      const jobs = this.load().map((job) => routinePayload(job, now));
      const legacy = this.cronFile.load().map((job) => ({ id: `cron:${job.id}`, kind: "legacy_recurring", task: job.task, cron: job.schedule.text, timezone: "system_local", status: job.enabled ? "enabled" : "paused" }));
      return { routines: [...jobs, ...legacy], checked_at: iso(now) };
    }
    if (operation === "create") {
      const task = (typeof args.task === "string" ? args.task : "").trim();
      if (!task || task.includes("\n") || task.includes("\r")) throw new RoutineError("task must be a nonempty one-line instruction, optionally 'Name: instruction' or 'Name: @file'.");
      const request = typeof args.request_id === "string" ? args.request_id : "";
      if (!request) throw new RoutineError("create requires a unique request_id; reuse it on retries to avoid duplicate schedules.");
      const zone = typeof args.timezone === "string" ? args.timezone : localZone();
      if (!isTimeZone(zone)) throw new RoutineError("Unknown timezone. Supply an IANA name such as Asia/Taipei.");
      const kind = args.kind === "once" || args.kind === "recurring" ? args.kind : null;
      if (!kind) throw new RoutineError("create requires kind='once' with at, or kind='recurring' with cron.");
      const at = parseAt(args.at, kind === "once");
      const cron = typeof args.cron === "string" ? args.cron : args.cron === undefined ? undefined : null;
      if (cron === null) throw new RoutineError("recurring requires cron with five valid fields: minute hour day month weekday.");
      if (kind === "recurring" && (cron === undefined || CronSchedule.parse(cron) === null)) throw new RoutineError("recurring requires cron with five valid fields: minute hour day month weekday.");
      if (!((kind === "once" && cron === undefined) || (kind === "recurring" && at === undefined))) throw new RoutineError("Use at for once, or cron for recurring, never both.");
      return this.transaction((jobs) => {
        const existing = jobs.find((job) => job.requestID === request);
        if (existing) {
          const sameAt = existing.at === undefined ? at === undefined : at !== undefined && Math.abs(existing.at - toSwiftDate(at)) < 1e-6;
          if (existing.task !== task || existing.kind !== kind || !sameAt || existing.cron !== cron || (args.timezone !== undefined && existing.timezone !== zone)) {
            throw new RoutineError("request_id already belongs to a different schedule. List routines; use a new request_id for new work.");
          }
          return routinePayload(existing, now);
        }
        if (at !== undefined && at <= now) throw new RoutineError("at must be in the future. Supply ISO-8601 with an explicit UTC offset, e.g. 2026-10-25T09:00:00+08:00.");
        const job: ScheduledRoutine = {
          id: randomUUID().toLowerCase(), kind, task, ...(at !== undefined ? { at: toSwiftDate(at) } : {}), ...(cron !== undefined ? { cron } : {}),
          timezone: zone, state: "pending", createdAt: toSwiftDate(now), baseline: toSwiftDate(now), requestID: request,
        };
        jobs.push(job);
        return routinePayload(job, now);
      });
    }
    if (!["cancel", "pause", "resume"].includes(operation)) throw new RoutineError("Supported operations: list, create, cancel, pause, resume. To reschedule, cancel the saved ID and create a new schedule with a new request_id.");
    const id = typeof args.id === "string" ? args.id : "";
    if (!id) throw new RoutineError("This operation requires the persisted id returned by create or list.");
    if (id.startsWith("cron:")) {
      return this.transaction(() => {
        this.cronFile.update(id.slice(5), operation);
        return { id, status: operation === "cancel" ? "cancelled" : operation === "pause" ? "paused" : "enabled" };
      });
    }
    return this.transaction((jobs) => {
      const job = jobs.find((candidate) => candidate.id === id);
      if (!job) throw new RoutineError("Unknown routine id. Call list and use an id from this bot.");
      if (operation === "cancel") {
        // Cancellation stops future dispatch only; it never interrupts already handed-off work.
        if (job.state === "claimed") throw new RoutineError("This routine was already claimed for dispatch. Check chat before creating a replacement; cancellation cannot retract dispatched work.");
        if (job.state !== "fired") job.state = "cancelled";
      } else {
        if (job.state !== "pending" && job.state !== "paused") throw new RoutineError("Only pending or paused routines can be paused/resumed. Fired, cancelled or delivery_uncertain jobs cannot be rearmed; create a new schedule explicitly.");
        if (operation === "resume" && job.state === "paused") job.baseline = toSwiftDate(now);
        job.state = operation === "pause" ? "paused" : "pending";
      }
      return routinePayload(job, now);
    });
  }
}

/** `at`: ISO-8601 with seconds and Z or an explicit offset (a zone alone does not resolve ambiguous local times). */
function parseAt(value: unknown, required: boolean): number | undefined {
  if (value === undefined || value === null) {
    if (required) throw new RoutineError("once requires at, an ISO-8601 timestamp with Z or an explicit UTC offset.");
    return undefined;
  }
  if (typeof value !== "string" || !/T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new RoutineError("at must be ISO-8601 with seconds and Z or an explicit UTC offset; timezone alone does not resolve ambiguous local times.");
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new RoutineError("Invalid at timestamp. Use e.g. 2026-10-25T09:00:00+08:00.");
  return ms;
}

// ------------------------------------------------------------------------------------------------
// A bot's routines

/** The legacy routines bot.json's `routines` held, as routines.cron lines (`legacyRoutineLines`). */
export function legacyRoutineLines(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const r = entry as { title?: unknown; instruction?: unknown; hour?: unknown; minute?: unknown; enabled?: unknown };
    if (typeof r.title !== "string" || typeof r.hour !== "number" || typeof r.minute !== "number") return [];
    const pause = r.enabled === false ? "#" : "";
    const instruction = typeof r.instruction === "string" ? r.instruction : "";
    // The old daily summary had no written task; older builds saved its title in Chinese (1.x's literal).
    if (r.title === "每日摘要" && !instruction && r.hour === 8 && r.minute === 15) return [pause + DAILY_SUMMARY];
    const task = instruction ? `${r.title}: ${instruction}` : r.title;
    return [`${pause}${r.minute} ${r.hour} * * * ${task}`];
  });
}

/** bot.json's `routineRuns` (1.x's: routine id → Swift date), as it is. */
export function fromRoutineRuns(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}

/** "Name · 08:15": the divider a routine's run starts with (24-hour, as 1.x's `.twoDigits` clock). */
export function routineDivider(job: Routine, ms: number): string {
  const date = new Date(ms);
  return `${routineTitle(job.task)} · ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** What the bot is told when a routine's time comes (`Workspace.prompt(for:of:)`). */
export function routinePrompt(job: Routine, role: "main" | "manager" | "bot", briefing: () => string): string {
  const file = routineFile(job.task);
  const ask = file ? `Open ${file} (relative to your working folder) and do what it says.` : routineInstruction(job.task);
  const title = routineTitle(job.task);
  if (role === "main") return `(App: Time for the routine "${title}". ${ask})\n${briefing()}`;
  return `(App: Time for the routine "${title}": ${ask}. When done, report the result in one sentence; if the user needs to decide something, attach a choices block.)`;
}
