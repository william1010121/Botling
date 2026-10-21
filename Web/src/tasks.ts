// The chat's background work, as one row under its latest message (the app puts every task of the chat
// there, and none under the others): up to four small icons with counts, only those there are —
// subagents still working, other work still waiting (background commands), work done, work
// failed (stopped or interrupted too). Pressing one opens the list, grouped by those four and filtered
// to the one pressed; pressing a task shows its last lines of output, which the app reads (`taskOutput`
// action with the id of the message that started it, answered by `ccb.taskOutput`).
import { post } from "./bridge";
import type { TaskChipView } from "./types";

let clock: () => number = () => Date.now();

/** For tests: what "now" is. */
export function setTaskClock(now: () => number): void {
  clock = now;
}

/** The four kinds the row counts, in the order it shows them. */
export type TaskBucket = "agent" | "waiting" | "done" | "failed";
export const taskBuckets: readonly TaskBucket[] = ["agent", "waiting", "done", "failed"];

const bucketWords: Record<TaskBucket, { label: string; count: string }> = {
  agent: { label: "Subagent", count: "subagent 執行中" },
  waiting: { label: "等待中", count: "等待中" },
  done: { label: "成功", count: "成功" },
  failed: { label: "錯誤", count: "錯誤" },
};

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

/** "45 秒", "3 分 12 秒", "1 小時 5 分". */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours} 小時 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${seconds} 秒`;
}

const endWords: Record<string, string> = {
  completed: "完成",
  failed: "失敗",
  killed: "已停止",
  stopped: "已中斷",
  interrupted: "已中斷（App 重開）",
};

/** What a task's line says after its title: its time, or how it ended (and how long it took). */
function status(task: TaskChipView, now: number): string {
  if (task.status === "running") return elapsed(now - task.started);
  const words = endWords[task.status] ?? endWords.killed;
  if (task.status === "completed") return task.ended != null ? elapsed(task.ended - task.started) : words;
  const took = task.ended != null && task.status === "failed" ? ` · ${elapsed(task.ended - task.started)}` : "";
  return `${words}${took}`;
}

/** The counts in words: "2 subagent 執行中、1 等待中、3 成功". */
function countWords(tasks: TaskChipView[]): string {
  const counts = countTasks(tasks);
  return taskBuckets.filter((bucket) => counts[bucket]).map((bucket) => `${counts[bucket]} ${bucketWords[bucket].count}`).join("、");
}

/** An icon's tooltip: its count, then a line per task of that kind. */
function bucketTooltip(bucket: TaskBucket, tasks: TaskChipView[], now: number): string {
  const mine = tasks.filter((task) => bucketOf(task) === bucket);
  return [`${mine.length} ${bucketWords[bucket].count}`, ...mine.map((task) => `${task.title} · ${status(task, now)}`), "按一下看清單"].join("\n");
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
  summary.setAttribute("aria-label", `背景工作：${countWords(tasks)}`);
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
    group.setAttribute("aria-label", `${counts[bucket]} ${bucketWords[bucket].count}`);
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
    panel.textContent = task ? (shown ?? "讀取中…") : "";
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
    item.title = [task.kind === "agent" ? "背景 subagent" : "背景指令", task.detail].filter(Boolean).join("：");
    const name = document.createElement("span");
    name.className = "task-name";
    name.textContent = task.title;
    const time = document.createElement("span");
    time.className = "task-time";
    time.textContent = status(task, now);
    item.append(iconElement(bucket, "task-mark"), name, time);
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
        if (choice === "all") tab.textContent = `全部 ${tasks.length}`;
        else tab.append(iconElement(choice, "task-filter-icon"), `${bucketWords[choice].label} ${counts[choice]}`);
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
        title.textContent = `${bucketWords[bucket].label} · ${mine.length}`;
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
  const shown = text.trim() ? text : "（沒有輸出）";
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
    time.textContent = elapsed(now - started);
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
