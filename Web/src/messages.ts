import { artifactCard } from "./artifacts";
import { post } from "./bridge";
import { t } from "./i18n";
import { pinBar, specPinButton } from "./pins";
import { answerAction, answerImages, choicesData, commandCard, componentElement, detailTarget, fallbackChoices } from "./components";
import type { ComponentAnswer } from "./components";
import { mediaHTML, renderMarkdown } from "./markdown";
import { acceptPictures } from "./pictures";
import type { ComponentRender } from "./plugins";
import { liveElement, stepsElement } from "./steps";
import { taskChips } from "./tasks";
import type { ComponentInfo, DisplayView, FileView, MessageView, SeenView, SpecChipView, StepView } from "./types";
import { escapeHTML } from "./util";
import { characterAvatar } from "./animated-avatar";

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
  const tasks = row.querySelector<HTMLElement>(".task-chips");
  if (tasks || message.reactionEnabled || message.seen?.length) {
    let holder = row.querySelector<HTMLElement>(".user-body, .speaker-column, .bot-column");
    if (!holder) {
      const body = row.querySelector<HTMLElement>(".bot-bubble, .notice-bubble, .relay-column, .relay:not(.row), .error-text");
      if (body) {
        holder = document.createElement("div");
        holder.className = "reaction-message-column";
        body.replaceWith(holder);
        holder.append(body);
      }
    }
    if (holder) {
      // Keep all compact metadata together; expanded work details get their own footer line.
      const footer = document.createElement("div");
      footer.className = "message-footer";
      if (tasks) footer.append(tasks);
      if (message.reactionEnabled) footer.append(reactionBar(message));
      if (message.seen?.length) footer.append(seenMarks(message.seen));
      holder.append(footer);
    }
  }
  if (message.completionVerification) {
    const holder = row.querySelector(".bot-column, .speaker-column");
    holder?.append(completionVerificationElement(message.completionVerification));
  }
  for (const { plugin, handler } of extensions.afterRender) {
    extensions.guard(plugin, () => handler(row, { id: message.id, role: message.role, text: message.text }));
  }
  return row;
}

/** App-owned verdict on this reply; all provider text is inserted as text, never HTML. */
export function completionVerificationElement(record: NonNullable<MessageView["completionVerification"]>): HTMLElement {
  const card = document.createElement("details");
  card.className = "completion-verification";
  card.dataset.state = record.state;
  card.dataset.verdict = record.verdict ?? "";
  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.setAttribute("role", "status");
  title.className = "verification-title";
  const verdicts = {
    CONTINUE: "verification.continue", CONTINUE_ANALYSIS: "verification.analysis",
    COMPLETE: "verification.complete", NEEDS_TERMINAL_SIGNAL: "verification.evidence",
    WAITING_USER: "verification.user", CANCELLED: "verification.cancelled",
    WAITING_DEPENDENCY: "verification.dependency", UNKNOWN: "verification.unknown",
    UNAVAILABLE: "verification.unavailable",
  } as const;
  const label = record.state === "checking" ? t("verification.checking")
    : record.state === "interrupted" ? t("verification.interrupted")
    : record.verdict ? t(verdicts[record.verdict]) : t("verification.unknown");
  const name = document.createElement("span");
  name.className = "verification-name";
  name.textContent = `${t("verification.title")} · `;
  const status = document.createElement("span");
  status.className = "verification-status";
  status.textContent = label;
  title.append(name, status);
  const model = document.createElement("div");
  model.className = "verification-model";
  model.textContent = `${record.model} · medium`;
  summary.append(title);
  const content = document.createElement("div");
  content.className = "verification-details";
  content.append(model);
  card.append(summary, content);
  if (record.state === "judged" && record.reason) {
    const reason = document.createElement("div");
    reason.className = "verification-reason";
    reason.textContent = record.reason;
    content.append(reason);
  }
  if (record.continuationPaused) {
    const paused = document.createElement("div");
    paused.textContent = t("verification.paused");
    content.append(paused);
  }
  return card;
}

