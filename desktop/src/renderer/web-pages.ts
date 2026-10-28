// Botling Web has no botling-card:// scheme (Electron main serves component and card pages there).
// A data:/blob:/srcdoc page would inherit the chat page's CSP (no inline script), so the web draws
// each page in a small host page the bridge serves, `/mobile/frame-host.html`:
//  - its response CSP has `sandbox allow-scripts` (an opaque origin even if someone frames or opens it
//    elsewhere: no cookies, storage, bridge or app page), no network, no frames, no forms;
//  - its only script takes one page from its parent (postMessage) and writes it into itself;
//  - the page starts with the desktop's own CSP (cardPage/CARD_CSP, COMPONENT_CSP), which narrows it more.
// The frame keeps sandbox="allow-scripts". Nothing is uploaded or stored; no command is sent.
import { cardPage, COMPONENT_CSP, PANEL_CSP } from "../main/card-page";

export const FRAME_HOST = "frame-host.html";

/** A library component's page (Web/src componentPage) with the desktop's CSP first in its head. */
export function componentHostPage(html: string, panel = false): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${panel ? PANEL_CSP : COMPONENT_CSP}">`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  return head ? html.slice(0, head.index + head[0].length) + meta + html.slice(head.index + head[0].length) : meta + html;
}

/** A Phase 0 card's page (main's cardPage, CARD_CSP). */
export const cardHostPage = (html: string) => cardPage(html);

/** A Phase 0 card's frame on the desktop (main serves it). */
export const desktopCardURL = (botId: string, messageId: string, cardId: string) =>
  `botling-card://card/${encodeURIComponent(botId)}/${encodeURIComponent(messageId)}/${encodeURIComponent(cardId)}`;

const latest = new WeakMap<HTMLIFrameElement, string>();
/** Loads the host into a sandboxed frame and hands it its page once loaded (only the latest page). */
export function showInHost(frame: HTMLIFrameElement, page: string, base = location.href): void {
  if (!latest.has(frame)) {
    frame.addEventListener("load", () => {
      const html = latest.get(frame);
      // An opaque-origin host can only be addressed as "*"; it takes one page, from its parent only.
      if (html !== undefined) frame.contentWindow?.postMessage({ botlingHost: "page", html }, "*");
    });
  }
  latest.set(frame, page);
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("src", new URL(FRAME_HOST, base).href);
}
