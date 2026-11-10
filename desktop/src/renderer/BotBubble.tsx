// The bot's bubble that shows or hides its chat over something else: the browser's full screen (BrowserPane), the Note
// tab and the report preview. Its face shows what the bot is doing, a dot its status, a badge its unread messages.
// With `line` it is the floating chat's strip (design B, FloatingChat.tsx): the face, the bot's newest line, the
// badge and a chevron, with six dots at its start to drag it by (`grab`).
import type { PointerEvent as ReactPointerEvent } from "react";
import type { BotView } from "../contract";
import { faceURL } from "./avatars";

const GRAB = (
  <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
    <circle cx="2.5" cy="2.5" r="1.3" /><circle cx="7.5" cy="2.5" r="1.3" /><circle cx="2.5" cy="7" r="1.3" />
    <circle cx="7.5" cy="7" r="1.3" /><circle cx="2.5" cy="11.5" r="1.3" /><circle cx="7.5" cy="11.5" r="1.3" />
  </svg>
);
const CHEVRON = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 10l4-4 4 4" /></svg>
);

export function BotBubble({ bot, look, on, onToggle, className, line, grab }: {
  bot: BotView; look: "original" | "cute"; on: boolean; onToggle(): void; className?: string;
  /** The strip's text (the bot's newest line); given, the bubble draws as the floating chat's strip. */
  line?: string;
  /** The strip's six dots pressed: the caller drags the strip. */
  grab?: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const statusKey = bot.working ? "working" : bot.approvals > 0 ? "waiting" : "idle";
  const unread = bot.unread;
  const face = faceURL(bot, look, { asleep: bot.phase === "asleep" && !bot.working, working: bot.working, waiting: bot.approvals > 0 });
  const label = `${bot.name}, ${statusKey}${unread ? `, ${unread} new message${unread === 1 ? "" : "s"}` : ""}. ${on ? "Hide" : "Show"} the chat`;
  if (line !== undefined) {
    return (
      <div className={`bot-strip${unread > 0 && !on ? " unread" : ""}${className ? ` ${className}` : ""}`} data-status={statusKey}>
        {grab && <span className="bot-strip-grab" onPointerDown={grab} title="Drag to another corner" aria-hidden="true">{GRAB}</span>}
        <button type="button" className="bot-strip-open" onClick={onToggle} aria-label={label} aria-expanded={on} title={on ? "Hide the chat (Esc)" : `Open the chat with ${bot.name}`}>
          <span className="bot-strip-face"><img src={face} alt="" /><span className="bp-bubble-dot" data-status={statusKey} aria-hidden="true" /></span>
          <span className="bot-strip-line">{line || `Ask ${bot.name}…`}</span>
          {unread > 0 && !on && <span className="bot-strip-badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
          <span className="bot-strip-chevron">{CHEVRON}</span>
        </button>
      </div>
    );
  }
  return (
    <button type="button" className={`bp-bubble${on ? " on" : ""}${className ? ` ${className}` : ""}`} onClick={onToggle}
      aria-label={label} aria-pressed={on}
      title={on ? "Hide the chat (Esc)" : `Ask ${bot.name}`}>
      <img src={face} alt="" />
      <span className="bp-bubble-dot" data-status={statusKey} aria-hidden="true" />
      {unread > 0 && !on && <span className="bp-bubble-badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
    </button>
  );
}
