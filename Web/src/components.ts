import { post } from "./bridge";
import { escapeHTML } from "./util";
import type { Action, ChoiceView, ComponentInfo, DisplayView, PinSize } from "./types";

/**
 * A component template inside its own iframe, so one template cannot break another or the chat.
 * The template sees `window.ccb` (also `window.deck`):
 * - `data`: what the bot gave.
 * - `answer(value)`: a number picks an option by index, text is a typed answer, and
 *   `{text, images}` sends words with pictures (`images`: File/Blob objects, data: URLs, or
 *   `{name, base64}`); the bot gets the pictures as saved files, like a message's attachments.
 *   Returns a promise that settles once it is sent.
 * - `pickImage({multiple})`: opens the picture picker; resolves to the pictures picked
 *   (`{name, type, base64, dataURL}` each, [] if cancelled). Call it from a click.
 * - `readImage(file)`: a pasted or dropped File as such a picture.
 * - `image(path)`: the URL to load a picture the data names by file path (`<img src>`).
 * - `open(url, label)`: show a page or file full-size, as a link chip does.
 * - `reviewWithCodex({scope, commit, spec})`: Codex reviews the chat bot's repository once
 *   ("uncommitted", "lastCommit", "branch" or "commit"; a commit hash implies "commit"), checked
 *   against a spec file if given. The app checks the call; the report shows in the right column.
 * - `runDetail(values)`: runs the component's `Detail command:` (about.md) with its `{name}`
 *   placeholders filled from `values` (`{hash: "2aed630"}`), in the folder its card's command
 *   runs in, once the user has allowed it there. Resolves to the output (parsed when it is JSON,
 *   else the text) or rejects with an Error saying why.
 * - `size`: the size it is drawn at, `{w, h, name, px: {width, height}}`: `w`×`h` Board cells
 *   (any from 1×1 to 4×4), `name` the nearest of 1×1 "small", 2×1 "wide", 1×2 "tall", 2×2 "large",
 *   4×2 "xlarge", and `px` the frame's real width and height. Also `<html data-size="2x1">`, for
 *   CSS, and `#ccb-root` is a CSS container (a size container where the page fills its frame, an
 *   inline-size one elsewhere), so container queries work. A card on the Board has the size the
 *   user dragged or picked; in the chat it is the widest its about.md's `Sizes:` hint names (2×2
 *   without one), drawn across the whole reply.
 * - `onSize(fn)`: calls `fn(size)` whenever its cells or its frame's pixels change (each step of a
 *   drag too); returns a function that stops.
 * - `setStatus({text, tone})`: what the chip of its pin (above the input box) shows beside its
 *   icon: a short value ("26°", "3 new"; about 14 characters show) and a tone ("good", "warning",
 *   "bad" or "neutral"), a dot on the icon unless neutral. Text alone is fine; `null` clears it (the
 *   chip shows the summary of its data again). Only a pinned copy (its sheet or Board tile) sets
 *   it, and the chip keeps the last one; elsewhere it does nothing.
 * - `surface`: where it is drawn, "chat", "board" or "pinned"; also `<html data-surface="chat">`.
 *   Everywhere it draws no frame of its own (no border, background or radius, at most ~12px
 *   padding): on the Board the component is the whole tile, like a home-screen widget, whose
 *   rounded corners and background frame it, and it fills the tile (the page is the tile's height
 *   and scrolls); in the chat the reply's bubble (or, under a reply, a tile like the Board's)
 *   frames it, edge to edge across the message column; "pinned" is a pin opened from its chip
 *   above the input box, framed by the panel. In the chat and pinned the page is as tall as its
 *   content. One rule for all: `.card { border: 0; background: none; border-radius: 0;
 *   padding: 12px }` with `html[data-surface="board"] .card { height: 100% }`.
 * The frame reports its height and answers to this page, which passes answers on to Swift.
 */
