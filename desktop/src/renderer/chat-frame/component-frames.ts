// Component frames for the reused chat page. Web/src draws each library component in an
// `<iframe sandbox="allow-scripts" srcdoc=…>` holding its template and the `ccb` runtime
// (components.ts `componentPage`). A srcdoc frame inherits the chat page's CSP, which allows no
// inline script, so here such a page is handed to main instead (`card.page`, through the app
// page), which serves it from `botling-card://page/<token>` under its own strict CSP; the frame
// stays sandboxed (opaque origin, no storage, no bridge, no network). Web/src's own listener in
// the chat page still finds the frame by its window and handles every `ccb` call, as in 1.x;
// what it posts goes through the app page and the core, which decide what it may do.
//
// Frames without scripts (`sandbox=""`, the Catch-up source snapshots) keep their srcdoc.
import { type FrameMessage } from "./protocol";
import { toShell, fromShell, nativeChat } from "./transport";

const native = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc")!;
let next = 0;
const waiting = new Map<number, (url: string | null) => void>();
const pageOf = new WeakMap<HTMLIFrameElement, string>();

/** Pages handed over so far (for tests). */
export const handed = { count: 0 };

function page(html: string): Promise<string | null> {
  const id = ++next;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    const message: FrameMessage = { botling: "page", id, html };
    if (!toShell(message)) { waiting.delete(id); resolve(null); }
  });
}

fromShell(message => {
  if (message?.botling !== "page") return;
  const resolve = waiting.get(message.id);
  if (!resolve) return;
  waiting.delete(message.id);
  resolve(message.url);
});

nativeChat?.subscribe(packet => {
  if ("unbound" in packet) { for (const resolve of waiting.values()) resolve(null); waiting.clear(); }
});

Object.defineProperty(HTMLIFrameElement.prototype, "srcdoc", {
  configurable: true,
  enumerable: native.enumerable,
  get(this: HTMLIFrameElement) {
    return pageOf.get(this) ?? native.get!.call(this);
  },
  set(this: HTMLIFrameElement, html: string) {
    const sandbox = this.getAttribute("sandbox") ?? "";
    if (!sandbox.split(/\s+/).includes("allow-scripts")) {
      native.set!.call(this, html);
      return;
    }
    const value = String(html);
    pageOf.set(this, value);
    handed.count++;
    void page(value).then((url) => {
      // Only the latest page this frame was given.
      if (!url || pageOf.get(this) !== value) return;
      this.setAttribute("src", url);
    });
  },
});

// A component frame is a page of its own (another process): the pointer over it does not make the chat page's
// holder around it :hover, so a hover bar over a frame (a preview card's "Make into component", a pinned card's
// tools) would never show. The component page says when the pointer enters and leaves it (`ccb: "hover"`): the
// holder gets `.hovered` then, which frame.css treats as :hover (Phase 5c).
window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as { ccb?: unknown; on?: unknown } | null;
  if (!data || data.ccb !== "hover") return;
  for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe.component-frame")) {
    if (frame.contentWindow !== event.source) continue;
    frame.closest(".preview-holder, .pin-holder")?.classList.toggle("hovered", data.on === true);
  }
});
