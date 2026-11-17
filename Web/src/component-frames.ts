import { post } from "./bridge";
import { openMedia } from "./lightbox";
import { mediaSrc } from "./markdown";
import { frameOf } from "./frame-protocol";
import type { Action, ComponentInfo, PinSize } from "./types";
import { componentTokensCss, onComponentTokens } from "./component-tokens";
import { chatSize, resizeFrame, answerPicks, saveLimit, componentPage, type Surface, type AnswerImage, type ComponentAnswer, type AnswerHandler, type SaveHandler, type ComponentFrame, type DetailTarget } from "./component-page";
// drawBehind and reportControl are still in components.ts (M7-S30c moves them); both are used only when called, not at import.
import { drawBehind, reportControl } from "./components";

/** runDetail calls sent to Swift, by request number: the frame that asked and its own number. */
const detailCalls = new Map<number, { source: MessageEventSource; id: number }>();
let detailRequests = 0;

/** Swift's answer to a runDetail (`ccb.detailReply`): the output's JSON, or why it failed. */
export function detailReply(requestID: number, ok: boolean, value: string): void {
  const call = detailCalls.get(requestID);
  if (!call) return;
  detailCalls.delete(requestID);
  let reply: { ccbDetail: number; ok: boolean; value?: unknown; error?: string };
  if (ok) {
    let parsed: unknown = value;
    try { parsed = JSON.parse(value); } catch { /* text as it is */ }
    reply = { ccbDetail: call.id, ok: true, value: parsed };
  } else {
    reply = { ccbDetail: call.id, ok: false, error: value };
  }
  (call.source as Window).postMessage(reply, "*");
}

/** A frame's runDetail: passed on to Swift with its card's folder, or refused at once. */
function runDetail(frame: ComponentFrame, source: MessageEventSource, id: unknown, values: unknown, save = false): void {
  if (typeof id !== "number") return;
  const refuse = (error: string) => (source as Window).postMessage({ ccbDetail: id, ok: false, error }, "*");
  const target = frame.ccbDetail;
  if (!target) {
    refuse("This component has no Detail command here (about.md needs a \"Detail command:\" line).");
    return;
  }
  const given: Record<string, string | number> = {};
  if (values && typeof values === "object" && !Array.isArray(values)) {
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (typeof value !== "string" && typeof value !== "number") {
        refuse(`The value for {${key}} must be text or a number.`);
        return;
      }
      given[key] = value;
    }
  } else if (values != null) {
    refuse("ccb.runDetail takes an object, like {hash: \"2aed630\"}.");
    return;
  }
  const requestID = ++detailRequests;
  detailCalls.set(requestID, { source, id });
  const into = save && target.card && target.command ? { card: target.card, command: target.command } : {};
  post({ type: "componentDetail", requestID, name: target.name, folder: target.folder, values: given, ...into });
}

/**
 * The height each component last had, by message and component. A redrawn frame starts at it
 * instead of collapsing to its default and growing again once loaded, which made the chat jump.
 * Kept in the page's storage too, so a chat opened after a restart has its placeholders (frames
 * not built yet) at the height they will have.
 */
const frameHeights = new Map<string, number>();
const heightsKey = "ccb.frameHeights";
/** The most heights kept; the oldest go first. */
const heightsKept = 3000;
let heightsTimer: ReturnType<typeof setTimeout> | null = null;
try {
  const saved = JSON.parse(localStorage.getItem(heightsKey) ?? "null") as unknown;
  if (saved && typeof saved === "object") {
    for (const [key, value] of Object.entries(saved as Record<string, unknown>)) {
      if (typeof value === "number" && value > 0) frameHeights.set(key, value);
    }
  }
} catch { /* no storage: heights last as long as the page */ }

function rememberHeight(key: string, height: number): void {
  if (frameHeights.get(key) === height) return;
  frameHeights.delete(key);
  frameHeights.set(key, height);
  while (frameHeights.size > heightsKept) frameHeights.delete(frameHeights.keys().next().value!);
  heightsTimer ??= setTimeout(() => {
    heightsTimer = null;
    try { localStorage.setItem(heightsKey, JSON.stringify(Object.fromEntries(frameHeights))); } catch { /* full or blocked */ }
  }, 1000);
}

/**
 * Lazy frames. A chat's component frames are built only once they come within `lazyMargin`
 * pixels of the visible part of the chat: a long chat holds tens of components, and building
 * every one at once (each its own page, scripts and all) took seconds on opening it. Until then
 * the frame is an empty placeholder at the height it last had (or `placeholderHeight`), so the
 * scroll position does not move when it is built. Pinned, Board and floating copies are always
 * on show and are built at once, as is everything when the page has no IntersectionObserver.
 */
