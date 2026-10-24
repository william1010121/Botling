import { closeLightbox } from "./lightbox";
import { t } from "./i18n";
import { mediaHTML, renderMarkdown } from "./markdown";
import { sourceLinks, clickableSourceURL } from "./catchup-links";
import { requestSourceSnapshot, staticSourcePage } from "./source-snapshot";
import { summaryMessages, summaryReferences, type SourceReference } from "./summary-sources";
import type { CatchUpView, ChatState, MessageView } from "./types";
import { escapeHTML } from "./util";

export function sourceAuthor(message: MessageView, reference?: SourceReference): string {
  if (reference?.part === "answer" || message.role === "user") return t("source.you");
  const engine = message.sourceEngine === "claude" ? "Claude" : message.sourceEngine === "codex" ? "Codex" : null;
  return [message.sourceAuthor ?? message.speaker, engine].filter(Boolean).join(" · ") || t("source.originals");
}
export function sourceHead(message: MessageView, reference?: SourceReference): string {
  return reference?.part === "answer" || message.role === "user" ? "you" : message.sourceEngine === "claude" || message.sourceEngine === "codex" ? message.sourceEngine : "unknown";
}
export function summaryBy(view: CatchUpView): string {
  const model = view.model?.trim() || t("source.unknown");
  const asked = view.requestedBy === "user" ? t("source.you") : view.requestedBy;
  return t("catchup.by", {model: model + (asked ? ` · ${t("source.askedBy", {author:asked})}` : "")});
}

/** One top-layer dialog shared by all ranges and citations. Original rows/frames stay in place. */
export class SummaryViewer {
  onClose: (() => void) | null = null;
  private dialog: HTMLDialogElement | null = null;
  private owner = "";
  private restore: HTMLElement | null = null;
  private restoreTarget: (()=>HTMLElement|null) | null = null;
  setRestoreTarget(target:()=>HTMLElement|null): void { this.restoreTarget=target; }
  private state: ChatState | null = null;
  private view: CatchUpView | null = null;
  private find: ((id: string) => HTMLElement | null) | null = null;
  private reveal: ((id: string) => void) | null = null;
  private point = -1;
  private index = 0;
  private epoch = 0;
  private contentKey = "";
  private fingerprint(state:ChatState,view:CatchUpView):string { return JSON.stringify([summaryMessages(view,state.messages),view,state.lang]); }
  private background: {element: HTMLElement; inert: boolean}[] = [];

