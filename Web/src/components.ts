import { post } from "./bridge";
import { escapeHTML } from "./util";
import type { Action, ChoiceView, ComponentInfo, DisplayView } from "./types";

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
 * The frame reports its height and answers to this page, which passes answers on to Swift.
 */
export function componentPage(template: string, data: string, images: Record<string, string> = {}): string {
  const safe = (json: string) => json.replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark">
<style>:root{color-scheme:dark}html,body{margin:0;padding:0;background:transparent;color:#EDEDF0;font:14px -apple-system,"PingFang TC",sans-serif;overflow:hidden}</style>
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
  window.ccb = {
    data: ${safe(data)},
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
</script></body></html>`;
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
type ComponentFrame = HTMLIFrameElement & { ccbAnswer?: AnswerHandler | null; ccbKey?: string; ccbDrawn?: string };

/**
 * The height each component last had, by message and component. A redrawn frame starts at it
 * instead of collapsing to its default and growing again once loaded, which made the chat jump.
 */
const frameHeights = new Map<string, number>();

// Frames are found by their window when they speak, so a message sent before the frame's own
// load event is not lost.
window.addEventListener("message", (event) => {
  const message = event.data as { ccb?: string; height?: number; index?: number; text?: string; images?: unknown; url?: string; label?: string; scope?: unknown; commit?: unknown; spec?: unknown };
  if (!message?.ccb) return;
  const frame = [...document.querySelectorAll<ComponentFrame>("iframe.component-frame")]
    .find((candidate) => candidate.contentWindow === event.source);
  if (!frame) return;
  if (message.ccb === "size" && typeof message.height === "number" && message.height > 0) {
    frame.style.height = `${message.height}px`;
    if (frame.ccbKey) frameHeights.set(frame.ccbKey, message.height);
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
): HTMLElement | null {
  if (!info) return null;
  const wrap = document.createElement("div");
  wrap.className = "component";
  const frame = document.createElement("iframe") as ComponentFrame;
  frame.className = "component-frame";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.title = name;
  frame.ccbAnswer = onAnswer;
  if (key) {
    frame.ccbKey = `${key}/${name}`;
    const height = frameHeights.get(frame.ccbKey);
    if (height) frame.style.height = `${height}px`;
  }
  // What it shows; the order of the pictures does not count (a Swift dictionary has none).
  const pictures = Object.entries(images ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  frame.ccbDrawn = JSON.stringify([name, info.template, info.version, data, pictures]);
  frame.srcdoc = componentPage(info.template, data, images ?? {});
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

/** Cards whose command was asked to run once allowed, so a redraw does not ask again. */
const requestedRuns = new Set<string>();

const refreshIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`;

/**
 * A component whose data comes from a CLI command. Above it a bar names the command, when it
 * last ran, and a button to run it again. Until the user allows that command for the project
 * the card only asks (Swift remembers the answer); a failed run shows why instead of the
 * component. `draw` draws the component itself with the data the command gave.
 */
export function commandCard(display: DisplayView, messageID: string, index: number, draw: () => HTMLElement | null): HTMLElement {
  const card = document.createElement("div");
  card.className = "command-card";
  const status = display.status ?? "approve";
  card.dataset.status = status;
  // With the command and folder this card shows: Swift allows and runs only what you saw.
  const shown = { command: display.command ?? "", folder: display.folder ?? "" };
  const run = (extra: { approve?: boolean; force?: boolean }) =>
    post({ type: "componentCommand", messageID, index, ...shown, ...extra });
  const hasData = display.data !== "null" && display.data !== "";

  if (display.command) {
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
    ask.append(line, folder, command, actions);
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
 * Say what to change, in words, pictures or both: a screenshot of the component as it is now
 * goes along unless you untick it, and pictures pasted (⌘V) or dropped on the box go too.
 */
function openReport(anchor: HTMLElement, name: string, info: ComponentInfo): void {
  document.querySelector(".report")?.remove();
  const component = anchor.closest(".component")?.querySelector<HTMLElement>(".component-frame") ?? null;
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
