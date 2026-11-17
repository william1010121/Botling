import type { CcbWeb } from "../../../../Web/src/plugins";
import { catchUpRenderer } from "./group";
import { setPage } from "./page";

/**
 * Catch-up's web part: draws the summaries its program part put among the chat's messages (chat
 * extension v2), with the chat's own Markdown and media, and asks the program part to
 * retry one or to summarize a stretch.
 */
export function activate(ccb: CcbWeb): () => void {
  setPage({
    render: (text) => ccb.messages.render(text),
    media: (url, label) => ccb.messages.media(url, label),
    // The stored data only, read only: a card made by a command is drawn from its last output, never runs the command again, and has no Detail to run.
    component: (name, info, display, key) => ccb.draw.component({ name, info, display: { ...display, command: null, detail: null, folder: null, card: null }, key, cardKey: key, lazy: false }),
    call: (method, params) => ccb.call(method, params),
  });
  return ccb.decorations.register(catchUpRenderer());
}