export function componentPage(template: string, data: string, images: Record<string, string> = {}, size: PinSize = "2x2", surface: Surface = "chat", fill = surface === "board"): string {
  const safe = (json: string) => json.replace(/</g, "\\u003c");
  return `<!doctype html><html data-size="${size}" data-surface="${surface}"${fill ? " data-fill" : ""}><head><meta charset="utf-8"><meta name="color-scheme" content="dark">
<style>:root{color-scheme:dark}html,body{margin:0;padding:0;background:transparent;color:#EDEDF0;font:14px -apple-system,"PingFang TC",sans-serif;overflow:hidden}
#ccb-root{container-type:inline-size;container-name:ccb}
html[data-surface="board"] #ccb-root{height:100%}
html[data-fill],html[data-fill] body,html[data-fill] #ccb-root{height:100%}html[data-fill] #ccb-root{container-type:size}
html[data-fill] body{overflow-y:auto;scrollbar-width:none}html[data-fill] body::-webkit-scrollbar{display:none}</style>
<script>
(() => {
  const images = ${safe(JSON.stringify(images))};
  const read = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataURL = String(reader.result || '');
      const type = file.type || (dataURL.match(/^data:([^;,]+)/) || [])[1] || 'image/png';
      resolve({name: file.name || ('Pasted image.' + (type.split('/')[1] || 'png')), type, base64: dataURL.slice(dataURL.indexOf(',') + 1), dataURL});
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  // Any way a template holds a picture, as {name, base64}.
  const picture = async (item, index) => {
    if (item instanceof Blob) item = await read(item);
    else if (typeof item === 'string') item = {dataURL: item};
    if (!item || typeof item !== 'object') return null;
    let base64 = typeof item.base64 === 'string' ? item.base64 : '';
    let type = item.type || '';
    if (!base64 && typeof item.dataURL === 'string' && item.dataURL.startsWith('data:')) {
      base64 = item.dataURL.slice(item.dataURL.indexOf(',') + 1);
      type = type || (item.dataURL.match(/^data:([^;,]+)/) || [])[1] || '';
    }
    if (!base64) return null;
    const name = typeof item.name === 'string' && item.name ? item.name : 'Picture ' + (index + 1) + '.' + ((type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg'));
    return {name, base64};
  };
  // runDetail calls waiting for the page's answer, by number.
  const details = new Map();
  let detailCount = 0;
  // Who wants to hear when its card is resized.
  const sizeWatchers = new Set();
  // The frame's own width and height: what a responsive layout has to fit.
  const pixels = () => Object.freeze({width: Math.round(Number(window.innerWidth) || 0), height: Math.round(Number(window.innerHeight) || 0)});
  const sized = (cells, px) => Object.freeze({w: cells.w, h: cells.h, name: String(cells.name), px});
  const tell = () => {
    for (const watcher of [...sizeWatchers]) {
      try { watcher(window.ccb.size); } catch (error) { console.error(error); }
    }
  };
  // New cells from the page (the user resized its card).
  const resized = (next) => {
    if (typeof next.w !== 'number' || typeof next.h !== 'number') return;
    const now = window.ccb.size;
    const px = pixels();
    if (next.w === now.w && next.h === now.h && px.width === now.px.width && px.height === now.px.height) return;
    window.ccb.size = sized(next, px);
    document.documentElement.dataset.size = next.w + 'x' + next.h;
    tell();
  };
  // New pixels: a drag, a narrower window, the panel dragged taller.
  const measured = () => {
    const now = window.ccb.size;
    const px = pixels();
    if (px.width === now.px.width && px.height === now.px.height) return;
    window.ccb.size = sized(now, px);
    tell();
  };
  window.addEventListener('resize', measured);
  window.addEventListener('load', measured);
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (event.source !== parent || !message) return;
    if (message.ccbSize && typeof message.ccbSize === 'object') return resized(message.ccbSize);
    if (typeof message.ccbDetail !== 'number') return;
    const call = details.get(message.ccbDetail);
    if (!call) return;
    details.delete(message.ccbDetail);
    if (message.ok) call.resolve(message.value);
    else call.reject(new Error(String(message.error || 'The Detail command failed.')));
  });
  window.ccb = {
    data: ${safe(data)},
    size: sized(${JSON.stringify(sizeInfo(size))}, pixels()),
    surface: ${JSON.stringify(surface)},
    onSize(fn) {
      if (typeof fn !== 'function') return () => {};
      sizeWatchers.add(fn);
      return () => sizeWatchers.delete(fn);
    },
    answer(value) {
      if (typeof value === 'number') {
        parent.postMessage({ccb: 'answer', index: value}, '*');
        return Promise.resolve();
      }
      if (value && typeof value === 'object' && !(value instanceof String)) {
        const text = value.text == null ? '' : String(value.text);
        return Promise.all([...(value.images || [])].map(picture)).then((list) => {
          parent.postMessage({ccb: 'answer', text, images: list.filter(Boolean)}, '*');
        });
      }
      parent.postMessage({ccb: 'answer', text: String(value)}, '*');
      return Promise.resolve();
    },
    choose(index) { return this.answer(Number(index)); },
    send(text) { return this.answer(String(text)); },
    pickImage(options) {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = !!(options && options.multiple);
        input.style.display = 'none';
        let settled = false;
        const done = (files) => {
          if (settled) return;
          settled = true;
          input.remove();
          Promise.all(files.filter((file) => file.type.startsWith('image/')).map(read)).then(resolve, () => resolve([]));
        };
        input.addEventListener('change', () => done([...(input.files || [])]));
        input.addEventListener('cancel', () => done([]));
        document.body.append(input);
        input.click();
      });
    },
    readImage(file) { return read(file); },
    image(path) {
      if (path == null) return '';
      const text = String(path);
      if (images[text]) return images[text];
      if (images[text.trim()]) return images[text.trim()];
      return /^(data:|blob:|ccb-preview:)/.test(text) ? text : '';
    },
    open(url, label) { parent.postMessage({ccb: 'open', url: String(url), label: label == null ? '' : String(label)}, '*'); },
    reviewWithCodex(options) {
      const given = options && typeof options === 'object' ? options : {};
      const text = (value) => value == null ? null : String(value);
      parent.postMessage({ccb: 'reviewWithCodex', scope: text(given.scope), commit: text(given.commit), spec: text(given.spec)}, '*');
      return Promise.resolve();
    },
    setStatus(status) {
      if (status == null) parent.postMessage({ccb: 'status', clear: true}, '*');
      else if (typeof status === 'object') parent.postMessage({ccb: 'status', text: status.text == null ? '' : String(status.text), tone: status.tone == null ? null : String(status.tone)}, '*');
      else parent.postMessage({ccb: 'status', text: String(status), tone: null}, '*');
      return Promise.resolve();
    },
    runDetail(values) {
      return new Promise((resolve, reject) => {
        const id = ++detailCount;
        details.set(id, {resolve, reject});
        let given = {};
        if (values && typeof values === 'object') {
          for (const key of Object.keys(values)) {
            const value = values[key];
            given[key] = typeof value === 'number' || typeof value === 'string' ? value : String(value);
          }
        }
        parent.postMessage({ccb: 'runDetail', id, values: given}, '*');
      });
    }
  };
  // Templates written while the app was called Deck call deck.answer(...).
  window.deck = window.ccb;
})();
</script></head><body><div id="ccb-root">
${template}
</div><script>
const ccbRoot = document.getElementById('ccb-root');
const ccbSize = () => parent.postMessage({ccb: 'size', height: Math.ceil(ccbRoot.getBoundingClientRect().height)}, '*');
new ResizeObserver(ccbSize).observe(ccbRoot);
window.addEventListener('load', ccbSize);
// The pointer over it, for the Board tile's controls (a parent page cannot always see it).
document.documentElement.addEventListener('mouseenter', () => parent.postMessage({ccb: 'hover', on: true}, '*'));
document.documentElement.addEventListener('mouseleave', () => parent.postMessage({ccb: 'hover', on: false}, '*'));
</script></body></html>`;
}

