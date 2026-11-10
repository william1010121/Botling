import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { BotView } from "../contract";
import { BotBubble } from "./BotBubble";
import { ShellOverlay } from "./ShellOverlay";

/**
 * The full page report preview over the chat column. With `bubble` it offers the page's bot's bubble, the same BotBubble
 * as the Note tab and the browser's full screen (one component, so their future floating chat restyle lands here too).
 * While the chat is open the viewer stops counting as a shell overlay, so the bot's real (native) chat shows over the
 * page; Esc hides the chat first, then closes the preview.
 */
export function ReportViewer({ url, onClose, bubble }: { url: string; onClose: () => void;
  bubble?: { bot: BotView; look: "original" | "cute"; on: boolean; onToggle(): void } }) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    back.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const chatOn = !!bubble?.on;
  return createPortal(<ShellOverlay active={!chatOn}><section className={`report-viewer${chatOn ? " chat-on" : ""}`} role="dialog" aria-modal={chatOn ? undefined : "true"} aria-label="Report preview"
    onKeyDown={event => { if (event.key !== "Escape") return; event.preventDefault(); if (chatOn) bubble!.onToggle(); else onClose(); }}>
    <header><button ref={back} type="button" onClick={onClose}>← Back to conversation</button><span>Report preview</span></header>
    <iframe src={url} title="Full page report" sandbox="allow-scripts" />
    {bubble && <BotBubble bot={bubble.bot} look={bubble.look} on={bubble.on} onToggle={bubble.onToggle} className="report-bubble" />}
  </section></ShellOverlay>, document.body);
}
