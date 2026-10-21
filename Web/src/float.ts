import { post } from "./bridge";
import { language, t } from "./i18n";
import { componentSizes, hasLiveFrame, keepFrames, pinSize, resizeFrame, sizeInfo } from "./components";
import { capture, closePopups, drawnPart, fillPinHead, openMenu, pinBody, pinHeadKey, pinTitle, refreshItems, whenWords, type MenuItem } from "./pins";
import type { ChatState, ComponentInfo, FloatCorner, FloatView, FloatingPinView, PinSize, PinView } from "./types";

/**
 * Pins floated in a corner of the window ("Float in corner" in a pin's menu): a small card over
 * the chat and the Board, only in its own bot's chat unless it is shown in all bots ("Show in all
 * bots" in its ⋯; then it carries its bot's name in its header, and stacks first), so something live (a release build's progress) can
 * be watched without asking. It draws the pin's component as its Board tile does, keeps a live
 * frame (`ccb.onData`) when new data comes, and reruns a pin refreshed every few seconds only
 * while the window is shown. Its header is the one an opened pin has (pins.ts `fillPinHead`), and
 * like it, it is as tall as its component's content up to a limit, then scrolls. Its head folds
 * it to one line (a click) and drags it to another corner (it snaps); its inner corner resizes it
 * (that width is kept, that height is then the most it grows to). It never covers the input box,
 * and in a narrow window it shows only as that one line.
 */

/** Room around a floating card and between two in the same corner, in px. */
const margin = 12;
const gap = 12;
/** A folded card's (or a chip's, in a narrow window) height: the shared header and the card's border. */
export const lineHeight = 38;
const lineWidth = 240;
/** The px a Board cell stands for, to tell the component its cells. */
const cellPx = 140;
/** A Board cell and the gap between two, in px (pins.ts's), for the width a card's tile has. */
const boardCell = 150;
const boardGap = 14;
/** A card not resized is at least this wide: typical cards then draw their full layout, not their compact one. */
export const floatWidth = 360;

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
 * How wide a card not resized is: as wide as its component's first Board size (its about.md's
 * `Sizes:`), and never narrower than `floatWidth`, so it draws its full layout.
 */
export function defaultFloatWidth(info: ComponentInfo | undefined): number {
  const { w } = sizeInfo(componentSizes(info)[0] ?? "2x2");
  const tile = w * boardCell + (w - 1) * boardGap;
  return Math.min(floatLimits.maxWidth, Math.max(floatWidth, tile));
}

/**
 * Where a card goes: in its corner, `offset` px further in when another card is there before it,
 * between the window's top and `composerTop` (never over the input box), no wider than the window.
 * Its height is its content's (CSS), up to `maxHeight`: the height it was resized to, else
 * `floatLimits.maxHeight`, and never more than the room there is. A card at the top is placed by
 * its top, one at the bottom by its bottom (`bottom` px above the window's bottom edge), so it
 * grows away from its corner. Folded, it is one line.
 */
export function floatRect(float: FloatView, view: { width: number; height: number }, composerTop: number, offset = 0, width = floatWidth): { left: number; top: number | null; bottom: number | null; width: number; maxHeight: number } {
  const bottom = Math.max(margin + lineHeight, Math.min(view.height, composerTop) - margin);
  const room = Math.max(lineHeight, bottom - margin - offset);
  const most = float.collapsed ? lineHeight : float.height ?? floatLimits.maxHeight;
  const wide = float.width ?? width;
  const shown = Math.round(Math.max(120, Math.min(float.collapsed ? Math.min(wide, lineWidth) : wide, view.width - 2 * margin)));
  const right = float.corner === "topRight" || float.corner === "bottomRight";
  const atTop = float.corner === "topRight" || float.corner === "topLeft";
  return {
    left: right ? view.width - margin - shown : margin,
    top: atTop ? margin + offset : null,
    bottom: atTop ? null : Math.round(view.height - bottom + offset),
    width: shown,
    maxHeight: Math.round(Math.min(most, room)),
  };
}

/** The corner a resize handle sits in: the card's inner one, across from its own corner. */
const innerCorner: Record<FloatCorner, FloatCorner> = {
  topRight: "bottomLeft", topLeft: "bottomRight", bottomRight: "topLeft", bottomLeft: "topRight",
};

/** A card shown in all bots carries its bot's name in its header: a small globe and the name. */
function ownerMark(botName: string): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "float-owner";
  mark.title = t("float.ownerTitle", { bot: botName });
  mark.innerHTML = globe;
  const name = document.createElement("span");
  name.textContent = botName;
  mark.append(name);
  return mark;
}

