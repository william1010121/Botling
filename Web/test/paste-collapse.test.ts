import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sent } from "../src/bridge";
import { Composer } from "../src/composer";
import { countLines, pasteLimits, shouldCollapse, splitPasted, withPasted } from "../src/paste-collapse";
import type { ChatState } from "../src/types";

const limits = { chars: 1000, lines: 15 };

describe("shouldCollapse", () => {
  it("collapses over 1000 characters or over 15 lines, not at the limit", () => {
    expect(shouldCollapse("a".repeat(1000), limits)).toBe(false);
    expect(shouldCollapse("a".repeat(1001), limits)).toBe(true);
    expect(shouldCollapse(Array(15).fill("x").join("\n"), limits)).toBe(false);
    expect(shouldCollapse(Array(16).fill("x").join("\n"), limits)).toBe(true);
  });
  it("0 turns a condition off", () => {
    expect(shouldCollapse("a".repeat(5000), { chars: 0, lines: 15 })).toBe(false);
    expect(shouldCollapse(Array(40).fill("x").join("\n"), { chars: 1000, lines: 0 })).toBe(false);
    expect(shouldCollapse("a".repeat(5000), { chars: 0, lines: 0 })).toBe(false);
  });
  it("counts lines without a final line break, with CRLF", () => {
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\r\nb\r\nc")).toBe(3);
    expect(countLines("")).toBe(0);
  });
  it("limits default when absent or invalid", () => {
    expect(pasteLimits({})).toEqual(limits);
    expect(pasteLimits({ pasteCollapseChars: 0, pasteCollapseLines: 30 })).toEqual({ chars: 0, lines: 30 });
    expect(pasteLimits({ pasteCollapseChars: -1, pasteCollapseLines: NaN })).toEqual(limits);
  });
});

describe("withPasted / splitPasted", () => {
  it("round-trips, with or without words", () => {
    const pasted = "one\n\ntwo\nthree";
    expect(splitPasted(withPasted("look at this", pasted))).toEqual({ text: "look at this", pasted });
    expect(splitPasted(withPasted("", pasted))).toEqual({ text: "", pasted });
    expect(withPasted("hi", null)).toBe("hi");
    expect(splitPasted("plain")).toEqual({ text: "plain", pasted: null });
  });
  it("gives the bot every character", () => {
    expect(withPasted("why?", "LOG LINE")).toContain("LOG LINE");
  });
});

function state(overrides: Partial<ChatState> = {}): ChatState {
  return { botID: "A", botName: "A", messages: [], working: false, avatar: "", placeholder: "", replyingTo: null, pendingFiles: [], components: {}, ...overrides } as ChatState;
}
function paste(composer: Composer, text: string): boolean {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  event.clipboardData = { files: [], getData: () => text };
  composer.view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("composer chip", () => {
  beforeEach(() => { sent.length = 0; document.body.innerHTML = ""; vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it("a long paste becomes a chip, a short one stays text", () => {
    const composer = new Composer(document.body);
    composer.update(state());
    paste(composer, "short");
    expect(composer.text).toBe("short");
    expect(document.querySelector(".paste-chip")).toBeNull();
    composer.setText("");
    expect(paste(composer, Array(20).fill("row").join("\n"))).toBe(true);
    expect(composer.text).toBe("");
    expect(document.querySelector(".paste-chip")?.textContent).toContain("20");
    expect((document.querySelector(".send") as HTMLButtonElement).disabled).toBe(false);
  });

  it("uses the limits from settings", () => {
    const composer = new Composer(document.body);
    composer.update(state({ pasteCollapseChars: 0, pasteCollapseLines: 3 }));
    expect(paste(composer, "a\nb\nc\nd")).toBe(true);
    composer.update(state({ pasteCollapseChars: 0, pasteCollapseLines: 0 }));
    expect(document.querySelector(".paste-chip")).not.toBeNull();
    document.querySelector<HTMLButtonElement>(".paste-remove")!.click();
    expect(document.querySelector(".paste-chip")).toBeNull();
  });

  it("opens a preview, and Expand into input puts the text in the editor and removes the chip", () => {
    const composer = new Composer(document.body);
    composer.update(state());
    const text = Array(20).fill("row").join("\n");
    paste(composer, text);
    document.querySelector<HTMLButtonElement>(".paste-chip")!.click();
    expect(document.querySelector(".paste-preview")!.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector(".paste-body")!.textContent).toBe(text);
    [...document.querySelectorAll<HTMLButtonElement>(".paste-action")].find((b) => b.textContent === "Expand into input")!.click();
    expect(composer.text).toBe(text);
    expect(document.querySelector(".paste-chip")).toBeNull();
  });

  it("send includes the pasted text after the typed words", () => {
    const composer = new Composer(document.body);
    composer.update(state());
    composer.insert("why does this fail?");
    const text = Array(20).fill("row").join("\n");
    paste(composer, text);
    composer.submit();
    const message = sent.find((action) => action.type === "send") as { text: string };
    expect(splitPasted(message.text)).toEqual({ text: "why does this fail?", pasted: text });
    expect(document.querySelector(".paste-chip")).toBeNull();
  });

  it("the chip belongs to its chat", () => {
    const composer = new Composer(document.body);
    composer.update(state());
    paste(composer, "x".repeat(2000));
    composer.update(state({ botID: "B" }));
    expect(document.querySelector(".paste-chip")).toBeNull();
    composer.update(state());
    expect(document.querySelector(".paste-chip")).not.toBeNull();
  });
});
