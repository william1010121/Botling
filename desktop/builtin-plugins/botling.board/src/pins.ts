import {
  componentSizes, escapeHTML, intervalRow, isComposingEnter,
  parseInterval, pieces, pinSizes, post, presetMinutes, presetSeconds, refreshWords, reportComponent, setChat, shared, sizeInfo, t,
  type WordKey,
} from "./kit";
import { whenWords } from "./pin-area";
import type { Interval, IntervalRow, IntervalUnit } from "../../../../Web/src/refresh";
import type { ComponentInfo, DisplayView, PinRefresh, PinSize, SpecChipView } from "../../../../Web/src/types";
import type { BoardState, FloatMenu, PinAction, PinChoiceView, PinView } from "./types";

/**
 * Components pinned to a bot. In the chat a component shows pin / ↻ / ⋯ on hover; pinning asks
 * how it should refresh and shows its command, then offers Undo. Pins show as chips above the
 * input box (click one: the full component rises from the bottom) or as cards floating in a
 * corner. Commands only run once allowed, as for any card: Swift checks.
 */

/** What the pin bar in the chat needs from the latest state. */
const current: { botName: string; pins: PinView[]; components: Record<string, ComponentInfo>; choices: PinChoiceView[]; enabled: boolean } = {
  botName: "this bot", pins: [], components: {}, choices: [], enabled: false,
};

/** A read-only view of `current` for pin-area.ts: `prime` is the only writer. */
export function pinsState(): Readonly<typeof current> {
  return current;
}

/**
 * What the pin bars and the pin actions need from a state, taken before the messages are drawn (the bar over a card says whether its
 * component is pinned) and again by `PinArea.update`. Pins can be made where the page has the plugin's data and no subagent is watched.
 */
export function prime(state: BoardState): void {
  current.enabled = !!state.pins && !state.subagent;
  current.botName = state.botName;
  current.pins = state.pins ?? [];
  current.components = state.components;
  current.choices = state.pinChoices ?? [];
  setChat(current.enabled ? state.botID : null, current.pins);
}

/**
 * Whether the bar over a card in a reply is offered for this component, and a key for what it shows (which components are pinned).
 * Every card of a library component has the bar (its ⋯ menu carries "Report a problem…"); `pinBar` leaves the pin button out for
 * a card with no Command (`canPin`), because only a Command component can be pinned (a snapshot pin from before keeps its bar).
 */
export function barFor(name: string): { offered: boolean; pinned: boolean } {
  return { offered: current.enabled && !!current.components[name], pinned: current.pins.some((pin) => pin.name === name) };
}

/** A card can be pinned when it has a Command, or when it is pinned already (a snapshot pin from before: to open or undo it). */
export function canPin(command: string | null | undefined, pinned: boolean): boolean {
  return !!command || pinned;
}

/** The built-in inline blocks (botling.cards): drawn from JSON the bot wrote in its reply, with no Command, so they cannot be pinned as they are. */
const INLINE_BLOCKS: ReadonlySet<string> = new Set(["inline-chart", "inline-report-block"]);
/** The JSON longer than this is not pasted into the request (the bot's reply above has it). */
const MAKE_PINNABLE_JSON_MAX = 16_000;
/** A second press of "Make it pinnable" within this many ms is the same request (a double tap sends once). */
const MAKE_PINNABLE_AGAIN_MS = 15_000;
/** When each card's request was sent (`messageID/index`), so a double tap never sends twice. */
const askedPinnable = new Map<string, number>();

/** Forgets the requests sent (for a test; the page is the only other thing that ends them). */
export function forgetPinnableAsks(): void {
  askedPinnable.clear();
}

/** An inline block with data and no command, not pinned: it can be made pinnable by asking the bot for a script. */
export function canMakePinnable(display: DisplayView, pinned: boolean): boolean {
  return !pinned && !display.command && INLINE_BLOCKS.has(display.name) && display.data.trim() !== "" && display.data.trim() !== "null";
}

/** The message "Make it pinnable" sends, in the page's language: the block's JSON (one line) and what the bot should do with it. */
export function makePinnableText(name: string, data: string): string {
  let json = data.trim();
  try { json = JSON.stringify(JSON.parse(json)); } catch { /* not JSON: as the bot wrote it */ }
  if (json.length > MAKE_PINNABLE_JSON_MAX) json = t("pins.makePinnableTooLong");
  return t("pins.makePinnableMessage", { name, json });
}

/**
 * Sends the request to this bot as a chat message, as if the user had typed it (the bot then starts a worker that writes the script and
 * shows the card again with a command, which has the Pin button). A press while the same card's request is fresh does nothing but say so.
 */
