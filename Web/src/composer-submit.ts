import { placeholder as placeholderExtension } from "@codemirror/view";
import { post } from "./bridge";
import { composerHost, DeliveryUncertain, type DeliveryResult } from "./composer-host";
import { answerPrefix, mentionsOf, slashItemsOf, type ChipHandle, type ComposerChip, type Mention } from "./composer";
import type { Composer } from "./composer";
import { t } from "./i18n";
import { escapeHTML } from "./util";
import type { AnswerWithView, ChatState, Draft } from "./types";

/**
 * The submit half of `Composer` (M7-S82): the state sync (`update`), sending, the "Answer with" row and the
 * plugins' chips. `Composer` owns every field below the bridge block; this class forwards to them.
 */
export class ComposerSubmit {
  private readonly host: Composer;

  constructor(host: Composer) {
    this.host = host;
  }

  // Bridge: the whole interface to `Composer`, one forwarder per name. The setters go away when the refinement
  // cards give those fields named transitions on their owner.
  private get draftKey(): string | null { return this.host["draftKey"]; }
  private get drafts(): Map<string, Draft> { return this.host["drafts"]; }
  private get models() { return this.host["models"]; }
  private get text(): string { return this.host.text; }
  private setText(text: string): void { this.host.setText(text); }
  private get view() { return this.host.view; }
  private get root(): HTMLElement { return this.host.root; }
  private get placeholder() { return this.host["placeholder"]; }
  private get replyBar(): HTMLElement { return this.host["replyBar"]; }
  private get filesRow(): HTMLElement { return this.host["filesRow"]; }
  private get chipRow(): HTMLElement { return this.host["chipRow"]; }
  private get chipPreview(): HTMLElement { return this.host["chipPreview"]; }
  private get answerRow(): HTMLElement { return this.host["answerRow"]; }
  private get answerHint(): HTMLElement { return this.host["answerHint"]; }
  private get submissionStatus(): HTMLElement { return this.host["submissionStatus"]; }
  private get sendButton(): HTMLButtonElement { return this.host["sendButton"]; }
  private get mentions(): Mention[] { return this.host["mentions"]; }
  private set mentions(value: Mention[]) { this.host["mentions"] = value; }
  private get allMentions(): Mention[] { return this.host["allMentions"]; }
  private set allMentions(value: Mention[]) { this.host["allMentions"] = value; }
  private get slashItems(): Mention[] { return this.host["slashItems"]; }
  private set slashItems(value: Mention[]) { this.host["slashItems"] = value; }
  private get hasFiles(): boolean { return this.host["hasFiles"]; }
  private set hasFiles(value: boolean) { this.host["hasFiles"] = value; }
  private get answer(): AnswerWithView | null { return this.host["answer"]; }
  private set answer(value: AnswerWithView | null) { this.host["answer"] = value; }
  private get answerRequest(): number { return this.host["answerRequest"]; }
  private set answerRequest(value: number) { this.host["answerRequest"] = value; }
  private get answerPicks() { return this.host["answerPicks"]; }
  private get chips() { return this.host["chips"]; }
  private get sending(): Set<string> { return this.host["sending"]; }
  private get submissionStates() { return this.host["submissionStates"]; }
  private saveDraft(): void { this.host["saveDraft"](); }
  private switchDraft(key: string): void { this.host["switchDraft"](key); }
  private setWords(): void { this.host["setWords"](); }
  private refreshMentions(): void { this.host["refreshMentions"](); }

