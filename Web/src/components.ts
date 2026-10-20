import { post } from "./bridge";
import { escapeHTML } from "./util";
import type { ChoiceView, ComponentInfo } from "./types";

/**
 * A component template inside its own iframe, so one template cannot break another or the chat.
 * The template sees `window.ccb` (data, answer, choose, send) as before; the frame reports its
 * height and answers to this page, which passes answers on to Swift.
 */
export function componentPage(template: string, data: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark">
<style>:root{color-scheme:dark}html,body{margin:0;padding:0;background:transparent;color:#EDEDF0;font:14px -apple-system,"PingFang TC",sans-serif;overflow:hidden}</style>
<script>
window.ccb = {
  data: ${data.replace(/</g, "\\u003c")},
  answer(value) {
    if (typeof value === 'number') parent.postMessage({ccb: 'answer', index: value}, '*');
    else parent.postMessage({ccb: 'answer', text: String(value)}, '*');
  },
  choose(index) { this.answer(Number(index)); },
  send(text) { this.answer(String(text)); }
};
// Templates written while the app was called Deck call deck.answer(...).
window.deck = window.ccb;
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

type AnswerHandler = (answer: { index?: number; text?: string }) => void;
type ComponentFrame = HTMLIFrameElement & { ccbAnswer?: AnswerHandler | null; ccbKey?: string };

/**
 * The height each component last had, by message and component. A redrawn frame starts at it
 * instead of collapsing to its default and growing again once loaded, which made the chat jump.
 */
const frameHeights = new Map<string, number>();

// Frames are found by their window when they speak, so a message sent before the frame's own
// load event is not lost.
window.addEventListener("message", (event) => {
  const message = event.data as { ccb?: string; height?: number; index?: number; text?: string };
  if (!message?.ccb) return;
  const frame = [...document.querySelectorAll<ComponentFrame>("iframe.component-frame")]
    .find((candidate) => candidate.contentWindow === event.source);
  if (!frame) return;
  if (message.ccb === "size" && typeof message.height === "number" && message.height > 0) {
    frame.style.height = `${message.height}px`;
    if (frame.ccbKey) frameHeights.set(frame.ccbKey, message.height);
  } else if (message.ccb === "answer" && frame.ccbAnswer) {
    if (typeof message.index === "number") frame.ccbAnswer({ index: message.index });
    else if (typeof message.text === "string" && message.text.trim() !== "") frame.ccbAnswer({ text: message.text });
  }
});

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
  frame.srcdoc = componentPage(info.template, data);
  wrap.append(frame, reportControl(name, info));
  return wrap;
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
