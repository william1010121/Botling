import { post } from "./bridge";
import { choicesData, componentElement, fallbackChoices } from "./components";
import { mediaHTML, renderMarkdown } from "./markdown";
import { escapeHTML, renderPlainWithMath } from "./math";
import type { ComponentInfo, FileView, MessageView } from "./types";

const replyIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>`;

/** One message, as the element that goes in the chat. */
export function messageElement(message: MessageView, components: Record<string, ComponentInfo>): HTMLElement {
  const row = document.createElement("div");
  row.className = `row ${message.role}`;
  row.dataset.id = message.id;

  switch (message.role) {
    case "user":
      row.append(userBody(message), replyButton(message));
      break;
    case "bot":
    case "notice":
      row.append(avatar(message.avatar), botBody(message, components), replyButton(message));
      break;
    case "relay": {
      const relay = document.createElement("div");
      relay.className = "relay";
      relay.innerHTML = `${message.avatar ? `<img class="mini-avatar" src="${message.avatar}" alt="">` : ""}<span>${escapeHTML(message.text)}</span>`;
      relay.setAttribute("aria-label", `主 bot 交辦：${message.text}`);
      row.append(relay);
      break;
    }
    case "divider":
      row.innerHTML = `<span class="line"></span><span class="label">${escapeHTML(message.text)}</span><span class="line"></span>`;
      break;
    case "error":
      row.innerHTML = `<div class="error-text">${escapeHTML(message.text)}</div>`;
      break;
  }
  return row;
}

function avatar(src: string | null): HTMLElement {
  const image = document.createElement("img");
  image.className = "avatar";
  image.alt = "";
  if (src) image.src = src;
  return image;
}

function replyButton(message: MessageView): HTMLElement {
  const button = document.createElement("button");
  button.className = "reply-button";
  button.setAttribute("aria-label", "回覆");
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
    bubble.innerHTML = renderPlainWithMath(message.text);
    body.append(bubble);
  }
  return body;
}

function botBody(message: MessageView, components: Record<string, ComponentInfo>): HTMLElement {
  const bubble = document.createElement("div");
  bubble.className = message.role === "notice" ? `bubble notice-bubble${message.open ? " open" : ""}` : "bubble bot-bubble";
  if (message.text) {
    const text = document.createElement("div");
    text.className = "markdown";
    text.innerHTML = renderMarkdown(message.text);
    bubble.append(text);
  }
  if (message.choices) {
    const onAnswer = message.open
      ? (answer: { index?: number; text?: string }) => {
          if (answer.index !== undefined) post({ type: "choose", messageID: message.id, index: answer.index });
          else if (answer.text !== undefined) post({ type: "answer", messageID: message.id, text: answer.text });
        }
      : null;
    const component = componentElement("choices", components.choices, choicesData(message.choices, message.chosen, message.answer), onAnswer);
    bubble.append(component ?? fallbackChoices(message.choices, message.chosen, message.answer, onAnswer ? (index) => onAnswer({ index }) : null));
  }
  if (message.display) {
    const component = componentElement(message.display.name, components[message.display.name], message.display.data, (answer) => {
      if (answer.index !== undefined) post({ type: "choose", messageID: message.id, index: answer.index });
      else if (answer.text !== undefined) post({ type: "answer", messageID: message.id, text: answer.text });
    });
    if (component) bubble.append(component);
  }
  if (message.openable) {
    const open = document.createElement("button");
    open.className = "open-source";
    open.textContent = "打開 ›";
    open.addEventListener("click", () => post({ type: "openSource", messageID: message.id }));
    bubble.append(open);
  }
  return bubble;
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
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1200);
}

export function typingElement(avatarSrc: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "row bot typing";
  row.append(avatar(avatarSrc));
  const bubble = document.createElement("div");
  bubble.className = "bubble bot-bubble dots";
  bubble.setAttribute("aria-label", "工作中");
  bubble.innerHTML = "<span></span><span></span><span></span>";
  row.append(bubble);
  return row;
}
