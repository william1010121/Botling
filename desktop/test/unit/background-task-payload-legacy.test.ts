import { describe, expect, it } from "vitest";
import { MessageView } from "../../src/contract";
import { messageView } from "../../src/core/bot";
import { toSwiftDate } from "../../src/core/store/records";

const now = Date.UTC(2026, 9, 26, 8);
const task = { id: "wake", kind: "wakeup", title: "Retry", status: "running", startedAt: toSwiftDate(now), fireAt: toSwiftDate(now + 60_000), detail: "Check the service" };
const record = (backgroundTasks: unknown[]) => ({ id: "6A0B0000-0000-4000-8000-0000000000AA", role: "bot" as const, text: "The saved reply still matters.", date: toSwiftDate(now), backgroundTasks });

describe("legacy background work at the message payload boundary", () => {
  it("keeps the message and valid schedules when sibling tasks use unknown kind/status values", () => {
    const saved = record([
      task,
      { ...task, id: "future-kind", kind: "remote-job" },
      { ...task, id: "future-status", status: "suspended" },
      { ...task, id: "cron", kind: "cron", jobID: "job-1", schedule: "*/30 * * * *", recurring: false, futureField: { ignored: true } },
    ]);
    const original = JSON.stringify(saved);
    const payload = messageView(saved);
    expect(MessageView.safeParse(payload).success).toBe(true);
    expect(payload.text).toBe(saved.text);
    expect(payload.backgroundTasks).toEqual([
      { id: "wake", kind: "wakeup", title: "Retry", status: "running", started: now, ended: null, detail: "Check the service", fires: now + 60_000, schedule: null, recurring: null, summary: null },
      { id: "cron", kind: "cron", title: "Retry", status: "running", started: now, ended: null, detail: "Check the service", fires: now + 60_000, schedule: "*/30 * * * *", recurring: false, summary: null },
    ]);
    expect(JSON.stringify(saved)).toBe(original);
  });

  it("does not lose the reply when the legacy array has no usable task records", () => {
    const payload = messageView(record([null, "old format", [], { ...task, status: "waiting" }, { kind: "wakeup" }]));
    expect(MessageView.safeParse(payload).success).toBe(true);
    expect(payload.text).toBe("The saved reply still matters.");
    expect(payload.backgroundTasks ?? []).toEqual([]);
  });

  it("normalizes unreadable optional metadata without discarding an otherwise valid wake-up", () => {
    const payload = messageView(record([{ ...task, fireAt: "unavailable", endedAt: "unknown", detail: {}, schedule: [], recurring: "yes", summary: 7 }]));
    expect(MessageView.safeParse(payload).success).toBe(true);
    expect(payload.backgroundTasks).toEqual([
      { id: "wake", kind: "wakeup", title: "Retry", status: "running", started: now, ended: null, detail: null, fires: null, schedule: null, recurring: null, summary: null },
    ]);
  });
});
