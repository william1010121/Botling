// Background work under a reply: up to three small icons for the commands and subagents the bot's turn
// left running, each with its count and only those there are (a spinner for the running ones, ✓ for the
// done ones, ✕ for the failed, stopped or interrupted ones), their words in the tooltip. Pressing it lists them (title, status, time); pressing one
// shows its last lines of output, which the app reads (`taskOutput` action, answered by `ccb.taskOutput`).
import { post } from "./bridge";
import type { TaskChipView } from "./types";

let clock: () => number = () => Date.now();

/** For tests: what "now" is. */
export function setTaskClock(now: () => number): void {
  clock = now;
}

/** Tasks open now, by "message/task", with the output last shown (null: still being read). */
const open = new Map<string, string | null>();

function key(messageID: string, taskID: string): string {
  return `${messageID}/${taskID}`;
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

const ended: Record<string, { mark: string; words: string; tone: string }> = {
  completed: { mark: "✓", words: "完成", tone: "done" },
  failed: { mark: "✕", words: "失敗", tone: "failed" },
  killed: { mark: "✕", words: "已停止", tone: "failed" },
  stopped: { mark: "✕", words: "已中斷", tone: "failed" },
  interrupted: { mark: "✕", words: "已中斷（App 重開）", tone: "failed" },
};

/** Replies whose list of tasks is open. */
const expanded = new Set<string>();

function endOf(task: TaskChipView) {
  return ended[task.status] ?? ended.killed;
}

/** What a task's line says after its title: its time, or how it ended (and how long it took). */
function status(task: TaskChipView, now: number): string {
  if (task.status === "running") return elapsed(now - task.started);
  const end = endOf(task);
  if (task.status === "completed") return task.ended != null ? elapsed(task.ended - task.started) : end.words;
  const took = task.ended != null && task.status === "failed" ? ` · ${elapsed(task.ended - task.started)}` : "";
  return `${end.words}${took}`;
}

/** The tooltip: counts, then a line per task. */
function summaryText(tasks: TaskChipView[], now: number): string {
  const running = tasks.filter((task) => task.status === "running").length;
  const done = tasks.filter((task) => task.status === "completed").length;
  const failed = tasks.length - running - done;
  const counts = [running && `${running} 執行中`, done && `${done} 完成`, failed && `${failed} 失敗`].filter(Boolean).join("、");
  const lines = tasks.map((task) => `${task.status === "running" ? "⋯" : endOf(task).mark} ${task.title} · ${status(task, now)}`);
  return [`背景工作：${counts}`, ...lines, "按一下看清單"].join("\n");
}

function markElement(task: TaskChipView): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "task-mark";
  mark.setAttribute("aria-hidden", "true");
  if (task.status === "running") mark.innerHTML = `<span class="task-spin"></span>`;
  else mark.textContent = endOf(task).mark;
  return mark;
}

/** Under a reply: up to three small icons with counts for its background work; pressed, a list of it; a task pressed, its output. */
export function taskChips(messageID: string, tasks: TaskChipView[]): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "task-chips";
  strip.dataset.message = messageID;
  const now = clock();
  const running = tasks.filter((task) => task.status === "running").length;
  const done = tasks.filter((task) => task.status === "completed").length;
  const failed = tasks.length - running - done;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "task-summary";
  // Up to three icons side by side, each with its count; only the kinds there are.
  for (const [tone, n] of [["running", running], ["done", done], ["failed", failed]] as const) {
    if (!n) continue;
    const group = document.createElement("span");
    group.className = `task-group ${tone}`;
    const icon = document.createElement("span");
    icon.className = "task-icon";
    icon.setAttribute("aria-hidden", "true");
    if (tone === "running") icon.innerHTML = `<span class="task-spin"></span>`;
    else icon.textContent = tone === "done" ? "✓" : "✕";
    const count = document.createElement("span");
    count.className = "task-count";
    count.textContent = String(n);
    group.append(icon, count);
    button.append(group);
  }
  button.title = summaryText(tasks, now);
  button.setAttribute("aria-label", summaryText(tasks, now).split("\n")[0]);
  // The times in the tooltip are as of now.
  button.addEventListener("pointerenter", () => (button.title = summaryText(tasks, clock())));

  const list = document.createElement("div");
  list.className = "task-list";
  const panel = document.createElement("pre");
  panel.className = "task-output";
  panel.hidden = true;
  panel.dataset.message = messageID;
  strip.append(button, list, panel);

  const lines: HTMLButtonElement[] = [];
  const show = (task: TaskChipView | null) => {
    const shown = task ? open.get(key(messageID, task.id)) : undefined;
    panel.hidden = !task || !expanded.has(messageID);
    panel.dataset.task = task?.id ?? "";
    panel.textContent = task ? (shown ?? "讀取中…") : "";
    for (const line of lines) line.setAttribute("aria-expanded", String(!!task && line.dataset.task === task.id));
  };
  const setExpanded = (on: boolean) => {
    list.hidden = !on;
    button.setAttribute("aria-expanded", String(on));
    if (on) expanded.add(messageID);
    else expanded.delete(messageID);
    show(tasks.find((task) => open.has(key(messageID, task.id))) ?? null);
  };
  button.addEventListener("click", () => setExpanded(!expanded.has(messageID)));

  for (const task of tasks) {
    const line = document.createElement("button");
    line.type = "button";
    line.className = `task-item ${task.status === "running" ? "running" : endOf(task).tone}`;
    line.dataset.task = task.id;
    line.dataset.message = messageID;
    line.dataset.started = String(task.started);
    line.title = [task.kind === "agent" ? "背景 subagent" : "背景指令", task.detail].filter(Boolean).join("：");
    const name = document.createElement("span");
    name.className = "task-name";
    name.textContent = task.title;
    const time = document.createElement("span");
    time.className = "task-time";
    time.textContent = status(task, now);
    line.append(markElement(task), name, time);
    line.addEventListener("click", () => {
      const id = key(messageID, task.id);
      if (open.has(id)) {
        open.delete(id);
        show(null);
        return;
      }
      // One open per reply.
      for (const other of tasks) open.delete(key(messageID, other.id));
      open.set(id, null);
      show(task);
      post({ type: "taskOutput", messageID, taskID: task.id });
    });
    lines.push(line);
    list.append(line);
  }
  setExpanded(expanded.has(messageID));
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
    if (messageID && taskID && expanded.has(messageID) && open.has(key(messageID, taskID)) && Math.floor(now / 1000) % 5 === 0) {
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
