// The page's answer to `card.page` (M7-07d): a plugin's frame (the Note tab, a settings block, a panel) gets its page made from the plugin's
// web part. On the desktop Electron main serves it (`botling-card://page/<token>`, no such scheme in a browser); on this page the same html
// is drawn in the small host page the server already serves (`frame-host.html`, web-pages.ts: `sandbox allow-scripts` in its response CSP, an opaque
// origin, no network, no frames; its one script takes ONE page from its parent and writes it into itself).
//
//   make(html, panel)  keeps the page under a fresh unguessable token and answers `frame-host.html#ccb-page=<token>` for the frame's `src`;
//   start()            listens (capture phase: a `load` does not bubble) for those frames to finish loading and hands each the page of ITS token,
//                      with the desktop's own CSP first in its head (componentHostPage). A token this page did not make, or a frame that is not
//                      one of the page's own iframes, gets nothing.
//
// Nothing is uploaded or stored; no command is sent. The pages are held in this tab's memory only, the newest `KEPT_PAGES` of them (a frame that
// reloads asks for its page again by the same token; an old one that was dropped shows its host page empty, and its plugin is asked again by the page).
import { componentHostPage, FRAME_HOST } from "../../src/renderer/web-pages";

/** How many pages are held at once (a page is up to 4 MB; the frames of one window are a few dozen at most). */
export const KEPT_PAGES = 32;
const TOKEN = /^[0-9a-f]{32}$/;
const MARK = "ccb-page=";

function newToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The token a frame's `src` names, or null (not one of this module's urls). */
export function tokenOf(src: string | null | undefined, base: string): string | null {
  if (!src) return null;
  let url: URL;
  try { url = new URL(src, base); } catch { return null; }
  const host = new URL(FRAME_HOST, base);
  if (url.origin !== host.origin || url.pathname !== host.pathname || !url.hash.startsWith(`#${MARK}`)) return null;
  const token = url.hash.slice(MARK.length + 1);
  return TOKEN.test(token) ? token : null;
}

export class FramePages {
  private readonly pages = new Map<string, { html: string; panel: boolean }>();
  private off: (() => void) | null = null;

  constructor(private readonly doc: Document, private readonly base: string) {}

  /** The url a frame loads for `html` (`panel`: a plugin panel's page, with the panel CSP). */
  make(html: string, panel = false): string {
    if (typeof html !== "string") throw new TypeError("a page is html text");
    const token = newToken();
    this.pages.set(token, { html, panel });
    // The oldest go first (Map keeps insertion order).
    while (this.pages.size > KEPT_PAGES) this.pages.delete(this.pages.keys().next().value as string);
    return `${new URL(FRAME_HOST, this.base).href}#${MARK}${token}`;
  }

  /** Starts handing pages to the frames made here. Returns the stop. */
  start(): () => void {
    if (this.off) return this.off;
    const onLoad = (event: Event) => {
      const frame = event.target as HTMLIFrameElement | null;
      if (!frame || frame.tagName !== "IFRAME") return;
      const token = tokenOf(frame.getAttribute("src"), this.base);
      const page = token ? this.pages.get(token) : undefined;
      if (!page) return;
      // An opaque-origin host can only be addressed as "*"; it takes one page, from its parent only.
      frame.contentWindow?.postMessage({ botlingHost: "page", html: componentHostPage(page.html, page.panel) }, "*");
    };
    this.doc.addEventListener("load", onLoad, true);
    const stop = () => { this.doc.removeEventListener("load", onLoad, true); this.pages.clear(); if (this.off === stop) this.off = null; };
    this.off = stop;
    return stop;
  }
}
