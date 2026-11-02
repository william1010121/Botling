// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sent } from "../../../../Web/src/bridge";
import type { Composer } from "../../../../Web/src/composer";
import { messageElement } from "../../../../Web/src/messages";
import type { PluginHost } from "../../../../Web/src/plugins";
import type { ChatState, MessageView } from "../../../../Web/src/types";
import { countLines, pasteLimits, shouldCollapse, splitPasted, withPasted } from "../src/paste";
import { chatPage, spec } from "./chat-page";
import { activate } from "../src/web";
import { activate as latex } from "../../ccb-latex/src/web";

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
    expect(pasteLimits(undefined, null)).toEqual(limits);
    expect(pasteLimits(0, 30)).toEqual({ chars: 0, lines: 30 });
    expect(pasteLimits(-1, NaN)).toEqual(limits);
    expect(pasteLimits("9", 2.7)).toEqual({ chars: 1000, lines: 2 });
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
  let composer: Composer;
  let host: PluginHost;
  let close: () => void;
  beforeEach(async () => { sent.length = 0; vi.useFakeTimers(); ({ composer, host, close } = await chatPage()); });
  afterEach(() => { close(); vi.useRealTimers(); });

  it("a long paste becomes a chip, a short one stays text", () => {
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

  it("uses the limits from the plugin's settings", async () => {
    composer.update(state());
    await host.sync([spec({ "botling.chat-extras.pasteCollapseChars": 0, "botling.chat-extras.pasteCollapseLines": 3 })], async () => activate);
    expect(paste(composer, "a\nb\nc\nd")).toBe(true);
    await host.sync([spec({ "botling.chat-extras.pasteCollapseChars": 0, "botling.chat-extras.pasteCollapseLines": 0 })], async () => activate);
    expect(document.querySelector(".paste-chip")).not.toBeNull();
    paste(composer, "x".repeat(5000));
    expect(composer.text).toBe("x".repeat(5000));
    document.querySelector<HTMLButtonElement>(".paste-remove")!.click();
    expect(document.querySelector(".paste-chip")).toBeNull();
  });

  it("opens a preview, and Expand into input puts the text in the editor and removes the chip", () => {
    composer.update(state());
    const text = Array(20).fill("row").join("\n");
    paste(composer, text);
    document.querySelector<HTMLButtonElement>(".paste-chip")!.click();
    expect(document.querySelector(".composer-chip-preview")!.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector(".paste-body")!.textContent).toBe(text);
    expect(document.querySelector(".paste-chip")!.getAttribute("aria-expanded")).toBe("true");
    [...document.querySelectorAll<HTMLButtonElement>(".paste-action")].find((b) => b.textContent === "Expand into input")!.click();
    expect(composer.text).toBe(text);
    expect(document.querySelector(".paste-chip")).toBeNull();
    expect(document.querySelector(".composer-chip-preview")!.hasAttribute("hidden")).toBe(true);
  });

  it("another paste joins the chip", () => {
    composer.update(state());
    paste(composer, Array(20).fill("one").join("\n"));
    paste(composer, Array(20).fill("two").join("\n"));
    expect(document.querySelectorAll(".paste-chip")).toHaveLength(1);
    expect(document.querySelector(".paste-chip")?.textContent).toContain("40");
  });

  it("send includes the pasted text after the typed words", () => {
    composer.update(state());
    composer.insert("why does this fail?");
    const text = Array(20).fill("row").join("\n");
    paste(composer, text);
    composer.submit();
    const message = sent.find((action) => action.type === "send") as { text: string };
    expect(message.text).toBe(`why does this fail?\n\n<pasted-text>\n${text}\n</pasted-text>`);
    expect(splitPasted(message.text)).toEqual({ text: "why does this fail?", pasted: text });
    expect(document.querySelector(".paste-chip")).toBeNull();
  });

  it("a paste alone sends just the tag; blank words are left out", () => {
    composer.update(state());
    composer.insert("  ");
    paste(composer, "x".repeat(2000));
    composer.submit();
    const message = sent.find((action) => action.type === "send") as { text: string };
    expect(message.text).toBe(`<pasted-text>\n${"x".repeat(2000)}\n</pasted-text>`);
  });

  it("the chip belongs to its chat", () => {
    composer.update(state());
    paste(composer, "x".repeat(2000));
    composer.update(state({ botID: "B" }));
    expect(document.querySelector(".paste-chip")).toBeNull();
    composer.update(state());
    expect(document.querySelector(".paste-chip")).not.toBeNull();
  });

  it("goes when the plugin is turned off, and the box takes long pastes as text again", () => {
    composer.update(state());
    paste(composer, "x".repeat(2000));
    close();
    expect(document.querySelector(".paste-chip")).toBeNull();
    expect((document.querySelector(".send") as HTMLButtonElement).disabled).toBe(true);
    paste(composer, "y".repeat(2000));
    expect(composer.text).toBe("y".repeat(2000));
    expect(document.querySelector(".paste-chip")).toBeNull();
  });
});

describe("a sent message with a paste", () => {
  let close: () => void;
  let host: PluginHost;
  beforeEach(async () => ({ close, host } = await chatPage()));
  afterEach(() => { close(); host.unload("ccb-latex"); });
  const message = (text: string): MessageView => ({
    id: "p1", role: "user", text, stamp: null, avatar: null, choices: null, chosen: null, answer: null, open: false,
    attachments: null, replyTo: null, replyPreview: null, openable: false, reactionEnabled: false,
  });

  it("shows your words in the bubble and the paste as a chip under it, which opens a dialog", () => {
    const row = messageElement(message(withPasted("look", "LOG\nLINE")), {});
    expect(row.querySelector(".user-bubble")!.innerHTML).toBe("look");
    const chip = row.querySelector<HTMLButtonElement>(".user-body > .attachments > .paste-chip")!;
    expect(chip.textContent).toContain("2 lines");
    document.body.append(row);
    chip.click();
    expect(document.querySelector(".paste-dialog .paste-body")!.textContent).toBe("LOG\nLINE");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".paste-dialog")).toBeNull();
  });

  it("keeps the paste out of ccb-latex's bubble, whichever plugin draws first", async () => {
    const latexSpec = { ...spec(), name: "ccb-latex", settings: {} };
    for (const order of [[latexSpec, spec()], [spec(), latexSpec]]) {
      host.unload("ccb-latex");
      close();
      await host.sync(order, async (loaded) => (loaded.name === "ccb-latex" ? latex : activate));
      const bubble = messageElement(message(withPasted("see $y$", "cost $5 \\n and $x$")), {}).querySelector(".user-bubble")!;
      expect(bubble.querySelectorAll(".katex")).toHaveLength(1);
      expect(bubble.textContent).not.toContain("pasted-text");
      expect(bubble.textContent).not.toContain("cost");
    }
  });

  it("a paste alone has no bubble, only the chip", () => {
    const row = messageElement(message(withPasted("", "LOG")), {});
    expect(row.querySelector(".user-bubble")).toBeNull();
    expect(row.querySelector(".user-body > .attachments > .paste-chip")).not.toBeNull();
  });
});
