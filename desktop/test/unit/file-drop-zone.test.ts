// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { watchFileDrops } from "../../../Web/src/drops";

function drag(type: string, target: EventTarget, files: File[] = [], types = ["Files"]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types, files } });
  target.dispatchEvent(event);
  return event;
}

let stop = () => {};
let taken: File[];
beforeEach(() => {
  vi.useFakeTimers();
  document.body.className = "";
  document.body.innerHTML = '<main id="scroller"><div id="messages"></div></main><div class="float-layer"></div><div id="composer-slot"></div>';
  taken = [];
  stop = watchFileDrops(document.body, (file) => taken.push(file));
});
afterEach(() => { stop(); document.head.innerHTML = ""; vi.useRealTimers(); });

// jsdom cannot paint pseudo-elements. Apply the actual cascaded outline declarations to a
// probe so their viewport positioning and stacking can be checked without opening a window.
function outlineStyle() {
  for (const file of ["../../../Web/src/chat.css", "../../src/renderer/chat-frame/frame.css"]) {
    const style = document.createElement("style");
    style.textContent = readFileSync(join(__dirname, file), "utf8");
    document.head.append(style);
  }
  const probe = document.createElement("div");
  for (const sheet of document.styleSheets) {
    for (const rule of sheet.cssRules) {
      if ((rule as CSSStyleRule).selectorText === "body.dropping::after") {
        const declarations = (rule as CSSStyleRule).style;
        // Apply separately: jsdom's inline parser rejects a border shorthand using var().
        for (let i = 0; i < declarations.length; i++) {
          const name = declarations[i];
          probe.style.setProperty(name, declarations.getPropertyValue(name));
        }
      }
    }
  }
  document.body.append(probe);
  return getComputedStyle(probe);
}

describe("desktop file drop outline", () => {
  it("keeps the chat viewport inset and stays visible above floating cards and width handles", () => {
    drag("dragover", document.getElementById("messages")!);
    const outline = outlineStyle();
    expect(outline.position).toBe("fixed");
    expect(outline.inset).toBe("12px");
    expect(outline.pointerEvents).toBe("none");
    const handle = document.createElement("div");
    handle.className = "message-width-handle left";
    document.body.append(handle);
    for (const obstacle of [document.querySelector(".float-layer")!, handle]) {
      expect(Number(outline.zIndex) || 0).toBeGreaterThan(Number(getComputedStyle(obstacle).zIndex));
    }
  });

  it("attaches from both the transcript and composer once, and clears on drop", () => {
    for (const id of ["messages", "composer-slot"]) {
      const target = document.getElementById(id)!;
      expect(drag("dragover", target).defaultPrevented).toBe(true);
      expect(document.body.classList.contains("dropping")).toBe(true);
      const file = new File([id], `${id}.txt`);
      expect(drag("drop", target, [file]).defaultPrevented).toBe(true);
      expect(taken.filter((item) => item === file)).toHaveLength(1);
      expect(document.body.classList.contains("dropping")).toBe(false);
    }
  });

  it("preserves a nested picture target and clears the outline when it consumes the drop", () => {
    const target = document.getElementById("messages")!;
    target.addEventListener("drop", (event) => { event.preventDefault(); event.stopPropagation(); });
    drag("dragover", target);
    drag("drop", target, [new File(["picture"], "picture.png")]);
    expect(taken).toEqual([]);
    expect(document.body.classList.contains("dropping")).toBe(false);
  });

  it("ignores text drags and clears cancelled or abandoned file drags", () => {
    const target = document.getElementById("messages")!;
    expect(drag("dragover", target, [], ["text/plain"]).defaultPrevented).toBe(false);
    expect(document.body.classList.contains("dropping")).toBe(false);
    for (const type of ["dragleave", "dragend", "blur"]) {
      drag("dragover", target);
      (type === "blur" ? window : target).dispatchEvent(new Event(type, { bubbles: true }));
      expect(document.body.classList.contains("dropping")).toBe(false);
    }
    drag("dragover", target);
    vi.runAllTimers();
    expect(document.body.classList.contains("dropping")).toBe(false);
  });
});
