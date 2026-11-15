// M5-09 (protocol v1 §9A.8, D53/D54): a link button on a peer bot's chat (`chat/link`, 「開始陪讀」) runs on the machine that owns the
// bot, as the plugin that contributes the button. So the button is offered only while that machine has the plugin (its
// `plugin:<name>` row in its table copy), and its command is attributed (`via`) to that machine's row (its code hash), never to the
// attached server's. Pure helpers for the renderer adapter (no Electron, no Node built-ins); the adapter is the only caller.
import type { PluginsView } from "../contract";
import { PluginRow } from "../protocol/table-rows";

type Menus = NonNullable<PluginsView["menus"]>;

/** Whether `rows` (a server's table) holds a valid row for the plugin. A `Map`, so a name such as `constructor` finds nothing (L-003). */
export function ownerHasPlugin(rows: ReadonlyMap<string, unknown> | null | undefined, name: string): boolean {
  if (!rows) return false;
  const row = rows.get(`plugin:${name}`);
  return row !== undefined && PluginRow.safeParse(row).success;
}

/**
 * The view for a chat of a peer's bot: its `chat/link` entries kept only for plugins the owner has (`rows` null: none; a missing
 * table fails closed, L-009). Every other entry, and the rest of the view, is as it was.
 */
export function withOwnerLinkMenus(plugins: PluginsView, rows: ReadonlyMap<string, unknown> | null | undefined): PluginsView {
  if (!plugins.menus) return plugins;
  const menus: Menus = plugins.menus.filter((entry) => entry.menu !== "chat/link" || ownerHasPlugin(rows, entry.plugin));
  return menus.length === plugins.menus.length ? plugins : { ...plugins, menus };
}

/** The plugin that contributes the `chat/link` entry running command `id` (null: no such entry in this view). */
export function chatLinkPlugin(plugins: PluginsView | null | undefined, id: string): string | null {
  const entry = plugins?.menus?.find((candidate) => candidate.menu === "chat/link" && candidate.command === id && id.startsWith(`${candidate.plugin}.`));
  return entry ? entry.plugin : null;
}

/** What the window was last told about `chat/link` entries: compared to know whether the list changed (null: no view yet). */
export function linkMenuKey(plugins: PluginsView | null | undefined): string | null {
  if (!plugins) return null;
  return JSON.stringify((plugins.menus ?? []).filter((entry) => entry.menu === "chat/link").map((entry) => [entry.plugin, entry.command]));
}
