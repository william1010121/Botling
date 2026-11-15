// Where Settings gets its core pages (M7-02c): from the `settings/section` slot of the renderer's kernel, where the settings plugin
// (plugins/settings/index.ts) registered them. `coreSettings()` answers what Settings draws:
//   - the plugin is up: the groups its registrations make, in registration order (the slot also holds plugins' own pages as feed
//     rows; they are not core pages and are left to `settingsNav`'s plugin pages);
//   - the shell's host refused it, it failed to load or it was unloaded (shell/inpage-host.ts): no pages and `unavailable`: Settings
//     shows the shell's "unavailable" line, not a blank page;
//   - the host never touched it (a page drawn without a shell, a component test): the plugin's own data, the same pages.
import { useMemo, useSyncExternalStore } from "react";
import type { Kernel } from "../../../Web/src/plugin-kernel";
import { rendererKernel, slotsVersion, subscribeSlots } from "./renderer-kernel";
import { inPageHost, type InPageHost } from "./shell/inpage-host";
import { SETTINGS_GROUPS } from "./plugins/settings/pages";
import { SECTION_SLOT, SETTINGS_PLUGIN, type SettingsPageEntry } from "./settings-names";
import type { SettingsCoreGroup } from "./settings-pages";

export interface CoreSettings { groups: readonly SettingsCoreGroup[]; unavailable: boolean }

/** The core pages the settings plugin has registered, grouped, in registration order (empty when it is not up). */
export function registeredCoreGroups(kernel: Kernel = rendererKernel): SettingsCoreGroup[] {
  const groups: SettingsCoreGroup[] = [];
  for (const { plugin, entry } of kernel.entries<Partial<SettingsPageEntry>>(SECTION_SLOT)) {
    // Only the settings plugin's own registrations are core pages.
    if (plugin !== SETTINGS_PLUGIN || entry.kind !== "settings-page" || !entry.page || typeof entry.group !== "string") continue;
    let group = groups.find((one) => one.title === entry.group);
    if (!group) groups.push((group = { title: entry.group, pages: [] }));
    group.pages.push(entry.page);
  }
  return groups;
}

export function coreSettings(kernel: Kernel = rendererKernel, host: Pick<InPageHost, "unavailable"> = inPageHost): CoreSettings {
  const groups = registeredCoreGroups(kernel);
  if (groups.length) return { groups, unavailable: false };
  if (host.unavailable(SETTINGS_PLUGIN)) return { groups: [], unavailable: true };
  return { groups: SETTINGS_GROUPS, unavailable: false };
}

/** `coreSettings()`, drawn again when the kernel's slots or the host's answer change. */
export function useCoreSettings(): CoreSettings {
  const version = useSyncExternalStore(subscribeSlots, slotsVersion, slotsVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => coreSettings(), [version]);
}
