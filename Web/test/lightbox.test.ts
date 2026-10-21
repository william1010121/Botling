/// <reference types="node" />
import { beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { closeLightbox, handleMediaClicks, isImageURL } from "../src/lightbox";
import { messageElement } from "../src/messages";
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
