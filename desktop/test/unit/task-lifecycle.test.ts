import { describe, expect, it } from "vitest";
import { TaskBook, readTaskCard } from "../../src/core/tasks";
import { parseReply } from "../../src/core/reply";
import { Event } from "../../src/contract";
import { taskGroups } from "../../src/renderer/RightPanel";
import { Bot, taskView } from "../../src/core/bot";

function started() {
  const book = new TaskBook();
  const id = book.begin("u", "Ship", "claude", 1);
  book.replied("r", { head: "claude", userMessage: "u" }, [{ name: "Ship", state: "running" }], 2);
  return { book, id };
}

describe("task lifecycle and retained history", () => {
  it("an idle old card is quiet even while unrelated work runs", () => {
    const { book, id } = started();
    const card = taskView(book.task(id)!, new Set());
    expect(taskGroups([card], true, Date.now()).quiet.map(t => t.id)).toEqual([id]);
    expect(book.task(id)!.state).toBe("running");
  });
  it("missing completion evidence never accepts declared work or clears waiting", () => {
    const { book, id } = started();
    book.replied("wait", { head: "claude", userMessage: "u" }, [{ state: "waiting", blocked: "Approve install" }], 3);
    book.replied("news", { head: "claude", userMessage: "u" }, [{ now: "Worker ended" }], 4);
    expect(book.task(id)!.state).toBe("waiting");
    const other = new TaskBook();
    other.replied("r", { head: "claude" }, [{ name: "Review required", stage: "built" }], 5);
    expect(other.named("Review required")!.state).toBe("running");
  });
  it("an explicit task id survives a rename and a new provisional user card", () => {
    const { book, id } = started();
    book.replied("rename", { head: "claude", userMessage: "u" }, [{ name: "Shipping" }], 3);
    book.begin("u2", "accept result", "claude", 4);
    const tags = parseReply(`<task id="${id}" name="Ship" state="done"/>`).tasks;
    book.replied("accepted", { head: "claude", userMessage: "u2" }, tags, 5);
    expect(book.tasks).toHaveLength(1);
    expect(book.task(id)).toMatchObject({ state: "done", messageIDs: expect.arrayContaining(["u2", "accepted"]) });
  });
  it("id updates preserve owner and manually completed decisions", () => {
    const { book, id } = started();
    book.replied("foreign", { head: "codex" }, parseReply(`<task id="${id}" state="done"/>`).tasks, 3);
    expect(book.task(id)!.state).toBe("running");
    book.complete(id, 4);
    book.replied("delayed", { head: "claude", reporting: ["worker"] }, parseReply(`<task id="${id}" state="running"/>`).tasks, 5);
    expect(book.task(id)).toMatchObject({ state: "done", manuallyCompletedAt: 4, updatedAt: 4 });
  });
  it("name-only completion remains compatible and repeated completion adds no card", () => {
    const { book, id } = started();
    for (const u of ["accept", "again"]) {
      book.begin(u, "Accepted", "claude", 4);
      book.replied(`r-${u}`, { head: "claude", userMessage: u }, [{ name: "Ship", state: "done" }], 5);
    }
    expect(book.tasks).toHaveLength(1);
    expect(book.task(id)!.state).toBe("done");
  });
  it("cancellation survives untagged and progress-only delayed reports", () => {
    const { book, id } = started();
    book.link("worker", id);
    book.replied("cancel", { head: "claude", userMessage: "u" }, [{ state: "stopped" }], 3);
    book.replied("late", { head: "claude", reporting: ["worker"] }, [{ now: "Worker finished" }], 4);
    book.replied("later", { head: "claude", reporting: ["worker"] }, [], 5);
    expect(book.task(id)!.state).toBe("stopped");
    expect(book.task(id)!.manuallyCompletedAt).toBeUndefined();
  });
  it("a foreign head cannot merge a new request into another owner's task", () => {
    const { book, id } = started();
    const foreign = book.begin("foreign", "Other work", "codex", 3);
    book.replied("foreign-report", { head: "codex", userMessage: "foreign" }, [{ continues: "Ship", state: "done" }], 4);
    expect(book.task(foreign)).toBeDefined();
    expect(book.task(id)).toMatchObject({ owner: "claude", state: "running" });
    expect(book.task(id)!.messageIDs).not.toContain("foreign");
  });
  it("worker termination and an untagged report preserve waiting and verification", () => {
    const { book, id } = started();
    book.link("worker", id);
    book.replied("wait", { head: "claude", userMessage: "u" }, [{ state: "waiting", stage: "installed" }], 3);
    book.replied("report", { head: "claude", reporting: ["worker"], runningSubagents: new Set() }, [], 4);
    expect(book.task(id)).toMatchObject({ state: "waiting", stage: "installed" });
  });
  it("unknown ids cannot silently finish another task", () => {
    const { book, id } = started();
    book.replied("wrong", { head: "claude", userMessage: "u" }, parseReply('<task id="missing" state="done"/>').tasks, 3);
    expect(book.task(id)!.state).toBe("running");
  });
  it("head execution is attached only to its own card and ends with its turn", () => {
    const { book, id } = started();
    const other = book.begin("other", "Other work", "claude", 3);
    book.replied("other-reply", { head: "claude", userMessage: "other" }, [{ name: "Other work", state: "running" }], 4);
    const live = { tasks: book, engine: "claude", subagents: { list: [] }, records: [], shownTurn: { open: true, origin: "user", userId: "u" } };
    const views = () => Bot.prototype.taskViews.call(live as unknown as Bot);
    expect(views().find(t => t.id === id)!.atWork).toBe(true);
    expect(views().find(t => t.id === other)!.atWork).toBe(false);
    live.shownTurn.open = false;
    expect(views().every(t => !t.atWork)).toBe(true);
    expect(book.task(id)!.state).toBe("running");
  });
  it("completed history survives new work, reload and chat pruning", () => {
    const { book, id } = started();
    book.complete(id, 3);
    for (let i = 0; i < 105; i++) {
      book.begin(`u${i}`, `Work ${i}`, "claude", 10 + i);
      book.replied(`r${i}`, { head: "claude", userMessage: `u${i}` }, [{ name: `Work ${i}`, state: "done" }], 20 + i);
    }
    const restored = new TaskBook(JSON.parse(JSON.stringify(book.tasks)).map((raw: unknown) => readTaskCard(raw)!));
    restored.keepOnly(new Set());
    expect(restored.tasks).toHaveLength(106);
    expect(restored.task(id)).toMatchObject({ state: "done", manuallyCompletedAt: 3 });
    const views = Bot.prototype.taskViews.call({ tasks: restored, engine: "claude", subagents: { list: [] }, records: [] } as unknown as Bot);
    expect(views).toHaveLength(106);
    expect(Event.safeParse({ type: "tasks.updated", botId: "main", tasks: views }).success).toBe(true);
    expect(taskGroups(views, false, Date.now()).done).toHaveLength(106);
  });
});


