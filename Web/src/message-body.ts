import { findMessageRow } from "./message-navigation";
import { artifactCard } from "./artifacts";
import { post } from "./bridge";
import { t } from "./i18n";
import { answerAction, answerImages, choicesData, choicesDrawGroups, commandCard, componentElement, detailTarget, fallbackChoices, questionGroupData } from "./components";
import { groupSummary, questionGroupElement } from "./question-group";
import type { ComponentAnswer } from "./components";
import { mediaHTML, mediaSrc, renderMarkdown } from "./markdown";
import { avatar, extensions, messageMenu, quickIcon } from "./messages";
import { liveElement, stepsElement } from "./steps";
import type { ChatState, ComponentInfo, DisplayView, FileView, MessageView, StepView, WorkerCardView } from "./types";
import { escapeHTML, queuedBadge } from "./util";

export function botBody(message: MessageView, components: Record<string, ComponentInfo>, botId: string | null = null): HTMLElement {
  const bubble = document.createElement("div");
  bubble.className = message.role === "notice" ? `bubble notice-bubble${message.open ? " open" : ""}` : "bubble bot-bubble";
  if (message.fromSubagent) bubble.append(fromSubagent(message.fromSubagent));
  if (message.steps?.length) bubble.append(stepsElement(message.id, message.steps, message.earlier === true));
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
    text.innerHTML = renderMarkdown(piece, message.id);
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
    const element = componentView(message, display, index, components, botId);
    if (element) appendWide(element);
  };
  // Worker cards (`<card>` tags) stand where the tag was, among the components.
  const cards = (message.workerCards ?? []).map((card, index) => ({ card, index, at: typeof card.at === "number" ? Math.min(Math.max(card.at, 0), message.text.length) : null }));
  const parts = [
    ...displays.map((shown) => ({ at: shown.at, order: shown.index, draw: () => appendComponent(shown) })),
    ...cards.map((shown) => ({ at: shown.at, order: 1_000 + shown.index, draw: () => appendWide(workerCardElement(message, shown.card, shown.index, components, botId)) })),
  ];
  // One written at the very end goes after the question, as a single component always has.
  const inline = parts.filter((part) => part.at !== null && part.at < message.text.length).sort((x, y) => x.at! - y.at! || x.order - y.order);
  for (const shown of inline) {
    appendText(shown.at!);
    shown.draw();
  }
  appendText(message.text.length);
  // Cut off before it answered: its words and steps so far stay, and it says so.
  if (message.interrupted) {
    const note = document.createElement("div");
    note.className = "interrupted-note";
    note.textContent = t("messages.interrupted");
    bubble.append(note);
  }
  if (message.choices && message.ignoredAt) {
    bubble.append(ignoredQuestion(message));
  } else if (message.choices) {
    // Loose: the app leaves out a nil chosen or answer (undefined), not only null.
    const answered = message.chosen != null || message.answer != null;
    // Your answer waits to reach the bot that asked (it is at work): shown as given, "Queued" until it gets there.
    if (message.queued) bubble.append(queuedBadge({ label: t("messages.queued"), hint: t("messages.answerQueuedHint") }));
    // The last answer did not reach it: the card is open again and says so.
    if (message.notDelivered && message.open) {
      const note = document.createElement("div");
      note.className = "interrupted-note";
      note.textContent = t("messages.answerNotDelivered", { name: message.notDelivered });
      bubble.append(note);
    }
    bubble.append(answered && !unfolded.has(message.id) ? foldedChoices(message, components) : choicesElement(message, components));
  }
  // Ones at the end, or with no place (saved before places were kept), come after the text.
  parts.filter((part) => !inline.includes(part)).forEach((part) => part.draw());
  // Result pages it links to, as preview cards under the text (the links stay chips too).
  message.previews?.forEach((preview, index) => {
    const card = componentElement(preview.name, components[preview.name], preview.data, null, `${message.id}/preview-${index}`, null, null, undefined, "chat", false, null, true);
    if (!card) return;
    card.classList.add("page-preview");
    const quick = message.role === "bot" ? messageMenu.previews.filter((entry) => entry.quick) : [];
    if (!quick.length) {
      appendWide(card);
      return;
    }
    // Its hover toolbar: make the page into a component (the component studio's `message/preview` entry).
    const holder = document.createElement("div");
    holder.className = "preview-holder";
    const bar = document.createElement("div");
    bar.className = "preview-bar";
    for (const item of quick) {
      const make = document.createElement("button");
      make.className = "preview-make";
      make.dataset.command = item.command;
      make.innerHTML = `${quickIcon(item.icon)}<span></span>`;
      make.querySelector("span")!.textContent = item.title;
      make.addEventListener("click", (event) => {
        event.stopPropagation();
        post({ type: "runCommand", id: item.command, via: "menu", menu: "message/preview", messageID: message.id, preview: index });
      });
      bar.append(make);
    }
    holder.append(card, bar);
    appendWide(holder);
  });
  // claude.ai Artifacts it links to, as cards under the text (the links stay chips too).
  message.artifacts?.forEach((card) => bubble.append(artifactCard(card)));
  if (message.openable) {
    const open = document.createElement("button");
    open.className = "open-source";
    open.textContent = t("steps.openSubagent");
    open.addEventListener("click", () => post({ type: "openSource", messageID: message.id }));
    bubble.append(open);
  }
  return bubble;
}

