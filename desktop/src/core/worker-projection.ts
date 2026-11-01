// An app-managed worker's ledger record projected onto what shows it (shared-core spec 3.4, 3.5): its row in
// subagents.json and its chip in the reply that started it here, its registry entry and its step through the bot
// (`Bot.projectWorker`). status.ts decides every one of them; the worker's own end notices never do.
import { projectBackgroundTask } from "./background-tasks";
import type { ChatRecord } from "./store/records";
import { toSwiftDate } from "./store/records";
import type { SubagentBook, SubagentRecord } from "./subagents";
import { stepFailed, subagentStatus, type WorkerLedgerRecord } from "./worker-core";

export interface WorkerProjection {
  /** Its row (null: the book does not list it yet; its opening items will). */
  row: SubagentRecord | null;
  rowChanged: boolean;
  /** The row was running and is not now: the run's end, to be told once. */
  ended: boolean;
  /** The chat record whose chip changed. */
  chip: ChatRecord | null;
  /** Whether the step that started it shows as failed. */
  stepFailed: boolean;
}

/**
 * Projects `record` onto `book` (the row) and `chats` (the chip, newest record first found). A run's start is the
 * opening items' (`subagentStarted` keeps the row's run history), so a running record changes neither.
 */
export function projectWorker(book: SubagentBook, chats: ChatRecord[], record: WorkerLedgerRecord): WorkerProjection {
  const row = book.get(record.id) ?? null;
  const status = subagentStatus(record);
  const wasRunning = row?.status === "running";
  const rowChanged = status !== "running" && !!book.project(record.id, { status, endedAt: record.endedAt ? toSwiftDate(record.endedAt) : null, result: record.report.text });
  const chip = record.status !== "running" ? projectBackgroundTask(chats, record.id, record, record.report.text) : null;
  return { row, rowChanged, ended: wasRunning && status !== "running", chip, stepFailed: stepFailed(record) };
}
