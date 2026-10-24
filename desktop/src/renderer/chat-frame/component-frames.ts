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
import { APP_ORIGIN, type FrameMessage, type ShellMessage } from "./protocol";

const origin = APP_ORIGIN;
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
    window.parent.postMessage(message, origin);
  });
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window.parent || event.origin !== origin) return;
  const message = event.data as ShellMessage | null;
  if (message?.botling !== "page") return;
  const resolve = waiting.get(message.id);
  if (!resolve) return;
  waiting.delete(message.id);
  resolve(message.url);
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
