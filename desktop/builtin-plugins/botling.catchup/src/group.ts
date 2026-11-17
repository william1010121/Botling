// Catch-up in the chat (botling.catchup's web part): a message decoration its program part chose (catchup.ts),
// folding the lines that are not among the few that matter behind a small header. The page places the header
// and folds the lines (Web/src/decorations.ts); this draws the header and opens the folded lines (viewer.ts).
// No summary is drawn: the messages that matter are ordinary, live messages of the chat.
import type { DecorationRenderer, PlacedContext } from "../../../../Web/src/decorations";
import type { ChatState } from "../../../../Web/src/types";
import { escapeHTML } from "../../../../Web/src/util";
import { viewOf, type CatchUpView } from "./types";
import { summaryViewer } from "./viewer";
import { t } from "./words";

/** The header, drawn into the element the page placed before the first line it folds. "Show N messages" opens the originals. */
export class CatchUpGroup {
  private state: ChatState | null = null;
  private context: PlacedContext | null = null;
  private owner = "";
  private drawnKey = "";
  private view: CatchUpView | null = null;

  constructor(readonly head: HTMLElement) {
    head.classList.add("catchup-head");
    head.addEventListener("click", (event) => this.clicked(event));
  }

  /** Draws the header for `view` as the chat stands in `context`. */
  update(view: CatchUpView, context: PlacedContext): void {
    const state = context.state;
    this.state = state;
    this.context = context;
    const owner = `${state.botID}:${view.key}`;
    if (this.owner && this.owner !== owner) summaryViewer.close(this.owner);
    this.owner = owner;
    const open = summaryViewer.isOpen(this.owner);
    this.view = view;
    summaryViewer.sync(this.owner, state, view);
    const drawKey = JSON.stringify([view, open, state.lang]);
    if (drawKey !== this.drawnKey) {
      const focused = this.head.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.action : undefined;
      this.drawnKey = drawKey;
      this.head.innerHTML = headHTML(view, open);
      if (focused) this.head.querySelector<HTMLElement>(`[data-action="${focused}"]`)?.focus({ preventScroll: true });
    }
    this.head.classList.toggle("open", open);
  }

  /** The fold went away. */
  clear(): void {
    if (this.owner) summaryViewer.close(this.owner);
    this.owner = "";
    this.view = null;
    this.drawnKey = "";
  }

  private clicked(event: Event): void {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!button || button.dataset.action !== "toggle" || !this.view || !this.context || !this.state) return;
    const context = this.context;
    summaryViewer.onClose = () => context.redraw();
    summaryViewer.open(this.owner, this.state, this.view, (id) => context.find(id), (id) => context.reveal(id));
    context.redraw();
    summaryViewer.setRestoreTarget(() => this.head.querySelector<HTMLElement>('[data-action="toggle"]'));
  }
}

/** The renderer the web part registers: a header per fold, kept by its element. */
export function catchUpRenderer(): DecorationRenderer {
  const groups = new Map<HTMLElement, CatchUpGroup>();
  return {
    draw(root, decoration, context) {
      const view = viewOf(decoration);
      let group = groups.get(root);
      if (!group) { group = new CatchUpGroup(root); groups.set(root, group); }
      group.update(view, context);
    },
    removed(decoration) {
      for (const [root, group] of groups) if (root.dataset.key === decoration.key && !root.isConnected) { group.clear(); groups.delete(root); }
    },
  };
}

const sparkle = `<svg class="catchup-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></svg>`;

/** "While you were away · 3 important" and the button that opens the folded messages. */
function headHTML(view: CatchUpView, open: boolean): string {
  const title = view.important > 0 ? t("catchup.away", { n: view.important }) : t("catchup.awayNone");
  return `<section class="catchup-card" aria-label="${escapeHTML(t("catchup.label"))}">`
    + `<div class="catchup-top">${sparkle}<span class="catchup-title">${escapeHTML(title)}</span><span class="catchup-space"></span>`
    + `<button type="button" class="catchup-button" data-action="toggle" aria-expanded="${open}" aria-haspopup="dialog">${escapeHTML(t("catchup.show", { n: view.ids.length }))}↗</button></div>`
    + `</section>`;
}
