import { describe, expect, it } from "vitest";
import { TaskBook, readTaskCard, type TaskTurn } from "../../src/core/tasks";

const make = () => {
  const book = new TaskBook();
  const id = book.begin("user", "Docs", "claude", 1);
  return { book, id };
};
const reload = (book: TaskBook) => new TaskBook(JSON.parse(JSON.stringify(book.tasks)).map((raw: unknown) => readTaskCard(raw)!));

describe("manual task closure", () => {
  it.each(["pending", "running", "waiting"] as const)("closes %s durably and keeps delayed owner, other-head and worker reports linked", (state) => {
    let { book, id } = make();
    book.set(id, state, 2);
    book.link("worker", id);
    book.help({ handoffID: "handoff", head: "codex", text: "Check docs" }, id);
    expect(book.complete(id, 3)).toBe(true);
    expect(book.complete(id, 4)).toBe(false);
    book = reload(book);
    expect(book.claim("user", "codex", 5)).toBe(false);
    book.working("user", "Docs", "claude", 6);
    for (const [message, turn] of [
      ["owner", { head: "claude", userMessage: "user" }],
      ["worker-report", { head: "claude", reporting: ["worker"] }],
      ["other-head", { head: "codex", handoffID: "handoff" }],
    ] as [string, TaskTurn][]) {
      book.replied(message, turn, [{ state: "running", now: "late progress" }], 7);
    }
    book.replied("untagged", { head: "claude", userMessage: "user", asks: true }, [], 8);
    book.replied("named", { head: "claude" }, [{ name: "Docs", state: "waiting" }], 9);
    book.replied("continued", { head: "claude" }, [{ continues: "Docs", state: "running" }], 10);
    book.set(id, "running", 11);
    expect(book.tasks).toHaveLength(1);
    expect(book.task(id)).toMatchObject({ state: "done", kept: true, manuallyCompletedAt: 3, updatedAt: 3, owner: "claude", subagentIDs: ["worker"], messageIDs: ["user", "owner", "worker-report", "other-head", "untagged", "named", "continued"] });
    expect(book.task(id)!.now).toBeUndefined();
  });

  it("keeps new requests separate, including replies, continues and queued message joins", () => {
    const { book, id } = make();
    book.complete(id, 2);
    const next = book.begin("new-user", "More docs", "claude", 3, "user");
    expect(next).not.toBe(id);
    book.join("user", "new-user");
    book.join("new-user", "user");
    book.replied("new-reply", { head: "claude", userMessage: "new-user" }, [{ continues: "Docs", name: "More docs", state: "running" }], 4);
    expect(book.tasks).toHaveLength(2);
    expect(book.task(id)).toMatchObject({ state: "done", messageIDs: ["user"] });
    expect(book.task(next)).toMatchObject({ state: "running", messageIDs: ["new-user", "new-reply"] });
  });

  it("requires owner completion and allows explicit reopening of owner-completed cards", () => {
    const { book, id } = make();
    book.claim("user", "claude", 2);
    book.replied("other", { head: "codex", userMessage: "user" }, [{ state: "done" }], 3);
    expect(book.task(id)!.state).toBe("running");
    book.replied("owner", { head: "claude", userMessage: "user", usedTools: true }, [{ state: "done" }], 30);
    expect(book.task(id)!.state).toBe("done");
    book.replied("continue", { head: "claude" }, [{ continues: "Docs", state: "running" }], 31);
    expect(book.task(id)!.state).toBe("running");
  });
});
