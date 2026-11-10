// The floating chat (floating-chat.ts, design B): a thin strip in a corner that opens into a panel you drag by its
// header, resize from its corner and that snaps to the corners; Esc collapses it; each place (Note, browser, report
// preview) remembers its own panel, strip corner and whether it is docked beside instead.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_H, DEFAULT_W, MARGIN, MIN_H, MIN_W, SNAP,
  chatMode, clampRect, defaultMemory, dragPanel, escCollapses, lastLine, nearestCorner, panelIn, readMemory,
  resizePanel, snapRect, stripBox, toggleDocked, withCorner, withPanel,
} from "../../src/renderer/floating-chat";

const area = { width: 1200, height: 800 };

describe("collapse and expand", () => {
  it("is the strip while closed, whatever the place remembers", () => {
    const memory = defaultMemory();
    expect(chatMode(false, memory.note)).toBe("collapsed");
    expect(chatMode(false, { ...memory.note, docked: true })).toBe("collapsed");
  });
  it("opens as the floating panel, or docked beside when the place was switched to that", () => {
    const memory = defaultMemory();
    expect(chatMode(true, memory.note)).toBe("floating");
    expect(chatMode(true, toggleDocked(memory, "note").note)).toBe("docked");
  });
  it("Esc collapses while the chrome shows, unless a reply is written, something open uses it, or a modifier is held", () => {
    const key = { key: "Escape" };
    expect(escCollapses(key, { shown: true, running: false, overlay: false })).toBe(true);
    expect(escCollapses(key, { shown: false, running: false, overlay: false })).toBe(false);
    expect(escCollapses(key, { shown: true, running: true, overlay: false })).toBe(false);
    expect(escCollapses(key, { shown: true, running: false, overlay: true })).toBe(false);
    expect(escCollapses({ key: "Escape", defaultPrevented: true }, { shown: true, running: false, overlay: false })).toBe(false);
    expect(escCollapses({ key: "Escape", isComposing: true }, { shown: true, running: false, overlay: false })).toBe(false);
    expect(escCollapses({ key: "Escape", metaKey: true }, { shown: true, running: false, overlay: false })).toBe(false);
    expect(escCollapses({ key: "Enter" }, { shown: true, running: false, overlay: false })).toBe(false);
  });
});

describe("the panel's place", () => {
  it("starts at the bottom right corner, inside the margin, at the default size", () => {
    expect(panelIn(defaultMemory().note, area)).toEqual({ x: 1200 - MARGIN - DEFAULT_W, y: 800 - MARGIN - DEFAULT_H, w: DEFAULT_W, h: DEFAULT_H });
  });
  it("shrinks the default to fit a small area", () => {
    const small = { width: 360, height: 300 };
    const rect = panelIn(defaultMemory().note, small);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(360);
    expect(rect.y + rect.h).toBeLessThanOrEqual(300);
  });
  it("is pulled back inside when the window got smaller since", () => {
    const rect = clampRect({ x: 1000, y: 700, w: 400, h: 500 }, { width: 900, height: 600 });
    expect(rect).toEqual({ x: 500, y: 100, w: 400, h: 500 });
  });
  it("drags with the pointer and never leaves the area", () => {
    const start = { x: 100, y: 100, w: 380, h: 520 };
    expect(dragPanel(start, 50, -20, area)).toEqual({ x: 150, y: 80, w: 380, h: 520 });
    expect(dragPanel(start, -500, -500, area)).toEqual({ x: 0, y: 0, w: 380, h: 520 });
    expect(dragPanel(start, 5000, 5000, area)).toEqual({ x: 1200 - 380, y: 800 - 520, w: 380, h: 520 });
  });
  it("resizes from its corner, not under the smallest size nor past the area", () => {
    const start = { x: 100, y: 100, w: 380, h: 520 };
    expect(resizePanel(start, 40, 30, area)).toEqual({ x: 100, y: 100, w: 420, h: 550 });
    expect(resizePanel(start, -1000, -1000, area)).toEqual({ x: 100, y: 100, w: MIN_W, h: MIN_H });
    expect(resizePanel(start, 5000, 5000, area)).toEqual({ x: 100, y: 100, w: 1100, h: 700 });
  });
});

