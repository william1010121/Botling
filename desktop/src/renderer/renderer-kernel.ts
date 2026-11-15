// The renderer's plugin kernel (kernel step 1 step 7; Web/src/plugin-kernel): what the app page's own surfaces provide to
// plugin frames as services, and (M7-02a) the slots the page is drawn from. Two instances of the page's own live here, with names
// no plugin can have:
//   - `:chat` provides `composer.insertQuote` while App is up (composer-quote.ts); a frame's call reaches it through the frame
//     broker (plugin-frame-host.ts) as a kernel call carrying the frame's plugin. The Note declares that it uses it (soft: with no
//     provider the quote is not inserted).
//   - `:shell` owns the shell's root slots (`ROOT_SLOTS`: app/rail, app/main, app/side, app/bottom, app/overlay). Whatever is
//     drawn in one is a contribution to it: today the whole page, as one contribution to `app/main` ("the legacy surface",
//     shell/ShellFrame.tsx). shell/KernelSlot.tsx draws a slot; it re-draws when `subscribeSlots` says the kernel changed.
// Slots have the new names and the 2.x names as aliases (slot-names.ts): the kernel holds one registration and finds it under both.
import { Kernel, ROOT_SLOTS, canonicalSlot } from "../../../Web/src/plugin-kernel";
import { SHELL_STORAGE, provideShellStorage } from "./shell/storage";

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
rendererKernel.install({ name: SHELL_SURFACE, provides: { slots: ROOT_SLOTS, services: [SHELL_STORAGE] } });
void rendererKernel.load(SHELL_SURFACE, (plugin) => {
  for (const slot of ROOT_SLOTS) rendererKernel.provideSlot(plugin, slot);
  provideShellStorage(rendererKernel, plugin);
});
