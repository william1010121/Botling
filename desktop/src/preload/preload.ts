// The app page's only bridge: post an envelope, receive envelopes. No ipcRenderer, no Node, no
// event objects (they would expose `sender`). Main validates everything posted here; this file
// stays tiny on purpose so there is little privileged code to get wrong.
import { contextBridge, ipcRenderer } from "electron";
import {editorBridge} from "./editor-bridge";

const listeners = new Set<(message: unknown) => void>();
ipcRenderer.on("botling:message", (_event, message: unknown) => {
  for (const listener of listeners) listener(message);
});

contextBridge.exposeInMainWorld("botling", Object.freeze({
  protocol: 2,
  // Dormant until main selects the native-editor shell; current windows do not receive this argument.
  ...(process.isMainFrame&&process.argv.includes("--botling-editor-shell=1")?{editorHost:editorBridge(ipcRenderer,"shell")} : {}),
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

// Main adds this argument only for unpackaged fake-agent runs with a verified synthetic data dir.
// Main must independently gate/validate the writer; this capability never grants a core command.
if (process.isMainFrame && process.argv.includes("--botling-test-trace=1")) {
  contextBridge.exposeInMainWorld("__botlingTestTrace", Object.freeze({
    protocol: 1,
    emit(record: unknown) { ipcRenderer.send("botling:test-trace", record); },
  }));
}
