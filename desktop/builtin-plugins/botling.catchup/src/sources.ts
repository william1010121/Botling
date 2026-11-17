import type { MessageView } from "../../../../Web/src/types";
import type { CatchUpView } from "./types";

/** Actual IDs in this exact range, in transcript chronology. */
export function summaryMessages(view: CatchUpView, messages: MessageView[]): MessageView[] {
  const allowed = new Set(view.ids.map(id => id.toLowerCase())), seen = new Set<string>();
  return messages.filter(message => {
    const id = message.id.toLowerCase();
    if (!allowed.has(id) || seen.has(id)) return false;
    seen.add(id); return true;
  });
}
