import { packChatAvatars } from "./chat-avatar-wire";
import { shellOverlayActive, shellOverlayRevealImmediately, subscribeShellOverlays } from "./ShellOverlay";
import type { editorBridge } from "../preload/editor-bridge";
import { CHAT_TARGET, type ShellMessage } from "./chat-frame/protocol";

export type EditorBridge = ReturnType<typeof editorBridge>;
export const nativeEditor = (): EditorBridge | undefined =>
  (window as unknown as { botling?: { editorHost?: EditorBridge } }).botling?.editorHost;

/** Business messages use the authenticated native pair when present, even while unbound. */
export function postToChat(message: ShellMessage): void {
  const bridge = nativeEditor();
  if (bridge) { bridge.post(packChatAvatars(message)); return; }
  (document.getElementById("chat-frame") as HTMLIFrameElement | null)?.contentWindow?.postMessage(message, CHAT_TARGET);
}

/** Said on `window` when the chat's placeholder moved without changing size (the floating chat dragged). */
export const CHAT_MOVED = "botling:chat-moved";

/** The placeholder occupies exactly the former iframe's layout; it never contains an editor. */
export function observeEditorLayout(element: HTMLElement, bridge: EditorBridge, visible: () => boolean): () => void {
  let previous = "";
  const update = () => {
    const rect = element.getBoundingClientRect();
    const bounds = visible() && rect.width > 0 && rect.height > 0
      ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.floor(rect.width), height: Math.floor(rect.height) } : null;
    const occluded = shellOverlayActive();
    const revealImmediately = shellOverlayRevealImmediately();
    // Floating over a page (FloatingChat.tsx), the native chat is drawn as a panel with rounded corners.
    const rounded = !!bounds && element.classList.contains("chat-floating");
    const key = JSON.stringify({bounds, occluded, revealImmediately, rounded, stamp: bridge.current()});
    if (key === previous) return;
    previous = key;
    bridge.layout(bounds, occluded, revealImmediately, rounded);
  };
  const observer = new ResizeObserver(update);
  observer.observe(element);
  // The chat can move without changing size: docked beside the Note at a fixed width (NoteDock.tsx), it slides when
  // the left column folds. The chat pane around it changes size then.
  const pane = element.closest(".chat-pane");
  if (pane) observer.observe(pane);
  const stopOverlays = subscribeShellOverlays(update);
  window.addEventListener("resize", update);
  // The floating chat's panel moves the placeholder without resizing it (FloatingChat.tsx says so).
  window.addEventListener(CHAT_MOVED, update);
  const unsubscribe = bridge.subscribe(packet => { if ("bound" in packet) update(); });
  update();
  return () => { observer.disconnect(); stopOverlays(); window.removeEventListener("resize", update); window.removeEventListener(CHAT_MOVED, update); unsubscribe(); bridge.layout(null); };
}