/**
 * Where a component is drawn: in the chat, as a tile on the Board, or "pinned": opened from its
 * chip above the input box, filling that panel.
 */
export type Surface = "chat" | "board" | "pinned";

/** The most cells a Board card spans each way. */
export const maxColumns = 4;
export const maxRows = 4;

/** Every Board size, row by row: 1×1, 2×1, … 4×4. */
export const pinSizes: PinSize[] = Array.from({ length: maxRows }, (_, row) =>
  Array.from({ length: maxColumns }, (_, column) => `${column + 1}x${row + 1}` as PinSize)).flat();

/** The five sizes that have a name, for templates written for them. */
const namedSizes: [number, number, string][] = [[1, 1, "small"], [2, 1, "wide"], [1, 2, "tall"], [2, 2, "large"], [4, 2, "xlarge"]];

/** A size of `w`×`h` cells, each kept within 1…4. */
export function pinSize(w: number, h: number): PinSize {
  const clamp = (value: number, most: number) => Math.min(most, Math.max(1, Math.round(value) || 1));
  return `${clamp(w, maxColumns)}x${clamp(h, maxRows)}`;
}

/** A size as Swift or about.md spells it, or null when it is not one ("5x1", "big"). */
export function parseSize(text: string | undefined | null): PinSize | null {
  const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(text ?? "");
  if (!match) return null;
  const [w, h] = [Number(match[1]), Number(match[2])];
  return w >= 1 && w <= maxColumns && h >= 1 && h <= maxRows ? `${w}x${h}` : null;
}

