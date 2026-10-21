import { post } from "./bridge";
import { hasLiveFrame, keepFrames, pinSize, resizeFrame } from "./components";
import { button, capture, chipIcon, closePopups, drawnPart, icons, openMenu, pinBody, refreshItems, refreshPin, whenWords, type MenuItem } from "./pins";
import type { ChatState, ChipStatus, ComponentInfo, FloatCorner, FloatView, FloatingPinView, PinSize, PinView } from "./types";

/**
 * Pins floated in a corner of the window ("Float in corner" in a pin's menu): a small card over
 * the chat and the Board, of whichever bot, so something live (a release build's progress) can
 * be watched without asking. It draws the pin's component as its Board tile does, keeps a live
 * frame (`ccb.onData`) when new data comes, and reruns a pin refreshed every few seconds only
 * while the window is shown. Its head folds it to one line (a click) and drags it to another
 * corner (it snaps); its inner corner resizes it. It never covers the input box, and in a narrow
 * window it shows only as that one line.
 */

/** Room around a floating card and between two in the same corner, in px. */
const margin = 12;
const gap = 12;
/** A folded card's (or a chip's, in a narrow window) height and widest width. */
const lineHeight = 34;
const lineWidth = 240;
/** The px a Board cell stands for, to tell the component its cells. */
const cellPx = 140;

/** Below this width the window shows floating cards as one line each. */
export const narrowWidth = 640;
export const floatLimits = { minWidth: 200, maxWidth: 640, minHeight: 100, maxHeight: 480 };

export function isNarrow(width: number): boolean {
  return width < narrowWidth;
}

/** A card's size kept within `floatLimits` (Swift keeps the same). */
export function clampFloatSize(width: number, height: number): { width: number; height: number } {
  const clamp = (value: number, low: number, high: number) => Math.round(Math.min(high, Math.max(low, value)));
  return { width: clamp(width, floatLimits.minWidth, floatLimits.maxWidth), height: clamp(height, floatLimits.minHeight, floatLimits.maxHeight) };
}

/** The Board cells a card of this many px stands for, for `ccb.size`: 280×160 is 2×1. */
export function floatCells(width: number, height: number): PinSize {
  return pinSize(Math.min(4, Math.max(1, Math.round(width / cellPx))), Math.min(4, Math.max(1, Math.round(height / cellPx))));
}

/** The corner nearest a point (a dragged card's centre) in a window this size. */
export function snapCorner(x: number, y: number, width: number, height: number): FloatCorner {
  const top = y < height / 2;
  const left = x < width / 2;
  return top ? (left ? "topLeft" : "topRight") : left ? "bottomLeft" : "bottomRight";
}

/**
 * Where a card goes: in its corner, `offset` px further in when another card is there before it,
 * between the window's top and `composerTop` (never over the input box), no wider than the window.
 * Folded, it is one line.
 */
export function floatRect(float: FloatView, view: { width: number; height: number }, composerTop: number, offset = 0): { left: number; top: number; width: number; height: number } {
  const bottom = Math.max(margin + lineHeight, Math.min(view.height, composerTop) - margin);
  const room = Math.max(lineHeight, bottom - margin - offset);
  const wanted = float.collapsed ? lineHeight : float.height;
  const height = Math.round(Math.min(wanted, room));
  const width = Math.round(Math.max(120, Math.min(float.collapsed ? Math.min(float.width, lineWidth) : float.width, view.width - 2 * margin)));
  const right = float.corner === "topRight" || float.corner === "bottomRight";
  const atTop = float.corner === "topRight" || float.corner === "topLeft";
  return {
    left: right ? view.width - margin - width : margin,
    top: atTop ? margin + offset : Math.max(margin, bottom - height - offset),
    width,
    height,
  };
}

/** The corner a resize handle sits in: the card's inner one, across from its own corner. */
const innerCorner: Record<FloatCorner, FloatCorner> = {
  topRight: "bottomLeft", topLeft: "bottomRight", bottomRight: "topLeft", bottomLeft: "topRight",
};

interface FloatEntry {
  pin: PinView;
  botName: string;
  card: HTMLElement;
  head: HTMLElement;
  body: HTMLElement | null;
  bodyKey: string;
  headKey: string;
  float: FloatView;
  rect: { left: number; top: number; width: number; height: number };
}

const defaultFloat: FloatView = { corner: "topRight", width: 280, height: 160, collapsed: false };

