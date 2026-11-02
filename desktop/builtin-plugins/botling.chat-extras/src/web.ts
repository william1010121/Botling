import type { CcbWeb } from "../../../../Web/src/plugins";
import { isLongUserText, settleUserFold, userFold } from "./fold";
import { groupImages } from "./gallery";
import { collapsePastes, openPasteDialog, pasteChip, splitPasted } from "./paste";

/**
 * Chat extras for Botling: pictures in a row of a reply become one gallery, a long message of yours
 * folds to its first lines (Show more), and a long paste waits as a chip above the input box, then
 * as a chip under the message it went with.
 */
export function activate(ccb: CcbWeb): void {
  collapsePastes(ccb);
  // A sent message's paste is not in its bubble; the chip under it opens it in a dialog.
  ccb.messages.userText((text) => splitPasted(text).text);

  ccb.messages.afterRender((element, message) => {
    if (message.role !== "user") {
      for (const piece of element.querySelectorAll<HTMLElement>(".bot-bubble > .markdown, .notice-bubble > .markdown")) groupImages(piece);
      return;
    }
    const { text, pasted } = splitPasted(message.text);
    const bubble = element.querySelector<HTMLElement>(".user-body > .user-bubble");
    if (bubble && isLongUserText(text)) {
      // It shows its first lines; the control under it, centered, opens and folds it.
      const fold = userFold(message.id, bubble);
      requestAnimationFrame(() => { if (fold.isConnected) settleUserFold(fold); });
    }
    const body = element.querySelector<HTMLElement>(".user-body");
    if (pasted !== null && body) {
      const strip = document.createElement("div");
      strip.className = "attachments";
      strip.append(pasteChip(pasted, () => openPasteDialog(pasted)));
      body.insertBefore(strip, body.querySelector(":scope > .message-footer"));
    }
  });
}
