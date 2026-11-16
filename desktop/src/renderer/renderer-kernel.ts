// The renderer's plugin kernel (kernel step 1 step 7; Web/src/plugin-kernel): what the app page's own surfaces provide to
// plugin frames as services, and (M7-02a) the slots the page is drawn from. Two instances of the page's own live here, with names
// no plugin can have:
//   - `:chat` provides `composer.insertQuote` while App is up (composer-quote.ts); a frame's call reaches it through the frame
//     broker (plugin-frame-host.ts, shell/frame-services.ts) as a kernel call carrying the frame's plugin. The Note declares that it uses
//     it in its manifest (soft: with no provider the quote is not inserted); the plugin feed installs that declaration (M7-04b).
//   - `:shell` owns the shell's root slots (`ROOT_SLOTS`: app/rail, app/main, app/side, app/bottom, app/overlay). Whatever is
//     drawn in one is a contribution to it: the chat column is `botling.chat`'s claim on `app/main` (M7-07a), the right panel
//     botling.bot-panel's on `app/side`, the bottom panels `:shell`'s on `app/bottom` (shell/regions.tsx); the rest of the page is
//     shell/ShellFrame.tsx's own layout. shell/KernelSlot.tsx draws a slot; it re-draws when `subscribeSlots` says the kernel changed.
//     It also owns the view and menu places the plugin feed fills (`FEED_SLOTS`, M7-02b): the plugin list as the page
//     received it, one instance per plugin (shell/plugin-feed.ts), until a plugin owns a place itself.
// Slots have the new names and the 2.x names as aliases (slot-names.ts): the kernel holds one registration and finds it under both.
import { Kernel, ROOT_SLOTS, canonicalSlot } from "../../../Web/src/plugin-kernel";
import { SHELL_STORAGE, provideShellStorage } from "./shell/storage";
import { FEED_SLOTS } from "./shell/feed-slots";

/** The chat surface's instance in the renderer's kernel. */
export const CHAT_SURFACE = ":chat";
/** The shell's instance: owns the root slots. */
export const SHELL_SURFACE = ":shell";
/** The service a plugin frame's `ccb.composer.insertQuote` calls. */
export const INSERT_QUOTE = "composer.insertQuote";
export { SHELL_STORAGE };

const listeners = new Set<() => void>();
let version = 0;
let scheduled = false;

/** Tells every `subscribeSlots` listener that a slot may show something else now (the kernel's own steps call it, once per turn of the event loop). */
export function notifySlots(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}
/** Calls `listener` after each change to the kernel's slots; returns the unsubscribe (a useSyncExternalStore subscribe). */
export function subscribeSlots(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** A number that changes whenever a slot may show something else (a useSyncExternalStore snapshot). */
export const slotsVersion = (): number => version;

// A kernel step is logged before the slot's list is updated (a contribution is added just after its registration), so the
// listeners are told a moment later, once for a burst of steps.
export const rendererKernel = new Kernel({
  slotName: canonicalSlot,
  log: () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; notifySlots(); });
  },
});
rendererKernel.install({ name: CHAT_SURFACE, provides: { services: [INSERT_QUOTE] } });
const SHELL_SLOTS = [...ROOT_SLOTS, ...FEED_SLOTS];
rendererKernel.install({ name: SHELL_SURFACE, provides: { slots: SHELL_SLOTS, services: [SHELL_STORAGE] } });
void rendererKernel.load(SHELL_SURFACE, (plugin) => {
  for (const slot of SHELL_SLOTS) rendererKernel.provideSlot(plugin, slot);
  provideShellStorage(rendererKernel, plugin);
});
