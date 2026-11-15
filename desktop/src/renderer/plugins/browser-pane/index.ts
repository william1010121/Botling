// `botling.browser-pane`, the fourth in-page built-in plugin (M7-06c; plugin-kernel design §19, Q-M7-C9). Loaded by the shell's trusted
// loader (shell/inpage-loader.ts) only because the FE build shipped this folder: its name and the hash of the whole folder are in
// fe-build-manifest.json. It owns one slot:
//   - `browser/tab` (2.x `menu/browser/tab`): the buttons in the browser pane's toolbar for the tab on screen. Plugins' entries land
//     here as registrations of those plugins (the feed's `{kind: "feed", row}`, shell/plugin-feed.ts); the plugin has no entries of
//     its own. Which tab gets which button is the row's `when` (browser-tab-menu.ts), checked by `browserTabActions` as before.
// BrowserPane.tsx still draws the pane and its toolbar; App hands it the buttons from this slot (browser-slot.ts), not from
// `PluginsView.menus`.
import type { PluginDeclaration } from "../../../../../Web/src/plugin-kernel";
import { isInPageApi } from "../../shell/inpage-host";
import { BROWSER_PANE_PLUGIN, BROWSER_PANE_SLOTS } from "../../browser-names";

export const browserPaneDeclaration: PluginDeclaration = { name: BROWSER_PANE_PLUGIN, provides: { slots: [...BROWSER_PANE_SLOTS] } };

export function activate(api: unknown): Promise<() => void> {
  if (!isInPageApi(api)) return Promise.reject(new Error("no in-page api"));
  return api.define(browserPaneDeclaration, (kernel, plugin) => {
    for (const slot of BROWSER_PANE_SLOTS) kernel.provideSlot(plugin, slot);
  });
}
