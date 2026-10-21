// The chat's background work, as one row under the bot's latest reply (the app puts there every task
// still running, and those finished since your latest line, and none under the others): up to four small icons with counts, only those there are —
// subagents still working, other work still waiting (background commands, Monitors, scheduled
// wake-ups and cron jobs, each with its own mark in the list), work done, work failed (stopped or
// interrupted too). Pressing one opens the list, grouped by those four and filtered
// to the one pressed; pressing a task shows its last lines of output, which the app reads (`taskOutput`
// action with the id of the message that started it, answered by `ccb.taskOutput`).
import { post } from "./bridge";
import { t, type Key } from "./i18n";
import type { TaskChipView } from "./types";

let clock: () => number = () => Date.now();

/** For tests: what "now" is. */
export function setTaskClock(now: () => number): void {
  clock = now;
}

/** The four kinds the row counts, in the order it shows them. */
export type TaskBucket = "agent" | "waiting" | "done" | "failed";
export const taskBuckets: readonly TaskBucket[] = ["agent", "waiting", "done", "failed"];

/** Each kind's name in the list ("Subagents · 2") and with its count ("2 subagents running"). */
const bucketWords: Record<TaskBucket, { label: Key; count: Key }> = {
  agent: { label: "tasks.agent", count: "tasks.agentCount" },
  waiting: { label: "tasks.waiting", count: "tasks.waitingCount" },
  done: { label: "tasks.done", count: "tasks.doneCount" },
  failed: { label: "tasks.failed", count: "tasks.failedCount" },
};

const bucketLabel = (bucket: TaskBucket) => t(bucketWords[bucket].label);
const bucketCount = (bucket: TaskBucket, n: number) => t(bucketWords[bucket].count, { n });

/** Which of the four a task counts as: a running subagent, other running work, done, or failed. */
export function bucketOf(task: TaskChipView): TaskBucket {
  if (task.status === "running") return task.kind === "agent" ? "agent" : "waiting";
  return task.status === "completed" ? "done" : "failed";
}

/** How many of each. */
export function countTasks(tasks: TaskChipView[]): Record<TaskBucket, number> {
  const counts: Record<TaskBucket, number> = { agent: 0, waiting: 0, done: 0, failed: 0 };
  for (const task of tasks) counts[bucketOf(task)] += 1;
  return counts;
}

/** Marks for kinds of waiting work in the list (the row's icons stay the four). */
const kindIcons: Partial<Record<TaskChipView["kind"], string>> = {
  // An eye: a Monitor watching.
  monitor: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>`,
  // An alarm clock: a wake-up set for later.
  wakeup: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.2 1.8M4.5 4.5 7 2.5M19.5 4.5 17 2.5"/></svg>`,
  // Arrows around: a cron job that comes back.
  cron: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/></svg>`,
};

/** What each kind is, for a line's tooltip. */
const kindWords: Record<TaskChipView["kind"], Key> = {
  command: "tasks.kind.command",
  agent: "tasks.kind.agent",
  monitor: "tasks.kind.monitor",
  wakeup: "tasks.kind.wakeup",
  cron: "tasks.kind.cron",
};

const icons: Record<TaskBucket, string> = {
  // A small bot head, gently pulsing while it works.
  agent: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 13.5h.01M15 13.5h.01"/><circle cx="12" cy="3.5" r="0.6" fill="currentColor"/></svg>`,
  // An hourglass.
  waiting: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12M6 21h12M7 3c0 5 10 6 10 9s-10 4-10 9M17 3c0 5-10 6-10 9s10 4 10 9"/></svg>`,
  done: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`,
  failed: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>`,
};

/** Tasks open now, by "message/task" (the message that started it), with the output last shown (null: still being read). */
const open = new Map<string, string | null>();

function key(messageID: string, taskID: string): string {
  return `${messageID}/${taskID}`;
}

/** The row's list: open or not, and which of the four it shows ("all": every one, grouped). There is one row, so one state. */
const view: { expanded: boolean; filter: TaskBucket | "all" } = { expanded: false, filter: "all" };

