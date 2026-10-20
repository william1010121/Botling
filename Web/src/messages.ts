import { post } from "./bridge";
import { answerAction, answerImages, choicesData, commandCard, componentElement, fallbackChoices } from "./components";
import type { ComponentAnswer } from "./components";
import { mediaHTML, renderMarkdown } from "./markdown";
import { acceptPictures } from "./pictures";
import type { ComponentRender } from "./plugins";
import { liveElement, stepsElement } from "./steps";
import type { ComponentInfo, DisplayView, FileView, MessageView, StepView } from "./types";
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
      if (message.feedback) {
        row.append(feedbackRelay(message, message.feedback));
        break;
      }
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

/** Feedback relays whose whole report you opened, by message id; the rest stay short. */
const openReports = new Set<string>();

/**
 * A "not right" report handed over: whose reply it was about, your words and the pictures; the
 * full report the bot got (the chat around the reply) behind a toggle.
 */
function feedbackRelay(message: MessageView, note: { about: string; words: string }): HTMLElement {
  const column = document.createElement("div");
  column.className = "relay-column";
  const card = document.createElement("div");
  card.className = "relay feedback-relay";
  card.innerHTML = `${message.avatar ? `<img class="mini-avatar" src="${message.avatar}" alt="">` : ""}<div class="feedback-body">
<div class="feedback-title"></div>
<div class="feedback-words"></div>
<button class="feedback-toggle"><span></span>${chevron}</button>
<div class="feedback-full"></div>
</div>`;
  card.querySelector(".feedback-title")!.textContent = `Feedback: a reply of ${note.about} was not right`;
  const words = card.querySelector<HTMLElement>(".feedback-words")!;
  words.textContent = note.words || "(No words, only the chat around it.)";
  words.classList.toggle("empty", !note.words);
  const toggle = card.querySelector<HTMLButtonElement>(".feedback-toggle")!;
  const full = card.querySelector<HTMLElement>(".feedback-full")!;
  full.textContent = message.text;
  const show = (open: boolean) => {
    full.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.querySelector("span")!.textContent = open ? "Hide the full report" : "Show the full report";
    toggle.classList.toggle("open", open);
  };
  show(openReports.has(message.id));
  toggle.addEventListener("click", () => {
    const open = !openReports.has(message.id);
    if (open) openReports.add(message.id);
    else openReports.delete(message.id);
    show(open);
  });
  card.setAttribute("aria-label", `Feedback on a reply of ${note.about}: ${note.words}`);
  column.append(card);
  if (message.attachments?.length) column.append(attachmentStrip(message.attachments));
  return column;
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

/**
 * Say what was wrong with a reply; it goes to the developer project with the chat around it, a
 * screenshot of the chat centered on the reply (taken by the app), and pictures pasted or dropped.
 */
function openFeedback(anchor: HTMLElement, message: MessageView): void {
  document.querySelector(".report")?.remove();
  const box = document.createElement("div");
  box.className = "report";
  box.innerHTML = `<div class="report-title">What was not right?</div>
<textarea rows="3" placeholder="e.g. it answered only half of what I said. Paste or drop a picture to show it."></textarea>
<div class="report-images" hidden></div>
<div class="report-actions"><span></span><button class="primary send">Send</button></div>`;
  const textarea = box.querySelector("textarea")!;
  const images = acceptPictures(box, textarea, box.querySelector<HTMLElement>(".report-images")!, () => place());
  box.querySelector(".send")!.addEventListener("click", () => {
    // Out of the way and the reply in the middle first, so the app's screenshot shows the chat
    // as you saw it around that reply.
    box.remove();
    const row = anchor.closest<HTMLElement>(".row");
    if (row) {
      document.dispatchEvent(new CustomEvent("ccb-read-back"));
      row.scrollIntoView?.({ block: row.offsetHeight > window.innerHeight ? "start" : "center" });
    }
    requestAnimationFrame(() => post({ type: "feedback", messageID: message.id, text: textarea.value.trim(), images }));
  });
  document.body.append(box);
  const rect = anchor.getBoundingClientRect();
  const place = () => {
    box.style.top = `${Math.max(12, Math.min(rect.top - 8, window.innerHeight - box.offsetHeight - 12))}px`;
  };
  place();
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
  const displays = (message.displays ?? (message.display ? [message.display] : []))
    .map((display, index) => ({ display, index, at: typeof display.at === "number" ? Math.min(Math.max(display.at, 0), message.text.length) : null }));
  // The text in pieces, with each component drawn where it was written.
  let from = 0;
  const appendText = (to: number) => {
    const piece = message.text.slice(from, to);
    from = to;
    if (!piece.trim()) return;
    const text = document.createElement("div");
    text.className = "markdown";
    text.innerHTML = renderMarkdown(piece);
    bubble.append(text);
  };
  const appendComponent = ({ display, index }: { display: DisplayView; index: number }) => {
    const element = componentView(message, display, index, components);
    if (element) bubble.append(element);
  };
  // One written at the very end goes after the question, as a single component always has.
  const inline = displays.filter((d) => d.at !== null && d.at < message.text.length).sort((x, y) => x.at! - y.at! || x.index - y.index);
  for (const shown of inline) {
    appendText(shown.at!);
    appendComponent(shown);
  }
  appendText(message.text.length);
  if (message.choices) {
    const answered = message.chosen !== null || message.answer !== null;
    bubble.append(answered && !unfolded.has(message.id) ? foldedChoices(message, components) : choicesElement(message, components));
  }
  // Ones at the end, or with no place (saved before places were kept), come after the text.
  displays.filter((d) => !inline.includes(d)).forEach(appendComponent);
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

/**
 * One component a bot's message shows. Its answers go back as answers to that message; the
 * first keeps the message's id as its key (its height survives a redraw), the rest add their place.
 */
function componentView(message: MessageView, display: DisplayView, index: number, components: Record<string, ComponentInfo>): HTMLElement | null {
  // Data from a command: the card around it asks to allow it, runs it, or says why it failed.
  if (display.command || display.status) {
    return commandCard(display, message.id, index, () => drawComponent(message, display, index, components));
  }
  return drawComponent(message, display, index, components);
}

function drawComponent(message: MessageView, display: DisplayView, index: number, components: Record<string, ComponentInfo>): HTMLElement | null {
  const answer = (value: ComponentAnswer) => {
    const action = answerAction(message.id, value);
    if (action) post(action);
  };
  const pluginComponent = extensions.components.get(display.name);
  if (pluginComponent) {
    const root = document.createElement("div");
    root.className = "plugin-component";
    let data: unknown = null;
    try { data = JSON.parse(display.data); } catch { /* left null */ }
    extensions.guard(pluginComponent.plugin, () => pluginComponent.render(root, data, (value) => answer(
      typeof value === "number" ? { index: value }
        : typeof value === "string" ? { text: value }
        : { text: value?.text ?? "", images: answerImages(value?.images) },
    )));
    return root;
  }
  return componentElement(display.name, components[display.name], display.data, answer,
    index === 0 ? message.id : `${message.id}/show-${index}`, display.images);
}

/** Answered questions you opened again, by message id; the rest stay folded to one line. */
const unfolded = new Set<string>();

const chevron = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

/** The question's options: the 「choices」 component, or plain buttons without one. */
function choicesElement(message: MessageView, components: Record<string, ComponentInfo>): HTMLElement {
  const choices = message.choices!;
  const onAnswer = message.open
    ? (answer: ComponentAnswer) => {
        const action = answerAction(message.id, answer);
        if (action) post(action);
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
