// M7-11a review probe: a slot owner installed after its contributors (inpage-host.ts `define`): fail closed while it loads, the
// feed's rows back only with `feed.refresh`, a non-feed contributor's never (none contributes to these slots today).
import { describe, expect, it } from "vitest";
import { Kernel, canonicalSlot } from "../../../Web/src/plugin-kernel";
import type { PluginsView } from "../../src/contract";
import { PLUGIN_OWNED_SLOTS } from "../../src/renderer/shell/feed-slots";
import { PluginFeed } from "../../src/renderer/shell/plugin-feed";
import { deferred, flush } from "../kernel-driver";

const SETTINGS = ":settings";
const SECTION = "settings/section";
const row = { plugin: "alpha.tools", id: "alpha.tools.settings", title: "Alpha" };
const view = { plugins: [], settingsSections: [row], broken: [], host: { running: true, problem: null }, secretsProblem: null } as unknown as PluginsView;

describe("a slot owner installed after its contributors (the late settings plugin)", () => {
  it("shows nothing while it loads, holds the feed's rows back until refresh, and gives a non-feed contributor nothing back", async () => {
    const kernel = new Kernel({ slotName: canonicalSlot });
    const feed = new PluginFeed(kernel);
    feed.reconcile(view);
    kernel.install({ name: "page.x", contributes: { slots: [SECTION] } });
    await kernel.load("page.x", (plugin) => { kernel.contribute(plugin, SECTION, { kind: "component", tag: "x" }); });
    // No owner installed: both load (K2 has no owner to wait for) and both contributions are refused.
    expect([kernel.state("alpha.tools"), kernel.state("page.x")]).toEqual(["active", "active"]);
    expect(kernel.allContributions()).toEqual([]);

    kernel.install({ name: SETTINGS, provides: { slots: PLUGIN_OWNED_SLOTS } });
    const gate = deferred();
    const loading = kernel.load(SETTINGS, async (plugin) => { for (const slot of PLUGIN_OWNED_SLOTS) kernel.provideSlot(plugin, slot); await gate.promise; });
    await flush();
    // The owner is loading: the contributors are still active, nothing shows, a new contribution is refused, a new instance waits.
    expect([kernel.state(SETTINGS), kernel.state("alpha.tools"), kernel.state("page.x")]).toEqual(["loading", "active", "active"]);
    expect([kernel.entries(SECTION), kernel.contribute("page.x", SECTION, { kind: "component", tag: "late" })]).toEqual([[], null]);
    kernel.install({ name: "page.y", contributes: { slots: [SECTION] } });
    expect((await kernel.load("page.y", () => undefined)).status).toBe("waiting");

    gate.resolve();
    expect((await loading).status).toBe("active");
    // Active owner: the kernel did not reload the contributors, so the slot holds only what came after (page.y, nothing).
    expect([feed.rows(SECTION), kernel.state("page.y")]).toEqual([[], "active"]);
    // The host's refresh (inpage-host.ts, right after the load) brings the feed's row back; page.x's stays lost until it reloads.
    feed.refresh(PLUGIN_OWNED_SLOTS);
    expect(feed.rows(SECTION)).toEqual([row]);
    expect(kernel.entries(SECTION).map((entry) => entry.plugin)).toEqual(["alpha.tools"]);
  });

  it("does not activate a contributor that was still loading when the owner was installed (only ones already active stay)", async () => {
    const kernel = new Kernel({ slotName: canonicalSlot });
    kernel.install({ name: "page.z", contributes: { slots: [SECTION] } });
    const slow = deferred();
    const loading = kernel.load("page.z", () => slow.promise);
    kernel.install({ name: SETTINGS, provides: { slots: PLUGIN_OWNED_SLOTS } });
    const owner = deferred();
    void kernel.load(SETTINGS, (plugin) => { for (const slot of PLUGIN_OWNED_SLOTS) kernel.provideSlot(plugin, slot); return owner.promise; });
    slow.resolve();
    // K2 at Activate: the owner is declared and loading, so page.z may not become active (today the load fails and is not retried).
    expect([(await loading).status, kernel.state("page.z")]).toEqual(["failed", "absent"]);
    owner.resolve();
    await flush();
    expect(kernel.state(SETTINGS)).toBe("active");
  });
});
