// The names the shell and the settings plugin (plugins/settings/index.ts) agree on (M7-02c). Pure: the shell reads them without
// importing the plugin's module (that one runs only through the trusted loader).
import type { SettingsCoreGroup } from "./settings-pages";

export const SETTINGS_PLUGIN = "botling.settings";
/** The settings plugin's slots, by their new names (the kernel finds them under the 2.x ids `view/settings.section`, `view/quickSettings` too). */
export const SECTION_SLOT = "settings/section";
export const QUICK_SLOT = "settings/quick";

/** What the settings plugin registers in `settings/section` for one core page. */
export interface SettingsPageEntry { kind: "settings-page"; group: string; page: SettingsCoreGroup["pages"][number] }
