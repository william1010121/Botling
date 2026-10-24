import { post } from "./bridge";
import { t } from "./i18n";
import type { CatchUpView, ChatState } from "./types";
import { escapeHTML } from "./util";

/**
 * Catch-up summary: the unread messages you came back to, folded into one group with a short
 * summary on top. The messages stay where they are in the list (moving one would reload its
 * component frames): folded ones are only hidden, and the card goes just before the first.
 * Elements it adds carry `catchup-extra`, so the message loop steps over them.
 */
export class CatchUpGroup {
  /** The unread divider and the summary card, before the first folded message. */
  readonly head: HTMLElement;
  /** "End of unread", after the last one, while expanded. */
  readonly end: HTMLElement;
  /** Ranges you expanded, by `CatchUpView.key`. */
  private readonly expanded = new Set<string>();
  private folded = new Set<HTMLElement>();
  private drawnKey = "";
  private view: CatchUpView | null = null;
  private botID = "";

  constructor() {
    this.head = document.createElement("div");
    this.head.className = "catchup-extra catchup-head";
    this.end = document.createElement("div");
    this.end.className = "catchup-extra catchup-end";
    for (const element of [this.head, this.end]) {
      element.addEventListener("click", (event) => this.clicked(event));
    }
  }

  /** Places the group for `state`; `element` finds a message's drawn row. */
  update(state: ChatState, element: (id: string) => HTMLElement | null): void {
    const view = state.subagent ? null : state.catchUp ?? null;
    const rows = view ? view.ids.map(element).filter((row): row is HTMLElement => !!row) : [];
    if (!view || rows.length === 0) {
      this.clear();
      return;
    }
    this.view = view;
    this.botID = state.botID;
    const open = this.expanded.has(view.key);
    const avatars = [...new Set(state.messages.filter((m) => view.ids.includes(m.id) && m.avatar).map((m) => m.avatar!))].slice(0, 3);
    const drawKey = JSON.stringify([view, open, avatars, state.lang]);
    if (drawKey !== this.drawnKey) {
      const focused = this.head.contains(document.activeElement) || this.end.contains(document.activeElement)
        ? (document.activeElement as HTMLElement).dataset.action : undefined;
      this.drawnKey = drawKey;
      this.head.innerHTML = headHTML(view, open, avatars);
      this.end.innerHTML = endHTML();
      if (focused) (this.head.querySelector<HTMLElement>(`[data-action="${focused}"]`) ?? this.end.querySelector<HTMLElement>(`[data-action="${focused}"]`))?.focus({ preventScroll: true });
    }
    this.head.classList.toggle("open", open);

    const now = new Set(rows);
    for (const row of this.folded) if (!now.has(row)) row.classList.remove("catchup-folded");
    for (const row of rows) row.classList.toggle("catchup-folded", !open);
    this.folded = now;

    const first = rows[0], last = rows[rows.length - 1];
    if (first.previousElementSibling !== this.head) first.before(this.head);
    if (open) {
      if (last.nextElementSibling !== this.end) last.after(this.end);
    } else {
      this.end.remove();
    }
  }

  private clear(): void {
    for (const row of this.folded) row.classList.remove("catchup-folded");
    this.folded.clear();
    this.head.remove();
    this.end.remove();
    this.view = null;
    this.drawnKey = "";
  }

  private clicked(event: Event): void {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!button || !this.view) return;
    if (button.dataset.action === "retry") {
      post({ type: "catchUpRetry", botID: this.botID });
      return;
    }
    const key = this.view.key;
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    onToggle?.();
    // Collapsing from the end row: the card is where you are.
    if (button.dataset.action === "collapse") {
      this.head.querySelector<HTMLElement>('[data-action="toggle"]')?.focus({ preventScroll: true });
      this.head.scrollIntoView?.({ block: "nearest" });
    }
  }
}

/** Draws again after a toggle (the chat sets it). */
let onToggle: (() => void) | null = null;
export function onCatchUpToggle(redraw: () => void): void {
  onToggle = redraw;
}

const sparkle = `<svg class="catchup-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></svg>`;
const alert = `<svg class="catchup-icon error" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/></svg>`;
const down = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;
const up = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>`;
const retry = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>`;
const check = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;

