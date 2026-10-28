/// <reference types="node" />
import { beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { closeLightbox, handleMediaClicks, isImageURL, openLightbox } from "../src/lightbox";
import { messageElement } from "../src/messages";
import { mediaHTML, renderMarkdown } from "../src/markdown";
import type { MessageView } from "../src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

function message(overrides: Partial<MessageView>): MessageView {
  return {
    id: "m1", role: "bot", text: "", stamp: null, avatar: null,
    choices: null, chosen: null, answer: null, open: false, display: null,
    attachments: null, replyTo: null, replyPreview: null, openable: false,
    ...overrides,
  };
}

function key(name: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
}

handleMediaClicks(document);

beforeEach(() => {
  closeLightbox();
  sent.length = 0;
  document.body.innerHTML = "";
});

describe("image lightbox", () => {
  it("opens over the chat when an image in a reply is clicked, and posts no window", () => {
    const row = messageElement(message({ text: "Here:\n\n![Login screen](file:///p/.bot/artifacts/login.png)" }), {});
    document.body.append(row);
    row.querySelector<HTMLImageElement>("img.media")!.click();
    const box = document.querySelector(".lightbox");
    expect(box).not.toBeNull();
    expect(box!.querySelector<HTMLImageElement>(".lightbox-image")!.getAttribute("src")).toBe("file:///p/.bot/artifacts/login.png");
    expect(box!.querySelector(".lightbox-caption")!.textContent).toBe("Login screen");
    expect(sent).toEqual([]);
  });

  it("closes on Esc", () => {
    const row = messageElement(message({ text: "![shot](file:///tmp/a.png)" }), {});
    document.body.append(row);
    row.querySelector<HTMLImageElement>("img.media")!.click();
    expect(document.querySelector(".lightbox")).not.toBeNull();
    key("Escape");
    expect(document.querySelector(".lightbox")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("closes on the close button and on a click outside the picture", () => {
    const row = messageElement(message({ text: "![shot](file:///tmp/a.png)" }), {});
    document.body.append(row);
    const image = row.querySelector<HTMLImageElement>("img.media")!;
    image.click();
    document.querySelector<HTMLButtonElement>(".lightbox-close")!.click();
    expect(document.querySelector(".lightbox")).toBeNull();
    image.click();
    document.querySelector<HTMLElement>(".lightbox")!.click();
    expect(document.querySelector(".lightbox")).toBeNull();
  });

  it("zooms to full size when the picture is clicked, and opens in Preview only on request", () => {
    const row = messageElement(message({ text: "![shot](file:///tmp/a.png)" }), {});
    document.body.append(row);
    row.querySelector<HTMLImageElement>("img.media")!.click();
    const box = document.querySelector<HTMLElement>(".lightbox")!;
    box.querySelector<HTMLImageElement>(".lightbox-image")!.click();
    expect(box.classList.contains("actual")).toBe(true);
    expect(document.querySelector(".lightbox")).not.toBeNull();
    box.querySelector<HTMLButtonElement>(".lightbox-open")!.click();
    expect(sent).toEqual([{ type: "openExternal", url: "file:///tmp/a.png" }]);
  });

  it("opens an attached picture's thumbnail in the lightbox too", () => {
    const row = messageElement(message({ role: "user", text: "look", attachments: [{ name: "a.png", kind: "image", url: "file:///tmp/a.png" }] }), {});
    document.body.append(row);
    row.querySelector<HTMLImageElement>(".thumb")!.click();
    expect(document.querySelector(".lightbox")).not.toBeNull();
    expect(sent).toEqual([]);
  });

  it("marks its buttons with the picture's URL (a click of yours) and offers Finder for Botling 2's chat attachments", () => {
    const url = "botling-chat://chat/attachment/B/ZmlsZTovLy90bXAvYS5wbmc/a.png";
    const row = messageElement(message({ role: "relay", text: "report", attachments: [{ name: "a.png", kind: "image", url }] }), {});
    document.body.append(row);
    row.querySelector<HTMLImageElement>(".thumb")!.click();
    const box = document.querySelector<HTMLElement>(".lightbox")!;
    expect(box.querySelector<HTMLElement>(".lightbox-open")!.dataset.url).toBe(url);
    box.querySelector<HTMLButtonElement>(".lightbox-reveal")!.click();
    expect(sent).toEqual([{ type: "revealFile", url }]);
  });

  it("still sends HTML pages and other files to their window", () => {
    const row = messageElement(message({ role: "user", text: "x", attachments: [{ name: "r.html", kind: "file", url: "file:///p/r.html" }] }), {});
    document.body.append(row);
    row.querySelector<HTMLElement>(".file-chip")!.click();
    expect(document.querySelector(".lightbox")).toBeNull();
    expect(sent).toEqual([{ type: "openURL", url: "file:///p/r.html", label: "r.html" }]);
  });

  it("tells pictures from pages by their extension", () => {
    expect(isImageURL("file:///a/b.PNG")).toBe(true);
    expect(isImageURL("file:///a/b.jpeg?x=1")).toBe(true);
    expect(isImageURL("data:image/png;base64,AA==")).toBe(true);
    expect(isImageURL("file:///a/b.html")).toBe(false);
    expect(isImageURL("https://example.com/")).toBe(false);
  });
});


describe("image preview keyboard lifecycle", () => {
  function trigger() {
    const row = messageElement(message({ text: "![Keyboard picture](file:///tmp/a.png)" }), {});
    document.body.append(row);
    return row.querySelector<HTMLElement>("img.media")!;
  }
  it.each(["Enter", " "])("opens a named image button with %s and restores it on Escape", (key) => {
    const image = trigger();
    expect(image.getAttribute("role")).toBe("button");
    expect(image.tabIndex).toBe(0);
    image.focus();
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    image.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.querySelector(".lightbox-close"));
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".lightbox")).toBeNull();
    expect(document.activeElement).toBe(image);
    expect(sent).toEqual([]);
  });
  it.each(["file:///tmp/a.png", "https://example.com/a.webp"])("wraps Tab in both directions and contains external focus for %s", (url) => {
    const before = document.createElement("button");
    document.body.append(before);
    before.focus();
    openLightbox(url, "Picture");
    const first = document.querySelector<HTMLButtonElement>(".lightbox-open")!;
    const last = document.querySelector<HTMLButtonElement>(".lightbox-close")!;
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(last);
    before.focus();
    expect(document.activeElement).toBe(last);
    closeLightbox();
    expect(document.activeElement).toBe(before);
  });
  it("keeps a nested summary open on Escape and restores its trigger", () => {
    const summary = document.createElement("dialog");
    summary.className = "summary-source-viewer";
    summary.setAttribute("open", "");
    document.body.append(summary);
    const image = trigger();
    summary.append(image);
    image.focus();
    let escaped = false;
    summary.addEventListener("keydown", () => { escaped = true; });
    openLightbox("file:///tmp/a.gif", "Animated");
    expect(summary.querySelector(".lightbox")).not.toBeNull();
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(escaped).toBe(false);
    expect(summary.hasAttribute("open")).toBe(true);
    expect(document.activeElement).toBe(image);
  });
  it("restores the original control after replacement and cleans up after removal", () => {
    const image = trigger();
    image.focus();
    openLightbox("file:///tmp/a.png", "First");
    openLightbox("file:///tmp/b.png", "Second");
    closeLightbox();
    expect(document.activeElement).toBe(image);
    openLightbox("file:///tmp/a.png", "Removed trigger");
    image.remove();
    expect(() => closeLightbox()).not.toThrow();
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    expect(document.activeElement).toBe(other);
  });
});


it("keeps media formats and safe Markdown rendering intact", () => {
  const root = document.createElement("div");
  root.innerHTML = mediaHTML("file:///tmp/a.png", '"<script>');
  const image = root.querySelector("img")!;
  expect(image.getAttribute("aria-label")).toBe('"<script>');
  expect(root.querySelector("script")).toBeNull();
  root.innerHTML = mediaHTML("file:///tmp/a.png", "");
  expect(root.querySelector("img")!.getAttribute("aria-label")).toBe("Picture");
  root.innerHTML = mediaHTML("file:///tmp/a.mp4", "Video");
  expect(root.querySelector("video")!.controls).toBe(true);
  expect(root.querySelector('[role="button"]')).toBeNull();
  root.innerHTML = renderMarkdown('![bad](javascript:alert%281%29) <script>alert(1)</script>');
  expect(root.querySelector("img, script")).toBeNull();
});
