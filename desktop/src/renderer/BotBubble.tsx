// The bot's round bubble that shows or hides its chat beside something else: the browser's full screen (BrowserPane)
// and the Note tab (NoteDock). Its face shows what the bot is doing, a dot its status, a badge its unread messages.
import type { BotView } from "../contract";
import { faceURL } from "./avatars";

export function BotBubble({ bot, look, on, onToggle, className }: { bot: BotView; look: "original" | "cute"; on: boolean; onToggle(): void; className?: string }) {
  const statusKey = bot.working ? "working" : bot.approvals > 0 ? "waiting" : "idle";
  const unread = bot.unread;
  return (
    <button type="button" className={`bp-bubble${on ? " on" : ""}${className ? ` ${className}` : ""}`} onClick={onToggle}
      aria-label={`${bot.name}, ${statusKey}${unread ? `, ${unread} new message${unread === 1 ? "" : "s"}` : ""}. ${on ? "Hide" : "Show"} the chat`} aria-pressed={on}
      title={on ? "Hide the chat (Esc)" : `Ask ${bot.name}`}>
      <img src={faceURL(bot, look, { asleep: bot.phase === "asleep" && !bot.working, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
      <span className="bp-bubble-dot" data-status={statusKey} aria-hidden="true" />
      {unread > 0 && !on && <span className="bp-bubble-badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
    </button>
  );
}
