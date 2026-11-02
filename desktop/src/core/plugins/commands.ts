// Plugin commands where you reach them (plugin-platform.md §3.3, steps M4 and M6): on keys, in the / menu
// and in the app's few fixed menus, read from the one contribution list (contributions.ts). A plugin puts
// only its own commands there ("<plugin>." prefix, as a frame may run only its own); a key it gives is read
// in either spelling (shortcuts.ts `legacyKey`) and left out when it is not a usable key.
import type { PluginsView } from "../../contract";
import { legacyKey } from "../../contract/shortcuts";
import { ofKind, type Contribution } from "./contributions";

export type CommandSurfaces = Required<Pick<PluginsView, "keybindings" | "slash" | "menus">>;

/** A / name: what the chat box can match after a slash (no space or slash, at most 40 characters). */
const slashName = (name: string) => /^[^\s/]{1,40}$/.test(name);

export function commandSurfaces(list: Contribution[]): CommandSurfaces {
  const titles = new Map(ofKind(list, "command").map((command) => [`${command.plugin}\u0000${command.id}`, command.title]));
  const own = (entry: { plugin: string; command: string }) => entry.command.startsWith(`${entry.plugin}.`) && /^[A-Za-z0-9_.:-]{1,200}$/.test(entry.command);
  const title = (entry: { plugin: string; command: string }) => (titles.get(`${entry.plugin}\u0000${entry.command}`) ?? entry.command).slice(0, 200);
  const keybindings: CommandSurfaces["keybindings"] = [];
  for (const entry of ofKind(list, "keybinding")) {
    const key = legacyKey(entry.key);
    if (key && own(entry)) keybindings.push({ command: entry.command, key, plugin: entry.plugin, title: title(entry) });
  }
  return {
    keybindings: keybindings.slice(0, 500),
    slash: ofKind(list, "slash").filter((entry) => own(entry) && slashName(entry.name)).slice(0, 200)
      .map((entry) => ({ name: entry.name, about: entry.about.slice(0, 400), command: entry.command, plugin: entry.plugin })),
    menus: ofKind(list, "menu").filter(own).slice(0, 200).map((entry) => ({ menu: entry.menu, command: entry.command, plugin: entry.plugin, title: title(entry) })),
  };
}
