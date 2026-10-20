import { post } from "./bridge";
import { commandCard, componentElement } from "./components";
import type { ChatState, ComponentInfo, DisplayView, PinChoiceView, PinRefresh, PinSize, PinView } from "./types";

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

interface MenuItem { label: string; run: () => void; checked?: boolean; disabled?: boolean }

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
function pinMenu(anchor: HTMLElement, pin: PinView, options: { sizes?: boolean } = {}): void {
  const at = current.pins.findIndex((p) => p.id === pin.id);
  const items: (MenuItem | "-")[] = [];
  if (pin.display.command) {
    for (const [refresh, minutes] of [["shown", pin.minutes], ["interval", pin.minutes], ["manual", pin.minutes]] as [PinRefresh, number][]) {
      items.push({ label: refreshWords(refresh, minutes), checked: pin.refresh === refresh, run: () => post({ type: "setPinRefresh", id: pin.id, refresh, minutes }) });
    }
    items.push("-");
  }
  if (options.sizes) {
    for (const size of ["s", "m", "l"] as PinSize[]) {
      items.push({ label: `Size ${size.toUpperCase()}`, checked: pin.size === size, run: () => post({ type: "resizePin", id: pin.id, size }) });
    }
    items.push("-");
  }
  items.push({ label: "Move earlier", disabled: at <= 0, run: () => post({ type: "movePin", id: pin.id, to: at - 1 }) });
  items.push({ label: "Move later", disabled: at < 0 || at >= current.pins.length - 1, run: () => post({ type: "movePin", id: pin.id, to: at + 1 }) });
  items.push("-");
  items.push({ label: "Unpin", run: () => post({ type: "unpin", id: pin.id }) });
  openMenu(anchor, items);
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

/** The pinned component, with its command's ask, error or wait as in the chat, without the bar. */
function pinBody(pin: PinView): HTMLElement {
  const draw = () => componentElement(pin.name, current.components[pin.name], pin.display.data, null, `pin-${pin.id}`, pin.display.images);
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

/** Name, command, when it ran, ↻ and ⋯: the top of a sheet or a Board card. */
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
  when.textContent = status === "running" ? "Running…" : pin.display.ranAt ? `Updated ${pin.display.ranAt}` : pin.display.command ? refreshWords(pin.refresh, pin.minutes) : "Snapshot";
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
    const key = JSON.stringify([pins.map((p) => [p.id, p.name, p.headline, p.display.status]), this.openID]);
    if (key === this.dockKey) return;
    this.dockKey = key;
    this.dock.innerHTML = "";
    pins.forEach((pin, index) => {
      const chip = document.createElement("button");
      chip.className = "pin-chip" + (pin.id === this.openID ? " on" : "") + (pin.display.status === "failed" ? " failed" : "");
      chip.draggable = true;
      chip.dataset.id = pin.id;
      chip.setAttribute("aria-expanded", String(pin.id === this.openID));
      const name = document.createElement("span");
      name.className = "pin-chip-name";
      name.textContent = pin.name;
      chip.append(name);
      if (pin.headline) {
        const line = document.createElement("span");
        line.className = "pin-chip-line";
        line.textContent = pin.headline;
        chip.append(line);
      }
      chip.title = pin.headline ? `${pin.name}: ${pin.headline}` : pin.name;
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
    const key = JSON.stringify([pin, current.components[pin.name] ?? null]);
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
      const key = JSON.stringify([pin, current.components[pin.name] ?? null, index, pins.length]);
      let entry = this.cards.get(pin.id);
      if (!entry || entry.key !== key) {
        const element = this.card(pin, index);
        if (entry) entry.element.replaceWith(element);
        entry = { key, element };
        this.cards.set(pin.id, entry);
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
  }

  private card(pin: PinView, index: number): HTMLElement {
    const card = document.createElement("section");
    card.className = `board-card size-${pin.size}`;
    card.dataset.id = pin.id;
    card.setAttribute("aria-label", pin.name);
    const head = pinHeader(pin, "board-card-head", [], true);
    const size = document.createElement("span");
    size.className = "board-size";
    size.textContent = pin.size.toUpperCase();
    head.insertBefore(size, head.querySelector(".pin-fill"));
    head.draggable = true;
    this.dragAndDrop(head, pin.id, index);
    // Dropping anywhere on a card puts the dragged one there.
    card.addEventListener("dragover", (event) => { if (this.dragging) event.preventDefault(); });
    card.addEventListener("drop", (event) => {
      const moving = this.dragging;
      this.dragging = null;
      if (!moving) return;
      event.preventDefault();
      if (moving !== pin.id) post({ type: "movePin", id: moving, to: index });
    });
    const body = document.createElement("div");
    body.className = "board-card-body";
    body.append(pinBody(pin));
    card.append(head, body);
    return card;
  }
}
