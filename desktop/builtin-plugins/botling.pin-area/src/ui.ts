// botling.pin-area, what the page draws: the list of cards above the chat (A 細清單: one thin row per card, a card that waits for you
// has an orange edge; a click opens the row in place into the card: status, steps, its thread and a collapsed 過程 log). At most 4 rows
// show, then 「還有 N 件」. An open card stays at the top while the chat scrolls below it; it has no input box: the chat's own box gets a
// 「回覆到 <card>」 chip (`Deps.chip`) and what is typed goes into the card. A click on the chat's empty space, Esc or the chevron closes it.
// Every word from a bot or a thread goes in with textContent, never as HTML. No Botling import: `Deps` is all this needs, so a test
// draws it in jsdom with fakes (no window, no focus taken).
import { readView, spanOf, type DigestRow, type DigestView, type PinsView } from "./digest";
import type { PinView, TraceData, Turn } from "./model";
import type { Words } from "./words";

export interface Deps {
  /** Calls the program part (`ccb.call`). */
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  words: Words;
  now(): number;
  /**
   * The chat's input box says where its words go: 「回覆到 <title>」 with a ✕ that leaves the card (`PinUi.close`); null takes the chip away.
   * What is typed while it shows goes into that card (the chip puts `@id ` before the words).
   */
  chip(card: { id: string; title: string } | null): void;
  /** Puts the caret in the chat's input box (a card was opened: the next thing is to write). */
  focusComposer(): void;
  /** Shows another bot's chat (`ccb.page.openChat`), at one of its lines when `messageId` is given. */
  openChat(botId: string, messageId?: string): void;
}

const SVG = "http://www.w3.org/2000/svg";
const PIN_PATH = ["M9 4h6l-1 6 3 3H7l3-3-1-6z", "M12 13v7"];
const icon = (paths: string[], size = 12, width = 2): SVGElement => {
  const svg = document.createElementNS(SVG, "svg");
  for (const [name, value] of [["width", String(size)], ["height", String(size)], ["viewBox", "0 0 24 24"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", String(width)], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"]] as const) svg.setAttribute(name, value);
  for (const d of paths) { const path = document.createElementNS(SVG, "path"); path.setAttribute("d", d); svg.append(path); }
  return svg;
};
export const pinIcon = (size = 12): SVGElement => icon(PIN_PATH, size);
export const closeIcon = (size = 12): SVGElement => icon(["M6 6l12 12M18 6L6 18"], size, 2.4);
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const TOAST_MS = 8_000;
const MAX_BARS = 12;
const KEYS = 3;
/** More cards than this: the first rows, then one 「還有 N 件」 row (a tap shows the rest). */
export const MAX_ROWS = 4;
/** A press on one of these in the chat's list is the chat's own business; on the list or a message row itself (the blank space) it leaves the open card. */
const BLANK = "#scroller, #messages, #messages .row, #messages .stamped";
const OWN_THINGS = "a, button, input, textarea, select, summary, [contenteditable], .bubble, .message-footer, .decoration-extra";

