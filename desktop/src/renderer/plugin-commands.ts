// Plugin commands in the app page (plugin-platform.md §3.3, steps M4 and M6): the / menu and the menus are
// made from the core's one list (PluginsView `keybindings`, `slash`, `menus`), and a command the chat page
// asks for runs only when a key, the / menu or that menu offers it now. The chat page is one realm with the
// plugins' web parts, so this is no wall against them; it keeps it from running any other command.
import { bottomPanelToggledBy } from "./BottomPanels";
import type { PluginsView } from "../contract";
import { legacyKey, type PluginKeybinding } from "../contract/shortcuts";
import latex from "../../builtin-plugins/ccb-latex/package.json";
import design from "../../builtin-plugins/botling.design/package.json";

/**
 * Without a plugins view (Botling Web: the phone is told nothing of plugins and runs none of them) the chat
 * page still has two first-party plugins, read from their own manifests: ccb-latex, whose web part Botling Web
 * bundles (its key runs there), and botling.design's /design. On the desktop the core's view has them.
 */
const STANDALONE: PluginsView = {
  plugins: [{
    name: latex.name, title: latex.displayName, version: latex.version, description: latex.description, enabled: true, failure: null, installedFrom: null, builtIn: true,
    permissions: latex.ccb.permissions, parts: ["web"], settings: [], panels: [], commands: latex.ccb.contributes.commands.map(({ id, title }) => ({ id, title, registered: false })),
  }],
  broken: [], host: { running: false, problem: null }, secretsProblem: null,
  keybindings: latex.ccb.contributes.commands.flatMap(({ id, title, key }) => { const combo = legacyKey(key); return combo ? [{ command: id, key: combo, plugin: latex.name, title }] : []; }),
  slash: design.ccb.contributes.slash.map((entry) => ({ ...entry, plugin: design.name })),
};
const viewOf = (plugins: PluginsView | null | undefined): PluginsView => plugins ?? STANDALONE;

/** Every plugin key, built-in plugins' first (the core lists them first). */
export function keybindingsOf(plugins: PluginsView | null | undefined): PluginKeybinding[] {
  return [...(viewOf(plugins).keybindings ?? [])];
}

/** A row of the / menu; `command` (a plugin's) runs when picked instead of going into the message. */
export interface SlashCommand { name: string; about: string; command?: string }
export type PluginMenu = NonNullable<PluginsView["menus"]>[number]["menu"];
export type CommandVia = "key" | "slash" | "menu";

/** The / menu's commands: built-in plugins' first (/design), then the others' by plugin name; a name already taken reads "name (plugin)". */
export function slashMenu(plugins: PluginsView | null | undefined): SlashCommand[] {
  const view = viewOf(plugins);
  const builtIn = new Set(view.plugins.filter((plugin) => plugin.builtIn).map((plugin) => plugin.name));
  const rank = (plugin: string) => (builtIn.has(plugin) ? 0 : 1);
  const contributed = [...(view.slash ?? [])].sort((a, b) => rank(a.plugin) - rank(b.plugin) || (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0));
  const out: SlashCommand[] = [];
  const taken = new Set<string>();
  for (const entry of contributed) {
    const name = taken.has(entry.name.toLowerCase()) ? `${entry.name} (${entry.plugin})` : entry.name;
    taken.add(name.toLowerCase());
    out.push({ name, about: entry.about, ...(entry.command ? { command: entry.command } : {}) });
  }
  return out;
}

/** The commands plugins put in one of the app's menus, in order. */
export function menuItems(plugins: PluginsView | null | undefined, menu: PluginMenu): { command: string; title: string; icon?: string; quick?: boolean; alt?: string; hint?: string }[] {
  return (plugins?.menus ?? []).filter((item) => item.menu === menu).map((item) => ({
    command: item.command, title: item.title,
    ...(item.icon ? { icon: item.icon } : {}), ...(item.quick ? { quick: true } : {}), ...(item.alt ? { alt: item.alt } : {}), ...(item.hint ? { hint: item.hint } : {}),
  }));
}

/** Whether `id` is offered `via` a key, the / menu or `menu` now (what the chat page may ask the app page to run). */
export function offered(plugins: PluginsView | null | undefined, id: string, via: CommandVia, menu?: PluginMenu): boolean {
  if (via === "key") return keybindingsOf(plugins).some((binding) => binding.command === id);
  if (via === "slash") return (viewOf(plugins).slash ?? []).some((entry) => entry.command === id);
  return !!menu && (plugins?.menus ?? []).some((item) => item.menu === menu && item.command === id);
}

/**
 * Whether `id` runs in the plugin host: its program part registered it, or its plugin has no web part in the
 * chat page that could have. Otherwise the chat page runs it (a web part's `commands.register`).
 */
export function runsInHost(plugins: PluginsView | null | undefined, id: string): boolean {
  const plugin = viewOf(plugins).plugins.find((candidate) => id.startsWith(`${candidate.name}.`));
  return !plugin || !plugin.parts.includes("web") || plugin.commands.some((command) => command.id === id && command.registered);
}

/** Where a plugin command runs when a key, the / menu or a menu asks: a bottom panel's toggle is the page's own, else the host or the chat page. */
export function commandRoute(plugins: PluginsView | null | undefined, id: string): "bottomPanel" | "host" | "chat" {
  if (bottomPanelToggledBy(plugins, id)) return "bottomPanel";
  return runsInHost(plugins, id) ? "host" : "chat";
}