export function reactionBar(message: MessageView): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "reactions";
  const send = (emoji: string, present: boolean) => post({ type: "setReaction", messageID: message.id, emoji, present });
  for (const reaction of message.reactions ?? []) {
    const chip = document.createElement("button");
    chip.className = "reaction-chip";
    chip.textContent = `${reaction.emoji} ${reaction.actors.length}`;
    chip.title = `${reaction.emoji} · ${reaction.actors.join(", ")}`;
    chip.setAttribute("aria-label", chip.title);
    chip.setAttribute("aria-pressed", String(reaction.own));
    chip.addEventListener("click", () => send(reaction.emoji, !reaction.own));
    bar.append(chip);
  }
  const picker = document.createElement("details");
  picker.className = "reaction-picker";
  const add = document.createElement("summary");
  add.textContent = "☺ +";
  add.setAttribute("aria-label", t("messages.addReaction"));
  add.title = t("messages.addReaction");
  picker.append(add);
  const palette = document.createElement("div");
  palette.className = "reaction-palette";
  for (const emoji of ["👍", "❤️", "😂", "🎉", "🤔", "👀"]) {
    const button = document.createElement("button");
    button.textContent = emoji;
    button.setAttribute("aria-label", t("messages.reactEmoji", { emoji }));
    const own = message.reactions?.some((r) => r.emoji === emoji && r.own) ?? false;
    button.setAttribute("aria-pressed", String(own));
    button.addEventListener("click", () => { picker.open = false; send(emoji, !own); });
    palette.append(button);
  }
  picker.append(palette);
  bar.append(picker);
  return bar;
}

/**
 * Original letters show read status; Cute user-message heads highlight recipients separately
 * from the small actual-read checks. Replies still highlight who has read them.
 */
export function seenMarks(seen: SeenView[]): HTMLElement {
  const marks = document.createElement("div");
  marks.className = "seen-marks";
  const reached = seen.filter((head) => head.seen).map((head) => head.name);
  const waiting = seen.filter((head) => !head.seen).map((head) => head.name);
  const recipients = seen.filter((head) => head.recipient).map((head) => head.name);
  const label = [recipients.length ? t("messages.toHeads", { names: recipients.join(", ") }) : "", reached.length ? t("messages.seenBy", { names: reached.join(", ") }) : "", waiting.length ? t("messages.notSeenBy", { names: waiting.join(", ") }) : ""].filter(Boolean).join(" · ");
  marks.title = label;
  marks.setAttribute("aria-label", label);
  for (const head of seen) {
    const receipt = document.createElement("span");
    receipt.className = "head-receipt";
    receipt.title = [head.recipient ? t("messages.toHeads", { names: head.name }) : "", t(head.seen ? "messages.seenBy" : "messages.notSeenBy", { names: head.name })].filter(Boolean).join(" · ");
    const mark = document.createElement("span");
    mark.className = head.seen ? "seen-mark on" : "seen-mark";
    if (head.recipient != null) mark.classList.add("recipient-mark");
    if (head.recipient) mark.classList.add("recipient");
    mark.textContent = head.mark;
    mark.dataset.mark = head.mark;
    mark.setAttribute("aria-hidden", "true");
    receipt.append(mark);
    if (head.seen) {
      const check = document.createElement("span");
      check.className = "seen-check";
      check.dataset.mark = head.mark;
      check.textContent = "✓";
      check.setAttribute("aria-hidden", "true");
      receipt.append(check);
    }
    marks.append(receipt);
  }
  return marks;
}

