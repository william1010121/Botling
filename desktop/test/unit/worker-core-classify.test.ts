// classifyRun (shared-core spec 2.3): one test per row of the table, in order, plus the order itself (the first row
// that fits decides) and the wire words reports carry.
import { describe, expect, it } from "vitest";
import { classifyRun, INTERRUPTED_REPORT, NO_REPORT, NO_RESULT, STOPPED_REPORT, type RunFacts } from "../../src/core/worker-core/classify";
import { wireStatus } from "../../src/core/worker-core/report";
import type { RunEnd } from "../../src/core/worker-core/events";
import { parseLine } from "../../src/core/agent/stream";

const end = (how: RunEnd["how"], over: Partial<RunEnd> = {}): RunEnd => ({ how, finalText: null, error: null, detail: "", ...over });
const facts = (over: Partial<RunFacts>): RunFacts => ({ end: end("normal"), reply: "", stoppedByApp: false, interruptedBy: null, requireReply: true, failedTools: 0, ...over });

describe("classifyRun: the table of spec 2.3, row by row", () => {
  it("1: stopped by the app → stopped, whatever the engine said", () => {
    expect(classifyRun(facts({ stoppedByApp: true, reply: "DONE", interruptedBy: "quit" }))).toMatchObject({ status: "stopped", report: STOPPED_REPORT });
    expect(STOPPED_REPORT).toBe("Stopped by the app; its work was not finished.");
  });

  it("2: interrupted (quit, restart, crash) → interrupted, with the reason's sentence and no replay", () => {
    for (const by of ["quit", "restart", "crash"] as const) {
      const verdict = classifyRun(facts({ end: null, interruptedBy: by }));
      expect(verdict).toMatchObject({ status: "interrupted", report: INTERRUPTED_REPORT[by] });
      expect(verdict.report).toContain("Nothing was replayed; continue it with app_send_message");
    }
    expect(INTERRUPTED_REPORT.quit).toBe("Interrupted when the app quit. Nothing was replayed; continue it with app_send_message (it resumes its session).");
  });

  it("3: normal end with a reply → done with the reply, even after failed tools (the user's rule)", () => {
    expect(classifyRun(facts({ reply: "  DONE — git failed as expected.\n" }))).toMatchObject({ status: "done", report: "DONE — git failed as expected." });
    expect(classifyRun(facts({ reply: "DONE", failedTools: 3 }))).toMatchObject({ status: "done", report: "DONE" });
    expect(classifyRun(facts({ reply: "DONE", failedTools: 1, requireReply: false }))).toMatchObject({ status: "done", report: "DONE" });
  });

  it("4: normal end, no reply, a reply required (workers) → failed, ask for the missing result", () => {
    expect(classifyRun(facts({ reply: "  \n" }))).toMatchObject({ status: "failed", report: NO_REPORT });
    expect(NO_REPORT).toBe("The worker ended without a report. Ask the same task_id for the missing result.");
  });

  it("5: normal end, no reply, silence allowed (head), no failed tool → done with nothing to say", () => {
    expect(classifyRun(facts({ requireReply: false }))).toMatchObject({ status: "done", report: "" });
  });

  it("6: normal end, no reply, silence allowed, a failed tool → failed (the agy head's rule)", () => {
    expect(classifyRun(facts({ requireReply: false, failedTools: 1, engine: "agy" }))).toMatchObject({ status: "failed", report: "Antigravity stopped after a failed tool." });
    expect(classifyRun(facts({ requireReply: false, failedTools: 2 })).report).toBe("The agent stopped after a failed tool.");
  });

  it("7: the engine cancelled the turn → stopped, with its words or \"Cancelled.\"", () => {
    expect(classifyRun(facts({ end: end("cancelled", { error: "Turn interrupted." }), reply: "half" }))).toMatchObject({ status: "stopped", report: "Turn interrupted." });
    expect(classifyRun(facts({ end: end("cancelled") }))).toMatchObject({ status: "stopped", report: "Cancelled." });
  });

  it("8: an engine error or a process exit → failed, its error then any reply", () => {
    expect(classifyRun(facts({ end: end("error", { error: "API Error: overloaded" }) }))).toMatchObject({ status: "failed", report: "API Error: overloaded" });
    expect(classifyRun(facts({ end: end("error", { error: "boom" }), reply: "partial words" }))).toMatchObject({ status: "failed", report: "boom\n\npartial words" });
    expect(classifyRun(facts({ end: end("exited", { error: "exit 137\nKilled" }) }))).toMatchObject({ status: "failed", report: "exit 137\nKilled" });
    expect(classifyRun(facts({ end: end("exited") })).report).toBe("The worker's process ended before its report.");
    expect(classifyRun(facts({ end: end("error") })).report).toBe("The worker's run failed.");
  });

  it("9: no end at all (and not stopped or interrupted) → failed", () => {
    expect(classifyRun(facts({ end: null, reply: "words" }))).toMatchObject({ status: "failed", report: NO_RESULT });
  });

  it("an error end with a reply is still failed: only a normal end makes a reply a success", () => {
    expect(classifyRun(facts({ end: end("error", { error: "x" }), reply: "DONE" })).status).toBe("failed");
  });

  it("wire words stay the coordinators' (never \"killed\")", () => {
    expect([wireStatus("done"), wireStatus("failed"), wireStatus("stopped"), wireStatus("interrupted")]).toEqual(["completed", "failed", "stopped", "interrupted"]);
  });
});

describe("claude's result line carries how it ended (parseLine, spec 2.8)", () => {
  const result = (line: object) => parseLine(JSON.stringify({ type: "result", ...line })).find((item) => item.kind === "result");
  it("success → normal; an error subtype or is_error → error; ok unchanged", () => {
    expect(result({ subtype: "success", is_error: false, result: "DONE" })).toMatchObject({ ok: true, how: "normal", text: "DONE" });
    expect(result({ subtype: "error_max_turns", result: "" })).toMatchObject({ ok: false, how: "error" });
    expect(result({ subtype: "success", is_error: true, result: "API Error" })).toMatchObject({ ok: false, how: "error", error: "API Error" });
  });
});