const globe = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`;

/**
 * Its menu's "Show in all bots" (off, saying which chat has no room, when one already shows the
 * most cards), or, shown in all bots, "Only in <its bot>".
 */
export function globalItems(entry: { pin: PinView; botName: string; global: boolean; blocked: string | null }): MenuItem[] {
  const id = entry.pin.id;
  if (entry.global) return [{ label: t("float.onlyIn", { bot: entry.botName }), run: () => post({ type: "setPinGlobal", id, global: false }) }];
  if (entry.blocked) return [{ label: t("float.allBotsBlocked", { bot: entry.blocked }), disabled: true, run: () => {} }];
  return [{ label: t("float.showInAllBots"), run: () => post({ type: "setPinGlobal", id, global: true }) }];
}

interface FloatEntry {
  pin: PinView;
  botName: string;
  /** Shown in all bots' chats; `blocked`: the chat that has no room for one more. */
  global: boolean;
  blocked: string | null;
  card: HTMLElement;
  head: HTMLElement;
  body: HTMLElement | null;
  bodyKey: string;
  headKey: string;
  float: FloatView;
  /** Where it is now, its height as shown (or, unmeasured, the most it may be). */
  rect: { left: number; top: number; width: number; height: number; maxHeight: number };
}

const defaultFloat: FloatView = { corner: "topRight", collapsed: false };

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
  /** A card's content got taller or shorter: the cards after it in its corner move. */
  private readonly observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.layOut()) : null;

  constructor(parent: HTMLElement) {
    this.layer = document.createElement("div");
    this.layer.className = "float-layer";
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
    this.layer.setAttribute("aria-label", t("float.layer"));
    const list: FloatingPinView[] = state.subagent ? [] : state.floating ?? [];
    this.components = state.components;
    const keep = new Set(list.map((f) => f.pin.id));
    for (const [id, entry] of this.entries) {
      if (keep.has(id)) continue;
      this.observer?.unobserve(entry.card);
      entry.card.remove();
      this.entries.delete(id);
      this.due.delete(id);
      this.pending.delete(id);
    }
    const appeared: PinView[] = [];
    for (const { pin, botName, global, blocked } of list) {
      let entry = this.entries.get(pin.id);
      if (!entry) {
        entry = this.create(pin, botName);
        this.entries.set(pin.id, entry);
        appeared.push(pin);
      }
      entry.pin = pin;
      entry.botName = botName;
      entry.global = global === true;
      entry.blocked = blocked ?? null;
      entry.float = this.merged(pin);
      this.drawHead(entry);
      this.drawBody(entry);
    }
    // In the order Swift gives (those shown in all bots first, then this chat's own); a card is moved only when out of
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

  private change(entry: FloatEntry, change: Partial<Pick<FloatView, "corner" | "collapsed">> & { width?: number; height?: number }): void {
    entry.float = { ...entry.float, ...change };
    this.pending.set(entry.pin.id, { ...(this.pending.get(entry.pin.id) ?? {}), ...change });
    post({ type: "setPinFloat", id: entry.pin.id, ...change });
  }

  private create(pin: PinView, botName: string): FloatEntry {
    const card = document.createElement("section");
    card.className = "float-card";
    card.dataset.id = pin.id;
    const head = document.createElement("div");
    head.className = "float-head pin-head";
    card.append(head);
    const entry: FloatEntry = { pin, botName, global: false, blocked: null, card, head, body: null, bodyKey: "", headKey: "", float: this.merged(pin), rect: { left: 0, top: 0, width: 0, height: 0, maxHeight: 0 } };
    this.observer?.observe(card);
    this.movable(entry);
    const handle = document.createElement("div");
    handle.className = "float-resize resize-handle";
    handle.title = t("float.dragToResize");
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

  /** Its one line, the header an opened pin has: icon, name, status, ↻ and ⋯. Redrawn whenever it changes; the body is not. */
  private drawHead(entry: FloatEntry): void {
    const pin = entry.pin;
    const info = this.components[pin.name];
    const title = pinTitle(pin, info);
    const key = JSON.stringify([pinHeadKey(pin, info), entry.botName, entry.global, language()]);
    entry.card.title = `${title} · ${entry.botName}${entry.global ? t("float.inAllBots") : ""}${pin.headline ? ` — ${pin.headline}` : ""}`;
    entry.card.setAttribute("aria-label", entry.global ? t("float.labelGlobal", { title, bot: entry.botName }) : t("float.label", { title }));
    entry.card.classList.toggle("running", pin.display.status === "running");
    entry.card.classList.toggle("global", entry.global);
    if (key === entry.headKey) return;
    entry.headKey = key;
    fillPinHead(entry.head, pin, info, { more: (anchor) => this.menu(entry, anchor) });
    if (entry.global) entry.head.querySelector(".pin-head-tools")?.before(ownerMark(entry.botName));
    entry.head.title = t("float.headTitle");
    entry.card.querySelector(".float-resize")?.setAttribute("title", t("float.dragToResize"));
  }

  /**
   * Its component, told it is pinned and its cells, as tall as its content (the card scrolls past
   * its most). Drawn again only when what it shows changed; a frame that takes live data is kept
   * and sent the new data.
   */
  private drawBody(entry: FloatEntry): void {
    // It does not rerun itself as a card would: the layer does, only while the window is shown.
    const pin: PinView = { ...entry.pin, display: { ...entry.pin.display, every: null } };
    const key = JSON.stringify([drawnPart(pin, "float"), this.components[pin.name] ?? null, language()]);
    if (key === entry.bodyKey && entry.body) return;
    entry.bodyKey = key;
    const body = document.createElement("div");
    body.className = "float-body";
    body.append(pinBody(pin, this.cells(entry), false, "float", this.components[pin.name]));
    const before = entry.body;
    const shown = before && hasLiveFrame(before) ? keepFrames(before, body) : body;
    if (before && shown !== before) before.replaceWith(shown);
    else if (!before) entry.head.after(shown);
    entry.body = shown;
  }

  private cells(entry: FloatEntry): PinSize {
    // From its own size, not as it shows (folded, in a short window), so folding does not resize it.
    const width = entry.float.width ?? defaultFloatWidth(this.components[entry.pin.name]);
    const most = entry.float.height ?? floatLimits.maxHeight;
    return floatCells(width, Math.max(lineHeight, most - lineHeight));
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
      const place = floatRect({ ...float, collapsed: folded }, view, composerTop, offset, defaultFloatWidth(this.components[entry.pin.name]));
      this.place(entry, place, folded);
      // As tall as it is drawn (its content's height); unmeasured, the most it may be.
      const height = folded ? lineHeight : Math.round(entry.card.getBoundingClientRect().height) || place.maxHeight;
      offsets[float.corner] = offset + height + gap;
      const top = place.top ?? view.height - (place.bottom ?? 0) - height;
      entry.rect = { left: place.left, top, width: place.width, height, maxHeight: place.maxHeight };
    }
  }

  private place(entry: FloatEntry, place: ReturnType<typeof floatRect>, folded: boolean): void {
    const card = entry.card;
    card.dataset.corner = entry.float.corner;
    card.classList.toggle("collapsed", folded);
    card.setAttribute("aria-expanded", String(!folded));
    // Being resized it is exactly as tall as dragged, to see it; else its content's height, up to its most.
    const exact = folded || card.classList.contains("resizing");
    Object.assign(card.style, {
      left: `${place.left}px`,
      top: place.top === null ? "" : `${place.top}px`,
      bottom: place.bottom === null ? "" : `${place.bottom}px`,
      width: `${place.width}px`,
      maxHeight: `${place.maxHeight}px`,
      height: exact ? `${place.maxHeight}px` : "",
    });
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
      // From the size it shows: one not resized yet has none of its own.
      const start = { width: entry.rect.width || entry.float.width || floatWidth, height: entry.rect.height || entry.float.height || floatLimits.maxHeight };
      const corner = entry.float.corner;
      const right = corner === "topRight" || corner === "bottomRight";
      const atTop = corner === "topRight" || corner === "topLeft";
      let size = start;
      let changed = false;
      entry.card.classList.add("resizing");
      document.body.classList.add("pin-resizing");
      capture(handle, event.pointerId);
      const move = (moved: PointerEvent) => {
        const dx = moved.clientX - startX;
        const dy = moved.clientY - startY;
        size = clampFloatSize(start.width + (right ? -dx : dx), start.height + (atTop ? dy : -dy));
        changed = true;
        entry.float = { ...entry.float, ...size };
        this.layOut();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        entry.card.classList.remove("resizing");
        document.body.classList.remove("pin-resizing");
        if (changed && (size.width !== start.width || size.height !== start.height)) this.change(entry, size);
        this.layOut();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
  }

  /** Its ⋯: whose it is, how it refreshes, fold, show in all bots or only its own, stop floating. */
  private menu(entry: FloatEntry, anchor: HTMLElement): void {
    const pin = entry.pin;
    const items: (MenuItem | "-")[] = [
      { label: pinTitle(pin, this.components[pin.name]), heading: true, run: () => {} },
      { label: `${entry.botName} · ${whenWords(pin)}`, note: true, run: () => {} },
      "-",
    ];
    if (pin.display.command) items.push(...refreshItems(pin), "-");
    if (!isNarrow(window.innerWidth)) {
      items.push({ label: entry.float.collapsed ? t("float.unfold") : t("float.fold"), run: () => {
        this.change(entry, { collapsed: !entry.float.collapsed });
        this.layOut();
      } });
    }
    items.push(...globalItems(entry));
    items.push({ label: t("float.stop"), run: () => post({ type: "floatPin", id: pin.id, floating: false }) });
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
