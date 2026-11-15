// The shell's frame (M7-02a; Q-M7-C4): the page laid out from the five root slots (slot-names.ts `ROOT_SLOTS`: app/rail,
// app/main, app/side, app/bottom, app/overlay), each drawn by KernelSlot from the renderer's kernel (renderer-kernel.ts, the
// `:shell` instance owns them). Nothing has moved into a slot yet: App hands in its whole current page, which is registered as
// one contribution of `:shell` to `app/main` ("the legacy surface") for as long as the frame is up. The frame draws no element of
// its own and the empty slots draw none, so the page's DOM is exactly what App rendered before.
//
// The frame also keeps the renderer kernel's copy of the plugin list (plugin-feed.ts, M7-02b) current: App hands it each `PluginsView`
// it has, the feed reconciles the kernel with it, and the plugins' rows are taken back when the frame unmounts. A mirror only: the
// feed's rows are not drawn (KernelSlot draws components and frames), so the page is still exactly what App rendered.
//
// The frame also holds the shell's in-page loader (inpage-host.ts, M7-02c): the built-in plugins the FE build shipped are loaded into
// the kernel while it is up and unloaded when it goes.
//
// The contribution reads the page through a ref the frame keeps current, so it is registered once, not on every render of App;
// it is registered while the frame renders (the first draw already holds it) and taken back when the frame unmounts.
import { useEffect, useRef, type ReactNode } from "react";
import { ROOT_SLOTS } from "../../../../Web/src/plugin-kernel";
import type { PluginsView } from "../../contract";
import { rendererKernel, SHELL_SURFACE } from "../renderer-kernel";
import { inPageHost } from "./inpage-host";
import { reconcileView } from "./plugin-feed";
import { KernelSlot, type SlotEntry, type SlotFrames } from "./KernelSlot";

/** The slot the legacy surface is contributed to. */
export const LEGACY_SLOT = "app/main";

/** Contributes `entry` to the shell's slot `slot` as `:shell`; returns what takes it back (null: the shell is not up, nothing was added). */
export function contributeToShell(slot: string, entry: SlotEntry): (() => void) | null {
  const registration = rendererKernel.contribute(SHELL_SURFACE, slot, entry);
  return registration ? () => { void registration.dispose(); } : null;
}

let framesMade = 0;

export function ShellFrame({ legacy, frames: services, plugins = null }: { /** The whole page as App draws it today. */ legacy: ReactNode; frames?: SlotFrames; /** The plugin list App has now (null: none yet). */ plugins?: PluginsView | null }) {
  // A name for this frame's entries (not useId: that would move the ids every other component of the page gets).
  const named = useRef("");
  const scope = (named.current ||= `shell-${++framesMade}`);
  const page = useRef(legacy);
  page.current = legacy;
  const take = useRef<(() => void) | null>(null);
  // Registered in the render that first needs it, so the page is in `app/main` on the first draw (a layout or passive effect
  // would leave a draw without it).
  if (!take.current) take.current = contributeToShell(LEGACY_SLOT, { kind: "component", scope, render: () => page.current });
  useEffect(() => {
    // Back after the effect ran its cleanup once (a remount that keeps state): registered again.
    take.current ??= contributeToShell(LEGACY_SLOT, { kind: "component", scope, render: () => page.current });
    return () => { take.current?.(); take.current = null; };
  }, [scope]);
  useEffect(() => { reconcileView(plugins); }, [plugins]);
  useEffect(() => () => { reconcileView(null); }, []);
  // The in-page built-in plugins (botling.settings, …) the build shipped are loaded while the frame is up (M7-02c).
  useEffect(() => inPageHost.acquire(), []);
  // The kernel did not take the page (the shell instance is not up): the page is drawn directly rather than not at all.
  if (!take.current) return <>{legacy}</>;
  return <>{ROOT_SLOTS.map((slot) => <KernelSlot key={slot} slot={slot} scope={scope} {...(services ? { frames: services } : {})} />)}</>;
}
