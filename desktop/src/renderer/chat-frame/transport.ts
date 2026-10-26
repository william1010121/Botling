import type { EditorBridge } from "../editor-surface";
import { APP_ORIGIN, type FrameMessage, type ShellMessage } from "./protocol";

export const nativeChat = (window as unknown as { botlingEditor?: EditorBridge }).botlingEditor;

export function toShell(message: FrameMessage): boolean {
  if (nativeChat) return nativeChat.post(message);
  window.parent.postMessage(message, APP_ORIGIN);
  return true;
}

export function fromShell(receive: (message: ShellMessage) => void): () => void {
  if (nativeChat) return nativeChat.subscribe(packet => { if ("message" in packet) receive(packet.message as ShellMessage); });
  const listener = (event: MessageEvent) => {
    if (event.source === window.parent && event.origin === APP_ORIGIN) receive(event.data as ShellMessage);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

/** Existing application shortcuts become semantic actions; editing events never leave this root. */
export function installNativeShellCommands(): void {
  if (!nativeChat) return;
  document.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    const key = event.key.toLowerCase();
    const command = key === "," && (event.metaKey || event.ctrlKey) ? "settings"
      : key === "i" && event.metaKey && event.ctrlKey ? "rightPanel"
      : key === "s" && event.metaKey && event.ctrlKey ? "sidebar"
      : key === "k" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey ? "search" : null;
    if (!command) return;
    event.preventDefault();
    toShell({ botling: "action", action: { type: "shellCommand", command } });
  }, true);
}
