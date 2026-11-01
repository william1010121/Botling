// subagents.json's worker records as projections of the worker ledger (shared-core spec 3.5, slice S4a): project()
// overwrites a worker's status/endedAt/result whatever it was (not first-writer-wins), and with the projection on
// (S4b turns it on) an engine's end notice no longer ends a worker. Off, everything is as before.
import { describe, expect, it } from "vitest";
import { SubagentBook } from "../../src/core/subagents";

const started = (book: SubagentBook, id: string, type: string | null) =>
  book.started({ id, description: `Task ${id}`, type, prompt: "do it", background: true }, 100);

describe("SubagentBook worker projection", () => {
  it("off (until S4b): an end notice ends a worker as before, first one wins", () => {
    const book = new SubagentBook();
    started(book, "w1", "codex-worker");
    expect(book.ended({ id: "w1", status: "failed", summary: "boom" }, 200)?.status).toBe("failed");
    expect(book.ended({ id: "w1", status: "completed", summary: "late" }, 300)).toBeNull();
    expect(book.get("w1")).toMatchObject({ status: "failed", endedAt: 200, result: "boom" });
  });

  it("on: an end notice changes no worker of any engine (the ledger decides); other subagents still end", () => {
    const book = new SubagentBook();
    book.workerProjection = true;
    for (const [id, type] of [["c", "claude-worker"], ["x", "codex-worker"], ["a", "agy-worker"], ["e", "ccb-core:component-editor"]] as const) {
      started(book, id, type);
      expect(book.ended({ id, status: "completed", summary: "done" }, 200), type).toBeNull();
      expect(book.get(id), type).toMatchObject({ status: "running" });
      expect(book.get(id)?.endedAt, type).toBeUndefined();
    }
    started(book, "s", "general-purpose");
    expect(book.ended({ id: "s", status: "completed", summary: "found it" }, 200)).toMatchObject({ status: "completed", result: "found it" });
  });

  it("project() overwrites a worker's status, end and result, also after an earlier end (not first-writer-wins)", () => {
    const book = new SubagentBook();
    started(book, "w1", "agy-worker");
    expect(book.project("w1", { status: "completed", endedAt: 200, result: "All done." })).toMatchObject({ status: "completed", endedAt: 200, result: "All done." });
    // An unresolved report later shows as failed.
    expect(book.project("w1", { status: "failed", endedAt: 200, result: null })).toMatchObject({ status: "failed", endedAt: 200, result: "All done." });
    // The same view again changes nothing.
    expect(book.project("w1", { status: "failed", endedAt: 200, result: null })).toBeNull();
  });

  it("project() back to running clears the end; no words keep the last report", () => {
    const book = new SubagentBook();
    started(book, "w1", "claude-worker");
    book.project("w1", { status: "stopped", endedAt: 150, result: "Stopped by the app; its work was not finished." });
    const record = book.project("w1", { status: "running", endedAt: null, result: null });
    expect(record).toMatchObject({ status: "running", result: "Stopped by the app; its work was not finished." });
    expect(record?.endedAt).toBeUndefined();
  });

  it("project() leaves unknown ids and non-worker subagents alone", () => {
    const book = new SubagentBook();
    started(book, "s", "Explore");
    expect(book.project("s", { status: "failed", endedAt: 200, result: "x" })).toBeNull();
    expect(book.get("s")).toMatchObject({ status: "running" });
    expect(book.project("missing", { status: "failed", endedAt: 200, result: "x" })).toBeNull();
  });
});

describe("SubagentBook.project() end times", () => {
  it("an end without a time keeps the one it has, else now", () => {
    const book = new SubagentBook();
    started(book, "w1", "codex-worker");
    expect(book.project("w1", { status: "completed", endedAt: null, result: "ok" }, 400)).toMatchObject({ endedAt: 400 });
    expect(book.project("w1", { status: "failed", endedAt: null, result: null }, 500)).toMatchObject({ status: "failed", endedAt: 400 });
  });
});
