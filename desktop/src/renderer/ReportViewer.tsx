import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { BotView } from "../contract";
import { FloatingChat } from "./FloatingChat";
import { ShellOverlay } from "./ShellOverlay";

/**
 * The full page report preview over the chat column. With `bubble` it offers the page's bot's floating chat, the same
 * FloatingChat (and BotBubble strip) as the Note tab and the browser's full screen: the strip in a corner of the page,
 * the bot's real chat floating over it, or docked where the chat column shows it. While the chat is open the viewer
 * stops counting as a shell overlay, so the native chat shows over the page; Esc hides the chat first, then closes the
 * preview.
 */
export function ReportViewer({ url, onClose, bubble }: { url: string; onClose: () => void;
  bubble?: { bot: BotView; look: "original" | "cute"; on: boolean; onOpen(open: boolean): void; line: string } }) {
  const back = useRef<HTMLButtonElement>(null);
  const page = useRef<HTMLIFrameElement>(null);
  const area = useCallback(() => page.current, []);
  useEffect(() => {
    const previous = document.activeElement;
    back.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const chatOn = !!bubble?.on;
  return createPortal(<ShellOverlay active={!chatOn}><section className={`report-viewer${chatOn ? " chat-on" : ""}`} role="dialog" aria-modal={chatOn ? undefined : "true"} aria-label="Report preview"
    onKeyDown={event => { if (event.key !== "Escape") return; event.preventDefault(); if (chatOn) bubble!.onOpen(false); else onClose(); }}>
    <header><button ref={back} type="button" onClick={onClose}>← Back to conversation</button><span>Report preview</span></header>
    <div className="report-page">
      <iframe ref={page} src={url} title="Full page report" sandbox="allow-scripts" />
      {bubble && <FloatingChat place="preview" bot={bubble.bot} look={bubble.look} open={bubble.on} onOpen={bubble.onOpen} line={bubble.line} area={area} />}
    </div>
  </section></ShellOverlay>, document.body);
}
