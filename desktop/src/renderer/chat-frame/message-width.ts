import { MESSAGE_WIDTH_DEFAULT, MESSAGE_WIDTH_MIN, MESSAGE_WIDTH_MAX, messageWidth } from "../../contract/message-width";

/** Desktop-only controls; Web/src and the 1.x chat surface stay unchanged. */
export function installMessageWidth(save: (value: number | null) => void, dragging: (active: boolean) => void) {
  let chosen: number | null = null;
  let chatId: string | null = null;
  let drag: { pointer: number; x: number; width: number; side: number; handle: HTMLElement; before: number | null } | null = null;
  const handles: HTMLElement[] = [];
  const paint = (value: number | null) => {
    document.documentElement.style.setProperty("--message-column-width", `${value ?? MESSAGE_WIDTH_DEFAULT}px`);
    for (const handle of handles) handle.setAttribute("aria-valuenow", String(value ?? MESSAGE_WIDTH_DEFAULT));
  };
  const commit = (value: number | null) => { chosen = value; paint(value); save(value); };
  const cancel = () => {
    const active = drag;
    if (!active) return;
    drag = null;
    document.body.classList.remove("resizing-message-column");
    dragging(false);
    paint(active.before);
    if (active.handle.hasPointerCapture(active.pointer)) active.handle.releasePointerCapture(active.pointer);
  };
  const reset = () => { cancel(); commit(null); };
  const move = (pointer: number, x: number) => {
    if (!drag || drag.pointer !== pointer) return;
    // Both edges move equally around the column's centre. Start from the rendered width,
    // so a saved wide column in a smaller window responds immediately to an inward drag.
    const available = document.documentElement.clientWidth;
    const width = Math.min(Math.max(MESSAGE_WIDTH_MIN, available), drag.width + 2 * drag.side * (x - drag.x));
    paint(messageWidth(width));
  };
  const up = (pointer: number, x: number) => {
    if (!drag || drag.pointer !== pointer) return;
    move(pointer, x);
    const moved = Math.abs(x - drag.x) >= 2;
    const width = messageWidth(parseFloat(document.documentElement.style.getPropertyValue("--message-column-width")));
    cancel();
    if (moved) commit(width);
  };
  for (const [edge, side] of [["left", -1], ["right", 1]] as const) {
    const handle = document.createElement("div");
    handle.className = `message-width-handle ${edge}`;
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-label", `Resize message column from ${edge}`);
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-valuemin", String(MESSAGE_WIDTH_MIN));
    handle.setAttribute("aria-valuemax", String(MESSAGE_WIDTH_MAX));
    handle.title = "Drag to resize message column. Double-click to reset.";
    handle.addEventListener("dblclick", reset);
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      // The second click belongs to a double-click reset, never another resize.
      if (event.detail > 1) return;
      cancel();
      handle.focus({ preventScroll: true });
      const width = document.getElementById("messages")!.getBoundingClientRect().width;
      drag = { pointer: event.pointerId, x: event.clientX, width, side, handle, before: chosen };
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add("resizing-message-column");
      dragging(true);
    });
    handle.addEventListener("pointermove", (event) => move(event.pointerId, event.clientX));
    handle.addEventListener("pointerup", (event) => up(event.pointerId, event.clientX));
    handle.addEventListener("pointercancel", cancel);
    handle.addEventListener("lostpointercapture", cancel);
    handle.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); reset(); return; }
      const width = Math.min(chosen ?? MESSAGE_WIDTH_DEFAULT, document.documentElement.clientWidth);
      const next = event.key === "Home" ? MESSAGE_WIDTH_MIN : event.key === "End" ? MESSAGE_WIDTH_MAX
        : event.key === "ArrowLeft" ? width - side * 20 : event.key === "ArrowRight" ? width + side * 20 : null;
      if (next !== null) { event.preventDefault(); cancel(); commit(messageWidth(next)); }
    });
    handles.push(handle);
    document.body.append(handle);
  }
  window.addEventListener("keydown", (event) => { if (event.key === "Escape" && drag) { event.preventDefault(); cancel(); } }, true);
  window.addEventListener("blur", cancel);
  window.addEventListener("resize", cancel);
  paint(null);
  return {
    pointer(kind: "move" | "up" | "cancel", pointer: number, x: number) {
      if (kind === "cancel") cancel();
      else if (kind === "move") move(pointer, x);
      else up(pointer, x);
    },
    set(value: number | null, id: string) {
      if (chatId !== id) cancel();
      chatId = id;
      if (!drag) { chosen = messageWidth(value); paint(chosen); }
    },
  };
}
