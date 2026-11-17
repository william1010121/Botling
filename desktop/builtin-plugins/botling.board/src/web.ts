import type { CcbWeb } from "../../../../Web/src/plugins";
import type { ChatState } from "../../../../Web/src/types";
import { FloatLayer } from "./float";
import { useKit } from "./kit";
import { barFor, PinArea, pinBar, prime, specPinButton } from "./pins";
import type { BoardData, BoardState } from "./types";
import { reportVisiblePins, reportVisiblePinsSoon, resetVisiblePins } from "./visible";

export const PLUGIN = "botling.board";

/** What the chat page's state says for the pins: the pins its program part keeps (`state.pluginData`), as the page's state once held them. */
export function boardState(state: ChatState): BoardState {
  const data = state.pluginData?.[PLUGIN] as BoardData | undefined;
  if (!data) return state;
  return {
    ...state, pins: data.pins, pinChoices: data.pinChoices,
    floating: data.floating.map((pin) => ({ botID: state.botID, botName: state.botName, pin, global: null, blocked: null })),
  };
}

/**
 * Pins: the strip of pinned components above the input box (and the sheet a chip raises), pins floating in a corner, and the pin / ↻ / ⋯ bar over a component in a reply. Everything is drawn here, in the chat page
 * (a pin's card is the page's own component frame); what a pin is, where it sits and when it runs is the program part's (host.ts),
 * which tells each chat what to draw (`chat.setData`) and hears what the user did to pins (`action`).
 */
export function activate(ccb: CcbWeb): () => void {
  useKit(ccb.page);
  resetVisiblePins();
  const area = new PinArea(ccb.page.slots.pinArea);
  const floats = new FloatLayer(ccb.page.slots.overlay);
  // A chat with no data yet (just opened, or the program part came back) asks for it, at most every few seconds.
  const asked = new Map<string, number>();
  const ask = (state: ChatState) => {
    if (state.pluginData?.[PLUGIN]) { asked.delete(state.botID); return; }
    const last = asked.get(state.botID);
    if (last !== undefined && Date.now() - last < 3_000) return;
    asked.set(state.botID, Date.now());
    void ccb.call("view", { botId: state.botID }).catch(() => {});
  };
  ccb.page.onState((state) => {
    ask(state);
    const board = boardState(state);
    area.update(board);
    floats.update(board);
    reportVisiblePinsSoon();
  });
  ccb.messages.cardBar(
    (display, messageID, index) => (barFor(display.name).offered ? pinBar(display, messageID, index) : null),
    // Before the messages are drawn: the bars take what is pinned from this state; a message with a card is drawn again when that changes.
    (state) => {
      const board = boardState(state);
      prime(board);
      return JSON.stringify([!!board.pins, !!board.subagent, (board.pins ?? []).map((pin) => pin.name).sort()]);
    },
  );
  // The pin button in the head of a component the component studio made from a reply: through the studio's seam, not the chat page's.
  ccb.studio.specButton((spec) => specPinButton(spec));
  // Which pins the user can see changes as the chat scrolls, the window resizes, or a pin
  // is opened or closed: the program part's timer reruns only those.
  const listeners = new AbortController();
  for (const type of ["scroll", "resize", "click", "visibilitychange"]) {
    (type === "resize" ? window : document).addEventListener(type, reportVisiblePinsSoon, { capture: true, passive: true, signal: listeners.signal });
  }
  ccb.page.onWindowVisible(reportVisiblePins);
  return () => {
    listeners.abort();
    area.dispose();
    floats.dispose();
    resetVisiblePins();
    useKit(null);
  };
}
