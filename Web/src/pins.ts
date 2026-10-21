import { post } from "./bridge";
import { language, pieces, t, type Key } from "./i18n";
import { isComposingEnter } from "./ime";
import { intervalRow, parseInterval, presetMinutes, presetSeconds, refreshWords, type Interval, type IntervalRow, type IntervalUnit } from "./refresh";
import { commandCard, componentElement, hasLiveFrame, keepFrames, componentSizes, detailTarget, markPinFrames, maxColumns, pinSize, pinSizes, reportComponent, resizeFrame, sizeInfo } from "./components";
import { escapeHTML } from "./util";
import type { ChatState, ChipStatus, ComponentInfo, DisplayView, FloatMenu, PinChoiceView, PinRefresh, PinSize, PinView, SpecChipView } from "./types";

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

export const icons = {
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

export function button(className: string, label: string, html: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
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
    pin: (refresh, minutes, seconds) => ({ type: "pin", id: newID(), messageID, index, refresh, minutes, ...(seconds ? { seconds } : {}) }),
  });
  if (display.pinned) {
    const badge = button("pin-badge", t("pins.pinnedShow"), `${icons.pin}<span>${escapeHTML(t("pins.pinned"))}</span>`, () => {
      document.dispatchEvent(new CustomEvent("ccb-open-pin", { detail: display.name }));
    });
    bar.append(badge);
  } else {
    const pin = button("pin-tool", t("pins.pinToThisBot"), icons.pin, () => pinIt(pin));
    bar.append(pin);
  }
  if (display.command && (display.status === "done" || display.status === "failed")) {
    bar.append(button("pin-tool", t("command.runAgainLabel"), icons.refresh, () => {
      post({ type: "componentCommand", messageID, index, command: display.command ?? "", folder: display.folder ?? "", force: true });
    }));
  }
  const more = button("pin-tool", t("pins.more"), icons.more, () => {
    const pinned = current.pins.find((p) => p.name === display.name);
    openMenu(more, [
      pinned
        ? { label: t("pins.unpin"), run: () => post({ type: "unpin", id: pinned.id }) }
        : { label: t("pins.pinToBotMenu", { bot: current.botName }), run: () => pinIt(more) },
      { label: t("pins.report"), run: () => more.closest(".pin-holder")?.querySelector<HTMLButtonElement>(".flag")?.click() },
    ]);
  });
  bar.append(more);
  return bar;
}

type PinAction = Extract<Parameters<typeof post>[0], { type: "pin" }>;

/**
 * The pin button of a component made from a reply (drawn under it), or a Pinned badge once this
 * bot has it. A bot-filled one whose about.md suggests a Board command is then made live.
 */
export function specPinButton(spec: SpecChipView): HTMLElement {
  const name = spec.component ?? spec.name;
  if (current.pins.some((p) => p.name === name)) {
    return button("pin-badge", t("pins.pinnedShow"), `${icons.pin}<span>${escapeHTML(t("pins.pinned"))}</span>`, () => {
      document.dispatchEvent(new CustomEvent("ccb-open-pin", { detail: name }));
    });
  }
  const pin = button("pin-tool", t("pins.pinToThisBot"), icons.pin, () => openPinDialog(pin, {
    name,
    command: spec.display?.command ?? null,
    pin: (refresh, minutes, seconds) => ({ type: "pin", id: newID(), spec: spec.id, refresh, minutes, ...(seconds ? { seconds } : {}) }),
  }));
  return pin;
}

/** "Making it live…": a bot-filled pin while Maintainer gives its component a command. */
function liveNote(): HTMLElement {
  const note = document.createElement("div");
  note.className = "pin-live-note";
  note.textContent = t("pins.makingLive");
  note.title = t("pins.makingLiveTitle");
  return note;
}

/**
 * "Pin to <bot>": how it refreshes (when shown, every N minutes, only on ↻) and the command that
 * redraws it. One without a command keeps the data it is drawn with now. Pin, then Undo.
 */
