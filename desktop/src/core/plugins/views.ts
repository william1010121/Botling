// Plugin views where the app page draws them (plugin-platform.md §3.3, plan W2): a `mainTab` view is a tab
// beside Chat / Storage in the chat header, for the bots its `forRole` names; a `settings.section` view is a page
// of Settings and a `quickSettings` view a block in the sidebar gear's popover (each a sandboxed frame, as every
// view). Read from the one contribution list (contributions.ts); a view needs a web part to draw it in its
// frame (panel-page.ts).
import type { PluginsView } from "../../contract";
import { COMPOSER_BAR_WIDTH, ofKind, type Contribution, type MainTabRole, type ViewRole } from "./contributions";

/** A role that is not a mainTab's: "marked" is only a mainTab's (the manifest refuses it elsewhere). */
const viewRole = (role: MainTabRole | undefined): ViewRole => (role === undefined || role === "marked" ? "any" : role);

/** The most bots one tab is marked for. */
export const MARKED_BOTS_MAX = 500;

export type ViewSurfaces = Required<Pick<PluginsView, "mainTabs" | "settingsSections" | "quickSettings" | "rightPanelSections" | "bottomPanels" | "chatHeaderViews" | "takeovers" | "composerBarViews">>;

/** `marked`: the bots (the core's ids) a plugin marked for one of its `forRole: "marked"` tabs (`ui.showTab`). */
export function viewSurfaces(list: Contribution[], drawn: (plugin: string) => boolean, marked: (plugin: string, view: string) => string[] = () => []): ViewSurfaces {
  const views = ofKind(list, "view").filter((view) => drawn(view.plugin) && view.id.length <= 100);
  return {
    mainTabs: views.filter((view) => view.where === "mainTab").slice(0, 50)
      .map((view) => ({
        plugin: view.plugin, id: view.id, title: view.title.slice(0, 200), ...(view.icon ? { icon: view.icon.slice(0, 40) } : {}), forRole: view.forRole ?? "any",
        ...(view.chat ? { chat: view.chat } : {}), ...(view.forRole === "marked" ? { bots: marked(view.plugin, view.id).slice(0, MARKED_BOTS_MAX) } : {}),
      })),
    settingsSections: views.filter((view) => view.where === "settings.section").slice(0, 20)
      .map((view) => ({
        plugin: view.plugin, id: view.id, title: view.title.slice(0, 200), terms: (view.terms ?? "").slice(0, 1_000),
        ...(view.after ? { after: view.after.slice(0, 40) } : {}), ...(view.link ? { link: view.link.slice(0, 100) } : {}),
      })),
    quickSettings: views.filter((view) => view.where === "quickSettings").slice(0, 10)
      .map((view) => ({ plugin: view.plugin, id: view.id, title: view.title.slice(0, 200) })),
    rightPanelSections: views.filter((view) => view.where === "rightPanel.section").slice(0, 20)
      .map((view) => ({ plugin: view.plugin, id: view.id, title: view.title.slice(0, 200), forRole: viewRole(view.forRole) })),
    bottomPanels: views.filter((view) => view.where === "bottomPanel").slice(0, 5)
      .map((view) => ({ plugin: view.plugin, id: view.id, title: view.title.slice(0, 200), ...(view.toggle ? { toggle: view.toggle.slice(0, 200) } : {}) })),
    chatHeaderViews: views.filter((view) => view.where === "chatHeader").slice(0, 5)
      .map((view) => ({ plugin: view.plugin, id: view.id, title: view.title.slice(0, 200) })),
    takeovers: views.filter((view) => view.where === "rightPanel.takeover").slice(0, 5)
      .map((view) => ({ plugin: view.plugin, id: view.id, title: view.title.slice(0, 200) })),
    composerBarViews: views.filter((view) => view.where === "composerBar").slice(0, 5)
      .map((view) => ({ plugin: view.plugin, id: view.id, title: view.title.slice(0, 200), width: view.width ?? COMPOSER_BAR_WIDTH.default, forRole: viewRole(view.forRole) })),
  };
}

/**
 * `PluginsView.tiles` (M7-03b): one row per `tile` contribution, without its component folder (each surface once: a manifest may repeat one). Nothing at all (no key) when there is none, so a
 * view of plugins without tiles is what it was. `list` is the contributions of the plugins that are on (`Plugins.contributions()`).
 */
export function tileView(list: Contribution[]): Pick<PluginsView, "tiles"> {
  const tiles = ofKind(list, "tile").filter((tile) => tile.id.length <= 100).slice(0, 200)
    .map((tile) => ({ plugin: tile.plugin, id: tile.id, title: tile.title.slice(0, 200), sizes: tile.sizes.slice(0, 10).map((size) => size.slice(0, 20)), surfaces: [...new Set(tile.surfaces)].slice(0, 3) }));
  return tiles.length ? { tiles } : {};
}
