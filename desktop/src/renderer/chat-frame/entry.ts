// The chat frame (app://botling/chat.html): the Swift app's chat page from Web/src, unchanged,
// fed with state by the app page. On top of it the desktop adds what the page does not have yet:
// Phase 0's sandboxed cards in their bubbles, a Stop button in the input box, and KaTeX (the
// ccb-latex plugin, bundled in).
import "./shim";
import "../../../../Web/src/main";
import { CardBroker, type CardTarget } from "../broker";
import type { FrameExtras } from "../payload";
import type { FrameMessage, ShellMessage } from "./protocol";

declare const __LATEX_SOURCE__: string;

const origin = location.origin;
const toShell = (message: FrameMessage) => window.parent.postMessage(message, origin);

// ---------------------------------------------------------------------------------------------
// Card requests go to the app page, which owns the contract client.

let nextRequest = 0;
const waiting = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
function request(cmd: Extract<FrameMessage, { botling: "request" }>["cmd"]): Promise<void> {
  const id = ++nextRequest;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    toShell({ botling: "request", id, cmd });
  });
}

const broker = new CardBroker({
  save: (target, data) => request({ type: "card.save", botId: target.botId, messageId: target.messageId, cardId: target.cardId, data }),
  action: (target, name, value) => request({ type: "card.action", botId: target.botId, messageId: target.messageId, cardId: target.cardId, name, value }),
});
// For end-to-end tests and diagnostics: what the broker refused and accepted.
(window as unknown as { __botlingBroker: CardBroker }).__botlingBroker = broker;

interface DrawnCard { element: HTMLElement; target: CardTarget; unregister: () => void; data: string | null; loaded: boolean }
const cards = new Map<string, DrawnCard>();

function cardElement(botId: string, messageId: string, cardId: string): DrawnCard {
  const element = document.createElement("div");
  element.className = "card";
  element.dataset.card = cardId;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = "Card";
  frame.style.height = "80px";
  frame.src = `botling-card://card/${encodeURIComponent(botId)}/${encodeURIComponent(messageId)}/${encodeURIComponent(cardId)}`;
  element.append(frame);
  const target: CardTarget = { botId, messageId, cardId, frame, onSize: (height) => { frame.style.height = `${Math.max(40, Math.min(height, 900))}px`; } };
  const drawn: DrawnCard = { element, target, unregister: broker.register(target), data: null, loaded: false };
  // A frame loads again when its element moves (the page redrew the message): send its data again.
  frame.addEventListener("load", () => { drawn.loaded = true; broker.sendData(target, drawn.data); });
  return drawn;
}

/** Puts each message's cards in its bubble, and its turn state on its row. */
function decorate(extras: FrameExtras) {
  const list = document.getElementById("messages");
  if (!list) return;
  document.body.classList.toggle("botling-running", extras.running);
  for (const row of list.querySelectorAll<HTMLElement>(".row[data-id]")) {
    const state = extras.states[row.dataset.id!];
    if (state) row.dataset.state = state;
    else delete row.dataset.state;
  }
  const keep = new Set<string>();
  for (const [messageId, list_] of Object.entries(extras.cards)) {
    const row = list.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(messageId)}"]`);
    const host = row?.querySelector<HTMLElement>(".bot-bubble, .notice-bubble");
    if (!host) continue;
    for (const card of list_) {
      const key = `${extras.botId}/${messageId}/${card.id}`;
      keep.add(key);
      let drawn = cards.get(key);
      if (!drawn) {
        drawn = cardElement(extras.botId, messageId, card.id);
        cards.set(key, drawn);
      }
      if (drawn.element.parentElement !== host) host.append(drawn.element);
      if (drawn.data !== card.data) {
        drawn.data = card.data;
        if (drawn.loaded) broker.sendData(drawn.target, card.data);
      }
    }
  }
  for (const [key, drawn] of cards) {
    if (keep.has(key)) continue;
    drawn.unregister();
    drawn.element.remove();
    cards.delete(key);
  }
}

// ---------------------------------------------------------------------------------------------
// Stop: a button beside Send while a reply is being written.

function addStop() {
  const tools = document.querySelector(".composer .composer-tools");
  if (!tools || tools.querySelector(".send.stop")) return;
  const stop = document.createElement("button");
  stop.className = "send stop";
  stop.type = "button";
  stop.setAttribute("aria-label", "Stop");
  stop.title = "Stop";
  stop.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>`;
  stop.addEventListener("click", () => toShell({ botling: "stop" }));
  tools.append(stop);
}

// ---------------------------------------------------------------------------------------------

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window.parent || event.origin !== origin) return;
  const message = event.data as ShellMessage | null;
  if (!message || typeof message !== "object") return;
  if (message.botling === "state") {
    window.ccb.setState(message.state);
    addStop();
    decorate(message.extras);
  } else if (message.botling === "response") {
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    if (message.ok) entry.resolve();
    else entry.reject(new Error(message.error ?? "refused"));
  }
});

// Escape stops a reply being written, as in a terminal.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("botling-running") && !event.isComposing) toShell({ botling: "stop" });
});

// LaTeX in messages: the ccb-latex plugin, bundled in (its stylesheet and fonts sit beside chat.html).
void window.ccb.setPlugins([{
  name: "ccb-latex",
  version: "1.0.0",
  source: __LATEX_SOURCE__,
  styles: [new URL("plugins/ccb-latex/katex.min.css", location.href).toString()],
  settings: { "ccb-latex.preview": true, "ccb-latex.copyTeX": true },
  commands: [{ id: "ccb-latex.insert", title: "Insert inline formula", key: "cmd+shift+m" }],
}]);
