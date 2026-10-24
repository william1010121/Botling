import { post } from "./bridge";
import { t } from "./i18n";
import type { CatchUpView, ChatState, MessageView } from "./types";
import { sourceLinks, clickableSourceURL, type SourceLink } from "./catchup-links";
import { summaryMessages, summaryReferences } from "./summary-sources";
import { summaryViewer, sourceAuthor, sourceHead, summaryBy } from "./summary-viewer";
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
  private readonly revealed = new Set<string>();
  private state: ChatState | null = null;
  private element: (id: string) => HTMLElement | null = () => null;
  private tooltip: HTMLElement | null = null;
  private owner = "";
  private folded = new Set<HTMLElement>();
  private drawnKey = "";
  private view: CatchUpView | null = null;
  private botID = "";

  constructor(private readonly interval = false) {
    this.head = document.createElement("div");
    this.head.className = "catchup-extra catchup-head";
    this.end = document.createElement("div");
    this.end.className = "catchup-extra catchup-end";
    for (const element of [this.head, this.end]) {
      element.addEventListener("click", (event) => this.clicked(event));
      element.addEventListener("pointerover",event=>this.preview(event));
      element.addEventListener("focusin",event=>this.preview(event));
      element.addEventListener("pointerout",()=>this.tooltip?.remove());
      element.addEventListener("focusout",()=>this.tooltip?.remove());
    }
  }

  /** Places the group for `state`; `element` finds a message's drawn row. */
  update(state: ChatState, element: (id: string) => HTMLElement | null): void {
    this.botID = state.botID;
    this.state = state;
    this.element = element;
    let view = state.subagent ? null : state.catchUp ?? null;
    const rows = view ? view.ids.map(element).filter((row): row is HTMLElement => !!row) : [];
    if (!view || rows.length === 0) {
      this.clear();
      return;
    }
    const owner = `${state.botID}:${view.key}`;
    if(this.owner && this.owner!==owner){summaryViewer.close(this.owner);this.revealed.clear();}
    this.owner=owner;
    const open = summaryViewer.isOpen(this.owner);
    const source = summaryMessages(view,state.messages);
    // Interval payloads carry reply counts but omit the unread group's display metadata.
    if (this.interval) {
      const latest = source.filter(message => message.role === "bot").at(-1);
      view = { ...view, since: view.since ?? source[0]?.sourceTime, until: view.until ?? source.at(-1)?.sourceTime,
        latest: view.latest ?? (latest ? `${sourceAuthor(latest)}: ${latest.text.replace(/\s+/g, " ").slice(0, 160)}` : null) };
    }
    this.view = view;
    summaryViewer.sync(this.owner,state,view);
    const avatars = [...new Set(state.messages.filter((m) => view.ids.includes(m.id) && m.avatar).map((m) => m.avatar!))].slice(0, 3);
    const links = sourceLinks(state.messages.filter((m) => view.ids.includes(m.id)));
    const drawKey = JSON.stringify([view, open, avatars, links, source, state.lang, state.avatar]);
    if (drawKey !== this.drawnKey) {
      const focused = this.head.contains(document.activeElement) || this.end.contains(document.activeElement)
        ? (document.activeElement as HTMLElement).dataset.action : undefined;
      this.drawnKey = drawKey;
      this.head.innerHTML = headHTML(view, open, avatars, links, source, this.interval);
      this.end.innerHTML = endHTML(view.manual);
      if (focused) (this.head.querySelector<HTMLElement>(`[data-action="${focused}"]`) ?? this.end.querySelector<HTMLElement>(`[data-action="${focused}"]`))?.focus({ preventScroll: true });
    }
    this.head.classList.toggle("open", open);
    this.head.classList.toggle("interval-summary-head", this.interval);

    const now = new Set(rows);
    for (const row of this.folded) if (!now.has(row)) row.classList.remove("catchup-folded");
    for (const id of view.ids) element(id)?.classList.toggle("catchup-folded", !this.revealed.has(id));
    this.folded = now;

    const first = rows[0], last = rows[rows.length - 1];
    if (first.previousElementSibling !== this.head) first.before(this.head);
    this.end.remove();
  }

  clear(): void {
    for (const row of this.folded) row.classList.remove("catchup-folded");
    this.folded.clear();
    this.revealed.clear();
    if(this.owner) summaryViewer.close(this.owner);
    this.owner="";
    this.tooltip?.remove();
    this.head.remove();
    this.end.remove();
    this.view = null;
    this.drawnKey = "";
  }

  private clicked(event: Event): void {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!button || !this.view) return;
    if (button.dataset.action === "retry") {
      post({ type: "catchUpRetry", botID: this.botID, ...(this.interval ? { key: this.view.key } : {}) });
      return;
    }
    const point = button.dataset.citePoint == null ? -1 : Number(button.dataset.citePoint);
    const index = Number(button.dataset.citeIndex ?? 0);
    if (!this.state) return;
    this.tooltip?.remove();
    summaryViewer.open(this.owner,this.state,this.view,this.element,id=>this.revealSource(id),point,index);
    onToggle?.();
    summaryViewer.setRestoreTarget(()=>this.head.querySelector<HTMLElement>(point<0?'[data-action="toggle"]':`[data-cite-point="${point}"][data-cite-index="${index}"]`));
  }

  private preview(event: Event): void {
    const chip=(event.target as HTMLElement).closest<HTMLElement>("[data-cite-point]");
    if(!chip || !this.view || !this.state)return;
    this.tooltip?.remove();
    const reference=summaryReferences(this.view,this.state.messages)[Number(chip.dataset.citePoint)]?.sources[Number(chip.dataset.citeIndex)];
    const source=this.state.messages.find(m=>m.id===reference?.messageID);if(!source || !reference)return;
    const tooltip=document.createElement("div");tooltip.className="source-hover";tooltip.setAttribute("role","tooltip");
    tooltip.innerHTML=`<strong>${escapeHTML(sourceAuthor(source,reference))}</strong> <span>${escapeHTML(reference.part==="answer"?"":source.sourceTime??source.time??"")}</span><div>${escapeHTML((reference.quote??source.text).slice(0,200))}</div><small>${escapeHTML(t("source.openCitation"))}</small>`;
    document.body.append(tooltip);this.tooltip=tooltip;
    const rect=chip.getBoundingClientRect();tooltip.style.left=`${Math.max(8,Math.min(rect.left,innerWidth-Math.min(340,innerWidth-16)-8))}px`;tooltip.style.top=`${Math.max(8,Math.min(rect.bottom+8,innerHeight-tooltip.offsetHeight-8))}px`;
  }

  private revealSource(id: string): void {
    if (!this.view?.ids.includes(id)) return;
    this.revealed.add(id);
    onToggle?.();
    const row=this.element(id);if(!row)return;
    row.classList.remove("catchup-folded");row.classList.add("source-live-flash");
    row.scrollIntoView?.({block:"center"});
    const focus=row.querySelector<HTMLElement>('button:not([disabled]),iframe,input,textarea')??row;
    if(!focus.hasAttribute("tabindex"))focus.setAttribute("tabindex","-1");focus.focus({preventScroll:true});
    setTimeout(()=>row.classList.remove("source-live-flash"),2000);
  }
}

