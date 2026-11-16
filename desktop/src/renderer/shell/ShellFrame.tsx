// The shell's frame (M7-02a; Q-M7-C4): the page laid out from the five root slots (slot-names.ts `ROOT_SLOTS`: app/rail,
// app/main, app/side, app/bottom, app/overlay), each drawn by KernelSlot from the renderer's kernel (renderer-kernel.ts, the
// `:shell` instance owns them). App hands in its page (the rail, the sheets and the rest of what has not moved yet): the frame draws
// it as the page's layout, in `app/main`'s place, and the regions that are slots now are drawn inside it by `<RegionSlot>`
// (regions.tsx): the chat column is `botling.chat`'s contribution to `app/main` (M7-07a; there is no `:shell` legacy contribution any
// more), the right panel is botling.bot-panel's `app/side`, the bottom panels `:shell`'s `app/bottom`. The frame draws no element of
// its own and the empty slots draw none, so the page's DOM is exactly what App rendered before.
//
// The fallback screen (shell/Fallback.tsx, M7-07c) is the shell's, not a plugin's: with `botling.chat` refused, failed or unloaded, `<RegionSlot region="main">`
// draws it in the chat column's place from `regions.away` (the page's client and store, and the chrome the page keeps out of the column). The frame needs
// nothing more of it; it stays up while the plugin is away and goes the moment the plugin's claim on `app/main` is held.
//
// The frame also keeps the renderer kernel's copy of the plugin list (plugin-feed.ts, M7-02b) current: App hands it each `PluginsView`
// it has, the feed reconciles the kernel with it, and the plugins' rows are taken back when the frame unmounts. A mirror only: the
// feed's rows are not drawn (KernelSlot draws components and frames), so the page is still exactly what App rendered.
//
// The frame also holds the shell's in-page loader (inpage-host.ts, M7-02c): the built-in plugins the FE build shipped are loaded into
// the kernel while it is up and unloaded when it goes.
//
// A slot the page draws itself, inside its own layout, is left out of the frame's list (`inline`; M7-05a: the left column, `app/rail`, sits
// beside the chat pane in the page's flex row, so the page places it: shell/SidebarRail.tsx `RailSlot`).
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ROOT_SLOTS } from "../../../../Web/src/plugin-kernel";
import type { PluginsView } from "../../contract";
import { rendererKernel, SHELL_SURFACE } from "../renderer-kernel";
import { inPageHost } from "./inpage-host";
import type { Client } from "../client";
import { reconcileView, type FeedWeb } from "./plugin-feed";
import { KernelSlot, type SlotEntry, type SlotFrames } from "./KernelSlot";
import { ShellRegionsProvider, useShellRegions, type RegionEntry, type ShellRegions } from "./regions";

/** The slot the page's main area is drawn in (the chat column is `botling.chat`'s contribution to it). */
const MAIN_SLOT = "app/main";

/** Contributes `entry` to the shell's slot `slot` as `:shell`; returns what takes it back (null: the shell is not up, nothing was added). */
export function contributeToShell(slot: string, entry: SlotEntry | RegionEntry): (() => void) | null {
  const registration = rendererKernel.contribute(SHELL_SURFACE, slot, entry);
  return registration ? () => { void registration.dispose(); } : null;
}

let framesMade = 0;

/** How long the first `plugins.web` answer is waited for: after it the feed goes on without the web versions (null) until one comes. */
export const FIRST_WEB_WAIT_MS = 2000;

export function ShellFrame({ legacy, regions, frames: services, plugins = null, client, inline = [] }: { /** The page as App draws it: its layout, with a `<RegionSlot>` where each region sits. */ legacy: ReactNode;
  /** What the page draws in the chat column (`main`), the right panel (`side`) and the bottom panels (`bottom`): drawn where `legacy` has a `<RegionSlot>` (regions.tsx, M7-03c, M7-07a). */ regions?: ShellRegions; frames?: SlotFrames; /** The plugin list App has now (null: none yet). */ plugins?: PluginsView | null;
  /** Asked for `plugins.web` whenever the list changes: the web parts' versions are part of the feed's fingerprints (M7-02c F3). */ client?: Pick<Client, "request">;
  /** Root slots the page draws itself (not drawn again here). */ inline?: readonly string[] }) {
  // A name for this frame's entries (not useId: that would move the ids every other component of the page gets).
  const named = useRef("");
  const scope = (named.current ||= `shell-${++framesMade}`);
  // The `plugins.web` answer (undefined: not answered yet; null: it failed). With a client the feed waits for the first answer (at most
  // FIRST_WEB_WAIT_MS), so the web parts' versions do not reload (and reorder) the plugins that have one right after the first load.
  const [web, setWeb] = useState<FeedWeb>(client ? undefined : null);
  useEffect(() => {
    if (!client) return;
    let live = true;
    const answer = (next: FeedWeb) => { if (live) setWeb((held) => (JSON.stringify(held) === JSON.stringify(next) ? held : next)); };
    void (async () => {
      try { answer({ specs: (await client.request({ type: "plugins.web" })).specs.map(({ name, version }) => ({ name, version })) }); } catch { answer(null); }
    })();
    return () => { live = false; };
  }, [client, plugins]);
  // A request that never settles must not keep the feed empty (the plugins' own Settings pages are read from it).
  useEffect(() => {
    if (!client) return;
    const late = setTimeout(() => setWeb((held) => (held === undefined ? null : held)), FIRST_WEB_WAIT_MS);
    return () => clearTimeout(late);
  }, [client]);
  useEffect(() => { if (web !== undefined) reconcileView(plugins, web); }, [plugins, web]);
  useEffect(() => () => { reconcileView(null); }, []);
  // The in-page built-in plugins (botling.settings, …) the build shipped are loaded while the frame is up (M7-02c).
  useEffect(() => inPageHost.acquire(), []);
  // The regions of the page that are slots too (the bottom panels' claim on `app/bottom`; the right panel is botling.bot-panel's on `app/side`).
  const placed = useShellRegions(scope, regions, false, contributeToShell);
  // The kernel did not take the shell's entries (the shell instance is not up): the page is drawn directly rather than not at all.
  if (placed.direct) return <ShellRegionsProvider value={placed}>{legacy}</ShellRegionsProvider>;
  return <ShellRegionsProvider value={placed}>{ROOT_SLOTS.filter((slot) => !inline.includes(slot)).map((slot) => (
    <Fragment key={slot}>{slot === MAIN_SLOT ? legacy : null}<KernelSlot slot={slot} scope={scope} {...(services ? { frames: services } : {})} /></Fragment>
  ))}</ShellRegionsProvider>;
}
