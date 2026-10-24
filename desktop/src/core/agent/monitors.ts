// Command monitors (the Swift app's CommandMonitor.swift): one command a Codex coordinator asks to
// run in the bot's folder (`app_monitor_start`), after an explicit Allow once card; when it ends,
// the app wakes the coordinator once with `app_monitor_result`. Only commands this app started are
// monitored: an outside PID is never adopted, and an interrupted command is never run again — a
// restart turns it into `interrupted` (its side effects unknown) and reports that instead.
//
// Kept in codex-threads/<session>.monitors.json (1.x's file and keys; dates as Swift dates).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../durable/atomic";
import { toSwiftDate } from "../store/records";

export type MonitorState = "awaitingApproval" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type MonitorWake = "none" | "pending" | "dispatching" | "delivered" | "suppressed" | "uncertain";

export interface CommandMonitor {
  id: string;
  /** The bot session (a UUID, as 1.x writes it: upper case). */
  owner: string;
  command: string;
  cwd: string;
  state: MonitorState;
  exitCode?: number;
  stdout: string;
  stderr: string;
  detail: string;
  wake: MonitorWake;
  createdAt: number;
  endedAt?: number;
}

/** Bytes per stream, also asked of `command/exec`. */
export const MONITOR_OUTPUT_LIMIT = 8_192;

export const isActive = (monitor: CommandMonitor) => monitor.state === "awaitingApproval" || monitor.state === "running" || monitor.state === "cancelling";

/** At most `MONITOR_OUTPUT_LIMIT` bytes of UTF-8, never half a character. */
export function bounded(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MONITOR_OUTPUT_LIMIT) return text;
  let end = MONITOR_OUTPUT_LIMIT;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/** What `app_monitor_status` / `app_monitor_result` say of one (`payload`). */
export function monitorPayload(monitor: CommandMonitor): Record<string, unknown> {
  return {
    monitor_id: monitor.id, run: 1, owner_session_id: monitor.owner.toLowerCase(), command: monitor.command, cwd: monitor.cwd, status: monitor.state,
    exit_code: monitor.exitCode ?? null, stdout: monitor.stdout, stderr: monitor.stderr, output_bytes_cap_per_stream: MONITOR_OUTPUT_LIMIT,
    output_may_be_truncated: true, detail: monitor.detail, wake: monitor.wake,
  };
}

export function monitorSummary(monitor: CommandMonitor): Record<string, unknown> {
  return { monitor_id: monitor.id, owner_session_id: monitor.owner.toLowerCase(), command: [...monitor.command].slice(0, 240).join(""), status: monitor.state, wake: monitor.wake, exit_code: monitor.exitCode ?? null };
}

/** A record read back after a restart (`reconcile`): nothing is run again or reported twice. */
export function reconcile(monitor: CommandMonitor, now = Date.now()): CommandMonitor {
  const record = { ...monitor };
  if (record.state === "cancelling") {
    record.state = "cancelled";
    delete record.exitCode;
    record.endedAt = toSwiftDate(now);
    record.wake = "suppressed";
    record.detail = "Cancellation was requested before restart. Final exit status is unknown; no rerun or callback was sent.";
  } else if (isActive(record)) {
    const awaiting = record.state === "awaitingApproval";
    record.state = "interrupted";
    delete record.exitCode;
    record.endedAt = toSwiftDate(now);
    record.detail = awaiting
      ? "Restarted while awaiting approval. The command was not started; no rerun was performed."
      : "The app-server session ended before a terminal result was saved. Execution may have had side effects. Exit status is unknown; the command was not rerun.";
    record.wake = "pending";
  } else if (record.wake === "dispatching") {
    // There is no idempotency key for turn/start: a replay after a crash could run a second continuation.
    record.wake = "uncertain";
    record.detail += " Callback dispatch was interrupted before acknowledgement; inspect the owner thread and monitor status before continuing. No duplicate wake was sent.";
  }
  return record;
}

function valid(value: unknown, owner: string): value is CommandMonitor {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return typeof m.id === "string" && typeof m.owner === "string" && m.owner.toLowerCase() === owner.toLowerCase() && typeof m.command === "string" && typeof m.cwd === "string"
    && typeof m.state === "string" && typeof m.wake === "string" && typeof m.createdAt === "number";
}

const file = (folder: string, session: string) => join(folder, `${session.toLowerCase()}.monitors.json`);

/** A session's monitors (`CodexThreads.monitors(for:)`); a file that is not this session's is an error, never empty. */
export function loadMonitors(folder: string, session: string): CommandMonitor[] {
  const path = file(folder, session);
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(value) || !value.every((entry) => valid(entry, session)) || new Set(value.map((entry: CommandMonitor) => entry.id)).size !== value.length) {
    throw new Error(`${path} is not this session's monitor list`);
  }
  return value.map((entry: CommandMonitor) => ({ ...entry, stdout: entry.stdout ?? "", stderr: entry.stderr ?? "", detail: entry.detail ?? "" }));
}

export function saveMonitors(folder: string, session: string, records: CommandMonitor[]) {
  mkdirSync(folder, { recursive: true });
  writeFileAtomic(file(folder, session), JSON.stringify(records));
}
