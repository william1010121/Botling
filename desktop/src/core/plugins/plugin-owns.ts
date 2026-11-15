// What a plugin owns (M7-04a, v1 §23 step 4 "the Note owns its server data, tier write"): the server data only that plugin writes.
// Today the one such data is the bots' notes (`note`): a plugin may change a bot's note only when it is shipped with Botling (its
// grant is `grantedBy: builtin`, tier write: plugin-rows.ts) and its package.json says `ccb.owns: ["note"]`. The check is made
// where the write happens (requests.ts), after the plugin's own `files` permission, so a library plugin that names `owns` in its
// package.json still owns nothing. The bots' own `app_note_*` tools do not come through here: they use the core's note store.
import { title } from "./manifest";
import type { InstalledPlugin } from "./registry";

/** The name the Note's server data goes by in `ccb.owns`. */
export const NOTE_DATA = "note";

/** What `plugin` owns: nothing unless it ships with Botling. */
export function ownedData(plugin: InstalledPlugin): readonly string[] {
  return plugin.builtIn && plugin.enabled ? plugin.manifest.ccb?.owns ?? [] : [];
}

/** Refuses (throws) unless `plugin` owns the bots' notes; `what` says what it tried, e.g. "Changing a bot's note". */
export function mustOwnNote(plugin: InstalledPlugin, what: string): void {
  if (!ownedData(plugin).includes(NOTE_DATA)) throw new Error(`${what} is only for the plugin that owns the notes (the built-in Note); "${title(plugin.manifest)}" does not.`);
}
