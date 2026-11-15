// Where the right panel gets its overview blocks (M7-03a): from the `panel/main` slot of the renderer's kernel, where the bot-panel plugin
// (plugins/bot-panel/index.ts) registered them. `panelState()` answers what RightPanel and TakeoverPage draw:
//   - the host says the plugin was refused, failed to load or was unloaded (shell/inpage-host.ts): no blocks and `unavailable`, even
//     while its registrations are still being taken back: the panel shows the shell's "unavailable" line, not a blank or stale one;
//   - the plugin is up: the blocks its registrations make, in registration order (a plugin's `rightPanel.section` rows are not blocks:
//     App hands those in, and they are drawn with the blocks);
//   - the host never touched it (a page drawn without a shell, a component test): the plugin's own data, the same blocks.
import { useMemo, useSyncExternalStore } from "react";
import type { Kernel } from "../../../Web/src/plugin-kernel";
import { rendererKernel, slotsVersion, subscribeSlots } from "./renderer-kernel";
import { inPageHost, type InPageHost } from "./shell/inpage-host";
import { BOT_PANEL_PLUGIN, MAIN_SLOT, PANEL_BLOCKS, type PanelBlock, type PanelBlockEntry } from "./panel-names";

export interface PanelState { blocks: readonly PanelBlock[]; unavailable: boolean }

/** The blocks the bot-panel plugin has registered, in registration order (only its own registrations count; a block id is one of PANEL_BLOCKS). */
export function registeredPanelBlocks(kernel: Kernel = rendererKernel): PanelBlock[] {
  const blocks: PanelBlock[] = [];
  for (const { plugin, entry } of kernel.entries<Partial<PanelBlockEntry>>(MAIN_SLOT)) {
    if (plugin !== BOT_PANEL_PLUGIN || entry.kind !== "panel-block" || !PANEL_BLOCKS.some((block) => block === entry.block)) continue;
    if (!blocks.includes(entry.block!)) blocks.push(entry.block!);
  }
  return blocks;
}

export function panelState(kernel: Kernel = rendererKernel, host: Pick<InPageHost, "unavailable"> = inPageHost): PanelState {
  if (host.unavailable(BOT_PANEL_PLUGIN)) return { blocks: [], unavailable: true };
  if (kernel.state(BOT_PANEL_PLUGIN) === "active") return { blocks: registeredPanelBlocks(kernel), unavailable: false };
  return { blocks: PANEL_BLOCKS, unavailable: false };
}

/** `panelState()`, drawn again when the kernel's slots or the host's answer change. */
export function usePanelState(): PanelState {
  const version = useSyncExternalStore(subscribeSlots, slotsVersion, slotsVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => panelState(), [version]);
}
