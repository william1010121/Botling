// Settings' pages in four groups (App, Bots, Connect, Advanced): what each page is called, the words a search finds
// it by, and where plugins' own settings pages go (under Plugins, indented). Older page ids ("engines", "doctor")
// still open the page that took their settings over.
import type { PluginsView } from "../contract";
import { SETTINGS_GROUPS } from "./plugins/settings/pages";

export type CoreSection = "general" | "appearance" | "shortcuts" | "models" | "permissions" | "chat" | "setup" | "plugins" | "phone" | "machines" | "updates" | "developer";
/** Page ids from before the pages were grouped, still accepted (links, plugins' `after`). */
export type LegacySection = "engines" | "doctor";
/** A page of Settings: a core one, or a plugin's (`settings.section` view: "<plugin>/<view id>"). */
export type SettingsSection = CoreSection | LegacySection | `${string}/${string}`;

export type SettingsPage = { id: CoreSection | `${string}/${string}`; title: string; terms: string; plugin?: string; view?: string; indent?: boolean };
export type SettingsGroup = { title: string; pages: SettingsPage[] };

const LEGACY: Record<LegacySection, CoreSection> = { engines: "models", doctor: "setup" };

/** A group of core pages: what the settings plugin registers (plugins/settings/pages.ts), one registration per page. */
export type SettingsCoreGroup = { title: string; pages: (SettingsPage & { id: CoreSection })[] };
/** The core pages as data, kept exported here for tests: the settings plugin's data (M7-02c). */
export { SETTINGS_GROUPS } from "./plugins/settings/pages";

/** The page an id opens: an older id goes to the page that has its settings now. */
export function resolveSection(id: SettingsSection): CoreSection | `${string}/${string}` {
  return (LEGACY as Record<string, CoreSection>)[id] ?? (id as CoreSection | `${string}/${string}`);
}

/**
 * The groups with their pages, plugins' pages under Plugins (indented), filtered by `search` (a page's title or
 * terms; a group with no page left is left out). `core` is the core pages: what the settings plugin registered in the
 * `settings/section` slot (settings-slot.ts `coreSettings`), or the plugin's own data (the default; no shell around).
 */
export function settingsNav(plugins: PluginsView | null, search = "", core: readonly SettingsCoreGroup[] = SETTINGS_GROUPS): SettingsGroup[] {
  const words = search.trim().toLowerCase();
  const pluginPages: SettingsPage[] = (plugins?.settingsSections ?? []).map((entry) => ({ id: `${entry.plugin}/${entry.id}`, title: entry.title, terms: entry.terms, plugin: entry.plugin, view: entry.id, indent: true }));
  return core.map((group) => ({
    title: group.title,
    pages: group.pages.flatMap((page) => (page.id === "plugins" ? [page, ...pluginPages] : [page]))
      .filter((page) => !words || `${page.title} ${page.terms}`.toLowerCase().includes(words)),
  })).filter((group) => group.pages.length > 0);
}
