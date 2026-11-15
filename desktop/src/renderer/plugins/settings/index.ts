// `botling.settings`, the first in-page built-in plugin (M7-02c; plugin-kernel design §23 step 2, D56). Loaded by the shell's trusted
// loader (shell/inpage-loader.ts) only because the FE build shipped this folder: its name and the hash of the whole folder are in
// fe-build-manifest.json. It owns two slots:
//   - `settings/section` (2.x `view/settings.section`): the Settings pages. It registers the core pages (pages.ts) in order, one
//     registration each, `{kind: "settings-page", group, page}`; a plugin's own `settings.section` view lands in the same slot as a
//     registration of that plugin (the feed's `{kind: "feed", row}`, shell/plugin-feed.ts), after the core pages.
//   - `settings/quick` (2.x `view/quickSettings`): the sidebar gear's quick settings; plugins' views land here. Nothing core in it.
// The shell keeps the Plugins page's grant sheet and approve controls (they are the shell's, not this plugin's).
import type { PluginDeclaration } from "../../../../../Web/src/plugin-kernel";
import { isInPageApi } from "../../shell/inpage-host";
import { SETTINGS_GROUPS } from "./pages";
import { QUICK_SLOT, SECTION_SLOT, SETTINGS_PLUGIN, type SettingsPageEntry } from "../../settings-names";

export const settingsDeclaration: PluginDeclaration = { name: SETTINGS_PLUGIN, provides: { slots: [SECTION_SLOT, QUICK_SLOT] } };

export function activate(api: unknown): Promise<() => void> {
  if (!isInPageApi(api)) return Promise.reject(new Error("no in-page api"));
  return api.define(settingsDeclaration, (kernel, plugin) => {
    kernel.provideSlot(plugin, SECTION_SLOT);
    kernel.provideSlot(plugin, QUICK_SLOT);
    for (const group of SETTINGS_GROUPS) {
      for (const page of group.pages) {
        // The plugin owns the slot, so the kernel takes this while it loads; a refusal fails the load (nothing half-registered stays).
        if (!kernel.contribute(plugin, SECTION_SLOT, { kind: "settings-page", group: group.title, page } satisfies SettingsPageEntry)) throw new Error(`the kernel refused the ${page.id} page`);
      }
    }
  });
}
