// `botling.bot-panel`, the second in-page built-in plugin (M7-03a; plugin-kernel design §23 step 3). Loaded by the shell's trusted loader
// (shell/inpage-loader.ts) only because the FE build shipped this folder: its name and the hash of the whole folder are in
// fe-build-manifest.json. It owns the right panel's three slots:
//   - `panel/main` (2.x `view/rightPanel`): the overview's blocks under the Now card. It registers the three core blocks in order
//     (waiting list, results, settled workers), one registration each, `{kind: "panel-block", block}`; RightPanel.tsx draws them;
//   - `panel/section` (2.x `view/rightPanel.section`): plugins' `rightPanel.section` views land here as the feed's rows;
//   - `panel/takeover` (2.x `view/rightPanel.takeover`): plugins' `rightPanel.takeover` views land here as the feed's rows.
// Nothing core goes in the last two. The panel's head and Now card, the bot's own settings page and the folded strip's face are the
// shell's: with this plugin away the panel shows the shell's "unavailable" line in its place and the chat stays (panel-slot.ts).
import type { PluginDeclaration } from "../../../../../Web/src/plugin-kernel";
import { isInPageApi } from "../../shell/inpage-host";
import { BOT_PANEL_PLUGIN, MAIN_SLOT, PANEL_BLOCKS, SECTION_SLOT, TAKEOVER_SLOT, type PanelBlockEntry } from "../../panel-names";

export const botPanelDeclaration: PluginDeclaration = { name: BOT_PANEL_PLUGIN, provides: { slots: [MAIN_SLOT, SECTION_SLOT, TAKEOVER_SLOT] } };

export function activate(api: unknown): Promise<() => void> {
  if (!isInPageApi(api)) return Promise.reject(new Error("no in-page api"));
  return api.define(botPanelDeclaration, (kernel, plugin) => {
    for (const slot of [MAIN_SLOT, SECTION_SLOT, TAKEOVER_SLOT]) kernel.provideSlot(plugin, slot);
    for (const block of PANEL_BLOCKS) {
      // The plugin owns the slot, so the kernel takes this while it loads; a refusal fails the load (nothing half-registered stays).
      if (!kernel.contribute(plugin, MAIN_SLOT, { kind: "panel-block", block } satisfies PanelBlockEntry)) throw new Error(`the kernel refused the ${block} block`);
    }
  });
}
