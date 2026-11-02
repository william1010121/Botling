// Catch-up and interval summaries in the chat (botling.catchup's web part): each is a message decoration
// its program part chose (catchup.ts), folding the lines it summarizes behind a card with a short summary
// on top. The page places the card and folds the lines (Web/src/decorations.ts); this draws the card,
// opens its sources (viewer.ts) and asks the program part to retry a failed one. Under the last reply of
// each stretch between your messages it also puts "Summarize N replies" (hidden by the desktop's CSS).
import type { DecorationRenderer, DecorationContext, PlacedContext } from "../../../../Web/src/decorations";
import type { ChatState, MessageView } from "../../../../Web/src/types";
import { escapeHTML } from "../../../../Web/src/util";
import { sourceLinks, clickableSourceURL, type SourceLink } from "./links";
import { page } from "./page";
import { summaryMessages, summaryReferences } from "./sources";
import { viewOf, type CatchUpView } from "./types";
import { summaryViewer, sourceAuthor, sourceHead, summaryBy } from "./viewer";
import { t } from "./words";

/** The replies a summary counts: bot replies and app notices (contract/summary.ts `isSummaryReply`). */
export const summaryCountable = (message: Pick<MessageView, "role">): boolean => message.role === "bot" || message.role === "notice";

/**
 * One summary's card, drawn into the element the page placed before the first line it folds (that
 * element is the old `catchup-head`). "Show N messages" and the source chips open the originals.
 */
export class CatchUpGroup {
  private state: ChatState | null = null;
  private context: PlacedContext | null = null;
  private tooltip: HTMLElement | null = null;
  private owner = "";
  private drawnKey = "";
  private view: CatchUpView | null = null;
  private botID = "";

  constructor(readonly head: HTMLElement, private readonly interval = false) {
    head.classList.add("catchup-head");
    head.addEventListener("click", (event) => this.clicked(event));
    head.addEventListener("pointerover",event=>this.preview(event));
    head.addEventListener("focusin",event=>this.preview(event));
    head.addEventListener("pointerout",()=>this.tooltip?.remove());
    head.addEventListener("focusout",()=>this.tooltip?.remove());
  }

  /** Draws the card for `view` as the chat stands in `context`. */
  update(view: CatchUpView, context: PlacedContext): void {
    const state = context.state;
    this.botID = state.botID;
    this.state = state;
    this.context = context;
    const owner = `${state.botID}:${view.key}`;
    if(this.owner && this.owner!==owner)summaryViewer.close(this.owner);
    this.owner=owner;
    const open = summaryViewer.isOpen(this.owner);
    const source = summaryMessages(view,state.messages);
    // Interval payloads carry reply counts but omit the unread group's display metadata.
    if (this.interval) {
      const latest = source.filter(summaryCountable).at(-1);
      view = { ...view, since: view.since ?? source[0]?.sourceTime, until: view.until ?? source.at(-1)?.sourceTime,
        latest: view.latest ?? (latest ? `${sourceAuthor(latest)}: ${latest.text.replace(/\s+/g, " ").slice(0, 160)}` : null) };
    }
    this.view = view;
    summaryViewer.sync(this.owner,state,view);
    const avatars = [...new Set(state.messages.filter((m) => view.ids.includes(m.id) && m.avatar).map((m) => m.avatar!))].slice(0, 3);
    const links = sourceLinks(state.messages.filter((m) => view.ids.includes(m.id)));
    const drawKey = JSON.stringify([view, open, avatars, links, source, state.lang, state.avatar]);
    if (drawKey !== this.drawnKey) {
      const focused = this.head.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.action : undefined;
      this.drawnKey = drawKey;
      this.head.innerHTML = headHTML(view, open, avatars, links, source, this.interval);
      if (focused) this.head.querySelector<HTMLElement>(`[data-action="${focused}"]`)?.focus({ preventScroll: true });
    }
    this.head.classList.toggle("open", open);
    this.head.classList.toggle("interval-summary-head", this.interval);
  }

  /** The summary went away. */
  clear(): void {
    if(this.owner) summaryViewer.close(this.owner);
    this.owner="";
    this.tooltip?.remove();
    this.view = null;
    this.drawnKey = "";
  }

  private clicked(event: Event): void {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!button || !this.view || !this.context) return;
    if (button.dataset.action === "task") {
      if (button.dataset.taskId) this.context.openTask(button.dataset.taskId);
      return;
    }
    if (button.dataset.action === "retry") {
      void page.call("retry", { botId: this.botID, ...(this.interval ? { key: this.view.key } : {}) }).catch(() => {});
      return;
    }
    const point = button.dataset.citePoint == null ? -1 : Number(button.dataset.citePoint);
    const index = Number(button.dataset.citeIndex ?? 0);
    if (!this.state) return;
    this.tooltip?.remove();
    const context = this.context;
    summaryViewer.onClose = () => context.redraw();
    summaryViewer.open(this.owner,this.state,this.view,(id)=>context.find(id),id=>context.reveal(id),point,index);
    context.redraw();
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
}

/**
 * The renderer the web part registers: a card per summary, kept by its element, and the "Summarize N
 * replies" buttons under each stretch's last reply that no summary folds.
 */
