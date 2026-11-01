// RunAccounting and costDelta (shared-core spec 2.4), the report format (2.5) and the blank-bubble rule (2.7).
import { describe, expect, it } from "vitest";
import { costDelta, RunAccounting, runCounter } from "../../src/core/worker-core/accounting";
import { deniedNote, ownedWorkerReport, REPORT_LIMIT, REPORT_TAIL, reportPayload, reportTag, withDeniedNote, workerReportText } from "../../src/core/worker-core/report";
import { ownedWorkerReport as workersOwned, workerReportText as workersText } from "../../src/core/agent/workers";
import { hasVisibleContent, type TurnContent } from "../../src/core/worker-core/visible";
import type { AdapterMeasurement } from "../../src/core/worker-core/events";

const tokens = (output: number) => ({ input: 10, output, cacheRead: 0, cacheWrite: 0 });

describe("costDelta", () => {
  it("turns a process's running total into each turn's spend; a total never goes back", () => {
    const state = { last: 0 };
    expect(costDelta(state, 0.25)).toBe(0.25);
    expect(costDelta(state, 0.4)).toBeCloseTo(0.15);
    expect(costDelta(state, 0.4)).toBe(0);
    expect(costDelta(state, 0.1)).toBe(0); // a stale total: nothing (as bot.ts's sessionCost)
    expect(state.last).toBe(0.4);
    expect(costDelta(state, Number.NaN)).toBe(0);
  });
});

describe("RunAccounting", () => {
  const make = (conversation: string | null = "conv-1") => new RunAccounting({ workerId: "task-1", run: 2, conversationId: () => conversation, parentThreadId: () => "coord-thread" });

  it("usage: the usage item carries the delta; one counter thread:<conversation>:run<n> with the run's output so far", () => {
    const acc = make();
    expect(acc.usage({ type: "usage", tokens: tokens(100), cost: 0.5 })).toEqual([
      { kind: "usage", totalCost: 0.5, tokens: tokens(100) },
      { kind: "subagentOutput", id: "task-1", counter: "thread:conv-1:run2", tokens: 100 },
    ]);
    expect(acc.usage({ type: "usage", tokens: tokens(50), cost: 0.1 })[1]).toEqual({ kind: "subagentOutput", id: "task-1", counter: "thread:conv-1:run2", tokens: 150 });
    expect(acc.outputTokens).toBe(150);
  });

  it("usage without output adds no counter item; negative cost is none", () => {
    expect(make().usage({ type: "usage", tokens: tokens(0), cost: -1 })).toEqual([{ kind: "usage", totalCost: 0, tokens: tokens(0) }]);
  });

  it("the counter falls back to the worker id before its conversation is known", () => {
    expect(runCounter(null, "task-1", 1)).toBe("thread:task-1:run1");
    expect(make(null).usage({ type: "usage", tokens: tokens(5), cost: 0 })[1]).toMatchObject({ counter: "thread:task-1:run2" });
  });

  it("request: scope is the worker id", () => {
    const request = { id: "r1", sample: { tokens: 10, seconds: 1 } } as any;
    expect(make().request({ type: "request", request })).toEqual({ kind: "request", request: { ...request, scope: "task-1" } });
  });

  it("measurement: workerId (prefixed for nested ids), run and the coordinator's thread are stamped", () => {
    const m: AdapterMeasurement = { threadId: "t", turnId: "u", startedAt: 1, endedAt: 2, source: "provider-turn", scope: "exclusive", tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, activities: [], complete: true };
    expect(make().measurement({ type: "measurement", provider: "claude", measurement: m })).toEqual({ kind: "measurement", provider: "claude", measurement: { ...m, workerId: "task-1", run: 2, parentThreadId: "coord-thread" } });
    expect((make().measurement({ type: "measurement", provider: "codex", measurement: { ...m, workerId: "sub", parentThreadId: "own" } }) as any).measurement).toMatchObject({ workerId: "task-1:sub", parentThreadId: "own" });
  });
});

describe("the report format", () => {
  const report = { id: "task-1", run: 2, engine: "claude" as const, status: "done" as const, text: "a <b> c" };

  it("reportTag: the <app_task_result> message, escaped, with the policy's tail; status is the wire word", () => {
    expect(reportTag(report, "none")).toBe(`<app_task_result task_id="task-1" run="2" engine="claude" status="completed">\na &lt;b> c\n</app_task_result>\n${REPORT_TAIL.none}`);
    expect(reportTag({ ...report, engine: "agy", status: "failed" }, "checkpoint")).toContain(`status="failed">`);
    expect(reportTag(report, "checkpoint").endsWith(REPORT_TAIL.checkpoint)).toBe(true);
    expect(REPORT_TAIL.checkpoint).toContain("app_task_checkpoint");
  });

  it("reportPayload: Codex's JSON tool output from the same report", () => {
    expect(reportPayload({ ...report, engine: "codex" }, { name: "Research", threadId: "th", turnId: null, reconciliationAttempt: 1 })).toEqual({
      task_id: "task-1", name: "Research", thread_id: "th", turn_id: null, run: 2, status: "completed", report: "a <b> c",
      completion_scope: "worker_turn", objective_status: "unverified", reconciliation_attempt: 1,
    });
  });

  it("the length limit applies in one place", () => {
    const long = "x".repeat(REPORT_LIMIT + 10);
    expect(reportTag({ ...report, text: long }, "none")).toContain(`${"x".repeat(REPORT_LIMIT)}\n</app_task_result>`);
    expect(ownedWorkerReport({ id: "a", run: 1, engine: "codex", status: "completed", report: long }).report).toHaveLength(REPORT_LIMIT);
  });

  it("workers.ts re-exports the same functions", () => {
    expect(workersText).toBe(workerReportText);
    expect(workersOwned).toBe(ownedWorkerReport);
  });

  it("the denial note (D2)", () => {
    expect(deniedNote(1)).toBe("(1 approval was denied during this run.)");
    expect(withDeniedNote("DONE", 2)).toBe("(2 approvals were denied during this run.)\nDONE");
    expect(withDeniedNote("DONE", 0)).toBe("DONE");
  });
});

describe("hasVisibleContent (blank bubbles)", () => {
  const turn = (over: Partial<TurnContent>): TurnContent => ({ status: "done", body: "", reactionsOnly: false, cards: 0, choices: 0, displays: 0, steps: 0, backgroundTasks: 0, requests: 0, decisionReference: false, handoff: false, error: null, ...over });

  it("a turn that did not succeed always shows (its error)", () => {
    expect(hasVisibleContent(turn({ status: "failed", error: "x" }))).toBe(true);
    expect(hasVisibleContent(turn({ status: "stopped" }))).toBe(true);
  });
  it("a hand-off shows", () => expect(hasVisibleContent(turn({ handoff: true }))).toBe(true));
  it("words, cards, choices, displays, steps, background tasks or a decision show", () => {
    expect(hasVisibleContent(turn({ body: " hi " }))).toBe(true);
    for (const key of ["cards", "choices", "displays", "steps", "backgroundTasks"] as const) expect(hasVisibleContent(turn({ [key]: 1 }))).toBe(true);
    expect(hasVisibleContent(turn({ decisionReference: true }))).toBe(true);
  });
  it("nothing to show → no bubble, whatever started the turn (D5); reactions alone make none", () => {
    expect(hasVisibleContent(turn({ body: "  \n" }))).toBe(false);
    expect(hasVisibleContent(turn({ reactionsOnly: true }))).toBe(false);
  });
});