/** The pseudo messages a worker card's report is drawn from (see `componentView`). */
const cardBodies = new WeakSet<MessageView>();
/** What was typed in a card's reply box and not sent, by card id: a redraw of the line (the worker moved on) keeps it. */
const cardDrafts = new Map<string, string>();
/** Cards whose words were just sent: their box stays shut until the worker's run shows, so a double Enter sends once. */
const cardSending = new Set<string>();

const CARD_STATUS_KEYS = {
  starting: "card.status.starting", running: "card.status.running", done: "card.status.done",
  failed: "card.status.failed", stopped: "card.status.stopped", interrupted: "card.status.interrupted",
} as const;

/**
 * A worker card: the title and state of its worker, its latest report drawn as a reply is (words and components), and a small box
 * whose words go to that worker as a follow-up. Its next report replaces the one shown.
 */
export function workerCardElement(message: MessageView, card: WorkerCardView, index: number, components: Record<string, ComponentInfo>, botId: string | null): HTMLElement {
  const root = document.createElement("div");
  root.className = `worker-card status-${card.status}`;
  root.dataset.card = card.id;
  const head = document.createElement("div");
  head.className = "worker-card-head";
  const title = document.createElement("span");
  title.className = "worker-card-title";
  title.textContent = card.title;
  const status = document.createElement("span");
  status.className = "worker-card-status";
  status.textContent = t(CARD_STATUS_KEYS[card.status]);
  head.append(title, status);
  root.append(head);
  if (card.text || card.displays?.length) {
    const report: MessageView = {
      ...message, id: `${message.id}/card-${index}`, role: "bot", text: card.text ?? "", displays: card.displays ?? null, display: null, workerCards: null,
      choices: null, chosen: null, answer: null, questions: null, picks: null, open: false, steps: null, previews: null, artifacts: null, attachments: null,
      openable: false, interrupted: null, fromSubagent: null, tasks: null, queued: false, replyTo: null, replyPreview: null, reactions: null, reactionEnabled: false, component: null,
    };
    cardBodies.add(report);
    const body = botBody(report, components, botId);
    body.className = "worker-card-body";
    root.append(body);
  } else if (card.status === "starting" || card.status === "running") {
    const wait = document.createElement("div");
    wait.className = "worker-card-wait";
    wait.textContent = t("card.waiting");
    root.append(wait);
  }
  if (card.error) {
    const error = document.createElement("div");
    error.className = "worker-card-error";
    error.textContent = card.error;
    root.append(error);
  }
  const taskId = card.taskId;
  if (taskId) {
    const form = document.createElement("form");
    form.className = "worker-card-reply";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = t("card.reply");
    input.setAttribute("aria-label", t("card.reply"));
    input.value = cardDrafts.get(card.id) ?? "";
    const send = document.createElement("button");
    send.type = "submit";
    send.textContent = t("card.send");
    const shut = () => { const closed = cardSending.has(card.id); input.disabled = closed; send.disabled = closed || !input.value.trim(); };
    input.addEventListener("input", () => { if (input.value) cardDrafts.set(card.id, input.value); else cardDrafts.delete(card.id); shut(); });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || cardSending.has(card.id)) return;
      cardSending.add(card.id);
      post({ type: "cardSend", taskID: taskId, text });
      cardDrafts.delete(card.id);
      input.value = "";
      shut();
      setTimeout(() => { cardSending.delete(card.id); shut(); }, 1_500);
    });
    // Enter while the IME is composing picks a character, it does not send.
    input.addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) event.preventDefault(); });
    shut();
    form.append(input, send);
    root.append(form);
  }
  return root;
}

