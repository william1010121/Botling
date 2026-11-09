// Routines (core/routines.ts): CronSchedule, routines.cron and the app-owned schedules, checked with
// the cases the Swift app's RoutineTests and ScheduledRoutineTests use (same inputs, same answers).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CronSchedule, DAILY_SUMMARY, RoutineFile, ScheduledRoutineStore, dueTime, legacyRoutineLines, parseRoutine, routineDivider, routineFile, routineInstruction,
  routinePrompt, routineStatus, routineTitle,
} from "../../src/core/routines";
import { fromSwiftDate } from "../../src/core/store/records";
import { tempDir } from "../helpers";

/** 2026-10-20 (a Tuesday) at hh:mm, local time. */
const day = (hour: number, minute: number, plusDays = 0) => new Date(2026, 9, 20 + plusDays, hour, minute).getTime();

describe("CronSchedule and routines.cron lines (CronTests)", () => {
  it("reads the daily summary line", () => {
    const job = parseRoutine(DAILY_SUMMARY)!;
    expect(routineTitle(job.task)).toBe("Daily summary");
    expect(routineInstruction(job.task).startsWith("Read each project's memory file")).toBe(true);
    expect(job.enabled).toBe(true);
    expect(job.schedule.description).toBe("Every day 08:15");
    expect(job.schedule.matches(day(8, 15), null)).toBe(true);
    expect(job.schedule.matches(day(8, 16), null)).toBe(false);
  });

  it("ends the name at its colon; a URL's colon is no name", () => {
    const url = parseRoutine("0 9 * * * https://example.com/report open and summarise")!;
    expect(routineInstruction(url.task)).toBe("https://example.com/report open and summarise");
    const named = parseRoutine("0 9 * * * Morning check of every open pull request: list them")!;
    expect(routineTitle(named.task)).toBe("Morning check of every open pull request");
    expect(routineInstruction(named.task)).toBe("list them");
    const wide = parseRoutine("0 9 * * * 晨報：整理新聞")!;
    expect(routineTitle(wide.task)).toBe("晨報");
    expect(routineInstruction(wide.task)).toBe("整理新聞");
  });

  it("paused lines, comments and @files", () => {
    const paused = parseRoutine("#0 18 * * 5 Friday review: Sum up what got done this week")!;
    expect(paused.enabled).toBe(false);
    expect(paused.schedule.description).toBe("Fri 18:00");
    expect(parseRoutine("# minute hour day month weekday  Name: what to do")).toBeNull();
    const standup = parseRoutine("0 9 * * 1-5 Standup: @notes/standup.md")!;
    expect(routineFile(standup.task)).toBe("notes/standup.md");
    expect(standup.schedule.description).toBe("Weekdays 09:00");
    expect(standup.schedule.matches(day(9, 0, 5), null)).toBe(false); // Sunday
    expect(standup.schedule.matches(day(9, 0), null)).toBe(true);
  });

  it("steps, lists and bad lines", () => {
    const every15 = CronSchedule.parse("*/15 9-17 * * *")!;
    expect(every15.matches(day(9, 45), null)).toBe(true);
    expect(every15.matches(day(9, 50), null)).toBe(false);
    expect(every15.matches(day(18, 0), null)).toBe(false);
    expect(CronSchedule.parse("61 * * * *")).toBeNull();
    expect(CronSchedule.parse("* * *")).toBeNull();
    expect(CronSchedule.parse("0 8 * * 7")!.matches(day(8, 0, 5), null)).toBe(true); // 7 = Sunday
  });

  it("looks back within the day only", () => {
    const schedule = CronSchedule.parse("15 8 * * *")!;
    expect(schedule.lastTimeToday(day(13, 0), null)).toBe(day(8, 15));
    expect(schedule.lastTimeToday(day(8, 0), null)).toBeNull();
    expect(schedule.nextTime(day(8, 0), null)).toBe(day(8, 15));
    expect(schedule.nextTime(day(8, 15), null)).toBe(day(8, 15, 1));
  });

  it("works in a saved zone, through a DST change", () => {
    const schedule = CronSchedule.parse("30 1 * * *")!;
    // 2026-11-01 in New York: 01:30 happens twice (EDT then EST); the latest at or before 05:00Z is the first.
    expect(schedule.lastTimeToday(Date.parse("2026-11-01T05:40:00Z"), "America/New_York")).toBe(Date.parse("2026-11-01T05:30:00Z"));
    expect(schedule.lastTimeToday(Date.parse("2026-11-01T06:40:00Z"), "America/New_York")).toBe(Date.parse("2026-11-01T06:30:00Z"));
    // 2026-03-08: 02:30 does not exist in New York.
    expect(CronSchedule.parse("30 2 * * *")!.lastTimeToday(Date.parse("2026-03-08T15:00:00Z"), "America/New_York")).toBeNull();
    expect(CronSchedule.parse("0 18 * * *")!.nextTime(Date.parse("2026-10-24T08:00:00Z"), "Asia/Taipei")).toBe(Date.parse("2026-10-24T10:00:00Z"));
  });

  it("edits keep comments and other lines", () => {
    const file = new RoutineFile(join(tempDir("cron"), "routines.cron"));
    file.create([DAILY_SUMMARY, "0 9 * * 1-5 Standup: @standup.md"]);
    const summary = file.load()[0]!;
    file.update(summary.id, "pause");
    expect(file.load()[0]!.enabled).toBe(false);
    file.update(file.load()[0]!.id, "cancel");
    const text = readFileSync(file.file, "utf8");
    expect(text.startsWith("# Routines")).toBe(true);
    expect(file.load().map((job) => routineTitle(job.task))).toEqual(["Standup"]);
  });

  it("moves 1.x's old bot.json routines into the file", () => {
    expect(legacyRoutineLines([{ title: "每日摘要", instruction: "", hour: 8, minute: 15, enabled: true }, { title: "Ping", instruction: "say hi", hour: 7, minute: 5, enabled: false }]))
      .toEqual([DAILY_SUMMARY, "#5 7 * * * Ping: say hi"]);
    expect(legacyRoutineLines(undefined)).toBeNull();
  });

  it("tells the bot as 1.x does, and starts with a divider", () => {
    const job = parseRoutine("0 9 * * * Standup: @notes/standup.md")!;
    expect(routinePrompt(job, "manager", () => "")).toBe("(App: Time for the routine \"Standup\": Open notes/standup.md (relative to your working folder) and do what it says.. When done, report the result in one sentence; if the user needs to decide something, attach a choices block.)");
    expect(routinePrompt(parseRoutine(DAILY_SUMMARY)!, "main", () => "(App: Project list.)")).toBe(`(App: Time for the routine "Daily summary". ${routineInstruction(parseRoutine(DAILY_SUMMARY)!.task)})\n(App: Project list.)`);
    expect(routineDivider(job, day(9, 0))).toBe("Standup · 09:00");
  });
});

