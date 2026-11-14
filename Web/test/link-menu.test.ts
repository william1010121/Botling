/// <reference types="node" />
// A plugin's button beside a link in a message (`chat/link`, link-menu.ts): shown while the pointer rests on a link it
// matches or the link has focus, floating over the chat (no line moves), gone when the pointer leaves both; its click posts
// the command with the message and link; no entries: no button at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sent } from "../src/bridge";
import { messageElement } from "../src/messages";
import { hideLinkBar, installLinkMenu, linkItemsFor, setLinkMenu } from "../src/link-menu";
import type { LinkMenuItem, MessageView } from "../src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

function message(overrides: Partial<MessageView>): MessageView {
  return {
    id: "m1", role: "bot", text: "", stamp: null, avatar: "data:image/png;base64,AA==",
    choices: null, chosen: null, answer: null, open: false, display: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false,
    ...overrides,
  };
}

const coach: LinkMenuItem = { command: "coach.start", title: "開始陪讀", icon: "book", when: { ext: ["pdf"] } };

function show(view: MessageView): HTMLElement {
  const row = messageElement(view, {});
  document.getElementById("messages")!.append(row);
  return row;
}
const over = (element: Element, related: Element | null = null) => element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: related }));
const out = (element: Element, related: Element | null = null) => element.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: related }));
const bar = () => document.querySelector<HTMLElement>(".link-bar");

beforeEach(() => {
  document.body.innerHTML = `<div id="messages"></div><input id="after">`;
  sent.length = 0;
  installLinkMenu(document);
  setLinkMenu([coach]);
});
afterEach(() => { hideLinkBar(); setLinkMenu([]); vi.useRealTimers(); });

describe("a plugin's button beside a chat link", () => {
  it("shows on a matching link in a bot reply, as an overlay in the body, and posts { id, messageID, url } on click", () => {
    const row = show(message({ id: "r7", text: "Read [the paper](/Users/me/Papers/Attention.PDF) or [the site](https://example.com/a.html)." }));
    const bubble = row.querySelector(".bot-bubble")!;
    const before = bubble.innerHTML;
    const [pdf, web] = [...row.querySelectorAll<HTMLElement>("a.chip")];
    over(pdf!);
    expect(bar()).not.toBeNull();
    // Out of the message: nothing in the bubble changed, the bar is the body's own (position: fixed in chat.css).
    expect(bar()!.parentElement).toBe(document.body);
    expect(bubble.innerHTML).toBe(before);
    expect(bar()!.getAttribute("role")).toBe("toolbar");
    const button = bar()!.querySelector<HTMLButtonElement>("button.preview-make")!;
    expect(button.textContent).toBe("開始陪讀");
    expect(button.querySelector("svg")).not.toBeNull();
    button.click();
    expect(sent).toEqual([{ type: "linkCommand", id: "coach.start", messageID: "r7", url: "/Users/me/Papers/Attention.PDF" }]);
    // The click ran the command and the bar went; the link's own click is untouched (no openURL here).
    expect(bar()).toBeNull();
    // A link the entry does not match: no bar.
    over(web!);
    expect(bar()).toBeNull();
  });

  it("matches web PDFs with a query, and file chips of your own line", () => {
    const row = show(message({ id: "u1", role: "user", text: "see this", attachments: [{ name: "Notes.PDF", url: "file:///Users/me/Notes.PDF", kind: "file" } as never] }));
    const chip = row.querySelector<HTMLElement>("a.file-chip");
    expect(chip).not.toBeNull();
    over(chip!);
    expect(bar()).not.toBeNull();
    bar()!.querySelector<HTMLButtonElement>("button")!.click();
    expect(sent.at(-1)).toEqual({ type: "linkCommand", id: "coach.start", messageID: "u1", url: "file:///Users/me/Notes.PDF" });
    expect(linkItemsFor("https://arxiv.org/pdf/1706.03762v7.pdf?download=1")).toEqual([coach]);
    expect(linkItemsFor("https://arxiv.org/abs/1706.03762")).toEqual([]);
  });

  it("goes when the pointer leaves link and bar, stays while it moves from the link onto the bar", () => {
    vi.useFakeTimers();
    const row = show(message({ text: "[p](file:///a/b.pdf)" }));
    const link = row.querySelector<HTMLElement>("a.chip")!;
    over(link);
    const shown = bar()!;
    out(link, shown);
    over(shown, link);
    vi.advanceTimersByTime(1_000);
    expect(bar()).toBe(shown);
    out(shown, document.body);
    vi.advanceTimersByTime(1_000);
    expect(bar()).toBeNull();
    over(link);
    out(link, document.body);
    vi.advanceTimersByTime(1_000);
    expect(bar()).toBeNull();
  });

  it("shows on keyboard focus; Tab goes into the bar, Tab again on to what follows the link, Escape closes it", () => {
    const row = show(message({ text: "[p](https://example.org/x.pdf#page=2)" }));
    const link = row.querySelector<HTMLElement>("a.chip")!;
    link.focus();
    expect(document.activeElement).toBe(link);
    expect(bar()).not.toBeNull();
    link.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    const button = bar()!.querySelector<HTMLButtonElement>("button")!;
    expect(document.activeElement).toBe(button);
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(bar()).toBeNull();
    // The next thing Tab reaches after the link, as without the bar: the reply's own Reply button.
    expect(document.activeElement).toBe(row.querySelector("button.reply-button"));
    link.focus();
    expect(bar()).not.toBeNull();
    link.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(bar()).toBeNull();
  });

  it("several entries: a compact row; more than 3: two and a ⋯ list with the rest", () => {
    const items = ["a", "b", "c", "d", "e"].map((name) => ({ command: `p.${name}`, title: name.toUpperCase(), when: { ext: ["pdf"] } }));
    setLinkMenu(items.slice(0, 3));
    const row = show(message({ id: "r2", text: "[p](/x/y.pdf)" }));
    const link = row.querySelector<HTMLElement>("a.chip")!;
    over(link);
    expect([...bar()!.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["A", "B", "C"]);
    setLinkMenu(items);
    over(link);
    const buttons = [...bar()!.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["A", "B", ""]);
    expect(buttons[2]!.getAttribute("aria-haspopup")).toBe("menu");
    buttons[2]!.click();
    const list = document.querySelector<HTMLElement>(".message-menu.link-menu-list")!;
    expect([...list.querySelectorAll("button")].map((entry) => entry.textContent)).toEqual(["C", "D", "E"]);
    list.querySelectorAll<HTMLButtonElement>("button")[1]!.click();
    expect(sent.at(-1)).toEqual({ type: "linkCommand", id: "p.d", messageID: "r2", url: "/x/y.pdf" });
    expect(document.querySelector(".link-menu-list")).toBeNull();
  });

  it("no entries from plugins: no button on any link", () => {
    setLinkMenu([]);
    const row = show(message({ text: "[p](/x/y.pdf)" }));
    const link = row.querySelector<HTMLElement>("a.chip")!;
    over(link);
    link.focus();
    expect(bar()).toBeNull();
    expect(document.querySelector(".link-bar")).toBeNull();
  });
});
