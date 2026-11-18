import { sourceSnapshotScript } from "./source-snapshot";
import { shared } from "./contract";
import { imeGuardScript } from "./ime";
import { componentTokensCss, tokenListenerScript } from "./component-tokens";
import { kitV1 } from "../kit/generated/kit-v1";
import type { ChoiceView, ComponentInfo, DisplayView, PinSize } from "./types";

/**
 * A component template inside its own iframe, so one template cannot break another or the chat.
 * The template sees `window.ccb` (also `window.deck`):
 * - `data`: what the bot gave.
 * - `answer(value)`: a number picks an option by index, text is a typed answer, and
 *   `{text, images}` sends words with pictures (`images`: File/Blob objects, data: URLs, or
 *   `{name, base64}`); the bot gets the pictures as saved files, like a message's attachments.
 *   `{index, text, images}` preserves a choice together with its notes/pictures.
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
 *
 * Tokens a plugin pushed (`component-tokens.ts`) come as `<style id="ccb-tokens">:root{…}</style>` right after that style, with a
 * listener that takes later changes from the parent; with none the page is byte for byte what it was.
 * A template with `<meta name="ccb-kit" content="1">` also gets the component kit (Web/kit,
 * README.md there): its text right after the ccb runtime, in <head>, and `<html data-theme="dark">`
 * for its tokens. A template without that meta gets exactly the page it got before the kit.
 */
export function componentPage(template: string, data: string, images: Record<string, string> = {}, size: PinSize = "2x2", surface: Surface = "chat", fill = surface === "board", saving = false, reportReady: boolean | "quick" = false): string {
  const safe = (json: string) => json.replace(/</g, "\\u003c");
  const kit = kitScript(template);
  // The tokens plugins push (component-tokens.ts): none, and the page is what it was before they existed.
  const tokenCss = componentTokensCss();
  const tokens = tokenCss ? `<style id="ccb-tokens">${tokenCss}</style><script>${tokenListenerScript}</script>` : "";
  // A page a frame hands over to (component-live.ts `drawBehind`) says when it is ready; any other page is what it was.
  const ready = reportReady ? readyScript(reportReady !== "quick") : "";
  return `<!doctype html><html${kit ? ` data-theme="${kitTheme}"` : ""} data-size="${size}" data-surface="${surface}"${fill ? " data-fill" : ""}><head><meta charset="utf-8"><meta name="color-scheme" content="dark">
<style>:root{color-scheme:dark}html,body{margin:0;padding:0;background:transparent;color:#EDEDF0;font:14px -apple-system,"PingFang TC",sans-serif;overflow:hidden}
#ccb-root{container-type:inline-size;container-name:ccb}
html[data-surface="board"] #ccb-root{height:100%}
html[data-fill],html[data-fill] body,html[data-fill] #ccb-root{height:100%}html[data-fill] #ccb-root{container-type:size}
html[data-fill] body{overflow-y:auto;scrollbar-width:none}html[data-fill] body::-webkit-scrollbar{display:none}</style>${tokens}
<script>
${sourceSnapshotScript}
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
          parent.postMessage({ccb: 'answer', ...(Number.isInteger(value.index) && value.index >= 0 ? {index: value.index} : {}), text, images: list.filter(Boolean)}, '*');
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
</script>${kit}</head><body><div id="ccb-root">
${template}
</div><script>
const ccbRoot = document.getElementById('ccb-root');
const ccbSize = () => parent.postMessage({ccb: 'size', height: Math.ceil(ccbRoot.getBoundingClientRect().height)}, '*');
new ResizeObserver(ccbSize).observe(ccbRoot);
window.addEventListener('load', ccbSize);
// The pointer over it, for the Board tile's controls (a parent page cannot always see it).
document.documentElement.addEventListener('mouseenter', () => parent.postMessage({ccb: 'hover', on: true}, '*'));
document.documentElement.addEventListener('mouseleave', () => parent.postMessage({ccb: 'hover', on: false}, '*'));
</script>${ready}</body></html>`;
}

/**
 * What a page that is handed over to (a new drawing behind the one on screen) says once it can take that one's place:
 * the page has loaded (never the empty page a frame starts with), its fonts and (unless `waitImages` is false: a page asked
 * for again after one that never got ready) its pictures are decoded, and it has been painted twice. `{ccb: "ready", height}`,
 * once; the height is 0 for a page with nothing in it, and the parent then keeps the height it has.
 */
const readyScript = (waitImages: boolean) => `<script>
(() => {
  let sent = false;
  const root = document.getElementById('ccb-root');
  // The next painted frame; a page that is not drawn on screen (behind another, in a window out of sight) may be given none, so a short timer stands in.
  const frame = () => new Promise((resolve) => {
    let over = false;
    const go = () => { if (!over) { over = true; resolve(); } };
    requestAnimationFrame(go);
    setTimeout(go, 100);
  });
  const settle = async () => {
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (error) {}
${waitImages ? `    try { await Promise.all([...document.images].map((image) => (image.decode ? image.decode().catch(() => {}) : null))); } catch (error) {}
` : ""}    await frame();
    await frame();
    if (sent) return;
    sent = true;
    parent.postMessage({ccb: 'ready', height: Math.max(0, Math.ceil(root.getBoundingClientRect().height))}, '*');
  };
  if (document.readyState === 'complete') settle();
  else window.addEventListener('load', settle);
})();
</script>`;