export const lazyMargin = 1500;
export const placeholderHeight = 200;
const nearWork = new Map<Element, () => void>();
let nearObserver: IntersectionObserver | null | undefined;

function observer(): IntersectionObserver | null {
  if (nearObserver !== undefined) return nearObserver;
  if (typeof IntersectionObserver === "undefined") return (nearObserver = null);
  nearObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const work = nearWork.get(entry.target);
      forgetNear(entry.target);
      work?.();
    }
  }, { root: document.getElementById("scroller"), rootMargin: `${lazyMargin}px 0px` });
  return nearObserver;
}

/** Calls `work` once `element` comes near the visible chat; false (nothing done) when it cannot tell. */
export function whenNear(element: Element, work: () => void): boolean {
  const watcher = observer();
  if (!watcher) return false;
  nearWork.set(element, work);
  watcher.observe(element);
  return true;
}

function forgetNear(element: Element): void {
  if (!nearWork.delete(element)) return;
  nearObserver?.unobserve(element);
}

/**
 * Does the waiting work of everything already near the visible chat, measured now: called once
 * a redraw has settled, so what shows when a chat opens is built at once (the observer reports
 * only at the next rendering, which a window drawn offscreen, as for a snapshot, never has).
 */
export function buildNear(): void {
  if (!nearWork.size) return;
  const box = document.getElementById("scroller")?.getBoundingClientRect();
  if (!box || box.height <= 0) return;
  const [top, bottom] = [box.top - lazyMargin, box.bottom + lazyMargin];
  for (const [element, work] of [...nearWork]) {
    if (!element.isConnected) continue;
    const rect = element.getBoundingClientRect();
    // Hidden (a folded part, the Board showing instead): it waits.
    if (rect.width <= 0 && rect.height <= 0) continue;
    if (rect.bottom < top || rect.top > bottom) continue;
    forgetNear(element);
    work();
  }
}

/**
 * The tokens changed (component-tokens.ts): every component frame on this page that was built with tokens is told the new
 * stylesheet (it keeps what it shows); one built without (no plugin had set any then) is built again with them, as a frame
 * that was not built yet is. A frame that is not on the page is left alone.
 */
export function applyTokens(root: ParentNode = document): void {
  const css = componentTokensCss();
  for (const frame of root.querySelectorAll<ComponentFrame>("iframe.component-frame")) {
    // Not built yet: its page is made again, so it is built with the tokens of the time it comes near.
    if (frame.ccbPending != null) {
      if (frame.ccbBuild) { frame.ccbPending = frame.ccbBuild(); frame.ccbTokens = css !== ""; }
      continue;
    }
    if (frame.ccbTokens) { frame.contentWindow?.postMessage({ ccbTokens: css }, "*"); continue; }
    if (!frame.ccbBuild || css === "") continue;
    frame.ccbTokens = true;
    frame.srcdoc = frame.ccbBuild();
  }
}
onComponentTokens(() => applyTokens());

/** Stops waiting for the frames and cards in `root` to come near: they are gone from the page. */
export function releaseFrames(root: Element): void {
  if (!nearWork.size) return;
  forgetNear(root);
  for (const element of waitingIn(root)) forgetNear(element);
}

/** The frames not built yet and the cards waiting for their first run in `root`. */
function waitingIn(root: Element): Element[] {
  return [...root.querySelectorAll<ComponentFrame>("iframe.component-frame, .command-waiting")]
    .filter((element) => !(element instanceof HTMLIFrameElement) || !frameBuilt(element));
}

/** Gives a lazy frame its page now (it came near the visible chat). */
function buildFrame(frame: ComponentFrame): void {
  forgetNear(frame);
  const page = frame.ccbPending;
  if (page == null) return;
  frame.ccbPending = null;
  frame.classList.remove("pending");
  frame.srcdoc = page;
}

/** Whether every component frame in `element` has its page. */
export function builtFrames(element: Element): boolean {
  return [...element.querySelectorAll<HTMLIFrameElement>("iframe.component-frame")].every(frameBuilt);
}

/** Whether the frame has its page (a lazy one is not built until it comes near). */
export function frameBuilt(frame: HTMLIFrameElement): boolean {
  return (frame as ComponentFrame).ccbPending == null;
}

/**
 * A frame above the visible part of the chat changed height (it was built, or its content
 * grew): the chat scrolls by as much, so what you are reading stays where it is. WebKit has no
 * scroll anchoring of its own.
 */
