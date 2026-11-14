import { describe, expect, it } from "vitest";
import { swapKeepingMedia } from "../src/media-keep";

// The helper the chat page draws a row again with (media-keep.ts): the row's videos and sounds stay the very elements.
const VIDEO = "botling-chat://chat/attachment/b1/AAAA/demo-video.mp4?line=m1";

describe("swapKeepingMedia", () => {
  const row = (html: string) => { const div = document.createElement("div"); div.className = "row bot"; div.innerHTML = html; return div; };

  it("moves the kept element with moveBefore where the page has it (an atomic move: a playing video plays on)", () => {
    const list = document.createElement("div");
    document.body.append(list);
    const old = row(`<p>a</p><video class="media" src="${VIDEO}" controls preload="metadata"></video>`);
    list.append(old);
    const kept = old.querySelector("video")!;
    const moves: Node[] = [];
    const proto = Element.prototype as unknown as { moveBefore?: (node: Node, child: Node | null) => void };
    proto.moveBefore = function (this: Element, node: Node, child: Node | null) { moves.push(node); this.insertBefore(node, child); };
    try {
      const fresh = row(`<p>a b</p><video class="media" src="${VIDEO}" controls preload="metadata" aria-label="demo"></video>`);
      swapKeepingMedia(old, fresh);
      expect(list.children).toHaveLength(1);
      expect(list.firstElementChild).toBe(fresh);
      expect(fresh.querySelector("video")).toBe(kept);
      expect(moves).toEqual([kept]);
      expect(kept.getAttribute("aria-label")).toBe("demo");
      expect(kept.getAttribute("preload")).toBe("metadata");
    } finally {
      delete proto.moveBefore;
      list.remove();
    }
  });

  it("without moveBefore, plays a kept video that was playing again after the move", async () => {
    const list = document.createElement("div");
    document.body.append(list);
    const old = row(`<video class="media" src="${VIDEO}"></video>`);
    list.append(old);
    const kept = old.querySelector("video")!;
    let played = 0;
    Object.defineProperty(kept, "paused", { configurable: true, get: () => false });
    Object.defineProperty(kept, "play", { configurable: true, value: () => { played += 1; return Promise.resolve(); } });
    swapKeepingMedia(old, row(`<p>more</p><video class="media" src="${VIDEO}"></video>`));
    await Promise.resolve(); await Promise.resolve();
    expect(list.querySelector("video")).toBe(kept);
    expect(played).toBe(1);
    list.remove();
  });
});
