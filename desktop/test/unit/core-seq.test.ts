// M7-S69: the event number is moved by one transition, `Core.nextSeq()`; `CoreBots.removeBot` and `Core.event` ask for it (they do not
// set it). The plugin list is announced only when its text changed: `markPluginsShown` says true then, false when it already was shown.
// Probe left open by the M7-S63 review ("removeBot advances Core's seq").
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import { saveProjectRow } from "../../src/core/projects";
import { tempDir } from "../helpers";

const GONE = "98BDBF26-850C-4521-AEB4-CCF9073E8BD2";

function fixture() {
  const dir = tempDir("core-seq");
  const folder = tempDir("core-seq-folder");
  mkdirSync(join(folder, ".bot"), { recursive: true });
  writeFileSync(join(folder, "keep.txt"), "x");
  saveProjectRow(dir, { id: GONE, name: "gone", folder, avatar: "triangle" });
  const sent: { seq: number; event: { type: string } }[] = [];
  const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit: (envelope: any) => { sent.push(envelope); }, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  return { core, sent };
}

describe("Core.nextSeq", () => {
  it("is the one thing that moves the event number: removing a bot takes the next number, and `event` the one after it", async () => {
    const { core, sent } = fixture();
    const before = core.seq;
    expect(core.nextSeq()).toBe(before + 1);
    expect(core.seq).toBe(before + 1);
    sent.length = 0;
    await core.removeBot(GONE);
    const removed = sent.find((envelope) => envelope.event.type === "bot.removed");
    expect(removed?.seq).toBeGreaterThan(before + 1);
    // Every envelope the removal sent got its own number, in order, with no gap and no repeat; Core's counter is the last one.
    expect(sent.map((envelope) => envelope.seq)).toEqual(sent.map((_, index) => sent[0]!.seq + index));
    expect(core.seq).toBe(sent[sent.length - 1]!.seq);
    (core as any).event({ type: "bot.removed", botId: "nobody" });
    expect(sent[sent.length - 1]!.seq).toBe(core.seq);
    expect(core.seq).toBe(sent[sent.length - 2]!.seq + 1);
  });
});

describe("a plugin's push to its frames (frameEvent)", () => {
  it("goes out as its own envelope with the next number, once per push", () => {
    const { core, sent } = fixture();
    const world = (core as any).corePluginWorld.pluginOptions().world;
    const before = core.seq;
    world.frameEvent("botling.terminal", "terminal", undefined, { type: "data" });
    world.frameEvent("botling.terminal", "terminal", undefined, { type: "data" });
    expect(sent.filter((envelope) => envelope.event.type === "plugins.emit").map((envelope) => envelope.seq)).toEqual([before + 1, before + 2]);
    expect(core.seq).toBe(before + 2);
  });
});

describe("Core.markPluginsShown", () => {
  it("says true when the text is new (and keeps it as what is shown), false when it is the same", () => {
    const { core } = fixture();
    expect(core.markPluginsShown("[1]")).toBe(true);
    expect(core.lastPlugins).toBe("[1]");
    expect(core.markPluginsShown("[1]")).toBe(false);
    expect(core.markPluginsShown("[2]")).toBe(true);
    expect(core.lastPlugins).toBe("[2]");
  });

  it("starts out showing what the snapshot shows, so the first poll with the same list announces nothing", () => {
    const { core } = fixture();
    expect(core.lastPlugins).toBe(JSON.stringify((core as any).plugins.view()));
    expect(core.markPluginsShown(core.lastPlugins)).toBe(false);
  });
});