/** A bullet as HTML: `code` spans and commit/agent ids in code, a decision ("!! …") marked. */
export function bulletHTML(bullet: string): string {
  const decision = bullet.startsWith("!!");
  const text = decision ? bullet.replace(/^!!\s*/, "") : bullet;
  const body = escapeHTML(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/(^|[\s(（，,:：])([0-9a-f]{7,40})(?=$|[\s)）。，,.;；:：])/g, (match, before: string, id: string) =>
      /\d/.test(id) && /[a-f]/.test(id) ? `${before}<code>${id}</code>` : match);
  return decision
    ? `<li class="decision"><span class="dot" aria-hidden="true"></span><span><strong>${escapeHTML(t("catchup.decide"))}</strong>${body}</span></li>`
    : `<li><span class="dot" aria-hidden="true"></span><span>${body}</span></li>`;
}

function headHTML(view: CatchUpView, open: boolean, avatars: string[]): string {
  const n = view.count;
  const divider = view.since ? t("catchup.divider", { n, since: view.since }) : t("catchup.dividerNoTime", { n });
  const meta = [t("catchup.count", { n }), view.heads ? t("catchup.heads", { n: view.heads }) : null].filter(Boolean).join(" · ");
  const range = view.since && view.until ? (view.since === view.until ? view.since : `${view.since} – ${view.until}`) : "";
  let body = "";
  if (view.state === "ready") {
    body = `<ul class="catchup-bullets">${view.bullets.map(bulletHTML).join("")}</ul>`;
  } else if (view.state === "loading") {
    body = `<div class="catchup-loading" role="status"><div class="catchup-writing"><span class="catchup-spinner" aria-hidden="true"></span><span>${escapeHTML(t("catchup.writing", { model: view.model }))}</span></div>`
      + `<div class="catchup-skeleton" aria-hidden="true"><div style="width:92%"></div><div style="width:74%"></div><div style="width:84%"></div><div style="width:58%"></div></div></div>`;
  } else {
    body = `<div class="catchup-error" role="alert"><div class="catchup-error-title">${escapeHTML(t("catchup.failed"))}</div>`
      + `<div class="catchup-error-detail">${escapeHTML([view.error, t("catchup.nothingLost", { n })].filter(Boolean).join(" "))}</div></div>`;
  }
  const footer = open ? t("catchup.showing", { n }) : view.latest ? t("catchup.latest", { line: view.latest }) : "";
  const faces = avatars.map((src) => `<img src="${escapeHTML(src)}" alt="">`).join("");
  return `<div class="catchup-divider"><div class="line"></div><div>${escapeHTML(divider)}</div><div class="line"></div></div>`
    + `<section class="catchup-card${open ? "" : " stacked"}" aria-label="${escapeHTML(t("catchup.label"))}">`
    + `<div class="catchup-card-body">`
    + `<div class="catchup-top">${view.state === "failed" ? alert : sparkle}<span class="catchup-title">${escapeHTML(t("catchup.title"))}</span><span class="catchup-meta">${escapeHTML(meta)}</span><span class="catchup-space"></span><span class="catchup-range">${escapeHTML(range)}</span></div>`
    + body
    + `<div class="catchup-foot"><div class="catchup-faces" aria-hidden="true">${faces}</div><div class="catchup-latest">${escapeHTML(footer)}</div>`
    + (view.state === "failed" ? `<button type="button" class="catchup-button outline" data-action="retry">${retry}${escapeHTML(t("catchup.retry"))}</button>` : "")
    + `<button type="button" class="catchup-button" data-action="toggle" aria-expanded="${open}">${escapeHTML(open ? t("catchup.hide") : t("catchup.show", { n }))}${open ? up : down}</button></div>`
    + (view.state === "ready" ? `<div class="catchup-by">${escapeHTML(t("catchup.by", { model: view.model }))}</div>` : "")
    + `</div></section>`;
}

function endHTML(): string {
  return `<div class="line"></div>${check}<span>${escapeHTML(t("catchup.end"))}</span>`
    + `<button type="button" class="catchup-button outline small" data-action="collapse">${escapeHTML(t("catchup.collapse"))}${up}</button><div class="line"></div>`;
}
