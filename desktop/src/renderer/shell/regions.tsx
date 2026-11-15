// The two regions of the page that are slots of the shell now (M7-03c): the bottom panels (`BottomPanels`, the `bottomPanel` views of plugins
// such as the Terminal) are drawn from `app/bottom`, and the right panel (`TaskDetails` / the takeover page) from `app/side`.
//   - `app/bottom` is `:shell`'s: ShellFrame contributes `{kind: "region", region: "bottom", scope}` there while it is up, the way it
//     contributes the legacy page to `app/main`. The plugins' own `bottomPanel` rows are in the same slot (the feed's rows, unchanged).
//   - `app/side` is `botling.bot-panel`'s contribution (plugins/bot-panel/index.ts: it declares that it contributes to the slot), so the
//     column is the plugin's: with the plugin up and its registration taken back there is no column; with the plugin not up (never loaded,
//     refused, failed, unloading) the column is drawn and shows what panel-slot.ts says (its own data, or the shell's "unavailable" line).
// A region entry carries no content: the page (App) hands in what each region draws (`ShellFrame regions`), as it reads the page's state, and
// puts a `<RegionSlot region>` where the region sits in its layout. RegionSlot draws no element of its own, so the page's DOM is exactly
// what App rendered before. The root slots' own KernelSlot draws a region entry as nothing (it is neither a component nor a frame), so a
// region is never drawn twice.
import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { rendererKernel, SHELL_SURFACE, slotsVersion, subscribeSlots } from "../renderer-kernel";
import { BOT_PANEL_PLUGIN } from "../panel-names";

export type Region = "side" | "bottom";
/** The root slot each region is drawn from. */
export const REGION_SLOTS: Readonly<Record<Region, string>> = { side: "app/side", bottom: "app/bottom" };

/** What is contributed to a region's slot: only the claim. Its content is the page's (`ShellRegions`). */
export interface RegionEntry { kind: "region"; region: Region; /** The ShellFrame it is for (the shell's own entry); the plugin's has none. */ scope?: string }

/** What the page draws in each region, as of its latest render (undefined: nothing). */
export interface ShellRegions { side?: ReactNode; bottom?: ReactNode }

interface RegionsContext {
  scope: string;
  /** Read at draw time, so the page's latest render is what shows (the entries themselves are registered once). */
  regions: { readonly current: ShellRegions };
  /** The kernel did not take the shell's entries: the regions are drawn without asking it, rather than not at all. */
  direct: boolean;
}
const Regions = createContext<RegionsContext | null>(null);
export const ShellRegionsProvider = Regions.Provider;

/** The one contributor each region accepts: `:shell` for the bottom, `botling.bot-panel` for the side. */
const CONTRIBUTOR: Readonly<Record<Region, string>> = { side: BOT_PANEL_PLUGIN, bottom: SHELL_SURFACE };

/** True when the slot holds this region's claim by its contributor (and, for the shell's, by this frame). */
function claimed(region: Region, scope: string): boolean {
  return rendererKernel.entries<Partial<RegionEntry>>(REGION_SLOTS[region]).some(({ plugin, entry }) =>
    plugin === CONTRIBUTOR[region] && typeof entry === "object" && entry !== null && entry.kind === "region" && entry.region === region
    && (entry.scope === undefined || entry.scope === scope));
}

/**
 * Whether the page draws `region` now. The bottom: while `:shell`'s entry for this frame is held. The side: while the bot-panel plugin's entry is
 * held, and also while the plugin is not up (state other than active): then the column is drawn as panel-slot.ts decides, so a plugin that
 * never loaded, was refused or is being unloaded leaves the shell's "unavailable" line, not a hole. Active without its entry: not drawn.
 */
export function regionShown(region: Region, scope: string): boolean {
  if (claimed(region, scope)) return true;
  return region === "side" && rendererKernel.state(BOT_PANEL_PLUGIN) !== "active";
}

/** Draws what the page supplied for `region`, if the slot says the region is there. */
export function RegionSlot({ region }: { region: Region }) {
  const context = useContext(Regions);
  const version = useSyncExternalStore(subscribeSlots, slotsVersion, slotsVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shown = useMemo(() => !!context && (context.direct || regionShown(region, context.scope)), [context, region, version]);
  return <>{shown ? context!.regions.current[region] ?? null : null}</>;
}

/**
 * ShellFrame's part: the shell's claim on `app/bottom` for this frame (registered in the render that first needs it, so the first draw has it, and
 * taken back when the frame unmounts), and the context RegionSlot reads. `contribute` is ShellFrame's `contributeToShell`.
 */
export function useShellRegions(scope: string, regions: ShellRegions | undefined, direct: boolean, contribute: (slot: string, entry: RegionEntry) => (() => void) | null): RegionsContext {
  const latest = useRef<ShellRegions>({});
  latest.current = regions ?? {};
  const take = useRef<(() => void) | null>(null);
  const claim = () => contribute(REGION_SLOTS.bottom, { kind: "region", region: "bottom", scope });
  if (!take.current) take.current = claim();
  useEffect(() => {
    take.current ??= claim();
    return () => { take.current?.(); take.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  const missing = !take.current;
  return useMemo(() => ({ scope, regions: latest, direct: direct || missing }), [scope, direct, missing]);
}