  isOpen(owner: string): boolean { return !!this.dialog && owner === this.owner; }
  sync(owner: string, state: ChatState, view: CatchUpView): void {
    if (!this.isOpen(owner)) return;
    const key=this.fingerprint(state,view);
    if(key===this.contentKey){this.state=state;this.view=view;return;}
    this.contentKey=key;
    const top = this.dialog!.querySelector(".source-body")?.scrollTop ?? 0;
    const focused=this.dialog!.contains(document.activeElement);
    this.state = state; this.view = view; this.draw();
    if(focused)this.dialog!.querySelector<HTMLButtonElement>('[data-source-close]')?.focus({preventScroll:true});
    this.dialog!.querySelector(".source-body")!.scrollTop = top;
  }
  open(owner: string, state: ChatState, view: CatchUpView, find: (id: string) => HTMLElement | null, reveal: (id: string) => void, point = -1, index = 0): void {
    const same = this.isOpen(owner);
    if (!same) this.close();
    this.owner = owner; this.state = state; this.view = view; this.contentKey=this.fingerprint(state,view); this.find = find; this.reveal = reveal; this.point = point; this.index = index;
    if (!same) {
      this.restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const dialog = document.createElement("dialog"); dialog.className = "summary-source-viewer";
      dialog.setAttribute("aria-label",t("source.originals"));
      this.dialog = dialog;
      dialog.addEventListener("cancel", event => { event.preventDefault(); this.close(); });
      dialog.addEventListener("click", event => { if (event.target === dialog) this.close(); });
      dialog.addEventListener("keydown", event => this.keydown(event));
      this.background = [...document.body.children].filter((e): e is HTMLElement => e instanceof HTMLElement).map(element => ({element,inert:element.inert}));
      for (const {element} of this.background) element.inert = true;
      document.body.append(dialog);
    }
    this.draw();
    if(!same){
      if(typeof this.dialog!.showModal === "function")this.dialog!.showModal();else this.dialog!.setAttribute("open", "");
    }
    this.dialog!.querySelector<HTMLButtonElement>('[data-source-close]')!.focus({preventScroll:true});
  }
  close(owner?: string): void {
    if (!this.dialog || owner && owner !== this.owner) return;
    this.epoch++;
    if(this.dialog.querySelector(".lightbox"))closeLightbox();
    this.dialog.remove(); this.dialog = null;
    for (const {element,inert} of this.background) element.inert = inert;
    this.background = [];
    const restore = this.restoreTarget?.() ?? this.restore;
    if (restore?.isConnected) restore.focus({preventScroll:true});
    this.restoreTarget=null;
    this.restore = null; this.state = null; this.view = null; this.owner = "";
    queueMicrotask(()=>this.onClose?.());
  }
  private keydown(event: KeyboardEvent): void {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(); return; }
    if (event.key !== "Tab" || !this.dialog) return;
    const focusable = [...this.dialog.querySelectorAll<HTMLElement>('button:not([disabled]),a[data-url],video[controls],[tabindex="0"]')].filter(e => !e.closest("[hidden]"));
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || !this.dialog.contains(document.activeElement))) { event.preventDefault();last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault();first?.focus(); }
  }
  private draw(): void {
    const dialog = this.dialog!, view = this.view!, state = this.state!, epoch = ++this.epoch;
    const messages = summaryMessages(view,state.messages), bullets = summaryReferences(view,state.messages);
    const citations = bullets[this.point]?.sources ?? [];
    this.index = Math.max(0,Math.min(this.index,citations.length-1));
    const selected = citations[this.index];
    const title = t("catchup.messages",{n:messages.length});
    dialog.innerHTML = `<header class="source-header"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--link)" stroke-width="1.8" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"></path></svg><div><strong>${escapeHTML(title)}</strong>${view.since ? `<span class="source-time"> · ${escapeHTML(view.since)}${view.until && view.until !== view.since ? ` – ${escapeHTML(view.until)}` : ""}</span>` : ""}<div class="source-meta">${escapeHTML(summaryBy(view))}</div></div><button type="button" class="source-icon" data-source-close aria-label="${escapeHTML(t("common.close"))}">✕</button></header>`
      + (selected ? `<nav class="source-nav" aria-label="${escapeHTML(t("source.navigation"))}"><strong>${escapeHTML(t("source.point",{n:this.point+1}))}</strong><span class="source-preview-line">${escapeHTML(selected.quote ?? bullets[this.point].text.replace(/^!!\s*/,""))}</span><span>${this.index+1} / ${citations.length}</span><button type="button" class="source-icon" data-source-prev aria-label="${escapeHTML(t("source.previous"))}" ${this.index===0?"disabled":""}>‹</button><button type="button" class="source-icon" data-source-next aria-label="${escapeHTML(t("source.next"))}" ${this.index===citations.length-1?"disabled":""}>›</button></nav>` : "")
      + `<div class="source-body" tabindex="0"></div><footer class="source-footer"><button type="button" class="catchup-button outline" data-source-all>${escapeHTML(selected ? t("source.all",{n:messages.length}) : t("source.showChat"))}</button><span>${escapeHTML(t("source.readOnly"))}</span><button type="button" class="catchup-button" data-source-close>${escapeHTML(t("source.done"))}</button></footer>`;
    dialog.querySelectorAll<HTMLButtonElement>('[data-source-close]').forEach(button => button.onclick = () => this.close());
    dialog.querySelector<HTMLButtonElement>('[data-source-prev]')?.addEventListener("click", () => {this.index--;this.draw();dialog.querySelector<HTMLButtonElement>('[data-source-prev]:not([disabled]),[data-source-next]')?.focus();});
    dialog.querySelector<HTMLButtonElement>('[data-source-next]')?.addEventListener("click", () => {this.index++;this.draw();dialog.querySelector<HTMLButtonElement>('[data-source-next]:not([disabled]),[data-source-prev]')?.focus();});
    dialog.querySelector<HTMLButtonElement>('[data-source-all]')!.onclick = () => {
      if(!selected){const id=messages[0]?.id,reveal=this.reveal;this.close();if(id)reveal?.(id);return;}
      this.point=-1;this.draw();dialog.querySelector<HTMLButtonElement>('[data-source-all]')?.focus();
    };
    const body = dialog.querySelector<HTMLElement>(".source-body")!;
    for (const message of messages) {
      const row = document.createElement("article");row.className="source-message";row.dataset.sourceId=message.id;
      if (selected?.messageID === message.id) row.classList.add("cited");
      const who = sourceAuthor(message), head = sourceHead(message);
      row.innerHTML = `${message.avatar ? `<img class="source-avatar" src="${escapeHTML(message.avatar)}" alt="">` : `<span class="source-avatar source-dot ${head}" aria-hidden="true"></span>`}<div class="source-column"><div class="source-who ${head}"><strong>${escapeHTML(who)}</strong>${message.sourceTime || message.time ? `<time>${escapeHTML(message.sourceTime ?? message.time ?? "")}</time>` : ""}${selected?.messageID===message.id ? `<span class="source-cited-label">${escapeHTML(t("source.cited",{n:this.point+1}))}</span>` : ""}</div><div class="source-prose bubble bot-bubble">${renderMarkdown(message.text)}</div></div>`;
      const column = row.querySelector<HTMLElement>(".source-column")!;
      if (message.stamp) {const stamp=document.createElement("div");stamp.className="source-meta";stamp.textContent=message.stamp;column.prepend(stamp);}
      for (const file of message.attachments ?? []) {
        const holder=document.createElement("div");
        holder.innerHTML=file.kind==="file" ? `<a href="#" class="file-chip" data-url="${escapeHTML(file.url)}" data-label="${escapeHTML(file.name)}">${escapeHTML(file.name)}</a>` : mediaHTML(file.url,file.name);
        column.append(holder);
      }
      const renderedLinks=new Set([...column.querySelectorAll<HTMLElement>("[data-url]")].map(node=>node.dataset.url));
      for (const link of sourceLinks([message])) {
        if (!clickableSourceURL(link.url) || renderedLinks.has(link.url)) continue;
        const anchor=document.createElement("a");anchor.className="chip";anchor.href="#";anchor.dataset.url=link.url;anchor.textContent=link.labels.join(" · ")||link.url;column.append(anchor);
      }
      if (message.choices?.length) this.choices(column,message,selected);
      // Capture only already-running frames; never call componentElement/commandCard here.
      const frames = [...this.find?.(message.id)?.querySelectorAll<HTMLIFrameElement>("iframe.component-frame") ?? []];
      const genericFrames = frames.filter(frame=>(frame as HTMLIFrameElement & {ccbKey?:string}).ccbKey !== `${message.id}/choices`);
      for (const frame of genericFrames) this.snapshot(column,frame,message,selected?.messageID===message.id?selected.quote:undefined,epoch);
      if (!genericFrames.length) for (const display of message.displays ?? (message.display?[message.display]:[])) {
        const fallback=document.createElement("section");fallback.className="source-card";
        fallback.innerHTML=`<div class="source-meta">${escapeHTML(display.name)} · ${escapeHTML(t("source.snapshotUnavailable"))}</div><pre></pre>`;
        fallback.querySelector("pre")!.textContent=display.data;this.cardStatus(fallback,message);column.append(fallback);this.clip(fallback);
      }
      body.append(row);
      if (selected?.messageID===message.id && selected.quote) {
        let quoteRoot:Element|null=null;
        if(selected.part==="answer") quoteRoot=message.answer?.includes(selected.quote) ? column.querySelector(".source-note>div:last-child") : column.querySelector(".source-picked");
        else if(message.text.includes(selected.quote)) quoteRoot=column.querySelector(".source-prose");
        else quoteRoot=[...column.querySelectorAll(".source-option")].find(option=>option.textContent?.includes(selected.quote!))??null;
        if(quoteRoot)markQuote(quoteRoot,selected.quote);
      }
    }
    if (selected) queueMicrotask(() => this.position(epoch));
  }
  private position(epoch:number): void {
    if(epoch!==this.epoch || !this.dialog || !this.view || !this.state)return;
    const selected=summaryReferences(this.view,this.state.messages)[this.point]?.sources[this.index];
    if(!selected)return;
    const row=[...this.dialog.querySelectorAll<HTMLElement>("[data-source-id]")].find(row=>row.dataset.sourceId===selected.messageID);
    const passage=row?.querySelector<HTMLElement>("mark") ?? row?.querySelector<HTMLElement>(".source-answer-cited") ?? row?.querySelector<HTMLElement>(".source-answer-in-chat") ?? (selected.quote ? row?.querySelector<HTMLElement>(".source-snapshot") : null) ?? row;
    passage?.scrollIntoView?.({block:"center",behavior:"auto"});
  }

  private choices(column: HTMLElement,message: MessageView,selected?: SourceReference): void {
    const card=document.createElement("section");card.className="source-card";
    const answered=message.chosen!=null || message.answer!=null;
    card.innerHTML=`<div class="source-card-top"><span>${escapeHTML(t("source.askedBy",{author:sourceAuthor(message)}))}</span>${!answered ? `<span class="source-unanswered">${escapeHTML(t("source.unanswered"))}</span><button type="button" class="catchup-button source-answer-in-chat">${escapeHTML(t("source.answerInChat"))} ↗</button>` : ""}</div>`;
    for (const [index,choice] of message.choices!.entries()) {
      const option=document.createElement("div");option.className="source-option"+(message.chosen===index?" source-picked":answered?" source-faded":"");
      option.innerHTML=`<span>${message.chosen===index?"✓ ":""}${escapeHTML(choice.label)}</span><span class="source-meta">${escapeHTML([choice.recommended?t("choices.recommended"):"",choice.detail].filter(Boolean).join(" · "))}</span>`;card.append(option);
      if (selected?.messageID===message.id && selected.part==="answer" && message.chosen===index) option.classList.add("source-answer-cited");
    }
    if (answered) {
      const note=document.createElement("div");note.className="source-note";
      note.innerHTML=`<div class="source-meta">${escapeHTML(t("source.pickedBy",{author:t("source.you")}))}</div><div></div>`;
      note.lastElementChild!.textContent=message.answer ?? "";card.append(note);
    }
    card.querySelector<HTMLButtonElement>(".source-answer-in-chat")?.addEventListener("click",()=>{
      const id=message.id, reveal=this.reveal;this.close();reveal?.(id);
    });
    column.append(card);this.clip(card);
  }
  private snapshot(column: HTMLElement,frame: HTMLIFrameElement,message:MessageView,quote: string|undefined,epoch:number): void {
    const holder=document.createElement("section");holder.className="source-card source-snapshot";holder.textContent=t("source.loadingCard");column.append(holder);
    void requestSourceSnapshot(frame).then(snapshot=>{
      if(epoch!==this.epoch || !holder.isConnected)return;
      holder.textContent="";
      if(!snapshot){holder.textContent=t("source.snapshotUnavailable");const data=document.createElement("pre");data.textContent=(message.displays??(message.display?[message.display]:[])).map(d=>d.data).join("\n");holder.append(data);this.cardStatus(holder,message);this.clip(holder);return;}
      const image=document.createElement("iframe");image.className="source-static-frame";image.setAttribute("sandbox","");image.setAttribute("tabindex","-1");image.setAttribute("aria-label",t("source.staticCard"));image.style.height=`${snapshot.height}px`;image.addEventListener("load",()=>{image.dataset.loaded="true";queueMicrotask(()=>this.position(epoch));},{once:true});image.srcdoc=staticSourcePage(snapshot.html,quote);holder.append(image);
      this.cardStatus(holder,message);
      if(message.answer!=null){const note=document.createElement("div");note.className="source-note";note.innerHTML=`<div class="source-meta">${escapeHTML(t("source.pickedBy",{author:t("source.you")}))}</div><div></div>`;note.lastElementChild!.textContent=message.answer;holder.append(note);if(quote)markQuote(note.lastElementChild!,quote);}
      if(!quote)this.clip(holder,snapshot.height+48);
      queueMicrotask(()=>this.position(epoch));
    });
  }
  private cardStatus(holder:HTMLElement,message:MessageView): void {
    const label=document.createElement("div");label.className="source-card-top";label.textContent=t("source.askedBy",{author:sourceAuthor(message)});holder.prepend(label);
    if(message.open && message.answer==null && message.chosen==null){
      const status=document.createElement("span");status.className="source-unanswered";status.textContent=t("source.unanswered");label.append(status);
      const answer=document.createElement("button");answer.type="button";answer.className="catchup-button source-answer-in-chat";answer.textContent=t("source.answerInChat");answer.onclick=()=>{const reveal=this.reveal;this.close();reveal?.(message.id);};label.append(answer);
    }
  }
  private clip(card: HTMLElement,height?:number): void {
    const apply=()=>{
      if((height ?? card.scrollHeight)<=240 || card.querySelector(".source-whole,mark,.source-answer-cited"))return;
      card.classList.add("source-clipped");
      const button=document.createElement("button");button.type="button";button.className="catchup-button source-whole";button.textContent=t("source.whole");button.onclick=()=>{card.classList.remove("source-clipped");button.remove();};card.append(button);
    };
    queueMicrotask(apply);
  }
}

/** First exact rendered occurrence, including a quote split over inline formatting. */
export function markQuote(root: Element,quote:string): void {
  if(!quote)return;
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes:Text[]=[];let node:Node|null,text="";
  while((node=walker.nextNode())){if(node.parentElement?.closest("script,style,button"))continue;nodes.push(node as Text);text+=node.textContent??"";}
  const at=text.indexOf(quote);if(at<0)return;
  let offset=0;const spans:{node:Text;start:number;end:number}[]=[];
  for(const node of nodes){const length=node.length,start=Math.max(0,at-offset),end=Math.min(length,at+quote.length-offset);if(start<end)spans.push({node,start,end});offset+=length;}
  for(const {node,start,end} of spans.reverse()){const range=document.createRange();range.setStart(node,start);range.setEnd(node,end);const mark=document.createElement("mark");range.surroundContents(mark);}
}
export const summaryViewer = new SummaryViewer();