  update(state: ChatState): void {
    this.setWords();
    this.switchDraft(state.botID);
    const unknown = composerHost?.uncertainSend?.(state.botID);
    if (unknown && !this.sending.has(state.botID)) this.submissionStates.set(state.botID, { text: new DeliveryUncertain(unknown).message, uncertain: unknown });
    this.drawSubmissionStatus();
    const mentions = mentionsOf(state.mentions);
    const allMentions = mentionsOf([...(state.mentions ?? []), ...(state.allMentions ?? [])]);
    const slashItems = slashItemsOf(state);
    if (JSON.stringify([mentions, allMentions, slashItems]) !== JSON.stringify([this.mentions, this.allMentions, this.slashItems])) {
      this.mentions = mentions;
      this.allMentions = allMentions;
      this.slashItems = slashItems;
      this.refreshMentions();
    }
    this.view.dispatch({ effects: this.placeholder.reconfigure(placeholderExtension(state.placeholder)) });
    this.setAnswer(state.answerWith ?? null, state.botID);

    if (state.replyingTo) {
      this.replyBar.hidden = false;
      this.replyBar.innerHTML = `<span class="reply-line"></span><span class="reply-text"><span class="reply-who">${escapeHTML(state.replyingTo.who)}</span><span class="reply-preview">${escapeHTML(state.replyingTo.preview)}</span></span><button class="close">×</button>`;
      this.replyBar.querySelector(".close")!.setAttribute("aria-label", t("composer.cancelReply"));
      this.replyBar.querySelector(".close")!.addEventListener("click", () => post({ type: "cancelReply" }));
    } else {
      this.replyBar.hidden = true;
      this.replyBar.innerHTML = "";
    }

    this.drawChips();
    this.hasFiles = state.pendingFiles.length > 0;
    this.filesRow.hidden = !this.hasFiles;
    this.filesRow.innerHTML = "";
    for (const file of state.pendingFiles) {
      const item = document.createElement("div");
      item.className = "pending";
      item.innerHTML = file.kind === "image"
        ? `<img src="${escapeHTML(file.url)}" alt="${escapeHTML(file.name)}">`
        : `<span class="pending-name">${escapeHTML(file.name)}</span>`;
      const remove = document.createElement("button");
      remove.className = "remove";
      remove.setAttribute("aria-label", t("composer.removeFile", { name: file.name }));
      remove.textContent = "×";
      remove.addEventListener("click", () => post({ type: "removeFile", id: file.id }));
      item.append(remove);
      this.filesRow.append(item);
    }
    this.refreshSend();
  }

  /** Sends what is typed (and any files). Returns true so Return does not also add a line. */
  submit(): boolean {
    if (this.draftKey && this.models.blocked(this.draftKey)) return false;
    let text = this.text;
    const key = this.draftKey;
    // What each chip sends, as it was when sent: a chip changed meanwhile stays.
    const chips = (this.chips.get(key ?? "") ?? []).map((entry) => ({ entry, text: entry.chip.serialize() }));
    if (text.trim() === "" && !this.hasFiles && !chips.length) return true;
    if (key && (this.sending.has(key) || this.submissionStates.get(key)?.uncertain)) { this.drawSubmissionStatus(); return true; }
    const original = text;
    const typed = this.answer ? answerPrefix(text, this.answer) : null;
    if (typed) text = typed.rest;
    if (chips.length) text = [text.trim() === "" ? "" : text, ...chips.map((chip) => chip.text)].filter(Boolean).join("\n\n");
    const to = this.answer ? typed?.id ?? this.answerPicks.get(this.answerChat)?.id ?? this.answer.chosen : undefined;
    if (composerHost && key) {
      this.saveDraft();
      this.sending.add(key);
      this.submissionStates.delete(key);
      this.drawSubmissionStatus();
      this.refreshSend();
      // Keep the text editable and recoverable until the core has actually accepted it.
      const finish = () => { this.sending.delete(key); this.refreshSend(); };
      const accepted = () => {
        this.submissionStates.delete(key);
        for (const { entry, text } of chips) if (entry.chip.serialize() === text) this.removeChip(key, entry);
        if (this.draftKey === key) {
          if (this.text === original) { this.setText(""); this.saveDraft(); }
        } else if (this.drafts.get(key)?.text === original) {
          this.drafts.delete(key);
          post({ type: "draft", botID: key, text: "", cursor: 0 });
        }
        this.drawSubmissionStatus();
      };
      let uncertainID: string | undefined;
      const lateResult = (result: DeliveryResult) => {
        // A dismissed outcome or a newer attempt never owns the current draft/status.
        if (!uncertainID || this.submissionStates.get(key)?.uncertain !== uncertainID) return;
        if (result.ok) accepted();
        else { this.submissionStates.set(key, { text: `Not sent: ${result.error || "Request failed"}` }); this.drawSubmissionStatus(); }
      };
      let request: Promise<void>;
      try { request = composerHost.send({ type: "send", botID: key, text, ...(to ? { to } : {}) }, lateResult); }
      catch (error) { request = Promise.reject(error); }
      void request.then(accepted, (error: unknown) => {
        uncertainID = error instanceof DeliveryUncertain ? error.requestID : undefined;
        this.submissionStates.set(key, { text: uncertainID ? (error as DeliveryUncertain).message : `Not sent: ${error instanceof Error ? error.message : String(error)}`, ...(uncertainID ? { uncertain: uncertainID } : {}) });
      }).finally(() => { finish(); this.drawSubmissionStatus(); });
      return true;
    }
    post({ type: "send", text, ...(to ? { to } : {}) });
    for (const { entry } of chips) this.removeChip(key ?? "", entry);
    this.setText("");
    this.saveDraft();
    return true;
  }