export function catchUpRenderer(): DecorationRenderer {
  const groups = new Map<HTMLElement, CatchUpGroup>();
  const triggers = new Map<string, HTMLButtonElement>();
  return {
    draw(root, decoration, context) {
      const view = viewOf(decoration);
      let group = groups.get(root);
      if (!group) { group = new CatchUpGroup(root, view.kind === "interval"); groups.set(root, group); }
      group.update(view, context);
    },
    removed(decoration) {
      for (const [root, group] of groups) if (root.dataset.key === decoration.key && !root.isConnected) { group.clear(); groups.delete(root); }
    },
    update(context) {
      drawTriggers(context, triggers);
    },
  };
}

const lines = `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h9"/></svg>`;

/** "Summarize N replies" under the last reply of each stretch between your messages that no interval summary folds. */
function drawTriggers(context: DecorationContext, triggers: Map<string, HTMLButtonElement>): void {
  const state = context.state;
  const covered = new Set((state.subagent ? [] : state.decorations ?? []).filter((d) => (d.data as CatchUpView | undefined)?.kind === "interval").flatMap((d) => d.fold ?? []));
  const retained = new Set<string>();
  if (!state.subagent) for (let i = 0; i < state.messages.length; i++) {
    const user = state.messages[i];
    if (user.role !== "user") continue;
    let end = i + 1;
    while (end < state.messages.length && state.messages[end].role !== "user") end++;
    const replies = state.messages.slice(i + 1, end).filter(summaryCountable);
    const last = replies.at(-1);
    if (!last || covered.has(last.id)) continue;
    const row = context.row(last.id);
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
    let trigger = triggers.get(key);
    if (!trigger) {
      trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "interval-summary-trigger";
      const botId = state.botID, userMessageId = user.id;
      trigger.addEventListener("click", () => { void page.call("interval", { botId, userMessageId }).catch(() => {}); });
      triggers.set(key, trigger);
    }
    const html = lines + escapeHTML(t("interval.summarize", { n: replies.length }));
    if (trigger.dataset.drawn !== html) { trigger.dataset.drawn = html; trigger.innerHTML = html; }
    if (trigger.parentElement !== footer) footer.append(trigger);
    i = end - 1;
  }
  for (const [key, trigger] of triggers) if (!retained.has(key)) {
    const footer = trigger.parentElement;
    trigger.remove();
    if (footer?.childElementCount === 0) footer.remove();
    triggers.delete(key);
  }
}

const sparkle = `<svg class="catchup-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></svg>`;
const alert = `<svg class="catchup-icon error" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/></svg>`;
const retry = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>`;

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
  // "· 2 tasks", in orange when one of them waits on you.
  const tasks = view.tasks?.length
    ? ` · <span class="catchup-task-count${view.tasks.some(task => task.state === "waiting") ? " waiting" : ""}">${escapeHTML(t("catchup.tasks", { n: view.tasks.length }))}</span>`
    : "";
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
    + `<div class="catchup-top">${view.state === "failed" ? alert : sparkle}<span class="catchup-title">${escapeHTML(t(interval || !view.manual ? "catchup.title" : "catchup.manualTitle"))}</span><span class="catchup-meta">${escapeHTML(meta)}${tasks}</span><span class="catchup-space"></span><span class="catchup-range">${escapeHTML(range)}</span></div>`
    + body
    + linksHTML(links)
    + `<div class="catchup-foot"><div class="catchup-faces" aria-hidden="true">${faces}</div><div class="catchup-latest">${escapeHTML(footer)}</div>`
    + (view.state === "failed" ? `<button type="button" class="catchup-button outline" data-action="retry">${retry}${escapeHTML(t("catchup.retry"))}</button>` : "")
    + `<button type="button" class="catchup-button" data-action="toggle" aria-expanded="${open}" aria-haspopup="dialog">${escapeHTML(t("catchup.show", { n }))}↗</button></div>`
    + (view.state === "ready" ? `<div class="catchup-by">${escapeHTML(summaryBy(view))}</div>` : "")
    + `</div></section>`;
}

function linksHTML(links: SourceLink[]): string {
  return links.length ? `<div class="catchup-links"><strong>${escapeHTML(t("catchup.links"))}</strong><ul>${links.map(({ url, labels }) => {
      const label = labels.length ? labels.join(" · ") : url;
      return `<li>${clickableSourceURL(url) ? `<a class="chip" href="#" data-url="${escapeHTML(url)}" data-label="${escapeHTML(label)}" title="${escapeHTML(url)}">${escapeHTML(label)}</a>` : `<span>${escapeHTML(label)} — ${escapeHTML(url)}</span>`}</li>`;
    }).join("")}</ul></div>` : "";
}


function bulletsHTML(view: CatchUpView, source: MessageView[]): string {
  const cards = new Map((view.tasks ?? []).map(task => [task.id.toUpperCase(), task]));
  return summaryReferences(view,source).map((bullet,point)=>{
    // The task it is about first, then where it comes from.
    const taskChips=(bullet.tasks ?? []).map(id=>cards.get(id.toUpperCase())).filter(task=>!!task).map(task=>page.taskChip(task!,"task")).join("");
    const chips=taskChips+bullet.sources.map((reference,index)=>{
      const message=source.find(m=>m.id===reference.messageID)!;
      return `<button type="button" class="source-cite ${sourceHead(message,reference)}" data-action="source" data-cite-point="${point}" data-cite-index="${index}" aria-haspopup="dialog" aria-label="${escapeHTML(t("source.openFrom",{author:sourceAuthor(message,reference),n:point+1}))}"><span class="source-head-dot" aria-hidden="true"></span>${escapeHTML(sourceAuthor(message,reference))}</button>`;
    }).join("");
    return bulletHTML(bullet.text).replace(/<\/span><\/li>$/,chips+"</span></li>");
  }).join("");
}
