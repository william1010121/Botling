// Copy and paste in the in-app browser pane (2026-11-13, browser-edit.ts): ⌘C/⌘X/⌘V/⌘A/⌘Z pressed in a pane page (a web
// page or a PDF tab) act on that page itself, and its right-click menu has the edit commands. Before, the keys went to
// the app menu's Edit roles, which do not reach the pane's WebContentsView, and a right-click showed nothing.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { editCommandFor, pageMenuItems, wirePageEditing, type EditablePage, type PageMenuParams } from "../../src/main/browser-edit";

type Key = { type?: string; key: string; meta?: boolean; control?: boolean; alt?: boolean; shift?: boolean };
const input = (k: Key) => ({ type: "keyDown", meta: false, control: false, alt: false, shift: false, ...k });

function fakePage() {
  const emitter = new EventEmitter();
  const page = Object.assign(emitter, {
    copy: vi.fn(), cut: vi.fn(), paste: vi.fn(), pasteAndMatchStyle: vi.fn(), selectAll: vi.fn(), undo: vi.fn(), redo: vi.fn(),
    copyImageAt: vi.fn(), isDestroyed: (): boolean => false,
  });
  return page as typeof page & EditablePage;
}
function press(page: EventEmitter, k: Key) {
  const event = { preventDefault: vi.fn() };
  page.emit("before-input-event", event, input(k));
  return event.preventDefault;
}

describe("the edit keys in a pane page", () => {
  it("⌘C/⌘X/⌘V/⌘A/⌘Z/⌘⇧Z/⌘⇧V on macOS run on the page itself, not the app menu", () => {
    const page = fakePage();
    wirePageEditing(page, { platform: "darwin", popup: vi.fn(), writeText: vi.fn() });
    expect(press(page, { key: "c", meta: true })).toHaveBeenCalled();
    expect(page.copy).toHaveBeenCalledTimes(1);
    press(page, { key: "x", meta: true }); expect(page.cut).toHaveBeenCalledTimes(1);
    press(page, { key: "v", meta: true }); expect(page.paste).toHaveBeenCalledTimes(1);
    press(page, { key: "a", meta: true }); expect(page.selectAll).toHaveBeenCalledTimes(1);
    press(page, { key: "z", meta: true }); expect(page.undo).toHaveBeenCalledTimes(1);
    press(page, { key: "Z", meta: true, shift: true }); expect(page.redo).toHaveBeenCalledTimes(1);
    press(page, { key: "V", meta: true, shift: true }); expect(page.pasteAndMatchStyle).toHaveBeenCalledTimes(1);
  });
  it("Ctrl elsewhere; a key up, plain letters, other modifiers and other keys are left alone", () => {
    expect(editCommandFor(input({ key: "c", control: true }), "linux")).toBe("copy");
    expect(editCommandFor(input({ key: "c", control: true }), "darwin")).toBeNull();
    expect(editCommandFor(input({ key: "c", meta: true }), "linux")).toBeNull();
    expect(editCommandFor(input({ key: "c", meta: true, alt: true }), "darwin")).toBeNull();
    expect(editCommandFor(input({ key: "c", meta: true, control: true }), "darwin")).toBeNull();
    expect(editCommandFor(input({ key: "c" }), "darwin")).toBeNull();
    expect(editCommandFor(input({ key: "l", meta: true }), "darwin")).toBeNull();
    expect(editCommandFor(input({ key: "C", meta: true, shift: true }), "darwin")).toBeNull();
    expect(editCommandFor({ ...input({ key: "c", meta: true }), type: "keyUp" }, "darwin")).toBeNull();
    const page = fakePage();
    wirePageEditing(page, { platform: "darwin", popup: vi.fn(), writeText: vi.fn() });
    expect(press(page, { key: "l", meta: true })).not.toHaveBeenCalled();
    expect(press(page, { key: "c" })).not.toHaveBeenCalled();
    expect(page.copy).not.toHaveBeenCalled();
  });
  it("a page already gone takes no command", () => {
    const page = fakePage();
    page.isDestroyed = () => true;
    wirePageEditing(page, { platform: "darwin", popup: vi.fn(), writeText: vi.fn() });
    press(page, { key: "c", meta: true });
    expect(page.copy).not.toHaveBeenCalled();
  });
});

const params = (over: Partial<PageMenuParams> = {}): PageMenuParams => ({
  x: 10, y: 20, isEditable: false, selectionText: "", linkURL: "", hasImageContents: false, mediaType: "none",
  editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: true },
  ...over,
});
const labels = (items: ReturnType<typeof pageMenuItems>) => items.map((item) => item === "separator" ? "-" : `${item.label}${item.enabled ? "" : " (off)"}`);

describe("the right-click menu of a pane page", () => {
  it("selected text: Copy (and Select All)", () => {
    expect(labels(pageMenuItems(params({ selectionText: "hello", editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: true, canPaste: false, canSelectAll: true } }))))
      .toEqual(["Copy", "-", "Select All"]);
  });
  it("a text field: Undo, Redo, Cut, Copy, Paste, Select All by what it allows", () => {
    expect(labels(pageMenuItems(params({ isEditable: true, editFlags: { canUndo: true, canRedo: false, canCut: false, canCopy: false, canPaste: true, canSelectAll: true } }))))
      .toEqual(["Undo", "Redo (off)", "-", "Cut (off)", "Copy (off)", "Paste", "-", "Select All"]);
  });
  it("a link and an image add their own copies", () => {
    expect(labels(pageMenuItems(params({ linkURL: "https://example.com/a", hasImageContents: true, mediaType: "image" }))))
      .toEqual(["Copy Link Address", "Copy Image", "-", "Select All"]);
  });
  it("picking an item runs it on the page", () => {
    const page = fakePage(), writeText = vi.fn();
    let shown: ReturnType<typeof pageMenuItems> = [];
    wirePageEditing(page, { platform: "darwin", popup: (items) => { shown = items; }, writeText });
    page.emit("context-menu", {}, params({ selectionText: "hi", linkURL: "https://example.com/x", hasImageContents: true, mediaType: "image", editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: true, canPaste: false, canSelectAll: true } }));
    const pick = (label: string) => { const item = shown.find((i) => i !== "separator" && i.label === label); if (!item || item === "separator") throw new Error(label); item.run(); };
    pick("Copy"); expect(page.copy).toHaveBeenCalledTimes(1);
    pick("Copy Link Address"); expect(writeText).toHaveBeenCalledWith("https://example.com/x");
    pick("Copy Image"); expect(page.copyImageAt).toHaveBeenCalledWith(10, 20);
    pick("Select All"); expect(page.selectAll).toHaveBeenCalledTimes(1);
  });
});
