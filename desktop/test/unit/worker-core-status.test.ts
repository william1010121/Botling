// The derived views of a ledger record (shared-core spec 3.4): one test per row of the table, each checking all five
// projections, so a status shows the same everywhere (WorkerInfo, subagents.json, agents.json, chip, step).
import { describe, expect, it } from "vitest";
import { agentState, chipStatus, stepFailed, subagentStatus, workerState, type ReportState, type WorkerStatus } from "../../src/core/worker-core/status";
import type { WorkerLedgerRecord } from "../../src/core/worker-core/ledger";

type Row = Pick<WorkerLedgerRecord, "status" | "report" | "cleanup" | "adapter">;
const rec = (status: WorkerStatus, state: ReportState = "none", over: Partial<Row> = {}): Row =>
  ({ status, report: { state, text: null, status: null, attempts: 0 }, adapter: "claude-process", ...over });
const views = (r: Row) => [workerState(r), subagentStatus(r), agentState(r), chipStatus(r), stepFailed(r)];

describe("projections: the table of spec 3.4, row by row", () => {
  it("running", () => {
    expect(views(rec("running"))).toEqual(["running", "running", "running", "running", false]);
  });

  it("done + report pending / dispatching / delivered", () => {
    for (const state of ["pending", "dispatching", "delivered"] as const)
      expect(views(rec("done", state))).toEqual(["reportPending", "completed", "reportPending", "completed", false]);
  });

  it("done + report acknowledged / none (the component editor's agent state: completed)", () => {
    for (const state of ["acknowledged", "none"] as const) {
      expect(views(rec("done", state))).toEqual(["idle", "completed", "idle", "completed", false]);
      expect(agentState(rec("done", state, { adapter: "component-editor" }))).toBe("completed");
    }
  });

  it("done / failed + report unresolved: failed everywhere", () => {
    for (const status of ["done", "failed"] as const)
      expect(views(rec(status, "unresolved"))).toEqual(["failed", "failed", "failed", "failed", true]);
  });

  it("done + report routed", () => {
    expect(views(rec("done", "routed"))).toEqual(["idle", "completed", "idle", "completed", false]);
  });

  it("failed (any report): failed; WorkerInfo says reportPending while the report waits", () => {
    expect(views(rec("failed", "acknowledged"))).toEqual(["failed", "failed", "failed", "failed", true]);
    expect(views(rec("failed", "none"))).toEqual(["failed", "failed", "failed", "failed", true]);
    for (const state of ["pending", "dispatching", "delivered"] as const)
      expect(views(rec("failed", state))).toEqual(["reportPending", "failed", "failed", "failed", true]);
  });

  it("stopped", () => {
    expect(views(rec("stopped"))).toEqual(["stopped", "stopped", "stopped", "killed", false]);
  });

  it("interrupted", () => {
    expect(views(rec("interrupted"))).toEqual(["interrupted", "stopped", "interrupted", "interrupted", false]);
  });

  it("any + cleanup failed: failed everywhere", () => {
    for (const status of ["done", "failed", "stopped", "interrupted", "running"] as const)
      expect(views(rec(status, "pending", { cleanup: "failed" }))).toEqual(["failed", "failed", "failed", "failed", true]);
  });

  it("a cleanup still pending changes nothing by itself", () => {
    expect(views(rec("done", "pending", { cleanup: "pending" }))).toEqual(views(rec("done", "pending")));
  });

  it("new (never started): idle for a follow-up, stopped in the books", () => {
    expect(views(rec("new"))).toEqual(["idle", "stopped", "idle", "killed", false]);
  });
});