/** Whose call it was: one of the bot's subagents ("Subagent · Fix group B  Open ›"), opening it. */
function fromSubagent(agent: { id: string; title: string }): HTMLElement {
  const button = document.createElement("button");
  button.className = "from-subagent";
  const label = document.createElement("span");
  label.textContent = `${t("steps.subagent")} · ${agent.title}`;
  const open = document.createElement("span");
  open.className = "from-subagent-open";
  open.textContent = t("steps.openSubagent");
  button.append(label, open);
  button.addEventListener("click", () => post({ type: "openSubagent", id: agent.id }));
  return button;
}

/**
 * One component a bot's message shows. Its answers go back as answers to that message; the
 * first keeps the message's id as its key (its height survives a redraw), the rest add their place.
 */
function componentView(message: MessageView, display: DisplayView, index: number, components: Record<string, ComponentInfo>, botId: string | null): HTMLElement | null {
  // A worker card's report is drawn as a reply is, but is no message of the chat: nothing in it answers, saves or pins.
  const readOnly = cardBodies.has(message);
  // Shown with no data and nothing to get it from: nothing to draw, and no error card in the
  // user's chat (the app tells the bot with the user's next message).
  if (display.status === "empty" && !display.command) return null;
  // Data from a command: the card around it asks to allow it, runs it, or says why it failed.
  const element = display.command || display.status
    ? commandCard(display, message.id, index, () => drawComponent(message, display, index, components, botId), { lazy: true })
    : drawComponent(message, display, index, components, botId);
  // A plugin's bars (the Board's pin / ↻ / ⋯, in a chat that can pin) show on hover.
  if (!element) return element;
  const bars = readOnly ? [] : extensions.cardBars.flatMap(({ plugin, make }) => extensions.guard(plugin, () => make(display, message.id, index)) ?? []);
  if (!bars.length) return element;
  const holder = document.createElement("div");
  holder.className = "pin-holder" + (bars.some((bar) => bar.dataset.holder === "pinned") ? " pinned" : "");
  holder.append(element, ...bars);
  return holder;
}

function drawComponent(message: MessageView, display: DisplayView, index: number, components: Record<string, ComponentInfo>, botId: string | null): HTMLElement | null {
  const readOnly = cardBodies.has(message);
  const answer = (value: ComponentAnswer) => {
    const action = readOnly ? null : answerAction(message.id, value);
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
    ), { botId, messageId: message.id }));
    return root;
  }
  // ccb.save(data) keeps new data in this message; a command's card shows the command's output.
  const save = message.role === "bot" && !display.command && !readOnly
    ? (data: string) => post({ type: "componentSave", messageID: message.id, index, data })
    : null;
  return componentElement(display.name, components[display.name], display.data, answer,
    index === 0 ? message.id : `${message.id}/show-${index}`, display.images, detailTarget(display), undefined, "chat", false, save, true);
}

/** Answered questions you opened again, by message id; the rest stay folded to one line. */
const unfolded = new Set<string>();

export const chevron = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

/** App-owned dismissal next to the existing Answer UI; no plugin action is synthesized. */
export function ignoreQuestionButton(messageId: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "folded-choice question-ignore";
  button.textContent = t("messages.ignoreQuestion");
  button.title = t("messages.ignoreQuestionHint");
  button.addEventListener("click", () => post({ type: "ignoreQuestion", messageID: messageId }));
  return button;
}

export function ignoredQuestion(message: MessageView): HTMLElement {
  const notice = document.createElement("details");
  notice.className = "ignored-question";
  const summary = document.createElement("summary");
  summary.textContent = t("messages.ignoredQuestion");
  const options = document.createElement("ul");
  // A question group lists its questions with their options; a plain question its options.
  const lines = message.questions?.length
    ? message.questions.map((question) => `${question.question ? `${question.question}: ` : ""}${question.options.map((option) => option.label).join(" / ")}`)
    : (message.choices ?? []).map((choice) => choice.label + (choice.detail ? ` — ${choice.detail}` : ""));
  for (const line of lines) {
    const item = document.createElement("li");
    item.textContent = line;
    options.append(item);
  }
  notice.append(summary, options);
  return notice;
}

