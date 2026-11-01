// How a run ended, one copy for every engine, workers and head turns alike (shared-core spec 2.3). The rows are tried
// in order; the first that fits decides. The user's rule: a run that ended normally with a reply succeeded, whatever
// failed on the way.
import type { Engine } from "../heads";
import type { RunEnd } from "./events";

export type RunStatus = "done" | "failed" | "stopped" | "interrupted";

export interface RunFacts {
  /** The engine's end, or null when the run never got one (stopped, quit, crash). */
  end: RunEnd | null;
  /** The run's reply: end.finalText if non-empty, else TextBlocks.last. */
  reply: string;
  /** stopWorker / app_cancel_task / the row's Stop / the sub-bot hand-off stop. */
  stoppedByApp: boolean;
  /** The app went away while it ran (quit, explicit restart, crash found at the next start). */
  interruptedBy: "quit" | "restart" | "crash" | null;
  /** Workers: true (a run must report). Head turns: false (silence is allowed). */
  requireReply: boolean;
  /** toolResult events with failed: true in this run/turn (the pipeline counts them). */
  failedTools: number;
  /** For row 6's words ("Antigravity stopped after a failed tool."); absent: "The agent". */
  engine?: Engine;
}

export interface RunVerdict { status: RunStatus; report: string; reason: string }

export const STOPPED_REPORT = "Stopped by the app; its work was not finished.";
export const NO_REPORT = "The worker ended without a report. Ask the same task_id for the missing result.";
export const NO_RESULT = "The worker's run ended without a result.";

const RESUME = "Nothing was replayed; continue it with app_send_message (it resumes its session).";
/** What a worker's report says when the app went away while it worked (claude-workers.ts's words). */
export const INTERRUPTED_REPORT: Record<"quit" | "restart" | "crash", string> = {
  quit: `Interrupted when the app quit. ${RESUME}`,
  restart: `Interrupted when the app restarted. ${RESUME}`,
  crash: `Interrupted: the app stopped while this worker was at work. ${RESUME}`,
};

export const ENGINE_NAMES: Record<Engine, string> = { claude: "Claude", codex: "Codex", agy: "Antigravity" };

export function classifyRun(f: RunFacts): RunVerdict {
  if (f.stoppedByApp) return { status: "stopped", report: STOPPED_REPORT, reason: "stopped by the app" };
  if (f.interruptedBy !== null) return { status: "interrupted", report: INTERRUPTED_REPORT[f.interruptedBy], reason: `interrupted (${f.interruptedBy})` };
  const end = f.end;
  if (!end) return { status: "failed", report: NO_RESULT, reason: "no end" };
  const reply = f.reply.trim();
  if (end.how === "normal") {
    if (reply) return { status: "done", report: reply, reason: f.failedTools ? `ended normally with a reply after ${f.failedTools} failed tool(s)` : "ended normally with a reply" };
    if (f.requireReply) return { status: "failed", report: NO_REPORT, reason: "ended normally without a report" };
    if (f.failedTools === 0) return { status: "done", report: "", reason: "ended normally in silence" };
    return { status: "failed", report: `${f.engine ? ENGINE_NAMES[f.engine] : "The agent"} stopped after a failed tool.`, reason: "ended in silence after a failed tool" };
  }
  if (end.how === "cancelled") return { status: "stopped", report: end.error ?? "Cancelled.", reason: "cancelled by the engine" };
  const error = end.error?.trim() || (end.how === "exited" ? "The worker's process ended before its report." : "The worker's run failed.");
  return { status: "failed", report: reply ? `${error}\n\n${reply}` : error, reason: end.how === "exited" ? "process exited" : "engine error" };
}
