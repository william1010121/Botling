import { actionForEvent, bindingsFor, commandForEvent, type Bindings } from "../../contract/shortcuts";
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

/** Native shell reload/rebinding invalidates delivery assumptions, not the user's editor draft. */
export function onTransportDisconnect(disconnected: () => void): () => void {
  let previous = nativeChat?.current();
  const unsubscribe = nativeChat?.subscribe(packet => {
    if ("unbound" in packet) { previous = null; disconnected(); }
    else if ("bound" in packet) {
      if (previous && (previous.surfaceId !== packet.stamp.surfaceId || previous.documentGeneration !== packet.stamp.documentGeneration)) disconnected();
      previous = packet.stamp;
    }
  });
  window.addEventListener("pagehide", disconnected);
  return () => { unsubscribe?.(); window.removeEventListener("pagehide", disconnected); };
}

let bindings: Bindings = bindingsFor({});
let commands: Record<string, string> = {};
/** The shell tells this page the keys now bound (before any, the defaults): the app's and plugin commands'. */
export function setShortcutBindings(next: Record<string, string>, nextCommands: Record<string, string> = {}): void {
  bindings = bindingsFor(next);
  commands = { ...nextCommands };
}
const SHELL_COMMANDS: Record<string, string> = { settings: "settings", toggleRightPanel: "rightPanel", toggleSidebar: "sidebar", search: "search" };

/**
 * Existing application shortcuts become semantic actions (native chat); plugin commands' keys run here when a
 * web part registered the command (`runLocal`), else the shell runs it. Editing events never leave this root.
 */
export function installNativeShellCommands(runLocal: (id: string) => boolean = () => false): void {
  document.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    const command = nativeChat ? SHELL_COMMANDS[actionForEvent(event, bindings) ?? ""] ?? null : null;
    if (command) {
      event.preventDefault();
      toShell({ botling: "action", action: { type: "shellCommand", command } });
      return;
    }
    const plugin = commandForEvent(event, commands);
    if (!plugin) return;
    event.preventDefault();
    if (!runLocal(plugin)) toShell({ botling: "action", action: { type: "runCommand", id: plugin, via: "key" } });
  }, true);
}
