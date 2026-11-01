// The one report format (shared-core spec 2.5): what a coordinator reads when a worker's run ends. Claude and
// Antigravity coordinators get the <app_task_result> message, Codex coordinators the JSON tool output, both from one
// `WorkerReport`. Escaping and the length limit live only here. Status words stay the ones coordinators already know
// (`wireStatus`: done → "completed").
import type { CodexItem } from "../agent/codex";
import type { Engine } from "../heads";
import type { RunStatus } from "./classify";

/** How a coordinator settles a report: "none" (taken = done with it: Claude), "checkpoint" (it must decide: Codex, Antigravity). */
export type AckPolicy = "none" | "checkpoint";

export interface WorkerReport { id: string; run: number; engine: Engine; status: RunStatus; text: string }

/** A report's text is cut to this many characters. */
export const REPORT_LIMIT = 200_000;

/** The status words reports, `subagentEnded` and `workerReport` carry (coordinator prompts know these; never "killed"). */
export function wireStatus(s: RunStatus): "completed" | "failed" | "stopped" | "interrupted" {
  return s === "done" ? "completed" : s;
}

/** The sentence after the tag, per policy (claude-workers.ts's and agy-workers.ts's words). */
export const REPORT_TAIL: Record<AckPolicy, string> = {
  none: "This is the worker's own account, not proof the user's goal is met: check what matters, then tell the user in a sentence or two what came of it. To continue this worker, use app_send_message with its task_id; to stop it, app_cancel_task.",
  checkpoint: "Worker completion is execution evidence, not acceptance of the user's full objective. Resolve this exact task_id and run with app_task_checkpoint (outcome and concrete evidence) or same-task app_send_message before ending this report turn. Research-only scope and existing permissions remain unchanged.",
};

const cut = (text: string) => text.slice(0, REPORT_LIMIT);

/** The report a coordinator reads when a worker's run ends (the tags every engine's report uses). `status` is a wire word. */
export function workerReportText(w: { id: string; run: number; engine: Engine; status: string; report: string }, tail: string): string {
  return `<app_task_result task_id="${w.id}" run="${w.run}" engine="${w.engine}" status="${w.status}">\n${cut(w.report).replaceAll("<", "&lt;")}\n</app_task_result>\n${tail}`;
}

/** A run report of a worker another bot owns: the host's `workerReport` item, for the app to route. */
export function ownedWorkerReport(w: { id: string; run: number; engine: Engine; status: string; report: string }): Extract<CodexItem, { kind: "workerReport" }> {
  return { kind: "workerReport", id: w.id, run: w.run, engine: w.engine, status: w.status, report: cut(w.report) };
}

/** The <app_task_result> message (Claude and Antigravity coordinators). */
export function reportTag(r: WorkerReport, ack: AckPolicy): string {
  return workerReportText({ id: r.id, run: r.run, engine: r.engine, status: wireStatus(r.status), report: r.text }, REPORT_TAIL[ack]);
}

/** The JSON tool output (Codex coordinator's `app_task_result`), from the same WorkerReport. */
export function reportPayload(r: WorkerReport, extra: { name: string; threadId: string | null; turnId: string | null; reconciliationAttempt: number }): Record<string, unknown> {
  return {
    task_id: r.id, name: extra.name, thread_id: extra.threadId, turn_id: extra.turnId, run: r.run,
    status: wireStatus(r.status), report: cut(r.text), completion_scope: "worker_turn", objective_status: "unverified",
    reconciliation_attempt: extra.reconciliationAttempt,
  };
}

/** The line put before a report whose run had approvals denied (decision D2: a denial no longer fails the run). */
export function deniedNote(denied: number): string {
  return denied === 1 ? "(1 approval was denied during this run.)" : `(${denied} approvals were denied during this run.)`;
}

/** A report with the denial note in front, when there was any. */
export const withDeniedNote = (text: string, denied: number) => (denied > 0 ? `${deniedNote(denied)}\n${text}` : text);
