// Message decorations (chat extension v2): what plugins' web parts draw among the messages, from what
// their program parts chose (`chat.decorate`, which arrives as `ChatState.decorations`). The page owns
// the places and the folding; the plugin draws inside the element it is given:
// - `fold`: the element goes just before the first of those messages, and they are hidden (only hidden:
//   moving a row would reload its component frames) until the plugin reveals one;
// - `after`: the element goes just after that message, nothing hidden;
// - `under`: the element goes inside that message's own column, last, under its words (a message that has none gets one).
// Elements carry `decoration-extra`, so the message loop steps over them; a folded row carries
// `decoration-folded`. Nothing is drawn while you watch a subagent.
import { findMessageRow } from "./message-navigation";
import type { ChatState, DecorationView } from "./types";

type Dispose = () => void;

/** What a renderer may do on the chat around its decorations. */
export interface DecorationContext {
  /** The chat as drawn now (read only). */
  readonly state: ChatState;
  /** A message's drawn row (null: not drawn now). Never moves the chat: safe to call on every draw. */
  row(id: string): HTMLElement | null;
  /**
   * Like `row`, but a message outside the mounted window is mounted first (the chat moves to it).
   * Only for something the person asked for, such as opening a source: never on a draw or update.
   */
  find(id: string): HTMLElement | null;
  /** Draw every decoration again (after something only the plugin knows changed, such as a dialog closing). */
  redraw(): void;
  /** @deprecated Task cards were removed in 2.5; this does nothing. */
  openTask(id: string): void;
}

/** The same, for one decoration: what it folds can be shown again. */
export interface PlacedContext extends DecorationContext {
  /** Shows a message this decoration folds, in place: scrolls to it, flashes and focuses it. */
  reveal(id: string): void;
  revealed(id: string): boolean;
}

export interface DecorationRenderer {
  /** Draws one decoration into its element; called again on every update of the chat or of the decoration. */
  draw(root: HTMLElement, decoration: DecorationView, context: PlacedContext): void;
  /** The decoration went away; its element is already out of the page. */
  removed?(decoration: DecorationView): void;
  /** Once per update, after the decorations are drawn: for marks that are no one decoration's (a button under replies). */
  update?(context: DecorationContext): void;
}

interface Placed {
  plugin: string;
  element: HTMLElement;
  /** The column this element made for a message that had none (taken away again with it). */
  made?: HTMLElement;
  decoration: DecorationView;
  revealed: Set<string>;
  folded: Set<HTMLElement>;
}

/**
 * The column a message's words and what goes under them share (`.bot-column`, `.speaker-column`): a message with nothing under its words
 * has none, so one is made around its bubble (and given back when its decoration goes: `Placed.made`).
 */
function columnOf(row: HTMLElement, placed: Placed): HTMLElement {
  const column = row.querySelector<HTMLElement>(":scope > .bot-column, :scope > .speaker-column");
  if (column) return column;
  if (placed.made?.isConnected && row.contains(placed.made)) return placed.made;
  const bubble = row.querySelector<HTMLElement>(":scope > .bubble");
  const made = document.createElement("div");
  made.className = "bot-column";
  if (bubble) { bubble.replaceWith(made); made.append(bubble); } else row.append(made);
  placed.made = made;
  return made;
}

export class DecorationLayer {
  private readonly renderers = new Map<string, DecorationRenderer>();
  private readonly placed = new Map<string, Placed>();
  private last: { state: ChatState; row: (id: string) => HTMLElement | null } | null = null;
  private drawing = false;

  /** `guard` runs a plugin's code, reporting (and unloading) the plugin if it throws. */
  constructor(private readonly guard: <T>(plugin: string, run: () => T) => T | undefined = (_plugin, run) => run()) {}

  /** A plugin's renderer for its own decorations (one per plugin). */
  register(plugin: string, renderer: DecorationRenderer): Dispose {
    this.renderers.set(plugin, renderer);
    this.redraw();
    return () => {
      if (this.renderers.get(plugin) !== renderer) return;
      this.renderers.delete(plugin);
      for (const [id, placed] of this.placed) if (placed.plugin === plugin) this.remove(id, false);
    };
  }

  /** Puts every decoration of `state` in place; `row` finds a message's drawn row. */
  update(state: ChatState, row: (id: string) => HTMLElement | null): void {
    this.last = { state, row };
    if (this.drawing) return;
    this.drawing = true;
    try {
      const wanted = new Map<string, DecorationView>();
      for (const decoration of state.subagent ? [] : state.decorations ?? []) {
        if (this.renderers.has(decoration.plugin)) wanted.set(`${state.botID}\u0000${decoration.plugin}\u0000${decoration.key}`, decoration);
      }
      // Gone ones first: a line one folded may be folded by the next.
      for (const id of [...this.placed.keys()]) if (!wanted.has(id)) this.remove(id);
      for (const [id, decoration] of wanted) if (!this.place(id, decoration, state, row)) this.remove(id);
      const context = this.context(state, row);
      for (const [plugin, renderer] of [...this.renderers]) if (renderer.update) this.guard(plugin, () => renderer.update!(context));
    } finally {
      this.drawing = false;
    }
  }