/** The kits a template can ask for, by major version: a new major version is added beside the old ones. */
const kits: Record<string, string> = { "1": kitV1 };
/** The theme a kit page starts in; the kit then follows the chat's look (prefers-color-scheme, Web/kit/src/index.js). */
const kitTheme = "dark";
const kitMeta = /<meta\s+(?:name\s*=\s*["']ccb-kit["']\s+content\s*=\s*["']([^"']*)["']|content\s*=\s*["']([^"']*)["']\s+name\s*=\s*["']ccb-kit["'])\s*\/?>/i;

/** The <script> that puts the kit a template's `<meta name="ccb-kit" content="N">` asks for into its page ("" without one). */
function kitScript(template: string): string {
  const match = template.match(kitMeta);
  if (!match) return "";
  const version = (match[1] ?? match[2] ?? "").trim();
  const kit = kits[version];
  if (kit) return `<script>\n${kit}\n</script>`;
  const message = JSON.stringify(`This app has no component kit version ${version || "(empty)"}: <meta name="ccb-kit" content="…"> takes ${Object.keys(kits).join(", ")}.`).replace(/</g, "\\u003c");
  return `<script>addEventListener('DOMContentLoaded',()=>{const d=document.createElement('pre');d.className='ccb-kit-missing';d.style.cssText='margin:8px;padding:10px 12px;border:1px solid #FF8A80;border-radius:10px;color:#FF8A80;white-space:pre-wrap;font:12px ui-monospace,Menlo,monospace';d.textContent=${message};document.getElementById('ccb-root').prepend(d);try{ccb.setStatus({text:'Error',tone:'bad'})}catch(e){}});</script>`;
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

/** The most options one question carries (the app's `QUESTION_OPTIONS_MAX`, desktop/src/contract/views.ts; the page is its own package). */
const QUESTION_OPTIONS_MAX = 12;

/**
 * A question group's answers as a template sent them, checked; null when not a group answer. A 「choices」 template
 * that draws groups posts them itself, `parent.postMessage({ccb: "answer", picks}, "*")` (the page script stays as it was).
 */
export function answerPicks(value: unknown): NonNullable<ComponentAnswer["picks"]> | null {
  if (!Array.isArray(value) || !value.length || value.length > 5) return null;
  const picks = value.map((entry) => {
    const pick = (entry ?? {}) as { options?: unknown; other?: unknown; skipped?: unknown; notes?: unknown };
    const options = Array.isArray(pick.options) ? pick.options.filter((option): option is number => Number.isInteger(option) && (option as number) >= 0 && (option as number) < QUESTION_OPTIONS_MAX).slice(0, QUESTION_OPTIONS_MAX) : [];
    // A note the template wrote on a ticked option (its speech bubble), keyed by that option's index.
    const notes: Record<string, string> = {};
    if (pick.notes && typeof pick.notes === "object" && !Array.isArray(pick.notes)) {
      for (const index of options) {
        const note = (pick.notes as Record<string, unknown>)[String(index)];
        if (typeof note === "string" && note.trim()) notes[String(index)] = note.trim().slice(0, 1_000);
      }
    }
    return { options, ...(typeof pick.other === "string" && pick.other.trim() ? { other: pick.other.trim().slice(0, 1_000) } : {}), ...(pick.skipped === true ? { skipped: true } : {}), ...(Object.keys(notes).length ? { notes } : {}) };
  });
  return picks;
}

/** Whether the 「choices」 template draws question groups itself (its root says `data-ccb-questions`); else the app draws them. */
export function choicesDrawGroups(info: ComponentInfo | undefined): boolean {
  return !!info?.template.includes("data-ccb-questions");
}

/** The data a 「choices」 template that draws groups reads: every question, the picks once answered, and the 1.x keys. */
export function questionGroupData(questions: { question: string; multiple: boolean; options: ChoiceView[] }[], picks: { options: number[]; other: string | null; skipped: boolean; notes?: Record<string, string> | null }[] | null, answer: string | null): string {
  return JSON.stringify({ questions, picks, options: questions[0]?.options ?? [], chosen: null, answer });
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
  /** A question group's answers, one per question in order (question-group.ts, or a 「choices」 template that draws groups). */
  picks?: { options: number[]; other?: string; skipped?: boolean; notes?: Record<string, string> }[];
}

export type AnswerHandler = (answer: ComponentAnswer) => void;
/** Where a component's `ccb.save(data)` goes, as the JSON it saved. */
export type SaveHandler = (json: string) => void;
/**
 * A component's frame: its answer handler, the use it is (`ccbKey`), and what it was drawn from
 * (`ccbDrawn`), so a redrawn message can keep a frame whose component did not change.
 */
export type ComponentFrame = HTMLIFrameElement & { ccbPending?: string | null; ccbAnswer?: AnswerHandler | null; ccbSave?: SaveHandler | null; ccbKey?: string; ccbDrawn?: string; ccbDrawnFor?: (data: string) => string; ccbShape?: string; ccbData?: string; ccbLive?: boolean; ccbDetail?: DetailTarget | null; ccbSize?: PinSize; ccbStatus?: StatusHandler | null; ccbIncoming?: ComponentFrame | null; ccbQueued?: ComponentFrame; ccbGaveUp?: string; ccbReady?: ((height: number) => void) | null; ccbSized?: number; ccbShownDrawn?: { drawn: string | undefined; data: string | undefined }; ccbImages?: Record<string, string>; ccbBuild?: (quick?: boolean) => string; ccbTokens?: boolean };

/** What a frame's `ccb.setStatus(...)` is told to: `{clear}` or `{text, tone}` as the frame sent them. */
export type StatusHandler = (message: { clear?: unknown; text?: unknown; tone?: unknown }) => void;

/** Gives the component frames in `element` a place for their `ccb.setStatus(...)` to go (a plugin's pinned copy has a chip to set). */
export function markStatusFrames(element: HTMLElement | null, handler: StatusHandler): void {
  for (const frame of element?.querySelectorAll<ComponentFrame>("iframe.component-frame") ?? []) frame.ccbStatus = handler;
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
