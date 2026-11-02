// Plugin commands in the app page (plugin-platform.md §3.3, steps M4 and M6): the / menu and the menus are
// made from the core's one list (PluginsView `keybindings`, `slash`, `menus`), and a command the chat page
// asks for runs only when a key, the / menu or that menu offers it now. The chat page is one realm with the
// plugins' web parts, so this is no wall against them; it keeps it from running any other command.
import type { PluginsView } from "../contract";
import type { PluginKeybinding } from "../contract/shortcuts";

/** The app's own / commands (`SlashCommands.all`): picked, the name goes in as words; the bots' rules say what each means. */
export const BUILT_IN_SLASH: readonly { name: string; about: string }[] = [{ name: "design", about: "Make a Claude Design and get its claude.ai link" }];

/** Keys of the plugins bundled into the chat page (ccb-latex, not in the library): run there, rebound like any other. */
export const BUNDLED_KEYBINDINGS: readonly PluginKeybinding[] = [{ command: "ccb-latex.insert", key: "Mod+Shift+M", plugin: "ccb-latex", title: "Insert inline formula" }];
const bundled = (id: string) => BUNDLED_KEYBINDINGS.some((binding) => binding.command === id);

/** Every plugin key, the bundled ones first (a library plugin named like one does not replace it). */
export function keybindingsOf(plugins: PluginsView | null | undefined): PluginKeybinding[] {
  return [...BUNDLED_KEYBINDINGS, ...(plugins?.keybindings ?? []).filter((binding) => !BUNDLED_KEYBINDINGS.some((own) => own.plugin === binding.plugin))];
}

/** A row of the / menu; `command` (a plugin's) runs when picked instead of going into the message. */
export interface SlashCommand { name: string; about: string; command?: string }
export type PluginMenu = NonNullable<PluginsView["menus"]>[number]["menu"];
export type CommandVia = "key" | "slash" | "menu";

/** The / menu's commands: the app's own first, then plugins' by plugin name; a name already taken reads "name (plugin)". */
export function slashMenu(plugins: PluginsView | null | undefined): SlashCommand[] {
  const out: SlashCommand[] = BUILT_IN_SLASH.map((entry) => ({ ...entry }));
  const taken = new Set(out.map((entry) => entry.name.toLowerCase()));
  const contributed = [...(plugins?.slash ?? [])].sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0));
  for (const entry of contributed) {
    const name = taken.has(entry.name.toLowerCase()) ? `${entry.name} (${entry.plugin})` : entry.name;
    taken.add(name.toLowerCase());
    out.push({ name, about: entry.about, command: entry.command });
  }
  return out;
}

/** The commands plugins put in one of the app's menus, in order. */
export function menuItems(plugins: PluginsView | null | undefined, menu: PluginMenu): { command: string; title: string }[] {
  return (plugins?.menus ?? []).filter((item) => item.menu === menu).map((item) => ({ command: item.command, title: item.title }));
}

/** Whether `id` is offered `via` a key, the / menu or `menu` now (what the chat page may ask the app page to run). */
export function offered(plugins: PluginsView | null | undefined, id: string, via: CommandVia, menu?: PluginMenu): boolean {
  if (via === "key") return keybindingsOf(plugins).some((binding) => binding.command === id);
  if (via === "slash") return (plugins?.slash ?? []).some((entry) => entry.command === id);
  return !!menu && (plugins?.menus ?? []).some((item) => item.menu === menu && item.command === id);
}

/**
 * Whether `id` runs in the plugin host: its program part registered it, or its plugin has no web part in the
 * chat page that could have. Otherwise the chat page runs it (a web part's `commands.register`, a bundled plugin's).
 */
export function runsInHost(plugins: PluginsView | null | undefined, id: string): boolean {
  if (bundled(id)) return false;
  const plugin = plugins?.plugins.find((candidate) => id.startsWith(`${candidate.name}.`));
  return !plugin || !plugin.parts.includes("web") || plugin.commands.some((command) => command.id === id && command.registered);
}