  /** Draws again from the last state (a renderer asked, or one was registered). */
  redraw(): void {
    if (this.last) this.update(this.last.state, this.last.row);
  }

  /** The decoration whose element holds `element`, if any (a task's "Jump to chat" looks for it). */
  static holder(element: Element): HTMLElement | null {
    return element.closest<HTMLElement>(".decoration-extra");
  }

  private place(id: string, decoration: DecorationView, state: ChatState, row: (id: string) => HTMLElement | null): boolean {
    // The card goes before the first of its lines as they stand in the page, whatever order they are listed in.
    const rows = decoration.fold?.length ? decoration.fold.map(row).filter((found): found is HTMLElement => !!found)
      .sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)) : [];
    const anchor = !decoration.fold?.length && decoration.after ? row(decoration.after) : null;
    const under = !rows.length && !anchor && decoration.under ? row(decoration.under) : null;
    if (!rows.length && !anchor && !under) return false;
    let placed = this.placed.get(id);
    if (!placed) {
      const element = document.createElement("div");
      element.className = "decoration-extra";
      element.dataset.plugin = decoration.plugin;
      element.dataset.key = decoration.key;
      placed = { plugin: decoration.plugin, element, decoration, revealed: new Set(), folded: new Set() };
      this.placed.set(id, placed);
    }
    placed.decoration = decoration;
    const now = new Set(rows);
    for (const folded of placed.folded) if (!now.has(folded)) folded.classList.remove("decoration-folded");
    for (const id of decoration.fold ?? []) row(id)?.classList.toggle("decoration-folded", !placed.revealed.has(id));
    placed.folded = now;
    const { element } = placed;
    if (rows.length) { if (rows[0].previousElementSibling !== element) rows[0].before(element); }
    else if (anchor) { if (anchor.nextElementSibling !== element) anchor.after(element); }
    else {
      const column = columnOf(under!, placed);
      if (column.lastElementChild !== element) column.append(element);
    }
    const renderer = this.renderers.get(decoration.plugin)!;
    const context: PlacedContext = {
      ...this.context(state, row),
      reveal: (message) => this.reveal(id, message),
      revealed: (message) => this.placed.get(id)?.revealed.has(message) ?? false,
    };
    this.guard(decoration.plugin, () => renderer.draw(element, decoration, context));
    return true;
  }

  private remove(id: string, tell = true): void {
    const placed = this.placed.get(id);
    if (!placed) return;
    this.placed.delete(id);
    for (const row of placed.folded) row.classList.remove("decoration-folded");
    placed.element.remove();
    // A column made for it goes (the words stay where they were): the message looks as it did before.
    if (placed.made?.isConnected && placed.made.children.length === 1) placed.made.replaceWith(placed.made.firstElementChild!);
    const renderer = this.renderers.get(placed.plugin);
    if (tell && renderer?.removed) this.guard(placed.plugin, () => renderer.removed!(placed.decoration));
  }

  private context(state: ChatState, row: (id: string) => HTMLElement | null): DecorationContext {
    return {
      state,
      // Draws run on every update of the chat: asking for an unmounted row there would mount the
      // window around it each time and pull the chat away from where it is read.
      row: (id) => row(id),
      find: (id) => row(id) ?? findMessageRow(id),
      redraw: () => queueMicrotask(() => this.redraw()),
      openTask: () => {},
    };
  }

  /** A folded message shown in place: the decoration keeps it shown until it goes away. */
  private reveal(id: string, message: string): void {
    const placed = this.placed.get(id);
    if (!placed?.decoration.fold?.includes(message)) return;
    placed.revealed.add(message);
    const row = this.last?.row(message) ?? findMessageRow(message);
    // (A person clicked to show it: mounting the window around it is wanted here.)
    this.redraw();
    if (!row) return;
    row.classList.remove("decoration-folded");
    row.classList.add("source-live-flash");
    row.scrollIntoView?.({ block: "center" });
    const focus = row.querySelector<HTMLElement>("button:not([disabled]),iframe,input,textarea") ?? row;
    if (!focus.hasAttribute("tabindex")) focus.setAttribute("tabindex", "-1");
    focus.focus({ preventScroll: true });
    setTimeout(() => row.classList.remove("source-live-flash"), 2000);
  }
}
