import { post } from "./bridge";
import { choicesData, componentElement, fallbackChoices } from "./components";
import { mediaHTML, renderMarkdown } from "./markdown";
import type { ComponentRender } from "./plugins";
import { liveElement, stepsElement } from "./steps";
import type { ComponentInfo, FileView, MessageView, StepView } from "./types";
import { escapeHTML } from "./util";

/** What plugins add to how messages are drawn. */
export const extensions = {
  /** Components drawn by plugins in the page, ahead of template components. */
  components: new Map<string, { plugin: string; render: ComponentRender }>(),
  /** Called with each drawn message, so a plugin can change it (LaTeX in your own messages). */
  afterRender: [] as { plugin: string; handler: (element: HTMLElement, message: { id: string; role: string; text: string }) => void }[],
  /** Right-column pages from plugins, by "plugin/id". */
  panels: new Map<string, { plugin: string; render: (root: HTMLElement) => void | (() => void) }>(),
  /** Runs a plugin's code, unloading the plugin if it throws. */
  guard: <T>(_plugin: string, run: () => T): T | undefined => run(),
};

/** Developer mode: bot replies get a "not right" flag (set from the state before drawing). */
export const feedback = { enabled: false };

const flagIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4h11l-2 4 2 4H5"/></svg>`;

const replyIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>`;

/** One message, as the element that goes in the chat. */
export function messageElement(message: MessageView, components: Record<string, ComponentInfo>): HTMLElement {
  const row = document.createElement("div");
  row.className = `row ${message.role}`;
  row.dataset.id = message.id;

  drawRole(row, message, components);
  for (const { plugin, handler } of extensions.afterRender) {
    extensions.guard(plugin, () => handler(row, { id: message.id, role: message.role, text: message.text }));
  }
  return row;
}

function drawRole(row: HTMLElement, message: MessageView, components: Record<string, ComponentInfo>): void {
  switch (message.role) {
    case "user":
      row.append(userBody(message), replyButton(message));
      break;
    case "bot":
    case "notice": {
      const body = botBody(message, components);
      const actions = message.role === "bot" && feedback.enabled ? withFeedback(message) : replyButton(message);
      if (message.speaker) {
        // The group chat: who said it, above what they said.
        const column = document.createElement("div");
        column.className = "speaker-column";
        const name = document.createElement("div");
        name.className = "speaker";
        name.textContent = message.speaker;
        column.append(name, body);
        row.append(avatar(message.avatar), column, actions);
      } else {
        row.append(avatar(message.avatar), body, actions);
      }
      break;
    }
    case "relay": {
      const relay = document.createElement("div");
      relay.className = "relay";
      relay.innerHTML = `${message.avatar ? `<img class="mini-avatar" src="${message.avatar}" alt="">` : ""}<span>${escapeHTML(message.text)}</span>`;
      relay.setAttribute("aria-label", `From the main bot: ${message.text}`);
      if (message.attachments?.length) {
        // Pictures handed over with the work (a report's screenshots), under the line.
        const column = document.createElement("div");
        column.className = "relay-column";
        column.append(relay, attachmentStrip(message.attachments));
        row.append(column);
      } else {
        row.append(relay);
      }
      break;
    }
    case "divider":
      row.innerHTML = `<span class="line"></span><span class="label">${escapeHTML(message.text)}</span><span class="line"></span>`;
      break;
    case "error":
      row.innerHTML = `<div class="error-text">${escapeHTML(message.text)}</div>`;
      break;
  }
}

function avatar(src: string | null): HTMLElement {
  const image = document.createElement("img");
  image.className = "avatar";
  image.alt = "";
  if (src) image.src = src;
  return image;
}

/** The reply button with a "not right" flag under it, for developer mode. */
function withFeedback(message: MessageView): HTMLElement {
  const column = document.createElement("div");
  column.className = "message-actions";
  const flag = document.createElement("button");
  flag.className = "reply-button feedback-button";
  flag.setAttribute("aria-label", "Not right: send to the developer project");
  flag.title = "Not right";
  flag.innerHTML = flagIcon;
  flag.addEventListener("click", (event) => {
    event.stopPropagation();
    openFeedback(flag, message);
  });
  column.append(replyButton(message), flag);
  return column;
}

/** Say what was wrong with a reply; it goes to the developer project with the chat around it. */
function openFeedback(anchor: HTMLElement, message: MessageView): void {
  document.querySelector(".report")?.remove();
  const box = document.createElement("div");
  box.className = "report";
  box.innerHTML = `<div class="report-title">What was not right?</div>
