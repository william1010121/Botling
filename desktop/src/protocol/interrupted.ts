// How a turn botlingd interrupted (`turn.interrupted`, §9.3: it stopped or crashed mid-reply, and nothing is re-run)
// shows on its reply line: the way 2.x shows a reply its core died during (core/bot.ts, on load: state "failed",
// `interrupted`, and a note after the words so far), with the checkpoint text as the words so far. The server's read model
// (server/log/read-model.ts, what a `snap` shows) and the Botling 3 window's adapter (main-v3/renderer-adapter.ts, the
// live path) both build the line here, so a snapshot after the restart shows exactly what the live event showed
// (M1 demo bug 5a). The 2.x renderer has no Continue or Retry for such a line; it shows the words and the note.
import { MESSAGE_TEXT_LIMIT, type MessageView } from "../contract";

export const INTERRUPTED_NOTE = "(Interrupted: the Botling server restarted during this reply. It was not sent again.)";

/** Reply line `line` (or a new one with `id` and `time` when there is none yet) after `turn.interrupted` with `text`. */
export function interruptedLine(line: MessageView | null | undefined, interrupted: { turnId: string; text: string }, fresh: { id: string; time: string }): MessageView {
  const base = line ?? { id: fresh.id, role: "bot" as const, text: "", time: fresh.time, turnId: interrupted.turnId };
  if (base.interrupted && base.state === "failed" && base.text.endsWith(INTERRUPTED_NOTE)) return base;
  const words = (interrupted.text || base.text).slice(0, MESSAGE_TEXT_LIMIT * 4 - INTERRUPTED_NOTE.length - 2);
  return { ...base, text: `${words}${words ? "\n\n" : ""}${INTERRUPTED_NOTE}`, state: "failed", interrupted: true };
}
