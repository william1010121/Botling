import { shellOverlayActive, shellOverlayRevealImmediately, subscribeShellOverlays } from "./ShellOverlay";
import type { editorBridge } from "../preload/editor-bridge";
import { CHAT_ORIGIN, type ShellMessage } from "./chat-frame/protocol";

export type EditorBridge = ReturnType<typeof editorBridge>;
export const nativeEditor = (): EditorBridge | undefined =>
  (window as unknown as { botling?: { editorHost?: EditorBridge } }).botling?.editorHost;

/** Business messages use the authenticated native pair when present, even while unbound. */
export function postToChat(message: ShellMessage): void {
  const bridge = nativeEditor();
  if (bridge) { bridge.post(message); return; }
  (document.getElementById("chat-frame") as HTMLIFrameElement | null)?.contentWindow?.postMessage(message, CHAT_ORIGIN);
}

/** The placeholder occupies exactly the former iframe's layout; it never contains an editor. */
export function observeEditorLayout(element: HTMLElement, bridge: EditorBridge, visible: () => boolean): () => void {
  let previous = "";
  const update = () => {
    const rect = element.getBoundingClientRect();
    const bounds = visible() && rect.width > 0 && rect.height > 0
      ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.floor(rect.width), height: Math.floor(rect.height) } : null;
    const occluded = shellOverlayActive();
    const revealImmediately = shellOverlayRevealImmediately();
    const key = JSON.stringify({bounds, occluded, revealImmediately, stamp: bridge.current()});
    if (key === previous) return;
    previous = key;
    bridge.layout(bounds, occluded, revealImmediately);
  };
  const observer = new ResizeObserver(update);
  observer.observe(element);
  const stopOverlays = subscribeShellOverlays(update);
  window.addEventListener("resize", update);
  const unsubscribe = bridge.subscribe(packet => { if ("bound" in packet) update(); });
  update();
  return () => { observer.disconnect(); stopOverlays(); window.removeEventListener("resize", update); unsubscribe(); bridge.layout(null); };
}