describe("snapping to the corners", () => {
  it("snaps into a corner dropped near it", () => {
    const w = 380, h = 520;
    expect(snapRect({ x: 5, y: 10, w, h }, area)).toEqual({ x: MARGIN, y: MARGIN, w, h });
    expect(snapRect({ x: 1200 - w - 4, y: 800 - h - SNAP + MARGIN + 1, w, h }, area)).toEqual({ x: 1200 - w - MARGIN, y: 800 - h - MARGIN, w, h });
    expect(snapRect({ x: 1200 - w, y: 0, w, h }, area)).toEqual({ x: 1200 - w - MARGIN, y: MARGIN, w, h });
    expect(snapRect({ x: 0, y: 800 - h, w, h }, area)).toEqual({ x: MARGIN, y: 800 - h - MARGIN, w, h });
  });
  it("leaves it where it was dropped away from the corners (an edge alone does not snap)", () => {
    const middle = { x: 400, y: 120, w: 380, h: 520 };
    expect(snapRect(middle, area)).toEqual(middle);
    expect(snapRect({ x: 2, y: 140, w: 380, h: 520 }, area)).toEqual({ x: 2, y: 140, w: 380, h: 520 });
  });
  it("puts the strip in the corner nearest where it was dropped", () => {
    expect(nearestCorner({ x: 10, y: 10 }, area)).toBe("tl");
    expect(nearestCorner({ x: 1100, y: 20 }, area)).toBe("tr");
    expect(nearestCorner({ x: 30, y: 700 }, area)).toBe("bl");
    expect(nearestCorner({ x: 900, y: 600 }, area)).toBe("br");
  });
  it("the strip's box sits in its corner inside the margin", () => {
    expect(stripBox("br", { w: 300, h: 44 }, area)).toEqual({ x: 1200 - MARGIN - 300, y: 800 - MARGIN - 44 });
    expect(stripBox("tl", { w: 300, h: 44 }, area)).toEqual({ x: MARGIN, y: MARGIN });
  });
});

describe("each place remembers its own", () => {
  it("panel, strip corner and dock choice, apart from the others", () => {
    let memory = defaultMemory();
    memory = withPanel(memory, "note", { x: 10, y: 20, w: 400, h: 500 });
    memory = withCorner(memory, "preview", "tr");
    memory = toggleDocked(memory, "browser");
    expect(memory.note).toEqual({ panel: { x: 10, y: 20, w: 400, h: 500 }, corner: "br", docked: false });
    expect(memory.preview).toEqual({ panel: null, corner: "tr", docked: false });
    expect(memory.browser).toEqual({ panel: null, corner: "br", docked: true });
    expect(toggleDocked(memory, "browser").browser.docked).toBe(false);
  });
  it("comes back from what was saved, and anything unreadable falls back to the defaults per place", () => {
    const saved = withCorner(withPanel(defaultMemory(), "note", { x: 1, y: 2, w: 333, h: 444 }), "browser", "tl");
    expect(readMemory(JSON.stringify(saved))).toEqual(saved);
    expect(readMemory(null)).toEqual(defaultMemory());
    expect(readMemory("{oops")).toEqual(defaultMemory());
    const mixed = readMemory(JSON.stringify({ note: { panel: { x: "a" }, corner: "zz", docked: "yes" }, preview: { panel: { x: 5, y: 6, w: 320, h: 300 }, corner: "bl", docked: true } }));
    expect(mixed.note).toEqual(defaultMemory().note);
    expect(mixed.preview).toEqual({ panel: { x: 5, y: 6, w: 320, h: 300 }, corner: "bl", docked: true });
    expect(mixed.browser).toEqual(defaultMemory().browser);
  });
});

describe("the strip's line", () => {
  it("is the bot's newest line, on one line, Markdown marks dropped", () => {
    const messages = [
      { role: "bot", text: "older" },
      { role: "bot", text: "**好的**，我把 `2.6.0` 那段\n改成條列了" },
      { role: "user", text: "thanks" },
    ];
    expect(lastLine(messages)).toBe("好的，我把 2.6.0 那段 改成條列了");
    expect(lastLine([{ role: "user", text: "hi" }])).toBe("");
    expect(lastLine([{ role: "bot", text: "x".repeat(300) }]).length).toBeLessThanOrEqual(120);
  });
});