  drawSubmissionStatus(): void {
    const key = this.draftKey;
    this.submissionStatus.replaceChildren();
    if (!key) return;
    if (this.sending.has(key)) { this.submissionStatus.textContent = "Sending…"; return; }
    const state = this.submissionStates.get(key); if (!state) return;
    this.submissionStatus.append(document.createTextNode(state.text));
    if (state.uncertain) {
      const release = document.createElement("button");
      release.textContent = "I checked the chat — allow another send";
      release.onclick = () => {
        if (this.submissionStates.get(key) !== state) return;
        composerHost?.releaseUncertain?.(state.uncertain!);
        this.submissionStates.delete(key); this.drawSubmissionStatus(); this.refreshSend();
      };
      this.submissionStatus.append(release);
    }
  }

  /** A save belongs to one click: an older acknowledgement never clears a newer choice. */
  answerWithSaved(ack: { botID: string; requestID: number; chosen: string }): void {
    const pending = this.answerPicks.get(ack.botID);
    if (!pending || pending.requestID !== ack.requestID) return;
    pending.id = ack.chosen;
    pending.saved = true;
    if (this.answerChat === ack.botID) {
      if (this.answer?.chosen === pending.id) this.answerPicks.delete(ack.botID);
      this.drawAnswer();
    }
  }

  /** Native state owns saved choices; keep a click visible until its save is acknowledged. */
  private setAnswer(answer: AnswerWithView | null, chat: string): void {
    this.models.update(chat, answer?.options.map(option => option.id) ?? []);
    this.answerChat = chat;
    const pending = this.answerPicks.get(chat);
    if (pending && ((pending.saved && answer?.chosen === pending.id) || !answer?.options.some((option) => option.id === pending.id))) {
      this.answerPicks.delete(chat);
    }
    this.answer = answer;
    this.drawAnswer();
  }

  private answerChat = "";