/** For tests: the list closed, nothing open. */
export function resetTaskChips(): void {
  view.expanded = false;
  view.filter = "all";
  open.clear();
}

/** "45 sec", "3 min 12 sec", "1 h 5 min" (in the page's language). */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return t("tasks.elapsedHours", { h: hours, m: minutes });
  if (minutes > 0) return t("tasks.elapsedMinutes", { m: minutes, s: seconds % 60 });
  return t("tasks.elapsedSeconds", { s: seconds });
}

/** "in 45 sec", "in 20 min", "in 3 h 5 min", "in 2 days"; "due now" once it is time. */
export function until(ms: number): string {
  if (ms <= 0) return t("tasks.dueNow");
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return t("tasks.inSeconds", { s: seconds });
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return t("tasks.inMinutes", { m: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? t("tasks.inHoursMinutes", { h: hours, m: minutes % 60 }) : t("tasks.inHours", { h: hours });
  return t("tasks.inDays", { n: Math.round(hours / 24) });
}

interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

/** A cron field ("*", "5", "1-5", "1,3", "*\/15", "0-30/10") as its values; null if it is not one. */
function cronValues(field: string, low: number, high: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step <= 0) return null;
    let from: number;
    let to: number;
    if (range === "*") [from, to] = [low, high];
    else if (range.includes("-")) [from, to] = range.split("-").map(Number) as [number, number];
    else [from, to] = [Number(range), stepText === undefined ? Number(range) : high];
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < low || to > high || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values.size ? values : null;
}

function parseCron(text: string): Cron | null {
  const fields = text.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = [cronValues(fields[0], 0, 59), cronValues(fields[1], 0, 23), cronValues(fields[2], 1, 31), cronValues(fields[3], 1, 12), cronValues(fields[4], 0, 7)];
  if (sets.some((set) => !set)) return null;
  const [minutes, hours, days, months, weekdays] = sets as Set<number>[];
  if (weekdays.has(7)) weekdays.add(0);
  return { minutes, hours, days, months, weekdays, daysRestricted: fields[2] !== "*", weekdaysRestricted: fields[4] !== "*" };
}

/** The first minute after `now` (local time) when a cron line runs, within a year; null if none or not a cron line. */
export function nextCronFire(text: string, now: number): number | null {
  const cron = parseCron(text);
  if (!cron) return null;
  const time = new Date(now);
  time.setSeconds(0, 0);
  time.setMinutes(time.getMinutes() + 1);
  const limit = now + 366 * 24 * 3600 * 1000;
  while (time.getTime() <= limit) {
    if (!cron.months.has(time.getMonth() + 1)) {
      time.setMonth(time.getMonth() + 1, 1);
      time.setHours(0, 0, 0, 0);
      continue;
    }
    const dayMatch = cron.days.has(time.getDate());
    const weekdayMatch = cron.weekdays.has(time.getDay());
    const dayOK = cron.daysRestricted && cron.weekdaysRestricted ? dayMatch || weekdayMatch : cron.daysRestricted ? dayMatch : cron.weekdaysRestricted ? weekdayMatch : true;
    if (!dayOK) {
      time.setDate(time.getDate() + 1);
      time.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hours.has(time.getHours())) {
      time.setHours(time.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (cron.minutes.has(time.getMinutes())) return time.getTime();
    time.setMinutes(time.getMinutes() + 1);
  }
  return null;
}

/** Sunday to Saturday, short, as the page's language writes them. */
const weekdayNames = () => t("tasks.weekdays").split(",");

function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** A cron line in words: "Every 30 min", "Hourly at :07", "Daily 09:00", "Weekdays 09:00", "Every Mon, Thu 18:30", "10/22 09:00"; the line itself when it is not that simple. */
export function describeCron(text: string): string {
  const cron = parseCron(text);
  if (!cron) return text;
  const fields = text.trim().split(/\s+/);
  const [minute, hour, day, month, weekday] = fields;
  const one = (set: Set<number>) => (set.size === 1 ? [...set][0] : null);
  const allDays = day === "*" && month === "*" && weekday === "*";
  const step = /^\*\/(\d+)$/;
  if (step.test(minute) && hour === "*" && allDays) return t("tasks.cronEveryMinutes", { n: minute.match(step)![1] });
  if (minute === "*" && hour === "*" && allDays) return t("tasks.cronEveryMinute");
  const m = one(cron.minutes);
  if (m === null) return text;
  if (hour === "*" && allDays) return t("tasks.cronHourly", { m: String(m).padStart(2, "0") });
  if (step.test(hour) && allDays) return t("tasks.cronEveryHours", { n: hour.match(step)![1] });
  const h = one(cron.hours);
  if (h === null) return text;
  const at = hhmm(h, m);
  if (day === "*" && month === "*") {
    if (weekday === "*") return t("tasks.cronDaily", { at });
    if (weekday === "1-5") return t("tasks.cronWeekdays", { at });
    if (weekday === "0,6" || weekday === "6,0" || weekday === "6-7") return t("tasks.cronWeekends", { at });
    const days = [...cron.weekdays].filter((d) => d !== 7).sort((a, b) => a - b);
    const names = weekdayNames();
    return t("tasks.cronWeekly", { days: days.map((d) => names[d]).join(t("tasks.listSeparator")), at });
  }
  const d = one(cron.days);
  const mo = one(cron.months);
  if (d !== null && mo !== null && weekday === "*") return `${mo}/${d} ${at}`;
  if (d !== null && month === "*" && weekday === "*") return t("tasks.cronMonthly", { d, at });
  return text;
}

/** What scheduled work's line says while it waits: when it fires next ("in 20 min", "Daily 09:00 · in 3 h"). */
function scheduledWords(kind: string, fires: number | null, schedule: string | null, recurring: boolean, now: number): string {
  if (kind === "cron" && schedule) {
    const next = recurring ? nextCronFire(schedule, now) : fires;
    const words = recurring ? describeCron(schedule) : t("tasks.cronOnce", { when: describeCron(schedule) });
    return next != null ? `${words} · ${until(next - now)}` : words;
  }
  return fires != null ? until(fires - now) : t("status.waiting");
}

/** A running line's time: how long it has run, or, for scheduled work, when it fires. */
function runningWords(item: { kind: string; started: number; fires: number | null; schedule: string | null; recurring: boolean }, now: number): string {
  if (item.kind === "wakeup" || item.kind === "cron") return scheduledWords(item.kind, item.fires, item.schedule, item.recurring, now);
  return elapsed(now - item.started);
}

function runningOf(task: TaskChipView): { kind: string; started: number; fires: number | null; schedule: string | null; recurring: boolean } {
  return { kind: task.kind, started: task.started, fires: task.fires ?? null, schedule: task.schedule ?? null, recurring: task.recurring !== false };
}

const endWords: Record<string, Key> = {
  completed: "status.done",
  failed: "status.failed",
  killed: "status.stopped",
  stopped: "tasks.interrupted",
  interrupted: "tasks.interruptedRestart",
};

/** What a task's line says after its title: its time, or how it ended (and how long it took). */
function status(task: TaskChipView, now: number): string {
  if (task.status === "running") return runningWords(runningOf(task), now);
  const words = t(endWords[task.status] ?? endWords.killed);
  if (task.status === "completed" && (task.kind === "wakeup" || task.kind === "cron")) {
    return task.kind === "cron" && task.recurring !== false ? t("tasks.cronEnded", { when: describeCron(task.schedule ?? "") }) : t("tasks.fired");
  }
  if (task.status === "completed") return task.ended != null ? elapsed(task.ended - task.started) : words;
  const took = task.ended != null && task.status === "failed" ? ` · ${elapsed(task.ended - task.started)}` : "";
  return `${words}${took}`;
}

/** The counts in words: "2 subagents running, 1 waiting, 3 done". */
function countWords(tasks: TaskChipView[]): string {
  const counts = countTasks(tasks);
  return taskBuckets.filter((bucket) => counts[bucket]).map((bucket) => bucketCount(bucket, counts[bucket])).join(t("tasks.listSeparator"));
}

/** An icon's tooltip: its count, then a line per task of that kind. */
function bucketTooltip(bucket: TaskBucket, tasks: TaskChipView[], now: number): string {
  const mine = tasks.filter((task) => bucketOf(task) === bucket);
  return [bucketCount(bucket, mine.length), ...mine.map((task) => `${task.title} · ${status(task, now)}`), t("tasks.clickForList")].join("\n");
}

function iconElement(bucket: TaskBucket, className: string): HTMLElement {
  const icon = document.createElement("span");
  icon.className = className;
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = icons[bucket];
  return icon;
}

/** The chat's background-work row, under its latest message: an icon with a count for each of the four there is; pressed, the list; a task pressed, its output. */
export function taskChips(messageID: string, tasks: TaskChipView[]): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "task-chips";
  strip.dataset.message = messageID;
  const now = clock();
  const counts = countTasks(tasks);
  const origin = (task: TaskChipView) => task.message ?? messageID;

  const summary = document.createElement("div");
  summary.className = "task-summary";
  summary.setAttribute("role", "group");
  summary.setAttribute("aria-label", t("tasks.summary", { counts: countWords(tasks) }));
  const iconButtons: HTMLButtonElement[] = [];
  for (const bucket of taskBuckets) {
    if (!counts[bucket]) continue;
    const group = document.createElement("button");
    group.type = "button";
    group.className = `task-group ${bucket}`;
    group.dataset.bucket = bucket;
    const count = document.createElement("span");
    count.className = "task-count";
    count.textContent = String(counts[bucket]);
    group.append(iconElement(bucket, "task-icon"), count);
    group.title = bucketTooltip(bucket, tasks, now);
    group.setAttribute("aria-label", bucketCount(bucket, counts[bucket]));
    // The times in the tooltip are as of now.
    group.addEventListener("pointerenter", () => (group.title = bucketTooltip(bucket, tasks, clock())));
    group.addEventListener("click", () => {
      // The same icon again closes the list; another one shows its kind.
      if (view.expanded && view.filter === bucket) view.expanded = false;
      else Object.assign(view, { expanded: true, filter: bucket });
      draw();
    });
    iconButtons.push(group);
    summary.append(group);
  }

  const list = document.createElement("div");
  list.className = "task-list";
  const panel = document.createElement("pre");
  panel.className = "task-output";
  panel.hidden = true;
  strip.append(summary, list, panel);

  const lines: HTMLButtonElement[] = [];
  const opened = () => tasks.find((task) => open.has(key(origin(task), task.id))) ?? null;
  const show = (task: TaskChipView | null) => {
    const shown = task ? open.get(key(origin(task), task.id)) : undefined;
    panel.hidden = !task || !view.expanded;
    panel.dataset.task = task?.id ?? "";
    panel.dataset.message = task ? origin(task) : "";
    panel.textContent = task ? (shown ?? t("tasks.reading")) : "";
    for (const line of lines) line.setAttribute("aria-expanded", String(!!task && line.dataset.task === task.id && line.dataset.message === origin(task)));
  };

  function line(task: TaskChipView): HTMLButtonElement {
    const bucket = bucketOf(task);
    const item = document.createElement("button");
    item.type = "button";
    item.className = `task-item ${bucket}${task.status === "running" ? " running" : ""}`;
    item.dataset.task = task.id;
    item.dataset.message = origin(task);
    item.dataset.started = String(task.started);
    item.dataset.kind = task.kind;
    if (task.fires != null) item.dataset.fires = String(task.fires);
    if (task.schedule) item.dataset.schedule = task.schedule;
    if (task.recurring === false) item.dataset.recurring = "false";
    const kind = t(kindWords[task.kind] ?? kindWords.command);
    item.title = task.detail ? t("tasks.kindDetail", { kind, detail: task.detail }) : kind;
    const name = document.createElement("span");
    name.className = "task-name";
    name.textContent = task.title;
    const time = document.createElement("span");
    time.className = "task-time";
    time.textContent = status(task, now);
    // Waiting work shows what kind it is; the rest how it went.
    const mark = iconElement(bucket, "task-mark");
    const glyph = bucket === "waiting" ? kindIcons[task.kind] : undefined;
    if (glyph) {
      mark.innerHTML = glyph;
      mark.dataset.kind = task.kind;
    }
    item.append(mark, name, time);
    item.addEventListener("click", () => {
      const id = key(origin(task), task.id);
      if (open.has(id)) {
        open.delete(id);
        show(null);
        return;
      }
      // One open at a time.
      open.clear();
      open.set(id, null);
      show(task);
      post({ type: "taskOutput", messageID: origin(task), taskID: task.id });
    });
    lines.push(item);
    return item;
  }

  function draw(): void {
    // A kind no longer there (its last one finished) falls back to all of them.
    if (view.filter !== "all" && !counts[view.filter]) view.filter = "all";
    list.hidden = !view.expanded;
    list.replaceChildren();
    lines.length = 0;
    for (const icon of iconButtons) icon.setAttribute("aria-expanded", String(view.expanded && (view.filter === "all" || view.filter === icon.dataset.bucket)));
    if (view.expanded) {
      // Filters: all, or one of the four there are.
      const filters = document.createElement("div");
      filters.className = "task-filters";
      filters.setAttribute("role", "tablist");
      for (const choice of ["all", ...taskBuckets.filter((bucket) => counts[bucket])] as const) {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = `task-filter ${choice}`;
        tab.dataset.filter = choice;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(view.filter === choice));
        if (choice === "all") tab.textContent = t("tasks.all", { n: tasks.length });
        else tab.append(iconElement(choice, "task-filter-icon"), `${bucketLabel(choice)} ${counts[choice]}`);
        tab.addEventListener("click", () => {
          view.filter = choice;
          draw();
        });
        filters.append(tab);
      }
      list.append(filters);
      // Grouped by the four, in the row's order; the newest first in each.
      for (const bucket of taskBuckets) {
        if (view.filter !== "all" && view.filter !== bucket) continue;
        const mine = tasks.filter((task) => bucketOf(task) === bucket).sort((a, b) => b.started - a.started);
        if (!mine.length) continue;
        const section = document.createElement("div");
        section.className = `task-section ${bucket}`;
        section.dataset.bucket = bucket;
        const title = document.createElement("div");
        title.className = "task-section-title";
        title.textContent = `${bucketLabel(bucket)} · ${mine.length}`;
        section.append(title, ...mine.map(line));
        list.append(section);
      }
    }
    show(opened());
  }
  draw();
  return strip;
}

/** The app's answer to an opened task: its output, into its box (also after a redraw). */
export function taskOutput(messageID: string, taskID: string, text: string): void {
  const id = key(messageID, taskID);
  if (!open.has(id)) return;
  const shown = text.trim() ? text : t("tasks.noOutput");
  open.set(id, shown);
  for (const panel of document.querySelectorAll<HTMLElement>(".task-output")) {
    if (panel.dataset.task === taskID && panel.dataset.message === messageID) panel.textContent = shown;
  }
}

/** Moves the time on in every running task's line; an open running one reads its output again every 5 seconds. */
export function tickTaskChips(now: number = clock()): void {
  for (const line of document.querySelectorAll<HTMLElement>(".task-item.running")) {
    const started = Number(line.dataset.started);
    const time = line.querySelector(".task-time");
    if (!time || !Number.isFinite(started)) continue;
    const fires = line.dataset.fires != null ? Number(line.dataset.fires) : null;
    time.textContent = runningWords(
      { kind: line.dataset.kind ?? "command", started, fires: fires != null && Number.isFinite(fires) ? fires : null, schedule: line.dataset.schedule ?? null, recurring: line.dataset.recurring !== "false" },
      now,
    );
    const messageID = line.dataset.message;
    const taskID = line.dataset.task;
    if (messageID && taskID && view.expanded && open.has(key(messageID, taskID)) && Math.floor(now / 1000) % 5 === 0) {
      post({ type: "taskOutput", messageID, taskID });
    }
  }
}

let ticking = false;

/** Starts the once-a-second tick (once). */
export function startTaskTicks(): void {
  if (ticking || typeof window === "undefined") return;
  ticking = true;
  window.setInterval(() => tickTaskChips(), 1000);
}
