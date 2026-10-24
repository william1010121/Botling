// The app page's only bridge: post an envelope, receive envelopes. No ipcRenderer, no Node, no
// event objects (they would expose `sender`). Main validates everything posted here; this file
// stays tiny on purpose so there is little privileged code to get wrong.
import { contextBridge, ipcRenderer } from "electron";

const listeners = new Set<(message: unknown) => void>();
ipcRenderer.on("botling:message", (_event, message: unknown) => {
  for (const listener of listeners) listener(message);
});

contextBridge.exposeInMainWorld("botling", Object.freeze({
  protocol: 2,
  platform: process.platform,
  post(envelope: unknown) {
    ipcRenderer.send("botling:post", envelope);
  },
  subscribe(listener: (message: unknown) => void) {
    if (typeof listener !== "function") throw new TypeError("subscribe takes a function");
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
}));
