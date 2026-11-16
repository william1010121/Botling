// Draws one slot of the renderer's plugin kernel (M7-02a): the contributions the slot holds, in registration order, each as an
// in-page component or as a plugin's frame (the existing SlotFrame / PanelFrame). It re-draws when the kernel changes
// (`subscribeSlots`), so a contribution that goes with its plugin's unload (the kernel's undo) is gone from the page at once.
// A slot is given by either name (`app/main` or `view/main`, slot-names.ts): the kernel finds the same slot.
//
// A contribution may list the shell functions it needs (`needsShell`, M7-07d). The page offers its own set (`ShellCapabilitiesProvider`; the
// desktop window gives none, which means all): a contribution with a function the page lacks is left out, or says "Not available on this
// device" (`whenMissing: "say"`). The check is made where the slot is drawn, so the same plugin bundle runs everywhere.
//
// It draws no element of its own: the contributions are siblings in the parent's layout, so a slot with nothing in it leaves
// the DOM as it was before the slot existed.
import { createContext, Fragment, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Client } from "../client";
import { PanelFrame, SlotFrame, type BuiltinRunner, type FrameServices } from "../Plugins";
import { rendererKernel, slotsVersion, subscribeSlots } from "../renderer-kernel";

/**
 * What a contribution may say about the shell functions it needs (`needsShell`, M7-07d; the manifest's `needsShell` list). The page it is drawn in offers
 * some of them (`ShellCapabilities`); one that is missing hides the contribution, or, with `whenMissing: "say"`, draws a short line instead.
 */
export interface NeedsShell {
  /** The shell functions the contribution cannot do without (`openFile`, `openLink`…). */
  needsShell?: readonly string[];
  /** What a page that lacks one of them does: leave the contribution out (default), or say it is not available on this device. */
  whenMissing?: "hide" | "say";
}

/** What a slot's contribution is: a component of the page (a built-in plugin's, or the legacy surface), or a plugin's frame. */
export type SlotEntry = NeedsShell & (
  | { kind: "component"; render: () => ReactNode; scope?: string; title?: string }
  | { kind: "frame"; frame: "slot"; plugin: string; view: string; title: string; fontSize?: number; botId?: string; scope?: string }
  | { kind: "frame"; frame: "panel"; plugin: string; panel: string; title: string; onClose?: () => void; scope?: string });

/** What a page that lacks a shell function says in its place. */
export const NOT_AVAILABLE_HERE = "Not available on this device";

/**
 * The shell functions this page offers. `null` (the default, no provider): everything, as in the desktop window, which has them all. The phone/browser
 * page gives its own set (web-v3/bridge-v3.ts `pageNeedsShell`).
 */
const ShellCapabilities = createContext<ReadonlySet<string> | null>(null);
export const ShellCapabilitiesProvider = ShellCapabilities.Provider;

/**
 * The names of `needsShell` this page does not offer (empty: the contribution may be drawn). Fails closed on a page that has a set: a value that is
 * not a list of strings, or an entry that is not a string, counts as missing, never as nothing needed.
 */
export function missingShell(needs: unknown, offered: ReadonlySet<string> | null): string[] {
  if (offered === null || needs === undefined) return [];
  if (!Array.isArray(needs)) return ["?"];
  return needs.filter((name) => typeof name !== "string" || !offered.has(name)).map((name) => (typeof name === "string" ? name : "?"));
}

/** What a frame entry needs from the page (a component entry needs nothing: it closes over what it uses). */
export type SlotFrames = { client: Client; onBuiltin?: BuiltinRunner } & FrameServices;

function draw(entry: SlotEntry, frames: SlotFrames | undefined, offered: ReadonlySet<string> | null): ReactNode {
  const missing = missingShell(entry.needsShell, offered);
  if (missing.length) {
    if (entry.whenMissing !== "say") return null;
    const title = "title" in entry && typeof entry.title === "string" ? entry.title : "plugin" in entry ? entry.plugin : "";
    return <div className="plugin-unavailable" role="note" data-needs-shell={missing.join(" ")}>{title ? `${title}: ` : ""}{NOT_AVAILABLE_HERE}</div>;
  }
  if (entry.kind === "component") return entry.render();
  // Not a component and not a frame (the plugin feed's rows, plugin-feed.ts `{kind: "feed"}`): nothing to draw.
  if (entry.kind !== "frame" || !frames) return null;
  const { client, onBuiltin, ...services } = frames;
  if (entry.frame === "panel") return <PanelFrame client={client} plugin={entry.plugin} panel={entry.panel} title={entry.title} onClose={entry.onClose ?? (() => {})} {...(onBuiltin ? { onBuiltin } : {})} {...services} />;
  return <SlotFrame client={client} plugin={entry.plugin} view={entry.view} title={entry.title} fontSize={entry.fontSize ?? 13} {...(entry.botId ? { botId: entry.botId } : {})} {...(onBuiltin ? { onBuiltin } : {})} {...services} />;
}

/**
 * `slot`'s contributions. `scope` limits it to the entries made for one ShellFrame (the entries without a scope show everywhere):
 * two pages in one document (tests, a second window) each draw only their own surface.
 */
export function KernelSlot({ slot, scope, frames }: { slot: string; scope?: string; frames?: SlotFrames }) {
  const version = useSyncExternalStore(subscribeSlots, slotsVersion, slotsVersion);
  const offered = useContext(ShellCapabilities);
  // The list is read again only when the kernel changed (a component entry's render reads the page's latest state itself).
  const entries = useMemo(
    () => rendererKernel.entries<SlotEntry>(slot).filter(({ entry }) => entry.scope === undefined || entry.scope === scope),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slot, scope, version],
  );
  return <>{entries.map(({ entry, registration }) => <Fragment key={registration.id}>{draw(entry, frames, offered)}</Fragment>)}</>;
}
