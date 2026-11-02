// What the main bot's whiteboard needs besides a bot's memory, task cards and task history
// (task-history.ts) (pure; Bot and the server call these):
//   - its latest action: the newest entry on any task card's timeline (else the newest card).
//   - its one-line description for the board's tooltip.
//   - a pending tool approval's command, from the approval card's text.
import type { TaskView } from "../contract";

export interface LatestAction { kind: "done" | "now" | "waiting"; text: string; at: string }

const clip = (text: string, limit = 400) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/**
 * The bot's latest action: the newest entry on its task cards' timelines (a task done, what it is
 * doing now, what it waits on you for); a card with no timeline counts by its last change. Null: no tasks.
 */
export function latestAction(tasks: TaskView[]): LatestAction | null {
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

/** What a tool approval card asks to run: the text in its fence (`permissionText`), else its first line. */
export function approvalSummary(text: string): string {
  const fenced = /^(~{3,})\n([\s\S]*?)\n\1\s*$/m.exec(text);
  const body = fenced?.[2] ?? text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  return clip(body.trim().replace(/\s+/g, " "));
}
