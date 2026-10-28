import { useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Shell surfaces that cover chat share this lifetime contract, including body portals and task
// timelines. Brief rail/status tips stay outside it to avoid snapshot work and input handoff on hover.
// No class names, roles or individual feature selectors participate in native stacking.
const overlays = new Map<symbol, boolean>();
const listeners = new Set<() => void>();
export const shellOverlayActive = () => overlays.size > 0;
export const shellOverlayRevealImmediately = () => [...overlays.values()].some(Boolean);
export function subscribeShellOverlays(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function ShellOverlay({ children, active = true, revealImmediately = false }: { children: ReactNode; active?: boolean; revealImmediately?: boolean }) {
  useLayoutEffect(() => {
    if (!active) return;
    const token = Symbol();
    overlays.set(token, revealImmediately); for (const listener of listeners) listener();
    return () => { overlays.delete(token); for (const listener of listeners) listener(); };
  }, [active, revealImmediately]);
  return <>{children}</>;
}
/** Body portals must use this instead of an unregistered createPortal. */
export function shellPortal(children: ReactNode, container: Element = document.body) {
  return createPortal(<ShellOverlay>{children}</ShellOverlay>, container);
}
