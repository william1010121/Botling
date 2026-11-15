// @vitest-environment jsdom
// M7-02c review: the settings plugin (the owner of two slots) unloading and loading again, with the plugin feed on the same kernel,
// never double-registers and never leaks a registration (counts per plugin and slot, unique registration ids).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginsView } from "../../src/contract";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { rendererKernel } from "../../src/renderer/renderer-kernel";
import { SETTINGS_PLUGIN } from "../../src/renderer/settings-names";
import { InPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { pluginFeed, reconcileView } from "../../src/renderer/shell/plugin-feed";
import { desktop } from "../helpers";

const manifest = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const fixture = (): PluginsView => JSON.parse(readFileSync(join(desktop, "test", "fixtures", "kernel-goldens", "plugins-list.json"), "utf8")) as PluginsView;
const hosts: InPageHost[] = [];
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.stop();
  reconcileView(null);
});
const host = () => { const one = new InPageHost({ manifest }); hosts.push(one); return one; };
const gone = () => vi.waitFor(() => { expect(rendererKernel.state(SETTINGS_PLUGIN)).toBe("absent"); expect(rendererKernel.declaration(SETTINGS_PLUGIN)).toBeUndefined(); });

/** Every registration the kernel holds, counted by plugin and slot, and the ids (they must be unique). */
function census() {
  const all = rendererKernel.allContributions();
  const counts = new Map<string, number>();
  for (const { plugin, slot } of all) counts.set(`${plugin} ${slot}`, (counts.get(`${plugin} ${slot}`) ?? 0) + 1);
  const ids = all.map((one) => (one as unknown as { registration: { id: string } }).registration?.id ?? JSON.stringify(one));
  return { total: all.length, counts, ids, plugins: [...rendererKernel.plugins()].sort(), installed: [...rendererKernel.installed()].sort() };
}

describe("owner cycles with the feed (the feed's refresh after each load and unload)", () => {
  it("six unload/load cycles of botling.settings leave exactly the registrations of the first load: no double registration, no leak", async () => {
    const view = fixture();
    const settingsRows = (view.settingsSections ?? []).length + (view.quickSettings ?? []).length;
    expect(settingsRows).toBeGreaterThan(0);
    reconcileView(view);
    const one = host();
    await one.start();
    const base = census();
    expect(new Set(base.ids).size).toBe(base.ids.length);
    expect(base.total).toBeGreaterThan(12 + settingsRows);
    for (let cycle = 0; cycle < 6; cycle++) {
      expect(one.unload(SETTINGS_PLUGIN), `cycle ${cycle}`).toBe(true);
      await gone();
      const away = census();
      // Away: the 12 core pages and every plugin's settings/quick rows are gone; every other registration is exactly as before.
      expect(away.total, `cycle ${cycle} away`).toBe(base.total - 12 - settingsRows);
      expect(new Set(away.ids).size, `cycle ${cycle} away ids`).toBe(away.ids.length);
      for (const [key, count] of away.counts) expect(count, key).toBe(base.counts.get(key));
      expect(away.plugins).toEqual(base.plugins.filter((name) => name !== SETTINGS_PLUGIN));
      expect(away.installed).toEqual(base.installed.filter((name) => name !== SETTINGS_PLUGIN));
      const [result] = await one.start();
      expect(result.status).toBe("loaded");
      const back = census();
      expect(back.total, `cycle ${cycle} back`).toBe(base.total);
      expect(new Set(back.ids).size, `cycle ${cycle} back ids`).toBe(back.ids.length);
      expect([...back.counts].sort()).toEqual([...base.counts].sort());
      expect(back.plugins).toEqual(base.plugins);
      expect(back.installed).toEqual(base.installed);
      expect(pluginFeed.loaded().sort()).toEqual(view.plugins.map((plugin) => plugin.name).sort());
    }
  });

  it("an owner that comes and goes while the view changes under it (a plugin turned off while the owner is away) leaves no registration of that plugin", async () => {
    const view = fixture();
    reconcileView(view);
    const one = host();
    await one.start();
    one.unload(SETTINGS_PLUGIN);
    await gone();
    // zed.tools disappears from the list while the owner is away.
    const next = { ...view, plugins: view.plugins.map((p) => (p.name === "zed.tools" ? { ...p, enabled: false } : p)) } as PluginsView;
    for (const key of ["mainTabs", "settingsSections", "quickSettings", "rightPanelSections", "takeovers", "bottomPanels", "chatHeaderViews", "composerBarViews"] as const) (next as any)[key] = (view[key] as any[] | undefined)?.filter((row) => row.plugin !== "zed.tools");
    next.menus = view.menus?.filter((row) => row.plugin !== "zed.tools");
    reconcileView(next);
    await one.start();
    expect(rendererKernel.allContributions().filter(({ plugin }) => plugin === "zed.tools")).toEqual([]);
    expect(rendererKernel.declaration("zed.tools")).toBeUndefined();
    expect(pluginFeed.loaded()).not.toContain("zed.tools");
    // and the others got their settings rows back exactly once
    expect(pluginFeed.rows("view/settings.section")).toEqual(next.settingsSections);
    expect(pluginFeed.rows("view/quickSettings")).toEqual(next.quickSettings);
  });
});
