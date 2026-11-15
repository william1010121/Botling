// Where the browser pane gets plugins' toolbar buttons (M7-06c): from the kernel slot `botling.browser-pane` owns (plugins/browser-pane/
// index.ts), not from `PluginsView.menus`. `browserPlugins(view)` is the view `browserTabActions` reads (plugin-commands.ts, called by
// App): its `browser/tab` rows are the rows the slot holds; every other menu and the rest of the view are as they were. The same rules
// as the chat's menus (chat-slot.ts, M7-06a):
//   - a row counts only when the slot holds it AND the view still has it (the feed catches up a moment after a new view: a row the view
//     dropped is never shown stale, and one the slot lacks is never shown early);
//   - the order is the view's array order (a plugin the feed reloaded sits last in the slot);
//   - the owner away (refused, failed to load, unloaded) → no button at all (fail closed; the pane itself still works); a host that
//     never touched it (a component test, a page drawn without a shell) → the view as it is.
// What the row's `when` says about a tab is not decided here: `browserTabActions` matches it against the tab's address as before.
import { useSyncExternalStore } from "react";
import type { Kernel } from "../../../Web/src/plugin-kernel";
import type { PluginsView } from "../contract";
import { BROWSER_PANE_PLUGIN, BROWSER_TAB_MENU } from "./browser-names";
import { rendererKernel, slotsVersion, subscribeSlots } from "./renderer-kernel";
import { inPageHost, type InPageHost } from "./shell/inpage-host";
import type { FeedEntry } from "./shell/plugin-feed";

type Menus = NonNullable<PluginsView["menus"]>;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The `browser/tab` rows the slot holds now (a feed row of any plugin), as `PluginsView.menus` rows. */
function slotRows(kernel: Kernel): Menus {
  const rows: Menus = [];
  for (const { entry } of kernel.entries<Partial<FeedEntry<Menus[number]>>>(BROWSER_TAB_MENU)) {
    if (entry.kind === "feed" && entry.row && entry.row.menu === BROWSER_TAB_MENU) rows.push(entry.row);
  }
  return rows;
}

export function browserPlugins(view: PluginsView | null | undefined, kernel: Kernel = rendererKernel, host: Pick<InPageHost, "unavailable"> = inPageHost): PluginsView | null | undefined {
  if (!view) return view;
  const up = kernel.state(BROWSER_PANE_PLUGIN) === "active";
  if (!up && !host.unavailable(BROWSER_PANE_PLUGIN)) return view;
  const held = up ? slotRows(kernel) : [];
  const menus = (view.menus ?? []).filter((row) => row.menu !== BROWSER_TAB_MENU || held.some((one) => same(one, row)));
  return menus.length === (view.menus ?? []).length ? view : { ...view, menus };
}

/** The version of the slots, to draw again when one changes (a useSyncExternalStore snapshot of the kernel's slots). */
export function useBrowserSlotsVersion(): number {
  return useSyncExternalStore(subscribeSlots, slotsVersion, slotsVersion);
}
