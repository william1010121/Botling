import type { CcbWeb } from "../../../../Web/src/plugins";
import { catchUpRenderer } from "./group";
import { setPage } from "./page";

/**
 * Catch-up's web part: draws the summaries its program part put among the chat's messages (chat
 * extension v2), with the chat's own Markdown, media and task chips, and asks the program part to
 * retry one or to summarize a stretch.
 */
export function activate(ccb: CcbWeb): () => void {
  setPage({
    render: (text) => ccb.messages.render(text),
    media: (url, label) => ccb.messages.media(url, label),
    taskChip: (task, action) => ccb.messages.taskChip(task, action),
    call: (method, params) => ccb.call(method, params),
  });
  return ccb.decorations.register(catchUpRenderer());
}
