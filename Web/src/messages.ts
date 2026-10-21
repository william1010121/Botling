import { post } from "./bridge";
import { pinBar, specPinButton } from "./pins";
import { answerAction, answerImages, choicesData, commandCard, componentElement, detailTarget, fallbackChoices } from "./components";
import type { ComponentAnswer } from "./components";
import { mediaHTML, renderMarkdown } from "./markdown";
import { acceptPictures } from "./pictures";
import type { ComponentRender } from "./plugins";
import { liveElement, stepsElement } from "./steps";
import { taskChips } from "./tasks";
import type { ComponentInfo, DisplayView, FileView, MessageView, SpecChipView, StepView } from "./types";
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

/** Replies can be made into components (set from the state before drawing). */
export const makeComponents = { enabled: false };

const cubeIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>`;

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
    case "user": {
      const body = userBody(message);
      if (message.tasks?.length) {
        // The chat's background work, when your line is the latest message.
        const column = document.createElement("div");
        column.className = "user-column";
        column.append(body, taskChips(message.id, message.tasks));
        row.append(column, replyButton(message));
      } else {
        row.append(body, replyButton(message));
      }
      break;
    }
    case "bot":
    case "notice": {
      const body = botBody(message, components);
      const actions = message.role === "bot" && (feedback.enabled || makeComponents.enabled) ? actionColumn(message) : replyButton(message);
      const chips = message.specs?.length ? specChips(message, components) : null;
      const tasks = message.tasks?.length ? taskChips(message.id, message.tasks) : null;
      if (message.speaker || chips || tasks) {
        // The group chat: who said it, above what they said. A spec's chip goes under it.
        const column = document.createElement("div");
        column.className = message.speaker ? "speaker-column" : "bot-column";
        if (message.speaker) {
          const name = document.createElement("div");
          name.className = "speaker";
          name.textContent = message.speaker;
          column.append(name);
        }
        column.append(body);
        // The chat's background work, when this is its latest message.
        if (tasks) column.append(tasks);
        if (chips) column.append(chips);
        // A component in the reply, or one made from it, takes the whole message column.
        if (body.classList.contains("wide") || column.querySelector(".spec-built")) {
          column.classList.add("wide");
          row.classList.add("wide");
        }
        // The reply's bubble is as wide as the tile under it, so the two line up on the right.
        if (column.querySelector(".spec-built")) column.classList.add("tiled");
        row.append(avatar(message.avatar), column, actions);
      } else {
        if (body.classList.contains("wide")) row.classList.add("wide");
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

/**
 * A bot reply's hover column: Reply, Make into component (or "Add to another bot…" when the reply
 * already is a library component), and in developer mode the "not right" flag.
 */
function actionColumn(message: MessageView): HTMLElement {
  const column = document.createElement("div");
  column.className = "message-actions";
  column.append(replyButton(message));
  if (makeComponents.enabled) {
    const label = message.component ? "Add to another bot…" : "Make into component";
    const make = document.createElement("button");
    make.className = "reply-button make-component";
    make.setAttribute("aria-label", label);
    make.title = message.component ? label : `${label}: Maintainer builds it from this reply right away`;
    make.innerHTML = cubeIcon;
    make.addEventListener("click", (event) => {
      event.stopPropagation();
      post({ type: "makeComponent", messageID: message.id });
    });
    column.append(make);
  }
  if (feedback.enabled) column.append(feedbackFlag(message));
  return column;
}

/**
 * Components made from a reply, under it. A bot's suggestion is a quiet chip until pressed (then
 * its first version is built); while building the chip says Building…; once built the component
 * itself shows, with "Edit spec" to open its spec in the right panel. A command it runs asks first
 * (Allow and run, with the exact command and folder), as on any card.
 */
function specChips(message: MessageView, components: Record<string, ComponentInfo>): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "spec-chips";
  for (const spec of message.specs ?? []) {
    const built = spec.component && spec.display ? builtSpec(spec, components) : null;
    if (built) {
      strip.append(built);
      continue;
    }
    const chip = document.createElement("button");
    chip.className = `spec-chip ${spec.status}${spec.suggested ? " suggested" : ""}${spec.open ? " open" : ""}`;
    chip.setAttribute("aria-expanded", String(spec.open));
    // Built, and the bot that wrote the reply is drawing it for the reply.
    const filling = spec.status === "done" && spec.filling ? spec.filling : null;
    const building = spec.status === "building" || !!filling;
    const words = filling ? `Filling in · ${filling}` : spec.status === "done" ? "Component" : building ? "Building…" : spec.suggested ? "Suggested component" : "Component spec";
    chip.innerHTML = `${building ? `<span class="spinner" aria-hidden="true"></span>` : cubeIcon}<span></span><span class="spec-chip-arrow" aria-hidden="true">›</span>`;
    chip.querySelector("span:not(.spinner)")!.textContent = `${words} · ${spec.component ?? spec.name}`;
    chip.title = filling ? `Built; ${filling} is drawing it with this reply's data` : spec.suggested ? "Make it into a component: Maintainer builds it now" : building ? "Maintainer is building it; show its progress" : spec.open ? "Showing in the right panel" : "Open in the right panel";
    chip.addEventListener("click", () => post({ type: "pressSpec", id: spec.id }));
    strip.append(chip);
    if (spec.status === "done") strip.append(editSpecButton(spec));
  }
  return strip;
}

function editSpecButton(spec: SpecChipView): HTMLButtonElement {
  const edit = document.createElement("button");
  edit.className = "spec-edit";
  edit.textContent = "Edit spec";
  edit.setAttribute("aria-expanded", String(spec.open));
  edit.title = spec.open ? "Showing in the right panel" : "Change it in the right panel; Build it makes a new version";
  edit.addEventListener("click", (event) => {
    event.stopPropagation();
    post({ type: "openSpec", id: spec.id });
  });
  return edit;
}