export function barsOf(pin: PinView): { done: number; total: number } | null {
  if (!pin.step) return null;
  return { done: pin.step.done, total: Math.min(pin.step.total, MAX_BARS) };
}
export const tagKey = (pin: Pick<PinView, "source">): "tag.user" | "tag.bot" | "tag.app" => (pin.source === "app" ? "tag.app" : pin.source === "user" ? "tag.user" : "tag.bot");
/** "HH:MM" of a time. */
export const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export class PinUi {
  private botId = "";
  private data: PinsView = { v: 1, pins: [] };
  private openId: string | null = null;
  private lastFocusId: string | null = null;
  private readonly digest = el("section", "pt-digest");
  private readonly section = el("section", "pt-strip");
  private readonly head = el("div", "pt-head");
  private readonly rows = el("div", "pt-rows");
  /** The rows above the open card, the card's own place, the rows below it, and 「還有 N 件」: only the rows are redrawn, so the card keeps its scroll. */
  private readonly above = el("div", "pt-above");
  private readonly below = el("div", "pt-below");
  private readonly more = el("button", "pt-more");
  private readonly toastLine = el("div", "pt-toast");
  private panel: HTMLElement | null = null;
  private panelParts: { title: HTMLElement; tag: HTMLElement; dot: HTMLElement; at: HTMLElement; note: HTMLElement; fresh: HTMLElement; status: HTMLElement; before: HTMLElement; bars: HTMLElement; thread: HTMLElement; updates: HTMLElement } | null = null;
  private toast: { text: string; undo?: { id: string }; until: number } | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private updatesOpen = false;
  /** 「還有 N 件」 was pressed (or the open card is below the first rows): every row shows. */
  private showAll = false;
  /** Cards that were unread when they were opened: their 剛更新 mark stays while they are open. */
  private readonly fresh = new Set<string>();
  /** What the chat's input box shows now (`id|title`), so it is told only when that changes. */
  private chipKey: string | null = null;
  /** Traces whose "改到…" list is open, and the moves under way (a double tap moves once). */
  private readonly alts = new Set<string>();
  private readonly moving = new Set<string>();
  private lastThread = new Map<string, number>();
  /** 看完了 / the chip's reopen is under way (a double tap asks once); let go when the chat draws the answer or after a moment. */
  private folding: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new AbortController();

  constructor(private readonly top: HTMLElement, private readonly deps: Deps) {
    this.section.setAttribute("aria-label", deps.words("strip.label"));
    this.more.type = "button";
    this.more.addEventListener("click", () => { this.showAll = !this.showAll; this.draw(); });
    this.rows.append(this.above, this.below, this.more);
    this.section.append(this.head, this.rows, this.toastLine);
    this.top.append(this.digest, this.section);
    const { signal } = this.listeners;
    // A plain primary-button press on the chat's empty space leaves the open card (not a press on a message, a button, the input box or the
    // list above; not a right-click, not a press on the scrollbar). A touch is a tap or the start of a scroll: it counts on its `click` only.
    let lastPointer = "";
    document.addEventListener("pointerdown", (event) => {
      lastPointer = (event as PointerEvent).pointerType ?? "";
      if (!this.openId || lastPointer === "touch" || (event as MouseEvent).button !== 0 || !this.isBlank(event.target, event as MouseEvent)) return;
      this.close();
    }, { capture: true, signal });
    document.addEventListener("click", (event) => {
      if (!this.openId || lastPointer !== "touch" || !this.isBlank(event.target)) return;
      this.close();
    }, { capture: true, signal });
    // ⌘1–3 open a card (before the page's own keys); Esc leaves it, but only when nothing else took the Esc (the input box's @ list, the model menu).
    document.addEventListener("keydown", (event) => this.onKey(event), { capture: true, signal });
    document.addEventListener("keydown", (event) => this.onEscape(event), { signal });
    this.draw();
  }

  dispose(): void {
    this.listeners.abort();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.folding) clearTimeout(this.folding);
    this.panel?.remove();
    this.digest.remove();
    this.section.remove();
    this.deps.chip(null);
    this.chipKey = null;
  }

  /** The chat's empty space: its list or a message row itself, not what is drawn on a row. */
  private isBlank(target: EventTarget | null, press?: MouseEvent): boolean {
    if (!(target instanceof Element) || this.section.contains(target) || this.digest.contains(target)) return false;
    if (!target.matches(BLANK) || target.closest(OWN_THINGS) || !target.closest("#scroller")) return false;
    // a press on the scroller's own scrollbar (beside or below its content box) is a drag of the scroll thumb, not the blank space
    if (press && target.id === "scroller" && target.clientWidth > 0) {
      const box = target.getBoundingClientRect();
      if (press.clientX - box.left >= target.clientWidth || press.clientY - box.top >= target.clientHeight) return false;
    }
    return true;
  }

  /** The chat drew `botId` with these pins (null: the program part has not said yet). */
  update(botId: string, data: PinsView | null): void {
    if (botId !== this.botId) {
      // another chat: its own cards, nothing of the last chat's panel
      this.botId = botId;
      this.openId = null;
      this.lastThread.clear();
      this.toast = null;
      this.removePanel();
      this.showAll = false;
      this.fresh.clear();
    }
    const away = data ? readView(data.away) : null;
    this.data = data && Array.isArray(data.pins) ? { ...data, ...(away ? { away } : { away: undefined }) } : { v: 1, pins: [] };
    if (this.folding) { clearTimeout(this.folding); this.folding = null; }
    if (this.openId && !this.pin(this.openId)) { this.openId = null; this.removePanel(); }
    this.draw();
  }

  /** What the "@" list offers: this chat's cards, by handle or id (`query` is lower case). */
  mentions(query: string): { name: string; about?: string; insert: string }[] {
    return this.data.pins
      .filter((pin) => pin.handle.toLowerCase().startsWith(query) || pin.id.startsWith(query))
      .slice(0, 8)
      .map((pin) => ({ name: pin.handle, about: `${this.deps.words(`state.${pin.state}`)} · ${pin.status}`, insert: `@${pin.handle} ` }));
  }

  isOpen(id?: string): boolean { return id === undefined ? this.openId !== null : this.openId === id; }
  get pins(): PinView[] { return this.data.pins; }

  private pin(id: string): PinView | undefined { return this.data.pins.find((pin) => pin.id === id); }

  // ---- the list ----

  /** The time of a card's last change: "HH:MM" today, month/day before. */
  private when(at: number): string {
    const day = (time: number) => new Date(time).toDateString();
    return day(at) === day(this.deps.now()) ? clock(at) : new Date(at).toLocaleDateString([], { month: "numeric", day: "numeric" });
  }

  private draw(): void {
    const { words } = this.deps;
    const pins = this.data.pins;
    this.drawDigest();
    this.section.hidden = pins.length === 0 && !this.toast;
    const waiting = pins.filter((pin) => pin.state === "wait").length;
    this.head.replaceChildren();
    if (pins.length) {
      const label = el("span", "pt-head-label", words("strip.title", { n: pins.length }));
      const keys = el("span", "pt-head-keys", pins.length === 1 ? words("strip.key") : words("strip.keys", { n: Math.min(pins.length, KEYS) }));
      this.head.append(pinIcon(), label, keys);
      this.head.classList.toggle("has-wait", waiting > 0);
    }
    // a row that has the keyboard focus keeps it across the redraw
    const active = document.activeElement instanceof HTMLElement && this.rows.contains(document.activeElement) ? document.activeElement.dataset.pin ?? null : null;
    // the first rows (the open card counts as one and shows in its place); the rest sit behind 「還有 N 件」
    const shown = (index: number) => this.showAll || index < MAX_ROWS;
    const openAt = pins.findIndex((pin) => pin.id === this.openId);
    this.above.replaceChildren(...pins.flatMap((pin, index) => (index < openAt && shown(index) ? [this.row(pin)] : [])));
    this.below.replaceChildren(...pins.flatMap((pin, index) => (index > openAt && shown(index) ? [this.row(pin)] : [])));
    // the card goes between the two groups (it is made once and keeps its scroll)
    if (this.panel && this.above.nextSibling !== this.panel) this.above.after(this.panel);
    const hidden = this.showAll ? 0 : Math.max(0, pins.length - MAX_ROWS);
    this.more.hidden = pins.length <= MAX_ROWS;
    this.more.className = `pt-more${this.showAll ? " open" : ""}`;
    this.more.replaceChildren(el("span", "", hidden ? words("strip.more", { n: hidden }) : words("strip.less", { n: MAX_ROWS })), icon([hidden ? "M6 9l6 6 6-6" : "M18 15l-6-6-6 6"], 14));
    this.more.setAttribute("aria-expanded", String(this.showAll));
    const focusId = this.lastFocusId ?? active;
    this.lastFocusId = null;
    if (focusId) (Array.from(this.rows.querySelectorAll<HTMLElement>(".pt-row"))).find((row) => row.dataset.pin === focusId)?.focus({ preventScroll: true });
    this.drawToast();
    this.drawChip();
    if (this.openId) this.drawPanel();
  }

  /** One thin row (A 細清單): a dot of its state, the title, the one-line status, when it changed (剛更新 while unread), a chevron. */
  private row(pin: PinView): HTMLElement {
    const { words } = this.deps;
    const row = el("button", `pt-row pt-${pin.state}`);
    row.type = "button";
    row.dataset.pin = pin.id;
    row.setAttribute("aria-expanded", "false");
    row.setAttribute("aria-label", `${words("row.open", { title: pin.title })} · ${words(`state.${pin.state}`)} · ${pin.status}`);
    const when = this.when(pin.updatedAt);
    row.append(
      el("span", `pt-dot pt-dot-${pin.state}`),
      el("b", "pt-title", pin.title),
      el("span", "pt-short", pin.status),
      el("span", `pt-meta${pin.unread ? " fresh" : ""}`, pin.unread ? `${when} ${words("row.fresh")}` : when),
      icon(["M6 9l6 6 6-6"], 14),
    );
    row.addEventListener("click", () => this.open(pin.id));
    return row;
  }

  /** The chat's input box shows 「回覆到 <title>」 while a card is open. */
  private drawChip(): void {
    const pin = this.openId ? this.pin(this.openId) : undefined;
    const key = pin ? `${pin.id}|${pin.title}` : null;
    if (key === this.chipKey) return;
    this.chipKey = key;
    this.deps.chip(pin ? { id: pin.id, title: pin.title } : null);
  }

  private bars(pin: PinView, className: string): HTMLElement {
    const box = el("span", `pt-bars ${className}`);
    const steps = barsOf(pin);
    if (!steps) return box;
    for (let i = 0; i < steps.total; i++) box.append(el("span", `pt-bar${i < steps.done ? ` on-${pin.state === "done" ? "done" : "run"}` : ""}`));
    return box;
  }

  // ---- 「你不在時」, the digest above the strip ----

  private spanWords(from: number, to: number): string {
    const { unit, n } = spanOf(from, to);
    return this.deps.words(`span.${unit}`, { n });
  }

  /** "22:30 – 01:31"; a gap of a day or more says the dates too. */
  private rangeOf(away: DigestView): string {
    const day = (at: number) => new Date(at).toLocaleDateString([], { month: "numeric", day: "numeric" });
    const long = away.to - away.from >= 20 * 3_600_000;
    return `${long ? `${day(away.from)} ` : ""}${clock(away.from)} – ${long ? `${day(away.to)} ` : ""}${clock(away.to)}`;
  }

  private fold(collapsed: boolean): void {
    if (this.folding) return;
    this.folding = setTimeout(() => { this.folding = null; }, 2_000);
    void this.deps.call("collapse", { botId: this.botId, collapsed }).catch((error) => this.failed(error));
  }

  private drawDigest(): void {
    const { words } = this.deps;
    const away = this.data.away;
    this.digest.replaceChildren();
    this.digest.hidden = !away;
    if (!away) return;
    const { counts } = away;
    if (away.collapsed) {
      // the one line: what was there, and a tap shows it again
      const parts = [
        counts.wait ? words("digest.c.wait", { n: counts.wait }) : "", counts.run ? words("digest.c.run", { n: counts.run }) : "", counts.done ? words("digest.c.done", { n: counts.done }) : "",
        !away.rows.length && away.others.length ? words("digest.c.others", { n: away.others.length + away.othersMore }) : "",
      ].filter(Boolean);
      const chip = el("button", "pt-digest-chip", words("digest.chip", { parts: parts.join(" · ") }));
      chip.type = "button";
      chip.title = words("digest.reopen");
      chip.setAttribute("aria-expanded", "false");
      chip.addEventListener("click", () => this.fold(false));
      this.digest.append(chip);
      return;
    }
    this.digest.setAttribute("aria-label", words("digest.label"));
    const head = el("div", "pt-d-head");
    head.append(el("span", "pt-d-title", words("digest.title", { span: this.spanWords(away.from, away.to) })), el("span", "pt-d-range", this.rangeOf(away)));
    const card = el("div", "pt-d-card");
    card.append(head);
    if (away.rows.length) {
      const tiles = el("div", "pt-d-tiles");
      for (const state of ["wait", "run", "done"] as const) {
        const tile = el("div", `pt-tile pt-tile-${state}`);
        tile.append(el("span", "pt-tile-n", String(counts[state])), el("span", "pt-tile-l", words(`digest.n.${state}`)));
        tiles.append(tile);
      }
      const list = el("div", "pt-d-rows");
      for (const row of away.rows) list.append(this.digestRow(row));
      card.append(tiles, list);
    }
    if (away.others.length) {
      const others = el("div", "pt-d-others");
      others.append(el("span", "pt-d-label", words("digest.others", { n: away.others.length + away.othersMore })));
      for (const line of away.others) {
        const row = el("button", "pt-orow");
        row.type = "button";
        row.dataset.bot = line.botId;
        row.title = words("digest.openBot", { name: line.name });
        row.setAttribute("aria-label", `${words("digest.openBot", { name: line.name })} · ${line.text}`);
        row.append(el("span", "pt-dot pt-dot-wait"), el("b", "pt-oname", line.name), el("span", "pt-otext", line.text));
        if (line.more > 0) row.append(el("span", "pt-omore", words("digest.more", { n: line.more })));
        row.addEventListener("click", () => this.deps.openChat(line.botId, line.messageId));
        others.append(row);
      }
      if (away.othersMore > 0) others.append(el("span", "pt-d-more", words("digest.moreBots", { n: away.othersMore })));
      card.append(others);
    }
    const close = el("button", "pt-d-close", words("digest.close"));
    close.type = "button";
    close.addEventListener("click", () => this.fold(true));
    const foot = el("div", "pt-d-foot");
    foot.append(close);
    card.append(foot);
    this.digest.append(card);
  }

  /** One card that changed while away: waiting rows are orange and say how long they have waited; a tap opens the card's panel. */
  private digestRow(row: DigestRow): HTMLElement {
    const { words } = this.deps;
    const button = el("button", `pt-drow pt-drow-${row.state}`);
    button.type = "button";
    button.dataset.pin = row.id;
    button.setAttribute("aria-label", `${words("row.open", { title: row.title })} · ${words(`digest.n.${row.state}`)} · ${row.status}`);
    const text = el("span", "pt-dtext");
    text.append(el("b", "", row.title), document.createTextNode(row.status ? `：${row.status}` : ""));
    const tag = row.state === "wait" && row.waitingSince !== undefined
      ? el("span", "pt-dtag pt-dtag-wait", words("digest.waitFor", { span: this.spanWords(row.waitingSince, this.deps.now()) }))
      : el("span", `pt-dtag pt-ptag-${row.source}`, words(tagKey(row)));
    button.append(el("span", `pt-dot pt-dot-${row.state}`), text, tag);
    button.addEventListener("click", () => this.open(row.id));
    return button;
  }

  // ---- toast ----

  private showToast(text: string, undo?: { id: string }): void {
    this.toast = { text, ...(undo ? { undo } : {}), until: this.deps.now() + TOAST_MS };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toast = null; this.draw(); }, TOAST_MS);
    this.draw();
  }

  private drawToast(): void {
    this.toastLine.replaceChildren();
    this.toastLine.hidden = !this.toast;
    if (!this.toast) return;
    const toast = this.toast;
    this.toastLine.append(el("span", "pt-toast-text", toast.text));
    if (toast.undo) {
      const undo = el("button", "pt-toast-act", this.deps.words("toast.undo"));
      undo.type = "button";
      undo.addEventListener("click", () => {
        const id = toast.undo!.id;
        this.toast = null;
        this.draw();
        void this.deps.call("repin", { botId: this.botId, id }).then(() => this.open(id), (error) => this.failed(error));
      });
      this.toastLine.append(undo);
    }
  }

  private failed(error: unknown): void {
    const why = error instanceof Error ? error.message : String(error);
    this.showToast(this.deps.words("toast.failed", { why: why.slice(0, 120) }));
  }

  // ---- the card (a row, opened in place) ----

  open(id: string): void {
    const pin = this.pin(id);
    if (!pin) return;
    const was = this.openId;
    if (was && was !== id) this.leave(was);
    this.openId = id;
    this.updatesOpen = false;
    if (pin.unread) this.fresh.add(id); else this.fresh.delete(id);
    // a card below the first rows is shown, so the rows around it are too
    if (this.data.pins.findIndex((candidate) => candidate.id === id) >= MAX_ROWS) this.showAll = true;
    this.removePanel();
    this.draw();
    this.deps.focusComposer();
    void this.deps.call("seen", { botId: this.botId, id }).catch(() => {});
  }

  /** Closes the card (it is a row again, the chip is gone); a done card the user opened and now closes is unpinned (with a 釘回). */
  close(refocus = false): void {
    const id = this.openId;
    if (!id) return;
    this.openId = null;
    this.lastFocusId = refocus ? id : null;
    this.leave(id);
    this.removePanel();
    this.draw();
  }

  private leave(id: string): void {
    this.fresh.delete(id);
    const pin = this.pin(id);
    if (!pin || pin.state !== "done") return;
    void this.deps.call("unpin", { botId: this.botId, id, by: "seen" }).then(
      () => this.showToast(this.deps.words("toast.seen", { title: pin.title }), { id }),
      (error) => this.failed(error),
    );
  }

  unpin(id: string): void {
    const pin = this.pin(id);
    if (!pin) return;
    if (this.openId === id) { this.openId = null; this.removePanel(); }
    void this.deps.call("unpin", { botId: this.botId, id }).then(
      () => this.showToast(this.deps.words("toast.unpinned", { title: pin.title }), { id }),
      (error) => this.failed(error),
    );
  }

  private removePanel(): void {
    const panel = this.panel;
    this.panel = null;
    this.panelParts = null;
    panel?.remove();
  }

  private drawPanel(): void {
    const pin = this.openId ? this.pin(this.openId) : undefined;
    if (!pin) return;
    const { words } = this.deps;
    if (!this.panel) { this.buildPanel(pin); this.above.after(this.panel!); }
    const parts = this.panelParts!;
    this.panel!.setAttribute("aria-label", pin.title);
    parts.dot.className = `pt-dot pt-dot-${pin.state}`;
    parts.title.textContent = pin.title;
    parts.tag.textContent = words(tagKey(pin));
    parts.tag.className = `pt-ptag pt-ptag-${pin.source}`;
    parts.at.textContent = words("card.at", { time: this.when(pin.updatedAt) });
    parts.fresh.hidden = !this.fresh.has(pin.id);
    parts.status.textContent = pin.status;
    parts.before.hidden = !pin.prev;
    parts.note.hidden = parts.fresh.hidden && !pin.prev;
    parts.before.replaceChildren();
    if (pin.prev) { parts.before.append(document.createTextNode(words("panel.before")), el("s", "", pin.prev)); }
    parts.bars.replaceChildren();
    if (pin.step) {
      parts.bars.append(this.bars(pin, "pt-bars-l"));
      const left = pin.step.total - pin.step.done;
      parts.bars.append(el("span", "pt-left", left === 1 ? words("panel.leftOne") : words("panel.left", { n: left })));
    }
    this.drawThread(pin, parts);
    this.drawUpdates(pin, parts);
  }

  private buildPanel(pin: PinView): void {
    const { words } = this.deps;
    const panel = el("article", "pt-card");
    panel.dataset.pin = pin.id;
    const head = el("div", "pt-phead");
    const dot = el("span", "pt-dot");
    const title = el("b", "pt-ptitle");
    const tag = el("span", "pt-ptag");
    const at = el("span", "pt-cat");
    const unpin = el("button", "pt-ib");
    unpin.type = "button";
    unpin.title = words("panel.unpin");
    unpin.setAttribute("aria-label", words("panel.unpin"));
    unpin.append(icon([...PIN_PATH, "M4 4l16 16"], 16));
    unpin.addEventListener("click", () => this.unpin(pin.id));
    const close = el("button", "pt-ib pt-collapse");
    close.type = "button";
    close.title = words("panel.close");
    close.setAttribute("aria-label", words("panel.close"));
    close.append(icon(["M18 15l-6-6-6 6"], 16));
    close.addEventListener("click", () => this.close(true));
    head.append(dot, title, tag, el("span", "pt-grow"), at, unpin, close);
    const status = el("span", "pt-pstatus");
    const fresh = el("span", "pt-pill", words("row.fresh"));
    const before = el("span", "pt-pbefore");
    const bars = el("div", "pt-pbars");
    const note = el("div", "pt-pnote");
    note.append(fresh, before);
    const summary = el("div", "pt-psummary");
    summary.append(note, status, bars);
    const thread = el("div", "pt-thread");
    thread.setAttribute("role", "log");
    const updates = el("div", "pt-updates");
    panel.append(head, summary, thread, updates);
    this.panel = panel;
    this.panelParts = { title, tag, dot, at, note, fresh, status, before, bars, thread, updates };
  }

  private drawThread(pin: PinView, parts: NonNullable<PinUi["panelParts"]>): void {
    const { words } = this.deps;
    const nearBottom = parts.thread.scrollHeight - parts.thread.scrollTop - parts.thread.clientHeight < 60;
    parts.thread.replaceChildren();
    if (!pin.thread.length) parts.thread.append(el("div", "pt-empty", words("panel.empty")));
    for (const turn of pin.thread) {
      // a turn with no words of yours is an answer the bot gave by itself (a second <pin-say>)
      if (turn.q) {
        const mine = el("div", "pt-msg pt-me");
        mine.append(el("span", "pt-bubble", turn.q), el("span", `pt-receipt${turn.seenAt !== null ? " seen" : ""}`, `${clock(turn.qAt)} · ${this.receipt(turn)}`));
        // a line the bot put here by itself: one tap takes it back to the chat
        if (turn.via === "auto") {
          const back = el("button", "pt-mv-act", words("trace.backBtn"));
          back.type = "button";
          back.addEventListener("click", () => this.moveBack(turn.rid));
          mine.append(back);
        }
        parts.thread.append(mine);
      }
      if (turn.a !== null) {
        const bot = el("div", "pt-msg pt-bot");
        bot.append(el("span", "pt-bubble", turn.a), el("span", "pt-receipt", `${words("bot.name")} · ${clock(turn.aAt ?? turn.qAt)}`));
        parts.thread.append(bot);
      }
    }
    const grew = pin.thread.length > (this.lastThread.get(pin.id) ?? 0);
    this.lastThread.set(pin.id, pin.thread.length);
    if (nearBottom || grew) parts.thread.scrollTop = parts.thread.scrollHeight;
  }

  private receipt(turn: Turn): string {
    const { words } = this.deps;
    if (turn.via === "auto") return turn.redirected ? words("receipt.redirected") : words("receipt.auto");
    return turn.a !== null || turn.seenAt !== null ? words("receipt.seen") : words("receipt.sent");
  }

  // ---- the trace in the chat: where the user's line went (drawn by the page's decoration for it) ----

  /** 移回聊天. */
  moveBack(rid: string): void {
    this.move(rid, "moveBack", {});
  }
  /** 改到… (`to`: a card id). */
  moveTo(rid: string, to: string): void {
    this.alts.delete(rid);
    this.move(rid, "moveTo", { to });
  }
  private move(rid: string, method: string, params: Record<string, unknown>): void {
    if (this.moving.has(rid)) return;
    this.moving.add(rid);
    void this.deps.call(method, { botId: this.botId, rid, ...params }).then(() => {}, (error) => this.failed(error)).finally(() => this.moving.delete(rid));
  }

  /** One line where the user's line was: "→ 放進「X」的卡片 · 移回聊天 · 改到…"; once moved back, the answer stays under it. */
  trace(root: HTMLElement, data: TraceData): void {
    const { words } = this.deps;
    root.replaceChildren();
    const line = el("div", `pt-mv pt-mv-${data.kind}`);
    if (data.kind === "back") {
      line.append(el("span", "pt-mv-text", words("trace.back")));
      root.append(line);
      if (data.a) root.append(el("div", "pt-mv-ans", `${words("bot.name")}：${data.a}`));
      return;
    }
    const open = el("button", "pt-mv-open", words(data.by === "user" ? "trace.moved" : "trace.put", { q: `“${data.q}”`, title: data.title }));
    open.type = "button";
    open.title = words("trace.open", { title: data.title });
    open.addEventListener("click", () => this.open(data.pin));
    const back = el("button", "pt-mv-act", words("trace.backBtn"));
    back.type = "button";
    back.addEventListener("click", () => this.moveBack(data.rid));
    const other = el("button", "pt-mv-act", words("trace.other"));
    other.type = "button";
    other.setAttribute("aria-expanded", String(this.alts.has(data.rid)));
    other.addEventListener("click", () => { if (this.alts.has(data.rid)) this.alts.delete(data.rid); else this.alts.add(data.rid); this.trace(root, data); });
    line.append(pinIcon(), open, el("span", "pt-mv-sep", "·"), back, el("span", "pt-mv-sep", "·"), other);
    root.append(line);
    if (this.alts.has(data.rid)) {
      const list = el("div", "pt-mv-alts");
      for (const pin of this.data.pins.filter((candidate) => candidate.id !== data.pin)) {
        const choice = el("button", "pt-mv-alt");
        choice.type = "button";
        choice.append(el("span", `pt-dot pt-dot-${pin.state}`), el("span", "", pin.title));
        choice.addEventListener("click", () => this.moveTo(data.rid, pin.id));
        list.append(choice);
      }
      root.append(list);
    }
  }

  private drawUpdates(pin: PinView, parts: NonNullable<PinUi["panelParts"]>): void {
    const { words } = this.deps;
    parts.updates.replaceChildren();
    // the first line is the card being made; the rest are "N 則更新"
    const lines = pin.updates.slice(1);
    parts.updates.hidden = lines.length === 0;
    if (!lines.length) return;
    const toggle = el("button", "pt-updates-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(this.updatesOpen));
    toggle.append(icon([this.updatesOpen ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6"]), el("span", "", words("panel.updates", { n: lines.length })), el("span", "pt-grow"), el("span", "pt-updates-last", lines[lines.length - 1]!.status));
    toggle.addEventListener("click", () => { this.updatesOpen = !this.updatesOpen; this.drawUpdates(pin, parts); });
    parts.updates.append(toggle);
    if (this.updatesOpen) {
      const list = el("ul", "pt-updates-list");
      for (const line of lines) list.append(el("li", "", `${clock(line.at)} · ${line.status}`));
      parts.updates.append(list);
    }
  }

  // ---- keys ----

  /** Esc folds the card unless something took it first (a list or menu that closed on this Esc has called preventDefault); the caret stays in the box it was in. */
  private onEscape(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !this.openId || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    const target = event.target;
    this.close(!(target instanceof Element && target.closest("input, textarea, [contenteditable]")));
  }

  private onKey(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey && /^[1-9]$/.test(event.key)) {
      const pin = this.data.pins[Number(event.key) - 1];
      if (!pin || Number(event.key) > KEYS) return;
      event.preventDefault();
      event.stopPropagation();
      if (this.openId === pin.id) this.close(true); else this.open(pin.id);
    }
  }
}
