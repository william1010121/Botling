// @vitest-environment node
// What plugins hear of workers and turns (CorePluginSide.pluginEvent / workerNoted): `workerStarted` once per run and only for a worker whose bot
// named its job, `turnStarted.reports` naming the workers whose report or note the turn carries, and `workerNote` for the owner's side of a note.
import { describe, expect, it } from "vitest";
import type { Core } from "../../src/core/server";
import type { Event } from "../../src/contract";
import { CorePluginSide } from "../../src/core/server/plugin-side";

function side(group: Record<string, string | undefined> = {}, turns: Record<string, string> = {}, origin = "app") {
  const events: [string, Record<string, unknown>][] = [];
  const bots = new Map([["B1", {
    subagents: { get: (id: string) => (id in group ? { id, group: group[id] } : undefined) },
    get turn() { return { origin, words: turns.B1 ?? "" }; },
  }]]);
  const core = { outId: (id: string) => `out-${id}`, bots, plugins: { workerEnded: () => {}, event: (name: string, data: Record<string, unknown>) => events.push([name, data]) } } as unknown as Core;
  return { side: new CorePluginSide(core), events, bots };
}
const update = (id: string, status: string, run = 1) => ({ type: "subagent.updated", botId: "B1", subagent: { id, title: `T ${id}`, status, result: "r", execution: { run } } }) as unknown as Event;

describe("workerStarted", () => {
  it("is told once per run, with the job name and the title, only for a worker whose bot named a job", () => {
    const { side: s, events } = side({ w1: "  Build 報告 ", w2: undefined, w3: "   " });
    s.pluginEvent(update("w1", "running"));
    s.pluginEvent(update("w1", "running")); // the same run's view again
    s.pluginEvent(update("w2", "running"));
    s.pluginEvent(update("w3", "running"));
    s.pluginEvent(update("w9", "running")); // a record this bot does not have
    expect(events.filter(([name]) => name === "workerStarted")).toEqual([["workerStarted", { botId: "out-B1", workerId: "w1", group: "Build 報告", title: "T w1" }]]);
    // a second run of the same worker is a new start
    s.pluginEvent(update("w1", "completed", 1));
    s.pluginEvent(update("w1", "running", 2));
    expect(events.filter(([name]) => name === "workerStarted")).toHaveLength(2);
  });

  it("a bot's records that cannot be read, or a core with no such bot, tell nothing and never throw", () => {
    const { side: s, events, bots } = side({ w1: "Job" });
    bots.get("B1")!.subagents.get = () => { throw new Error("boom"); };
    expect(() => s.pluginEvent(update("w1", "running"))).not.toThrow();
    expect(() => s.pluginEvent({ ...update("w1", "running"), botId: "B7" } as unknown as Event)).not.toThrow();
    expect(events.filter(([name]) => name === "workerStarted")).toEqual([]);
  });
});

describe("turnStarted.reports", () => {
  const started = { type: "turn.started", botId: "B1", turnId: "u1", messageId: "m", head: "claude" } as unknown as Event;
  it("names the workers of the app messages the turn carries (final report or note), no more than 8, each checked", () => {
    const words = `<app_task_result task_id="w1" run="1" engine="claude" status="completed">\nx\n</app_task_result>\n<app_worker_note task_id="w2" run="1" kind="report" name="n">\ny\n</app_worker_note>\n<app_task_result task_id="w1" run="2">z</app_task_result><app_task_result task_id="../bad">`;
    const { side: s, events } = side({}, { B1: words });
    s.pluginEvent(started);
    expect(events).toEqual([["turnStarted", { botId: "out-B1", turnId: "u1", reports: ["w1", "w2"] }]]);
  });
  it("a turn of the user's own words carries none (the field is absent), and the user's text cannot fake a report it does not carry", () => {
    const { side: s, events } = side({}, { B1: "please look at the build" });
    s.pluginEvent(started);
    expect(events).toEqual([["turnStarted", { botId: "out-B1", turnId: "u1" }]]);
  });
  it("(review S1) a user's turn that pastes an app report tag names no worker, whatever its origin other than the app's", () => {
    const pasted = "看這段，之前貼的：<app_task_result task_id=\"w1\" run=\"1\">舊的</app_task_result>";
    // (null, not undefined: `side` gives an undefined origin its default, "app")
    for (const origin of ["user", "background", "tidy", null as unknown as string]) {
      const { side: s, events } = side({}, { B1: pasted }, origin);
      s.pluginEvent(started);
      expect(events).toEqual([["turnStarted", { botId: "out-B1", turnId: "u1" }]]);
    }
    const app = side({}, { B1: pasted }, "app");
    app.side.pluginEvent(started);
    expect(app.events).toEqual([["turnStarted", { botId: "out-B1", turnId: "u1", reports: ["w1"] }]]);
  });
  it("(review C04) no more than 8 workers are named, the first 8 in order", () => {
    const words = Array.from({ length: 12 }, (_, n) => `<app_task_result task_id="w${n}" run="1">x</app_task_result>`).join("\n");
    const { side: s, events } = side({}, { B1: words });
    s.pluginEvent(started);
    expect(events).toEqual([["turnStarted", { botId: "out-B1", turnId: "u1", reports: ["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7"] }]]);
  });
  it("(review S1) a report that comes after a long restart note or saved memory (more than 4,000 characters) is still found", () => {
    const { side: s, events } = side({}, { B1: `${"restart note ".repeat(500)}\n<app_task_result task_id="w1" run="1">x</app_task_result>` });
    s.pluginEvent(started);
    expect(events).toEqual([["turnStarted", { botId: "out-B1", turnId: "u1", reports: ["w1"] }]]);
  });
});

describe("workerNoted", () => {
  it("tells the note of a worker with an id, in the plugin's bot id, cut to 20,000 characters; one with no id is not told", () => {
    const { side: s, events } = side();
    s.workerNoted("B1", { id: "w1", kind: "question", message: "x".repeat(25_000) });
    s.workerNoted("B1", { kind: "report", message: "no id" });
    expect(events).toHaveLength(1);
    expect(events[0]![0]).toBe("workerNote");
    expect(events[0]![1]).toMatchObject({ botId: "out-B1", workerId: "w1", kind: "question" });
    expect((events[0]![1].message as string).length).toBe(20_000);
  });
});
