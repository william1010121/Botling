// The one source of worker state (shared-core spec 3.2): <member store>/worker-ledger.json, written only by that
// member's WorkerCore and only at state transitions (launch, end, report state, owner, process, session), never for
// text or usage. Until S4b switches to it, the engines keep their own journals through the LegacyStores (migrate.ts),
// which implement the same `WorkerStore`.
import { readFileSync, statSync } from "node:fs";
import { writeFileAtomic } from "../durable/atomic";
import type { Engine } from "../heads";
import { readWorkerOwner, type ProcessIdentity, type WorkerOwner } from "../agent/workers";
import type { RunStatus } from "./classify";
import type { WorkerAdapterKind } from "./events";
import type { ReportState, WorkerStatus } from "./status";
import { importLegacy, legacyFiles, type LegacySources } from "./migrate";

/** A checkpoint the coordinator made on a report (app_task_checkpoint). */
export interface ReportCheckpoint { outcome: string; evidence: string; dependencyTaskId?: string }

/** Its latest run's report and where it is. */
export interface WorkerReportRecord {
  state: ReportState;
  /** The report's words (kept after delivery; null before the first end). */
  text: string | null;
  status: RunStatus | null;
  /** Deliveries to the coordinator so far (checkpoint policy: at most 2). */
  attempts: number;
  checkpoint?: ReportCheckpoint;
}

export interface WorkerLedgerRecord {
  v: 3;
  /** Task id (a UUID). */
  id: string;
  /** What it runs on. */
  engine: Engine;
  adapter: WorkerAdapterKind;
  name: string;
  instructions: string;
  /** subagent_type (Claude definitions). */
  type: string | null;
  /** The coordinator conversation that started it (a session-scoped core lists only its own). */
  ownerSessionId: string;
  run: number;
  status: WorkerStatus;
  report: WorkerReportRecord;
  /** Claude session / Codex thread / ACP session (null: not known yet). */
  conversationId: string | null;
  /** Newest 8. */
  processes: ProcessIdentity[];
  /** Cache of the registry's owner (the registry stays authoritative: syncWorkerOwners). */
  owner?: WorkerOwner;
  createdAt: number;
  runStartedAt: number | null;
  endedAt: number | null;
  interruptedBy?: "quit" | "restart" | "crash";
  /** Crash recovery must verify its old processes are gone before a follow-up (agy recoveryRequired; Claude interrupted). */
  recovery?: "required";
  /** Process cleanup after the run: "pending" holds its report back; "failed" blocks follow-ups until recovery (agy cleanup-failed). */
  cleanup?: "pending" | "failed";
  /** Engine-only data the core never reads (spec 4.2: Claude sessionId/model, Codex thread/turn/restart data, …). */
  engineData: Record<string, unknown>;
}

export interface WorkerStore {
  load(): WorkerLedgerRecord[];
  /** Atomic, whole file. */
  save(records: readonly WorkerLedgerRecord[]): void;
}

/** Records a store keeps at most (claude-workers.ts's limit). */
export const MAX_WORKER_RECORDS = 200;
export const MAX_PROCESSES = 8;

const STATUSES = new Set<WorkerStatus>(["new", "running", "done", "failed", "stopped", "interrupted"]);
const REPORT_STATES = new Set<ReportState>(["none", "pending", "dispatching", "delivered", "acknowledged", "unresolved", "routed"]);
const RUN_STATUSES = new Set<RunStatus>(["done", "failed", "stopped", "interrupted"]);
const ADAPTERS = new Set<WorkerAdapterKind>(["claude-process", "codex-thread", "agy-acp", "component-editor"]);
const ENGINES = new Set<Engine>(["claude", "codex", "agy"]);

const str = (v: unknown): v is string => typeof v === "string";
const time = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** Valid process identities, newest `MAX_PROCESSES`. */
export function readProcesses(value: unknown): ProcessIdentity[] {
  return Array.isArray(value)
    ? value.filter((p) => p && Number.isSafeInteger(p.pid) && p.pid > 0 && str(p.started) && p.started).map((p) => ({ pid: p.pid, started: p.started })).slice(-MAX_PROCESSES)
    : [];
}