describe("scheduled-routines.json (ScheduledRoutineStoreTests)", () => {
  const now = Date.parse("2026-10-24T08:00:00Z");
  const once = (key = "one", at = "2026-10-24T17:00:00+08:00") => ({ operation: "create", kind: "once", at, timezone: "Asia/Taipei", task: "Check: inspect result", request_id: key });
  const make = () => new ScheduledRoutineStore(join(tempDir("schedule"), "scheduled-routines.json"));

  it("an overdue once job recovers after a restart and fires only once", () => {
    const store = make();
    const id = store.perform(once(), now).id as string;
    const due = now + 3600_000;
    expect(routineStatus(store.load()[0]!, now)).toBe("pending");
    const restarted = new ScheduledRoutineStore(store.file);
    expect(routineStatus(restarted.load()[0]!, due + 86_400_000)).toBe("due");
    expect(restarted.claim(id, due + 86_400_000)).not.toBeNull();
    restarted.didDispatch(id, due + 86_400_000);
    expect(store.load()[0]!.state).toBe("fired");
    expect(store.claim(id, due + 172_800_000)).toBeNull();
    expect(store.perform(once(), due).id).toBe(id); // a retry even after its time passed
    expect(() => store.perform({ operation: "resume", id }, due)).toThrow();
  });

  it("a crash after the claim stays delivery_uncertain and is never retried", () => {
    const store = make();
    const id = store.perform(once(), now).id as string;
    expect(store.claim(id, now + 3600_000)).not.toBeNull();
    const restarted = new ScheduledRoutineStore(store.file);
    expect(routineStatus(restarted.load()[0]!, now)).toBe("delivery_uncertain");
    expect(restarted.claim(id, now + 999_999_000)).toBeNull();
    expect(() => restarted.perform({ operation: "cancel", id })).toThrow(/already claimed/);
  });

  it("pause and cancel are saved before anything is dispatched", () => {
    const store = make();
    const id = store.perform(once(), now).id as string;
    store.perform({ operation: "pause", id }, now);
    const due = now + 3601_000;
    expect(store.claim(id, due)).toBeNull();
    store.perform({ operation: "resume", id }, due);
    expect(routineStatus(store.load()[0]!, due)).toBe("due");
    store.perform({ operation: "cancel", id }, due);
    expect(new ScheduledRoutineStore(store.file).claim(id, due)).toBeNull();
    expect(store.perform(once(), due).status).toBe("cancelled");
    expect(() => store.perform({ operation: "resume", id })).toThrow();
  });

  it("create is idempotent, but a different payload cannot reuse the key", () => {
    const store = make();
    const first = store.perform(once(), now).id;
    expect(store.perform(once(), now).id).toBe(first);
    expect(store.load()).toHaveLength(1);
    expect(() => store.perform({ ...once(), task: "different" }, now)).toThrow(/request_id already belongs/);
    expect(() => store.perform({ ...once("past"), at: "2026-10-24T07:59:00Z" }, now)).toThrow(/future/);
    expect(() => store.perform({ ...once("ambiguous"), at: "2026-11-01T01:30:00" }, now)).toThrow(/explicit UTC offset/);
    expect(() => store.perform({ ...once("zone"), timezone: "Not/AZone" }, now)).toThrow(/Unknown timezone/);
    expect(() => store.perform({ operation: "cancel", id: "missing" })).toThrow(/Unknown routine id/);
  });

  it("corrupt or unwritable state does not dispatch or overwrite", () => {
    const dir = tempDir("schedule");
    const file = join(dir, "scheduled-routines.json");
    writeFileSync(file, "not json");
    const store = new ScheduledRoutineStore(file);
    expect(() => store.claim("anything", now)).toThrow(/Cannot read routine state/);
    expect(() => store.perform(once(), now)).toThrow();
    expect(readFileSync(file, "utf8")).toBe("not json");
    writeFileSync(join(dir, "file-not-folder"), "");
    expect(() => new ScheduledRoutineStore(join(dir, "file-not-folder", "scheduled-routines.json")).perform(once(), now)).toThrow();
    writeFileSync(file, JSON.stringify({ version: 1, routines: [{ id: "x" }] }));
    expect(() => store.load()).toThrow(/Invalid routine state/);
  });

  it("a recurring job uses its saved zone and catches up only today", () => {
    const store = make();
    const id = store.perform({ operation: "create", kind: "recurring", cron: "0 18 * * *", timezone: "Asia/Taipei", task: "Daily: check", request_id: "daily" }, now).id as string;
    const due = now + 7200_000; // 18:00 in Taipei
    expect(dueTime(store.load()[0]!, due)).toBe(due);
    expect(store.claim(id, due)).not.toBeNull();
    store.didDispatch(id, due);
    expect(store.claim(id, due + 60_000)).toBeNull();
    expect(dueTime(store.load()[0]!, due + 86_400_000 - 60_000)).toBeNull();
    expect(store.claim(id, due + 86_400_000)).not.toBeNull();
  });

  it("resuming after a run skips the times it was paused", () => {
    const store = make();
    const id = store.perform({ operation: "create", kind: "recurring", cron: "0 18 * * *", timezone: "Asia/Taipei", task: "Daily: check", request_id: "resume" }, now).id as string;
    const first = now + 7200_000;
    expect(store.claim(id, first)).not.toBeNull();
    store.didDispatch(id, first);
    store.perform({ operation: "pause", id }, first + 60_000);
    const resumed = first + 86_400_000 + 3600_000;
    store.perform({ operation: "resume", id }, resumed);
    expect(store.claim(id, resumed)).toBeNull();
    expect(store.claim(id, first + 172_800_000)).not.toBeNull();
  });

  it("explicit offsets keep the two instants of a DST fold apart", () => {
    const store = make();
    const a = store.perform(once("dst-a", "2026-11-01T01:30:00-04:00"), now).id as string;
    const b = store.perform(once("dst-b", "2026-11-01T01:30:00-05:00"), now).id as string;
    const jobs = store.load();
    expect(fromSwiftDate(jobs[1]!.at!) - fromSwiftDate(jobs[0]!.at!)).toBe(3600_000);
    expect(store.claim(a, fromSwiftDate(jobs[0]!.at!))).not.toBeNull();
    expect(store.claim(b, fromSwiftDate(jobs[0]!.at!))).toBeNull();
  });

  it("routines.cron jobs are listed with cron: ids, and can be paused, resumed and cancelled", () => {
    const store = make();
    const cron = join(store.file, "..", "routines.cron");
    writeFileSync(cron, "# keep me\n0 9 * * * Daily: check\n");
    const list = store.perform({ operation: "list" }).routines as { id: string; kind: string; timezone: string }[];
    expect(list).toEqual([{ id: "cron:0 9 * * * Daily: check", kind: "legacy_recurring", task: "Daily: check", cron: "0 9 * * *", timezone: "system_local", status: "enabled" }]);
    store.perform({ operation: "pause", id: list[0]!.id });
    expect(new RoutineFile(cron).load()[0]!.enabled).toBe(false);
    store.perform({ operation: "resume", id: list[0]!.id });
    expect(new RoutineFile(cron).load()[0]!.enabled).toBe(true);
    store.perform({ operation: "cancel", id: list[0]!.id });
    expect(new RoutineFile(cron).load()).toEqual([]);
    expect(readFileSync(cron, "utf8")).toBe("# keep me\n");
  });

  it("writes 1.x's format: version 1, sorted keys, Swift dates, no nil keys", () => {
    const store = make();
    store.perform(once(), now);
    const saved = JSON.parse(readFileSync(store.file, "utf8"));
    expect(saved.version).toBe(1);
    const job = saved.routines[0];
    expect(Object.keys(job)).toEqual(["at", "baseline", "createdAt", "id", "kind", "requestID", "state", "task", "timezone"]);
    expect(job.at).toBe((Date.parse("2026-10-24T09:00:00Z") - Date.UTC(2001, 0, 1)) / 1000);
    expect(job.state).toBe("pending");
    expect(existsSync(`${store.file}.botling2.lock`)).toBe(false);
    mkdirSync(join(store.file, ".."), { recursive: true });
  });
});

