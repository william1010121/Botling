// The chat frame's side of a line's media on the Botling 3 page (M2 step 9). Bundled into chat.js after the 2.x chat
// page's entry (web-v3/chat-entry.ts), which it does not edit: it replaces the page's media source (Web/src/markdown.ts
// `setMediaSource`, set by the 2.x entry for the desktop's chat origin) with one that maps a line's local file to the
// `/v3/c/…` URL the shell got for it.
//
// - A file the shell has answered: its URL at once (the element loads it directly, so `<video>` does its own ranges).
// - A file not answered yet: a harmless `data:` placeholder (allowed by the chat page's `media-src`), and a
//   `media.want` to the shell; when the answer comes, every element showing the placeholder gets the URL.
// - A file that changed after its line (or is gone): the element is hidden and a short note says so; never new bytes.
// - Anything else (a web URL, a component card's picture) goes through the 2.x mapping as before.
// The line is the one the page names (Markdown media) or, for an attachment strip or the lightbox, the row's id.
import { localMediaSource } from "../src/contract/attachment-url";
import { setMediaSource } from "../../Web/src/markdown";
import { CHANGED_TEXT, GONE_TEXT, isLocalMedia, mediaKey, type FrameMediaMessage, type MediaAnswer, type ShellMediaMessage } from "./media-wire";

const PLACEHOLDER = "data:,botling3-media-";
const MEDIA = "img, video, audio, source";

interface Pending { url: string; line?: string }

const answers = new Map<string, MediaAnswer>();
const placeholders: Pending[] = [];
const placeholderOf = new Map<string, string>();
const asked = new Set<string>();
const srcKey = new Map<string, string>();

function post(message: FrameMediaMessage): void {
  window.parent.postMessage(message, "*");
}

function shownBot(): string | undefined {
  return document.documentElement.dataset.chat?.split("/")[0];
}

function want(key: string, botId: string, line: string, url: string): void {
  if (asked.has(key)) return;
  asked.add(key);
  post({ botling3: "media.want", items: [{ key, botId, line, url }] });
}

function placeholder(url: string, line?: string): string {
  const id = `${line ?? ""}\n${url}`;
  let text = placeholderOf.get(id);
  if (!text) {
    text = `${PLACEHOLDER}${placeholders.length}`;
    placeholders.push({ url, ...(line ? { line } : {}) });
    placeholderOf.set(id, text);
  }
  return text;
}

/** The media source of the Botling 3 page. */
export function v3MediaSource(url: string, line?: string): string {
  const botId = shownBot();
  if (!botId || !isLocalMedia(url)) return localMediaSource(document.documentElement.dataset.chat, url, line);
  if (line) {
    const key = mediaKey(botId, line, url);
    const known = answers.get(key);
    if (known?.state === "ready" && known.src) return known.src;
    want(key, botId, line, url);
  }
  return placeholder(url, line);
}

function keyOf(element: Element): string | null {
  const src = element.getAttribute("src") ?? "";
  if (src.startsWith(PLACEHOLDER)) {
    const pending = placeholders[Number(src.slice(PLACEHOLDER.length))];
    const botId = shownBot();
    if (!pending || !botId) return null;
    const line = pending.line ?? (element.closest(".row") as HTMLElement | null)?.dataset.id;
    if (!line) return null;
    const key = mediaKey(botId, line, pending.url);
    want(key, botId, line, pending.url);
    return key;
  }
  return srcKey.get(src) ?? (element as HTMLElement).dataset?.botling3Media ?? null;
}

function note(element: Element, text: string): void {
  const host = element.tagName === "SOURCE" ? element.parentElement ?? element : element;
  const next = host.nextElementSibling as HTMLElement | null;
  if (next?.dataset.botling3Note === text) return;
  const div = document.createElement("div");
  div.className = "botling3-media-note";
  div.dataset.botling3Note = text;
  div.dataset.testid = "media-changed";
  div.setAttribute("role", "note");
  div.textContent = text;
  div.style.cssText = "padding:8px 10px;border-radius:8px;background:rgba(127,127,127,.14);font-size:13px;opacity:.85;margin:4px 0";
  host.after(div);
}

function apply(element: Element): void {
  const key = keyOf(element);
  if (!key) return;
  const answer = answers.get(key);
  if (!answer) return;
  const html = element as HTMLElement;
  html.dataset.botling3Media = key;
  if (answer.state === "ready" && answer.src) {
    if (element.getAttribute("src") !== answer.src) element.setAttribute("src", answer.src);
    return;
  }
  if (answer.state === "changed" || answer.state === "gone") {
    if (element.hasAttribute("src")) {
      element.removeAttribute("src");
      if (element instanceof HTMLMediaElement) element.load();
    }
    const host = element.tagName === "SOURCE" ? element.parentElement ?? html : html;
    // `hidden` alone loses to the chat page's `.media { display: … }`.
    (host as HTMLElement).hidden = true;
    (host as HTMLElement).style.display = "none";
    note(element, answer.state === "changed" ? CHANGED_TEXT : GONE_TEXT);
  }
}

function scan(root: ParentNode = document): void {
  for (const element of root.querySelectorAll(MEDIA)) {
    const src = element.getAttribute("src") ?? "";
    if (src.startsWith(PLACEHOLDER) || srcKey.has(src) || (element as HTMLElement).dataset.botling3Media) apply(element);
  }
}

function onShell(event: MessageEvent): void {
  if (event.source !== window.parent) return;
  const data = event.data as ShellMediaMessage | null;
  if (!data || data.botling3 !== "media" || !Array.isArray(data.items)) return;
  for (const item of data.items) {
    if (typeof item?.key !== "string") continue;
    // An older URL of the key stays known: an element still showing it learns the new state.
    answers.set(item.key, item);
    if (item.src) srcKey.set(item.src, item.key);
    // A state other than ready may change again (preparing → ready): the next render asks again.
    if (item.state !== "ready") asked.delete(item.key);
  }
  scan();
}

/** Installs the source and the watchers (once, after the 2.x chat page's entry ran). */
export function installChatMedia(): void {
  setMediaSource(v3MediaSource);
  window.addEventListener("message", onShell);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") { if ((record.target as Element).matches?.(MEDIA)) apply(record.target as Element); continue; }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(MEDIA)) apply(node);
        scan(node);
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
  // A media element that failed (a 410 for a file rewritten since, an expired ticket): the shell asks the server again.
  document.addEventListener("error", (event) => {
    const element = event.target as Element | null;
    if (!element || !element.matches?.(MEDIA)) return;
    const key = srcKey.get(element.getAttribute("src") ?? "");
    if (key) post({ botling3: "media.failed", key });
  }, true);
  scan();
}