export function keepReading(frame: HTMLElement, before: DOMRect, height: number): void {
  const scroller = frame.closest<HTMLElement>("#scroller");
  if (!scroller) return;
  const delta = height - before.height;
  if (!delta || before.bottom > scroller.getBoundingClientRect().top + 1) return;
  scroller.scrollTop += delta;
}

// Frames are found by their window when they speak (frame-protocol.ts), so a message sent before the
// frame's own load event is not lost. A library component is no plugin's: it has no call or command.
window.addEventListener("message", (event) => {
  const message = event.data as { ccb?: string; height?: number; index?: number; text?: string; images?: unknown; url?: string; label?: string; scope?: unknown; commit?: unknown; spec?: unknown; id?: unknown; values?: unknown };
  if (!message?.ccb) return;
  const frame = frameOf(document.querySelectorAll<ComponentFrame>("iframe.component-frame"), event.source);
  if (!frame) return;
  if (message.ccb === "size" && typeof message.height === "number" && message.height > 0) {
    const before = frame.getBoundingClientRect();
    frame.style.height = `${message.height}px`;
    // One drawing behind the shown frame takes no room yet: its height counts once it shows.
    if (!frame.classList.contains("incoming")) keepReading(frame, before, message.height);
    if (frame.ccbKey) rememberHeight(frame.ccbKey, message.height);
  } else if (message.ccb === "hover") {
    // The pointer is over the component: its Board tile (or opened pin) shows its controls.
    frame.closest(".board-card, .pin-sheet, .float-card")?.classList.toggle("hovered", !!(message as { on?: unknown }).on);
  } else if (message.ccb === "answer" && frame.ccbAnswer) {
    const images = answerImages(message.images);
    const picks = answerPicks((message as { picks?: unknown }).picks);
    if (picks) frame.ccbAnswer({ picks });
    else if (typeof message.index === "number" && Number.isInteger(message.index)) frame.ccbAnswer({ index: message.index, ...(typeof message.text === "string" && message.text.trim() ? {text: message.text} : {}), ...(images.length ? {images} : {}) });
    else if (images.length) frame.ccbAnswer({ text: typeof message.text === "string" ? message.text : "", images });
    else if (typeof message.text === "string" && message.text.trim() !== "") frame.ccbAnswer({ text: message.text });
  } else if (message.ccb === "open" && typeof message.url === "string" && message.url !== "") {
    // Opened full-size the way a link chip is: a picture in the lightbox, a page in a window of its own.
    // A picture the card shows (its data names it): the lightbox shows that one, loaded as the card loads it.
    const card = cardPicture(frame.ccbImages, message.url);
    openMedia(message.url, typeof message.label === "string" ? message.label : "", card ? mediaSrc(card) : undefined);
  } else if (message.ccb === "status") {
    // Only a copy with a chip to set (a pin's) has somewhere for it to go.
    frame.ccbStatus?.(message as { clear?: unknown; text?: unknown; tone?: unknown });
  } else if (message.ccb === "live") {
    // It takes new data itself (ccb.onData): a redraw with only new data keeps it.
    frame.ccbLive = true;
  } else if (message.ccb === "save" && frame.ccbSave) {
    const data = (message as { data?: unknown }).data;
    if (typeof data !== "string" || data === "" || data.length > saveLimit) return;
    // The frame shows this data already: a redraw with it keeps the frame.
    if (frame.ccbDrawnFor) frame.ccbDrawn = frame.ccbDrawnFor(data);
    frame.ccbData = data;
    frame.ccbSave(data);
  } else if (message.ccb === "runDetail" && event.source) {
    runDetail(frame, event.source, message.id, message.values, (message as { save?: unknown }).save === true);
  }
});

/** The path a file URL or absolute path names, else null. */
function localPath(text: string): string | null {
  const value = text.trim();
  if (/^file:/i.test(value)) {
    try { return decodeURIComponent(new URL(value).pathname); } catch { return null; }
  }
  return value.startsWith("/") && !value.startsWith("//") ? value : null;
}

/** The URL a card loads a picture its data names from (`images`, by the data's text), for the file URL or path it opens; else null. */
export function cardPicture(images: Record<string, string> | undefined, url: string): string | null {
  if (!images) return null;
  if (images[url]) return images[url]!;
  const path = localPath(url);
  if (!path) return null;
  for (const [named, shown] of Object.entries(images)) if (localPath(named) === path) return shown;
  return null;
}

