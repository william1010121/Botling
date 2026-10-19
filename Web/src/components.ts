import { post } from "./bridge";
import { escapeHTML } from "./math";
import type { ChoiceView, ComponentInfo } from "./types";

/**
 * A component template inside its own iframe, so one template cannot break another or the chat.
 * The template sees `window.deck` (data, answer, choose, send) as before; the frame reports its
 * height and answers to this page, which passes answers on to Swift.
 */
export function componentPage(template: string, data: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark">
<style>:root{color-scheme:dark}html,body{margin:0;padding:0;background:transparent;color:#EDEDF0;font:14px -apple-system,"PingFang TC",sans-serif;overflow:hidden}</style>
<script>
window.deck = {
  data: ${data},
  answer(value) {
    if (typeof value === 'number') parent.postMessage({deck: 'answer', index: value}, '*');
    else parent.postMessage({deck: 'answer', text: String(value)}, '*');
  },
  choose(index) { this.answer(Number(index)); },
  send(text) { this.answer(String(text)); }
};
</script></head><body><div id="deck-root">
${template}
</div><script>
const deckRoot = document.getElementById('deck-root');
const deckSize = () => parent.postMessage({deck: 'size', height: Math.ceil(deckRoot.getBoundingClientRect().height)}, '*');
new ResizeObserver(deckSize).observe(deckRoot);
window.addEventListener('load', deckSize);
</script></body></html>`;
}

/** The choices data a 「choices」 template reads. */
export function choicesData(choices: ChoiceView[], chosen: number | null, answer: string | null): string {
  return JSON.stringify({ options: choices, chosen, answer });
}

type AnswerHandler = (answer: { index?: number; text?: string }) => void;
type ComponentFrame = HTMLIFrameElement & { deckAnswer?: AnswerHandler | null };

// Frames are found by their window when they speak, so a message sent before the frame's own
// load event is not lost.
window.addEventListener("message", (event) => {
  const message = event.data as { deck?: string; height?: number; index?: number; text?: string };
  if (!message?.deck) return;
  const frame = [...document.querySelectorAll<ComponentFrame>("iframe.component-frame")]
    .find((candidate) => candidate.contentWindow === event.source);
  if (!frame) return;
  if (message.deck === "size" && typeof message.height === "number" && message.height > 0) {
    frame.style.height = `${message.height}px`;
  } else if (message.deck === "answer" && frame.deckAnswer) {
    if (typeof message.index === "number") frame.deckAnswer({ index: message.index });
    else if (typeof message.text === "string" && message.text.trim() !== "") frame.deckAnswer({ text: message.text });
  }
});

/** A component with its report flag beside it (shown on hover), or nothing if no template. */
export function componentElement(
  name: string,
  info: ComponentInfo | undefined,
  data: string,
  onAnswer: AnswerHandler | null,
): HTMLElement | null {
  if (!info) return null;
  const wrap = document.createElement("div");
  wrap.className = "component";
  const frame = document.createElement("iframe") as ComponentFrame;
  frame.className = "component-frame";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.title = name;
  frame.deckAnswer = onAnswer;
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
    const side = chosen === index ? "✓" : choice.recommended ? (choice.detail ? `建議 · ${choice.detail}` : "建議") : (choice.detail ?? "");
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
    side.innerHTML = `<span class="spinner" role="img" aria-label="組件改版中"></span>`;
  } else {
    const flag = document.createElement("button");
    flag.className = "flag";
    flag.setAttribute("aria-label", "回報這個組件");
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
    label.textContent = "已更新";
    side.append(label);
  }
  return side;
}

function openReport(anchor: HTMLElement, name: string, info: ComponentInfo): void {
  document.querySelector(".report")?.remove();
  const box = document.createElement("div");
  box.className = "report";
  box.innerHTML = `<div class="report-title">要怎麼改這個組件？</div>
<textarea rows="3" placeholder="例如：選項改成橫排"></textarea>
<div class="report-actions">${info.hasPrevious ? `<button class="plain revert">退回上一版</button>` : ""}<span></span><button class="primary send">送出</button></div>`;
  const textarea = box.querySelector("textarea")!;
  const send = box.querySelector<HTMLButtonElement>(".send")!;
  send.disabled = true;
  textarea.addEventListener("input", () => {
    send.disabled = textarea.value.trim() === "";
  });
  send.addEventListener("click", () => {
    post({ type: "componentReport", name, text: textarea.value.trim() });
    box.remove();
  });
  box.querySelector(".revert")?.addEventListener("click", () => {
    post({ type: "componentRevert", name });
    box.remove();
  });
  document.body.append(box);
  const rect = anchor.getBoundingClientRect();
  box.style.top = `${Math.max(12, rect.top - 8)}px`;
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
