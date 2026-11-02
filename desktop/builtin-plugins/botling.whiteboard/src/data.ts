// What the board needs besides a bot's memory, task cards and task history (moved from the core's
// whiteboard-data.ts): its latest action and its one-line description.
import type { LatestAction, Task } from "./types";

const clip = (text: string, limit = 400) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/**
 * The bot's latest action: the newest entry on its task cards' timelines (a task done, what it is
 * doing now, what it waits on you for); a card with no timeline counts by its last change. Null: no tasks.
 */
export function latestAction(tasks: Task[]): LatestAction | null {
  let best: { at: number; action: LatestAction } | null = null;
  const consider = (at: string, action: Omit<LatestAction, "at">) => {
    const time = Date.parse(at);
    if (Number.isNaN(time) || !action.text.trim()) return;
    if (!best || time >= best.at) best = { at: time, action: { ...action, text: clip(action.text.trim()), at } };
  };
  for (const task of tasks.filter((candidate) => candidate.name.trim())) {
    const history = task.history ?? [];
    if (!history.length) {
      const kind = task.state === "done" || task.state === "stopped" ? "done" : task.state === "waiting" ? "waiting" : "now";
      const text = kind === "waiting" ? task.blocked ?? task.name : kind === "now" ? task.now ?? task.name : task.state === "stopped" ? `${task.name} (stopped)` : task.name;
      consider(task.updatedAt, { kind, text });
      continue;
    }
    for (const event of history) {
      switch (event.kind) {
        case "done": case "complete": consider(event.at, { kind: "done", text: task.name }); break;
        case "stopped": consider(event.at, { kind: "done", text: `${task.name} (stopped)` }); break;
        case "waiting": consider(event.at, { kind: "waiting", text: event.text ?? task.blocked ?? task.name }); break;
        case "now": consider(event.at, { kind: "now", text: event.text ?? task.name }); break;
        // Started, your reply, a subagent sent: the task is under way.
        default: consider(event.at, { kind: "now", text: task.name }); break;
      }
    }
  }
  return (best as { action: LatestAction } | null)?.action ?? null;
}

/** The bot in one line, for the board's tooltip: its job, else its memory's first "Current status" line, else its folder's name. */
export function botDescription(job: string | null | undefined, status: string | undefined, folder: string): string | null {
  const first = (text: string | null | undefined) => (text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const line = first(job) || first(status) || (folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "");
  return line ? clip(line) : null;
}
