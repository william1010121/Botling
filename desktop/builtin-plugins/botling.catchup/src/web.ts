import type { CcbWeb } from "../../../../Web/src/plugins";
import { catchUpRenderer } from "./group";
import { setPage } from "./page";

/**
 * Catch-up's web part: draws the header its program part put before the folded messages (chat extension
 * v2), and opens the folded messages in a read-only dialog, with the chat's own Markdown and media.
 */
export function activate(ccb: CcbWeb): () => void {
  setPage({
    render: (text) => ccb.messages.render(text),
    media: (url, label) => ccb.messages.media(url, label),
  });
  return ccb.decorations.register(catchUpRenderer());
}