/** A ledger record as saved, or null when it is not one. */
export function readLedgerRecord(value: unknown): WorkerLedgerRecord | null {
  const r = value as Record<string, any> | null;
  if (!r || typeof r !== "object" || r.v !== 3 || !str(r.id) || !r.id || !ENGINES.has(r.engine) || !ADAPTERS.has(r.adapter)) return null;
  if (!str(r.name) || !str(r.instructions) || !str(r.ownerSessionId) || !Number.isSafeInteger(r.run) || r.run < 0 || !STATUSES.has(r.status)) return null;
  const report = r.report as Record<string, any> | null;
  if (!report || typeof report !== "object" || !REPORT_STATES.has(report.state)) return null;
  const checkpoint = report.checkpoint && str(report.checkpoint.outcome) && str(report.checkpoint.evidence)
    ? { outcome: report.checkpoint.outcome, evidence: report.checkpoint.evidence, ...(str(report.checkpoint.dependencyTaskId) ? { dependencyTaskId: report.checkpoint.dependencyTaskId } : {}) }
    : undefined;
  const owner = readWorkerOwner(r.owner);
  return {
    v: 3, id: r.id, engine: r.engine, adapter: r.adapter, name: r.name, instructions: r.instructions, type: str(r.type) ? r.type : null,
    ownerSessionId: r.ownerSessionId, run: r.run, status: r.status,
    report: { state: report.state, text: str(report.text) ? report.text : null, status: RUN_STATUSES.has(report.status) ? report.status : null,
      attempts: Number.isSafeInteger(report.attempts) && report.attempts >= 0 ? report.attempts : 0, ...(checkpoint ? { checkpoint } : {}) },
    conversationId: str(r.conversationId) && r.conversationId ? r.conversationId : null,
    processes: readProcesses(r.processes),
    ...(owner ? { owner } : {}),
    createdAt: time(r.createdAt) ?? 0, runStartedAt: time(r.runStartedAt), endedAt: time(r.endedAt),
    ...(r.interruptedBy === "quit" || r.interruptedBy === "restart" || r.interruptedBy === "crash" ? { interruptedBy: r.interruptedBy } : {}),
    ...(r.recovery === "required" ? { recovery: "required" as const } : {}),
    ...(r.cleanup === "pending" || r.cleanup === "failed" ? { cleanup: r.cleanup } : {}),
    engineData: r.engineData && typeof r.engineData === "object" && !Array.isArray(r.engineData) ? { ...r.engineData } : {},
  };
}

/**
 * The newest `max` records, dropping the oldest that are safe to forget: not running, owing no report, no cleanup or
 * recovery outstanding, and not `live` (a process the core still holds). Order is kept.
 */
export function trimRecords<T extends WorkerLedgerRecord>(records: readonly T[], max = MAX_WORKER_RECORDS, live: (id: string) => boolean = () => false): T[] {
  let excess = records.length - max;
  if (excess <= 0) return [...records];
  return records.filter((r) => {
    if (excess <= 0) return true;
    const forgettable = r.status !== "running" && r.report.state !== "pending" && r.report.state !== "dispatching" && r.report.state !== "delivered"
      && !r.cleanup && !r.recovery && !live(r.id);
    if (forgettable) excess -= 1;
    return !forgettable;
  });
}

interface LedgerFile { version: 3; imported: { file: string; mtimeMs: number }[]; records: WorkerLedgerRecord[] }

/**
 * <member store>/worker-ledger.json. Loading reads the ledger, then imports each legacy journal it has not imported
 * yet (records it does not have; the journal itself is never renamed or deleted, so a downgrade still finds it).
 */
export class WorkerLedger implements WorkerStore {
  private imported: { file: string; mtimeMs: number }[] = [];

  constructor(readonly file: string, private legacy: LegacySources = {}) {}

  load(): WorkerLedgerRecord[] {
    let saved: Partial<LedgerFile> | null = null;
    try { saved = JSON.parse(readFileSync(this.file, "utf8")); } catch { saved = null; }
    const records = saved?.version === 3 && Array.isArray(saved.records) ? saved.records.map(readLedgerRecord).filter((r): r is WorkerLedgerRecord => !!r) : [];
    this.imported = saved?.version === 3 && Array.isArray(saved.imported)
      ? saved.imported.filter((i) => i && str(i.file) && typeof i.mtimeMs === "number") : [];
    const done = new Set(this.imported.map((i) => i.file));
    const fresh: LegacySources = {};
    const files = legacyFiles(this.legacy);
    if (files.claude && !done.has(files.claude)) fresh.claudeFile = this.legacy.claudeFile;
    if (files.agy && !done.has(files.agy)) fresh.agy = this.legacy.agy;
    if (files.codex && !done.has(files.codex)) fresh.codex = this.legacy.codex;
    const added = importLegacy(fresh, new Set(records.map((r) => r.id)));
    const newly = [files.claude && fresh.claudeFile ? files.claude : null, files.agy && fresh.agy ? files.agy : null, files.codex && fresh.codex ? files.codex : null]
      .filter((f): f is string => !!f).flatMap((file) => { try { return [{ file, mtimeMs: statSync(file).mtimeMs }]; } catch { return []; } });
    const all = [...records, ...added];
    if (newly.length) {
      this.imported = [...this.imported, ...newly];
      this.save(all);
    }
    return all;
  }

  save(records: readonly WorkerLedgerRecord[]): void {
    const file: LedgerFile = { version: 3, imported: this.imported, records: trimRecords(records) };
    writeFileAtomic(this.file, JSON.stringify(file));
  }
}