/** The pictures in a component's answer that are well formed; anything else is dropped. */
export function answerImages(value: unknown): AnswerImage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is AnswerImage => !!item && typeof item.name === "string" && typeof item.base64 === "string" && item.base64 !== "")
    .map((item) => ({ name: item.name.trim() || "Picture.png", base64: item.base64 }));
}

/**
 * What an answer posts to Swift for message `messageID`: a pick, or words (with any pictures).
 * Nothing for an empty answer.
 */
export function answerAction(messageID: string, answer: ComponentAnswer): Action | null {
  if (answer.picks?.length) return { type: "answer", messageID, text: "", picks: answer.picks };
  if (answer.index !== undefined) return { type: "choose", messageID, index: answer.index, ...(answer.text?.trim() ? { text: answer.text } : {}), ...(answer.images?.length ? { images: answer.images } : {}) };
  const text = answer.text ?? "";
  const images = answer.images ?? [];
  if (images.length) return { type: "answer", messageID, text, images };
  if (text.trim() !== "") return { type: "answer", messageID, text };
  return null;
}

/**
 * A component with its report flag beside it (shown on hover), or nothing if no template.
 * `key` names this use of it (the message it is in), so a redraw keeps its height. `lazy`: in the
 * chat's history, its frame is built only once it comes near the visible chat (`whenNear`).
 */
