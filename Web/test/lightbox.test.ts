/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { closeLightbox, draggableFileURL, handleMediaClicks, isImageURL, openLightbox } from "../src/lightbox";
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
afterEach(() => closeLightbox());

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

  it("zooms in when the picture is clicked (no longer closes), and opens in Preview only on request", () => {
    const row = messageElement(message({ text: "![shot](file:///tmp/a.png)" }), {});
    document.body.append(row);
    row.querySelector<HTMLImageElement>("img.media")!.click();
    const box = document.querySelector<HTMLElement>(".lightbox")!;
    box.querySelector<HTMLImageElement>(".lightbox-image")!.click();
    expect(document.querySelector(".lightbox")).not.toBeNull();
    box.querySelector<HTMLButtonElement>(".lightbox-open")!.click();
    expect(sent).toEqual([{ type: "openExternal", url: "file:///tmp/a.png", shown: "file:///tmp/a.png" }]);
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
    expect(sent).toEqual([{ type: "revealFile", url, shown: url }]);
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


describe("attachment image keyboard entry", () => {
  it.each(["Enter", " "])("opens a thumbnail with %s and returns focus on Escape", (key) => {
    const row = messageElement(message({ role: "user", text: "look", attachments: [
      { name: 'Photo "one".png', kind: "image", url: "file:///tmp/a.png" },
    ] }), {});
    document.body.append(row);
    const thumb = row.querySelector<HTMLImageElement>(".thumb")!;
    expect(thumb.getAttribute("role")).toBe("button");
    expect(thumb.getAttribute("aria-label")).toBe('Photo "one".png');
    expect(thumb.getAttribute("aria-haspopup")).toBe("dialog");
    expect(thumb.parentElement!.closest('button, a, [role="button"]')).toBeNull();
    expect(thumb.tabIndex).toBe(0);
    thumb.focus();
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    thumb.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelectorAll(".lightbox")).toHaveLength(1);
    expect(document.activeElement).toBe(document.querySelector(".lightbox-close"));
    expect(document.querySelector(".lightbox-caption")!.textContent).toBe('Photo "one".png');
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".lightbox")).toBeNull();
    expect(document.activeElement).toBe(thumb);
    expect(sent).toEqual([]);
  });
});


it("makes a linked Markdown image one external link, not a nested preview button", () => {
 const row=document.createElement("div");
 row.innerHTML=renderMarkdown('[![Photo](file:///tmp/a.png)](https://example.com/details)');
 document.body.append(row);
 const link=row.querySelector("a")!, image=link.querySelector("img")!;
 expect(link.dataset.url).toBe("https://example.com/details");
 expect(image.alt).toBe("Photo");
 expect(image.hasAttribute("role")).toBe(false);
 expect(image.tabIndex).toBe(-1);
 expect(image.hasAttribute("data-url")).toBe(false);
 image.click();
 expect(sent).toEqual([{type:"openURL",url:"https://example.com/details",label:""}]);
 expect(document.querySelector(".lightbox")).toBeNull();
});
it("does not swallow keyboard input after an unexpected preview DOM removal", () => {
 openLightbox("file:///tmp/a.png","Photo");
 document.querySelector(".lightbox")!.remove();
 const tab=new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true});
 document.dispatchEvent(tab);
 expect(tab.defaultPrevented).toBe(false);
 const escape=new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true});
 document.dispatchEvent(escape);
 expect(escape.defaultPrevented).toBe(false);
});


describe("standalone media keyboard handler IME safety", () => {
  it.each([
    {key:"Enter",isComposing:true}, {key:"Enter",keyCode:229},
    {key:" ",isComposing:true}, {key:" ",keyCode:229},
  ])("leaves composition key %j untouched without a window capture guard", init => {
    // This file installs only handleMediaClicks; production-window coverage is in ime.test.ts.
    const root=document.createElement("div");root.innerHTML=mediaHTML("file:///tmp/photo.png","Photo");document.body.append(root);
    const image=root.querySelector<HTMLImageElement>("img")!;image.focus();
    const event=new KeyboardEvent("keydown",{...init,bubbles:true,cancelable:true});
    image.dispatchEvent(event);
    expect(document.querySelector(".lightbox")).toBeNull();
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(image);
    expect(sent).toEqual([]);
    image.dispatchEvent(new KeyboardEvent("keydown",{key:init.key,bubbles:true,cancelable:true}));
    expect(document.querySelector(".lightbox")).not.toBeNull();
    closeLightbox();expect(document.activeElement).toBe(image);
  });
});

describe("dragging a local file out of the chat", () => {
  function dragStart(element: Element): DragEvent {
    const event = new Event("dragstart", { bubbles: true, cancelable: true }) as DragEvent;
    element.dispatchEvent(event);
    return event;
  }

  it("names only local files: file:// URLs, absolute paths and this chat's attachments", () => {
    expect(draggableFileURL("file:///p/report.md")).toBe("file:///p/report.md");
    expect(draggableFileURL("/Users/me/eeg/notes.md")).toBe("/Users/me/eeg/notes.md");
    expect(draggableFileURL("botling-chat://chat/attachment/b1/x.png")).toBe("botling-chat://chat/attachment/b1/x.png");
    for (const url of ["https://example.com/a.md", "mailto:a@b.c", "data:image/png;base64,AAAA", "//host/x", "notes.md", "#", "", undefined]) {
      expect(draggableFileURL(url)).toBeNull();
    }
  });

  it("asks the app for a file drag when a reply's file link or picture is dragged, and keeps the drag from the page", () => {
    const row = messageElement(message({ text: "See [notes](file:///p/notes.md) and ![shot](file:///p/shot.png)" }), {});
    document.body.append(row);
    const link = row.querySelector<HTMLAnchorElement>("a.chip[data-url]")!;
    const linkDrag = dragStart(link);
    expect(linkDrag.defaultPrevented).toBe(true);
    const picture = row.querySelector<HTMLImageElement>("img.media")!;
    expect(dragStart(picture).defaultPrevented).toBe(true);
    expect(sent).toEqual([{ type: "dragFile", url: "file:///p/notes.md" }, { type: "dragFile", url: "file:///p/shot.png" }]);
  });

  it("drags an attached file's chip", () => {
    const row = messageElement(message({ role: "user", attachments: [{ name: "data.csv", kind: "file", url: "file:///p/data.csv" }] }), {});
    document.body.append(row);
    dragStart(row.querySelector("a.file-chip")!);
    expect(sent).toEqual([{ type: "dragFile", url: "file:///p/data.csv" }]);
  });

  it("leaves web links as the browser drags them, and a click still opens a file link", () => {
    const row = messageElement(message({ text: "[site](https://example.com) and [notes](file:///p/notes.md)" }), {});
    document.body.append(row);
    const [web, file] = [...row.querySelectorAll<HTMLAnchorElement>("a[data-url]")];
    expect(dragStart(web!).defaultPrevented).toBe(false);
    expect(sent).toEqual([]);
    file!.click();
    expect(sent).toEqual([{ type: "openURL", url: "file:///p/notes.md", label: "notes" }]);
  });
});
