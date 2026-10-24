import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Client, type Bridge } from "./client";
import { ChatStore } from "./store";
import { CardBroker } from "./broker";

const bridge = (window as unknown as { botling?: Bridge }).botling;
const root = createRoot(document.getElementById("root")!);

if (!bridge) {
  root.render(<div className="banner">Botling's bridge is missing: open this page in the app.</div>);
} else {
  const client = new Client(bridge);
  const store = new ChatStore(() => client.request({ type: "chat.snapshot" }));
  client.onEvent((event) => store.receive(event));
  const broker = new CardBroker({
    save: (target, data) => client.request({ type: "card.save", messageId: target.messageId, cardId: target.cardId, data }),
    action: (target, name, value) => client.request({ type: "card.action", messageId: target.messageId, cardId: target.cardId, name, value }),
  });
  // For end-to-end tests and diagnostics: what the broker refused and accepted.
  (window as unknown as { __botlingBroker: CardBroker }).__botlingBroker = broker;
  (window as unknown as { __botlingStore: ChatStore }).__botlingStore = store;
  void store.resync();
  root.render(<App client={client} store={store} broker={broker} />);
}
