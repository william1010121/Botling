// Background work a turn left running (1.x's BackgroundTask.swift): kept in its reply, ended by its
// notification, stopped or interrupted with its process, and told once at the bot's next wake.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endBackgroundTask, hasBackgroundWorkRunning, interruptedNote, markCutOffTasksTold, stopBackgroundTasks, type BackgroundTask } from "../../src/core/background-tasks";
import { toSwiftDate, type ChatRecord } from "../../src/core/store/records";
import { parseLine } from "../../src/core/agent/stream";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const reply = (tasks: BackgroundTask[]): ChatRecord => ({ id: "6A0B0000-0000-4000-8000-0000000000AA", role: "bot", text: "Started it.", date: toSwiftDate(), backgroundTasks: tasks });
const task = (over: Partial<BackgroundTask>): BackgroundTask => ({ id: "toolu_1", kind: "command", title: "Run tests", status: "running", startedAt: toSwiftDate(), ...over });

describe("background tasks", () => {
  it("end with their notification; a stopped Monitor did its job", () => {
    const records = [reply([task({}), task({ id: "toolu_2", kind: "monitor", title: "Watch logs" })])];
    expect(endBackgroundTask(records, "toolu_1", "failed", "exit 1")).toBe(records[0]);
    expect(endBackgroundTask(records, "toolu_2", "killed", null)).toBe(records[0]);
    expect((records[0]!.backgroundTasks as BackgroundTask[]).map((t) => [t.status, t.summary])).toEqual([["failed", "exit 1"], ["completed", undefined]]);
    // Ended already: nothing changes.
    expect(endBackgroundTask(records, "toolu_1", "completed", null)).toBeNull();
  });

  it("are read from claude's task_started lines (1.x's StreamEvent)", () => {
    const line = (value: object) => parseLine(JSON.stringify({ type: "system", subtype: "task_started", ...value }));
    expect(line({ task_type: "local_bash", is_backgrounded: true, tool_use_id: "toolu_1", description: "Run tests" })).toEqual([{ kind: "backgroundStarted", id: "toolu_1", description: "Run tests", monitor: false }]);
    expect(line({ task_type: "local_bash", is_backgrounded: false, tool_use_id: "toolu_1" })).toEqual([]);
    expect(line({ task_type: "monitor_ws", tool_use_id: "toolu_2", description: "Watch" })).toEqual([{ kind: "backgroundStarted", id: "toolu_2", description: "Watch", monitor: true }]);
    expect(line({ task_type: "monitor_mcp", ambient: true, tool_use_id: "toolu_3" })).toEqual([]);
  });

  it("running ones keep the bot awake for 6 hours at most", () => {
    expect(hasBackgroundWorkRunning([reply([task({})])])).toBe(true);
    expect(hasBackgroundWorkRunning([reply([task({ startedAt: toSwiftDate(Date.now() - 7 * 3600_000) })])])).toBe(false);
  });

  it("cut off ones make the wake note (1.x's interruptedNote), told once", () => {
    const records = [reply([task({ detail: "npm test\n--watch" }), task({ id: "toolu_2", kind: "monitor", title: "Watch logs" })])];
    expect(stopBackgroundTasks(records, "interrupted")).toHaveLength(1);
    const note = interruptedNote(records)!;
    expect(note.split("\n")[0]).toBe("(App: This background work of yours never finished: it went away with its process before it reported. Nothing of it is running now. Start again whatever still needs doing; leave out what no longer matters.)");
    expect(note.split("\n")[1]).toMatch(/^- background command "Run tests" \(started \d\d\/\d\d, \d\d:\d\d, killed when the app restarted\): npm test --watch$/);
    expect(note.split("\n")[2]).toMatch(/^- Monitor "Watch logs" \(started .*, killed when the app restarted\)$/);
    expect(markCutOffTasksTold(records)).toHaveLength(1);
    expect(interruptedNote(records)).toBeNull();
  });
});

const harnesses: CoreHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});

describe("background work through the core", () => {
  it("work running when the app went away is interrupted, and the next wake is told about it once", async () => {
    const dir = tempDir("background");
    mkdirSync(join(dir, "main"), { recursive: true });
    writeFileSync(join(dir, "main", "chat.json"), JSON.stringify([reply([task({ title: "Build the app", detail: "npm run dist:dir" })])]));
    const c = new CoreHarness(dir, { FAKE_CLAUDE_INPUT: join(dir, "input.log") });
    harnesses.push(c);
    const saved = () => JSON.parse(readFileSync(join(dir, "main", "chat.json"), "utf8"))[0].backgroundTasks[0];
    await until(() => existsSync(join(dir, "main", "chat.json")) && saved().status === "interrupted", { what: "the task marked interrupted" });
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "hello" });
    await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId));
    const woke = JSON.parse(readFileSync(join(dir, "input.log"), "utf8").trim().split("\n").at(-1)!).text as string;
    expect(woke).toMatch(/\(App: This background work of yours never finished[^\n]*\n- background command "Build the app" \(started [^)]*, killed when the app restarted\): npm run dist:dir\n\n/);
    await until(() => saved().told === true, { what: "told" });
  });
});