export function componentElement(
  name: string,
  info: ComponentInfo | undefined,
  data: string,
  onAnswer: AnswerHandler | null,
  key?: string,
  images?: Record<string, string> | null,
  detail?: DetailTarget | null,
  size?: PinSize,
  surface: Surface = "chat",
  fill = surface === "board",
  onSave: SaveHandler | null = null,
  lazy = false,
): HTMLElement | null {
  if (!info) return null;
  const wrap = document.createElement("div");
  wrap.className = "component";
  wrap.dataset.surface = surface;
  const frame = document.createElement("iframe") as ComponentFrame;
  frame.className = "component-frame";
  frame.setAttribute("sandbox", "allow-scripts");
  // Named for VoiceOver, not with a title: that is a hover tooltip poking out of the reply.
  frame.setAttribute("aria-label", name);
  frame.ccbAnswer = onAnswer;
  frame.ccbSave = onSave;
  frame.ccbDetail = detail ?? null;
  frame.ccbImages = images ?? {};
  if (key) {
    frame.ccbKey = `${key}/${name}`;
    const height = frameHeights.get(frame.ccbKey);
    if (height) frame.style.height = `${height}px`;
  }
  // What it shows; the order of the pictures does not count (a Swift dictionary has none).
  const pictures = Object.entries(images ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  frame.ccbDrawnFor = (shown: string) => JSON.stringify([name, info.template, info.version, shown, pictures, fill, !!onSave]);
  frame.ccbDrawn = frame.ccbDrawnFor(data);
  // All of it but the data: a frame that takes live data (ccb.onData) is kept when only that changes.
  frame.ccbShape = JSON.stringify([name, info.template, info.version, pictures, fill, !!onSave]);
  frame.ccbData = data;
  const drawnSize = size ?? chatSize(info);
  frame.ccbSize = drawnSize;
  const page = componentPage(info.template, data, images ?? {}, drawnSize, surface, fill, !!onSave);
  // Built with tokens, it takes later changes live; built without, a first set rebuilds it (`applyTokens`). It is rebuilt from what it shows now.
  frame.ccbTokens = componentTokensCss() !== "";
  frame.ccbBuild = () => componentPage(info.template, frame.ccbData ?? data, frame.ccbImages ?? {}, frame.ccbSize ?? drawnSize, surface, fill, !!onSave);
  if (lazy && whenNear(frame, () => buildFrame(frame))) {
    // A placeholder until it comes near, as tall as it will be (or a guess, kept from then on).
    frame.ccbPending = page;
    frame.classList.add("pending");
    if (!frame.style.height) frame.style.height = `${placeholderHeight}px`;
  } else {
    frame.srcdoc = page;
  }
  // Resized before its page ran: tell it once it has loaded.
  frame.addEventListener("load", () => {
    if (frame.ccbSize && frame.ccbSize !== drawnSize) resizeFrame(frame, frame.ccbSize);
  });
  wrap.append(frame, reportControl(name, info));
  return wrap;
}

/**
 * Brings the drawn message `old` up to its redraw `fresh` while keeping the component frames
 * that show the same thing, since a frame given a new page, or taken out of the page even for a
 * moment, loads again (it flickered on every streamed word or status change). Everything else
 * is `fresh`'s, with its own click handlers. Returns the element to keep: `old` (still where it
 * was) if any frame was kept, otherwise `fresh`, which the caller puts in its place.
 */
export function keepFrames(old: HTMLElement, fresh: HTMLElement): HTMLElement {
  const replaced = () => {
    releaseFrames(old);
    return fresh;
  };
  if (old.tagName !== fresh.tagName) return replaced();
  const oldFrames = new Map<string, ComponentFrame>();
  for (const frame of old.querySelectorAll<ComponentFrame>("iframe.component-frame")) {
    // A frame still drawing new data behind the one on screen stands for nothing yet.
    if (frame.classList.contains("incoming")) continue;
    if (frame.ccbKey && frame.ccbDrawn && !oldFrames.has(frame.ccbKey)) oldFrames.set(frame.ccbKey, frame);
  }
  if (!oldFrames.size) return replaced();
  // Each fresh element kept as its old one: the frames, and the elements around them.
  const kept = new Map<Element, Element>([[fresh, old]]);
  const keptFrames = new Set<Element>();
  const behind: [ComponentFrame, ComponentFrame][] = [];
  for (const frame of fresh.querySelectorAll<ComponentFrame>("iframe.component-frame")) {
    const before = frame.ccbKey ? oldFrames.get(frame.ccbKey) : undefined;
    if (!before) continue;
    // Only its data changed, and it takes new data itself: kept, and sent the data.
    const changed = before.ccbDrawn !== frame.ccbDrawn;
    const sameShape = before.ccbShape === frame.ccbShape;
    const live = changed && !!before.ccbLive && sameShape;
    // Only its data changed but it draws data only as it loads: it stays on screen while a new
    // frame draws the new data behind it (a frame given a new page goes blank while it loads).
    const redraw = changed && !live && sameShape && frameBuilt(before);
    if (changed && !live && !redraw) continue;
    // Only where it sits the same way in both, so nothing around it has to move.
    const pairs: [Element, Element][] = [];
    let a: Element | null = frame;
    let b: Element | null = before;
    while (a && b && a !== fresh && b !== old && a.tagName === b.tagName) {
      pairs.push([a, b]);
      a = a.parentElement;
      b = b.parentElement;
    }
    if (a !== fresh || b !== old) continue;
    if (pairs.some(([x, y]) => (kept.has(x) && kept.get(x) !== y) || (!kept.has(x) && [...kept.values()].includes(y)))) continue;
    for (const [x, y] of pairs) kept.set(x, y);
    keptFrames.add(frame);
    oldFrames.delete(frame.ccbKey!);
    (before as ComponentFrame).ccbAnswer = frame.ccbAnswer;
    (before as ComponentFrame).ccbSave = frame.ccbSave;
    (before as ComponentFrame).ccbDetail = frame.ccbDetail;
    if (frame.ccbSize && before.ccbSize !== frame.ccbSize) resizeFrame(before, frame.ccbSize);
    if (redraw) behind.push([before, frame]);
    if (live) {
      before.ccbDrawn = frame.ccbDrawn;
      before.ccbData = frame.ccbData;
      before.contentWindow?.postMessage({ ccbData: frame.ccbData }, "*");
    }
  }
  if (!keptFrames.size) return replaced();
  // The fresh copies of kept frames are dropped, and so are the old elements nothing kept.
  for (const frame of keptFrames) forgetNear(frame);
  const waiting = waitingIn(old);
  const patch = (target: Element, source: Element) => {
    for (const { name } of [...target.attributes]) {
      if (!source.hasAttribute(name)) target.removeAttribute(name);
    }
    for (const { name, value } of [...source.attributes]) {
      if (target.getAttribute(name) !== value) target.setAttribute(name, value);
    }
    const wanted = [...source.childNodes].flatMap((child): Node[] => {
      const match = child instanceof Element ? kept.get(child) : undefined;
      if (!match) return [child];
      if (!keptFrames.has(child as Element)) patch(match, child as Element);
      // The frame drawing its new data behind it stays where it is too.
      const incoming = (match as ComponentFrame).ccbIncoming;
      return incoming && incoming.parentNode === target ? [match, incoming] : [match];
    });
    const keep = new Set<Node>(wanted);
    for (const child of [...target.childNodes]) {
      if (!keep.has(child)) child.remove();
    }
    let cursor = target.firstChild;
    for (const node of wanted) {
      if (node === cursor) cursor = cursor.nextSibling;
      else target.insertBefore(node, cursor);
    }
  };
  patch(old, fresh);
  for (const [shown, next] of behind) drawBehind(shown, next);
  for (const element of waiting) if (!old.contains(element)) forgetNear(element);
  return old;
}
