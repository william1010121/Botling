// Where Settings gets its core pages (M7-02c, M7-02d): from the `settings/section` slot of the renderer's kernel, where the settings
// plugin (plugins/settings/index.ts) registered them. `coreSettings()` answers what Settings draws:
//   - the plugin has registered pages: the groups its registrations make, in registration order (the slot also holds plugins' own
//     pages as feed rows; they are not core pages: settings-feed.ts gives those);
//   - none: no pages and `unavailable`: Settings shows the shell's "unavailable" line, not a blank page. This is the answer for every
//     way the plugin can be away (never loaded, refused, failed to load, unloaded by the host or by the kernel): nothing is drawn from
//     data the plugin did not register.
import { useMemo, useSyncExternalStore } from "react";
import type { Kernel } from "../../../Web/src/plugin-kernel";
import { rendererKernel, slotsVersion, subscribeSlots } from "./renderer-kernel";
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

export function coreSettings(kernel: Kernel = rendererKernel): CoreSettings {
  const groups = registeredCoreGroups(kernel);
  return groups.length ? { groups, unavailable: false } : { groups: [], unavailable: true };
}

/** `coreSettings()`, drawn again when the kernel's slots or the host's answer change. */
export function useCoreSettings(): CoreSettings {
  const version = useSyncExternalStore(subscribeSlots, slotsVersion, slotsVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => coreSettings(), [version]);
}