/** Draws again after a toggle (the chat sets it). */
let onToggle: (() => void) | null = null;
export function onCatchUpToggle(redraw: () => void): void {
  onToggle = redraw;
  summaryViewer.onClose = redraw;
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

function headHTML(view: CatchUpView, open: boolean, avatars: string[], links: SourceLink[], source: MessageView[], interval = false): string {
  const n = interval || view.manual ? view.ids.length : view.count;
  const divider = view.manual ? t("catchup.manualRange", { n }) : view.since ? t("catchup.divider", { n, since: view.since }) : t("catchup.dividerNoTime", { n });
  const heads = interval ? Object.entries(view.speakerCounts ?? {}).filter(([head, count]) => head !== "unknown" && count > 0).length || view.heads : view.heads;
  const meta = [t(interval ? "interval.replies" : view.manual ? "catchup.messages" : "catchup.count", { n: interval ? view.count : n }), heads ? t("catchup.heads", { n: heads }) : null].filter(Boolean).join(" · ");
  const range = view.since && view.until ? (view.since === view.until ? view.since : `${view.since} – ${view.until}`) : "";
  let body = "";
  if (view.state === "ready") {
    body = `<ul class="catchup-bullets">${bulletsHTML(view, source)}</ul>`;
  } else if (view.state === "loading") {
    body = `<div class="catchup-loading" role="status"><div class="catchup-writing"><span class="catchup-spinner" aria-hidden="true"></span><span>${escapeHTML(t("catchup.writing", { model: view.model }))}</span></div>`
      + `<div class="catchup-skeleton" aria-hidden="true"><div style="width:92%"></div><div style="width:74%"></div><div style="width:84%"></div><div style="width:58%"></div></div></div>`;
  } else {
    body = `<div class="catchup-error" role="alert"><div class="catchup-error-title">${escapeHTML(t("catchup.failed"))}</div>`
      + `<div class="catchup-error-detail">${escapeHTML([view.error, t("catchup.nothingLost", { n })].filter(Boolean).join(" "))}</div></div>`;
  }
  const footer = view.latest ? t("catchup.latest", { line: view.latest }) : "";
  const faces = avatars.map((src) => `<img src="${escapeHTML(src)}" alt="">`).join("");
  return (interval ? "" : `<div class="catchup-divider"><div class="line"></div><div>${escapeHTML(divider)}</div><div class="line"></div></div>`)
    + `<section class="catchup-card stacked" aria-label="${escapeHTML(t("catchup.label"))}">`
    + `<div class="catchup-card-body">`
    + `<div class="catchup-top">${view.state === "failed" ? alert : sparkle}<span class="catchup-title">${escapeHTML(t(interval || !view.manual ? "catchup.title" : "catchup.manualTitle"))}</span><span class="catchup-meta">${escapeHTML(meta)}</span><span class="catchup-space"></span><span class="catchup-range">${escapeHTML(range)}</span></div>`
    + body
    + linksHTML(links)
    + `<div class="catchup-foot"><div class="catchup-faces" aria-hidden="true">${faces}</div><div class="catchup-latest">${escapeHTML(footer)}</div>`
    + (view.state === "failed" ? `<button type="button" class="catchup-button outline" data-action="retry">${retry}${escapeHTML(t("catchup.retry"))}</button>` : "")
    + `<button type="button" class="catchup-button" data-action="toggle" aria-expanded="${open}" aria-haspopup="dialog">${escapeHTML(t("catchup.show", { n }))}↗</button></div>`
    + (view.state === "ready" ? `<div class="catchup-by">${escapeHTML(summaryBy(view))}</div>` : "")
    + `</div></section>`;
}

function endHTML(manual = false): string {
  return `<div class="line"></div>${check}<span>${escapeHTML(t(manual ? "catchup.rangeEnd" : "catchup.end"))}</span>`
    + `<button type="button" class="catchup-button outline small" data-action="collapse">${escapeHTML(t("catchup.collapse"))}${up}</button><div class="line"></div>`;
}

function linksHTML(links: SourceLink[]): string {
  return links.length ? `<div class="catchup-links"><strong>${escapeHTML(t("catchup.links"))}</strong><ul>${links.map(({ url, labels }) => {
      const label = labels.length ? labels.join(" · ") : url;
      return `<li>${clickableSourceURL(url) ? `<a class="chip" href="#" data-url="${escapeHTML(url)}" data-label="${escapeHTML(label)}" title="${escapeHTML(url)}">${escapeHTML(label)}</a>` : `<span>${escapeHTML(label)} — ${escapeHTML(url)}</span>`}</li>`;
    }).join("")}</ul></div>` : "";
}

const lines = `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h9"/></svg>`;

/** One independent group per range. Never routes an older chip to the latest range. */
export class IntervalSummaries {
  private groups = new Map<string, CatchUpGroup>();
  private triggers = new Map<string, HTMLButtonElement>();
  private unread = new CatchUpGroup();

  update(state: ChatState, element: (id: string) => HTMLElement | null): void {
    const views = state.subagent ? [] : state.intervalSummaries ?? [];
    const active = new Set(views.map(v => `${state.botID}:${v.key}`));
    for (const [key, group] of this.groups) if (!active.has(key)) { group.clear(); this.groups.delete(key); }
    // Unread automation keeps its own state. Avoid overlapping DOM folding owners.
    const covered = new Set(views.flatMap(v => v.ids));
    this.unread.update({ ...state, catchUp: state.catchUp?.ids.some(id => covered.has(id)) ? null : state.catchUp }, element);
    for (const view of views) {
      const key = `${state.botID}:${view.key}`;
      let group = this.groups.get(key);
      if (!group) { group = new CatchUpGroup(true); this.groups.set(key, group); }
      group.update({ ...state, catchUp: view }, element);
    }
    const retained = new Set<string>();
    if (!state.subagent) for (let i = 0; i < state.messages.length; i++) {
      const user = state.messages[i];
      if (user.role !== "user") continue;
      let end = i + 1;
      while (end < state.messages.length && state.messages[end].role !== "user") end++;
      const replies = state.messages.slice(i + 1, end).filter(m => m.role === "bot");
      const last = replies.at(-1);
      if (!last || covered.has(last.id)) continue;
      const row = element(last.id);
      if (!row) continue;
      let footer = row.querySelector<HTMLElement>(".message-footer");
      if (!footer) {
        let holder = row.querySelector<HTMLElement>(".speaker-column, .bot-column, .reaction-message-column");
        if (!holder) {
          const bubble = row.querySelector<HTMLElement>(".bot-bubble");
          if (!bubble) continue;
          holder = document.createElement("div");
          holder.className = "reaction-message-column";
          bubble.replaceWith(holder);
          holder.append(bubble);
        }
        footer = document.createElement("div");
        footer.className = "message-footer";
        holder.append(footer);
      }
      const key = `${state.botID}:${user.id}`;
      retained.add(key);
      let trigger = this.triggers.get(key);
      if (!trigger) {
        trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "interval-summary-trigger";
        trigger.addEventListener("click", () => post({ type: "catchUpManual", botID: state.botID, userMessageID: user.id }));
        this.triggers.set(key, trigger);
      }
      trigger.innerHTML = lines + escapeHTML(t("interval.summarize", { n: replies.length }));
      if (trigger.parentElement !== footer) footer.append(trigger);
      i = end - 1;
    }
    for (const [key, trigger] of this.triggers) if (!retained.has(key)) {
      const footer = trigger.parentElement;
      trigger.remove();
      if (footer?.childElementCount === 0) footer.remove();
      this.triggers.delete(key);
    }
  }
}

function bulletsHTML(view: CatchUpView, source: MessageView[]): string {
  return summaryReferences(view,source).map((bullet,point)=>{
    const chips=bullet.sources.map((reference,index)=>{
      const message=source.find(m=>m.id===reference.messageID)!;
      return `<button type="button" class="source-cite ${sourceHead(message,reference)}" data-action="source" data-cite-point="${point}" data-cite-index="${index}" aria-haspopup="dialog" aria-label="${escapeHTML(t("source.openFrom",{author:sourceAuthor(message,reference),n:point+1}))}"><span class="source-head-dot" aria-hidden="true"></span>${escapeHTML(sourceAuthor(message,reference))}</button>`;
    }).join("");
    return bulletHTML(bullet.text).replace(/<\/span><\/li>$/,chips+"</span></li>");
  }).join("");
}
