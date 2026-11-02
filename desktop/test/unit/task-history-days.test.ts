// A bot's task history (core/task-history.ts): the done log that outlives tasks.json's pruning, as
// plain data any plugin can read (`workspace.taskHistory`), not only the whiteboard.
import { describe, expect, it } from "vitest";
import { DONE_DAYS, dayKey, doneDays, readDoneLog, recordDone, taskHistory, type DoneLog } from "../../src/core/task-history";
import { toSwiftDate } from "../../src/core/store/records";
import type { TaskCard } from "../../src/core/tasks";

const NOW = new Date(2026, 9, 28, 17, 0).getTime();
const hoursAgo = (hours: number) => NOW - hours * 3_600_000;
const daysAgo = (days: number, hour = 10) => { const date = new Date(NOW); date.setDate(date.getDate() - days); date.setHours(hour, 0, 0, 0); return date.getTime(); };
const card = (id: string, state: TaskCard["state"], at: number, extra: Partial<TaskCard> = {}): TaskCard => ({
  id, name: `Task ${id}`, state, createdAt: toSwiftDate(at - 3_600_000), updatedAt: toSwiftDate(at), messageIDs: ["m"], kept: true, declared: true, ...extra,
});

describe("done log", () => {
  it("logs a task when it becomes done, by its done time; one closed by you is counted apart", () => {
    const log: DoneLog = {};
    const cards = [
      card("a", "done", daysAgo(0), { history: [{ kind: "start", at: toSwiftDate(daysAgo(1)) }, { kind: "done", at: toSwiftDate(daysAgo(1, 15)) }], updatedAt: toSwiftDate(daysAgo(0)) }),
      card("b", "done", daysAgo(0), { manuallyCompletedAt: toSwiftDate(daysAgo(0, 9)) }),
      card("c", "running", daysAgo(0)),
      card("d", "stopped", daysAgo(0)),
      card("e", "done", daysAgo(2), { declared: false }), // Not shown on the board: not counted.
    ];
    expect(recordDone(log, cards, NOW)).toBe(true);
    expect(Object.keys(log).sort()).toEqual(["a", "b"]);
    expect(log.a).toEqual({ at: daysAgo(1, 15), manual: false });
    expect(log.b).toEqual({ at: daysAgo(0, 9), manual: true });
    expect(recordDone(log, cards, NOW)).toBe(false); // Nothing new: nothing to write.
    const days = doneDays(log, NOW);
    expect(days).toHaveLength(DONE_DAYS);
    expect(days.at(-1)).toEqual({ day: dayKey(NOW), done: 1, manual: 1 });
    expect(days.at(-2)).toEqual({ day: dayKey(daysAgo(1)), done: 1, manual: 0 });
  });

  it("keeps a finished task after tasks.json drops its card, forgets it after 14 days, and drops one opened again", () => {
    const log: DoneLog = {};
    recordDone(log, [card("old", "done", daysAgo(13)), card("older", "done", daysAgo(14)), card("again", "done", daysAgo(3))], NOW);
    expect(Object.keys(log).sort()).toEqual(["again", "old"]);
    // The cards are pruned: the log still counts them.
    recordDone(log, [], NOW);
    expect(doneDays(log, NOW).reduce((sum, day) => sum + day.done, 0)).toBe(2);
    // Opened again: no longer done; done again later, logged at the new time.
    recordDone(log, [card("again", "running", daysAgo(0))], NOW);
    expect(log.again).toBeUndefined();
    recordDone(log, [card("again", "done", hoursAgo(1), { history: [{ kind: "done", at: toSwiftDate(hoursAgo(1)) }] })], NOW);
    expect(log.again).toEqual({ at: hoursAgo(1), manual: false });
    // A day later than 14 days: gone.
    recordDone(log, [], daysAgo(-1));
    expect(log.old).toBeUndefined();
  });

  it("reads back what it wrote and ignores what it cannot read", () => {
    expect(readDoneLog({ v: 1, tasks: { a: { at: 5, manual: true }, b: { at: "x" }, c: null } })).toEqual({ a: { at: 5, manual: true } });
    expect(readDoneLog(null)).toEqual({});
    expect(readDoneLog([1])).toEqual({});
  });
});

describe("task history: how many days", () => {
  it("gives the last `days` days, oldest first, at most the 14 the log keeps and at least one", () => {
    const log: DoneLog = {};
    recordDone(log, [card("a", "done", daysAgo(1)), card("b", "done", daysAgo(5))], NOW);
    expect(taskHistory(log, NOW, 7)).toEqual(doneDays(log, NOW).slice(-7));
    expect(taskHistory(log, NOW, 7).map((day) => day.day)).toEqual(doneDays(log, NOW, 7).map((day) => day.day));
    expect(taskHistory(log, NOW, 2).reduce((sum, day) => sum + day.done, 0)).toBe(1);
    expect(taskHistory(log, NOW, 60)).toEqual(doneDays(log, NOW));
    expect(taskHistory(log, NOW, 0)).toHaveLength(1);
    expect(taskHistory(log, NOW, Number.NaN)).toHaveLength(DONE_DAYS);
    expect(taskHistory(log, NOW, 3.7)).toHaveLength(3);
  });
});

describe("done log: review regressions", () => {
  it("does not add (then prune) a done card older than 14 days, so an unchanged read reports no change", () => {
    const log: DoneLog = {};
    const old = [card("old", "done", daysAgo(20), { history: [{ kind: "done", at: toSwiftDate(daysAgo(20)) }] })];
    expect(recordDone(log, old, NOW)).toBe(false);
    expect(recordDone(log, old, NOW)).toBe(false);
    expect(log).toEqual({});
  });

  it("follows a done card closed by you afterwards: the entry becomes manual, at the close", () => {
    const log: DoneLog = {};
    const built = card("u", "done", daysAgo(2), { stage: "built", history: [{ kind: "done", at: toSwiftDate(daysAgo(2)) }] });
    recordDone(log, [built], NOW);
    expect(log.u).toEqual({ at: daysAgo(2), manual: false });
    const closed = { ...built, manuallyCompletedAt: toSwiftDate(daysAgo(0, 9)), history: [...built.history!, { kind: "complete" as const, at: toSwiftDate(daysAgo(0, 9)) }] };
    expect(recordDone(log, [closed], NOW)).toBe(true);
    expect(log.u).toEqual({ at: daysAgo(0, 9), manual: true });
    expect(recordDone(log, [closed], NOW)).toBe(false);
  });
});
