// @vitest-environment node
// `PluginsView.tiles` through the built core (M7-03b): the page's feed turns these rows into the slots `panel/tile/*` (bot-panel-tiles.test.ts).
// The server asks for them; a bare `Plugins.view()` does not give them (the step-1 goldens, plugin-kernel-goldens.test.ts, read that one and
// stay byte for byte). A plugin that is turned off gives none.
import { afterEach, describe, expect, it } from "vitest";
import { tempDir, until } from "../helpers";
import { CoreHarness } from "../core-harness";
import { PluginsView } from "../../src/contract";

const harnesses: CoreHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});
const CARDS = "botling.cards";
const list = async (c: CoreHarness) => (await c.call({ type: "plugins.list" })) as PluginsView;
const tilesOf = (view: PluginsView, plugin: string) => (view.tiles ?? []).filter((tile) => tile.plugin === plugin);

describe("plugins.list carries the tiles of the plugins that are on", () => {
  it("botling.cards' preview card is a tile on all three surfaces; turned off, it is gone; turned on, it is back; the update event carries them too", async () => {
    const c = new CoreHarness(tempDir("view-tiles"), { BOTLING_ROUTINE_TICK_MS: "0", BOTLING_PLAIN_SHELL: "1", BOTLING_TEST_SEAL_KEY: "test-key" });
    harnesses.push(c);
    await until(async () => tilesOf(await list(c), CARDS).length > 0, { timeout: 20_000 });
    const view = await list(c);
    expect(PluginsView.safeParse(view).success).toBe(true);
    expect(tilesOf(view, CARDS)).toEqual([
      { plugin: CARDS, id: `${CARDS}.inline-report-block`, title: "inline-report-block", sizes: ["2x2"], surfaces: ["board", "whiteboard", "pin"] },
      { plugin: CARDS, id: `${CARDS}.網頁預覽卡片`, title: "網頁預覽卡片", sizes: ["2x2"], surfaces: ["board", "whiteboard", "pin"] },
    ]);
    // Every row is a plugin that is listed and on.
    for (const tile of view.tiles ?? []) expect(view.plugins.find((plugin) => plugin.name === tile.plugin)).toMatchObject({ enabled: true, failure: null });

    await c.call({ type: "plugins.enable", name: CARDS, enabled: false });
    expect(tilesOf(await list(c), CARDS)).toEqual([]);
    const updated = c.of("plugins.updated").map((event) => (event.event as { plugins: PluginsView }).plugins);
    expect(updated.length).toBeGreaterThan(0);
    expect(tilesOf(updated[updated.length - 1]!, CARDS)).toEqual([]);

    await c.call({ type: "plugins.enable", name: CARDS, enabled: true });
    expect(tilesOf(await list(c), CARDS)).toHaveLength(1);
  }, 60_000);
});
