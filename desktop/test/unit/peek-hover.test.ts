// The status card's hover timing (peek-hover.ts), with fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PEEK_CLOSE_GRACE_MS, PEEK_OPEN_DELAY_MS, peekHover } from "../../src/renderer/peek-hover";

const at = { top: 100, right: 248 };
let log: string[];
const make = () => peekHover({ onOpen: (id) => log.push(`open ${id}`), onClose: () => log.push("close") });

beforeEach(() => { vi.useFakeTimers(); log = []; });
afterEach(() => { vi.useRealTimers(); });

describe("the status card on hover", () => {
  it("opens after about 250 ms on a row, not before", () => {
    const hover = make();
    hover.enterRow("a", () => at);
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS - 1);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(["open a"]);
    expect(hover.shown()).toBe("a");
  });
  it("sweeping over the list flashes no card", () => {
    const hover = make();
    for (const id of ["a", "b", "c"]) { hover.enterRow(id, () => at); vi.advanceTimersByTime(80); hover.leaveRow(); }
    vi.advanceTimersByTime(1_000);
    expect(log).toEqual([]);
  });
  it("stays open while the pointer crosses from the row into the card, and closes after leaving both", () => {
    const hover = make();
    hover.enterRow("a", () => at);
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS);
    hover.leaveRow();
    vi.advanceTimersByTime(PEEK_CLOSE_GRACE_MS - 10);
    hover.enterCard();
    vi.advanceTimersByTime(1_000);
    expect(log).toEqual(["open a"]);
    hover.leaveCard();
    vi.advanceTimersByTime(PEEK_CLOSE_GRACE_MS - 1);
    expect(log).toEqual(["open a"]);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(["open a", "close"]);
    expect(hover.shown()).toBeNull();
  });
  it("coming back to the row from the card keeps it open (no second open)", () => {
    const hover = make();
    hover.enterRow("a", () => at);
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS);
    hover.leaveCard();
    hover.enterRow("a", () => at);
    vi.advanceTimersByTime(1_000);
    expect(log).toEqual(["open a"]);
  });
  it("one card at a time: hovering another bot switches to its card, without a gap", () => {
    const hover = make();
    hover.enterRow("a", () => at);
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS);
    hover.leaveRow();
    hover.enterRow("b", () => ({ top: 160, right: 248 }));
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS - 1);
    expect(hover.shown()).toBe("a");
    vi.advanceTimersByTime(1);
    expect(log).toEqual(["open a", "open b"]);
    expect(hover.shown()).toBe("b");
  });
  it("the anchor is read when the card opens (the row may have moved)", () => {
    const anchors: unknown[] = [];
    const hover = peekHover({ onOpen: (_id, anchor) => anchors.push(anchor), onClose() {} });
    let top = 100;
    hover.enterRow("a", () => ({ top, right: 248 }));
    top = 140;
    vi.advanceTimersByTime(PEEK_OPEN_DELAY_MS);
    expect(anchors).toEqual([{ top: 140, right: 248 }]);
  });
  it("keyboard focus (or a tap) opens at once; Escape closes at once and drops anything pending", () => {
    const hover = make();
    hover.openNow("a", at);
    expect(log).toEqual(["open a"]);
    hover.openNow("a", at);
    expect(log).toEqual(["open a"]);
    hover.enterRow("b", () => at);
    hover.close();
    vi.advanceTimersByTime(1_000);
    expect(log).toEqual(["open a", "close"]);
    hover.close();
    expect(log).toEqual(["open a", "close"]);
  });
});
