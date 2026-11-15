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
import { BOT_PANEL_PLUGIN, MAIN_SLOT, PANEL_BLOCKS, TILE_SLOTS, type PanelBlock, type PanelBlockEntry, type TileSurface, type TileView } from "./panel-names";
import type { FeedEntry } from "./shell/plugin-feed";

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

/**
 * The tiles `surface` holds (M7-03b): the rows the feed put into `panel/tile/<surface>` for the plugins that are on, in the view's order. Fail closed:
 * none while the host says the bot-panel plugin is unavailable; the kernel shows a slot only while its owner and the contributor are active, so none
 * while the plugin is unloading either (no tile outlives its owner, before its registrations are taken back too). Only a registration of the plugin
 * the row names counts, and the row must name this surface (the kernel lets any plugin contribute to a slot someone else owns, so the slot's owner
 * is not a filter). There is no data of its own to fall back on (the plugin never loaded: no tile).
 */
export function tilesFor(surface: TileSurface, kernel: Kernel = rendererKernel, host: Pick<InPageHost, "unavailable"> = inPageHost): TileView[] {
  if (host.unavailable(BOT_PANEL_PLUGIN)) return [];
  const tiles: TileView[] = [];
  for (const { plugin, entry } of kernel.entries<Partial<FeedEntry<TileView>>>(TILE_SLOTS[surface])) {
    if (typeof entry !== "object" || entry === null || entry.kind !== "feed") continue;
    const row = entry.row;
    if (plugin === BOT_PANEL_PLUGIN || typeof row !== "object" || row === null || row.plugin !== plugin || !Array.isArray(row.surfaces) || !row.surfaces.includes(surface)) continue;
    tiles.push(row);
  }
  return tiles;
}

/** `tilesFor(surface)`, drawn again when the kernel's slots or the host's answer change. */
export function useTiles(surface: TileSurface, host: Pick<InPageHost, "unavailable"> = inPageHost): TileView[] {
  const version = useSyncExternalStore(subscribeSlots, slotsVersion, slotsVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => tilesFor(surface, rendererKernel, host), [surface, host, version]);
}
