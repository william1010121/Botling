// Plugin views where the app page draws them (plugin-platform.md §3.3, plan W2): a `mainTab` view is a tab
// beside Chat / Board in the chat header, for the bots its `forRole` names. Read from the one contribution
// list (contributions.ts); a view needs a web part to draw it in its frame (panel-page.ts).
import type { PluginsView } from "../../contract";
import { ofKind, type Contribution } from "./contributions";

export type ViewSurfaces = Required<Pick<PluginsView, "mainTabs">>;

export function viewSurfaces(list: Contribution[], drawn: (plugin: string) => boolean): ViewSurfaces {
  return {
    mainTabs: ofKind(list, "view").filter((view) => view.where === "mainTab" && drawn(view.plugin) && view.id.length <= 100).slice(0, 50)
      .map((view) => ({ plugin: view.plugin, id: view.id, title: view.title.slice(0, 200), ...(view.icon ? { icon: view.icon.slice(0, 40) } : {}), forRole: view.forRole ?? "any" })),
  };
}