/** The nearest named size to `w`×`h` ("small", "wide", "tall", "large", "xlarge"); of two as near, the earlier. */
export function sizeName(w: number, h: number): string {
  let best = namedSizes[0];
  let distance = Infinity;
  for (const named of namedSizes) {
    const d = (named[0] - w) ** 2 + (named[1] - h) ** 2;
    if (d < distance) {
      best = named;
      distance = d;
    }
  }
  return best[2];
}

/** What a template sees in `ccb.size` (the frame adds `px`, its real width and height). */
export function sizeInfo(size: PinSize): { w: number; h: number; name: string } {
  const [w, h] = (parseSize(size) ?? "2x2").split("x").map(Number);
  return { w, h, name: sizeName(w, h) };
}

/** The sizes its about.md's optional `Sizes:` line hints at, else 2×2 alone. */
export function componentSizes(info: ComponentInfo | undefined): PinSize[] {
  const sizes = (info?.sizes ?? []).map(parseSize).filter((size): size is PinSize => size !== null);
  return sizes.length ? sizes : ["2x2"];
}

/**
 * The size a component is drawn at in the chat, where it spans the reply: the widest it has a
 * layout for (of two as wide, the taller), so 4×2 when it has one; 2×2, its one layout, when its
 * about.md names no sizes.
 */
export function chatSize(info: ComponentInfo | undefined): PinSize {
  const wider = (a: PinSize, b: PinSize) => {
    const [x, y] = [sizeInfo(a), sizeInfo(b)];
    return x.w !== y.w ? x.w > y.w : x.h > y.h;
  };
  return componentSizes(info).reduce((best, size) => (wider(size, best) ? size : best));
}

/** Tells a component's frame its card now has `size` (its `ccb.onSize` watchers run). */
export function resizeFrame(frame: HTMLIFrameElement, size: PinSize): void {
  (frame as ComponentFrame).ccbSize = size;
  frame.contentWindow?.postMessage({ ccbSize: sizeInfo(size) }, "*");
}

/** The choices data a 「choices」 template reads. */
export function choicesData(choices: ChoiceView[], chosen: number | null, answer: string | null): string {
  return JSON.stringify({ options: choices, chosen, answer });
}

/** A picture a component sends back, as the Swift side saves it. */
export interface AnswerImage {
  name: string;
  base64: string;
}

/** What a component answered: an option, words, or words with pictures. */
export interface ComponentAnswer {
  index?: number;
  text?: string;
  images?: AnswerImage[];
}

type AnswerHandler = (answer: ComponentAnswer) => void;
/**
 * A component's frame: its answer handler, the use it is (`ccbKey`), and what it was drawn from
 * (`ccbDrawn`), so a redrawn message can keep a frame whose component did not change.
 */
type ComponentFrame = HTMLIFrameElement & { ccbAnswer?: AnswerHandler | null; ccbKey?: string; ccbDrawn?: string; ccbDetail?: DetailTarget | null; ccbSize?: PinSize; ccbPin?: string | null };

/** Marks the component frames in `element` as pin `id`'s: their `ccb.setStatus` sets its chip. */
export function markPinFrames(element: HTMLElement | null, id: string): void {
  for (const frame of element?.querySelectorAll<ComponentFrame>("iframe.component-frame") ?? []) frame.ccbPin = id;
}

/** A pinned frame's `ccb.setStatus(...)` as the action Swift gets: text and tone as strings, or cleared. */
export function pinStatusAction(id: string, message: { clear?: unknown; text?: unknown; tone?: unknown }): Action {
  if (message.clear) return { type: "pinStatus", id, text: null, tone: null };
  const text = typeof message.text === "string" ? message.text : typeof message.text === "number" ? String(message.text) : "";
  return { type: "pinStatus", id, text, tone: typeof message.tone === "string" && message.tone !== "" ? message.tone : null };
}