<textarea rows="3" placeholder="e.g. it answered only half of what I said"></textarea>
<div class="report-actions"><span></span><button class="primary send">Send</button></div>`;
  const textarea = box.querySelector("textarea")!;
  box.querySelector(".send")!.addEventListener("click", () => {
    post({ type: "feedback", messageID: message.id, text: textarea.value.trim() });
    box.remove();
  });
  document.body.append(box);
  const rect = anchor.getBoundingClientRect();
  box.style.top = `${Math.max(12, Math.min(rect.top - 8, window.innerHeight - box.offsetHeight - 12))}px`;
  box.style.left = `${Math.max(12, Math.min(rect.left - 316, window.innerWidth - 316))}px`;
  textarea.focus();
  const close = (event: MouseEvent) => {
    if (!box.contains(event.target as Node)) {
      box.remove();
      document.removeEventListener("mousedown", close);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

function replyButton(message: MessageView): HTMLElement {
  const button = document.createElement("button");
  button.className = "reply-button";
  button.setAttribute("aria-label", "Reply");
  button.innerHTML = replyIcon;
  button.addEventListener("click", () => post({ type: "reply", messageID: message.id }));
  return button;
}

function userBody(message: MessageView): HTMLElement {
  const body = document.createElement("div");
  body.className = "user-body";
  if (message.replyPreview && message.replyTo) {
    const quote = document.createElement("button");
    quote.className = "quote";
    quote.innerHTML = `${replyIcon}<span>${escapeHTML(message.replyPreview)}</span>`;
    const target = message.replyTo;
    quote.addEventListener("click", () => jumpTo(target));
    body.append(quote);
  }
  if (message.attachments?.length) body.append(attachmentStrip(message.attachments));
  if (message.text) {
    const bubble = document.createElement("div");
    bubble.className = "bubble user-bubble";
    bubble.innerHTML = escapeHTML(message.text).replace(/\n/g, "<br>");
    body.append(bubble);
  }
  return body;
}

function botBody(message: MessageView, components: Record<string, ComponentInfo>): HTMLElement {
  const bubble = document.createElement("div");
  bubble.className = message.role === "notice" ? `bubble notice-bubble${message.open ? " open" : ""}` : "bubble bot-bubble";
  if (message.steps?.length) bubble.append(stepsElement(message.id, message.steps));
  if (message.text) {
    const text = document.createElement("div");
    text.className = "markdown";
    text.innerHTML = renderMarkdown(message.text);
    bubble.append(text);
  }
  if (message.choices) {
    const answered = message.chosen !== null || message.answer !== null;
    bubble.append(answered && !unfolded.has(message.id) ? foldedChoices(message, components) : choicesElement(message, components));
  }
  if (message.display) {
    const answer = (value: number | string) =>
      post(typeof value === "number"
        ? { type: "choose", messageID: message.id, index: value }
        : { type: "answer", messageID: message.id, text: value });
    const pluginComponent = extensions.components.get(message.display.name);
    if (pluginComponent) {
      const root = document.createElement("div");
      root.className = "plugin-component";
      let data: unknown = null;
      try { data = JSON.parse(message.display.data); } catch { /* left null */ }
      extensions.guard(pluginComponent.plugin, () => pluginComponent.render(root, data, answer));
      bubble.append(root);
    } else {
      const component = componentElement(message.display.name, components[message.display.name], message.display.data, (value) => {
        if (value.index !== undefined) answer(value.index);
        else if (value.text !== undefined) answer(value.text);
      }, message.id);
      if (component) bubble.append(component);
    }
  }
  // Result pages it links to, as preview cards under the text (the links stay chips too).
  message.previews?.forEach((preview, index) => {
    const card = componentElement(preview.name, components[preview.name], preview.data, null, `${message.id}/preview-${index}`);
    if (card) bubble.append(card);
  });
  if (message.openable) {
    const open = document.createElement("button");
    open.className = "open-source";
    open.textContent = "Open ›";
    open.addEventListener("click", () => post({ type: "openSource", messageID: message.id }));
    bubble.append(open);
  }
  return bubble;
}

/** Answered questions you opened again, by message id; the rest stay folded to one line. */
const unfolded = new Set<string>();

const chevron = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

/** The question's options: the 「choices」 component, or plain buttons without one. */
function choicesElement(message: MessageView, components: Record<string, ComponentInfo>): HTMLElement {
  const choices = message.choices!;
  const onAnswer = message.open
    ? (answer: { index?: number; text?: string }) => {
        if (answer.index !== undefined) post({ type: "choose", messageID: message.id, index: answer.index });
        else if (answer.text !== undefined) post({ type: "answer", messageID: message.id, text: answer.text });
      }
    : null;
  const component = componentElement("choices", components.choices, choicesData(choices, message.chosen, message.answer), onAnswer, message.id);
  const options = component ?? fallbackChoices(choices, message.chosen, message.answer, onAnswer ? (index) => onAnswer({ index }) : null);
  if (message.open) return options;
  // Opened again after answering: a way to fold it back.
  const wrap = document.createElement("div");
  wrap.className = "unfolded";
  const fold = document.createElement("button");
  fold.className = "fold";
  fold.innerHTML = `<span>Fold</span>${chevron}`;
  fold.setAttribute("aria-expanded", "true");
  fold.addEventListener("click", () => {
    unfolded.delete(message.id);
    const folded = foldedChoices(message, components);
    wrap.replaceWith(folded);
    folded.focus();
  });
  wrap.append(options, fold);
  return wrap;
}

/**
 * An answered question as one line, what you picked; click to see every option again. No tick:
 * the answer may as well be "Don't allow" or "No longer needed".
 */
export function foldedChoices(message: MessageView, components: Record<string, ComponentInfo>): HTMLElement {
  const picked = message.chosen !== null ? message.choices?.[message.chosen]?.label : null;
  const label = picked ?? message.answer ?? "Answered";
  const button = document.createElement("button");
  button.className = "folded-choice";
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = `<span class="picked-label"></span>${chevron}`;
  button.querySelector(".picked-label")!.textContent = label;
  button.title = label;
  button.setAttribute("aria-label", `Answered: ${label}. Show the options`);
  button.addEventListener("click", () => {
    unfolded.add(message.id);
    const options = choicesElement(message, components);
    button.replaceWith(options);
    options.querySelector<HTMLElement>(".fold")?.focus();
  });
  return button;
}

export function attachmentStrip(files: FileView[]): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "attachments";
  for (const file of files) {
    if (file.kind === "image") {
      strip.insertAdjacentHTML("beforeend", `<img class="thumb" src="${escapeHTML(file.url)}" alt="${escapeHTML(file.name)}" data-url="${escapeHTML(file.url)}" data-label="${escapeHTML(file.name)}">`);
    } else if (file.kind === "video") {
      strip.insertAdjacentHTML("beforeend", mediaHTML(file.url, file.name));
    } else {
      strip.insertAdjacentHTML("beforeend", `<a class="file-chip" href="#" data-url="${escapeHTML(file.url)}" data-label="${escapeHTML(file.name)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/></svg>${escapeHTML(file.name)}</a>`);
    }
  }
  return strip;
}

/** Scrolls to a message and flashes it, for a reply's quote. */
export function jumpTo(id: string): void {
  const target = document.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(id)}"]`);
  if (!target) return;
  // Reading back: the chat stops following the bottom.
  document.dispatchEvent(new CustomEvent("ccb-read-back"));
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1200);
}

/** The bot at work: what it is doing right now, if it has started on tools, then the dots. */
export function typingElement(avatarSrc: string, live: StepView[] = []): HTMLElement {
  const row = document.createElement("div");
  row.className = "row bot typing";
  row.append(avatar(avatarSrc));
  const dots = document.createElement("div");
  dots.className = "dots";
  dots.setAttribute("aria-label", "Working");
  dots.innerHTML = "<span></span><span></span><span></span>";
  if (!live.length) {
    dots.classList.add("bubble", "bot-bubble");
    row.append(dots);
    return row;
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble bot-bubble working";
  bubble.append(liveElement(live), dots);
  row.append(bubble);
  return row;
}