/** The question's options: the 「choices」 component, or plain buttons without one. */
function choicesElement(message: MessageView, components: Record<string, ComponentInfo>): HTMLElement {
  const choices = message.choices!;
  const onAnswer = message.open
    ? (answer: ComponentAnswer) => {
        const action = answerAction(message.id, answer);
        if (action) post(action);
      }
    : null;
  const options = message.questions?.length
    ? groupOptions(message, components, onAnswer)
    : componentElement("choices", components.choices, choicesData(choices, message.chosen ?? null, message.answer ?? null), onAnswer, message.id, null, null, undefined, "chat", false, null, true)
      ?? fallbackChoices(choices, message.chosen ?? null, message.answer ?? null, onAnswer ? (index) => onAnswer({ index }) : null);
  if (message.open) {
    if (!message.canIgnoreQuestion) return options;
    const wrap = document.createElement("div");
    wrap.append(options, ignoreQuestionButton(message.id));
    return wrap;
  }
  // Opened again after answering: a way to fold it back.
  const wrap = document.createElement("div");
  wrap.className = "unfolded";
  const fold = document.createElement("button");
  fold.className = "fold";
  fold.innerHTML = `<span>${escapeHTML(t("messages.fold"))}</span>${chevron}`;
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
 * A question group: the 「choices」 template when it draws groups (`data-ccb-questions`), else the app's own card
 * (question-group.ts). Either way one Submit sends every answer as `picks`.
 */
function groupOptions(message: MessageView, components: Record<string, ComponentInfo>, onAnswer: ((answer: ComponentAnswer) => void) | null): HTMLElement {
  const questions = message.questions!;
  const picks = message.picks ?? null;
  if (choicesDrawGroups(components.choices)) {
    const component = componentElement("choices", components.choices, questionGroupData(questions, picks, message.answer ?? null), onAnswer, message.id, null, null, undefined, "chat", false, null, true);
    if (component) return component;
  }
  return questionGroupElement(questions, picks, onAnswer ? (given) => onAnswer({ picks: given }) : null);
}

/**
 * An answered question as one line, what you picked; click to see every option again. No tick:
 * the answer may as well be "Don't allow" or "No longer needed".
 */
export function foldedChoices(message: MessageView, components: Record<string, ComponentInfo>): HTMLElement {
  const picked = message.chosen != null ? message.choices?.[message.chosen]?.label : null;
  // A question group: each answer, in order ("Postgres · Login; Export · Skipped").
  const group = message.questions?.length && message.picks?.length ? groupSummary(message.questions, message.picks) : null;
  const label = group ?? (picked ? picked + (message.answer ? ` — ${message.answer}` : "") : message.answer?.replace(/\s*\n\s*/g, " ") ?? t("messages.answered"));
  const button = document.createElement("button");
  button.className = "folded-choice";
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = `<span class="picked-label"></span>${chevron}`;
  button.querySelector(".picked-label")!.textContent = label;
  button.title = label;
  button.setAttribute("aria-label", t("messages.answeredLabel", { label }));
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
    if (file.missing) strip.append(missingAttachment(file.name));
    else if (file.kind === "image") {
      strip.insertAdjacentHTML("beforeend", `<img class="thumb" role="button" tabindex="0" aria-haspopup="dialog" aria-label="${escapeHTML(file.name || t("lightbox.picture"))}" src="${escapeHTML(mediaSrc(file.url))}" alt="${escapeHTML(file.name)}" data-url="${escapeHTML(file.url)}" data-label="${escapeHTML(file.name)}">`);
    } else if (file.kind === "video") {
      strip.insertAdjacentHTML("beforeend", mediaHTML(file.url, file.name));
    } else {
      strip.insertAdjacentHTML("beforeend", `<a class="file-chip" href="#" data-url="${escapeHTML(file.url)}" data-label="${escapeHTML(file.name)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/></svg>${escapeHTML(file.name)}</a>`);
    }
  }
  // A picture or video that will not load (its original moved or deleted since): the missing chip.
  for (const media of strip.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img.thumb, video")) {
    media.addEventListener("error", () => media.replaceWith(missingAttachment(media.getAttribute("alt") || media.getAttribute("aria-label") || "")), { once: true });
  }
  return strip;
}

