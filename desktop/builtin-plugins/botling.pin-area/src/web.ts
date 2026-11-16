import type { CcbWeb } from "../../../../Web/src/plugins";
import type { ChatState } from "../../../../Web/src/types";
import type { PinsView } from "./digest";
import { parseAsk, stripBriefing, type TraceData } from "./model";
import { PinUi, pinIcon } from "./ui";
import { wordsFor } from "./words";

export const PLUGIN = "botling.pin-area";
/** The page says the user is here at most this often. */
export const PRESENT_EVERY_MS = 60_000;

/** What the chat page's state says for the pins: what the program part published for this chat (`state.pluginData`). */
export function bookOf(state: ChatState): PinsView | null {
  const data = state.pluginData?.[PLUGIN] as PinsView | undefined;
  return data && typeof data === "object" && Array.isArray(data.pins) ? data : null;
}

/** A decoration's data as the program part wrote it, or null (anything else is not drawn). */
export function traceOf(raw: unknown): TraceData | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const text = (value: unknown) => typeof value === "string";
  if ((d.kind !== "moved" && d.kind !== "back") || !text(d.rid) || !text(d.pin) || !text(d.title) || !text(d.q) || (d.a !== undefined && !text(d.a))) return null;
  return { kind: d.kind, rid: d.rid as string, pin: d.pin as string, title: d.title as string, q: d.q as string, by: d.by === "user" ? "user" : "bot", ...(typeof d.a === "string" ? { a: d.a } : {}) };
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
    openChat: (id, messageId) => ccb.page.openChat(id, messageId),
  });
  // 「你不在時」: a sign that the user is here, at most once a minute (the program part decides what a gap of 30 minutes means).
  const signs = new AbortController();
  let lastSign = 0;
  const present = () => {
    const at = Date.now();
    if (!botId || at - lastSign < PRESENT_EVERY_MS || document.visibilityState === "hidden") return;
    lastSign = at;
    void ccb.call("touch", { botId }).catch(() => {});
  };
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel", "focus"]) window.addEventListener(type, present, { capture: true, passive: true, signal: signs.signal });
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
  // The note of the cards a plain message carries for the bot is not the user's: the bubble shows their words only.
  const bubbles = ccb.messages.userText((text) => {
    const own = stripBriefing(text);
    const asked = parseAsk(own);
    return asked ? `@${asked.title} ${asked.text}` : own;
  });
  // Where a line the bot put into a card went: a one-line trace in its place (a decoration the program part asked for), with 移回聊天 and 改到….
  const traces = ccb.decorations.register({
    draw: (root, decoration) => {
      const data = traceOf(decoration.data);
      if (data) ui.trace(root, data);
    },
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
  return () => { signs.abort(); mentions(); bubbles(); traces(); pinning(); ui.dispose(); };
}
