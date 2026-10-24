import { post } from "./bridge";
import { t } from "./i18n";
import { shared } from "./contract";
import { imeGuardScript } from "./ime";
import { openMedia } from "./lightbox";
import { acceptPictures } from "./pictures";
import { LiveSchedule, liveTick, type LiveCard } from "./refresh";
import { onScreen, whenShownAgain } from "./visible";
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
 * - `runDetail(values)`: runs the component's `Detail command:` (about.md) with its `{name}`
 *   placeholders filled from `values` (`{hash: "2aed630"}`), in the folder its card's command
 *   runs in, once the user has allowed it there. Resolves to the output (parsed when it is JSON,
 *   else the text) or rejects with an Error saying why. `runDetail(values, {save: true})` (a
 *   "scan again" button whose output is the card's whole data) also makes the output the card's
 *   data, as its command's run: the card shows it running, and it finishes into the card even
 *   when the user opens another chat meanwhile; asking again while it runs waits for that run.
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
 * - `save(data)`: keeps `data` (anything JSON can hold but null, up to 256 KB) as this use of the
 *   component's data from now on, so it draws with it again, also after a restart: in its chat
 *   message, or on its pin (a pin keeps a copy of its own). It becomes `ccb.data`, does not lock
 *   the card or wake the bot (the bot hears the latest state with your next message), and the
 *   frame is not drawn again for it. Resolves once sent; rejects with an Error when the data cannot
 *   be kept or the component cannot save here (a card whose data comes from a command, a preview).
 * - `onData(fn)`: live data. Each new data for this card (its command ran again, a pin refreshed,
 *   the bot updated the card) calls `fn(data)` and becomes `ccb.data`, and the frame is kept
 *   instead of drawn anew. Returns a function that stops it.
 * - `load()`: resolves to the data it has now (the saved data, after `save`).
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
 * Before the template runs, the frame gets the input-method guard (`ime.ts`): a Return that commits
 * a Zhuyin or Pinyin candidate never reaches the template's keydown/keypress handlers or submits
 * its form, so a template's "send on Enter" is safe without checking anything itself.
 */
export function componentPage(template: string, data: string, images: Record<string, string> = {}, size: PinSize = "2x2", surface: Surface = "chat", fill = surface === "board", saving = false): string {
  const safe = (json: string) => json.replace(/</g, "\\u003c");
  return `<!doctype html><html data-size="${size}" data-surface="${surface}"${fill ? " data-fill" : ""}><head><meta charset="utf-8"><meta name="color-scheme" content="dark">
<style>:root{color-scheme:dark}html,body{margin:0;padding:0;background:transparent;color:#EDEDF0;font:14px -apple-system,"PingFang TC",sans-serif;overflow:hidden}
#ccb-root{container-type:inline-size;container-name:ccb}
html[data-surface="board"] #ccb-root{height:100%}
html[data-fill],html[data-fill] body,html[data-fill] #ccb-root{height:100%}html[data-fill] #ccb-root{container-type:size}
html[data-fill] body{overflow-y:auto;scrollbar-width:none}html[data-fill] body::-webkit-scrollbar{display:none}</style>
<script>
// First of all: an input method's Return (Zhuyin, Pinyin) never reaches the template's handlers.
${imeGuardScript}
(() => {
  const images = ${safe(JSON.stringify(images))};
  // Whether ccb.save keeps anything here.
  const canSave = ${saving ? "true" : "false"};
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
    // New data for a frame kept on screen (ccb.onData): its command ran again, or the bot updated it.
    if (typeof message.ccbData === 'string') {
      let next;
      try { next = JSON.parse(message.ccbData); } catch (error) { return; }
      window.ccb.data = next;
      for (const watcher of [...dataWatchers]) {
        try { watcher(next); } catch (error) { console.error(error); }
      }
      return;
    }
    if (typeof message.ccbDetail !== 'number') return;
    const call = details.get(message.ccbDetail);
    if (!call) return;
    details.delete(message.ccbDetail);
    if (message.ok) call.resolve(message.value);
    else call.reject(new Error(String(message.error || 'The Detail command failed.')));
  });
  const dataWatchers = new Set();
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
    onData(fn) {
      if (typeof fn !== 'function') return () => {};
      dataWatchers.add(fn);
      // The page keeps this frame from now on and sends it each new data instead of drawing it anew.
      parent.postMessage({ccb: 'live'}, '*');
      return () => dataWatchers.delete(fn);
    },
    load() { return Promise.resolve(window.ccb.data); },
    save(value) {
      if (!canSave) return Promise.reject(new Error('This component cannot save here: its data comes from a command, or it is a preview.'));
      let json;
      try { json = JSON.stringify(value); } catch (error) { return Promise.reject(new Error('ccb.save takes data JSON can hold: ' + error.message)); }
      if (json === undefined || json === 'null') return Promise.reject(new Error('ccb.save needs data (not null or undefined).'));
      if (json.length > ${saveLimit}) return Promise.reject(new Error('The data is too big to save (at most ${saveLimit} characters of JSON).'));
      window.ccb.data = JSON.parse(json);
      parent.postMessage({ccb: 'save', data: json}, '*');
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
    setStatus(status) {
      if (status == null) parent.postMessage({ccb: 'status', clear: true}, '*');
      else if (typeof status === 'object') parent.postMessage({ccb: 'status', text: status.text == null ? '' : String(status.text), tone: status.tone == null ? null : String(status.tone)}, '*');
      else parent.postMessage({ccb: 'status', text: String(status), tone: null}, '*');
      return Promise.resolve();
    },
    runDetail(values, options) {
      const save = !!(options && typeof options === 'object' && options.save);
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
        parent.postMessage(save ? {ccb: 'runDetail', id, values: given, save} : {ccb: 'runDetail', id, values: given}, '*');
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

/** The most `ccb.save` keeps, as JSON characters (UTF-16 code units; Swift's `ComponentState.limit`). */
export const saveLimit = shared.saveLimit;

/**
 * Where a component is drawn: in the chat, as a tile on the Board, or "pinned": opened from its
 * chip above the input box, filling that panel.
 */
export type Surface = "chat" | "board" | "pinned";

/** The most cells a Board card spans each way (Swift's `PinnedComponent.Size`). */
export const maxColumns = shared.board.maxColumns;
export const maxRows = shared.board.maxRows;

/** Every Board size, row by row: 1×1, 2×1, … 4×4. */
export const pinSizes: PinSize[] = Array.from({ length: maxRows }, (_, row) =>
  Array.from({ length: maxColumns }, (_, column) => `${column + 1}x${row + 1}` as PinSize)).flat();

/** A size of `w`×`h` cells, each kept within 1…`maxColumns` and 1…`maxRows`. */
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

/**
 * The nearest named size to `w`×`h` ("small", "wide", "tall", "large", "xlarge"), as Swift names
 * every size (`PinnedComponent.Size.name`, sent in the contract).
 */
export function sizeName(w: number, h: number): string {
  return shared.board.sizeNames[pinSize(w, h)] ?? "large";
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
/** Where a component's `ccb.save(data)` goes, as the JSON it saved. */
export type SaveHandler = (json: string) => void;
/**
 * A component's frame: its answer handler, the use it is (`ccbKey`), and what it was drawn from
 * (`ccbDrawn`), so a redrawn message can keep a frame whose component did not change.
 */
type ComponentFrame = HTMLIFrameElement & { ccbPending?: string | null; ccbAnswer?: AnswerHandler | null; ccbSave?: SaveHandler | null; ccbKey?: string; ccbDrawn?: string; ccbDrawnFor?: (data: string) => string; ccbShape?: string; ccbData?: string; ccbLive?: boolean; ccbDetail?: DetailTarget | null; ccbSize?: PinSize; ccbPin?: string | null; ccbIncoming?: ComponentFrame | null };

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

/**
 * Where a frame's `ccb.runDetail` goes: its component, and the folder its card showed; with the
 * card and its command when its data comes from one (what `{save: true}` saves into).
 */
export interface DetailTarget {
  name: string;
  folder: string;
  card?: string;
  command?: string;
}

/** The DetailTarget a card's display gives, when its component has a Detail command. */
export function detailTarget(display: DisplayView): DetailTarget | null {
  if (!display.detail || !display.folder) return null;
  const target: DetailTarget = { name: display.name, folder: display.folder };
  if (display.card && display.command) {
    target.card = display.card;
    target.command = display.command;
  }
  return target;
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
function builtFrames(element: Element): boolean {
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
function keepReading(frame: HTMLElement, before: DOMRect, height: number): void {
  const scroller = frame.closest<HTMLElement>("#scroller");
  if (!scroller) return;
  const delta = height - before.height;
  if (!delta || before.bottom > scroller.getBoundingClientRect().top + 1) return;
  scroller.scrollTop += delta;
}

// Frames are found by their window when they speak, so a message sent before the frame's own
// load event is not lost.
window.addEventListener("message", (event) => {
  const message = event.data as { ccb?: string; height?: number; index?: number; text?: string; images?: unknown; url?: string; label?: string; scope?: unknown; commit?: unknown; spec?: unknown; id?: unknown; values?: unknown };
  if (!message?.ccb) return;
  const frame = [...document.querySelectorAll<ComponentFrame>("iframe.component-frame")]
    .find((candidate) => candidate.contentWindow === event.source);
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
    if (typeof message.index === "number") frame.ccbAnswer({ index: message.index });
    else if (images.length) frame.ccbAnswer({ text: typeof message.text === "string" ? message.text : "", images });
    else if (typeof message.text === "string" && message.text.trim() !== "") frame.ccbAnswer({ text: message.text });
  } else if (message.ccb === "open" && typeof message.url === "string" && message.url !== "") {
    // Opened full-size the way a link chip is: a picture in the lightbox, a page in a window of its own.
    openMedia(message.url, typeof message.label === "string" ? message.label : "");
  } else if (message.ccb === "status") {
    // Only a pinned copy has a chip to set.
    if (frame.ccbPin) post(pinStatusAction(frame.ccbPin, message as { clear?: unknown; text?: unknown; tone?: unknown }));
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

/** How long a frame drawing new data behind the shown one may take before it is shown anyway, in ms. */
export const redrawWait = 2000;

/** Runs `work` after the next frame is painted (at once where there are no frames, as in a test). */
function afterPaint(work: () => void): void {
  if (typeof requestAnimationFrame !== "function") return work();
  requestAnimationFrame(() => requestAnimationFrame(work));
}

/**
 * New data for `shown`, a frame that reads its data only as it loads (no ccb.onData): `next`, a
 * frame with the new page, loads hidden right over it, and once it has loaded and painted it
 * takes `shown`'s place in one step. So a card that refreshes never shows a blank frame: the
 * old drawing stays until the new one is ready. Newer data while `next` loads replaces `next`.
 */
function drawBehind(shown: ComponentFrame, next: ComponentFrame): void {
  shown.ccbIncoming?.remove();
  const page = next.ccbPending;
  next.ccbPending = null;
  next.classList.remove("pending");
  next.classList.add("incoming");
  // Over the shown frame, as big as it is; hidden and out of the way until it is ready.
  next.style.position = "absolute";
  next.style.left = `${shown.offsetLeft}px`;
  next.style.top = `${shown.offsetTop}px`;
  next.style.width = `${shown.offsetWidth}px`;
  next.style.setProperty("height", shown.style.height || `${shown.offsetHeight}px`, "important");
  shown.ccbIncoming = next;
  // It shows that data from now on: a redraw with it again changes nothing.
  shown.ccbDrawn = next.ccbDrawn;
  shown.ccbData = next.ccbData;
  let done = false;
  const swap = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (shown.ccbIncoming !== next) return;
    shown.ccbIncoming = null;
    if (!next.isConnected) return;
    if (!shown.isConnected) return next.remove();
    next.ccbAnswer = shown.ccbAnswer;
    next.ccbSave = shown.ccbSave;
    next.ccbDetail = shown.ccbDetail;
    next.ccbPin = shown.ccbPin ?? next.ccbPin;
    if (shown.ccbSize && next.ccbSize !== shown.ccbSize) resizeFrame(next, shown.ccbSize);
    for (const name of ["position", "left", "top", "width"]) next.style.removeProperty(name);
    // As tall as it said it is, or else as the shown one.
    if (next.style.getPropertyPriority("height") === "important") next.style.height = shown.style.height;
    // Not moved in the page (it would load again): the old one goes and the new one shows.
    const box = shown.getBoundingClientRect();
    shown.remove();
    next.classList.remove("incoming");
    const height = parseFloat(next.style.height);
    if (height > 0) keepReading(next, box, height);
  };
  const timer = setTimeout(swap, redrawWait);
  next.addEventListener("load", () => afterPaint(swap), { once: true });
  shown.after(next);
  if (page != null) next.srcdoc = page;
}

/** Where a card's command requests go instead of a chat card's (a pinned card's). */
export type CommandSend = (request: { command: string; folder: string; detail?: string; approve?: boolean; force?: boolean; live?: boolean }) => void;

/** Cards whose command was asked to run once allowed, so a redraw does not ask again. */
const requestedRuns = new Set<string>();

const refreshIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`;

/**
 * A component whose data comes from a CLI command. Above it a bar names the command, when it
 * last ran, and a button to run it again. Until the user allows that command for the project
 * the card only asks (Swift remembers the answer); a failed run shows why instead of the
 * component. `draw` draws the component itself with the data the command gave.
 */
/** Whether `element` holds a component frame (one `keepFrames` may keep). */
export function hasFrame(element: Element | null): boolean {
  return !!element?.querySelector("iframe.component-frame");
}

/**
 * Cards that refresh by themselves (`Refresh: every 2s`): what runs each one again, by its card,
 * the newest drawing's (a redraw may keep the old element, so the element holds only the key),
 * and when each is due. A card is due `every` seconds after it was first seen done (or failed);
 * it then runs once the user can see it (`onScreen`, visible.ts), and counts again once it is drawn
 * done again, so a run is never asked for while one is going.
 */
const liveRuns = new Map<string, () => void>();
const liveSchedule = new LiveSchedule();
let liveTimer: ReturnType<typeof setInterval> | null = null;

// Shown again (the window was minimized, hidden or covered): those overdue run at once.
whenShownAgain(() => refreshDueCards());

/** Runs the cards whose time has come and that are on screen; how many ran. */
export function refreshDueCards(now = Date.now()): number {
  const cards = [...document.querySelectorAll<HTMLElement>(".command-card[data-every]")];
  const ran = liveSchedule.tick(cards.map((card): LiveCard => {
    const key = card.dataset.liveKey ?? "";
    return {
      key,
      every: Number(card.dataset.every),
      idle: card.dataset.status === "done" || card.dataset.status === "failed",
      // Not seen (visible.ts: the window shown, its tab showing, scrolled into view), or its
      // frame not built yet (it is built once near): it waits.
      ready: () => onScreen(card) && builtFrames(card),
      run: () => liveRuns.get(key)?.(),
    };
  }), now);
  if (!cards.length && liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
    liveSchedule.clear();
  }
  return ran;
}

function watchLiveCards(): void {
  liveTimer ??= setInterval(() => refreshDueCards(), liveTick);
}

export function commandCard(
  display: DisplayView,
  messageID: string,
  index: number,
  draw: () => HTMLElement | null,
  options: { send?: CommandSend; bar?: boolean; lazy?: boolean } = {},
): HTMLElement {
  const card = document.createElement("div");
  card.className = "command-card";
  const status = display.status ?? "approve";
  card.dataset.status = status;
  // With the command and folder this card shows: Swift allows and runs only what you saw.
  const shown: { command: string; folder: string; detail?: string } = { command: display.command ?? "", folder: display.folder ?? "" };
  if (display.detail) shown.detail = display.detail;
  const run = (extra: { approve?: boolean; force?: boolean; live?: boolean }) =>
    options.send ? options.send({ ...shown, ...extra }) : post({ type: "componentCommand", messageID, index, ...shown, ...extra });
  const hasData = display.data !== "null" && display.data !== "";
  // Runs again by itself every so often while on screen (its about.md's Refresh line).
  if (display.command && typeof display.every === "number" && display.every > 0) {
    const key = `${messageID}/${index}`;
    card.dataset.every = String(Math.max(1, display.every));
    card.dataset.liveKey = key;
    liveRuns.set(key, () => run({ force: true, live: true }));
    watchLiveCards();
  }

  if (display.command && options.bar !== false) {
    const bar = document.createElement("div");
    bar.className = "command-bar";
    const text = document.createElement("code");
    text.className = "command-text";
    text.textContent = display.command;
    text.title = display.folder ? t("command.runsIn", { folder: display.folder }) : display.command;
    bar.append(text);
    const when = document.createElement("span");
    when.className = "command-when";
    const every = typeof display.every === "number" && display.every > 0
      ? display.every < 60 ? t("command.everySeconds", { n: display.every }) : t("command.everyMinutes", { n: Math.round(display.every / 60) })
      : "";
    // A card that refreshes by itself says how often, and does not flash "Running…" each time.
    when.textContent = every
      ? [display.ranAt ? t("command.ran", { when: display.ranAt }) : "", every].filter(Boolean).join(" · ")
      : status === "running" ? t("command.running") : display.ranAt ? t("command.ran", { when: display.ranAt }) : "";
    bar.append(when);
    if (status !== "approve") {
      const refresh = document.createElement("button");
      refresh.className = "command-refresh" + (status === "running" ? " spinning" : "");
      refresh.setAttribute("aria-label", t("command.runAgainLabel"));
      refresh.title = t("command.runAgain");
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
    line.textContent = t("command.approveLine");
    const folder = document.createElement("code");
    folder.className = "command-folder";
    folder.textContent = display.folder ?? t("command.projectFolder");
    const command = document.createElement("pre");
    command.className = "command-full";
    command.textContent = display.command ?? "";
    const actions = document.createElement("div");
    actions.className = "command-actions";
    const allow = document.createElement("button");
    allow.className = "primary command-allow";
    allow.textContent = t("command.allow");
    allow.addEventListener("click", () => {
      allow.disabled = true;
      run({ approve: true });
    });
    const note = document.createElement("span");
    note.className = "command-note";
    note.textContent = t("command.remembered");
    actions.append(allow, note);
    ask.append(line, folder, command);
    if (display.detail) {
      // Allowed with it: the command the component runs for more data when you ask it to.
      const also = document.createElement("div");
      also.className = "command-detail-line";
      also.textContent = t("command.detailLine");
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
    title.textContent = display.command ? t("command.failed") : t("command.nothing");
    const detail = document.createElement("pre");
    detail.textContent = display.error ?? "";
    problem.append(title, detail);
    card.append(problem);
  } else if (status === "done" || (status === "running" && hasData)) {
    const component = draw();
    if (component) card.append(component);
  } else {
    // Allowed and not run yet (ask once per command and folder), or running for the first time.
    // In the chat's history only once it comes near the visible chat: opening a long chat after
    // a restart ran every card's command at once.
    const key = JSON.stringify([messageID, index, shown.folder, shown.command]);
    const waiting = document.createElement("div");
    waiting.className = "command-waiting";
    waiting.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${escapeHTML(t("command.runningFirst"))}</span>`;
    const first = () => {
      if (requestedRuns.has(key)) return;
      requestedRuns.add(key);
      run({});
    };
    if (status === "idle" && !requestedRuns.has(key) && !(options.lazy && whenNear(waiting, first))) first();
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
    const side = chosen === index ? "✓" : choice.recommended ? (choice.detail ? `${t("choices.recommended")} · ${choice.detail}` : t("choices.recommended")) : (choice.detail ?? "");
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
    side.innerHTML = `<span class="spinner" role="img" aria-label="${escapeHTML(t("component.updating"))}"></span>`;
  } else {
    const flag = document.createElement("button");
    flag.className = "flag";
    flag.setAttribute("aria-label", t("component.report"));
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
    label.textContent = t("component.updated");
    side.append(label);
  }
  return side;
}

/**
 * "Report a problem…", from a card's ⋯ menu (a reply's card, an opened pin, a Board tile, a
 * floating card): the report box shown by `anchor`, asking what's wrong, with a screenshot of the
 * card drawn in `drawn` (its component's frame, else all of it). Sent, it goes to Maintainer
 * with the card's pin (`pinID`), so Swift can say whose chat it is in, how it refreshes and when
 * its data is from; "Sent to Maintainer" says it went.
 */
export function reportComponent(anchor: HTMLElement, name: string, info: ComponentInfo, drawn: HTMLElement | null, pinID?: string): void {
  const frame = drawn ? drawn.querySelector<HTMLElement>(".component-frame") ?? drawn : null;
  openReport(anchor, name, info, frame, { pinID: pinID ?? null });
}

/** "Sent to Maintainer", for a moment, where a pin's Undo shows. */
function sentToast(): void {
  document.querySelector(".pin-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "pin-toast";
  toast.setAttribute("role", "status");
  toast.textContent = t("component.sentToMaintainer");
  document.body.append(toast);
  setTimeout(() => toast.remove(), 3000);
}

/**
 * Say what to change, in words, pictures or both: a screenshot of the component as it is now
 * goes along unless you untick it, and pictures pasted (⌘V) or dropped on the box go too. From
 * a menu (`problem`) it asks what's wrong, has Cancel, and says when it was sent.
 */
function openReport(anchor: HTMLElement, name: string, info: ComponentInfo, frame?: HTMLElement | null, problem?: { pinID: string | null }): void {
  document.querySelector(".report")?.remove();
  const component = frame ?? anchor.closest(".component")?.querySelector<HTMLElement>(".component-frame") ?? null;
  const box = document.createElement("div");
  box.className = "report";
  const title = problem ? t("component.problemQuestion") : t("component.changeQuestion");
  const placeholder = problem ? t("component.problemPlaceholder") : t("component.changePlaceholder");
  const shotWords = problem ? t("component.attachCardShot") : t("component.attachShot");
  const cancel = problem ? `<button class="plain cancel">${escapeHTML(t("common.cancel"))}</button>` : "";
  box.innerHTML = `<div class="report-title">${escapeHTML(title)}</div>
<textarea rows="3" placeholder="${escapeHTML(placeholder)}"></textarea>
<div class="report-images" hidden></div>
${component ? `<label class="report-shot"><input type="checkbox" checked> ${escapeHTML(shotWords)}</label>` : ""}
<div class="report-actions">${info.hasPrevious ? `<button class="plain revert">${escapeHTML(t("component.revert"))}</button>` : ""}<span></span>${cancel}<button class="primary send">${escapeHTML(t("composer.send"))}</button></div>`;
  const textarea = box.querySelector("textarea")!;
  const send = box.querySelector<HTMLButtonElement>(".send")!;
  const strip = box.querySelector<HTMLElement>(".report-images")!;
  const shot = box.querySelector<HTMLInputElement>(".report-shot input");
  // The screenshot alone is not a request: words or a picture of your own are.
  const refresh = () => {
    send.disabled = textarea.value.trim() === "" && images.length === 0;
    strip.hidden = images.length === 0;
  };
  const images = acceptPictures(box, textarea, strip, refresh);
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
    const text = textarea.value.trim();
    requestAnimationFrame(() => post(problem
      ? { type: "componentReport", name, text, images, rect, problem: true, ...(problem.pinID ? { pinID: problem.pinID } : {}) }
      : { type: "componentReport", name, text, images, rect }));
    if (problem) sentToast();
  });
  box.querySelector(".cancel")?.addEventListener("click", () => box.remove());
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