/** Where a frame's `ccb.runDetail` goes: its component, and the folder its card showed. */
export interface DetailTarget {
  name: string;
  folder: string;
}

/** The DetailTarget a card's display gives, when its component has a Detail command. */
export function detailTarget(display: DisplayView): DetailTarget | null {
  return display.detail && display.folder ? { name: display.name, folder: display.folder } : null;
}

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
function runDetail(frame: ComponentFrame, source: MessageEventSource, id: unknown, values: unknown): void {
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
  post({ type: "componentDetail", requestID, name: target.name, folder: target.folder, values: given });
}

/**
 * The height each component last had, by message and component. A redrawn frame starts at it
 * instead of collapsing to its default and growing again once loaded, which made the chat jump.
 */
const frameHeights = new Map<string, number>();

// Frames are found by their window when they speak, so a message sent before the frame's own
// load event is not lost.
window.addEventListener("message", (event) => {
  const message = event.data as { ccb?: string; height?: number; index?: number; text?: string; images?: unknown; url?: string; label?: string; scope?: unknown; commit?: unknown; spec?: unknown; id?: unknown; values?: unknown };
  if (!message?.ccb) return;
  const frame = [...document.querySelectorAll<ComponentFrame>("iframe.component-frame")]
    .find((candidate) => candidate.contentWindow === event.source);
  if (!frame) return;
  if (message.ccb === "size" && typeof message.height === "number" && message.height > 0) {
    frame.style.height = `${message.height}px`;
    if (frame.ccbKey) frameHeights.set(frame.ccbKey, message.height);
  } else if (message.ccb === "hover") {
    // The pointer is over the component: its Board tile (or opened pin) shows its controls.
    frame.closest(".board-card, .pin-sheet")?.classList.toggle("hovered", !!(message as { on?: unknown }).on);
  } else if (message.ccb === "answer" && frame.ccbAnswer) {
    const images = answerImages(message.images);
    if (typeof message.index === "number") frame.ccbAnswer({ index: message.index });
    else if (images.length) frame.ccbAnswer({ text: typeof message.text === "string" ? message.text : "", images });
    else if (typeof message.text === "string" && message.text.trim() !== "") frame.ccbAnswer({ text: message.text });
  } else if (message.ccb === "open" && typeof message.url === "string" && message.url !== "") {
    // Opened full-size the way a link chip is: a file in a window of its own.
    post({ type: "openURL", url: message.url, label: typeof message.label === "string" ? message.label : "" });
  } else if (message.ccb === "reviewWithCodex") {
    // Passed on as strings or null; Swift checks them against the bot's repository.
    post(codexReviewAction(message));
  } else if (message.ccb === "status") {
    // Only a pinned copy has a chip to set.
    if (frame.ccbPin) post(pinStatusAction(frame.ccbPin, message as { clear?: unknown; text?: unknown; tone?: unknown }));
  } else if (message.ccb === "runDetail" && event.source) {
    runDetail(frame, event.source, message.id, message.values);
  }
});

/** A component's `ccb.reviewWithCodex(...)` as the action Swift gets: anything but text is null. */
export function codexReviewAction(message: { scope?: unknown; commit?: unknown; spec?: unknown }): Action {
  const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
  return { type: "codexReview", scope: text(message.scope), commit: text(message.commit), spec: text(message.spec) };
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
  if (answer.index !== undefined) return { type: "choose", messageID, index: answer.index };
  const text = answer.text ?? "";
  const images = answer.images ?? [];
  if (images.length) return { type: "answer", messageID, text, images };
  if (text.trim() !== "") return { type: "answer", messageID, text };
  return null;
}

