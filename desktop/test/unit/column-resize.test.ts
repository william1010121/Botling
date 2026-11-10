// The window's column dividers (column-resize.ts): limits, the chat's minimum, what is remembered, and the reset.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clampWidth, COLUMNS, dragWidth, HANDLE, loadWidth, MIN_CHAT, roomFor, saveWidth } from "../../src/renderer/column-resize";
import { desktop } from "../helpers";

const memory = () => {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
};

describe("clampWidth", () => {
  it("keeps each column inside its own limits", () => {
    expect(clampWidth(COLUMNS.rail, 100)).toBe(COLUMNS.rail.min);
    expect(clampWidth(COLUMNS.rail, 9999)).toBe(COLUMNS.rail.max);
    expect(clampWidth(COLUMNS.right, 300.4)).toBe(300);
    expect(clampWidth(COLUMNS.browser, 200)).toBe(320);
  });
  it("never takes the chat under its minimum, but never goes under the column's own minimum either", () => {
    // Rail 248 wide, chat 500 wide: the rail may take 140 more.
    const room = roomFor(248, 500);
    expect(room).toBe(248 + 500 - MIN_CHAT);
    expect(clampWidth(COLUMNS.rail, 420, room)).toBe(388);
    // The chat already at its minimum: the column cannot grow, and shrinking still works.
    expect(roomFor(300, MIN_CHAT - 20)).toBe(300);
    expect(clampWidth(COLUMNS.browser, 500, roomFor(400, MIN_CHAT))).toBe(400);
    expect(clampWidth(COLUMNS.browser, 350, roomFor(400, MIN_CHAT))).toBe(350);
    expect(clampWidth(COLUMNS.right, 260, 100)).toBe(COLUMNS.right.min);
  });
});

describe("the Note's docked chat", () => {
  it("is a right column inside the chat pane, its room coming from the Note's minimum", () => {
    const spec = COLUMNS.noteChat;
    expect(spec.side).toBe("right");
    expect(spec.within?.min).toBe(320);
    // Note 500 wide, chat 380: the chat may take 180 more.
    expect(clampWidth(spec, 1000, roomFor(380, 500, spec.within!.min))).toBe(560);
    expect(dragWidth(spec, 380, 900, 800)).toBe(480);
    expect(dragWidth(spec, 380, 900, 1200)).toBe(spec.min);
  });
});

describe("dragWidth", () => {
  it("grows a left column as the pointer moves right, and a right column as it moves left", () => {
    expect(dragWidth(COLUMNS.rail, 248, 248, 300)).toBe(300);
    expect(dragWidth(COLUMNS.right, 272, 1000, 950)).toBe(322);
    expect(dragWidth(COLUMNS.browser, 500, 700, 760)).toBe(440);
  });
  it("clamps while dragging past the limits or the chat's minimum", () => {
    expect(dragWidth(COLUMNS.rail, 248, 248, 0)).toBe(200);
    expect(dragWidth(COLUMNS.rail, 248, 248, 2000)).toBe(420);
    expect(dragWidth(COLUMNS.browser, 500, 700, 0, roomFor(500, 600))).toBe(740);
  });
});

describe("remembered widths", () => {
  it("saves, loads and forgets (the double click's reset) per divider", () => {
    const store = memory();
    expect(loadWidth(COLUMNS.rail, store)).toBeNull();
    saveWidth(COLUMNS.rail, 301.6, store);
    saveWidth(COLUMNS.right, 333, store);
    expect(loadWidth(COLUMNS.rail, store)).toBe(302);
    expect(loadWidth(COLUMNS.right, store)).toBe(333);
    expect(loadWidth(COLUMNS.browser, store)).toBeNull();
    saveWidth(COLUMNS.rail, null, store);
    expect(loadWidth(COLUMNS.rail, store)).toBeNull();
    expect(loadWidth(COLUMNS.right, store)).toBe(333);
  });
  it("keeps the browser pane's width saved before the dividers existed", () => {
    const store = memory();
    store.setItem("botling.browserPaneWidth", "640");
    expect(loadWidth(COLUMNS.browser, store)).toBe(640);
  });
  it("ignores junk, a too-small value, and clamps a too-large one; a refusing storage is harmless", () => {
    const store = memory();
    store.setItem(COLUMNS.rail.key, "wide");
    expect(loadWidth(COLUMNS.rail, store)).toBeNull();
    store.setItem(COLUMNS.rail.key, "50");
    expect(loadWidth(COLUMNS.rail, store)).toBeNull();
    store.setItem(COLUMNS.rail.key, "5000");
    expect(loadWidth(COLUMNS.rail, store)).toBe(COLUMNS.rail.max);
    const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    expect(loadWidth(COLUMNS.rail, refusing)).toBeNull();
    expect(() => saveWidth(COLUMNS.rail, 300, refusing)).not.toThrow();
    expect(() => saveWidth(COLUMNS.rail, null, null)).not.toThrow();
  });
});

describe("the stylesheet agrees", () => {
  const css = readFileSync(join(desktop, "src/renderer/styles.css"), "utf8");
  it("sizes each column with its variable, falling back to the default width", () => {
    expect(css).toContain(`.rail { width: var(${COLUMNS.rail.cssVar}, ${COLUMNS.rail.fallback}px);`);
    expect(css).toContain(`.shell > .detail-panel { width: var(${COLUMNS.right.cssVar}, ${COLUMNS.right.fallback}px); }`);
    expect(css).toContain(`.browser-pane { position: relative; flex: 0 1 var(${COLUMNS.browser.cssVar}, 50%);`);
    expect(css).toContain(`min-width: ${COLUMNS.browser.min}px`);
  });
  it("sizes the Note's docked chat with its variable, and keeps the Note its minimum", () => {
    expect(css).toContain(`flex: 0 0 var(${COLUMNS.noteChat.cssVar}, ${COLUMNS.noteChat.fallback}px)`);
    expect(css).toContain(`max-width: calc(100% - ${COLUMNS.noteChat.within!.min}px)`);
    expect(css).toContain('.col-handle[data-column="noteChat"]::before');
  });
  it("insets the browser's page by the handle's width", () => {
    expect(css).toContain(`.browser-pane:not(.full) > .bp-body { padding-left: ${HANDLE}px; }`);
    expect(css).toContain(`width: ${HANDLE + 1}px; cursor: col-resize;`);
  });
});
