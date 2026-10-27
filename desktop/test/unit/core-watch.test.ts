// The built core no longer polls the component library (1.x: every 1.5 s) or bots' memory files (every
// 5 s): both are watched. With the slow look set far off, a change on disk still reaches the page at once.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until, sleep } from "../helpers";
import { CoreHarness } from "../core-harness";
import { saveProjectRow } from "../../src/core/projects";
import { writeLibrary } from "../fixtures/components";

const harnesses: CoreHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});
const PROJECT = "6A0B0000-0000-4000-8000-0000000000C1";
// Ten minutes: no slow look happens during a test.
const FAR = "600000";

describe("the core watches instead of polling", () => {
  it("a component added on disk reaches the page without the library clock", async () => {
    const dir = tempDir("core-watch-components");
    writeLibrary(dir);
    const c = new CoreHarness(dir, { BOTLING_ROUTINE_TICK_MS: "0", BOTLING_COMPONENT_SCAN_MS: FAR, BOTLING_WAITING_SCAN_MS: "0" });
    harnesses.push(c);
    await c.call({ type: "chat.snapshot" });
    await sleep(500);
    expect(c.of("components.updated")).toHaveLength(0);
    mkdirSync(join(dir, "plugins", "other", "components", "weather"), { recursive: true });
    writeFileSync(join(dir, "plugins", "other", "components", "weather", "template.html"), "<div>Sunny</div>");
    writeFileSync(join(dir, "plugins", "other", "components", "weather", "about.md"), "Weather card: today's weather.");
    const event = await until(() => c.of("components.updated").find((e) => "weather" in (e.event as any).components), { timeout: 5_000 });
    expect((event.event as any).components.weather).toMatchObject({ version: 0 });
  });

  it("a project's memory.md \"Waiting on you\" reaches the page without the waiting clock", async () => {
    const dir = tempDir("core-watch-waiting");
    const folder = join(tempDir("core-watch-proj"), "Site");
    mkdirSync(join(folder, ".bot"), { recursive: true });
    writeFileSync(join(folder, ".bot", "memory.md"), "## Current status\n- Fine\n## Waiting on you\n");
    saveProjectRow(dir, { id: PROJECT, name: "Site", folder, avatar: "triangle" });
    const c = new CoreHarness(dir, { BOTLING_ROUTINE_TICK_MS: "0", BOTLING_COMPONENT_SCAN_MS: "0", BOTLING_WAITING_SCAN_MS: FAR });
    harnesses.push(c);
    expect((await c.call({ type: "waiting.list" })).items).toEqual([]);
    await sleep(500);
    writeFileSync(join(folder, ".bot", "memory.md"), "## Current status\n- Fine\n## Waiting on you\n- Which domain?\n");
    const event = await until(() => c.of("waiting.updated").at(-1), { timeout: 5_000 });
    expect((event.event as any).waiting.items).toEqual([{ botId: PROJECT, text: "Which domain?", messageId: null }]);
  });
});
