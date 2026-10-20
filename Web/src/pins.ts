import { post } from "./bridge";
import { commandCard, componentElement, componentSizes, detailTarget, markPinFrames, resizeFrame, sizeInfo } from "./components";
import type { ChatState, ChipStatus, ComponentInfo, DisplayView, PinChoiceView, PinRefresh, PinSize, PinView } from "./types";

/**
 * Components pinned to a bot. In the chat a component shows pin / ↻ / ⋯ on hover; pinning asks
 * how it should refresh and shows its command, then offers Undo. Pins show as chips above the
 * input box (click one: the full component rises from the bottom) and as cards on the bot's
 * Board. Commands only run once allowed, as for any card: Swift checks.
 */

/** What the pin bar in the chat needs from the latest state. */
const current: { botName: string; pins: PinView[]; components: Record<string, ComponentInfo>; choices: PinChoiceView[] } = {
  botName: "this bot", pins: [], components: {}, choices: [],
};

const icons = {
  pin: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2v.8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`,
  refresh: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`,
  more: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01"/></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
  grip: `<svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor" aria-hidden="true"><circle cx="4" cy="3" r="1.3"/><circle cx="8" cy="3" r="1.3"/><circle cx="4" cy="7" r="1.3"/><circle cx="8" cy="7" r="1.3"/><circle cx="4" cy="11" r="1.3"/><circle cx="8" cy="11" r="1.3"/></svg>`,
  /** A pin chip whose component names no icon: a small widget. */
  component: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg>`,
  close: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`,
};

function newID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID().toUpperCase();
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, hex).toUpperCase();
}

function button(className: string, label: string, html: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.className = className;
  element.setAttribute("aria-label", label);
  element.title = label;
  element.innerHTML = html;
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick(event);
  });
  return element;
}

function refreshWords(refresh: PinRefresh, minutes: number): string {
  return refresh === "shown" ? "When shown" : refresh === "interval" ? `Every ${minutes} min` : "Only on ↻";
}

// MARK: In the chat

/**
 * The bar over a chat component that can be pinned: pin (or a Pinned badge that opens the pin),
 * run its command again, and more.
 */
export function pinBar(display: DisplayView, messageID: string, index: number): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "pin-bar";
  const pinIt = (anchor: HTMLElement) => openPinDialog(anchor, {
    name: display.name,
    command: display.command ?? null,
    pin: (refresh, minutes) => ({ type: "pin", id: newID(), messageID, index, refresh, minutes }),
  });
  if (display.pinned) {
    const badge = button("pin-badge", "Pinned: show it", `${icons.pin}<span>Pinned</span>`, () => {
      document.dispatchEvent(new CustomEvent("ccb-open-pin", { detail: display.name }));
    });
    bar.append(badge);
  } else {
    const pin = button("pin-tool", "Pin to this bot", icons.pin, () => pinIt(pin));
    bar.append(pin);
  }
  if (display.command && (display.status === "done" || display.status === "failed")) {
    bar.append(button("pin-tool", "Run the command again", icons.refresh, () => {
      post({ type: "componentCommand", messageID, index, command: display.command ?? "", folder: display.folder ?? "", force: true });
    }));
  }
  const more = button("pin-tool", "More", icons.more, () => {
    const pinned = current.pins.find((p) => p.name === display.name);
    openMenu(more, [
      pinned
        ? { label: "Unpin", run: () => post({ type: "unpin", id: pinned.id }) }
        : { label: `Pin to ${current.botName}…`, run: () => pinIt(more) },
      { label: "Report this component…", run: () => more.closest(".pin-holder")?.querySelector<HTMLButtonElement>(".flag")?.click() },
    ]);
  });
  bar.append(more);
  return bar;
}

type PinAction = Extract<Parameters<typeof post>[0], { type: "pin" }>;

/**
 * "Pin to <bot>": how it refreshes (when shown, every N minutes, only on ↻) and the command that
 * redraws it. One without a command keeps the data it is drawn with now. Pin, then Undo.
 */
