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
  none: "This is the worker's own account, not proof the user's goal is met: check what matters, then tell the user in a sentence or two what came of it. In that same reply, show what you said you would show (pictures and videos as ![caption](file://full path)) and, when it leaves the user something to decide, end with a choices block; a note in memory is not shown to the user. To continue this worker, use app_send_message with its task_id; to stop it, app_cancel_task.",
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

// ---- Worker notes (app_notify_owner): interim news or a question from a run still under way ----

export type WorkerNoteKind = "report" | "question";
export const WORKER_NOTE_KINDS: readonly WorkerNoteKind[] = ["report", "question"];
/** A note's text is cut to this many characters; at most this many files, each path this long. */
export const NOTE_LIMIT = 20_000;
export const NOTE_FILES_MAX = 20;
const NOTE_PATH_MAX = 1_000;

/** A worker's note to its owner: the worker's task, the run under way, and what it says. */
export interface WorkerNote { id: string; run: number; engine: Engine; kind: WorkerNoteKind; name: string; message: string; files: string[] }

/** The sentence after the note's tag: what the owner does with it (never treated as the worker's final report). */
export const NOTE_TAIL: Record<WorkerNoteKind, string> = {
  report: "Interim news from a worker that is still running, not its final report (that comes later as <app_task_result>). Act on it if it helps now (start parallel workers on what it unblocks, read the file it names); tell the user only if it matters to them or needs their decision, otherwise reply with only <no-reply/>.",
  question: "A worker that is still running asks you this; it is not its final report. Answer it with app_send_message to its task_id (your words join its run under way). If only the user can answer, ask the user, then pass their answer on the same way.",
};

const attr = (value: string) => value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");

/** The <app_worker_note> message the owner reads (`tail`: what to do with it; default NOTE_TAIL). */
export function workerNoteText(n: Pick<WorkerNote, "id" | "run" | "kind" | "name" | "message" | "files">, tail = NOTE_TAIL[n.kind]): string {
  const files = n.files.length ? `\nFiles: ${n.files.join(", ")}` : "";
  return `<app_worker_note task_id="${attr(n.id)}" run="${n.run}" kind="${n.kind}" name="${attr(n.name)}">\n${`${n.message}${files}`.replaceAll("<", "&lt;")}\n</app_worker_note>\n${tail}`;
}

/** The owner's chat line for a note (a relay line, not the user's). */
export function workerNoteLine(n: Pick<WorkerNote, "kind" | "name" | "message" | "files">): string {
  const files = n.files.length ? `\n${n.files.join("\n")}` : "";
  return `${n.kind === "question" ? "Question" : "Note"} from worker "${n.name}": ${n.message}${files}`;
}

/** app_notify_owner's arguments, checked: an error says what is wrong (nothing was sent). */
export function parseWorkerNote(args: Record<string, unknown>): Pick<WorkerNote, "kind" | "message" | "files"> {
  const kind = args.kind;
  if (kind !== "report" && kind !== "question") throw new Error('kind must be "report" or "question". Nothing was sent.');
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) throw new Error("message required. Nothing was sent.");
  const raw = args.files ?? [];
  if (!Array.isArray(raw) || raw.length > NOTE_FILES_MAX || raw.some((file) => typeof file !== "string" || !file.trim() || file.length > NOTE_PATH_MAX))
    throw new Error(`files must be a list of at most ${NOTE_FILES_MAX} paths. Nothing was sent.`);
  return { kind, message: message.slice(0, NOTE_LIMIT), files: (raw as string[]).map((file) => file.trim()) };
}
