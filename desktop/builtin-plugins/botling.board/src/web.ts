import type { CcbWeb } from "../../../../Web/src/plugins";
import { FloatLayer } from "./float";
import { useKit } from "./kit";
import { PinArea, pinBar, specPinButton } from "./pins";
import { reportVisiblePins, reportVisiblePinsSoon, resetVisiblePins } from "./visible";

/**
 * The Board and pins: the strip of pinned components above the input box (and the sheet a chip raises), the Board in place of the
 * messages, pins floating in a corner, and the pin / ↻ / ⋯ bar over a component in a reply. Everything is drawn here, in the chat page
 * (a pin's card is the page's own component frame); what a pin is, where it sits and when it runs is still Botling's (`pin.*`).
 */
export function activate(ccb: CcbWeb): () => void {
  useKit(ccb.page);
  resetVisiblePins();
  const area = new PinArea(ccb.page.slots.pinArea, ccb.page.slots.board);
  const floats = new FloatLayer(ccb.page.slots.overlay);
  ccb.page.onState((state) => {
    area.update(state);
    floats.update(state);
    reportVisiblePinsSoon();
  });
  ccb.messages.cardBar((display, messageID, index) => (display.pinned === undefined || display.pinned === null ? null : pinBar(display, messageID, index)));
  ccb.messages.specButton((spec) => specPinButton(spec));
  // Which pins the user can see changes as the chat or Board scrolls, the window resizes, or a pin
  // is opened or closed: Swift's timer reruns only those.
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
