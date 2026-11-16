// botling.pin-area, what the page draws: the strip of cards above the chat (one row each, faded until you point at it, a card that
// waits for you always clear) and the floating panel a row opens (status, steps, the card's own thread and its own input box).
// Every word from a bot or a thread goes in with textContent, never as HTML. No Botling import: `Deps` is all this needs, so a test
// draws it in jsdom with fakes (no window, no focus taken).
import type { BookView, PinView, TraceData, Turn } from "./model";
import type { Words } from "./words";

export interface Deps {
  /** Calls the program part (`ccb.call`). */
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** Sends words to the chat's bot as the user (`ccb.page.post({ type: "send" })`). */
  send(text: string): void;
  words: Words;
  now(): number;
  /** The user asked for no motion: the panel then leaves at once instead of sliding out. */
  reduceMotion(): boolean;
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
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const TOAST_MS = 8_000;
/** A send waits for its line in the thread (the program part's answer to the page); one that never shows (another plugin stopped it) lets go after this long. */
const SEND_WAIT_MS = 4_000;
const MAX_BARS = 12;
const KEYS = 3;

export function barsOf(pin: PinView): { done: number; total: number } | null {
  if (!pin.step) return null;
  return { done: pin.step.done, total: Math.min(pin.step.total, MAX_BARS) };
}
export const tagKey = (pin: PinView): "tag.user" | "tag.bot" | "tag.app" => (pin.source === "app" ? "tag.app" : pin.source === "user" ? "tag.user" : "tag.bot");
/** "HH:MM" of a time. */
export const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export class PinUi {
  private botId = "";
  private data: BookView = { v: 1, pins: [] };
  private openId: string | null = null;
  private lastFocusId: string | null = null;
  private readonly section = el("section", "pt-strip");
  private readonly head = el("div", "pt-head");
  private readonly rows = el("div", "pt-rows");
  private readonly toastLine = el("div", "pt-toast");
  private panel: HTMLElement | null = null;
  private panelParts: { title: HTMLElement; tag: HTMLElement; dot: HTMLElement; status: HTMLElement; before: HTMLElement; bars: HTMLElement; thread: HTMLElement; updates: HTMLElement; input: HTMLInputElement; hint: HTMLElement } | null = null;
  private toast: { text: string; undo?: { id: string }; until: number } | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly sending = new Map<string, { at: number; turns: number }>();
  private updatesOpen = false;
  /** Traces whose "改到…" list is open, and the moves under way (a double tap moves once). */
  private readonly alts = new Set<string>();
  private readonly moving = new Set<string>();
  private lastThread = new Map<string, number>();
  private readonly listeners = new AbortController();

  constructor(private readonly top: HTMLElement, private readonly overlay: HTMLElement, private readonly deps: Deps) {
    this.section.setAttribute("aria-label", deps.words("strip.label"));
    this.section.append(this.head, this.rows, this.toastLine);
    this.top.append(this.section);
    const { signal } = this.listeners;
    // Outside a panel, a click closes it (a click on a row is that row's own toggle); Esc closes it, and ⌘1–3 open a card.
    document.addEventListener("pointerdown", (event) => {
      if (!this.openId) return;
      const target = event.target as Node | null;
      if (target && (this.panel?.contains(target) || this.section.contains(target))) return;
      this.close();
    }, { capture: true, signal });
    document.addEventListener("keydown", (event) => this.onKey(event), { capture: true, signal });
    this.draw();
  }

  dispose(): void {
    this.listeners.abort();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.panel?.remove();
    this.section.remove();
    document.body.classList.remove("pt-panel-open");
  }

  /** The chat drew `botId` with these pins (null: the program part has not said yet). */
  update(botId: string, data: BookView | null): void {
    if (botId !== this.botId) {
      // another chat: its own cards, nothing of the last chat's panel
      this.botId = botId;
      this.openId = null;
      this.sending.clear();
      this.lastThread.clear();
      this.toast = null;
      this.removePanel();
    }
    this.data = data && Array.isArray(data.pins) ? data : { v: 1, pins: [] };
    for (const [id, guard] of [...this.sending]) {
      const pin = this.pin(id);
      if (!pin || pin.thread.length > guard.turns || this.deps.now() - guard.at > SEND_WAIT_MS) this.sending.delete(id);
    }
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

  // ---- the strip ----

  private draw(): void {
    const { words } = this.deps;
    const pins = this.data.pins;
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
    this.rows.replaceChildren(...pins.map((pin, index) => this.row(pin, index)));
    const focusId = this.lastFocusId ?? active;
    this.lastFocusId = null;
    if (focusId) (Array.from(this.rows.children) as HTMLElement[]).find((row) => row.dataset.pin === focusId)?.focus({ preventScroll: true });
    this.drawToast();
    if (this.openId) this.drawPanel();
  }

  private row(pin: PinView, index: number): HTMLElement {
    const { words } = this.deps;
    const row = el("button", `pt-row pt-${pin.state}${this.openId === pin.id ? " on" : ""}`);
    row.type = "button";
    row.dataset.pin = pin.id;
    row.setAttribute("aria-expanded", String(this.openId === pin.id));
    row.setAttribute("aria-label", `${words("row.open", { title: pin.title })} · ${words(`state.${pin.state}`)} · ${pin.status}`);
    const first = el("span", "pt-l1");
    first.append(el("span", `pt-dot pt-dot-${pin.state}`));
    first.append(el("span", "pt-fd pt-title", pin.title));
    first.append(el("span", "pt-fd pt-short", pin.status));
    if (pin.unread && this.openId !== pin.id) {
      const unread = el("span", "pt-unread");
      unread.title = words("row.unread");
      first.append(unread);
    }
    first.append(el("span", "pt-fd pt-tag", words(tagKey(pin))));
    if (index < KEYS) first.append(el("span", "pt-fd pt-kc", `⌘${index + 1}`));
    const second = el("span", "pt-l2");
    second.append(this.bars(pin, "pt-bars-s"));
    second.append(el("span", "pt-l2-text", pin.status));
    row.append(first, second);
    row.addEventListener("click", () => (this.openId === pin.id ? this.close(true) : this.open(pin.id)));
    return row;
  }

  private bars(pin: PinView, className: string): HTMLElement {
    const box = el("span", `pt-bars ${className}`);
    const steps = barsOf(pin);
    if (!steps) return box;
    for (let i = 0; i < steps.total; i++) box.append(el("span", `pt-bar${i < steps.done ? ` on-${pin.state === "done" ? "done" : "run"}` : ""}`));
    return box;
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

  // ---- the panel ----

  open(id: string): void {
    if (!this.pin(id)) return;
    const was = this.openId;
    if (was && was !== id) this.leave(was);
    this.openId = id;
    this.updatesOpen = false;
    this.removePanel(true);
    this.draw();
    this.panelParts?.input.focus({ preventScroll: true });
    void this.deps.call("seen", { botId: this.botId, id }).catch(() => {});
  }

  /** Closes the panel; a done card the user opened and now closes is unpinned (with a 釘回). */
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

  private removePanel(instant = false): void {
    const panel = this.panel;
    this.panel = null;
    this.panelParts = null;
    document.body.classList.toggle("pt-panel-open", this.openId !== null);
    if (!panel) return;
    if (instant || this.deps.reduceMotion()) { panel.remove(); return; }
    panel.classList.add("x");
    panel.setAttribute("inert", "");
    setTimeout(() => panel.remove(), 140);
  }

  private drawPanel(): void {
    const pin = this.openId ? this.pin(this.openId) : undefined;
    if (!pin) return;
    const { words } = this.deps;
    if (!this.panel) this.buildPanel(pin);
    const parts = this.panelParts!;
    document.body.classList.add("pt-panel-open");
    this.panel!.setAttribute("aria-label", pin.title);
    parts.dot.className = `pt-dot pt-dot-${pin.state}`;
    parts.title.textContent = pin.title;
    parts.tag.textContent = words(tagKey(pin));
    parts.tag.className = `pt-ptag pt-ptag-${pin.source}`;
    parts.status.textContent = pin.status;
    parts.before.hidden = !pin.prev;
    parts.before.replaceChildren();
    if (pin.prev) { parts.before.append(document.createTextNode(words("panel.before")), el("s", "", pin.prev)); }
    parts.bars.replaceChildren();
    if (pin.step) {
      parts.bars.append(this.bars(pin, "pt-bars-l"));
      const left = pin.step.total - pin.step.done;
      parts.bars.append(el("span", "pt-left", left === 1 ? words("panel.leftOne") : words("panel.left", { n: left })));
    }
    parts.input.placeholder = words("panel.say", { title: pin.title });
    this.drawThread(pin, parts);
    this.drawUpdates(pin, parts);
  }

  private buildPanel(pin: PinView): void {
    const { words } = this.deps;
    const panel = el("section", "pt-panel");
    panel.setAttribute("role", "dialog");
    panel.dataset.pin = pin.id;
    const head = el("div", "pt-phead");
    const dot = el("span", "pt-dot");
    const title = el("b", "pt-ptitle");
    const tag = el("span", "pt-ptag");
    const unpin = el("button", "pt-ib");
    unpin.type = "button";
    unpin.title = words("panel.unpin");
    unpin.setAttribute("aria-label", words("panel.unpin"));
    unpin.append(icon([...PIN_PATH, "M4 4l16 16"], 16));
    unpin.addEventListener("click", () => this.unpin(pin.id));
    const close = el("button", "pt-ib");
    close.type = "button";
    close.title = "Esc";
    close.setAttribute("aria-label", words("panel.close"));
    close.append(icon(["M6 6l12 12M18 6L6 18"], 16));
    close.addEventListener("click", () => this.close(true));
    head.append(dot, title, tag, el("span", "pt-grow"), unpin, close);
    const status = el("span", "pt-pstatus");
    const before = el("span", "pt-pbefore");
    const bars = el("div", "pt-pbars");
    const summary = el("div", "pt-psummary");
    summary.append(status, before, bars);
    const thread = el("div", "pt-thread");
    thread.setAttribute("role", "log");
    const updates = el("div", "pt-updates");
    const form = el("form", "pt-form");
    const input = el("input", "pt-input");
    input.type = "text";
    input.autocomplete = "off";
    input.maxLength = 2000;
    const hint = el("span", "pt-hint");
    const send = el("button", "pt-send");
    send.type = "submit";
    send.setAttribute("aria-label", words("panel.send"));
    send.append(icon(["M5 12h14M13 6l6 6-6 6"], 18));
    form.append(input, send);
    form.addEventListener("submit", (event) => { event.preventDefault(); this.submit(input, hint); });
    panel.append(head, summary, thread, updates, hint, form);
    this.overlay.append(panel);
    this.panel = panel;
    this.panelParts = { title, tag, dot, status, before, bars, thread, updates, input, hint };
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
    toggle.append(icon([this.updatesOpen ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"]), document.createTextNode(words("panel.updates", { n: lines.length, last: lines[lines.length - 1]!.status })));
    toggle.addEventListener("click", () => { this.updatesOpen = !this.updatesOpen; this.drawUpdates(pin, parts); });
    parts.updates.append(toggle);
    if (this.updatesOpen) {
      const list = el("ul", "pt-updates-list");
      for (const line of lines) list.append(el("li", "", `${clock(line.at)} · ${line.status}`));
      parts.updates.append(list);
    }
  }

  /** The panel's own input: "@handle words" goes the way a message typed in the main box goes (beforeSend writes it into the thread). */
  private submit(input: HTMLInputElement, hint: HTMLElement): void {
    const pin = this.openId ? this.pin(this.openId) : undefined;
    const text = input.value.trim();
    if (!pin || !text) return;
    const guard = this.sending.get(pin.id);
    const now = this.deps.now();
    // a double tap, or the same words again at once: one send
    if (guard && now - guard.at < SEND_WAIT_MS) {
      hint.textContent = this.deps.words("panel.again");
      hint.hidden = false;
      setTimeout(() => { hint.textContent = ""; hint.hidden = true; }, 1_800);
      return;
    }
    this.sending.set(pin.id, { at: now, turns: pin.thread.length });
    input.value = "";
    hint.textContent = "";
    this.deps.send(`@${pin.handle} ${text}`);
  }

  // ---- keys ----

  private onKey(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && this.openId) {
      event.preventDefault();
      event.stopPropagation();
      this.close(true);
      return;
    }
    if (event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey && /^[1-9]$/.test(event.key)) {
      const pin = this.data.pins[Number(event.key) - 1];
      if (!pin || Number(event.key) > KEYS) return;
      event.preventDefault();
      event.stopPropagation();
      if (this.openId === pin.id) this.close(true); else this.open(pin.id);
    }
  }
}