function openPinDialog(anchor: HTMLElement, options: { name: string; command: string | null; pin: (refresh: PinRefresh, minutes: number) => PinAction }): void {
  closePopups();
  const dialog = document.createElement("div");
  dialog.className = "pin-dialog pin-popup";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", `Pin to ${current.botName}`);
  const title = document.createElement("div");
  title.className = "pin-dialog-title";
  title.textContent = `Pin to ${current.botName}`;
  const note = document.createElement("div");
  note.className = "pin-dialog-note";
  dialog.append(title, note);
  if (options.command) {
    note.textContent = `Keeps ${options.name} on this bot and redraws it with its command.`;
    const line = document.createElement("div");
    line.className = "pin-dialog-line";
    line.innerHTML = `<span>Command</span><code class="pin-dialog-command"></code>`;
    line.querySelector("code")!.textContent = options.command;
    const heading = document.createElement("div");
    heading.className = "pin-dialog-heading";
    heading.textContent = "Refresh";
    dialog.append(line, heading);
    const group = `pin-refresh-${newID()}`;
    for (const value of ["shown", "interval", "manual"] as PinRefresh[]) {
      const label = document.createElement("label");
      label.className = "pin-radio";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = group;
      input.value = value;
      input.checked = value === "shown";
      label.append(input);
      if (value === "interval") {
        const minutes = document.createElement("input");
        minutes.type = "number";
        minutes.min = "1";
        minutes.value = "15";
        minutes.className = "pin-minutes";
        minutes.setAttribute("aria-label", "Minutes");
        minutes.addEventListener("focus", () => { input.checked = true; });
        label.append(document.createTextNode("Every "), minutes, document.createTextNode(" min"));
      } else {
        label.append(document.createTextNode(value === "shown" ? "When shown" : "Only when I press ↻"));
      }
      dialog.append(label);
    }
    const hint = document.createElement("div");
    hint.className = "pin-dialog-note";
    hint.textContent = "It runs only once you have allowed this command for the bot's folder.";
    dialog.append(hint);
  } else {
    note.textContent = `Keeps ${options.name} on this bot as it is drawn now (it has no command to redraw it).`;
  }
  const actions = document.createElement("div");
  actions.className = "pin-dialog-actions";
  const cancel = document.createElement("button");
  cancel.className = "plain";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => dialog.remove());
  const confirm = document.createElement("button");
  confirm.className = "primary";
  confirm.textContent = "Pin";
  confirm.addEventListener("click", () => {
    const picked = dialog.querySelector<HTMLInputElement>("input[type=radio]:checked");
    const refresh = options.command ? ((picked?.value as PinRefresh | undefined) ?? "shown") : "manual";
    const minutes = Math.max(1, Math.round(Number(dialog.querySelector<HTMLInputElement>(".pin-minutes")?.value ?? "15")) || 15);
    const action = options.pin(refresh, minutes);
    post(action);
    dialog.remove();
    showToast(`Pinned ${options.name} to ${current.botName}`, () => post({ type: "unpin", id: action.id }));
  });
  actions.append(cancel, confirm);
  dialog.append(actions);
  place(dialog, anchor);
  confirm.focus();
}

