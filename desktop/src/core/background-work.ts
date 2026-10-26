// Presentation and output for 1.x's background-work chips. File paths stay in the core.
import { open } from "node:fs/promises";
import { BackgroundTaskView } from "../contract";
import type { BackgroundTask } from "./background-tasks";
import type { SubagentRecord } from "./subagents";
import { fromSwiftDate } from "./store/records";

/** A persisted task as the chat draws it. Records come from older/newer builds, so anything the
 * strict view rejects (an unknown kind or status, no start time) is null; unreadable optional
 * metadata is absent instead. */
export function backgroundTaskView(value: unknown): BackgroundTaskView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>;
  const ms = (date: unknown) => typeof date === "number" && Number.isFinite(date) ? Math.round(fromSwiftDate(date)) : null;
  const text = (field: unknown) => typeof field === "string" ? field : null;
  const started = ms(task.startedAt);
  if (started === null) return null;
  const parsed = BackgroundTaskView.safeParse({
    id: task.id, kind: task.kind, title: task.title, status: task.status,
    started, ended: ms(task.endedAt), detail: text(task.detail), fires: ms(task.fireAt),
    schedule: text(task.schedule), recurring: typeof task.recurring === "boolean" ? task.recurring : null,
    summary: text(task.summary),
  });
  return parsed.success ? parsed.data : null;
}

/** BackgroundTask.tail: read at most 16 KiB, discard a partial first line, keep eight nonblank lines. */
async function tail(path: string): Promise<string | null> {
  let file;
  try {
    file = await open(path, "r");
    const { size } = await file.stat();
    const from = Math.max(0, size - 16_384);
    const bytes = Buffer.alloc(Math.min(size, 16_384));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, from);
    let text = bytes.subarray(0, bytesRead).toString("utf8");
    if (from > 0 && text.includes("\n")) text = text.slice(text.indexOf("\n") + 1);
    return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n")
      .map((line) => line.split("\r").filter(Boolean).at(-1)?.trim() ?? "").filter(Boolean)
      .map((line) => [...line].length > 300 ? [...line].slice(0, 300).join("") + "…" : line).slice(-8).join("\n");
  } catch { return null; }
  finally { await file?.close(); }
}

/** Bot.backgroundTaskOutput: a command's tail, a report, recent subagent steps, or its state. */
export async function backgroundTaskOutput(task: BackgroundTask, subagent?: SubagentRecord): Promise<string> {
  if (task.kind === "command" && task.outputFile) {
    const text = await tail(task.outputFile);
    if (text) return text;
  }
  if (task.kind === "wakeup" || task.kind === "cron") {
    const when = typeof task.fireAt === "number" ? `Fires ${new Date(fromSwiftDate(task.fireAt)).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}` : null;
    const schedule = task.schedule ? `cron ${task.schedule}${task.recurring === false ? " (once)" : ""}` : null;
    return [[schedule, task.status === "running" ? when : task.summary].filter(Boolean).join(" · "), task.detail].filter(Boolean).join("\n\n");
  }
  if (task.summary != null && (task.status !== "running" || task.kind === "command" || task.kind === "monitor")) return task.summary;
  if (task.kind === "agent" && subagent) {
    if (subagent.status !== "running" && subagent.result) return subagent.result;
    const recent = subagent.steps.slice(-4).map((step) => {
      const line = step.title.split(/[\r\n\u2028\u2029]/)[0] ?? "";
      return step.kind === "text" ? `· ${line}` : step.kind === "message" ? `← ${step.detail ?? line}` : `› ${step.title}`;
    });
    if (recent.length) return recent.join("\n");
  }
  switch (task.status) {
    case "running": return task.kind === "agent" ? "Working; nothing to show yet." : task.kind === "monitor" ? "Watching; no event yet." : "No output yet.";
    case "stopped": return "The bot's process ended before this reported back.";
    case "interrupted": return "The app restarted while this ran; it was killed.";
    default: return "No output was kept.";
  }
}

/** LaunchText.outputFile: older CLI results carry the output path in their text. */
export function backgroundOutputFile(output: string): string | undefined {
  for (const marker of ["Output is being written to: ", "output_file: "]) {
    const at = output.indexOf(marker);
    if (at < 0) continue;
    const line = output.slice(at + marker.length).split(/[\r\n\u2028\u2029]/)[0]!;
    const path = line.split(". You ")[0]!.trim().replace(/\.$/, "");
    if (path) return path;
  }
}
