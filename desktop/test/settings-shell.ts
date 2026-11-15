// A stand-in for the shell around Settings in a component test (M7-02d). Settings and the sidebar gear draw only from the renderer
// kernel's slots (settings/section, settings/quick), so a test that renders `SettingsSheet` or `SidebarSettings` loads the
// settings plugin the way the shell does (the real `InPageHost`, the real module) and, when the test has a plugin list, hands it to
// the plugin feed the way `ShellFrame` does (`reconcileView`).
//
// The manifest is an explicit stand-in: the host trusts the manifest's own pair (the page's bundle is the trust root for code it
// bundled), so any well-formed hash lets the real module load. A test of the FE build's own manifest reads that file itself.
import type { PluginsView } from "../src/contract";
import { SETTINGS_PLUGIN } from "../src/renderer/settings-names";
import { InPageHost } from "../src/renderer/shell/inpage-host";
import { reconcileView } from "../src/renderer/shell/plugin-feed";

export const STAND_IN_MANIFEST = { plugins: [{ name: SETTINGS_PLUGIN, codeHash: "0".repeat(64) }] };

export interface SettingsShell {
  host: InPageHost;
  /** Takes the plugin list and everything the shell loaded back out of the kernel. */
  stop(): Promise<void>;
}

/** Loads `botling.settings` into the renderer's kernel and gives the feed `view` (null: no plugin list). Await `stop()` in `afterEach`. */
export async function loadSettingsShell(view: PluginsView | null = null): Promise<SettingsShell> {
  const host = new InPageHost({ manifest: STAND_IN_MANIFEST, log: () => undefined });
  await host.start();
  reconcileView(view);
  return { host, async stop() { reconcileView(null); await host.stop(); } };
}
