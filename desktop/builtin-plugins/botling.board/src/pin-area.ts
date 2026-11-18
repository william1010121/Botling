import {
  commandCard, componentElement, detailTarget, keepFrames, language, markPinFrames, post, refreshWords, shared, t,
} from "./kit";
import type { ComponentInfo, PinRefresh, PinSize } from "../../../../Web/src/types";
import type { BoardState, ChipStatus, PinView } from "./types";
import { button, closePopups, icons, liveNote, newID, openPinDialog, pinMenu, pinsState, prime, type PinAdd } from "./pins";

// The picker, the pinned component, a pin's header and `PinArea`, moved out of pins.ts unchanged (M7-S97).
// pins.ts re-exports every name from here, so no importer changes. The two files import each other (pins.ts: `whenWords`
// and the re-exports; this file: the menus, buttons and `prime`); nothing here or there uses the other at load time, only inside functions.

/** What the pin bar needs from the latest state: owned by pins.ts (`prime` is its only writer); read here through its getter, at use, never at load. */
const current = {
  get botName() { return pinsState().botName; },
  get pins() { return pinsState().pins; },
  get components() { return pinsState().components; },
  get choices() { return pinsState().choices; },
  get enabled() { return pinsState().enabled; },
};

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
    tag.className = "pin-tag command";
    tag.textContent = t("pins.command");
    const detail = document.createElement("span");
    detail.className = "pin-picker-detail";
    detail.textContent = [choice.pinned ? t("pins.pinnedTag") : "", choice.uses ? t("pins.uses", { n: choice.uses }) : ""].filter(Boolean).join(" · ");
    row.append(name, tag, detail);
    row.title = choice.command;
    row.addEventListener("click", () => {
      backdrop.remove();
      const pin = (refresh: PinRefresh, minutes: number, seconds?: number): PinAdd => ({ type: "pin", id: newID(), name: choice.name, refresh, minutes, ...(seconds ? { seconds } : {}) });
      openPinDialog(document.querySelector<HTMLElement>(".pin-chip.add") ?? document.body, { name: choice.name, command: choice.command, pin });
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
      heightKey: `${key}/${pin.name}`,
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
  /** Its menu's `openMenu` key, so ⋯ closes the menu it opened even after the header is redrawn. */
  menuKey?: string;
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
  if (tools.menuKey !== undefined) more.dataset.menuKey = tools.menuKey;
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
  // Where its Board card sits is not drawn inside it either: a moved tile keeps its frame.
  return { ...pin, headline: "", chip: undefined, display, float: undefined, floatMenu: undefined, place: undefined };
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

/** Runs `paint` at the next frame (at once where there are no frames, as in a test without them). */
function nextFrame(paint: () => void): number {
  if (typeof window.requestAnimationFrame === "function") return window.requestAnimationFrame(() => paint());
  paint();
  return 0;
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

/**
 * The Board's smallest cell and the gap between cells, in px; also floating cards' (float.ts).
 * chat.css reads them as `--board-cell-min` and `--board-gap`, set here on the page.
 */
export const boardCell = 150;
export const boardGap = 14;
if (typeof document !== "undefined") {
  document.documentElement.style.setProperty("--board-cell-min", `${boardCell}px`);
  document.documentElement.style.setProperty("--board-gap", `${boardGap}px`);
}

/** The heights an opened pin's panel may be dragged to (Swift's `PinnedComponent.panelHeights`). */
const [panelMinimum, panelMaximum] = shared.panelHeights;
/** What a dragged-up panel leaves of the window for the chat above it and the input box, in px. */
const chatRoom = 140;
function panelHeight(height: number): number {
  const most = Math.max(panelMinimum, Math.min(panelMaximum, (window.innerHeight || 800) - chatRoom));
  return Math.round(Math.min(most, Math.max(panelMinimum, height)));
}

/**
 * The pins of the chat on show: chips above the input box with the sheet they raise. Drawn from each state; parts that did not change are kept, so
 * component frames do not load again.
 */
export class PinArea {
  /** The row over the input box: the pinned strip on the left, room on its right (the hand-off chip). */
  readonly row: HTMLElement;
  private readonly dock: HTMLElement;
  private readonly chipList: HTMLElement;
  private readonly addChip: HTMLButtonElement;
  /** The words beside the +, shown only while nothing is pinned (the strip then holds just this button). */
  private readonly addLabel: HTMLElement;
  private readonly sheet: HTMLElement;
  private openID: string | null = null;
  private sheetKey = "";
  private dockKey = "";
  private botID: string | null = null;
  private dragging: string | null = null;
  private enabled = false;
  /** While the opened pin's panel is being dragged taller or shorter. */
  private sheetDrag = false;
  /** The opened pin's header, kept (filled again when what it shows changed). */
  private readonly sheetHead: HTMLElement;
  private sheetHeadKey = "";
  /** The language its words were last drawn in. */
  private wordsIn = "";
  private readonly listeners = new AbortController();

  constructor(area: HTMLElement) {
    this.sheet = document.createElement("section");
    this.sheet.className = "pin-sheet";
    this.sheet.hidden = true;
    this.sheetHead = document.createElement("div");
    this.sheetHead.className = "pin-sheet-head pin-head";
    this.dock = document.createElement("div");
    this.dock.className = "pin-dock";
    this.dock.setAttribute("role", "toolbar");
    this.dock.hidden = true;
    this.chipList = document.createElement("div");
    this.chipList.className = "pin-chip-list";
    this.addChip = button("pin-chip add", t("pins.pinAComponent"), icons.plus, () => openPicker());
    this.addLabel = document.createElement("span");
    this.addLabel.className = "pin-chip-label";
    this.addChip.append(this.addLabel);
    this.dock.append(this.chipList, this.addChip);
    this.row = document.createElement("div");
    this.row.className = "dock-row";
    this.row.append(this.dock);
    area.append(this.sheet, this.row);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(".pin-popup")) closePopups();
      else if (this.openID) this.close();
    }, { signal: this.listeners.signal });
    document.addEventListener("ccb-open-pin", (event) => {
      const pin = current.pins.find((p) => p.name === (event as CustomEvent<string>).detail);
      if (pin) this.open(pin.id);
    }, { signal: this.listeners.signal });
  }

  /** The plugin unloads: what it put in the page goes. */
  dispose(): void {
    this.listeners.abort();
    this.sheet.remove();
    this.row.remove();
    closePopups();
  }

  update(state: BoardState): void {
    // A new language: everything is drawn again in its words (live frames are kept).
    if (this.wordsIn !== language()) {
      this.wordsIn = language();
      this.dock.setAttribute("aria-label", t("pins.dock"));
      this.sheetKey = this.dockKey = this.sheetHeadKey = "";
    }
    prime(state);
    this.enabled = current.enabled;
    if (state.botID !== this.botID) {
      this.botID = state.botID;
      this.openID = null;
    }
    this.drawDock();
    this.drawSheet();
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
    // With nothing pinned the strip stays, holding only "+ Add component", so the first one can be added.
    const empty = pins.length === 0;
    this.dock.hidden = !this.enabled;
    this.dock.classList.toggle("empty", empty);
    this.addLabel.hidden = !empty;
    this.addLabel.textContent = empty ? t("pins.addFirst") : "";
    const addWords = empty ? t("pins.addFirst") : t("pins.pinAComponent");
    this.addChip.title = addWords;
    this.addChip.setAttribute("aria-label", addWords);
    const icon = (p: PinView) => [current.components[p.name]?.icon ?? null, current.components[p.name]?.iconImage ?? null];
    const key = JSON.stringify([pins.map((p) => [p.id, p.name, p.headline, p.chip ?? null, icon(p), p.display.status]), this.openID]);
    if (key === this.dockKey) return;
    this.dockKey = key;
    const scrollLeft = this.chipList.scrollLeft;
    const focusedID = this.chipList.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.id : undefined;
    this.chipList.replaceChildren();
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
      chip.addEventListener("focus", () => chip.scrollIntoView({ block: "nearest", inline: "nearest" }));
      chip.addEventListener("click", () => (this.openID === pin.id ? this.close() : this.open(pin.id)));
      chip.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        pinMenu(chip, pin);
      });
      this.dragAndDrop(chip, pin.id, index);
      this.chipList.append(chip);
    });
    // Status refreshes and opening a sheet redraw the chips. Keep the user's place in the
    // scrollable row, including the keyboard target; the add button never leaves its slot.
    this.chipList.scrollLeft = scrollLeft;
    if (focusedID) {
      [...this.chipList.querySelectorAll<HTMLButtonElement>(".pin-chip")]
        .find(chip => chip.dataset.id === focusedID)?.focus({ preventScroll: true });
    }
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
    const pin = this.enabled ? current.pins.find((p) => p.id === this.openID) : undefined;
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
    // Its frame is kept: given only new data, it takes it (ccb.onData) or is drawn anew behind
    // what it shows, so a refresh never blanks it.
    const keep = this.sheet.querySelector<HTMLElement>(":scope > .pin-sheet-body");
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

}
