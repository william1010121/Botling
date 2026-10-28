// The whiteboard's derived data (core/whiteboard-data.ts): the done log that outlives tasks.json's
// pruning, a bot's latest action, its one-line description and an approval's command; and, through
// the core, `whiteboard.view` carrying them and `waiting` carrying when a question was asked.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { CoreHarness } from "../core-harness";
import { saveProjectRow } from "../../src/core/projects";
import { WhiteboardView, type TaskView } from "../../src/contract";
import { DONE_DAYS, approvalSummary, botDescription, dayKey, doneDays, latestAction, readDoneLog, recordDone, type DoneLog } from "../../src/core/whiteboard-data";
import { permissionText } from "../../src/core/bot";
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

describe("latest action", () => {
  const task = (id: string, state: TaskView["state"], updatedAt: string, extra: Partial<TaskView> = {}): TaskView => ({
    id, name: `Task ${id}`, state, owner: null, now: null, next: null, blocked: null, messageIds: [], updatedAt, atWork: false, ...extra,
  });
  const iso = (ms: number) => new Date(ms).toISOString();
  it("is the newest entry on any task's timeline", () => {
    const tasks = [
      task("a", "done", iso(hoursAgo(1)), { history: [{ kind: "start", at: iso(hoursAgo(5)), text: null }, { kind: "done", at: iso(hoursAgo(3)), text: null }] }),
      task("b", "running", iso(hoursAgo(2)), { history: [{ kind: "now", at: iso(hoursAgo(2)), text: "Running the 8th ICA" }] }),
      task("c", "waiting", iso(hoursAgo(4)), { history: [{ kind: "waiting", at: iso(hoursAgo(4)), text: "Which account?" }] }),
    ];
    expect(latestAction(tasks)).toEqual({ kind: "now", text: "Running the 8th ICA", at: iso(hoursAgo(2)) });
    expect(latestAction(tasks.filter((entry) => entry.id !== "b"))).toEqual({ kind: "done", text: "Task a", at: iso(hoursAgo(3)) });
    expect(latestAction([tasks[2]!])).toEqual({ kind: "waiting", text: "Which account?", at: iso(hoursAgo(4)) });
  });
  it("falls back to the newest card's last change and name when no card has a timeline; null with no tasks", () => {
    expect(latestAction([task("x", "done", iso(hoursAgo(9))), task("y", "pending", iso(hoursAgo(8)))])).toEqual({ kind: "now", text: "Task y", at: iso(hoursAgo(8)) });
    expect(latestAction([task("z", "waiting", iso(hoursAgo(1)), { blocked: "Pick a domain" })])).toMatchObject({ kind: "waiting", text: "Pick a domain" });
    expect(latestAction([])).toBeNull();
  });
});

describe("description and approvals", () => {
  it("describes a bot by its job, else its first status line, else its folder", () => {
    expect(botDescription("Morning news\nevery day", "x", "/a/b")).toBe("Morning news");
    expect(botDescription(null, "The theme is live.", "/a/Site")).toBe("The theme is live.");
    expect(botDescription(null, undefined, "/Users/me/Site/")).toBe("Site");
  });
  it("takes the command from an approval card's text", () => {
    expect(approvalSummary(permissionText("Bash", "npm publish --tag next"))).toBe("npm publish --tag next");
    expect(approvalSummary(permissionText("Bash", "echo ~~~ fence"))).toBe("echo ~~~ fence");
    expect(approvalSummary("Something else\nmore")).toBe("Something else");
  });
});

const harnesses: CoreHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});
const PROJECT = "6A0B0000-0000-4000-8000-0000000000B2";
const QUESTION = "6A0B0000-0000-4000-8000-0000000000C1";

describe("whiteboard.view: the board's new data", () => {
  it("carries the latest action, 14 days of finished tasks (kept in done-days.json), a description, approvals; waiting carries when it was asked", async () => {
    const dir = tempDir("whiteboard-data");
    const folder = join(tempDir("wb-data-proj"), "Site");
    mkdirSync(join(folder, ".bot"), { recursive: true });
    writeFileSync(join(folder, ".bot", "memory.md"), "## Current status\n- The theme is live.\n");
    saveProjectRow(dir, { id: PROJECT, name: "Site", folder, avatar: "triangle" });
    const store = join(dir, "projects", PROJECT);
    mkdirSync(store, { recursive: true });
    const now = Date.now();
    const asked = toSwiftDate(now - 2 * 3_600_000);
    writeFileSync(join(store, "tasks.json"), JSON.stringify([
      { id: "t-done", name: "Ship the theme", state: "done", createdAt: toSwiftDate(now - 7_200_000), updatedAt: toSwiftDate(now - 3_600_000), messageIDs: [QUESTION], kept: true, declared: true,
        history: [{ kind: "start", at: toSwiftDate(now - 7_200_000) }, { kind: "done", at: toSwiftDate(now - 3_600_000) }] },
    ]));
    writeFileSync(join(store, "chat.json"), JSON.stringify([
      { id: QUESTION, role: "bot", text: "Publish now?", date: asked, choices: [{ label: "Yes", recommended: true }, { label: "No", recommended: false }] },
    ]));
    const c = new CoreHarness(dir, { BOTLING_ROUTINE_TICK_MS: "0", BOTLING_COMPONENT_SCAN_MS: "0", BOTLING_WAITING_SCAN_MS: "0" });
    harnesses.push(c);
    const view = await c.call({ type: "whiteboard.view" });
    expect(WhiteboardView.safeParse(view).success).toBe(true);
    const site = view.bots.find((entry: any) => entry.botId === PROJECT);
    expect(site.latest).toMatchObject({ kind: "done", text: "Ship the theme" });
    expect(site.description).toBe("The theme is live.");
    expect(site.approvals).toEqual([]);
    expect(site.doneDays).toHaveLength(14);
    expect(site.doneDays.reduce((sum: number, day: any) => sum + day.done, 0)).toBe(1);
    const saved = JSON.parse(readFileSync(join(store, "done-days.json"), "utf8"));
    expect(Object.keys(saved.tasks)).toEqual(["t-done"]);
    const waiting = await c.call({ type: "waiting.list" });
    expect(waiting.items.find((item: any) => item.botId === PROJECT)).toMatchObject({ text: "Publish now?", messageId: QUESTION, at: new Date(Date.UTC(2001, 0, 1) + asked * 1000).toISOString() });
  });
});
