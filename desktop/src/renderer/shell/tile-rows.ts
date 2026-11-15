// The rows of `PluginsView.tiles` as the feed puts them into the tile slots (M7-03b). Kept out of plugin-feed.ts: the feed asks for them in
// one line (planOf), the rules are here and tested on their own (bot-panel-tiles.test.ts).
import { canonicalSlot } from "../../../../Web/src/plugin-kernel";
import type { PluginsView } from "../../contract";
import { TILE_SLOTS, TILE_SURFACES, type TileView } from "../panel-names";

/**
 * One row for each surface a tile names (a surface the contract does not know is ignored, a repeated one counts once), in the view's order, for a
 * plugin that is listed, on and not failed: a tile of a plugin that is off, failed or not in the list never reaches a slot, even when the row is
 * still in the view. The slot is given by its 2.x id (`tile/board`, …), the id the kernel holds it under.
 */
export function tileRows(view: PluginsView): { slot: string; row: TileView }[] {
  const on = new Set((view.plugins ?? []).filter((plugin) => plugin.enabled && plugin.failure === null).map((plugin) => plugin.name));
  const out: { slot: string; row: TileView }[] = [];
  for (const row of view.tiles ?? []) {
    if (typeof row !== "object" || row === null || typeof row.plugin !== "string" || !on.has(row.plugin) || !Array.isArray(row.surfaces)) continue;
    for (const surface of TILE_SURFACES) if (row.surfaces.includes(surface)) out.push({ slot: canonicalSlot(TILE_SLOTS[surface]), row });
  }
  return out;
}
