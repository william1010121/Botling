// botling.note, cards in the note: a `<show name="component" …>JSON</show>` (or `<show name="…" command="…"></show>`,
// `<show name="…"/>`) standing on its own line(s), the chat's own syntax. The note keeps that text as it is; the editor draws
// it as a live card (ui.js). The patterns are the core's (desktop/src/core/reply.ts showTag / attributes), so the editor
// and the bots read the same cards; a tag whose data is not JSON, or without a name, is no card (the core keeps it as text).
// Everything here is pure.

// Reading a `<show>` line (cardAt, showAttributes, refresh) is the app's one copy of the rules, desktop/src/core/note-cells.ts.
import { cardAt, showAttributes, cardRefreshSeconds as refreshSeconds } from "../../../src/core/note-cells.ts";
export { cardAt, showAttributes, refreshSeconds };

const escAttr = (s) => String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// The line a new card is written as: a component with a Command runs it (an empty tag); one without shows JSON
// (what the bot's chat last drew it with, else {}), kept on one line.
export function showLine(component) {
  const name = escAttr(component?.name ?? "");
  if (component?.command) return `<show name="${name}"></show>`;
  let data = "{}";
  if (typeof component?.chatData === "string" && component.chatData.trim()) {
    try {
      data = JSON.stringify(JSON.parse(component.chatData));
    } catch {
      data = "{}";
    }
  }
  return `<show name="${name}">${data}</show>`;
}