export function askMakePinnable(display: DisplayView, messageID: string, index: number): void {
  const key = `${messageID}/${index}`;
  const last = askedPinnable.get(key);
  if (last !== undefined && Date.now() - last < MAKE_PINNABLE_AGAIN_MS) {
    showToast(t("pins.makePinnableAsked"));
    return;
  }
  askedPinnable.set(key, Date.now());
  post({ type: "send", text: makePinnableText(display.name, display.data) });
  showToast(t("pins.makePinnableSent", { bot: current.botName }));
}

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

export function newID(): string {
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
  const pinnedHere = barFor(display.name).pinned;
  const pinnable = canPin(display.command, pinnedHere);
  const makeable = canMakePinnable(display, pinnedHere);
  if (pinnedHere) bar.dataset.holder = "pinned";
  if (pinnedHere) {
    const badge = button("pin-badge", t("pins.pinnedShow"), `${icons.pin}<span>${escapeHTML(t("pins.pinned"))}</span>`, () => {
      document.dispatchEvent(new CustomEvent("ccb-open-pin", { detail: display.name }));
    });
    bar.append(badge);
  } else if (pinnable) {
    const pin = button("pin-tool", t("pins.pinToThisBot"), icons.pin, () => pinIt(pin));
    bar.append(pin);
  } else if (makeable) {
    // An inline block has no command to pin: this first, visible button asks the bot for one.
    const make = button("pin-tool pin-make", t("pins.makePinnableTitle", { bot: current.botName }), `${icons.pin}<span>${escapeHTML(t("pins.makePinnable"))}</span>`, () => askMakePinnable(display, messageID, index));
    bar.append(make);
  }
  if (display.command && (display.status === "done" || display.status === "failed")) {
    bar.append(button("pin-tool", t("command.runAgainLabel"), icons.refresh, () => {
      post({ type: "componentCommand", messageID, index, command: display.command ?? "", folder: display.folder ?? "", force: true });
    }));
  }
  const more = button("pin-tool", t("pins.more"), icons.more, () => {
    const pinned = current.pins.find((p) => p.name === display.name);
    openMenu(more, [
      ...(pinned
        ? [{ label: t("pins.unpin"), run: () => post({ type: "unpin", id: pinned.id }) }]
        : pinnable ? [{ label: t("pins.pinToBotMenu", { bot: current.botName }), run: () => pinIt(more) }]
        : makeable ? [{ label: t("pins.makePinnable"), run: () => askMakePinnable(display, messageID, index) }] : []),
      reportItem(more, display.name, current.components[display.name], more.closest(".pin-holder")?.querySelector<HTMLElement>(".component-frame") ?? null, pinned?.id)
        ?? { label: t("pins.report"), disabled: true, run: () => {} },
    ]);
  });
  bar.append(more);
  return bar;
}

/**
 * "Report a problem…", in a component card's ⋯ menu (in a reply, an opened pin, a Board tile, a
 * floating card): its flag is not drawn over it, so this is where you say what's wrong. Shown off
 * while Maintainer is changing it; none for a component the library does not have.
 */
export function reportItem(anchor: HTMLElement, name: string, info: ComponentInfo | undefined, drawn: HTMLElement | null, pinID?: string): MenuItem | null {
  if (!info) return null;
  if (info.working) return { label: t("pins.beingUpdated"), disabled: true, run: () => {} };
  return { label: t("pins.report"), run: () => reportComponent(anchor, name, info, drawn, pinID) };
}

export type PinAdd = Extract<PinAction, { type: "pin" }>;

/**
 * The pin button of a component made from a reply (drawn under it), or a Pinned badge once this
 * bot has it. A bot-filled one whose about.md suggests a Board command is then made live.
 */
export function specPinButton(spec: SpecChipView): HTMLElement | null {
  const name = spec.component ?? spec.name;
  if (current.pins.some((p) => p.name === name)) {
    return button("pin-badge", t("pins.pinnedShow"), `${icons.pin}<span>${escapeHTML(t("pins.pinned"))}</span>`, () => {
      document.dispatchEvent(new CustomEvent("ccb-open-pin", { detail: name }));
    });
  }
  // Without a Command there is nothing to pin (no snapshot pins).
  const command = spec.display?.command;
  if (!command) return null;
  const pin = button("pin-tool", t("pins.pinToThisBot"), icons.pin, () => openPinDialog(pin, {
    name,
    command,
    pin: (refresh, minutes, seconds) => ({ type: "pin", id: newID(), spec: spec.id, refresh, minutes, ...(seconds ? { seconds } : {}) }),
  }));
  return pin;
}

