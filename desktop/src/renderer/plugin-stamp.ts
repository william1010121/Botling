// Which version of a plugin an open frame was built from, and whether the plugin library has moved on since: after a one-click
// update (core/plugin-store.ts `direct`) the frame loads the new web part without being closed and opened again (Plugins.tsx
// `usePluginFrame`). Pure: no client, no DOM.
import type { PluginView } from "../contract";

/** What a frame was built from: the plugin's version (an update always moves it) and where it runs from (the library's copy or the built-in). */
export function pluginStamp(plugin: Pick<PluginView, "version" | "builtIn" | "replacesBuiltIn"> | undefined): string | null {
  if (!plugin) return null;
  return `${plugin.version}|${plugin.replacesBuiltIn ?? ""}|${plugin.builtIn ? "b" : "l"}`;
}

/**
 * Whether an open frame built from `loaded` must load again given the plugins now: the plugin is there and its stamp differs.
 * Nothing known yet (`loaded` null), or the plugin gone, never reloads (the page's own handling of a missing panel stays).
 */
export function frameNeedsReload(loaded: string | null, plugins: readonly Pick<PluginView, "name" | "version" | "builtIn" | "replacesBuiltIn">[], name: string): boolean {
  if (loaded === null) return false;
  const now = pluginStamp(plugins.find((plugin) => plugin.name === name));
  return now !== null && now !== loaded;
}