/** A built component under its reply: its name, Edit spec, and the component itself. */
function builtSpec(spec: SpecChipView, components: Record<string, ComponentInfo>): HTMLElement | null {
  const display = spec.display!;
  const name = spec.component!;
  const draw = () => componentElement(name, components[name], display.data, null, `spec-${spec.id}`, display.images, detailTarget(display));
  const card = display.command
    ? commandCard(display, `spec:${spec.id}`, 0, draw, {
        send: (request) => post({ type: "specCommand", id: spec.id, ...request }),
      })
    : draw();
  if (!card) return null;
  const box = document.createElement("div");
  box.className = `spec-built ${spec.status}${spec.open ? " open" : ""}`;
  const head = document.createElement("div");
  head.className = "spec-built-head";
  const label = document.createElement("span");
  label.className = "spec-built-name";
  label.innerHTML = spec.status === "building" ? `<span class="spinner" aria-hidden="true"></span><span></span>` : `${cubeIcon}<span></span>`;
  label.querySelector("span:not(.spinner)")!.textContent = spec.status === "building" ? `Building a new version · ${name}` : `Component · ${name}`;
  head.append(label, editSpecButton(spec));
  // Pinned, a bot-filled one is made live on the Board (Maintainer gives it a command).
  if (spec.status === "done") head.append(specPinButton(spec));
  box.append(head, card);
  return box;
}

/** The "not right" flag, for developer mode. */
function feedbackFlag(message: MessageView): HTMLElement {
  const flag = document.createElement("button");
  flag.className = "reply-button feedback-button";
  flag.setAttribute("aria-label", "Not right: send to the developer project");
  flag.title = "Not right";
  flag.innerHTML = flagIcon;
  flag.addEventListener("click", (event) => {
    event.stopPropagation();
    openFeedback(flag, message);
  });
  return flag;
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
  // A component in it spans the reply edge to edge, and the reply the whole message column: the
  // bubble is its frame, as a tile is on the Board (a plugin's own component keeps its place).
  const appendWide = (element: HTMLElement) => {
    if (!element.matches(".plugin-component") && !element.querySelector(".plugin-component")) {
      element.classList.add("wide-part");
      bubble.classList.add("wide");
    }
    bubble.append(element);
  };
  const appendComponent = ({ display, index }: { display: DisplayView; index: number }) => {
    const element = componentView(message, display, index, components);
    if (element) appendWide(element);
  };
  // One written at the very end goes after the question, as a single component always has.
  const inline = displays.filter((d) => d.at !== null && d.at < message.text.length).sort((x, y) => x.at! - y.at! || x.index - y.index);
  for (const shown of inline) {
    appendText(shown.at!);
    appendComponent(shown);
  }
  appendText(message.text.length);
  if (message.choices) {
    // Loose: the app leaves out a nil chosen or answer (undefined), not only null.
    const answered = message.chosen != null || message.answer != null;
    bubble.append(answered && !unfolded.has(message.id) ? foldedChoices(message, components) : choicesElement(message, components));
  }
  // Ones at the end, or with no place (saved before places were kept), come after the text.
  displays.filter((d) => !inline.includes(d)).forEach(appendComponent);
  // Result pages it links to, as preview cards under the text (the links stay chips too).
  message.previews?.forEach((preview, index) => {
    const card = componentElement(preview.name, components[preview.name], preview.data, null, `${message.id}/preview-${index}`);
    if (!card) return;
    if (!makeComponents.enabled || message.role !== "bot") {
      appendWide(card);
      return;
    }
    // Its hover toolbar: make the page into a component.
    const holder = document.createElement("div");
    holder.className = "preview-holder";
    const bar = document.createElement("div");
    bar.className = "preview-bar";
    const make = document.createElement("button");
    make.className = "preview-make";
    make.innerHTML = `${cubeIcon}<span>Make into component</span>`;
    make.addEventListener("click", (event) => {
      event.stopPropagation();
      post({ type: "makeComponent", messageID: message.id, preview: index });
    });
    bar.append(make);
    holder.append(card, bar);
    appendWide(holder);
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
  const element = display.command || display.status
    ? commandCard(display, message.id, index, () => drawComponent(message, display, index, components))
    : drawComponent(message, display, index, components);
  // In a chat that can pin, hovering it shows pin / ↻ / ⋯.
  if (!element || display.pinned === undefined || display.pinned === null) return element;
  const holder = document.createElement("div");
  holder.className = "pin-holder" + (display.pinned ? " pinned" : "");
  holder.append(element, pinBar(display, message.id, index));
  return holder;
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
  // ccb.save(data) keeps new data in this message; a command's card shows the command's output.
  const save = message.role === "bot" && !display.command
    ? (data: string) => post({ type: "componentSave", messageID: message.id, index, data })
    : null;
  return componentElement(display.name, components[display.name], display.data, answer,
    index === 0 ? message.id : `${message.id}/show-${index}`, display.images, detailTarget(display), undefined, "chat", false, save);
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
  const component = componentElement("choices", components.choices, choicesData(choices, message.chosen ?? null, message.answer ?? null), onAnswer, message.id);
  const options = component ?? fallbackChoices(choices, message.chosen ?? null, message.answer ?? null, onAnswer ? (index) => onAnswer({ index }) : null);
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
    // The drawn one, which may be an earlier wrap kept around its frame on a redraw.
    (fold.closest(".unfolded") ?? wrap).replaceWith(folded);
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
  const picked = message.chosen != null ? message.choices?.[message.chosen]?.label : null;
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