/** "Making it live…": a bot-filled pin while Maintainer gives its component a command. */
export function liveNote(): HTMLElement {
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
export function openPinDialog(anchor: HTMLElement, options: { name: string; command: string | null; pin: (refresh: PinRefresh, minutes: number, seconds?: number) => PinAdd }): void {
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

/** A toast for a few seconds, with Undo when `undo` is given. */
export function showToast(text: string, undo?: () => void): void {
  document.querySelector(".pin-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "pin-toast";
  toast.setAttribute("role", "status");
  const words = document.createElement("span");
  words.textContent = text;
  toast.append(words);
  if (undo) {
    const undoButton = document.createElement("button");
    undoButton.textContent = t("pins.undo");
    undoButton.addEventListener("click", () => {
      undo();
      toast.remove();
    });
    toast.append(undoButton);
  }
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

/**
 * Opens a menu by `anchor`, or closes it when that anchor's menu is the one open (⋯ clicked again).
 * `key` names whose menu it is, for an anchor drawn again while it is open (a floating pin's header
 * redrawn as its data refreshes): its button carries `data-menu-key` (`PinHeadTools.menuKey`).
 */
export function openMenu(anchor: HTMLElement, items: (MenuItem | "-")[], key?: string): void {
  const open = document.querySelector<HTMLElement>(".pin-menu");
  const same = open && (popupAnchors.get(open) === anchor || (key !== undefined && open.dataset.menuKey === key));
  closePopups();
  if (same) return;
  const menu = document.createElement("div");
  menu.className = "pin-menu pin-popup";
  menu.setAttribute("role", "menu");
  if (key !== undefined) menu.dataset.menuKey = key;
  popupAnchors.set(menu, anchor);
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

/** The anchor each open menu was opened by, so clicking it again closes the menu. */
const popupAnchors = new WeakMap<HTMLElement, HTMLElement>();

/** A popup by its anchor, inside the window; a click elsewhere (a component's frame too) closes it. */
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
  const stop = () => {
    document.removeEventListener("mousedown", close);
    window.removeEventListener("blur", away);
  };
  const dismiss = () => {
    // A refresh row's edit is applied as its field is left (see `intervalRow`), then it closes.
    if (popup.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    popup.remove();
    stop();
  };
  const close = (event: MouseEvent) => {
    if (!popup.isConnected) return stop();
    const target = event.target as Node;
    if (popup.contains(target)) return;
    // Its own ⋯ (or the one drawn in its place): left to that button's click, which closes it.
    // Closed here, that click would open it again at once.
    // (A menu opened by right-clicking a card closes on any click in it.)
    const key = popup.dataset.menuKey;
    if (anchor instanceof HTMLButtonElement && anchor.contains(target)) return;
    if (key !== undefined && target instanceof Element && target.closest<HTMLElement>("[data-menu-key]")?.dataset.menuKey === key) return;
    dismiss();
  };
  // A click in a component's frame never reaches this document: the page loses focus instead.
  const away = () => {
    if (!popup.isConnected) return stop();
    dismiss();
  };
  setTimeout(() => {
    if (!popup.isConnected) return;
    document.addEventListener("mousedown", close);
    window.addEventListener("blur", away);
  }, 0);
}

/** The menu of a pin (a chip's right-click, a sheet's or card's ⋯). */
export function pinMenu(anchor: HTMLElement, pin: PinView, options: { sizes?: boolean; about?: boolean; report?: HTMLElement; resize?: (size: PinSize) => void } = {}): void {
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
    items.push(...sizeItems(pin, options.resize));
    items.push("-");
  }
  // An opened pin or a tile has no flag over its corner (it covered the content): Report is here,
  // with a screenshot of what `options.report` draws.
  const report = reportItem(anchor, pin.name, current.components[pin.name], options.report ?? null, pin.id);
  if (report) items.push(report, "-");
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
const floatWords: Record<FloatMenu, WordKey> = {
  float: "pins.float",
  stop: "float.stop",
  full: "pins.floatFull",
};

/** "Float in corner" / "Stop floating" (shown off while two float already); none where Swift says nothing. */
export function floatItem(pin: PinView): MenuItem | null {
  const menu = pin.floatMenu ?? (pin.float ? "stop" : null);
  if (!menu) return null;
  return { label: t(floatWords[menu], { n: shared.floating.max }), disabled: menu === "full", run: () => post({ type: "floatPin", id: pin.id, floating: menu === "float" }) };
}

const sizeWords: Record<string, WordKey> = { "1x1": "pins.sizeSmall", "2x1": "pins.sizeWide", "1x2": "pins.sizeTall", "2x2": "pins.sizeLarge", "4x2": "pins.sizeExtraWide" };

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
function sizeItems(pin: PinView, resize?: (size: PinSize) => void): MenuItem[] {
  const hints = current.components[pin.name]?.sizes?.length ? componentSizes(current.components[pin.name]) : [];
  const pick = resize ?? ((size: PinSize) => post({ type: "resizePin", id: pin.id, size }));
  return [{ label: t("pins.size"), run: () => {}, sizes: { current: pin.size, hints, pick } }];
}

export { boardCell, boardGap, capture, chipIcon, drawnPart, fillPinHead, PinArea, pinBody, pinHeadKey, pinStatus, pinTitle, refreshPin, whenWords } from "./pin-area";
export type { PinHeadTools, PinSurface } from "./pin-area";
