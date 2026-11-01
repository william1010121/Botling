// The worker status vocabulary and every view derived from it (shared-core spec 3.1, 3.4). The ledger record's
// `status` + `report.state` + `cleanup` is the one truth; WorkerInfo.state, subagents.json, agents.json, the chat chip
// and a step's failed flag are projections of it through the functions below, and nowhere else.
import type { WorkerState } from "../agent/workers";
import type { AgentState } from "../agent-registry";
import type { SubagentStatus } from "../subagents";
import type { WorkerLedgerRecord } from "./ledger";

export { wireStatus } from "./report";

/** THE worker status. Every other status in the app is derived from this. */
export type WorkerStatus = "new" | "running" | "done" | "failed" | "stopped" | "interrupted";

/** Where its latest run's report is. */
export type ReportState =
  | "none"          // nothing owed (running, stopped, or a new worker)
  | "pending"       // ended; waiting for the coordinator to take it
  | "dispatching"   // being handed over right now (agy beginReport; Codex `active`)
  | "delivered"     // the coordinator took it; checkpoint policy: waiting for its decision
  | "acknowledged"  // done with it (policy none: at delivery; checkpoint: a checkpoint or same-task follow-up)
  | "unresolved"    // checkpoint policy: no decision after the allowed attempts — needs an explicit decision
  | "routed";       // another bot owns it: emitted as workerReport for the app to route

/** The chat chip's statuses a worker can have. */
export type WorkerChipStatus = "running" | "completed" | "failed" | "killed" | "interrupted";

type Projected = Pick<WorkerLedgerRecord, "status" | "report" | "cleanup" | "adapter">;

/** A report the coordinator still has to take (or decide on). */
export const reportOwed = (state: ReportState) => state === "pending" || state === "dispatching" || state === "delivered";

/** Whether the record shows as failed whatever its status: a failed process cleanup or an unresolved report. */
const showsFailed = (r: Projected) => r.cleanup === "failed" || (r.report.state === "unresolved" && (r.status === "done" || r.status === "failed"));

/** WorkerInfo.state. A worker that was never started (`new`) is idle: a follow-up starts its first run. */
export function workerState(r: Projected): WorkerState {
  if (showsFailed(r)) return "failed";
  if (r.status === "running") return "running";
  switch (r.status) {
    case "done": return reportOwed(r.report.state) ? "reportPending" : "idle";
    case "failed": return reportOwed(r.report.state) ? "reportPending" : "failed";
    case "stopped": return "stopped";
    case "interrupted": return "interrupted";
    default: return "idle";
  }
}

/** subagents.json's status (the row's four). */
export function subagentStatus(r: Projected): SubagentStatus {
  if (showsFailed(r)) return "failed";
  if (r.status === "running") return "running";
  switch (r.status) {
    case "done": return "completed";
    case "failed": return "failed";
    default: return "stopped";
  }
}

/** agents.json's state. The component editor's done run is completed (it takes no follow-up), any other worker's idle. */
export function agentState(r: Projected): AgentState {
  if (showsFailed(r)) return "failed";
  if (r.status === "running") return "running";
  switch (r.status) {
    case "done":
      if (reportOwed(r.report.state)) return "reportPending";
      return r.adapter === "component-editor" && r.report.state !== "routed" ? "completed" : "idle";
    case "failed": return "failed";
    case "stopped": return "stopped";
    case "interrupted": return "interrupted";
    default: return "idle";
  }
}

/** The chat chip's status. */
export function chipStatus(r: Projected): WorkerChipStatus {
  if (showsFailed(r)) return "failed";
  if (r.status === "running") return "running";
  switch (r.status) {
    case "done": return "completed";
    case "failed": return "failed";
    case "interrupted": return "interrupted";
    default: return "killed";
  }
}

/** Whether the worker's step in the coordinator's turn shows as failed. */
export function stepFailed(r: Projected): boolean {
  return showsFailed(r) || r.status === "failed";
}
