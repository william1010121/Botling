// The actual shell, without Electron, CLI processes or a real profile.
import { createRoot } from "react-dom/client";
import { App } from "../../src/renderer/App";
import { Client } from "../../src/renderer/client";
import { WorkspaceStore } from "../../src/renderer/store";
import type { Command } from "../../src/contract";

declare global { interface Window { sidebarRequest: (cmd: Command) => Promise<any> } }
const store = new WorkspaceStore(async () => ({
  epoch: "sidebar-test", seq: 0, bots: [], imported: null, chat: null, components: {},
  plugins: { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null },
  settings: await window.sidebarRequest({ type: "settings.get" }),
}));
const client = {
  request: async (cmd: Command) => {
    if (cmd.type === "updates.check") return null;
    const result = await window.sidebarRequest(cmd);
    if (cmd.type === "settings.set") await store.resync();
    return result;
  },
} as Client;
void store.resync().then(() => createRoot(document.getElementById("root")!).render(<App client={client} store={store} />));
