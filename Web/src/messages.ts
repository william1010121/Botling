import { post } from "./bridge";
import { t } from "./i18n";
import { acceptPictures } from "./pictures";
import type { ComponentRender } from "./plugins";
import { attachmentStrip, botBody, chevron, jumpTo } from "./message-body";
import { taskChips } from "./tasks";
import type { ChatState, ComponentInfo, DisplayView, MessageMenuItem, MessageView, SeenView } from "./types";
import { escapeHTML, queuedBadge } from "./util";

/** The message bodies live in message-body.ts; the names this file exported before stay importable from here. */
export { attachmentStrip, foldedChoices, ignoreQuestionButton, ignoredQuestion, jumpTo, refreshRetryNote, refreshThinkNote, retryText, typingElement, updateTypingElement } from "./message-body";
export type { RetryView } from "./message-body";

/** What plugins add to how messages are drawn. */
export const extensions = {
  /** Components drawn by plugins in the page, ahead of template components. */
  components: new Map<string, { plugin: string; render: ComponentRender }>(),
  /** Called with each drawn message, so a plugin can change it (LaTeX in your own messages). */
  afterRender: [] as { plugin: string; handler: (element: HTMLElement, message: { id: string; role: string; text: string }) => void }[],
  /** What your own message's bubble shows, from its text (a long paste taken out of it). */
  userText: [] as { plugin: string; handler: (text: string) => string }[],
  /** Right-column pages from plugins, by "plugin/id". */
  panels: new Map<string, { plugin: string; render: (root: HTMLElement) => void | (() => void) }>(),
  /**
   * A bar over a component a bot's message shows (the Board's pin / ↻ / ⋯): a plugin draws it from the card's display, or
   * returns null for none. The card and the bars sit in one `.pin-holder`, which shows them on hover; a bar with
   * `data-holder="pinned"` marks its holder `pinned`. `stamp`: what the bars depend on besides the card (the Board: which components
   * are pinned), asked before the messages are drawn: a message with a card is drawn again when it changes.
   */
  cardBars: [] as { plugin: string; make: (display: DisplayView, messageID: string, index: number) => HTMLElement | null; stamp?: (state: ChatState) => string }[],
  /** Runs a plugin's code, unloading the plugin if it throws. */
  guard: <T>(_plugin: string, run: () => T): T | undefined => run(),
};

/** Developer mode: bot replies get a "not right" flag (set from the state before drawing). */
export const feedback = { enabled: false };

/** Plugins' commands in a reply's menu (`contributes.menus["message/context"]`); none: no menu button. */
export const messageMenu: { items: MessageMenuItem[]; previews: MessageMenuItem[] } = { items: [], previews: [] };

/** The page's icons a plugin's quick menu entry may name (`icon`); any other name is a dot. */
const quickIcons: Record<string, string> = { cube: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>` };
export const quickIcon = (name: string | undefined) => (name && quickIcons[name]) || "•";


const flagIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4h11l-2 4 2 4H5"/></svg>`;

const moreIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`;
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
  for (const { plugin, handler } of extensions.afterRender) {
    extensions.guard(plugin, () => handler(row, { id: message.id, role: message.role, text: message.text }));
  }
  return row;
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
      const actions = message.role === "bot" && (feedback.enabled || messageMenu.items.length) ? actionColumn(message) : replyButton(message);
      const tasks = message.tasks?.length ? taskChips(message.id, message.tasks) : null;
      if (message.speaker || tasks || message.role === "notice") {
        // The group chat: who said it, above what they said.
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
        // A component in the reply takes the whole message column.
        if (body.classList.contains("wide")) {
          column.classList.add("wide");
          row.classList.add("wide");
        }
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

export function avatar(src: string | null): HTMLElement {
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
  if (feedback.enabled) column.append(feedbackFlag(message));
  // Plugins' quick entries are buttons of their own (the component studio's "Make into component"); the rest are rows of "⋯".
  for (const item of messageMenu.items.filter((entry) => entry.quick)) column.append(quickButton(message, item, "message/context"));
  if (messageMenu.items.some((entry) => !entry.quick)) column.append(menuButton(message));
  return column;
}

/** A plugin's quick menu entry as a reply's button: the app page runs its command with the bot and message (and, on a preview card, which card). */
function quickButton(message: MessageView, item: MessageMenuItem, menu: "message/context" | "message/preview", preview?: number): HTMLButtonElement {
  const label = message.component ? item.alt ?? item.title : item.title;
  const button = document.createElement("button");
  button.className = "reply-button make-component";
  button.dataset.command = item.command;
  button.setAttribute("aria-label", label);
  button.title = message.component || !item.hint ? label : `${label}: ${item.hint}`;
  button.innerHTML = quickIcon(item.icon);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    post({ type: "runCommand", id: item.command, via: "menu", menu, messageID: message.id, ...(preview === undefined ? {} : { preview }) });
  });
  return button;
}

/** The reply menu now open (one at a time). */
let openMenu: { message: string; close: () => void } | null = null;

/** "⋯" beside a reply: plugins' commands for it; the app page runs the one picked (only one this menu offers). */
function menuButton(message: MessageView): HTMLElement {
  const button = document.createElement("button");
  button.className = "reply-button message-menu-button";
  button.setAttribute("aria-label", t("messages.more"));
  button.setAttribute("aria-haspopup", "menu");
  button.innerHTML = moreIcon;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const was = openMenu?.message;
    openMenu?.close();
    if (was === message.id) return;
    const menu = document.createElement("div");
    menu.className = "message-menu";
    menu.setAttribute("role", "menu");
    const close = () => { menu.remove(); openMenu = null; document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true); };
    const outside = (down: Event) => { if (!(down.target instanceof Node && (menu.contains(down.target) || button.contains(down.target)))) close(); };
    const escape = (key: KeyboardEvent) => { if (key.key === "Escape") close(); };
    for (const item of messageMenu.items.filter((entry) => !entry.quick)) {
      const entry = document.createElement("button");
      entry.setAttribute("role", "menuitem");
      entry.textContent = item.title;
      entry.addEventListener("click", () => {
        close();
        post({ type: "runCommand", id: item.command, via: "menu", menu: "message/context", messageID: message.id });
      });
      menu.append(entry);
    }
    const box = button.getBoundingClientRect();
    menu.style.top = `${box.bottom + 4}px`;
    menu.style.left = `${Math.max(8, box.right - 200)}px`;
    document.body.append(menu);
    openMenu = { message: message.id, close };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
  });
  return button;
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
  if (message.queued) body.append(queuedBadge());
  // Sent by a plugin, not typed by you (`bots.send`).
  if (message.via) {
    const via = document.createElement("div");
    via.className = "speaker via";
    via.textContent = t("messages.via", { name: message.via });
    body.append(via);
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
  const text = extensions.userText.reduce((shown, { plugin, handler }) => extensions.guard(plugin, () => handler(shown)) ?? shown, message.text);
  if (text) {
    const bubble = document.createElement("div");
    bubble.className = "bubble user-bubble";
    bubble.innerHTML = escapeHTML(text).replace(/\n/g, "<br>");
    body.append(bubble);
  }
  return body;
}
