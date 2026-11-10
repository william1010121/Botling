// The floating chat's header and corner grip (design B, floating-chat.ts in the shell). The chat is a native view
// over the shell's page, so the shell cannot draw over it: the panel's chrome is drawn here, on top of the chat page,
// whenever the shell says the chat floats (or is docked beside the page, where the header keeps its buttons). Dragging
// the header moves the panel and the bottom right grip resizes it: this page only tells the shell how far the pointer
// went since the drag started (pointer capture keeps the moves coming while the view moves under it), and the shell
// moves the chat's placeholder, which main's view follows. Double-click the header: back to the default corner.
import { overlayOpen } from "./escape-stop";
import { escCollapses } from "../floating-chat";
import type { FloatChromeSpec, FrameMessage } from "./protocol";

const svg = (path: string, size = 14) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const GRAB = `<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="2.5" r="1.3"/><circle cx="7.5" cy="2.5" r="1.3"/><circle cx="2.5" cy="7" r="1.3"/><circle cx="7.5" cy="7" r="1.3"/><circle cx="2.5" cy="11.5" r="1.3"/><circle cx="7.5" cy="11.5" r="1.3"/></svg>`;
/** Dock beside: a window with its right column; float: a small window over a big one. */
const DOCK = svg(`<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M10 3v10"/>`);
const FLOAT = svg(`<rect x="2" y="3" width="12" height="10" rx="2"/><rect x="8" y="8" width="4.5" height="3.5" rx="1" fill="currentColor" stroke="none"/>`);
const COLLAPSE = svg(`<path d="M4 8h8"/>`);

export interface FloatChrome {
  show(spec: FloatChromeSpec | null): void;
  dispose(): void;
}

/**
 * Draws the chrome at the top of `root` (the chat page's body; a test page's box) and the grip at its bottom right;
 * `send` is how it reaches the shell. `running` says whether a reply is being written (Esc then belongs to stopping it).
 */
export function mountFloatChrome(root: HTMLElement, send: (message: FrameMessage) => void, running: () => boolean): FloatChrome {
  let spec: FloatChromeSpec | null = null;
  let header: HTMLElement | null = null;
  let grip: HTMLElement | null = null;

  const drag = (element: HTMLElement, kind: "move" | "resize") => {
    let start: { x: number; y: number; id: number } | null = null;
    let queued: { dx: number; dy: number } | null = null;
    let frame = 0;
    const flush = () => { frame = 0; if (queued) { send({ botling: "floatDrag", kind, phase: "move", ...queued }); queued = null; } };
    element.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || (event.target as Element).closest("button")) return;
      event.preventDefault();
      start = { x: event.screenX, y: event.screenY, id: event.pointerId };
      element.setPointerCapture(event.pointerId);
      element.classList.add("dragging");
      send({ botling: "floatDrag", kind, phase: "start", dx: 0, dy: 0 });
    });
    element.addEventListener("pointermove", (event) => {
      if (!start || event.pointerId !== start.id) return;
      queued = { dx: event.screenX - start.x, dy: event.screenY - start.y };
      if (!frame) frame = requestAnimationFrame(flush);
    });
    const end = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) return;
      cancelAnimationFrame(frame); frame = 0; queued = null;
      const dx = event.screenX - start.x, dy = event.screenY - start.y;
      start = null;
      element.classList.remove("dragging");
      send({ botling: "floatDrag", kind, phase: "end", dx, dy });
    };
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
  };

  const button = (className: string, label: string, icon: string, act: () => void) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = `float-btn ${className}`;
    element.setAttribute("aria-label", label);
    element.title = label;
    element.innerHTML = icon;
    element.addEventListener("click", act);
    return element;
  };

  const build = () => {
    header = document.createElement("header");
    header.className = "float-chrome";
    header.setAttribute("aria-label", "Floating chat");
    header.innerHTML = `<span class="float-grab" aria-hidden="true">${GRAB}</span><img class="float-face" alt=""><span class="float-name"></span><span class="float-status"></span><span class="float-gap"></span>`;
    header.append(
      button("float-dock", "", DOCK, () => send({ botling: "floatAct", act: spec?.docked ? "float" : "dock" })),
      button("float-collapse", "Collapse to the strip (Esc)", COLLAPSE, () => send({ botling: "floatAct", act: "collapse" })),
    );
    header.addEventListener("dblclick", (event) => { if (!(event.target as Element).closest("button") && !spec?.docked) send({ botling: "floatAct", act: "reset" }); });
    drag(header, "move");
    grip = document.createElement("div");
    grip.className = "float-grip";
    grip.setAttribute("aria-hidden", "true");
    grip.title = "Resize";
    drag(grip, "resize");
    root.prepend(header);
    root.append(grip);
  };

  const render = () => {
    if (!spec) { header?.remove(); grip?.remove(); header = grip = null; root.classList.remove("floating-chat", "floating-docked"); return; }
    if (!header || !header.isConnected) build();
    root.classList.add("floating-chat");
    root.classList.toggle("floating-docked", spec.docked);
    const face = header!.querySelector<HTMLImageElement>(".float-face")!;
    if (spec.face) { face.src = spec.face; face.hidden = false; } else face.hidden = true;
    header!.querySelector(".float-name")!.textContent = spec.name;
    const status = header!.querySelector<HTMLElement>(".float-status")!;
    status.textContent = spec.status;
    status.dataset.tone = spec.tone;
    const dock = header!.querySelector<HTMLButtonElement>(".float-dock")!;
    const label = spec.docked ? "Float the chat over the page" : "Dock the chat beside the page";
    dock.setAttribute("aria-label", label);
    dock.title = label;
    dock.innerHTML = spec.docked ? FLOAT : DOCK;
    header!.classList.toggle("docked", spec.docked);
    grip!.hidden = spec.docked;
  };

  // Esc folds it to the strip; one an open menu or list used does not (looked at before anything else sees the key).
  const used = new WeakSet<Event>();
  const early = (event: KeyboardEvent) => { if (event.key === "Escape" && overlayOpen()) used.add(event); };
  const late = (event: KeyboardEvent) => {
    if (!escCollapses(event, { shown: !!spec, running: running(), overlay: used.has(event) })) return;
    event.preventDefault();
    send({ botling: "floatAct", act: "collapse" });
  };
  window.addEventListener("keydown", early, true);
  document.addEventListener("keydown", late);

  return {
    show(next) {
      if (JSON.stringify(next) === JSON.stringify(spec)) return;
      spec = next;
      render();
    },
    dispose() {
      spec = null;
      render();
      window.removeEventListener("keydown", early, true);
      document.removeEventListener("keydown", late);
    },
  };
}