function showToast(text: string, undo: () => void): void {
  document.querySelector(".pin-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "pin-toast";
  toast.setAttribute("role", "status");
  const words = document.createElement("span");
  words.textContent = text;
  const undoButton = document.createElement("button");
  undoButton.textContent = "Undo";
  undoButton.addEventListener("click", () => {
    undo();
    toast.remove();
  });
  toast.append(words, undoButton);
  document.body.append(toast);
  setTimeout(() => toast.remove(), 6000);
}

// MARK: Menus and popups

/** A menu's entry; a heading or note is a line of text, not a button. */
interface MenuItem { label: string; run: () => void; checked?: boolean; disabled?: boolean; heading?: boolean; note?: boolean; code?: boolean }

function openMenu(anchor: HTMLElement, items: (MenuItem | "-")[]): void {
  closePopups();
  const menu = document.createElement("div");
  menu.className = "pin-menu pin-popup";
  menu.setAttribute("role", "menu");
  for (const item of items) {
    if (item === "-") {
      const line = document.createElement("div");
      line.className = "pin-menu-line";
      menu.append(line);
      continue;
    }
    if (item.heading || item.note) {
      const text = document.createElement("div");
      text.className = item.heading ? "pin-menu-heading" : "pin-menu-note" + (item.code ? " code" : "");
      text.textContent = item.label;
      text.title = item.label;
      menu.append(text);
      continue;
    }
    const entry = document.createElement("button");
    entry.setAttribute("role", "menuitem");
    entry.textContent = item.label;
    if (item.checked) entry.classList.add("checked");
    entry.disabled = !!item.disabled;
    entry.addEventListener("click", (event) => {
      event.stopPropagation();
      menu.remove();
      item.run();
    });
    menu.append(entry);
  }
  place(menu, anchor);
}

function closePopups(): void {
  document.querySelectorAll(".pin-popup").forEach((popup) => popup.remove());
}

/** A popup by its anchor, inside the window; a click elsewhere closes it. */
function place(popup: HTMLElement, anchor: HTMLElement): void {
  document.body.append(popup);
  const rect = anchor.getBoundingClientRect();
  const width = popup.offsetWidth || 300;
  const height = popup.offsetHeight || 200;
  const below = rect.bottom + 6 + height < window.innerHeight;
  popup.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
  popup.style.top = `${Math.max(8, below ? rect.bottom + 6 : rect.top - height - 6)}px`;
  // Opened from the keyboard: its first entry has focus, Escape closes it and goes back.
  if (popup.classList.contains("pin-menu")) {
    popup.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    popup.addEventListener("keydown", (event) => {
      const entries = [...popup.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const at = entries.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape") {
        event.stopPropagation();
        popup.remove();
        anchor.focus({ preventScroll: true });
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = entries[(at + (event.key === "ArrowDown" ? 1 : entries.length - 1)) % entries.length];
        next?.focus();
      }
    });
  }
  const close = (event: MouseEvent) => {
    if (!popup.isConnected) return document.removeEventListener("mousedown", close);
    if (!popup.contains(event.target as Node)) {
      popup.remove();
      document.removeEventListener("mousedown", close);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

/** The menu of a pin (a chip's right-click, a sheet's or card's ⋯). */
function pinMenu(anchor: HTMLElement, pin: PinView, options: { sizes?: boolean; about?: boolean } = {}): void {
  const at = current.pins.findIndex((p) => p.id === pin.id);
  const items: (MenuItem | "-")[] = [];
  if (options.about) {
    // A Board tile has no header: its name, command and when it ran are said here.
    items.push({ label: pin.name, heading: true, run: () => {} });
    items.push({ label: whenWords(pin), note: true, run: () => {} });
    if (pin.display.command) items.push({ label: `$ ${pin.display.command}`, note: true, code: true, run: () => {} });
    items.push("-");
  }
  if (pin.display.command) {
    for (const [refresh, minutes] of [["shown", pin.minutes], ["interval", pin.minutes], ["manual", pin.minutes]] as [PinRefresh, number][]) {
      items.push({ label: refreshWords(refresh, minutes), checked: pin.refresh === refresh, run: () => post({ type: "setPinRefresh", id: pin.id, refresh, minutes }) });
    }
    items.push("-");
  }
  if (options.sizes) {
    items.push(...sizeItems(pin));
    items.push("-");
  }
  items.push({ label: "Move earlier", disabled: at <= 0, run: () => post({ type: "movePin", id: pin.id, to: at - 1 }) });
  items.push({ label: "Move later", disabled: at < 0 || at >= current.pins.length - 1, run: () => post({ type: "movePin", id: pin.id, to: at + 1 }) });
  items.push("-");
  items.push({ label: "Unpin", run: () => post({ type: "unpin", id: pin.id }) });
  openMenu(anchor, items);
}

const sizeWords: Record<PinSize, string> = { "1x1": "Small", "2x1": "Wide", "1x2": "Tall", "2x2": "Large", "4x2": "Extra wide" };

/** A size as its card's button and menu show it: "Wide 2×1". */
export function sizeLabel(size: PinSize): string {
  const { w, h } = sizeInfo(size);
  return `${sizeWords[size]} ${w}×${h}`;
}

/**
 * The sizes a card can take: the ones its component has a layout for (about.md's `Sizes:`), and
 * the one it has now if that is not among them (an old pin, or the component dropped it).
 */
function sizeItems(pin: PinView): MenuItem[] {
  const sizes = componentSizes(current.components[pin.name]);
  const shown = sizes.includes(pin.size) ? sizes : [...sizes, pin.size];
  return shown.map((size) => ({ label: sizeLabel(size), checked: pin.size === size, run: () => { if (size !== pin.size) post({ type: "resizePin", id: pin.id, size }); } }));
}

/** "Pin a component": what this bot drew (with a Command marked), and components with a Command. */
function openPicker(): void {
  closePopups();
  const backdrop = document.createElement("div");
  backdrop.className = "pin-picker-backdrop pin-popup";
  const picker = document.createElement("div");
  picker.className = "pin-picker";
  picker.setAttribute("role", "dialog");
  picker.setAttribute("aria-label", "Pin a component");
  const head = document.createElement("div");
  head.className = "pin-picker-head";
  const title = document.createElement("div");
  title.className = "pin-picker-title";
  title.textContent = `Pin components to ${current.botName}`;
  const count = document.createElement("span");
  count.className = "pin-picker-count";
  count.textContent = `${current.pins.length} pinned`;
  head.append(title, count);
  picker.append(head);
  const list = document.createElement("div");
  list.className = "pin-picker-list";
  if (!current.choices.length) {
    const empty = document.createElement("div");
    empty.className = "pin-picker-empty";
    empty.textContent = "This bot has not drawn any components yet.";
    list.append(empty);
  }
  for (const choice of current.choices) {
    const row = document.createElement("button");
    row.className = "pin-picker-row" + (choice.pinned ? " pinned" : "");
    row.disabled = choice.pinned;
    const name = document.createElement("span");
    name.className = "pin-picker-name";
    name.textContent = choice.name;
    const tag = document.createElement("span");
    tag.className = "pin-tag" + (choice.command ? " command" : "");
    tag.textContent = choice.command ? "Command" : "Snapshot";
    const detail = document.createElement("span");
    detail.className = "pin-picker-detail";
    detail.textContent = [choice.pinned ? "pinned" : "", choice.uses ? `${choice.uses} use${choice.uses === 1 ? "" : "s"}` : "not used here yet"].filter(Boolean).join(" · ");
    row.append(name, tag, detail);
    if (choice.command) row.title = choice.command;
    row.addEventListener("click", () => {
      backdrop.remove();
      const pin = (refresh: PinRefresh, minutes: number): PinAction => ({ type: "pin", id: newID(), name: choice.name, refresh, minutes });
      if (choice.command) {
        openPinDialog(document.querySelector<HTMLElement>(".pin-chip.add, .board-add") ?? document.body, { name: choice.name, command: choice.command, pin });
      } else {
        const action = pin("manual", 15);
        post(action);
        showToast(`Pinned ${choice.name} to ${current.botName}`, () => post({ type: "unpin", id: action.id }));
      }
    });
    list.append(row);
  }
  picker.append(list);
  const note = document.createElement("div");
  note.className = "pin-picker-note";
  note.textContent = "Components without a Command pin as a snapshot of their last drawing.";
  const actions = document.createElement("div");
  actions.className = "pin-dialog-actions";
  const cancel = document.createElement("button");
  cancel.className = "plain";
  cancel.textContent = "Close";
  cancel.addEventListener("click", () => backdrop.remove());
  actions.append(cancel);
  picker.append(note, actions);
  backdrop.append(picker);
  backdrop.addEventListener("mousedown", (event) => { if (event.target === backdrop) backdrop.remove(); });
  document.body.append(backdrop);
}

// MARK: The pinned component itself

/**
 * The pinned component, with its command's ask, error or wait as in the chat, without the bar.
 * Given a size it is a Board tile: drawn at that size, told it is on the Board.
 */
function pinBody(pin: PinView, size?: PinSize): HTMLElement {
  const key = size ? `board-${pin.id}` : `pin-${pin.id}`;
  const draw = () => {
    const drawn = componentElement(pin.name, current.components[pin.name], pin.display.data, null, key, pin.display.images, detailTarget(pin.display), size, size ? "board" : "chat");
    // Its ccb.setStatus sets this pin's chip.
    markPinFrames(drawn, pin.id);
    return drawn;
  };
  if (pin.display.command || pin.display.status) {
    return commandCard(pin.display, `pin:${pin.id}`, 0, draw, {
      bar: false,
      send: (request) => post({ type: "pinCommand", id: pin.id, ...request }),
    });
  }
  const drawn = draw();
  if (drawn) return drawn;
  const missing = document.createElement("div");
  missing.className = "command-error";
  missing.textContent = `The component ${pin.name} is not installed any more.`;
  return missing;
}

function refreshPin(pin: PinView): void {
  if (!pin.display.command) return;
  post({ type: "pinCommand", id: pin.id, command: pin.display.command, folder: pin.display.folder ?? "", force: true });
}

/** When it last ran, or how it refreshes: "Updated 10:42", "Running…", "Snapshot". */
function whenWords(pin: PinView): string {
  if (pin.display.status === "running") return "Running…";
  if (pin.display.ranAt) return `Updated ${pin.display.ranAt}`;
  return pin.display.command ? refreshWords(pin.refresh, pin.minutes) : "Snapshot";
}

/** Name, command, when it ran, ↻ and ⋯: the top of a pin's sheet. */
function pinHeader(pin: PinView, className: string, extra: HTMLElement[] = [], sizes = false): HTMLElement {
  const head = document.createElement("div");
  head.className = className;
  const title = document.createElement("span");
  title.className = className === "pin-sheet-head" ? "pin-sheet-title" : "board-card-title";
  title.textContent = pin.name;
  head.append(title);
  if (pin.display.command) {
    const code = document.createElement("code");
    code.className = "pin-command";
    code.textContent = pin.display.command;
    code.title = pin.display.folder ? `Runs in ${pin.display.folder}` : pin.display.command;
    head.append(code);
  }
  const fill = document.createElement("span");
  fill.className = "pin-fill";
  head.append(fill);
  const when = document.createElement("span");
  when.className = "pin-when";
  const status = pin.display.status;
  when.textContent = whenWords(pin);
  head.append(when);
  if (pin.display.command) {
    const refresh = button("pin-tool" + (status === "running" ? " spinning" : ""), "Refresh", icons.refresh, () => refreshPin(pin));
    refresh.disabled = status === "running" || status === "approve";
    head.append(refresh);
  }
  const more = button("pin-tool", "More", icons.more, () => pinMenu(more, pin, { sizes }));
  head.append(more, ...extra);
  return head;
}

// MARK: Chips, the sheet, the Board

/**
 * A chip's icon: the component's emoji, its SF Symbol (a picture Swift drew, used as a mask so it
 * takes the chip's colour), or a generic one; with a dot in its tone unless neutral.
 */
function chipIcon(info: ComponentInfo | undefined, status: ChipStatus): HTMLElement {
  const holder = document.createElement("span");
  holder.className = "pin-chip-icon";
  holder.setAttribute("aria-hidden", "true");
  if (info?.iconImage) {
    const symbol = document.createElement("span");
    symbol.className = "pin-chip-symbol";
    const mask = `url("${info.iconImage}")`;
    symbol.style.setProperty("mask-image", mask);
    symbol.style.setProperty("-webkit-mask-image", mask);
    holder.append(symbol);
  } else if (info?.icon && !/^[a-z0-9.]+$/.test(info.icon)) {
    holder.textContent = info.icon;
  } else {
    holder.innerHTML = icons.component;
  }
  if (status.tone !== "neutral") {
    const dot = document.createElement("span");
    dot.className = "pin-chip-dot";
    holder.append(dot);
  }
  return holder;
}

/** A pin as its sheet or tile draws it: what only its chip shows is left out, so a new chip status does not reload the frame. */
function drawnPart(pin: PinView): PinView {
  return { ...pin, headline: "", chip: undefined };
}

/** The Board's smallest cell and the gap between cells, in px (chat.css has the same gap). */
const boardCell = 150;
const boardGap = 14;

/**
 * The pins of the chat on show: chips above the input box with the sheet they raise, and the
 * Board in place of the messages. Drawn from each state; parts that did not change are kept, so
 * component frames do not load again.
 */
export class PinArea {
  private readonly dock: HTMLElement;
  private readonly sheet: HTMLElement;
  private readonly board: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly boardHead: HTMLElement;
  private openID: string | null = null;
  private sheetKey = "";
  private dockKey = "";
  private headKey = "";
  private readonly cards = new Map<string, { key: string; element: HTMLElement }>();
  private boardShown = false;
  private botID: string | null = null;
  private dragging: string | null = null;
  private enabled = false;
  /** The Board's columns of square cells, from its width. */
  private columns = 0;

  constructor(area: HTMLElement, board: HTMLElement) {
    this.sheet = document.createElement("section");
    this.sheet.className = "pin-sheet";
    this.sheet.hidden = true;
    this.dock = document.createElement("div");
    this.dock.className = "pin-dock";
    this.dock.setAttribute("role", "toolbar");
    this.dock.setAttribute("aria-label", "Pinned components");
    this.dock.hidden = true;
    area.append(this.sheet, this.dock);
    this.board = board;
    this.boardHead = document.createElement("div");
    this.boardHead.className = "board-head";
    this.grid = document.createElement("div");
    this.grid.className = "board-grid";
    board.append(this.boardHead, this.grid);
    new ResizeObserver(() => this.layOut()).observe(this.grid);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(".pin-popup")) closePopups();
      else if (this.openID) this.close();
    });
    document.addEventListener("ccb-open-pin", (event) => {
      const pin = current.pins.find((p) => p.name === (event as CustomEvent<string>).detail);
      if (pin && !this.boardShown) this.open(pin.id);
    });
  }

  update(state: ChatState): void {
    this.enabled = !!state.pins && !state.subagent;
    current.botName = state.botName;
    current.pins = state.pins ?? [];
    current.components = state.components;
    current.choices = state.pinChoices ?? [];
    if (state.botID !== this.botID) {
      this.botID = state.botID;
      this.openID = null;
    }
    const board = this.enabled && !!state.board;
    document.body.classList.toggle("board", board);
    this.drawDock();
    this.drawSheet();
    if (board) this.drawBoard(state);
    if (board && !this.boardShown) post({ type: "pinShown", ids: null });
    this.boardShown = board;
  }

  private open(id: string): void {
    this.openID = id;
    this.sheetKey = "";
    this.drawSheet();
    this.drawDock();
    post({ type: "pinShown", ids: [id] });
  }

  private close(): void {
    this.openID = null;
    this.drawSheet();
    this.drawDock();
  }

  private drawDock(): void {
    const pins = this.enabled ? current.pins : [];
    this.dock.hidden = pins.length === 0;
    const icon = (p: PinView) => [current.components[p.name]?.icon ?? null, current.components[p.name]?.iconImage ?? null];
    const key = JSON.stringify([pins.map((p) => [p.id, p.name, p.headline, p.chip ?? null, icon(p), p.display.status]), this.openID]);
    if (key === this.dockKey) return;
    this.dockKey = key;
    this.dock.innerHTML = "";
    pins.forEach((pin, index) => {
      // A small status icon: the component's icon, a short value beside it and a dot for its
      // tone; its name and whole line in the tooltip.
      const status: ChipStatus = pin.chip ?? { text: pin.headline, tone: pin.display.status === "failed" ? "bad" : "neutral" };
      const chip = document.createElement("button");
      chip.className = "pin-chip" + (pin.id === this.openID ? " on" : "") + (pin.display.status === "failed" ? " failed" : "");
      chip.draggable = true;
      chip.dataset.id = pin.id;
      chip.dataset.tone = status.tone;
      chip.setAttribute("aria-expanded", String(pin.id === this.openID));
      chip.append(chipIcon(current.components[pin.name], status));
      if (status.text) {
        const text = document.createElement("span");
        text.className = "pin-chip-status";
        text.textContent = status.text;
        chip.append(text);
      }
      chip.title = pin.headline ? `${pin.name} — ${pin.headline}` : pin.name;
      chip.setAttribute("aria-label", status.text ? `${pin.name}: ${status.text}` : pin.name);
      chip.addEventListener("click", () => (this.openID === pin.id ? this.close() : this.open(pin.id)));
      chip.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        pinMenu(chip, pin);
      });
      this.dragAndDrop(chip, pin.id, index);
      this.dock.append(chip);
    });
    const add = button("pin-chip add", "Pin a component", icons.plus, () => openPicker());
    this.dock.append(add);
  }

  /** Drag one pin onto another to put it there. */
  private dragAndDrop(element: HTMLElement, id: string, index: number): void {
    element.addEventListener("dragstart", (event) => {
      this.dragging = id;
      event.dataTransfer?.setData("text/plain", id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    element.addEventListener("dragend", () => { this.dragging = null; });
    element.addEventListener("dragover", (event) => {
      if (!this.dragging) return;
      event.preventDefault();
      event.stopPropagation();
      element.classList.add("drop-target");
    });
    element.addEventListener("dragleave", () => element.classList.remove("drop-target"));
    element.addEventListener("drop", (event) => {
      element.classList.remove("drop-target");
      const moving = this.dragging;
      this.dragging = null;
      if (!moving) return;
      // A pin, not files: the chat's own drop (attach files) stays out of it.
      event.preventDefault();
      event.stopPropagation();
      if (moving !== id) post({ type: "movePin", id: moving, to: index });
    });
  }

  private drawSheet(): void {
    const pin = this.enabled && !document.body.classList.contains("board") ? current.pins.find((p) => p.id === this.openID) : undefined;
    if (!pin) {
      if (this.openID && !current.pins.some((p) => p.id === this.openID)) this.openID = null;
      this.sheet.hidden = true;
      if (this.sheetKey) {
        this.sheet.innerHTML = "";
        this.sheetKey = "";
      }
      return;
    }
    this.sheet.hidden = false;
    const key = JSON.stringify([drawnPart(pin), current.components[pin.name] ?? null]);
    if (key === this.sheetKey) return;
    this.sheetKey = key;
    this.sheet.innerHTML = "";
    this.sheet.setAttribute("aria-label", pin.name);
    const close = button("pin-tool", "Close", icons.close, () => this.close());
    const body = document.createElement("div");
    body.className = "pin-sheet-body";
    body.append(pinBody(pin));
    this.sheet.append(pinHeader(pin, "pin-sheet-head", [close]), body);
  }

  private drawBoard(state: ChatState): void {
    const pins = current.pins;
    const headKey = JSON.stringify([state.botName, pins.length, pins.some((p) => p.display.command)]);
    if (headKey !== this.headKey) {
      this.headKey = headKey;
      this.boardHead.innerHTML = "";
      const title = document.createElement("span");
      title.className = "board-title";
      title.textContent = state.botName;
      const count = document.createElement("span");
      count.className = "board-count";
      count.textContent = pins.length ? `${pins.length} pinned` : "Nothing pinned yet";
      const fill = document.createElement("span");
      fill.className = "pin-fill";
      this.boardHead.append(title, count, fill);
      if (pins.some((p) => p.display.command)) {
        const all = button("board-button board-refresh-all", "Refresh all", `${icons.refresh}<span>Refresh all</span>`, () => current.pins.forEach(refreshPin));
        this.boardHead.append(all);
      }
      this.boardHead.append(button("board-button primary-outline", "Add component", `${icons.plus}<span>Add component</span>`, () => openPicker()));
    }

    const keep = new Set(pins.map((p) => p.id));
    for (const [id, entry] of this.cards) {
      if (!keep.has(id)) {
        entry.element.remove();
        this.cards.delete(id);
      }
    }
    let previous: Element | null = null;
    pins.forEach((pin, index) => {
      // Its size is not part of it: a resized card keeps its frame and tells the component.
      const key = JSON.stringify([{ ...drawnPart(pin), size: null }, current.components[pin.name] ?? null, index, pins.length]);
      let entry = this.cards.get(pin.id);
      if (!entry || entry.key !== key) {
        const element = this.card(pin, index);
        if (entry) entry.element.replaceWith(element);
        entry = { key, element };
        this.cards.set(pin.id, entry);
      } else if (entry.element.dataset.size !== pin.size) {
        this.resize(entry.element, pin, index);
      }
      const expected: Element | null = previous ? previous.nextElementSibling : this.grid.firstElementChild;
      if (expected !== entry.element) {
        if (previous) previous.after(entry.element);
        else this.grid.prepend(entry.element);
      }
      previous = entry.element;
    });
    let add = this.grid.querySelector<HTMLElement>(".board-add");
    if (!add) {
      add = document.createElement("button");
      add.className = "board-add";
      add.innerHTML = `${icons.plus}<span>Add component</span><span class="board-add-note">or pin one from the chat</span>`;
      add.addEventListener("click", () => openPicker());
    }
    if (this.grid.lastElementChild !== add) this.grid.append(add);
    this.layOut();
  }

  /**
   * The Board as a grid of square cells, like a home screen's widgets: as many columns of at
   * least 150px as its width holds (fewer in a narrow window, never wider than it), rows as tall
   * as a column is wide. A card spans its size's cells, a 4-wide one only as many columns as
   * there are; dense placement fills the gaps.
   */
  private layOut(): void {
    const width = this.grid.clientWidth;
    if (width <= 0) return;
    const columns = Math.max(1, Math.floor((width + boardGap) / (boardCell + boardGap)));
    const cell = Math.floor((width - boardGap * (columns - 1)) / columns);
    this.grid.style.setProperty("--board-cols", String(columns));
    this.grid.style.setProperty("--board-cell", `${cell}px`);
    if (columns === this.columns) return;
    this.columns = columns;
    for (const card of this.grid.querySelectorAll<HTMLElement>(".board-card")) this.span(card);
  }

  /** Its cells: its size's, as wide as the Board allows. */
  private span(card: HTMLElement): void {
    const { w, h } = sizeInfo((card.dataset.size ?? "2x2") as PinSize);
    card.style.gridColumn = `span ${this.columns ? Math.min(w, this.columns) : w}`;
    card.style.gridRow = `span ${h}`;
  }

  /** Puts a card at its pin's new size, keeping the component's frame (it hears `ccb.onSize`). */
  private resize(card: HTMLElement, pin: PinView, index: number): void {
    card.className = this.cardClass(pin);
    card.dataset.size = pin.size;
    this.span(card);
    card.querySelector(".board-card-tools")?.replaceWith(this.cardTools(pin, index));
    for (const frame of card.querySelectorAll<HTMLIFrameElement>("iframe.component-frame")) resizeFrame(frame, pin.size);
  }

  /** A tile's classes: its size, and while its command runs (its tools stay in sight). */
  private cardClass(pin: PinView): string {
    return `board-card size-${pin.size}` + (pin.display.status === "running" ? " running" : "");
  }

  /**
   * A tile's controls, floating over its top-right corner on hover or keyboard focus: a grip to
   * drag it by, its size, ↻ and ⋯ (name, when it ran, refresh, sizes, move, unpin).
   */
  private cardTools(pin: PinView, index: number): HTMLElement {
    const tools = document.createElement("div");
    tools.className = "board-card-tools";
    tools.setAttribute("role", "toolbar");
    tools.setAttribute("aria-label", `${pin.name}: ${whenWords(pin)}`);
    const grip = document.createElement("span");
    grip.className = "board-grip";
    grip.title = `${pin.name} · ${whenWords(pin)} · drag to move`;
    grip.setAttribute("aria-hidden", "true");
    grip.innerHTML = icons.grip;
    grip.draggable = true;
    this.dragAndDrop(grip, pin.id, index);
    const size = button("board-size pin-tool", `Size: ${sizeLabel(pin.size)}`, sizeInfo(pin.size).w + "×" + sizeInfo(pin.size).h, () => openMenu(size, sizeItems(pin)));
    tools.append(grip, size);
    const status = pin.display.status;
    if (pin.display.command) {
      const refresh = button("pin-tool" + (status === "running" ? " spinning" : ""), `Refresh (${whenWords(pin)})`, icons.refresh, () => refreshPin(pin));
      refresh.disabled = status === "running" || status === "approve";
      tools.append(refresh);
    }
    const more = button("pin-tool", "More", icons.more, () => pinMenu(more, pin, { sizes: true, about: true }));
    tools.append(more);
    return tools;
  }

  /** A tile: the component is all of it, like a home-screen widget; its controls float over it. */
  private card(pin: PinView, index: number): HTMLElement {
    const card = document.createElement("section");
    card.className = this.cardClass(pin);
    card.dataset.id = pin.id;
    card.dataset.size = pin.size;
    if (pin.display.status) card.dataset.status = pin.display.status;
    card.setAttribute("aria-label", pin.name);
    this.span(card);
    // Dropping anywhere on a tile puts the dragged one there.
    card.addEventListener("dragover", (event) => {
      if (!this.dragging) return;
      event.preventDefault();
      card.classList.add("drop-target");
    });
    card.addEventListener("dragleave", (event) => { if (!card.contains(event.relatedTarget as Node)) card.classList.remove("drop-target"); });
    card.addEventListener("drop", (event) => {
      card.classList.remove("drop-target");
      const moving = this.dragging;
      this.dragging = null;
      if (!moving) return;
      event.preventDefault();
      if (moving !== pin.id) post({ type: "movePin", id: moving, to: index });
    });
    const body = document.createElement("div");
    body.className = "board-card-body";
    body.append(pinBody(pin, pin.size));
    card.append(body, this.cardTools(pin, index));
    return card;
  }
}