describe("@once lines in routines.cron (a script waking its bot)", () => {
  it("reads \"@once Name: what\" as a one-shot job; the usual lines are as before", () => {
    const job = parseRoutine("@once Alert: disk full on 4090-2")!;
    expect(job).toMatchObject({ once: true, enabled: true, task: "Alert: disk full on 4090-2", id: "@once Alert: disk full on 4090-2" });
    expect(routineTitle(job.task)).toBe("Alert");
    expect(parseRoutine("#@once Alert: paused")).toMatchObject({ once: true, enabled: false });
    expect(parseRoutine("@once")).toBeNull();
    expect(parseRoutine("@once   ")).toBeNull();
    expect(parseRoutine(DAILY_SUMMARY)!.once).toBeFalsy();
  });

  it("takeOnce removes exactly that line, keeps comments and other lines, and says false when it is gone", () => {
    const dir = tempDir("routines-once");
    const file = join(dir, "routines.cron");
    writeFileSync(file, `# header\n${DAILY_SUMMARY}\n@once Alert: one\n\n# note\n@once Alert: two\n`);
    const routines = new RoutineFile(file);
    expect(routines.load().filter((job) => job.once).map((job) => job.task)).toEqual(["Alert: one", "Alert: two"]);
    expect(routines.takeOnce("@once Alert: one")).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(`# header\n${DAILY_SUMMARY}\n\n# note\n@once Alert: two\n`);
    expect(routines.takeOnce("@once Alert: one")).toBe(false);
  });
});

