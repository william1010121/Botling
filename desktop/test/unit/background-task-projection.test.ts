// A worker's chat chip as a projection of the worker ledger (shared-core spec 3.4, 3.5; slice S4a): chipStatus of the
// record overwrites the chip whatever it said (not first-writer-wins, unlike endBackgroundTask for other chips).
import { describe, expect, it } from "vitest";
import { backgroundTask, endBackgroundTask, projectBackgroundTask } from "../../src/core/background-tasks";
import type { ChatRecord } from "../../src/core/store/records";
import type { WorkerLedgerRecord } from "../../src/core/worker-core";

type Projected = Pick<WorkerLedgerRecord, "status" | "report" | "cleanup" | "adapter">;
const ledger = (status: Projected["status"], report: Projected["report"]["state"] = "none", extra: Partial<Projected> = {}): Projected =>
  ({ status, report: { state: report, text: null, status: null, attempts: 0 }, adapter: "codex-thread", ...extra });

const chat = (): ChatRecord[] => [
  { id: "m1", role: "bot", text: "Sent a worker.", date: 0, backgroundTasks: [backgroundTask("w1", "agent", "Fix the build", undefined, 10)] } as ChatRecord,
  { id: "m2", role: "bot", text: "Later.", date: 1 } as ChatRecord,
];
const chip = (records: ChatRecord[]) => (records[0]!.backgroundTasks as { status: string; endedAt?: number; summary?: string }[])[0]!;

describe("projectBackgroundTask", () => {
  it("each ledger state gives its chip status (status.ts chipStatus)", () => {
    const cases: [Projected, string][] = [
      [ledger("running"), "running"],
      [ledger("done", "pending"), "completed"],
      [ledger("done", "acknowledged"), "completed"],
      [ledger("done", "unresolved"), "failed"],
      [ledger("failed", "pending"), "failed"],
      [ledger("stopped"), "killed"],
      [ledger("interrupted"), "interrupted"],
      [ledger("done", "acknowledged", { cleanup: "failed" }), "failed"],
    ];
    for (const [record, status] of cases) {
      const records = chat();
      projectBackgroundTask(records, "w1", record, null, 50);
      expect(chip(records).status, JSON.stringify(record)).toBe(status);
    }
  });

  it("overwrites an earlier end (not first-writer-wins) and keeps when it ended", () => {
    const records = chat();
    endBackgroundTask(records, "w1", "completed", "Fixed.", 40);
    expect(projectBackgroundTask(records, "w1", ledger("done", "unresolved"), null, 60)).toBe(records[0]);
    expect(chip(records)).toMatchObject({ status: "failed", endedAt: 40, summary: "Fixed." });
  });

  it("an end sets when it ended and its summary; the same view again changes nothing", () => {
    const records = chat();
    expect(projectBackgroundTask(records, "w1", ledger("done", "pending"), "Fixed the build.", 50)).toBe(records[0]);
    expect(chip(records)).toMatchObject({ status: "completed", endedAt: 50, summary: "Fixed the build." });
    expect(projectBackgroundTask(records, "w1", ledger("done", "acknowledged"), "Fixed the build.", 70)).toBeNull();
  });

  it("a new run puts the chip back to running", () => {
    const records = chat();
    projectBackgroundTask(records, "w1", ledger("failed"), "It broke.", 50);
    projectBackgroundTask(records, "w1", ledger("running"), null, 80);
    expect(chip(records).status).toBe("running");
    expect(chip(records).endedAt).toBeUndefined();
  });

  it("no chip with that id: nothing changes", () => {
    expect(projectBackgroundTask(chat(), "other", ledger("done", "pending"), null, 50)).toBeNull();
  });
});