describe("original-owner reconciliation with an expected snapshot", () => {
  it.each(["done", "stopped"] as const)("applies %s to the original id without touching a current repair card", (state) => {
    const { book, id } = started();
    const repair = book.begin("repair", "Fix lifecycle", "claude", 10);
    book.replied("repair-start", { head: "claude", userMessage: "repair" }, [{ name: "Lifecycle repair", state: "running" }], 11);
    const beforeRepair = structuredClone(book.task(repair));
    book.replied("audit", { head: "claude", userMessage: "repair" }, parseReply(`<task id="${id}" expected-updated-at="2" state="${state}"/>`).tasks, 12);
    expect(book.task(repair)).toEqual(beforeRepair);
    expect(book.task(id)).toMatchObject({ state, updatedAt: 12 });
    expect(book.task(id)!.manuallyCompletedAt).toBeUndefined();
    expect(book.task(id)!.history!.at(-1)!.kind).toBe(state);
    const accepted = structuredClone(book.tasks);
    book.replied("replayed", { head: "claude", userMessage: "repair" }, parseReply(`<task id="${id}" expected-updated-at="2" state="${state}"/>`).tasks, 13);
    expect(book.tasks).toEqual(accepted);
  });
  it.each([['missing', '2', 'claude'], ['original', '1', 'claude'], ['original', 'invalid', 'claude'], ['original', '2', 'codex']] as const)("rejects id=%s version=%s owner=%s before any mutation", (target, version, head) => {
    const { book, id } = started();
    book.begin("repair", "Repair card", head, 10);
    const before = structuredClone(book.tasks);
    book.replied("wrong", { head, userMessage: "repair" }, parseReply(`<task id="${target === 'original' ? id : target}" expected-updated-at="${version}" name="New name" state="done"/>`).tasks, 11);
    expect(book.tasks).toEqual(before);
  });
  it("name-only original completion cannot rename or close the current declared repair card", () => {
    const { book, id } = started();
    const repair = book.begin("repair", "Fix lifecycle", "claude", 10);
    book.replied("repair-start", { head: "claude", userMessage: "repair" }, [{ name: "Lifecycle repair", state: "running" }], 11);
    const before = structuredClone(book.task(repair));
    book.replied("report", { head: "claude", userMessage: "repair" }, [{ name: "Ship", state: "done" }], 12);
    expect(book.task(repair)).toEqual(before);
    expect(book.task(id)!.state).toBe("done");
  });
  it("foreign continues is a strict no-op, including links and the current card", () => {
    const { book } = started();
    book.begin("repair", "Repair card", "codex", 10);
    const before = structuredClone(book.tasks);
    book.replied("wrong", { head: "codex", userMessage: "repair" }, [{ continues: "Ship", state: "done" }], 11);
    expect(book.tasks).toEqual(before);
  });
});