function openPinDialog(anchor: HTMLElement, options: { name: string; command: string | null; pin: (refresh: PinRefresh, minutes: number, seconds?: number) => PinAction }): void {
  closePopups();
  const dialog = document.createElement("div");
  dialog.className = "pin-dialog pin-popup";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", t("pins.pinTo", { bot: current.botName }));
  const title = document.createElement("div");
  title.className = "pin-dialog-title";
  title.textContent = t("pins.pinTo", { bot: current.botName });
  const note = document.createElement("div");
  note.className = "pin-dialog-note";
  dialog.append(title, note);
  if (options.command) {
    note.textContent = t("pins.keepsWithCommand", { name: options.name });
    const line = document.createElement("div");
    line.className = "pin-dialog-line";
    line.innerHTML = `<span>${escapeHTML(t("pins.command"))}</span><code class="pin-dialog-command"></code>`;
    line.querySelector("code")!.textContent = options.command;
    const heading = document.createElement("div");
    heading.className = "pin-dialog-heading";
    heading.textContent = t("pins.refresh");
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
        minutes.type = "text";
        minutes.inputMode = "numeric";
        minutes.value = String(presetMinutes);
        minutes.className = "pin-minutes";
        minutes.setAttribute("aria-label", t("refresh.interval"));
        minutes.addEventListener("focus", () => { input.checked = true; });
        // Return pins it (never an input method's Return committing a candidate).
        minutes.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !isComposingEnter(event)) {
            event.preventDefault();
            dialog.querySelector<HTMLButtonElement>(".pin-dialog-actions .primary")?.click();
          }
        });
        // Minutes, or seconds for a live pin (a CPU meter, tests running).
        const unit = document.createElement("select");
        unit.className = "pin-unit";
        unit.setAttribute("aria-label", t("refresh.unit"));
        for (const [value, word] of [["min", t("refresh.min")], ["sec", t("refresh.sec")]]) unit.add(new Option(word, value));
        unit.addEventListener("focus", () => { input.checked = true; });
        // "Every [n] [unit]" in the page's language.
        for (const piece of pieces("refresh.everyRow")) {
          if (typeof piece === "string") label.append(document.createTextNode(piece));
          else label.append(piece.mark === "n" ? minutes : unit);
        }
      } else {
        label.append(document.createTextNode(value === "shown" ? t("refresh.whenShown") : t("pins.onlyWhenPressed")));
      }
      dialog.append(label);
    }
    const wrong = document.createElement("div");
    wrong.className = "refresh-interval-error";
    wrong.setAttribute("role", "alert");
    wrong.hidden = true;
    const hint = document.createElement("div");
    hint.className = "pin-dialog-note";
    hint.textContent = t("pins.runsOnceAllowed");
    dialog.append(wrong, hint);
  } else {
    note.textContent = t("pins.keepsSnapshot", { name: options.name });
  }
  const actions = document.createElement("div");
  actions.className = "pin-dialog-actions";
  const cancel = document.createElement("button");
  cancel.className = "plain";
  cancel.textContent = t("common.cancel");
  cancel.addEventListener("click", () => dialog.remove());
  const confirm = document.createElement("button");
  confirm.className = "primary";
  confirm.textContent = t("pins.pin");
  confirm.addEventListener("click", () => {
    const picked = dialog.querySelector<HTMLInputElement>("input[type=radio]:checked");
    const refresh = options.command ? ((picked?.value as PinRefresh | undefined) ?? "shown") : "manual";
    let action = options.pin(refresh, presetMinutes);
    if (refresh === "interval") {
      // From 2 sec to 24 h; anything else is said under the choices and nothing is pinned.
      const count = dialog.querySelector<HTMLInputElement>(".pin-minutes");
      const unit = (dialog.querySelector<HTMLSelectElement>(".pin-unit")?.value ?? "min") as IntervalUnit;
      const parsed = parseInterval(count?.value ?? "", unit);
      const wrong = dialog.querySelector<HTMLElement>(".refresh-interval-error");
      if ("error" in parsed) {
        if (wrong) { wrong.textContent = parsed.error; wrong.hidden = false; }
        count?.setAttribute("aria-invalid", "true");
        count?.focus();
        return;
      }
      action = parsed.interval.seconds ? options.pin(refresh, presetMinutes, parsed.interval.seconds) : options.pin(refresh, parsed.interval.minutes ?? presetMinutes);
    }
    post(action);
    dialog.remove();
    showToast(t("pins.pinnedToast", { name: options.name, bot: current.botName }), () => post({ type: "unpin", id: action.id }));
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
  undoButton.textContent = t("pins.undo");
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
export interface MenuItem { label: string; run: () => void; checked?: boolean; disabled?: boolean; heading?: boolean; note?: boolean; code?: boolean; sizes?: SizeGrid; interval?: IntervalRow }

/** A menu's size picker: every size as a 4×4 grid of cells, the current one and the component's hints marked. */
interface SizeGrid { current: PinSize; hints: PinSize[]; pick: (size: PinSize) => void }

/**
 * Every size from 1×1 to 4×4 as a grid of cells, like a table-size picker: pointing at a cell
 * lights the cards it would span and says its size; clicking it picks that size.
 */
function sizeGrid(grid: SizeGrid, menu: HTMLElement): HTMLElement {
  const holder = document.createElement("div");
  holder.className = "pin-size-picker";
  const caption = document.createElement("div");
  caption.className = "pin-size-caption";
  const cells = document.createElement("div");
  cells.className = "pin-size-grid";
  cells.setAttribute("role", "group");
  cells.setAttribute("aria-label", t("pins.size"));
  const light = (size: PinSize) => {
    const { w, h } = sizeInfo(size);
    for (const cell of cells.querySelectorAll<HTMLButtonElement>("button")) {
      const at = sizeInfo(cell.dataset.size as PinSize);
      cell.classList.toggle("lit", at.w <= w && at.h <= h);
    }
    caption.textContent = sizeLabel(size);
  };
  for (const size of pinSizes) {
    const cell = document.createElement("button");
    cell.setAttribute("role", "menuitemradio");
    cell.dataset.size = size;
    cell.setAttribute("aria-label", sizeLabel(size));
    cell.setAttribute("aria-checked", String(size === grid.current));
    cell.title = sizeLabel(size) + (grid.hints.includes(size) ? ` · ${t("pins.suggested")}` : "");
    if (size === grid.current) cell.classList.add("checked");
    if (grid.hints.includes(size)) cell.classList.add("hint");
    cell.addEventListener("mouseenter", () => light(size));
    cell.addEventListener("focus", () => light(size));
    cell.addEventListener("click", (event) => {
      event.stopPropagation();
      menu.remove();
      if (size !== grid.current) grid.pick(size);
    });
    cells.append(cell);
  }
  cells.addEventListener("mouseleave", () => light(grid.current));
  holder.append(cells, caption);
  light(grid.current);
  return holder;
}

export function openMenu(anchor: HTMLElement, items: (MenuItem | "-")[]): void {
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
    if (item.sizes) {
      menu.append(sizeGrid(item.sizes, menu));
      continue;
    }
    if (item.interval) {
      // "Every [n] [sec|min]", typed in place: picked or Return closes the menu; leaving the
      // field after an edit applies it and checks this row, and the menu stays open.
      const set = item.interval.set;
      const row = intervalRow({ start: item.interval.start, set: (interval, close) => {
        if (close) menu.remove();
        else {
          menu.querySelectorAll(".checked").forEach((other) => other.classList.remove("checked"));
          menu.querySelectorAll("[aria-checked=true]").forEach((other) => other.setAttribute("aria-checked", "false"));
          row.classList.add("checked");
          row.querySelector(".refresh-interval-pick")?.setAttribute("aria-checked", "true");
        }
        set(interval, close);
      } }, !!item.checked);
      menu.append(row);
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

export function closePopups(): void {
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
    // A size picker starts on the size the card has.
    ((popup.firstElementChild?.classList.contains("pin-size-picker") ? popup.querySelector<HTMLButtonElement>(".pin-size-grid button.checked") : null) ?? popup.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus({ preventScroll: true });
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
      // A refresh row's edit is applied as its field is left (see `intervalRow`), then it closes.
      if (popup.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      popup.remove();
      document.removeEventListener("mousedown", close);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

/** The menu of a pin (a chip's right-click, a sheet's or card's ⋯). */
function pinMenu(anchor: HTMLElement, pin: PinView, options: { sizes?: boolean; about?: boolean; report?: HTMLElement } = {}): void {
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
    items.push(...refreshItems(pin));
    items.push("-");
  }
  if (options.sizes) {
    items.push(...sizeItems(pin));
    items.push("-");
  }
  const info = current.components[pin.name];
  if (options.report && info) {
    // An opened pin has no flag over its corner (it covered the content): Report is here.
    const drawn = options.report;
    items.push(info.working
      ? { label: t("pins.beingUpdated"), disabled: true, run: () => {} }
      : { label: t("pins.report"), run: () => reportComponent(anchor, pin.name, info, drawn) });
    items.push("-");
  }
  // Drawn before it floated (or stopped), its sheet or tile still has the old pin.
  const float = floatItem(current.pins.find((p) => p.id === pin.id) ?? pin);
  if (float) items.push(float, "-");
  items.push({ label: t("pins.moveEarlier"), disabled: at <= 0, run: () => post({ type: "movePin", id: pin.id, to: at - 1 }) });
  items.push({ label: t("pins.moveLater"), disabled: at < 0 || at >= current.pins.length - 1, run: () => post({ type: "movePin", id: pin.id, to: at + 1 }) });
  items.push("-");
  items.push({ label: t("pins.unpin"), run: () => post({ type: "unpin", id: pin.id }) });
  openMenu(anchor, items);
}

/**
 * How a pin with a command refreshes, as its menu offers it: when shown, every [n] min, every
 * [n] sec (both typed in place, 2 sec to 24 h; the row in the pin's unit shows its interval and
 * is checked), only on ↻.
 */
export function refreshItems(pin: PinView): MenuItem[] {
  const interval = pin.refresh === "interval";
  const seconds = interval ? pin.seconds || null : null;
  const set = (value: Interval) => post({ type: "setPinRefresh", id: pin.id, refresh: "interval", ...value });
  const inMinutes = interval && !seconds ? pin.minutes : presetMinutes;
  const inSeconds = seconds ?? presetSeconds;
  return [
    { label: refreshWords("shown", pin.minutes), checked: pin.refresh === "shown", run: () => post({ type: "setPinRefresh", id: pin.id, refresh: "shown", minutes: pin.minutes }) },
    { label: refreshWords("interval", inMinutes), checked: interval && !seconds, run: () => set({ minutes: inMinutes }), interval: { start: { count: inMinutes, unit: "min" }, set } },
    { label: refreshWords("interval", inMinutes, inSeconds), checked: !!seconds, run: () => set({ seconds: inSeconds }), interval: { start: { count: inSeconds, unit: "sec" }, set } },
    { label: refreshWords("manual", pin.minutes), checked: pin.refresh === "manual", run: () => post({ type: "setPinRefresh", id: pin.id, refresh: "manual", minutes: pin.minutes }) },
  ];
}

/** The float entry's words, as Swift's `Pins.FloatMenu` says them. */
const floatWords: Record<FloatMenu, Key> = {
  float: "pins.float",
  stop: "float.stop",
  full: "pins.floatFull",
};

/** "Float in corner" / "Stop floating" (shown off while two float already); none where Swift says nothing. */
export function floatItem(pin: PinView): MenuItem | null {
  const menu = pin.floatMenu ?? (pin.float ? "stop" : null);
  if (!menu) return null;
  return { label: t(floatWords[menu]), disabled: menu === "full", run: () => post({ type: "floatPin", id: pin.id, floating: menu === "float" }) };
}

const sizeWords: Record<string, Key> = { "1x1": "pins.sizeSmall", "2x1": "pins.sizeWide", "1x2": "pins.sizeTall", "2x2": "pins.sizeLarge", "4x2": "pins.sizeExtraWide" };

/** A size as its card's button and menu show it: "Wide 2×1", or "3×2" for one without a name. */
export function sizeLabel(size: PinSize): string {
  const { w, h } = sizeInfo(size);
  const word = sizeWords[`${w}x${h}`];
  return word ? `${t(word)} ${w}×${h}` : `${w}×${h}`;
}

/**
 * The sizes a card can take: every one from 1×1 to 4×4 (the component lays itself out for any),
 * with the ones its about.md's `Sizes:` line hints at marked.
 */
function sizeItems(pin: PinView): MenuItem[] {
  const hints = current.components[pin.name]?.sizes?.length ? componentSizes(current.components[pin.name]) : [];
  return [{ label: t("pins.size"), run: () => {}, sizes: { current: pin.size, hints, pick: (size) => post({ type: "resizePin", id: pin.id, size }) } }];
}

/** "Pin a component": what this bot drew (with a Command marked), and components with a Command. */
function openPicker(): void {
  closePopups();
  const backdrop = document.createElement("div");
  backdrop.className = "pin-picker-backdrop pin-popup";
  const picker = document.createElement("div");
  picker.className = "pin-picker";
  picker.setAttribute("role", "dialog");
  picker.setAttribute("aria-label", t("pins.pinAComponent"));
  const head = document.createElement("div");
  head.className = "pin-picker-head";
  const title = document.createElement("div");
  title.className = "pin-picker-title";
  title.textContent = t("pins.pickerTitle", { bot: current.botName });
  const count = document.createElement("span");
  count.className = "pin-picker-count";
  count.textContent = t("pins.count", { n: current.pins.length });
  head.append(title, count);
  picker.append(head);
  const list = document.createElement("div");
  list.className = "pin-picker-list";
  if (!current.choices.length) {
    const empty = document.createElement("div");
    empty.className = "pin-picker-empty";
    empty.textContent = t("pins.pickerEmpty");
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
    tag.textContent = choice.command ? t("pins.command") : t("pins.snapshot");
    const detail = document.createElement("span");
    detail.className = "pin-picker-detail";
    detail.textContent = [choice.pinned ? t("pins.pinnedTag") : "", choice.uses ? t("pins.uses", { n: choice.uses }) : t("pins.notUsed")].filter(Boolean).join(" · ");
    row.append(name, tag, detail);
    if (choice.command) row.title = choice.command;
    row.addEventListener("click", () => {
      backdrop.remove();
      const pin = (refresh: PinRefresh, minutes: number, seconds?: number): PinAction => ({ type: "pin", id: newID(), name: choice.name, refresh, minutes, ...(seconds ? { seconds } : {}) });
      if (choice.command) {
        openPinDialog(document.querySelector<HTMLElement>(".pin-chip.add, .board-add") ?? document.body, { name: choice.name, command: choice.command, pin });
      } else {
        const action = pin("manual", 15);
        post(action);
        showToast(t("pins.pinnedToast", { name: choice.name, bot: current.botName }), () => post({ type: "unpin", id: action.id }));
      }
    });
    list.append(row);
  }
  picker.append(list);
  const note = document.createElement("div");
  note.className = "pin-picker-note";
  note.textContent = t("pins.pickerNote");
  const actions = document.createElement("div");
  actions.className = "pin-dialog-actions";
  const cancel = document.createElement("button");
  cancel.className = "plain";
  cancel.textContent = t("common.close");
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
 * On the Board it is drawn at its tile's size and fills it (`fill`). Opened above the input box
 * or floating in a corner it is told it is "pinned" (frameless there too) and is as tall as its
 * content; its panel scrolls past its most.
 */
export function pinBody(pin: PinView, size?: PinSize, fill = !!size, where: PinSurface = size ? "board" : "sheet", info: ComponentInfo | undefined = current.components[pin.name]): HTMLElement {
  const key = where === "sheet" ? `pin-${pin.id}` : `${where}-${pin.id}`;
  const shown = pin.display.data;
  const saveKey = `${where}:${pin.id}`;
  if (pinSaves.get(saveKey)?.to !== shown) pinSaves.delete(saveKey);
  // ccb.save(data) keeps new data on the pin; a pinned command's card shows the command's output.
  const save = pin.display.command ? null : (data: string) => {
    pinSaves.set(saveKey, { from: pinSaves.get(saveKey)?.from ?? shown, to: data });
    post({ type: "pinSave", id: pin.id, data });
  };
  const draw = () => {
    // Opened above the input box or floating, it is "pinned": as tall as its content, under the shared header.
    const drawn = componentElement(pin.name, info, pin.display.data, null, key, pin.display.images, detailTarget(pin.display), size, where === "board" ? "board" : "pinned", fill, save);
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
  missing.textContent = t("pins.missing", { name: pin.name });
  return missing;
}

export function refreshPin(pin: PinView): void {
  if (!pin.display.command) return;
  post({ type: "pinCommand", id: pin.id, command: pin.display.command, folder: pin.display.folder ?? "", force: true });
}

/** When it last ran, or how it refreshes: "Updated 10:42", "Running…", "Snapshot". */
export function whenWords(pin: PinView): string {
  if (pin.display.status === "running") return t("command.running");
  if (pin.display.ranAt) return t("pins.updatedAt", { when: pin.display.ranAt });
  if (pin.makingLive) return t("pins.makingLive");
  return pin.display.command ? refreshWords(pin.refresh, pin.minutes, pin.seconds) : t("pins.snapshot");
}

/** What an opened or floating pin's header calls it: its about.md's short name ("發版進度卡"), else its folder name. */
export function pinTitle(pin: PinView, info: ComponentInfo | undefined = current.components[pin.name]): string {
  const title = info?.title?.trim();
  return title ? title : pin.name;
}

/** What its chip says: what its component set, else its headline (red when its command failed). */
export function pinStatus(pin: PinView): ChipStatus {
  return pin.chip ?? { text: pin.headline, tone: pin.display.status === "failed" ? "bad" : "neutral" };
}

/** A header's buttons beyond ↻: ⋯ always, collapse where the panel can be put away. */
export interface PinHeadTools {
  more: (anchor: HTMLElement) => void;
  close?: () => void;
}

/** All a header shows, to fill it again only when that changed. */
export function pinHeadKey(pin: PinView, info: ComponentInfo | undefined): string {
  return JSON.stringify([language(), pin.name, pinTitle(pin, info), pinStatus(pin), pin.display.status, pin.display.ranAt ?? null, info?.icon ?? null, info?.iconImage ?? null, !!pin.display.command, pin.refresh, pin.minutes, pin.seconds ?? null]);
}

/**
 * The header an opened pin (above the input box) and a floating pin share, one line: its icon,
 * its name (about.md's, not its folder's), its status chip, then ↻ (one with a command), ⋯ and,
 * given `close`, collapse. Filled into `head`, which is kept, so what listens on it stays.
 */
export function fillPinHead(head: HTMLElement, pin: PinView, info: ComponentInfo | undefined, tools: PinHeadTools): void {
  head.classList.add("pin-head");
  head.innerHTML = "";
  const status = pinStatus(pin);
  head.append(chipIcon(info, status));
  const title = document.createElement("span");
  title.className = "pin-head-title";
  title.textContent = pinTitle(pin, info);
  title.title = pin.name;
  const chip = document.createElement("span");
  chip.className = "pin-head-status";
  chip.dataset.tone = status.tone;
  chip.textContent = status.text;
  const bar = document.createElement("span");
  bar.className = "pin-head-tools";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", `${pinTitle(pin, info)}: ${whenWords(pin)}`);
  const running = pin.display.status;
  if (pin.display.command) {
    const refresh = button("pin-tool" + (running === "running" ? " spinning" : ""), t("pins.refreshWhen", { when: whenWords(pin) }), icons.refresh, () => refreshPin(pin));
    refresh.disabled = running === "running" || running === "approve";
    bar.append(refresh);
  }
  const more = button("pin-tool", t("pins.more"), icons.more, () => tools.more(more));
  bar.append(more);
  if (tools.close) bar.append(button("pin-tool", t("pins.collapse"), icons.close, tools.close));
  head.append(title, chip, bar);
}

// MARK: Chips, the sheet, the Board

/**
 * A chip's icon: the component's emoji, its SF Symbol (a picture Swift drew, used as a mask so it
 * takes the chip's colour), or a generic one; with a dot in its tone unless neutral.
 */
export function chipIcon(info: ComponentInfo | undefined, status: ChipStatus): HTMLElement {
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
export function drawnPart(pin: PinView, surface?: PinSurface): PinView {
  // Data its own frame there saved (ccb.save) is what that frame shows already: not a change to draw.
  const saved = surface ? pinSaves.get(`${surface}:${pin.id}`) : undefined;
  const display = saved && saved.to === pin.display.data ? { ...pin.display, data: saved.from } : pin.display;
  return { ...pin, headline: "", chip: undefined, display, float: undefined, floatMenu: undefined };
}

/**
 * Keeps the pointer's moves coming to `handle` while it is held, over frames too. A pointer the
 * page does not know (a synthetic event) cannot be captured; the drag goes on without it.
 */
export function capture(handle: HTMLElement, pointer: number): void {
  try {
    handle.setPointerCapture?.(pointer);
  } catch {
    // Frames already ignore the pointer while dragging (body.pin-resizing).
  }
}

/**
 * Where a dragged Board tile would go among the others (`rects`, in order, on screen): before the
 * tile under the pointer or, over a gap, the nearest one, when the pointer is on its left half
 * (its top half when the Board is one column), else after it. `slot` is the tile's index once
 * it is out of the list and put back, as Swift's `Pins.move` takes it. Null with no others.
 */
export function dropSlot(rects: DOMRect[], x: number, y: number, vertical = false): { slot: number; rect: DOMRect; before: boolean } | null {
  let best = -1;
  let distance = Infinity;
  rects.forEach((r, i) => {
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const d = Math.hypot(dx, dy);
    if (d < distance) {
      distance = d;
      best = i;
    }
  });
  if (best < 0) return null;
  const rect = rects[best];
  const before = vertical ? y < rect.top + rect.height / 2 : x < rect.left + rect.width / 2;
  return { slot: before ? best : best + 1, rect, before };
}

/** Where a pin is drawn: its Board tile, opened above the input box, or floating in a corner. */
export type PinSurface = "board" | "sheet" | "float";

/**
 * Pins whose frame saved new data (`ccb.save`), by surface and id ("board:P1"): the data that
 * frame was drawn with and what it saved since, so the pin coming back from Swift with that data
 * keeps the frame (which would otherwise load again, losing what you were typing). Only that
 * surface's: the other one, drawn with the old data, still draws again.
 */
const pinSaves = new Map<string, { from: string; to: string }>();

/** The Board's smallest cell and the gap between cells, in px (chat.css has the same gap). */
const boardCell = 150;
const boardGap = 14;

/** The heights an opened pin's panel may be dragged to (Swift keeps 120…1600 too), leaving the chat room above. */
const panelMinimum = 120;
function panelHeight(height: number): number {
  const most = Math.max(panelMinimum, Math.min(1600, (window.innerHeight || 800) - 140));
  return Math.round(Math.min(most, Math.max(panelMinimum, height)));
}

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
  /** While the opened pin's panel is being dragged taller or shorter. */
  private sheetDrag = false;
  /** The opened pin's header, kept (filled again when what it shows changed). */
  private readonly sheetHead: HTMLElement;
  private sheetHeadKey = "";
  /** The language its words were last drawn in. */
  private wordsIn = "";

  constructor(area: HTMLElement, board: HTMLElement) {
    this.sheet = document.createElement("section");
    this.sheet.className = "pin-sheet";
    this.sheet.hidden = true;
    this.sheetHead = document.createElement("div");
    this.sheetHead.className = "pin-sheet-head pin-head";
    this.dock = document.createElement("div");
    this.dock.className = "pin-dock";
    this.dock.setAttribute("role", "toolbar");
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
    // A new language: everything is drawn again in its words (live frames are kept).
    if (this.wordsIn !== language()) {
      this.wordsIn = language();
      this.dock.setAttribute("aria-label", t("pins.dock"));
      this.board.setAttribute("aria-label", t("pins.board"));
      this.sheetKey = this.dockKey = this.headKey = this.sheetHeadKey = "";
      for (const entry of this.cards.values()) entry.key = "";
      this.grid.querySelector(".board-add")?.remove();
    }
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
      const status = pinStatus(pin);
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
    const add = button("pin-chip add", t("pins.pinAComponent"), icons.plus, () => openPicker());
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
        this.sheetHeadKey = "";
      }
      return;
    }
    this.sheet.hidden = false;
    // As tall as its content; a height the user dragged it to is the most it grows to (it
    // scrolls past that), so it never shows an empty area under a short component.
    const capped = typeof pin.panelHeight === "number" && pin.panelHeight > 0;
    if (!this.sheetDrag) {
      this.sheet.style.height = "";
      this.sheet.style.maxHeight = capped ? `${panelHeight(pin.panelHeight!)}px` : "";
    }
    this.sheet.classList.toggle("sized", capped || this.sheetDrag);
    this.sheet.classList.toggle("running", pin.display.status === "running");
    const info = current.components[pin.name];
    this.sheet.setAttribute("aria-label", pinTitle(pin, info));
    const headKey = pinHeadKey(pin, info);
    if (headKey !== this.sheetHeadKey) {
      this.sheetHeadKey = headKey;
      const id = pin.id;
      fillPinHead(this.sheetHead, pin, info, {
        more: (anchor) => {
          const latest = current.pins.find((p) => p.id === id) ?? pin;
          pinMenu(anchor, latest, { about: true, report: this.sheet.querySelector<HTMLElement>(":scope > .pin-sheet-body") ?? undefined });
        },
        close: () => this.close(),
      });
    }
    const key = JSON.stringify([{ ...drawnPart(pin, "sheet"), panelHeight: null }, info ?? null]);
    if (key === this.sheetKey) return;
    this.sheetKey = key;
    // A component that takes live data (ccb.onData) keeps its frame and gets the new data.
    const before = this.sheet.querySelector<HTMLElement>(":scope > .pin-sheet-body");
    const keep = hasLiveFrame(before) ? before : null;
    // Taken out of the page even for a moment, a frame loads again: the body that is kept stays.
    for (const child of [...this.sheet.children]) if (child !== keep && child !== this.sheetHead) child.remove();
    this.sheet.classList.remove("hovered");
    const body = document.createElement("div");
    body.className = "pin-sheet-body";
    body.append(pinBody(pin, undefined, false));
    const shown = keep ? keepFrames(keep, body) : body;
    if (shown !== keep) keep?.remove();
    if (this.sheetHead.parentElement !== this.sheet) this.sheet.prepend(this.sheetHead);
    if (shown.parentElement !== this.sheet) this.sheetHead.after(shown);
    this.sheetHead.before(this.sheetHandle(pin));
    if (pin.makingLive) shown.after(liveNote());
  }

  /**
   * The grab bar along an opened pin's top edge: the panel rises from the input box, so dragging
   * it up makes it taller and down shorter, within `panelHeight`'s limits; that is then the most
   * it grows to (shorter content, a shorter panel). A double-click takes that limit away. The component hears each step (`ccb.onSize`).
   */
  private sheetHandle(pin: PinView): HTMLElement {
    const handle = document.createElement("div");
    handle.className = "pin-sheet-resize resize-handle";
    handle.title = t("pins.sheetHandle");
    handle.setAttribute("aria-hidden", "true");
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startY = event.clientY;
      const start = this.sheet.getBoundingClientRect().height || this.sheet.offsetHeight || 0;
      let height = Math.round(start);
      this.sheetDrag = true;
      this.sheet.classList.add("sized", "resizing");
      document.body.classList.add("pin-resizing");
      capture(handle, event.pointerId);
      // While dragged it is exactly that tall; let go, that is the most it grows to.
      const move = (moved: PointerEvent) => {
        height = panelHeight(start + startY - moved.clientY);
        this.sheet.style.height = `${height}px`;
        this.sheet.style.maxHeight = `${height}px`;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        this.sheetDrag = false;
        this.sheet.style.height = "";
        this.sheet.classList.remove("resizing");
        document.body.classList.remove("pin-resizing");
        if (height !== Math.round(start)) post({ type: "setPinHeight", id: pin.id, height });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
    handle.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      if (current.pins.find((p) => p.id === pin.id)?.panelHeight != null) post({ type: "setPinHeight", id: pin.id, height: null });
    });
    return handle;
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
      count.textContent = pins.length ? t("pins.count", { n: pins.length }) : t("pins.nothingPinned");
      const fill = document.createElement("span");
      fill.className = "pin-fill";
      this.boardHead.append(title, count, fill);
      if (pins.some((p) => p.display.command)) {
        const all = button("board-button board-refresh-all", t("pins.refreshAll"), `${icons.refresh}<span>${escapeHTML(t("pins.refreshAll"))}</span>`, () => current.pins.forEach(refreshPin));
        this.boardHead.append(all);
      }
      this.boardHead.append(button("board-button primary-outline", t("pins.addComponent"), `${icons.plus}<span>${escapeHTML(t("pins.addComponent"))}</span>`, () => openPicker()));
    }

    const keep = new Set(pins.map((p) => p.id));
    for (const [id, entry] of this.cards) {
      if (!keep.has(id)) {
        entry.element.remove();
        this.cards.delete(id);
      }
    }
    let previous: Element | null = null;
    pins.forEach((pin) => {
      // Its size and place are not part of it: a resized or moved card keeps its frame (a
      // resized one tells the component).
      const key = JSON.stringify([{ ...drawnPart(pin, "board"), size: null }, current.components[pin.name] ?? null]);
      let entry = this.cards.get(pin.id);
      if (!entry || entry.key !== key) {
        let element: HTMLElement;
        if (entry && hasLiveFrame(entry.element)) {
          // A component that takes live data (ccb.onData) keeps its tile and frame, drawn anew
          // around it, and gets the new data.
          element = this.card(pin, entry.element);
        } else {
          element = this.card(pin);
          if (entry) entry.element.replaceWith(element);
        }
        entry = { key, element };
        this.cards.set(pin.id, entry);
      } else if (entry.element.dataset.size !== pin.size) {
        this.resize(entry.element, pin);
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
      add.innerHTML = `${icons.plus}<span>${escapeHTML(t("pins.addComponent"))}</span><span class="board-add-note">${escapeHTML(t("pins.addNote"))}</span>`;
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

  /** Its cells: its size's (or the one it is being dragged to), as wide as the Board allows. */
  private span(card: HTMLElement): void {
    const { w, h } = sizeInfo((card.dataset.preview ?? card.dataset.size ?? "2x2") as PinSize);
    card.style.gridColumn = `span ${this.columns ? Math.min(w, this.columns) : w}`;
    card.style.gridRow = `span ${h}`;
  }

  /**
   * A tile's resize handles (on hover): its bottom-right corner, and its right and bottom edges
   * for one way only. Dragging one resizes the tile cell by cell, from 1×1 up to 4×4 (no wider
   * than the Board's columns). The tile and its component follow the drag (`ccb.onSize` at each
   * new cell); letting go keeps the size.
   */
  private resizeHandle(card: HTMLElement, pin: PinView, edge: "se" | "e" | "s"): HTMLElement {
    const handle = document.createElement("div");
    handle.className = (edge === "se" ? "board-resize" : `board-resize-${edge}`) + " resize-handle";
    handle.title = t("float.dragToResize");
    handle.setAttribute("aria-hidden", "true");
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = card.getBoundingClientRect();
      const cell = parseFloat(this.grid.style.getPropertyValue("--board-cell")) || boardCell;
      const startX = event.clientX;
      const startY = event.clientY;
      // From where the tile is now, in cells (its rect is 0 before layout, as in a test).
      const was = (card.dataset.size ?? pin.size) as PinSize;
      const { w: startW, h: startH } = sizeInfo(was);
      const width = rect.width || startW * cell + (startW - 1) * boardGap;
      const height = rect.height || startH * cell + (startH - 1) * boardGap;
      let size = was;
      card.classList.add("resizing");
      document.body.classList.add("pin-resizing");
      capture(handle, event.pointerId);
      const move = (moved: PointerEvent) => {
        const w = edge === "s" ? startW : Math.round((width + moved.clientX - startX + boardGap) / (cell + boardGap));
        const h = edge === "e" ? startH : Math.round((height + moved.clientY - startY + boardGap) / (cell + boardGap));
        const next = pinSize(Math.min(w, this.columns || maxColumns), h);
        if (next === size) return;
        size = next;
        card.dataset.preview = next;
        this.span(card);
        const label = card.querySelector<HTMLElement>(".board-size");
        if (label) label.textContent = next.replace("x", "×");
        for (const frame of card.querySelectorAll<HTMLIFrameElement>("iframe.component-frame")) resizeFrame(frame, next);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        card.classList.remove("resizing");
        document.body.classList.remove("pin-resizing");
        // Kept at the new size until Swift's state says so; unchanged, as it was.
        if (size !== was) post({ type: "resizePin", id: pin.id, size });
        else delete card.dataset.preview;
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
    return handle;
  }

  /**
   * Lets a tile be dragged by `handle` (its grip, or the grab bar along its top edge) with the
   * pointer, not HTML drag and drop: its component's frame covers the whole tile, so a drop
   * would land in the frame and never reach the Board. The tile follows the pointer while the
   * others stay put, and a line in the gap shows where it will go (`dropSlot`): before the tile
   * under the pointer or nearest it when over its left half (top half, in one column), after it
   * over its right half. Letting go puts it there and asks Swift to keep it; a small wobble is a
   * click.
   */
  private movable(handle: HTMLElement, card: HTMLElement, pin: PinView): void {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const tiles = [...this.grid.querySelectorAll<HTMLElement>(".board-card")];
      const from = tiles.indexOf(card);
      const others = tiles.filter((tile) => tile !== card);
      const startX = event.clientX;
      const startY = event.clientY;
      let moving = false;
      let slot = from;
      let line: HTMLElement | null = null;
      document.body.classList.add("pin-resizing");
      capture(handle, event.pointerId);
      const move = (moved: PointerEvent) => {
        const x = moved.clientX;
        const y = moved.clientY;
        if (!moving) {
          if (Math.hypot(x - startX, y - startY) < 4) return;
          moving = true;
          card.classList.add("moving");
        }
        card.style.transform = `translate(${Math.round(x - startX)}px, ${Math.round(y - startY)}px)`;
        const vertical = this.columns === 1;
        const drop = dropSlot(others.map((tile) => tile.getBoundingClientRect()), x, y, vertical);
        if (!drop) return;
        slot = drop.slot;
        if (!line) {
          line = document.createElement("div");
          line.className = "board-drop-line";
          line.setAttribute("aria-hidden", "true");
          document.body.append(line);
        }
        // In the gap beside the tile it goes before or after, as long as that tile's side.
        const r = drop.rect;
        const half = boardGap / 2;
        line.classList.toggle("vertical", vertical);
        if (vertical) {
          Object.assign(line.style, { left: `${r.left}px`, top: `${(drop.before ? r.top - half : r.bottom + half) - 2}px`, width: `${r.width}px`, height: "4px" });
        } else {
          Object.assign(line.style, { left: `${(drop.before ? r.left - half : r.right + half) - 2}px`, top: `${r.top}px`, width: "4px", height: `${r.height}px` });
        }
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        document.body.classList.remove("pin-resizing");
        card.classList.remove("moving");
        card.style.transform = "";
        line?.remove();
        if (!moving || slot === from || from < 0) return;
        // Put it there now; Swift's state comes back in the same order.
        if (slot < others.length) others[slot].before(card);
        else others[others.length - 1]?.after(card);
        post({ type: "movePin", id: pin.id, to: slot });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
  }

  /** Puts a card at its pin's new size, keeping the component's frame (it hears `ccb.onSize`). */
  private resize(card: HTMLElement, pin: PinView): void {
    card.className = this.cardClass(pin);
    card.dataset.size = pin.size;
    delete card.dataset.preview;
    this.span(card);
    card.querySelector(".board-card-tools")?.replaceWith(this.cardTools(card, pin));
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
  private cardTools(card: HTMLElement, pin: PinView): HTMLElement {
    const tools = document.createElement("div");
    tools.className = "board-card-tools";
    tools.setAttribute("role", "toolbar");
    tools.setAttribute("aria-label", `${pin.name}: ${whenWords(pin)}`);
    const grip = document.createElement("span");
    grip.className = "board-grip";
    grip.title = `${pin.name} · ${whenWords(pin)} · ${t("pins.dragToMoveLower")}`;
    grip.setAttribute("aria-hidden", "true");
    grip.innerHTML = icons.grip;
    this.movable(grip, card, pin);
    const size = button("board-size pin-tool", t("pins.sizeLabel", { size: sizeLabel(pin.size) }), sizeInfo(pin.size).w + "×" + sizeInfo(pin.size).h, () => openMenu(size, sizeItems(pin)));
    tools.append(grip, size);
    const status = pin.display.status;
    if (pin.display.command) {
      const refresh = button("pin-tool" + (status === "running" ? " spinning" : ""), t("pins.refreshWhen", { when: whenWords(pin) }), icons.refresh, () => refreshPin(pin));
      refresh.disabled = status === "running" || status === "approve";
      tools.append(refresh);
    }
    const more = button("pin-tool", t("pins.more"), icons.more, () => pinMenu(more, pin, { sizes: true, about: true }));
    tools.append(more);
    return tools;
  }

  /** A tile: the component is all of it, like a home-screen widget; its controls float over it. */
  private card(pin: PinView, reuse?: HTMLElement): HTMLElement {
    const card = reuse ?? document.createElement("section");
    card.className = this.cardClass(pin);
    card.dataset.id = pin.id;
    card.dataset.size = pin.size;
    if (pin.display.status) card.dataset.status = pin.display.status;
    else delete card.dataset.status;
    card.setAttribute("aria-label", pin.name);
    this.span(card);
    const body = document.createElement("div");
    body.className = "board-card-body";
    body.append(pinBody(pin, pin.size));
    // A grab bar along its top edge (on hover), as an opened pin's panel has: drag it to move.
    const bar = document.createElement("div");
    bar.className = "board-move resize-handle";
    bar.title = t("pins.dragToMove");
    bar.setAttribute("aria-hidden", "true");
    this.movable(bar, card, pin);
    // A tile drawn anew around a live frame: its body stays in place (taken out, the frame would
    // load again) and takes the new one's content; everything else is new.
    const before = reuse?.querySelector<HTMLElement>(":scope > .board-card-body") ?? null;
    const shown = before ? keepFrames(before, body) : body;
    for (const child of [...card.children]) if (child !== shown) child.remove();
    if (shown.parentElement !== card) card.append(shown);
    card.append(this.cardTools(card, pin), bar, this.resizeHandle(card, pin, "e"), this.resizeHandle(card, pin, "s"), this.resizeHandle(card, pin, "se"));
    if (pin.makingLive) card.append(liveNote());
    return card;
  }
}
