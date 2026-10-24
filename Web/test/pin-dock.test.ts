import { beforeEach, describe, expect, it } from "vitest";
import { PinArea } from "../src/pins";
import type { ChatState, PinView } from "../src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const pins: PinView[] = ["CPU 24%", "426/494 GB", "Memory 80%", "Today: Claude…", "botling · use…"].map((text, index) => ({
  id: `P${index}`, name: `Status ${index}`, headline: text, chip: { text, tone: "neutral" },
  size: "2x2", refresh: "manual", minutes: 15, display: { name: `Status ${index}`, data: "{}" },
}));
const state = (items = pins): ChatState => ({
  botID: "status-strip", botName: "botling", messages: [], working: false, avatar: "", placeholder: "",
  replyingTo: null, pendingFiles: [], components: {}, pins: items,
  pinChoices: [{ name: "New status", uses: 1, pinned: false, command: null }],
});
let area: PinArea;
beforeEach(() => {
  document.body.innerHTML = '<div id="pin-area"></div><section id="board"></section>';
  area = new PinArea(document.querySelector("#pin-area")!, document.querySelector("#board")!);
  area.update(state());
});

describe("the status strip keeps its add control beside overflowing pins", () => {
  it("puts all pins in a separate scroll region, followed by the native add button", () => {
    const dock = document.querySelector('[role="toolbar"]')!;
    const list = dock.querySelector(".pin-chip-list")!;
    expect(list).not.toBeNull();
    expect([...list.querySelectorAll<HTMLElement>(".pin-chip")].map(chip => chip.dataset.id)).toEqual(pins.map(pin => pin.id));
    const add = dock.querySelector<HTMLButtonElement>(":scope > .pin-chip.add")!;
    expect(list.nextElementSibling).toBe(add);
    expect(add.tagName).toBe("BUTTON");
    expect(add.disabled).toBe(false);
    expect(add.tabIndex).toBe(0);
    add.click();
    expect(document.querySelector(".pin-picker-row")?.textContent).toContain("New status");
  });

  it("keeps the scrolled position and keyboard target through a live status update", () => {
    const list = document.querySelector<HTMLElement>(".pin-chip-list")!;
    expect(list).not.toBeNull();
    list.scrollLeft = 150;
    list.querySelector<HTMLButtonElement>('[data-id="P4"]')!.focus();
    area.update(state(pins.map(pin => ({ ...pin, headline: pin.headline + " updated" }))));
    expect(document.querySelector<HTMLElement>(".pin-chip-list")!.scrollLeft).toBe(150);
    expect((document.activeElement as HTMLElement).dataset.id).toBe("P4");
  });

  it("keeps keyboard focus on the pin when opening and closing its sheet", () => {
    document.querySelector<HTMLButtonElement>('[data-id="P4"]')!.focus();
    (document.activeElement as HTMLButtonElement).click();
    expect((document.activeElement as HTMLElement).dataset.id).toBe("P4");
    expect(document.activeElement?.getAttribute("aria-expanded")).toBe("true");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect((document.activeElement as HTMLElement).dataset.id).toBe("P4");
    expect(document.activeElement?.getAttribute("aria-expanded")).toBe("false");
  });
});
