// Plugin views where the app page draws them (plugin-platform.md §3.3, plan W2): a `mainTab` view is a tab
// beside Chat / Board in the chat header, for the bots its `forRole` names; a `settings.section` view is a page
// of Settings and a `quickSettings` view a block in the sidebar gear's popover (each a sandboxed frame, as every
// view). Read from the one contribution list (contributions.ts); a view needs a web part to draw it in its
// frame (panel-page.ts).
import type { PluginsView } from "../../contract";
import { ofKind, type Contribution } from "./contributions";

export type ViewSurfaces = Required<Pick<PluginsView, "mainTabs" | "settingsSections" | "quickSettings" | "rightPanelSections" | "bottomPanels">>;

export function viewSurfaces(list: Contribution[], drawn: (plugin: string) => boolean): ViewSurfaces {
  const views = ofKind(list, "view").filter((view) => drawn(view.plugin) && view.id.length <= 100);
  return {
    mainTabs: views.filter((view) => view.where === "mainTab").slice(0, 50)
      .map((view) => ({ plugin: view.plugin, id: view.id, title: view.title.slice(0, 200), ...(view.icon ? { icon: view.icon.slice(0, 40) } : {}), forRole: view.forRole ?? "any" })),
    settingsSections: views.filter((view) => view.where === "settings.section").slice(0, 20)
      .map((view) => ({
        plugin: view.plugin, id: view.id, title: view.title.slice(0, 200), terms: (view.terms ?? "").slice(0, 1_000),
        ...(view.after ? { after: view.after.slice(0, 40) } : {}), ...(view.link ? { link: view.link.slice(0, 100) } : {}),
      })),
    quickSettings: views.filter((view) => view.where === "quickSettings").slice(0, 10)
      .map((view) => ({ plugin: view.plugin, id: view.id, title: view.title.slice(0, 200) })),
    rightPanelSections: views.filter((view) => view.where === "rightPanel.section").slice(0, 20)
      .map((view) => ({ plugin: view.plugin, id: view.id, title: view.title.slice(0, 200), forRole: view.forRole ?? "any" })),
    bottomPanels: views.filter((view) => view.where === "bottomPanel").slice(0, 5)
      .map((view) => ({ plugin: view.plugin, id: view.id, title: view.title.slice(0, 200), ...(view.toggle ? { toggle: view.toggle.slice(0, 200) } : {}) })),
  };
}
