import "./input-trace-shell";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Client, type Bridge } from "./client";
import { WorkspaceStore } from "./store";

const bridge = (window as unknown as { botling?: Bridge }).botling;
const root = createRoot(document.getElementById("root")!);

if (!bridge) {
  root.render(<div className="banner">Botling's bridge is missing: open this page in the app.</div>);
} else {
  const client = new Client(bridge);
  const store = new WorkspaceStore((botId) => client.request({ type: "chat.snapshot", ...(botId ? { botId } : {}) }), (botId, before, until) => client.request({ type: "chat.history", botId, before, ...(until ? { until } : {}) }));
  client.onEvent((event) => store.receive(event));
  // For end-to-end tests and diagnostics.
  (window as unknown as { __botlingStore: WorkspaceStore }).__botlingStore = store;
  void store.resync();
  root.render(<App client={client} store={store} />);
}
