// A task card keeps a short timeline of its updates (`history`), so the panel's hover card can show
// the task from its start to now: started, each new Now, waiting on you, your reply, subagents
// linked, done / stopped / marked complete by you.
import { describe, expect, it } from "vitest";
import { taskView } from "../../src/core/bot";
import { TaskBook, readTaskCard, type TaskTurn } from "../../src/core/tasks";

const turn = (userMessage: string, extra: Partial<TaskTurn> = {}): TaskTurn => ({ head: "claude", userMessage, started: 0, usedTools: true, ...extra });
const kinds = (book: TaskBook, name: string) => (book.named(name)!.history ?? []).map((event) => [event.kind, event.at, event.text ?? null]);

describe("task history", () => {
  it("records start, each new Now, waiting, your reply, a subagent and done", () => {
    const book = new TaskBook();
    book.begin("m1", "fix the launch", null, 10);
    book.replied("r1", turn("m1"), [{ name: "Fix launch", now: "Reading launch logs", state: "running" }], 12);
    book.link("agent-1", book.named("Fix launch")!.id, 13);
    // The same Now said again is not a new event.
    book.replied("r2", turn("m9"), [{ continues: "Fix launch", now: "Reading launch logs", state: "running" }], 14);
    book.replied("r3", turn("m9"), [{ continues: "Fix launch", blocked: "Read ~/Library/Logs?", state: "waiting" }], 15);
    book.begin("m2", "Yes", null, 16, "r3");
    book.replied("r4", turn("m2"), [{ continues: "Fix launch", now: "Rebuilding the bundle", state: "running" }], 17);
    book.replied("r5", turn("m9"), [{ continues: "Fix launch", state: "done" }], 18);
    expect(kinds(book, "Fix launch")).toEqual([
      ["start", 10, null],
      ["now", 12, "Reading launch logs"],
      ["subagent", 13, "agent-1"],
      ["waiting", 15, "Read ~/Library/Logs?"],
      ["you", 16, "Yes"],
      ["now", 17, "Rebuilding the bundle"],
      ["done", 18, null],
    ]);
  });

  it("records Mark complete without inferring acceptance from a silent state", () => {
    const book = new TaskBook();
    book.begin("m1", "ship", null, 1);
    book.replied("r1", turn("m1"), [{ name: "Ship", now: "tagging", state: "running" }], 2);
    expect(book.complete(book.named("Ship")!.id, 3)).toBe(true);
    expect(kinds(book, "Ship").at(-1)).toEqual(["complete", 3, null]);
    const other = new TaskBook();
    other.begin("m1", "docs", null, 1);
    other.replied("r1", turn("m1"), [{ name: "Docs", now: "writing" }], 2); // No explicit completion: retain the work state.
    expect(kinds(other, "Docs").at(-1)).toEqual(["now", 2, "writing"]);
    expect(other.named("Docs")!.state).toBe("running");
  });

  it("keeps a bounded history and survives a reload; bad entries are dropped", () => {
    const book = new TaskBook();
    book.begin("m1", "loop", null, 0);
    book.replied("r0", turn("m1"), [{ name: "Loop", now: "step 0", state: "running" }], 1);
    for (let index = 1; index < 80; index += 1) book.replied(`r${index}`, turn("m9"), [{ continues: "Loop", now: `step ${index}`, state: "running" }], index + 1);
    const history = book.named("Loop")!.history!;
    expect(history.length).toBeLessThanOrEqual(40);
    expect(history[0]).toMatchObject({ kind: "start", at: 0 });
    expect(history.at(-1)).toMatchObject({ kind: "now", text: "step 79" });
    const raw = JSON.parse(JSON.stringify(book.named("Loop")));
    raw.history.push({ kind: "bogus", at: 5 }, { kind: "now", at: "x" }, null);
    const read = readTaskCard(raw)!;
    expect(read.history).toEqual(history);
  });

  it("is in the task's view, with its start date", () => {
    const view = taskView({ id: "T", name: "Docs", state: "running", createdAt: 0, updatedAt: 60, messageIDs: [], kept: true,
      history: [{ kind: "start", at: 0 }, { kind: "now", at: 60, text: "writing" }] }, new Set());
    expect(view.createdAt).toBe("2001-01-01T00:00:00.000Z");
    expect(view.history).toEqual([
      { kind: "start", at: "2001-01-01T00:00:00.000Z", text: null },
      { kind: "now", at: "2001-01-01T00:01:00.000Z", text: "writing" },
    ]);
    expect(taskView({ id: "T", name: "Docs", state: "running", createdAt: 0, updatedAt: 0, messageIDs: [], kept: true }, new Set()).history).toBeUndefined();
  });
});
