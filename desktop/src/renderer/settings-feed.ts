// What plugins put in the settings plugin's slots (M7-02d): their own pages of Settings in `settings/section` and their blocks in
// the sidebar gear's popover in `settings/quick`. Both are rows the plugin feed registered (shell/plugin-feed.ts: the
// `PluginsView` row as the page received it), and they are there only while `botling.settings` owns the slots: with the plugin
// away the kernel takes no row and the lists are empty. Settings and the gear read them here, not from `PluginsView`.
//
// The rows come in the plugin list's order (`rowsInListOrder`), not in registration order: a plugin switched off and on again
// registers last, and the page must not move its entry for that.
import { useMemo, useSyncExternalStore } from "react";
import type { PluginsView } from "../contract";
import { slotsVersion, subscribeSlots } from "./renderer-kernel";
import { QUICK_SLOT, SECTION_SLOT } from "./settings-names";
import type { PluginSettingsRow } from "./settings-pages";
import { pluginFeed, type PluginFeed } from "./shell/plugin-feed";

/** A plugin's block in the gear's popover (one `quickSettings` view row). */
export type QuickSettingsRow = NonNullable<PluginsView["quickSettings"]>[number];

export interface PluginSettings {
  /** The plugins' pages of Settings, for `settingsNav` and the gear's links. */
  pages: readonly PluginSettingsRow[];
  /** The plugins' blocks in the gear's popover. */
  quick: readonly QuickSettingsRow[];
}

export function pluginSettings(feed: Pick<PluginFeed, "rowsInListOrder"> = pluginFeed): PluginSettings {
  return { pages: feed.rowsInListOrder<PluginSettingsRow>(SECTION_SLOT), quick: feed.rowsInListOrder<QuickSettingsRow>(QUICK_SLOT) };
}

/** `pluginSettings()`, read again when the kernel's slots change (a plugin switched on or off, the settings plugin loaded or unloaded). */
export function usePluginSettings(): PluginSettings {
  const version = useSyncExternalStore(subscribeSlots, slotsVersion, slotsVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => pluginSettings(), [version]);
}