/**
 * Runs `body` with a script's appends landing inside the app's rewrite of `file`: `before` right before the rename
 * of the new file over it (into the file the app read), `after` right after it (into the new file).
 */
function racing(file: string, { before = [], after = [] }: { before?: string[]; after?: string[] }, body: () => void) {
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const original = fs.renameSync;
  let renames = 0;
  fs.renameSync = ((from: string, to: string) => {
    if (String(to) !== file) return original(from, to);
    renames++;
    for (const line of before) appendFileSync(file, line);
    original(from, to);
    for (const line of after) appendFileSync(file, line);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { body(); } finally {
    fs.renameSync = original;
    syncBuiltinESMExports();
  }
  expect(renames).toBe(1);
}

describe("an app rewrite of routines.cron keeps what a script appends meanwhile (the user, 2026-11-09)", () => {
  const cron = (text: string) => {
    const file = join(tempDir("routines-race"), "routines.cron");
    if (text) writeFileSync(file, text);
    return file;
  };

  it("takeOnce: lines appended before the rename come back, the taken line does not, the same words appended again do", () => {
    const file = cron("# h\n@once A: one\n");
    let taken = false;
    racing(file, { before: ["@once A: two\n", "@once A: one\n"] }, () => { taken = new RoutineFile(file).takeOnce("@once A: one"); });
    expect(taken).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("# h\n@once A: two\n@once A: one\n");
  });

  it("takeOnce: a line appended after the rename is there once, not repeated", () => {
    const file = cron("@once A: one\n# h\n");
    racing(file, { before: ["@once B: x\n"], after: ["@once C: y\n"] }, () => new RoutineFile(file).takeOnce("@once A: one"));
    expect(readFileSync(file, "utf8")).toBe("# h\n@once C: y\n@once B: x\n");
  });

  it("add (a plugin's addRoutine) keeps an appended line", () => {
    const file = cron(`# h\n${DAILY_SUMMARY}\n`);
    racing(file, { before: ["@once Alert: done\n"] }, () => new RoutineFile(file).add(parseRoutine("0 9 * * * Morning: hello")!));
    expect(readFileSync(file, "utf8")).toBe(`# h\n${DAILY_SUMMARY}\n0 9 * * * Morning: hello\n@once Alert: done\n`);
  });

  it("update cancel/pause keep an appended line and never bring back the line they removed or changed", () => {
    const file = cron(`${DAILY_SUMMARY}\n@once Alert: old\n`);
    racing(file, { before: ["@once Alert: new\n"] }, () => new RoutineFile(file).update("@once Alert: old", "cancel"));
    expect(readFileSync(file, "utf8")).toBe(`${DAILY_SUMMARY}\n@once Alert: new\n`);
    racing(file, { before: ["30 7 * * * Wake: up\n"] }, () => new RoutineFile(file).update(parseRoutine(DAILY_SUMMARY)!.id, "pause"));
    expect(readFileSync(file, "utf8")).toBe(`#${DAILY_SUMMARY}\n@once Alert: new\n30 7 * * * Wake: up\n`);
  });

  it("create keeps what a script wrote into the file it was about to make", () => {
    const file = cron("");
    racing(file, { before: ["@once Alert: early\n"] }, () => new RoutineFile(file).create([DAILY_SUMMARY]));
    const text = readFileSync(file, "utf8");
    expect(text.endsWith(`${DAILY_SUMMARY}\n@once Alert: early\n`)).toBe(true);
    expect(text.split("\n").filter((line) => line === "@once Alert: early")).toHaveLength(1);
  });

  it("a line appended without a final newline is kept as its own line", () => {
    const file = cron("@once A: one\n");
    racing(file, { before: ["@once B: x"] }, () => new RoutineFile(file).takeOnce("@once A: one"));
    expect(readFileSync(file, "utf8")).toBe("@once B: x\n");
  });
});

describe("the routine clock", () => {
  it("checks every 15 s, so a script's @once line runs within about 15 s (the user, 2026-11-09)", async () => {
    const { ROUTINE_TICK_MS } = await import("../../src/core/routines");
    expect(ROUTINE_TICK_MS).toBe(15_000);
  });
});
