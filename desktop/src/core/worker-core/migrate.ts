// The engines' own worker journals and the ledger record (shared-core spec 3.6). `fromLegacy*` read an old record
// into a ledger record by the one table below; `toLegacy*` write a ledger record back in the old shape, which the
// interim LegacyStores use so the facades of S1–S3 keep writing their old files until S4b switches to the ledger.
//
// | old                                         | status      | report.state                                   | other                              |
// |---------------------------------------------|-------------|------------------------------------------------|------------------------------------|
// | Claude active:true (a crash left it)        | interrupted | none                                           | interruptedBy crash, recovery      |
// | completed + reportPending && !reportDelivered | done      | pending                                        |                                    |
// | completed + reportDelivered                 | done        | acknowledged (Claude) / delivered (agy, Codex) | attempts from reviewAttempts       |
// | agy reportDispatching                       | (as is)     | dispatching                                    |                                    |
// | agy checkpoint                              | (as is)     | acknowledged (routed: outcome "moved" + owner) | checkpoint copied                  |
// | failed                                      | failed      | by the report flags                            |                                    |
// | stopped, killed                             | stopped     | none                                           |                                    |
// | interrupted                                 | interrupted | none                                           | recovery                           |
// | agy cleanup-failed                          | failed      | by the report flags                            | cleanup failed, recovery           |
// | agy recoveryRequired / active / cleaning    | interrupted | pending (agy-workers.ts restore)               | recovery                           |
// | Codex wasActive:true                        | interrupted | none                                           | engineData restartSafe/restartTurn |
// | new                                         | new         | none                                           |                                    |
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../durable/atomic";
import { readWorkerOwner, type WorkerOwner } from "../agent/workers";
import type { CodexThreads, WorkerRecord } from "../agent/codex";
import { INTERRUPTED_REPORT, type RunStatus } from "./classify";
import { wireStatus } from "./report";
import { readProcesses, trimRecords, type WorkerLedgerRecord, type WorkerReportRecord, type WorkerStore } from "./ledger";
import type { ReportState, WorkerStatus } from "./status";

/** A Codex member's journal: its CodexThreads and coordinator session. */
export type CodexJournal = Pick<CodexThreads, "folder" | "workers" | "saveWorkers">;

export interface LegacySources { claudeFile?: string; agy?: { acpHome: string; sessionId: string }; codex?: { threads: CodexJournal; session: string } }