/**
 * A component with its report flag beside it (shown on hover), or nothing if no template.
 * `key` names this use of it (the message it is in), so a redraw keeps its height.
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
): HTMLElement | null {
  if (!info) return null;
  const wrap = document.createElement("div");
  wrap.className = "component";
  wrap.dataset.surface = surface;
  const frame = document.createElement("iframe") as ComponentFrame;
  frame.className = "component-frame";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.title = name;
  frame.ccbAnswer = onAnswer;
  frame.ccbDetail = detail ?? null;
  if (key) {
    frame.ccbKey = `${key}/${name}`;
    const height = frameHeights.get(frame.ccbKey);
    if (height) frame.style.height = `${height}px`;
  }
  // What it shows; the order of the pictures does not count (a Swift dictionary has none).
  const pictures = Object.entries(images ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  frame.ccbDrawn = JSON.stringify([name, info.template, info.version, data, pictures, fill]);
  const drawnSize = size ?? chatSize(info);
  frame.ccbSize = drawnSize;
  frame.srcdoc = componentPage(info.template, data, images ?? {}, drawnSize, surface, fill);
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
  if (old.tagName !== fresh.tagName) return fresh;
  const oldFrames = new Map<string, ComponentFrame>();
  for (const frame of old.querySelectorAll<ComponentFrame>("iframe.component-frame")) {
    if (frame.ccbKey && frame.ccbDrawn && !oldFrames.has(frame.ccbKey)) oldFrames.set(frame.ccbKey, frame);
  }
  if (!oldFrames.size) return fresh;
  // Each fresh element kept as its old one: the frames, and the elements around them.
  const kept = new Map<Element, Element>([[fresh, old]]);
  const keptFrames = new Set<Element>();
  for (const frame of fresh.querySelectorAll<ComponentFrame>("iframe.component-frame")) {
    const before = frame.ccbKey ? oldFrames.get(frame.ccbKey) : undefined;
    if (!before || before.ccbDrawn !== frame.ccbDrawn) continue;
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
    (before as ComponentFrame).ccbDetail = frame.ccbDetail;
  }
  if (!keptFrames.size) return fresh;
  const patch = (target: Element, source: Element) => {
    for (const { name } of [...target.attributes]) {
      if (!source.hasAttribute(name)) target.removeAttribute(name);
    }
    for (const { name, value } of [...source.attributes]) {
      if (target.getAttribute(name) !== value) target.setAttribute(name, value);
    }
    const wanted = [...source.childNodes].map((child) => {
      const match = child instanceof Element ? kept.get(child) : undefined;
      if (!match) return child;
      if (!keptFrames.has(child as Element)) patch(match, child as Element);
      return match;
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
  return old;
}

/** Where a card's command requests go instead of a chat card's (a pinned card's). */
export type CommandSend = (request: { command: string; folder: string; detail?: string; approve?: boolean; force?: boolean }) => void;

/** Cards whose command was asked to run once allowed, so a redraw does not ask again. */
const requestedRuns = new Set<string>();

const refreshIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`;

/**
 * A component whose data comes from a CLI command. Above it a bar names the command, when it
 * last ran, and a button to run it again. Until the user allows that command for the project
 * the card only asks (Swift remembers the answer); a failed run shows why instead of the
 * component. `draw` draws the component itself with the data the command gave.
 */
export function commandCard(
  display: DisplayView,
  messageID: string,
  index: number,
  draw: () => HTMLElement | null,
  options: { send?: CommandSend; bar?: boolean } = {},
): HTMLElement {
  const card = document.createElement("div");
  card.className = "command-card";
  const status = display.status ?? "approve";
  card.dataset.status = status;
  // With the command and folder this card shows: Swift allows and runs only what you saw.
  const shown: { command: string; folder: string; detail?: string } = { command: display.command ?? "", folder: display.folder ?? "" };
  if (display.detail) shown.detail = display.detail;
  const run = (extra: { approve?: boolean; force?: boolean }) =>
    options.send ? options.send({ ...shown, ...extra }) : post({ type: "componentCommand", messageID, index, ...shown, ...extra });
  const hasData = display.data !== "null" && display.data !== "";

  if (display.command && options.bar !== false) {
    const bar = document.createElement("div");
    bar.className = "command-bar";
    const text = document.createElement("code");
    text.className = "command-text";
    text.textContent = display.command;
    text.title = display.folder ? `Runs in ${display.folder}` : display.command;
    bar.append(text);
    const when = document.createElement("span");
    when.className = "command-when";
    when.textContent = status === "running" ? "Running…" : display.ranAt ? `Ran ${display.ranAt}` : "";
    bar.append(when);
    if (status !== "approve") {
      const refresh = document.createElement("button");
      refresh.className = "command-refresh" + (status === "running" ? " spinning" : "");
      refresh.setAttribute("aria-label", "Run the command again");
      refresh.title = "Run again";
      refresh.innerHTML = refreshIcon;
      refresh.disabled = status === "running" || status === "idle";
      refresh.addEventListener("click", () => run({ force: true }));
      bar.append(refresh);
    }
    card.append(bar);
  }

  if (status === "approve") {
    const ask = document.createElement("div");
    ask.className = "command-approve";
    const line = document.createElement("div");
    line.textContent = "This card gets its data by running a command in";
    const folder = document.createElement("code");
    folder.className = "command-folder";
    folder.textContent = display.folder ?? "the project folder";
    const command = document.createElement("pre");
    command.className = "command-full";
    command.textContent = display.command ?? "";
    const actions = document.createElement("div");
    actions.className = "command-actions";
    const allow = document.createElement("button");
    allow.className = "primary command-allow";
    allow.textContent = "Allow and run";
    allow.addEventListener("click", () => {
      allow.disabled = true;
      run({ approve: true });
    });
    const note = document.createElement("span");
    note.className = "command-note";
    note.textContent = "Remembered for this command in this project.";
    actions.append(allow, note);
    ask.append(line, folder, command);
    if (display.detail) {
      // Allowed with it: the command the component runs for more data when you ask it to.
      const also = document.createElement("div");
      also.className = "command-detail-line";
      also.textContent = "and, for details when you open one, with the {values} filled in:";
      const detail = document.createElement("pre");
      detail.className = "command-full command-detail";
      detail.textContent = display.detail;
      ask.append(also, detail);
    }
    ask.append(actions);
    card.append(ask);
  } else if (status === "failed") {
    const problem = document.createElement("div");
    problem.className = "command-error";
    problem.setAttribute("role", "alert");
    const title = document.createElement("strong");
    title.textContent = display.command ? "The command failed" : "Nothing to show";
    const detail = document.createElement("pre");
    detail.textContent = display.error ?? "";
    problem.append(title, detail);
    card.append(problem);
  } else if (status === "done" || (status === "running" && hasData)) {
    const component = draw();
    if (component) card.append(component);
  } else {
    // Allowed and not run yet (ask once per command and folder), or running for the first time.
    const key = JSON.stringify([messageID, index, shown.folder, shown.command]);
    if (status === "idle" && !requestedRuns.has(key)) {
      requestedRuns.add(key);
      run({});
    }
    const waiting = document.createElement("div");
    waiting.className = "command-waiting";
    waiting.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>Running the command…</span>`;
    card.append(waiting);
  }
  return card;
}

/** Plain buttons, for when the 「choices」 template is missing. */
export function fallbackChoices(choices: ChoiceView[], chosen: number | null, answer: string | null, onPick: ((i: number) => void) | null): HTMLElement {
  const list = document.createElement("div");
  list.className = "choices";
  const answered = chosen !== null || answer !== null;
  choices.forEach((choice, index) => {
    const button = document.createElement("button");
    button.className = "choice" + (choice.recommended && !answered ? " recommended" : "") + (chosen === index ? " picked" : "") + (answered && chosen !== index ? " faded" : "");
    button.disabled = answered || !onPick;
    const side = chosen === index ? "✓" : choice.recommended ? (choice.detail ? `Recommended · ${choice.detail}` : "Recommended") : (choice.detail ?? "");
    button.innerHTML = `<span>${escapeHTML(choice.label)}</span><span class="detail">${escapeHTML(side)}</span>`;
    button.addEventListener("click", () => onPick?.(index));
    list.append(button);
  });
  return list;
}

/** The flag beside a component: say what to change, or put back the previous version. */
function reportControl(name: string, info: ComponentInfo): HTMLElement {
  const side = document.createElement("div");
  side.className = "component-side";
  if (info.working) {
    side.innerHTML = `<span class="spinner" role="img" aria-label="Component being updated"></span>`;
  } else {
    const flag = document.createElement("button");
    flag.className = "flag";
    flag.setAttribute("aria-label", "Report this component");
    flag.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4h11l-2 4 2 4H5"/></svg>`;
    flag.addEventListener("click", (event) => {
      event.stopPropagation();
      openReport(flag, name, info);
    });
    side.append(flag);
  }
  if (info.updated) {
    const label = document.createElement("span");
    label.className = "updated";
    label.textContent = "Updated";
    side.append(label);
  }
  return side;
}