/** An attachment that is no longer where it was attached: its name, not openable. */
function missingAttachment(name: string): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "file-chip missing";
  chip.textContent = t("messages.attachmentMissing", { name: name || t("lightbox.picture") });
  return chip;
}

/** Scrolls to a message and flashes it, for a reply's quote. */
export function jumpTo(id: string): void {
  const target = findMessageRow(id);
  if (!target) return;
  // Reading back: the chat stops following the bottom.
  document.dispatchEvent(new CustomEvent("ccb-read-back"));
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1200);
}

/** The bot at work: what it is doing right now, if it has started on tools, then the dots. */
export function typingElement(avatarSrc: string, live: StepView[] = [], retry: RetryView | null = null): HTMLElement {
  const row = document.createElement("div");
  row.className = "row bot typing";
  row.dataset.avatar = avatarSrc;
  row.append(avatar(avatarSrc));
  updateTypingElement(row, live, retry);
  return row;
}

export type RetryView = NonNullable<ChatState["retrying"]>;

/** "Codex is rate limited · retrying in about 40 s (attempt 1/5)": once its time is past or unknown, "retrying (attempt 1/5)". */
export function retryText(retry: RetryView, now = Date.now()): string {
  const left = retry.retryAt === null ? 0 : Math.ceil((retry.retryAt - now) / 1000);
  const values = { attempt: retry.attempt, max: retry.max };
  const limited = retry.reason === "rateLimited";
  if (left <= 0) return t(limited ? "messages.retryLimited" : "messages.retryConnection", values);
  const wait = left < 60 ? t("messages.retrySeconds", { n: left }) : t("messages.retryMinutes", { n: Math.round(left / 60) });
  return t(limited ? "messages.retryLimitedIn" : "messages.retryConnectionIn", { ...values, wait });
}

/** The retry note's words now (they count down while it waits). */
export function refreshRetryNote(row: HTMLElement | null, retry: RetryView | null | undefined, now = Date.now()): void {
  const note = row?.querySelector<HTMLElement>(".retry-note");
  if (note && retry) note.textContent = retryText(retry, now);
}

/** "Thinking · 12 s" / "Thinking · 1:35": how long the turn has gone without new output. Hidden for the first few seconds. */
export function refreshThinkNote(row: HTMLElement | null, now = Date.now()): void {
  const note = row?.querySelector<HTMLElement>(".think-note");
  if (!row || !note) return;
  const seconds = Math.floor((now - Number(row.dataset.since)) / 1000);
  note.hidden = !(seconds >= 3);
  if (note.hidden) return;
  const time = seconds < 60 ? t("messages.retrySeconds", { n: seconds }) : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  note.textContent = t("messages.thinking", { time });
}

/** Updates the live content while keeping the active avatar's animation and DOM node. */
export function updateTypingElement(row: HTMLElement, live: StepView[] = [], retry: RetryView | null = null): void {
  const key = JSON.stringify([live, retry]);
  if (row.dataset.live === key) return;
  row.dataset.live = key;
  // The "thinking N s" count restarts whenever the steps change (new output).
  const steps = JSON.stringify(live);
  if (row.dataset.steps !== steps || !row.dataset.since) {
    row.dataset.steps = steps;
    row.dataset.since = String(Date.now());
  }
  while (row.children.length > 1) row.lastElementChild!.remove();
  const dots = document.createElement("div");
  dots.className = "dots";
  dots.setAttribute("aria-label", t("messages.working"));
  dots.innerHTML = "<span></span><span></span><span></span><em class=\"think-note\" hidden></em>";
  if (!live.length && !retry) {
    dots.classList.add("bubble", "bot-bubble");
    row.append(dots);
    return;
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble bot-bubble working";
  if (live.length) bubble.append(liveElement(live));
  if (retry) {
    // Codex waiting on a refused request: why the dots go on so long.
    const note = document.createElement("div");
    note.className = "retry-note";
    note.setAttribute("role", "status");
    note.textContent = retryText(retry);
    bubble.append(note);
  }
  bubble.append(dots);
  row.append(bubble);
}
