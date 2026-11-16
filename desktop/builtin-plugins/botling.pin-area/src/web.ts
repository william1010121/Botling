import type { CcbWeb } from "../../../../Web/src/plugins";
import type { ChatState } from "../../../../Web/src/types";
import { parseAsk, type BookView } from "./model";
import { PinUi, pinIcon } from "./ui";
import { wordsFor } from "./words";

export const PLUGIN = "botling.pin-area";

/** What the chat page's state says for the pins: what the program part published for this chat (`state.pluginData`). */
export function bookOf(state: ChatState): BookView | null {
  const data = state.pluginData?.[PLUGIN] as BookView | undefined;
  return data && typeof data === "object" && Array.isArray(data.pins) ? data : null;
}

/**
 * Pin 區: the strip of cards above the chat (the page's `topArea` slot), the panel a card opens (the `overlay` slot), the 釘選 button
 * on every message, and the cards in the input box's @ list (`ccb.composer.mentionSource`). What a card is, who may change it and where a
 * message written into it goes is the program part's (pins.ts); this draws what it publishes and sends what the user does.
 */
export function activate(ccb: CcbWeb): () => void {
  const words = wordsFor(() => ccb.page.language());
  let botId = "";
  const ui = new PinUi(ccb.page.slots.topArea, ccb.page.slots.overlay, {
    call: (method, params) => ccb.call(method, params),
    send: (text) => ccb.page.post({ type: "send", text }),
    words,
    now: () => Date.now(),
    reduceMotion: () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  });
  // A chat with no data yet asks for it, at most every few seconds.
  const asked = new Map<string, number>();
  ccb.page.onState((state) => {
    botId = state.botID;
    const data = bookOf(state);
    if (!data) {
      const last = asked.get(state.botID);
      if (last === undefined || Date.now() - last >= 3_000) {
        asked.set(state.botID, Date.now());
        void ccb.call("view", { botId: state.botID }).catch(() => {});
      }
    } else asked.delete(state.botID);
    ui.update(state.botID, data);
  });
  // "@card words": the cards after @, before the bots
  const mentions = ccb.composer.mentionSource((query) => ui.mentions(query));
  // The bubble of a message written into a card shows "@title words", not the header the bot got.
  const bubbles = ccb.messages.userText((text) => {
    const asked = parseAsk(text);
    return asked ? `@${asked.title} ${asked.text}` : text;
  });
  // The 釘選 button of any message: in a reply's hover column, beside your own message otherwise.
  const pinning = ccb.messages.afterRender((element, message) => {
    if (element.querySelector(".pt-pin-msg") || !message.text.trim() || parseAsk(message.text)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "reply-button pt-pin-msg";
    button.title = words("msg.pin");
    button.setAttribute("aria-label", words("msg.pin"));
    button.append(pinIcon(14));
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const target = botId;
      void ccb.call("pinMessage", { botId: target, messageId: message.id, text: message.text }).then(
        (result) => {
          const id = (result as { id?: string } | null)?.id;
          if (id) ui.open(id);
        },
        () => {},
      );
    });
    const actions = element.querySelector(":scope > .message-actions");
    if (actions) actions.append(button); else element.append(button);
  });
  return () => { mentions(); bubbles(); pinning(); ui.dispose(); };
}
