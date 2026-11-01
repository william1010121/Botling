// @vitest-environment jsdom
// Dragging the chat's message column edges (installMessageWidth): with the left column folded or the window
// zoomed out the chat is wider than the old 1200 px cap, and the column must still grow to fill it.
// jsdom only: no window, no focus taken.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMessageWidth } from "../../src/renderer/chat-frame/message-width";
import { MESSAGE_WIDTH_MAX } from "../../src/contract/message-width";

function pointer(type: string, x: number, init: { detail?: number } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0, detail: init.detail ?? 1 });
  Object.assign(event, { pointerId: 1, isPrimary: true });
  return event;
}

describe("message column drag", () => {
  let viewWidth = 2000;
  let saved: (number | null)[];
  let column: ReturnType<typeof installMessageWidth>;
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
    document.body.innerHTML = '<div id="messages"></div>';
    vi.spyOn(document.documentElement, "clientWidth", "get").mockImplementation(() => viewWidth);
    vi.spyOn(document.getElementById("messages")!, "getBoundingClientRect").mockImplementation(() => {
      const width = Math.min(viewWidth, parseFloat(document.documentElement.style.getPropertyValue("--message-column-width")));
      return { width } as DOMRect;
    });
    Object.assign(HTMLElement.prototype, { setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false });
    saved = [];
    column = installMessageWidth((value) => saved.push(value), () => {});
  });
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });
  const handle = (edge: "left" | "right") => document.querySelector<HTMLElement>(`.message-width-handle.${edge}`)!;
  const width = () => parseFloat(document.documentElement.style.getPropertyValue("--message-column-width"));
  const drag = (edge: "left" | "right", from: number, to: number) => {
    handle(edge).dispatchEvent(pointer("pointerdown", from));
    handle(edge).dispatchEvent(pointer("pointermove", to));
    handle(edge).dispatchEvent(pointer("pointerup", to));
  };

  it("a column saved at 1200 px grows past it when the chat is wider", () => {
    viewWidth = 2000;
    column.set(1200, "chat");
    expect(width()).toBe(1200);
    drag("right", 1600, 1800);
    expect(width()).toBe(1600);
    expect(saved).toEqual([1600]);
    drag("left", 200, 0);
    expect(width()).toBe(2000);
    expect(saved).toEqual([1600, 2000]);
  });

  it("still stops at the chat's own width, and the saved setting comes back as is", () => {
    viewWidth = 1500;
    column.set(1200, "chat");
    drag("right", 1350, 1900);
    expect(width()).toBe(1500);
    column.set(1500, "chat");
    expect(width()).toBe(1500);
    expect(MESSAGE_WIDTH_MAX).toBeGreaterThanOrEqual(2000);
  });
});
