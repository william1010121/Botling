// The main bot's whiteboard data (`whiteboard.view`): each bot's memory.md sections, its task cards and
// its results, from what the bot keeps itself; nothing for the main bot (it is not a card).
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import { saveProjectRow } from "../../src/core/projects";
import { WhiteboardView } from "../../src/contract";

const harnesses: CoreHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});

const PROJECT = "6A0B0000-0000-4000-8000-0000000000B1";

describe("whiteboard.view", () => {
  it("reads every bot's Current status, In progress and Decided, its tasks and results; a bot with no memory gets empty lists", async () => {
    const dir = tempDir("whiteboard");
    const folder = join(tempDir("wb-proj"), "Site");
    mkdirSync(join(folder, ".bot"), { recursive: true });
    writeFileSync(join(folder, ".bot", "memory.md"), "## Current status\n- The theme is live.\n## In progress\n- Dark mode\n- RSS feed\n## Waiting on you\n- Which domain?\n## Decided\n- Kept the old URLs (redirects cost nothing)\n");
    saveProjectRow(dir, { id: PROJECT, name: "Site", folder, avatar: "triangle" });
    mkdirSync(join(dir, "projects", PROJECT), { recursive: true });
    writeFileSync(join(dir, "projects", PROJECT, "tasks.json"), JSON.stringify([
      { id: "t-done", name: "Ship the theme", state: "done", createdAt: 1, updatedAt: 2, messageIDs: [], kept: true, declared: true },
      { id: "t-run", name: "Dark mode", state: "running", now: "Picking colours", next: "Test on phones", createdAt: 1, updatedAt: 3, messageIDs: [], kept: true, declared: true },
    ]));
    const c = new CoreHarness(dir, { BOTLING_ROUTINE_TICK_MS: "0", BOTLING_COMPONENT_SCAN_MS: "0", BOTLING_WAITING_SCAN_MS: "0" });
    harnesses.push(c);
    const view = await c.call({ type: "whiteboard.view" });
    expect(WhiteboardView.safeParse(view).success).toBe(true);
    const site = view.bots.find((entry: any) => entry.botId === PROJECT);
    expect(site).toMatchObject({ currentStatus: ["The theme is live."], inProgress: ["Dark mode", "RSS feed"], decided: ["Kept the old URLs (redirects cost nothing)"], results: [] });
    expect(site.tasks.map((task: any) => [task.name, task.state, task.next])).toEqual([["Ship the theme", "done", null], ["Dark mode", "running", "Test on phones"]]);
    // The main bot is not a card; Maintainer (no memory yet) is, with nothing in it.
    expect(view.bots.some((entry: any) => entry.botId === MAIN)).toBe(false);
    const maintainer = view.bots.find((entry: any) => entry.botId === "DEC0DE00-0000-4000-8000-00000000DEC0");
    expect(maintainer).toMatchObject({ currentStatus: [], inProgress: [], decided: [] });
  });
});

describe("whiteboard.view stamps", () => {
  it("answers `same` with no bots while nothing changed, and the new board once a memory.md changes", async () => {
    const dir = tempDir("whiteboard-stamp");
    const folder = join(tempDir("wb-stamp-proj"), "Site");
    mkdirSync(join(folder, ".bot"), { recursive: true });
    writeFileSync(join(folder, ".bot", "memory.md"), "## Current status\n- One\n");
    saveProjectRow(dir, { id: PROJECT, name: "Site", folder, avatar: "triangle" });
    const c = new CoreHarness(dir, { BOTLING_ROUTINE_TICK_MS: "0", BOTLING_COMPONENT_SCAN_MS: "0", BOTLING_WAITING_SCAN_MS: "0" });
    harnesses.push(c);
    const first = await c.call({ type: "whiteboard.view" });
    expect(first.stamp).toEqual(expect.any(String));
    expect(first.bots.find((entry: any) => entry.botId === PROJECT).currentStatus).toEqual(["One"]);
    const again = await c.call({ type: "whiteboard.view", since: first.stamp });
    expect(again).toEqual({ bots: [], stamp: first.stamp, same: true });
    expect(WhiteboardView.safeParse(again).success).toBe(true);
    writeFileSync(join(folder, ".bot", "memory.md"), "## Current status\n- Two, now\n");
    const changed = await c.call({ type: "whiteboard.view", since: first.stamp });
    expect(changed.same).toBeUndefined();
    expect(changed.stamp).not.toBe(first.stamp);
    expect(changed.bots.find((entry: any) => entry.botId === PROJECT).currentStatus).toEqual(["Two, now"]);
    // An old or foreign stamp gets the whole board.
    expect((await c.call({ type: "whiteboard.view", since: "other:1" })).bots.length).toBeGreaterThan(0);
  });
});