export class FloatLayer {
  private readonly layer: HTMLElement;
  private readonly entries = new Map<string, FloatEntry>();
  /** Changes made here not yet back from Swift, by pin: kept over an older state meanwhile. */
  private readonly pending = new Map<string, Partial<FloatView>>();
  private components: Record<string, ComponentInfo> = {};
  /** When each pin refreshed every few seconds runs next. */
  private readonly due = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(parent: HTMLElement) {
    this.layer = document.createElement("div");
    this.layer.className = "float-layer";
    this.layer.setAttribute("aria-label", "Floating components");
    parent.append(this.layer);
    window.addEventListener("resize", () => this.layOut());
    const composer = document.getElementById("composer-slot");
    if (composer && typeof ResizeObserver !== "undefined") new ResizeObserver(() => this.layOut()).observe(composer);
    // Shown again: those refreshed "when shown" run again (Swift skips one that just ran).
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "hidden") this.shown([...this.entries.values()].map((e) => e.pin));
    });
  }

  update(state: ChatState): void {
    const list: FloatingPinView[] = state.subagent ? [] : state.floating ?? [];
    this.components = state.components;
    const keep = new Set(list.map((f) => f.pin.id));
    for (const [id, entry] of this.entries) {
      if (keep.has(id)) continue;
      entry.card.remove();
      this.entries.delete(id);
      this.due.delete(id);
      this.pending.delete(id);
    }
    const appeared: PinView[] = [];
    for (const { pin, botName } of list) {
      let entry = this.entries.get(pin.id);
      if (!entry) {
        entry = this.create(pin, botName);
        this.entries.set(pin.id, entry);
        appeared.push(pin);
      }
      entry.pin = pin;
      entry.botName = botName;
      entry.float = this.merged(pin);
      this.drawHead(entry);
      this.drawBody(entry);
    }
    // In the order Swift gives (one bot's after another's); a card is moved only when out of
    // place, since a frame taken out of the page loads again.
    let previous: Element | null = null;
    for (const { pin } of list) {
      const card = this.entries.get(pin.id)!.card;
      const expected: Element | null = previous ? previous.nextElementSibling : this.layer.firstElementChild;
      if (expected !== card) {
        if (previous) previous.after(card);
        else this.layer.prepend(card);
      }
      previous = card;
    }
    this.layOut();
    this.shown(appeared);
    if (this.entries.size && !this.timer) this.timer = setInterval(() => this.refreshDue(), 1000);
    if (!this.entries.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The state's float with what was changed here and is not back yet. */
  private merged(pin: PinView): FloatView {
    const float = { ...defaultFloat, ...(pin.float ?? {}) };
    const pending = this.pending.get(pin.id);
    if (!pending) return float;
    const back = (Object.keys(pending) as (keyof FloatView)[]).every((key) => float[key] === pending[key]);
    if (back) {
      this.pending.delete(pin.id);
      return float;
    }
    return { ...float, ...pending };
  }

  private change(entry: FloatEntry, change: Partial<FloatView>): void {
    entry.float = { ...entry.float, ...change };
    this.pending.set(entry.pin.id, { ...(this.pending.get(entry.pin.id) ?? {}), ...change });
    post({ type: "setPinFloat", id: entry.pin.id, ...change });
  }

  private create(pin: PinView, botName: string): FloatEntry {
    const card = document.createElement("section");
    card.className = "float-card";
    card.dataset.id = pin.id;
    const head = document.createElement("div");
    head.className = "float-head";
    card.append(head);
    const entry: FloatEntry = { pin, botName, card, head, body: null, bodyKey: "", headKey: "", float: this.merged(pin), rect: { left: 0, top: 0, width: 0, height: 0 } };
    this.movable(entry);
    const handle = document.createElement("div");
    handle.className = "float-resize resize-handle";
    handle.title = "Drag to resize";
    handle.setAttribute("aria-hidden", "true");
    this.resizable(entry, handle);
    card.append(handle);
    card.addEventListener("contextmenu", (event) => {
      if ((event.target as Element).closest(".float-body")) return;
      event.preventDefault();
      this.menu(entry, card);
    });
    return entry;
  }

  /** Its one line: icon, name, status, and ↻ and ⋯. Redrawn whenever it changes; the body is not. */
  private drawHead(entry: FloatEntry): void {
    const pin = entry.pin;
    const status: ChipStatus = pin.chip ?? { text: pin.headline, tone: pin.display.status === "failed" ? "bad" : "neutral" };
    const info = this.components[pin.name];
    const key = JSON.stringify([pin.name, status, pin.headline, pin.display.status, pin.display.ranAt ?? null, info?.icon ?? null, info?.iconImage ?? null, entry.botName, !!pin.display.command]);
    entry.card.title = `${pin.name} · ${entry.botName}${pin.headline ? ` — ${pin.headline}` : ""}`;
    entry.card.setAttribute("aria-label", `${pin.name}, floating`);
    entry.card.classList.toggle("running", pin.display.status === "running");
    if (key === entry.headKey) return;
    entry.headKey = key;
    const head = entry.head;
    head.innerHTML = "";
    head.title = "Click to fold or unfold · drag to another corner";
    head.append(chipIcon(info, status));
    const title = document.createElement("span");
    title.className = "float-title";
    title.textContent = pin.name;
    const chip = document.createElement("span");
    chip.className = "float-status";
    chip.dataset.tone = status.tone;
    chip.textContent = status.text;
    const tools = document.createElement("span");
    tools.className = "float-tools";
    if (pin.display.command) {
      const refresh = button("pin-tool" + (pin.display.status === "running" ? " spinning" : ""), `Refresh (${whenWords(pin)})`, icons.refresh, () => refreshPin(entry.pin));
      refresh.disabled = pin.display.status === "running" || pin.display.status === "approve";
      tools.append(refresh);
    }
    const more = button("pin-tool", "More", icons.more, () => this.menu(entry, more));
    tools.append(more);
    head.append(title, chip, tools);
  }

  /**
   * Its component, as on the Board (it fills the card and is told its cells). Drawn again only
   * when what it shows changed; a frame that takes live data is kept and sent the new data.
   */
  private drawBody(entry: FloatEntry): void {
    // It does not rerun itself as a card would: the layer does, only while the window is shown.
    const pin: PinView = { ...entry.pin, display: { ...entry.pin.display, every: null } };
    const key = JSON.stringify([drawnPart(pin, "float"), this.components[pin.name] ?? null]);
    if (key === entry.bodyKey && entry.body) return;
    entry.bodyKey = key;
    const body = document.createElement("div");
    body.className = "float-body";
    body.append(pinBody(pin, this.cells(entry), true, "float", this.components[pin.name]));
    const before = entry.body;
    const shown = before && hasLiveFrame(before) ? keepFrames(before, body) : body;
    if (before && shown !== before) before.replaceWith(shown);
    else if (!before) entry.head.after(shown);
    entry.body = shown;
  }

  private cells(entry: FloatEntry): PinSize {
    return floatCells(entry.float.width, Math.max(lineHeight, entry.float.height - lineHeight));
  }

  /** Puts every card in its corner, stacked when two share one, above the input box. */
  layOut(): void {
    const view = { width: window.innerWidth || document.documentElement.clientWidth, height: window.innerHeight || document.documentElement.clientHeight };
    const narrow = isNarrow(view.width);
    this.layer.classList.toggle("narrow", narrow);
    const composer = document.getElementById("composer-slot")?.getBoundingClientRect();
    const composerTop = composer && composer.height > 0 ? composer.top : view.height;
    const offsets: Partial<Record<FloatCorner, number>> = {};
    for (const card of this.layer.children) {
      const entry = this.entries.get((card as HTMLElement).dataset.id ?? "");
      if (!entry) continue;
      const float = entry.float;
      const folded = float.collapsed || narrow;
      const offset = offsets[float.corner] ?? 0;
      const rect = floatRect({ ...float, collapsed: folded }, view, composerTop, offset);
      offsets[float.corner] = offset + rect.height + gap;
      entry.rect = rect;
      this.place(entry, rect, folded);
    }
  }

  private place(entry: FloatEntry, rect: FloatEntry["rect"], folded: boolean): void {
    const card = entry.card;
    card.dataset.corner = entry.float.corner;
    card.classList.toggle("collapsed", folded);
    card.setAttribute("aria-expanded", String(!folded));
    Object.assign(card.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const handle = card.querySelector<HTMLElement>(":scope > .float-resize");
    if (handle) handle.dataset.edge = innerCorner[entry.float.corner];
    const size = this.cells(entry);
    for (const frame of card.querySelectorAll<HTMLIFrameElement & { ccbSize?: PinSize }>("iframe.component-frame")) {
      if (frame.ccbSize !== size) resizeFrame(frame, size);
    }
  }

  /** Its head: a click folds or unfolds it; a drag moves it, and letting go snaps it to the nearest corner. */
  private movable(entry: FloatEntry): void {
    const head = entry.head;
    head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || (event.target as Element).closest("button")) return;
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      let moving = false;
      let dx = 0;
      let dy = 0;
      document.body.classList.add("pin-resizing");
      capture(head, event.pointerId);
      const move = (moved: PointerEvent) => {
        dx = moved.clientX - startX;
        dy = moved.clientY - startY;
        if (!moving && Math.hypot(dx, dy) < 4) return;
        moving = true;
        entry.card.classList.add("moving");
        entry.card.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        document.body.classList.remove("pin-resizing");
        entry.card.classList.remove("moving");
        entry.card.style.transform = "";
        if (!moving) {
          // In a narrow window it stays one line.
          if (!isNarrow(window.innerWidth)) this.change(entry, { collapsed: !entry.float.collapsed });
        } else {
          const r = entry.rect;
          const corner = snapCorner(r.left + r.width / 2 + dx, r.top + r.height / 2 + dy, window.innerWidth, window.innerHeight);
          if (corner !== entry.float.corner) this.change(entry, { corner });
        }
        this.layOut();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
  }

  /** Its inner corner's handle: dragging it makes the card wider or narrower, taller or shorter. */
  private resizable(entry: FloatEntry, handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      const start = { width: entry.float.width, height: entry.float.height };
      const corner = entry.float.corner;
      const right = corner === "topRight" || corner === "bottomRight";
      const atTop = corner === "topRight" || corner === "topLeft";
      let size = start;
      entry.card.classList.add("resizing");
      document.body.classList.add("pin-resizing");
      capture(handle, event.pointerId);
      const move = (moved: PointerEvent) => {
        const dx = moved.clientX - startX;
        const dy = moved.clientY - startY;
        size = clampFloatSize(start.width + (right ? -dx : dx), start.height + (atTop ? dy : -dy));
        entry.float = { ...entry.float, ...size };
        this.layOut();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        entry.card.classList.remove("resizing");
        document.body.classList.remove("pin-resizing");
        if (size.width !== start.width || size.height !== start.height) this.change(entry, size);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
  }

  /** Its ⋯: whose it is, how it refreshes, fold, stop floating. */
  private menu(entry: FloatEntry, anchor: HTMLElement): void {
    const pin = entry.pin;
    const items: (MenuItem | "-")[] = [
      { label: pin.name, heading: true, run: () => {} },
      { label: `${entry.botName} · ${whenWords(pin)}`, note: true, run: () => {} },
      "-",
    ];
    if (pin.display.command) items.push(...refreshItems(pin), "-");
    if (!isNarrow(window.innerWidth)) {
      items.push({ label: entry.float.collapsed ? "Unfold" : "Fold to one line", run: () => {
        this.change(entry, { collapsed: !entry.float.collapsed });
        this.layOut();
      } });
    }
    items.push({ label: "Stop floating", run: () => post({ type: "floatPin", id: pin.id, floating: false }) });
    closePopups();
    openMenu(anchor, items);
  }

  /** Pins that just came into sight: those refreshed "when shown" run (once allowed). */
  private shown(pins: PinView[]): void {
    const ids = pins.filter((p) => p.refresh === "shown" && p.display.command).map((p) => p.id);
    if (ids.length && document.visibilityState !== "hidden") post({ type: "pinShown", ids });
  }

  /**
   * Reruns the floating pins refreshed every few seconds (the pin's own seconds, or its about.md's
   * `Refresh: every 2s`) whose time has come, only while the window is shown and not while a run
   * is going. A pin also open on screen elsewhere (its Board tile, its sheet) is left to that.
   * How many ran.
   */
  refreshDue(now = Date.now()): number {
    if (this.busy) return 0;
    this.busy = true;
    let ran = 0;
    try {
      for (const [id, entry] of this.entries) {
        const pin = entry.pin;
        const every = typeof pin.display.every === "number" && pin.display.every > 0 ? pin.display.every
          : pin.refresh === "interval" && pin.seconds ? pin.seconds : 0;
        const status = pin.display.status;
        if (!every || !pin.display.command || (status !== "done" && status !== "failed")) {
          this.due.delete(id);
          continue;
        }
        const due = this.due.get(id);
        if (due === undefined) {
          this.due.set(id, now + every * 1000);
          continue;
        }
        if (now < due || document.visibilityState === "hidden" || this.elsewhere(id)) continue;
        this.due.set(id, now + Math.max(1, every) * 1000);
        post({ type: "pinCommand", id, command: pin.display.command, folder: pin.display.folder ?? "", force: true, live: true });
        ran += 1;
      }
    } finally {
      this.busy = false;
    }
    return ran;
  }

  /** Whether the pin's Board tile or opened sheet, rerunning itself, is on screen. */
  private elsewhere(id: string): boolean {
    for (const card of document.querySelectorAll<HTMLElement>(`.command-card[data-every][data-live-key="pin:${id}/0"]`)) {
      if (this.layer.contains(card)) continue;
      const box = card.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) return true;
    }
    return false;
  }
}