  private drawAnswer(): void {
    const answer = this.answer;
    this.answerRow.hidden = !answer;
    this.answerHint.hidden = !answer;
    this.answerRow.innerHTML = "";
    this.root.classList.toggle("answering", !!answer);
    if (!answer) return;
    const picked = this.answerPicks.get(this.answerChat)?.id ?? answer.chosen;
    this.answerRow.setAttribute("aria-label", t("composer.answerWith"));
    this.answerRow.title = t("composer.answerWith");
    answer.options.forEach((option, index) => {
      const chip = document.createElement("button");
      chip.className = "answer-chip" + (option.id === picked ? " picked" : "");
      chip.textContent = option.label;
      chip.dataset.head = option.id;
      chip.setAttribute("aria-pressed", String(option.id === picked));
      chip.title = `${t("composer.answerWith")} ${option.label} · ⌥${index + 1}`;
      chip.addEventListener("click", () => this.pickAnswer(option.id));
      if (composerHost?.modelSettings && ['claude','codex','agy'].includes(option.id)) {
        const segment = document.createElement('span');
        segment.className = 'answer-segment' + (option.id === picked ? ' picked' : '');
        const menu = document.createElement('button');
        menu.className = 'answer-menu'; menu.type = 'button'; menu.dataset.engine = option.id;
        menu.setAttribute('aria-label', `${option.label} model and effort`);
        menu.setAttribute('aria-haspopup', 'dialog'); menu.setAttribute('aria-expanded', String(this.models.isOpen(this.answerChat, option.id)));
        menu.innerHTML = '<svg width="8" height="5" viewBox="0 0 8 5" aria-hidden="true"><path d="m1 1 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
        menu.onclick = () => void this.models.open(this.answerChat, option.id as 'claude'|'codex'|'agy', option.label);
        segment.append(chip, menu); this.answerRow.append(segment);
      } else this.answerRow.append(chip);
    });
    this.answerHint.textContent = t("composer.answerHint", { keys: answer.options.map((_, index) => `⌥${index + 1}`).join(" ") });
  }

  private pickAnswer(id: string): void {
    this.models.close(false);
    if (!this.answer?.options.some((option) => option.id === id)) return;
    if (id === this.answer.chosen && !this.answerPicks.has(this.answerChat)) {
      this.view.focus();
      return;
    }
    const requestID = ++this.answerRequest;
    this.answerPicks.set(this.answerChat, { id, requestID, saved: false });
    post({ type: "setAnswerWith", botID: this.answerChat, to: id, requestID });
    this.drawAnswer();
    this.view.focus();
  }

  /** ⌥1, ⌥2, ⌥3 pick a chip (by key position: ⌥ changes the character typed). */
  answerKey(event: KeyboardEvent): boolean {
    if (!this.answer || !event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false;
    const digit = /^Digit([1-9])$/.exec(event.code);
    const option = digit ? this.answer.options[Number(digit[1]) - 1] : undefined;
    if (!option) return false;
    event.preventDefault();
    this.pickAnswer(option.id);
    return true;
  }

  refreshSend(): void {
    this.sendButton.disabled = !!(this.draftKey && (this.sending.has(this.draftKey) || this.models.blocked(this.draftKey))) || (this.text.trim() === "" && !this.hasFiles && !this.chips.get(this.draftKey ?? "")?.length);
  }

  /** A plugin's chip in the chat open now; it stays with that chat's draft until sent or removed. */
  addChip(chip: ComposerChip): ChipHandle {
    const key = this.draftKey ?? "";
    const handle: ChipHandle = {
      update: () => { if (key === (this.draftKey ?? "")) this.drawChips(); },
      remove: () => this.removeChip(key, entry),
    };
    const entry = { chip, handle };
    this.chips.set(key, [...(this.chips.get(key) ?? []), entry]);
    this.drawChips();
    this.refreshSend();
    return handle;
  }

  /** The chips in the chat open now. */
  chipsHere(): ChipHandle[] {
    return (this.chips.get(this.draftKey ?? "") ?? []).map((entry) => entry.handle);
  }

  private removeChip(key: string, entry: { chip: ComposerChip; handle: ChipHandle }): void {
    const list = this.chips.get(key) ?? [];
    if (!list.includes(entry)) return;
    const kept = list.filter((other) => other !== entry);
    if (kept.length) this.chips.set(key, kept);
    else this.chips.delete(key);
    entry.chip.onRemove?.();
    if (key !== (this.draftKey ?? "")) return;
    this.drawChips();
    this.refreshSend();
  }

  /** The open chat's chips in their row, and what they open above the box. */
  private drawChips(): void {
    const list = this.chips.get(this.draftKey ?? "") ?? [];
    this.chipRow.replaceChildren(...list.map(({ chip }) => chip.render()));
    this.chipRow.hidden = !list.length;
    const previews = list.map(({ chip }) => chip.preview?.() ?? null).filter((node): node is Node => node !== null);
    this.chipPreview.replaceChildren(...previews);
    this.chipPreview.hidden = !previews.length;
  }
}