function drawRole(row: HTMLElement, message: MessageView, components: Record<string, ComponentInfo>): void {
  switch (message.role) {
    case "user":
      // The chat's background work never goes under your own line, only under the bot's.
      row.append(userBody(message), replyButton(message));
      break;
    case "bot":
    case "notice": {
      const body = botBody(message, components);
      const actions = message.role === "bot" && (feedback.enabled || makeComponents.enabled) ? actionColumn(message) : replyButton(message);
      const chips = message.specs?.length ? specChips(message, components) : null;
      const tasks = message.tasks?.length ? taskChips(message.id, message.tasks) : null;
      if (message.speaker || chips || tasks || message.completionVerification) {
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
      // How many buttons its hover toolbar has: a card's own bar at the top-right of a wide reply
      // moves left of it by that much, so neither covers the other (chat.css).
      if (row.classList.contains("wide")) row.dataset.actions = String(actions.matches(".message-actions") ? actions.children.length : 1);
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
      relay.setAttribute("aria-label", t("messages.fromMain", { text: message.text }));
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
  card.querySelector(".feedback-title")!.textContent = t("feedback.title", { bot: note.about });
  const words = card.querySelector<HTMLElement>(".feedback-words")!;
  words.textContent = note.words || t("feedback.noWords");
  words.classList.toggle("empty", !note.words);
  const toggle = card.querySelector<HTMLButtonElement>(".feedback-toggle")!;
  const full = card.querySelector<HTMLElement>(".feedback-full")!;
  full.textContent = message.text;
  const show = (open: boolean) => {
    full.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.querySelector("span")!.textContent = open ? t("feedback.hideFull") : t("feedback.showFull");
    toggle.classList.toggle("open", open);
  };
  show(openReports.has(message.id));
  toggle.addEventListener("click", () => {
    const open = !openReports.has(message.id);
    if (open) openReports.add(message.id);
    else openReports.delete(message.id);
    show(open);
  });
  card.setAttribute("aria-label", t("feedback.label", { bot: note.about, words: note.words }));
  column.append(card);
  if (message.attachments?.length) column.append(attachmentStrip(message.attachments));
  return column;
}

function avatar(src: string | null): HTMLElement {
  return characterAvatar(src);
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
    const label = message.component ? t("messages.addToBot") : t("messages.makeComponent");
    const make = document.createElement("button");
    make.className = "reply-button make-component";
    make.setAttribute("aria-label", label);
    make.title = message.component ? label : t("messages.makeComponentTitle", { label });
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
    const words = filling ? t("specChip.filling", { bot: filling }) : spec.status === "done" ? t("specChip.component") : building ? t("specChip.building") : spec.suggested ? t("specChip.suggested") : t("specChip.spec");
    chip.innerHTML = `${building ? `<span class="spinner" aria-hidden="true"></span>` : cubeIcon}<span></span><span class="spec-chip-arrow" aria-hidden="true">›</span>`;
    chip.querySelector("span:not(.spinner)")!.textContent = `${words} · ${spec.component ?? spec.name}`;
    chip.title = filling ? t("specChip.fillingTitle", { bot: filling }) : spec.suggested ? t("specChip.suggestedTitle") : building ? t("specChip.buildingTitle") : spec.open ? t("specChip.showing") : t("specChip.openInPanel");
    chip.addEventListener("click", () => post({ type: "pressSpec", id: spec.id }));
    strip.append(chip);
    if (spec.status === "done") strip.append(editSpecButton(spec));
  }
  return strip;
}

function editSpecButton(spec: SpecChipView): HTMLButtonElement {
  const edit = document.createElement("button");
  edit.className = "spec-edit";
  edit.textContent = t("specChip.edit");
  edit.setAttribute("aria-expanded", String(spec.open));
  edit.title = spec.open ? t("specChip.showing") : t("specChip.editTitle");
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
  const draw = () => componentElement(name, components[name], display.data, null, `spec-${spec.id}`, display.images, detailTarget(display), undefined, "chat", false, null, true);
  const card = display.command
    ? commandCard(display, `spec:${spec.id}`, 0, draw, {
        send: (request) => post({ type: "specCommand", id: spec.id, ...request }),
        lazy: true,
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
  label.querySelector("span:not(.spinner)")!.textContent = spec.status === "building" ? t("specChip.newVersion", { name }) : `${t("specChip.component")} · ${name}`;
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
  flag.setAttribute("aria-label", t("feedback.flagLabel"));
  flag.title = t("feedback.flag");
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
  box.innerHTML = `<div class="report-title">${escapeHTML(t("feedback.question"))}</div>
<textarea rows="3" placeholder="${escapeHTML(t("feedback.placeholder"))}"></textarea>
<div class="report-images" hidden></div>
<div class="report-actions"><span></span><button class="primary send">${escapeHTML(t("composer.send"))}</button></div>`;
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
  button.setAttribute("aria-label", t("messages.reply"));
  button.innerHTML = replyIcon;
  button.addEventListener("click", () => post({ type: "reply", messageID: message.id }));
  return button;
}

function userBody(message: MessageView): HTMLElement {
  const body = document.createElement("div");
  body.className = "user-body";
  // A line someone else wrote (a subagent's view: what its bot sent it), under their name.
  if (message.speaker) {
    const name = document.createElement("div");
    name.className = "speaker";
    name.textContent = message.speaker;
    body.append(name);
  }
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
  // Cut off before it answered: its words and steps so far stay, and it says so.
  if (message.interrupted) {
    const note = document.createElement("div");
    note.className = "interrupted-note";
    note.textContent = t("messages.interrupted");
    bubble.append(note);
  }
  if (message.choices) {
    // Loose: the app leaves out a nil chosen or answer (undefined), not only null.
    const answered = message.chosen != null || message.answer != null;
    bubble.append(answered && !unfolded.has(message.id) ? foldedChoices(message, components) : choicesElement(message, components));
  }
  // Ones at the end, or with no place (saved before places were kept), come after the text.
  displays.filter((d) => !inline.includes(d)).forEach(appendComponent);
  // Result pages it links to, as preview cards under the text (the links stay chips too).
  message.previews?.forEach((preview, index) => {
    const card = componentElement(preview.name, components[preview.name], preview.data, null, `${message.id}/preview-${index}`, null, null, undefined, "chat", false, null, true);
    if (!card) return;
    card.classList.add("page-preview");
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
    make.innerHTML = `${cubeIcon}<span>${escapeHTML(t("messages.makeComponent"))}</span>`;
    make.addEventListener("click", (event) => {
      event.stopPropagation();
      post({ type: "makeComponent", messageID: message.id, preview: index });
    });
    bar.append(make);
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
function componentView(message: MessageView, display: DisplayView, index: number, components: Record<string, ComponentInfo>): HTMLElement | null {
  // Shown with no data and nothing to get it from: nothing to draw, and no error card in the
  // user's chat (the app tells the bot with the user's next message).
  if (display.status === "empty" && !display.command) return null;
  // Data from a command: the card around it asks to allow it, runs it, or says why it failed.
  const element = display.command || display.status
    ? commandCard(display, message.id, index, () => drawComponent(message, display, index, components), { lazy: true })
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
    index === 0 ? message.id : `${message.id}/show-${index}`, display.images, detailTarget(display), undefined, "chat", false, save, true);
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
  const component = componentElement("choices", components.choices, choicesData(choices, message.chosen ?? null, message.answer ?? null), onAnswer, message.id, null, null, undefined, "chat", false, null, true);
  const options = component ?? fallbackChoices(choices, message.chosen ?? null, message.answer ?? null, onAnswer ? (index) => onAnswer({ index }) : null);
  if (message.open) return options;
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
 * An answered question as one line, what you picked; click to see every option again. No tick:
 * the answer may as well be "Don't allow" or "No longer needed".
 */
export function foldedChoices(message: MessageView, components: Record<string, ComponentInfo>): HTMLElement {
  const picked = message.chosen != null ? message.choices?.[message.chosen]?.label : null;
  const label = picked ?? message.answer ?? t("messages.answered");
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
  row.dataset.avatar = avatarSrc;
  row.append(avatar(avatarSrc));
  updateTypingElement(row, live);
  return row;
}

/** Updates the live content while keeping the active avatar's animation and DOM node. */
export function updateTypingElement(row: HTMLElement, live: StepView[] = []): void {
  const key = JSON.stringify(live);
  if (row.dataset.live === key) return;
  row.dataset.live = key;
  while (row.children.length > 1) row.lastElementChild!.remove();
  const dots = document.createElement("div");
  dots.className = "dots";
  dots.setAttribute("aria-label", t("messages.working"));
  dots.innerHTML = "<span></span><span></span><span></span>";
  if (!live.length) {
    dots.classList.add("bubble", "bot-bubble");
    row.append(dots);
    return;
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble bot-bubble working";
  bubble.append(liveElement(live), dots);
  row.append(bubble);
}