/**
 * The report box for `name`, from somewhere other than its flag (an opened pin's ⋯ menu): shown
 * by `anchor`, with a screenshot of the component drawn in `drawn`.
 */
export function reportComponent(anchor: HTMLElement, name: string, info: ComponentInfo, drawn: HTMLElement | null): void {
  openReport(anchor, name, info, drawn?.querySelector<HTMLElement>(".component-frame") ?? null);
}

/**
 * Say what to change, in words, pictures or both: a screenshot of the component as it is now
 * goes along unless you untick it, and pictures pasted (⌘V) or dropped on the box go too.
 */
function openReport(anchor: HTMLElement, name: string, info: ComponentInfo, frame?: HTMLElement | null): void {
  document.querySelector(".report")?.remove();
  const component = frame ?? anchor.closest(".component")?.querySelector<HTMLElement>(".component-frame") ?? null;
  const box = document.createElement("div");
  box.className = "report";
  box.innerHTML = `<div class="report-title">How should this component change?</div>
<textarea rows="3" placeholder="e.g. put the options in a row. Paste or drop a picture to show it."></textarea>
<div class="report-images" hidden></div>
${component ? `<label class="report-shot"><input type="checkbox" checked> Attach a screenshot of it as it is now</label>` : ""}
<div class="report-actions">${info.hasPrevious ? `<button class="plain revert">Revert to previous version</button>` : ""}<span></span><button class="primary send">Send</button></div>`;
  const textarea = box.querySelector("textarea")!;
  const send = box.querySelector<HTMLButtonElement>(".send")!;
  const strip = box.querySelector<HTMLElement>(".report-images")!;
  const shot = box.querySelector<HTMLInputElement>(".report-shot input");
  const images: { name: string; base64: string }[] = [];
  // The screenshot alone is not a request: words or a picture of your own are.
  const refresh = () => {
    send.disabled = textarea.value.trim() === "" && images.length === 0;
    strip.hidden = images.length === 0;
  };
  const addImage = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const image = { name: file.name || `Pasted image.${file.type.split("/")[1] ?? "png"}`, base64: url.slice(url.indexOf(",") + 1) };
      images.push(image);
      const item = document.createElement("div");
      item.className = "report-image";
      item.innerHTML = `<img alt=""><button class="remove" aria-label="Remove picture">×</button>`;
      item.querySelector("img")!.src = url;
      item.querySelector("img")!.alt = image.name;
      item.querySelector(".remove")!.addEventListener("click", () => {
        images.splice(images.indexOf(image), 1);
        item.remove();
        refresh();
      });
      strip.append(item);
      refresh();
    };
    reader.readAsDataURL(file);
  };
  textarea.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    files.forEach(addImage);
  });
  box.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    box.classList.add("dropping");
  });
  box.addEventListener("dragleave", () => box.classList.remove("dropping"));
  box.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files.length) return;
    // Pictures dropped here go with the report, not into the chat's input box.
    event.preventDefault();
    event.stopPropagation();
    box.classList.remove("dropping");
    [...event.dataTransfer.files].forEach(addImage);
  });
  refresh();
  textarea.addEventListener("input", refresh);
  send.addEventListener("click", () => {
    let rect: { x: number; y: number; width: number; height: number } | null = null;
    if (component && shot?.checked) {
      const bounds = component.getBoundingClientRect();
      rect = { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height };
    }
    // Out of the way first, so the screenshot shows the component and not this box.
    box.remove();
    requestAnimationFrame(() => post({ type: "componentReport", name, text: textarea.value.trim(), images, rect }));
  });
  box.querySelector(".revert")?.addEventListener("click", () => {
    post({ type: "componentRevert", name });
    box.remove();
  });
  document.body.append(box);
  const rect = anchor.getBoundingClientRect();
  // Beside the flag, but inside the window, also once pictures make it taller.
  const place = () => {
    box.style.top = `${Math.max(12, Math.min(rect.top - 8, window.innerHeight - box.offsetHeight - 12))}px`;
  };
  place();
  new ResizeObserver(place).observe(box);
  box.style.left = `${Math.min(rect.right + 8, window.innerWidth - 316)}px`;
  textarea.focus();
  const close = (event: MouseEvent) => {
    if (!box.contains(event.target as Node)) {
      box.remove();
      document.removeEventListener("mousedown", close);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}