/** The journal files these sources name (what the ledger records as imported). */
export function legacyFiles(src: LegacySources): { claude?: string; agy?: string; codex?: string } {
  return {
    ...(src.claudeFile ? { claude: src.claudeFile } : {}),
    ...(src.agy ? { agy: join(src.agy.acpHome, "workers.json") } : {}),
    ...(src.codex ? { codex: join(src.codex.threads.folder, `${src.codex.session.toLowerCase()}.workers.json`) } : {}),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown): v is string => typeof v === "string";
const ownerOf = (value: unknown): { owner?: WorkerOwner } => { const owner = readWorkerOwner(value); return owner ? { owner } : {}; };

/** An old status word as a run status (null: not an ended run's). */
function runStatusOf(status: string): RunStatus | null {
  if (status === "completed" || status === "done") return "done";
  if (status === "failed" || status === "cleanup-failed") return "failed";
  if (status === "stopped" || status === "killed") return "stopped";
  if (status === "interrupted") return "interrupted";
  return null;
}

/** An ended run's status as the ledger keeps it. */
const workerStatusOf = (status: string): WorkerStatus => runStatusOf(status) ?? (status === "new" ? "new" : "interrupted");

/** The old journals' status word for a ledger status. */
function legacyStatus(status: WorkerStatus): string {
  return status === "done" ? "completed" : status;
}

function report(state: ReportState, text: string | null, status: RunStatus | null, attempts = 0, checkpoint?: WorkerReportRecord["checkpoint"]): WorkerReportRecord {
  return { state, text, status, attempts, ...(checkpoint ? { checkpoint } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Claude: <bot store>/claude-workers.json, { version: 1, workers }

/** A claude-workers.json record as a ledger record (null: not a valid one). */
export function fromLegacyClaude(value: unknown): WorkerLedgerRecord | null {
  const r = value as Record<string, any> | null;
  if (!r || typeof r !== "object" || !str(r.id) || !UUID.test(r.id) || !str(r.sessionId) || !UUID.test(r.sessionId) || !Number.isSafeInteger(r.run) || r.run < 0 || !str(r.instructions)) return null;
  const status = str(r.status) ? r.status : "completed";
  const sessionStarted = r.sessionStarted === true;
  const base: Omit<WorkerLedgerRecord, "status" | "report"> = {
    v: 3, id: r.id, engine: "claude", adapter: "claude-process", name: str(r.name) ? r.name : r.instructions.slice(0, 80), instructions: r.instructions,
    type: str(r.type) ? r.type : null, ownerSessionId: "", run: r.run, conversationId: sessionStarted ? r.sessionId : null,
    processes: readProcesses(r.processes), ...ownerOf(r.owner), createdAt: Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
    runStartedAt: null, endedAt: null, engineData: { sessionId: r.sessionId, sessionStarted, model: str(r.model) ? r.model : null },
  };
  const text = str(r.report) ? r.report : null;
  if (r.active === true || status === "running") {
    return { ...base, status: "interrupted", report: report("none", INTERRUPTED_REPORT.crash, "interrupted"), interruptedBy: "crash", recovery: "required" };
  }
  if (r.interrupted === true || status === "interrupted") return { ...base, status: "interrupted", report: report("none", text, "interrupted"), recovery: "required" };
  const ended = workerStatusOf(status);
  if (ended === "stopped" || ended === "new") return { ...base, status: ended, report: report("none", text, ended === "new" ? null : "stopped") };
  const state: ReportState = r.reportPending === true && r.reportDelivered !== true ? "pending" : r.reportDelivered === true ? "acknowledged" : "none";
  return { ...base, status: ended, report: report(state, text, runStatusOf(status), r.reportDelivered === true ? 1 : 0) };
}

/** A ledger record as a claude-workers.json record. */
export function toLegacyClaude(r: WorkerLedgerRecord): Record<string, unknown> {
  const state = r.report.state;
  return {
    id: r.id, name: r.name, type: r.type, instructions: r.instructions,
    sessionId: str(r.engineData.sessionId) ? r.engineData.sessionId : r.conversationId ?? r.id,
    sessionStarted: typeof r.engineData.sessionStarted === "boolean" ? r.engineData.sessionStarted : r.conversationId !== null,
    run: r.run, status: legacyStatus(r.status), active: r.status === "running",
    reportPending: state === "pending" || state === "dispatching",
    reportDelivered: state === "delivered" || state === "acknowledged" || state === "routed" || state === "unresolved",
    ...(r.report.text !== null ? { report: r.report.text } : {}),
    model: str(r.engineData.model) ? r.engineData.model : null, processes: r.processes.map((p) => ({ ...p })),
    interrupted: r.status === "interrupted", createdAt: r.createdAt, ...(r.owner ? { owner: { ...r.owner } } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Antigravity: <acpHome>/workers.json, { version: 2, ownerSessionId, workers }

/** agy-workers.ts's words for a worker found at work after a restart. */
export const AGY_INTERRUPTED_REPORT = "Worker interrupted before confirmed cleanup/result. Process-ledger recovery is required before any explicit continuation; no task was replayed.";

/** An agy workers.json record as a ledger record (null: not a valid one). */
export function fromLegacyAgy(value: unknown, ownerSessionId: string): WorkerLedgerRecord | null {
  const r = value as Record<string, any> | null;
  if (!r || typeof r !== "object" || !str(r.id) || !UUID.test(r.id) || (r.engine !== undefined && r.engine !== "agy" && r.engine !== "codex") || !str(r.sessionId)
    || !Number.isSafeInteger(r.run) || r.run < 1 || !str(r.name) || !str(r.instructions) || !str(r.status) || typeof r.active !== "boolean"
    || typeof r.cleaning !== "boolean" || typeof r.reportPending !== "boolean" || (r.report !== undefined && !str(r.report))) return null;
  const base: Omit<WorkerLedgerRecord, "status" | "report"> = {
    v: 3, id: r.id, engine: r.engine ?? "agy", adapter: "agy-acp", name: r.name, instructions: r.instructions, type: null, ownerSessionId,
    run: r.run, conversationId: r.sessionId || null, processes: readProcesses(r.processes), ...ownerOf(r.owner),
    createdAt: 0, runStartedAt: null, endedAt: null, engineData: {},
  };
  const attempts = Number.isSafeInteger(r.reviewAttempts) && r.reviewAttempts >= 0 ? Math.min(r.reviewAttempts, 2) : 0;
  const checkpoint = r.checkpoint && str(r.checkpoint.outcome) && str(r.checkpoint.evidence)
    ? { outcome: r.checkpoint.outcome, evidence: r.checkpoint.evidence, ...(str(r.checkpoint.dependency_task_id) ? { dependencyTaskId: r.checkpoint.dependency_task_id } : {}) }
    : undefined;
  if (r.active || r.cleaning) {
    return { ...base, status: "interrupted", report: report("pending", AGY_INTERRUPTED_REPORT, "interrupted", attempts), interruptedBy: "crash", recovery: "required" };
  }
  const text = str(r.report) ? r.report : null;
  // The report flags, whatever the status: where the report is.
  const state: ReportState = r.reportDispatching === true ? "dispatching"
    : checkpoint ? (checkpoint.outcome === "moved" && r.owner ? "routed" : "acknowledged")
      : !r.reportPending ? "none"
        : r.reportDelivered !== true ? "pending"
          : attempts >= 2 ? "unresolved" : "delivered";
  const status = runStatusOf(r.status);
  if (r.status === "cleanup-failed") return { ...base, status: "failed", report: report(state, text, "failed", attempts, checkpoint), cleanup: "failed", recovery: "required" };
  if (r.recoveryRequired === true) return { ...base, status: "interrupted", report: report(state, text, "interrupted", attempts, checkpoint), recovery: "required" };
  if (status === "stopped") return { ...base, status: "stopped", report: report(state === "dispatching" ? state : "none", text, "stopped", attempts, checkpoint) };
  if (status === "interrupted") return { ...base, status: "interrupted", report: report(state === "dispatching" ? state : "none", text, "interrupted", attempts, checkpoint), recovery: "required" };
  if (r.status === "new") return { ...base, status: "new", report: report("none", null, null) };
  return { ...base, status: workerStatusOf(r.status), report: report(state, text, status, attempts, checkpoint) };
}

/** A ledger record as an agy workers.json record (null: agy keeps no such record: one never started). */
export function toLegacyAgy(r: WorkerLedgerRecord): Record<string, unknown> | null {
  if (r.run < 1 || r.status === "new") return null;
  const state = r.report.state;
  const owed = state === "pending" || state === "dispatching" || state === "delivered" || state === "unresolved";
  const checkpoint = r.report.checkpoint
    ? { outcome: r.report.checkpoint.outcome, evidence: r.report.checkpoint.evidence, ...(r.report.checkpoint.dependencyTaskId ? { dependency_task_id: r.report.checkpoint.dependencyTaskId } : {}) }
    : state === "routed" ? { outcome: "moved", evidence: `Delivered to its owner ${r.owner?.agentId ?? ""}` } : undefined;
  const status = r.cleanup === "failed" ? "cleanup-failed" : r.status === "interrupted" ? "stopped" : legacyStatus(r.status);
  return {
    id: r.id, engine: r.engine === "codex" ? "codex" : "agy", name: r.name, instructions: r.instructions, sessionId: r.conversationId ?? "", run: r.run,
    active: r.status === "running" && r.cleanup !== "pending", cleaning: r.cleanup === "pending", denied: false,
    ...(r.recovery === "required" ? { recoveryRequired: true } : {}), reportDispatching: state === "dispatching",
    ...(r.report.text !== null ? { report: r.report.text } : {}), status, reportPending: owed,
    reportDelivered: state === "delivered" || state === "unresolved" || state === "acknowledged" || state === "routed",
    reviewAttempts: state === "unresolved" ? 2 : Math.min(r.report.attempts, 2), ...(checkpoint ? { checkpoint } : {}),
    ...(r.owner ? { owner: { ...r.owner } } : {}), processes: r.processes.map((p) => ({ ...p })),
  };
}

// ---------------------------------------------------------------------------------------------
// Codex: codex-threads/<session>.workers.json, WorkerRecord[]

const CODEX_ENGINE_KEYS = ["thread", "turn", "isolatedGit", "ownershipInstructions", "role", "restartSafe", "restartTurn", "editorCheckpoint", "editorSessionConfirmed"] as const;

/** A Codex WorkerRecord as a ledger record. */
export function fromLegacyCodex(r: WorkerRecord, ownerSessionId = ""): WorkerLedgerRecord {
  const editor = r.role === "component-editor";
  const engineData: Record<string, unknown> = {};
  for (const key of CODEX_ENGINE_KEYS) if (r[key] !== undefined) engineData[key] = r[key];
  const base: Omit<WorkerLedgerRecord, "status" | "report"> = {
    v: 3, id: r.id, engine: editor ? "claude" : "codex", adapter: editor ? "component-editor" : "codex-thread", name: r.name, instructions: r.instructions,
    type: null, ownerSessionId, run: r.run, conversationId: r.thread ?? null, processes: [], ...ownerOf(r.owner),
    createdAt: 0, runStartedAt: null, endedAt: null, engineData,
  };
  if (r.wasActive) return { ...base, status: "interrupted", report: report("none", null, "interrupted"), recovery: "required" };
  if (!r.reportPending) return { ...base, status: "done", report: report("acknowledged", r.report ?? null, r.status ? runStatusOf(r.status) : null, 1) };
  const status = runStatusOf(r.status ?? "failed") ?? "failed";
  return { ...base, status: status === "interrupted" ? "interrupted" : status, report: report(r.reportDispatching ? "dispatching" : "pending", r.report ?? null, status) };
}

/** A ledger record as a Codex WorkerRecord. An unresolved report is still pending there (Codex has no such state). */
export function toLegacyCodex(r: WorkerLedgerRecord): WorkerRecord {
  const state = r.report.state;
  const pending = state === "pending" || state === "dispatching" || state === "delivered" || state === "unresolved";
  const record: WorkerRecord = { id: r.id, name: r.name, instructions: r.instructions, run: r.run, wasActive: r.status === "running" || r.status === "interrupted", reportPending: pending };
  for (const key of CODEX_ENGINE_KEYS) if (r.engineData[key] !== undefined) (record as unknown as Record<string, unknown>)[key] = r.engineData[key];
  if (r.conversationId) record.thread = r.conversationId;
  if (state === "dispatching") record.reportDispatching = true;
  if (pending) { record.report = r.report.text ?? ""; record.status = wireStatus(r.report.status ?? "failed"); }
  if (r.owner) record.owner = { ...r.owner };
  return record;
}

// ---------------------------------------------------------------------------------------------
// Import and the interim stores

/** The legacy journals' records the ledger does not have yet (`have`: ids it has). Unreadable journals give none. */
export function importLegacy(src: LegacySources, have: ReadonlySet<string>): WorkerLedgerRecord[] {
  const out: WorkerLedgerRecord[] = [];
  const add = (r: WorkerLedgerRecord | null) => { if (r && !have.has(r.id) && !out.some((o) => o.id === r.id)) out.push(r); };
  if (src.claudeFile) for (const r of readClaudeFile(src.claudeFile)) add(r);
  if (src.agy) for (const r of readAgyFile(src.agy.acpHome, null)) add(r);
  if (src.codex) for (const r of src.codex.threads.workers(src.codex.session)) add(fromLegacyCodex(r, src.codex.session));
  return out;
}

function readClaudeFile(file: string): WorkerLedgerRecord[] {
  let saved: any;
  try { saved = JSON.parse(readFileSync(file, "utf8")); } catch { return []; }
  if (saved?.version !== 1 || !Array.isArray(saved.workers)) return [];
  return saved.workers.slice(-200).map(fromLegacyClaude).filter((r: WorkerLedgerRecord | null): r is WorkerLedgerRecord => !!r);
}

/** Records of an agy workers.json; `owner` set: only that conversation's file (else it throws, as agy-workers.ts does). */
function readAgyFile(acpHome: string, owner: string | null): WorkerLedgerRecord[] {
  let saved: any;
  try { saved = JSON.parse(readFileSync(join(acpHome, "workers.json"), "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || owner === null) return [];
    throw new Error("ACP worker state is unreadable or belongs to another conversation; preserved for recovery.");
  }
  const valid = saved?.version === 2 && str(saved.ownerSessionId) && Array.isArray(saved.workers) && saved.workers.length <= 128;
  if (owner !== null && (!valid || saved.ownerSessionId !== owner)) throw new Error("ACP worker state is unreadable or belongs to another conversation; preserved for recovery.");
  if (!valid) return [];
  const records = saved.workers.map((r: unknown) => fromLegacyAgy(r, saved.ownerSessionId));
  if (owner !== null && records.some((r: WorkerLedgerRecord | null) => !r)) throw new Error("ACP worker state is unreadable or belongs to another conversation; preserved for recovery.");
  return records.filter((r: WorkerLedgerRecord | null): r is WorkerLedgerRecord => !!r);
}

/** Interim store (S1): the Claude facade keeps claude-workers.json. */
export class ClaudeLegacyStore implements WorkerStore {
  constructor(readonly file: string) {}
  load(): WorkerLedgerRecord[] { return readClaudeFile(this.file); }
  save(records: readonly WorkerLedgerRecord[]): void {
    const workers = trimRecords(records.filter((r) => r.adapter === "claude-process")).map(toLegacyClaude);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ version: 1, workers }));
  }
}

/**
 * Interim store (S2): the Antigravity facade keeps <acpHome>/workers.json. Like agy-workers.ts it loads only when
 * resuming, and refuses (throws) a file that is unreadable or another conversation's, leaving it in place.
 */
export class AgyLegacyStore implements WorkerStore {
  constructor(readonly acpHome: string, readonly ownerSessionId: string, private options: { resume: boolean } = { resume: true }) {}
  load(): WorkerLedgerRecord[] { return this.options.resume ? readAgyFile(this.acpHome, this.ownerSessionId) : []; }
  save(records: readonly WorkerLedgerRecord[]): void {
    const workers = records.filter((r) => r.adapter === "agy-acp").map(toLegacyAgy).filter((r): r is Record<string, unknown> => !!r).slice(-128);
    mkdirSync(this.acpHome, { recursive: true });
    writeFileAtomic(join(this.acpHome, "workers.json"), JSON.stringify({ version: 2, ownerSessionId: this.ownerSessionId, workers }));
  }
}

/** Interim store (S3): the Codex facade keeps codex-threads/<session>.workers.json (its workers and component editors). */
export class CodexLegacyStore implements WorkerStore {
  constructor(readonly threads: CodexJournal, readonly session: string) {}
  load(): WorkerLedgerRecord[] { return this.threads.workers(this.session).map((r) => fromLegacyCodex(r, this.session)); }
  save(records: readonly WorkerLedgerRecord[]): void {
    const rows = records.filter((r) => r.adapter === "codex-thread" || r.adapter === "component-editor").map(toLegacyCodex)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.threads.saveWorkers(rows, this.session);
  }
}
