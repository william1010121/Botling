// Background work under a reply: a chip for each command or subagent the bot's turn left running,
// with how long it has run, then how it ended. Pressing one shows its last lines of output, which
// the app reads (`taskOutput` action, answered by `ccb.taskOutput`).
import { post } from "./bridge";
import type { TaskChipView } from "./types";

let clock: () => number = () => Date.now();

/** For tests: what "now" is. */
export function setTaskClock(now: () => number): void {
  clock = now;
}

/** Chips open now, by "message/task", with the output last shown (null: still being read). */
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

function label(task: TaskChipView, now: number): { mark: string; text: string; tone: string } {
  if (task.status === "running") {
    return { mark: "⏳", text: `${task.title} · ${elapsed(now - task.started)}`, tone: "running" };
  }
  const end = ended[task.status] ?? ended.killed;
  const took = task.ended != null && task.status !== "interrupted" && task.status !== "stopped" ? ` · ${elapsed(task.ended - task.started)}` : "";
  return { mark: end.mark, text: `${task.title} · ${end.mark} ${end.words}${took}`, tone: end.tone };
}

function drawChip(chip: HTMLElement, task: TaskChipView, now: number): void {
  const { mark, text, tone } = label(task, now);
  chip.className = `task-chip ${tone}`;
  const icon = chip.querySelector(".task-mark")!;
  const words = chip.querySelector(".task-words")!;
  // An ended chip's mark is in its words ("✓ 完成"); a running one leads with ⏳.
  icon.textContent = task.status === "running" ? mark : "";
  words.textContent = text;
}

/** The strip of chips under a reply, and the output box of the one opened. */
export function taskChips(messageID: string, tasks: TaskChipView[]): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "task-chips";
  const row = document.createElement("div");
  row.className = "task-chip-row";
  const panel = document.createElement("pre");
  panel.className = "task-output";
  panel.hidden = true;
  panel.dataset.message = messageID;
  strip.append(row, panel);
  const now = clock();
  const chips: HTMLButtonElement[] = [];
  const show = (task: TaskChipView | null) => {
    const shown = task ? open.get(key(messageID, task.id)) : undefined;
    panel.hidden = !task;
    panel.dataset.task = task?.id ?? "";
    panel.textContent = task ? (shown ?? "讀取中…") : "";
    for (const chip of chips) chip.setAttribute("aria-expanded", String(!!task && chip.dataset.task === task.id));
  };
  for (const task of tasks) {
    const chip = document.createElement("button");
    chip.dataset.task = task.id;
    chip.dataset.message = messageID;
    chip.dataset.started = String(task.started);
    chip.innerHTML = `<span class="task-mark" aria-hidden="true"></span><span class="task-words"></span>`;
    chip.title = [task.kind === "agent" ? "背景 subagent" : "背景指令", task.detail].filter(Boolean).join("：");
    drawChip(chip, task, now);
    chip.addEventListener("click", () => {
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
    chips.push(chip);
    row.append(chip);
  }
  show(tasks.find((task) => open.has(key(messageID, task.id))) ?? null);
  return strip;
}

/** The app's answer to an opened chip: its output, into its box (also after a redraw). */
export function taskOutput(messageID: string, taskID: string, text: string): void {
  const id = key(messageID, taskID);
  if (!open.has(id)) return;
  const shown = text.trim() ? text : "（沒有輸出）";
  open.set(id, shown);
  for (const panel of document.querySelectorAll<HTMLElement>(".task-output")) {
    if (panel.dataset.task === taskID && panel.dataset.message === messageID) panel.textContent = shown;
  }
}

/** Moves the time on in every running chip; an open running one reads its output again now and then. */
export function tickTaskChips(now: number = clock()): void {
  for (const chip of document.querySelectorAll<HTMLElement>(".task-chip.running")) {
    const started = Number(chip.dataset.started);
    const words = chip.querySelector(".task-words");
    if (!words || !Number.isFinite(started)) continue;
    const title = (words.textContent ?? "").replace(/ · [^·]*$/, "");
    words.textContent = `${title} · ${elapsed(now - started)}`;
    const messageID = chip.dataset.message;
    const taskID = chip.dataset.task;
    if (messageID && taskID && open.has(key(messageID, taskID)) && Math.floor(now / 1000) % 5 === 0) {
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
