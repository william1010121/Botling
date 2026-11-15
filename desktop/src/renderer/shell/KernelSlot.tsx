// Draws one slot of the renderer's plugin kernel (M7-02a): the contributions the slot holds, in registration order, each as an
// in-page component or as a plugin's frame (the existing SlotFrame / PanelFrame). It re-draws when the kernel changes
// (`subscribeSlots`), so a contribution that goes with its plugin's unload (the kernel's undo) is gone from the page at once.
// A slot is given by either name (`app/main` or `view/main`, slot-names.ts): the kernel finds the same slot.
//
// It draws no element of its own: the contributions are siblings in the parent's layout, so a slot with nothing in it leaves
// the DOM as it was before the slot existed.
import { Fragment, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Client } from "../client";
import { PanelFrame, SlotFrame, type BuiltinRunner, type FrameServices } from "../Plugins";
import { rendererKernel, slotsVersion, subscribeSlots } from "../renderer-kernel";

/** What a slot's contribution is: a component of the page (a built-in plugin's, or the legacy surface), or a plugin's frame. */
export type SlotEntry =
  | { kind: "component"; render: () => ReactNode; scope?: string }
  | { kind: "frame"; frame: "slot"; plugin: string; view: string; title: string; fontSize?: number; botId?: string; scope?: string }
  | { kind: "frame"; frame: "panel"; plugin: string; panel: string; title: string; onClose?: () => void; scope?: string };

/** What a frame entry needs from the page (a component entry needs nothing: it closes over what it uses). */
export type SlotFrames = { client: Client; onBuiltin?: BuiltinRunner } & FrameServices;

function draw(entry: SlotEntry, frames: SlotFrames | undefined): ReactNode {
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
  // The list is read again only when the kernel changed (a component entry's render reads the page's latest state itself).
  const entries = useMemo(
    () => rendererKernel.entries<SlotEntry>(slot).filter(({ entry }) => entry.scope === undefined || entry.scope === scope),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slot, scope, version],
  );
  return <>{entries.map(({ entry, registration }) => <Fragment key={registration.id}>{draw(entry, frames)}</Fragment>)}</>;
}
