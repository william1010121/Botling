import { ComposerModels } from './composer-models';
import { renderFilePreview, fileReference, emphasizePath } from "./file-preview";
import type { ProjectFile, FilePreview } from "./composer-host";
import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent } from "@codemirror/commands";
import { EditorState, Prec, StateEffect, Transaction, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { post } from "./bridge";
import { composerHost } from "./composer-host";
import { ComposerSubmit } from "./composer-submit";
import { escapeRegExp, shared } from "./contract";
import { language, t } from "./i18n";
import { isComposingEnter, isComposingKey, isSendEnter } from "./ime";
import { EnterMode } from "./enter-mode";
import type { AnswerWithView, ChatState, Draft } from "./types";

/** How long after the last change a draft is saved (ms): typing does not write on every key. */
export const draftDelay = 500;

/**
 * The `/name` being typed right before the caret, as Swift reads a component's name in a message
 * (`ComponentMentions`): the slash starts a word after whitespace, non-ASCII text such as
 * Chinese, or one of the contract's `startsAfter` characters; group 1 is what is typed so far.
 */
export const slashQuery = new RegExp(`(?:^|[\\s${escapeRegExp(shared.componentMention.startsAfter)}\\u0080-\\uffff])\\/([^\\s/]{0,40})$`);

/**
 * The input box: CodeMirror 6, so editor plugins (laas and the like) work in it as they do on the
 * web. Return sends, Shift-Return adds a line, and Return while an input method is choosing a
 * candidate only commits the candidate.
 */
/** `draft` with `quote` after it as its own paragraph: one blank line before it (when there is text) and after it. */
export function quoteAppend(draft: string, quote: string): string {
  const body = quote.replace(/^\n+|\n+$/g, "");
  const before = !draft ? "" : draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n";
  return `${draft}${before}${body}\n\n`;
}

export class Composer {
  readonly root: HTMLElement;
  readonly view: EditorView;
  private readonly placeholder = new Compartment();
  /** The undo history, started again with each chat's draft (undo never brings another's back). */
  private readonly historySlot = new Compartment();
  /**
   * Unsent text and caret, by chat (`ChatState.botID`): switching keeps what you typed, and the
   * app keeps it over a restart (`draft` actions; `setDrafts` when the page loads). Only
   * committed text counts: while an input method is composing, the last text before it is kept.
   */
  private readonly drafts = new Map<string, Draft>();
  /** The chat the box holds now; null before the first state. */
  private draftKey: string | null = null;
  /** The current chat's text as the app last heard it, so nothing unchanged is sent again. */
  private savedDraft: Draft = { text: "", cursor: 0 };
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  /** The editor's own label for screen readers, in the page's language. */
  private readonly label = new Compartment();
  /** Return sends with a physical keyboard, makes a new line on a phone's on-screen keyboard (enter-mode.ts). */
  private readonly enterMode = new EnterMode();
  /** The language the box's own words were last set in. */
  private wordsIn = "";
  private readonly plus: HTMLButtonElement;
  private readonly replyBar: HTMLElement;
  private readonly filesRow: HTMLElement;
  private readonly sendButton: HTMLButtonElement;
  private hasFiles = false;
  /** Plugins' chips above the box, per chat (`composer.chips`): sent after your words, then taken away. */
  private readonly chips = new Map<string, { chip: ComposerChip; handle: ChipHandle }[]>();
  private readonly chipRow: HTMLElement;
  private readonly chipPreview: HTMLElement;
  private readonly sending = new Set<string>();
  private readonly submissionStates = new Map<string, { text: string; uncertain?: string }>();
  private readonly submissionStatus = document.createElement("div");
  /**
   * "Answer with" in the box's toolbar, between + and send: Both / Claude / Codex as one
   * segmented control, then the ⌥1 ⌥2 ⌥3 hint; the app saves its choice for this bot.
   */
  private readonly answerRow: HTMLElement;
  private readonly answerHint: HTMLElement;
  private answer: AnswerWithView | null = null;
  private readonly models: ComposerModels;
  /** The submit half (composer-submit.ts): state sync, sending, "Answer with", chips. */
  private readonly submitPart = new ComposerSubmit(this);
  /** Explicit choices awaiting the app's saved state, keyed so switching chats keeps them. */
  private readonly answerPicks = new Map<string, { id: string; requestID: number; saved: boolean }>();
  private answerRequest = 0;
  /** Plugins see key presses first; returning true means a plugin handled it. */
  onKey: (event: KeyboardEvent) => boolean = () => false;
  /** Plugins see a paste of text first; returning true means a plugin took it. */
  onPaste: (event: ClipboardEvent) => boolean = () => false;
  private popover: HTMLElement | null = null;
  /**
   * What the list offers as you type: after @ the bots (a group's members, or in a bot's own chat
   * the bots you can call in); after / at the start of a word the app's commands, and once a
   * letter follows the slash the components that match (the bot is told you mean that component).
   * The / list stays quiet: a few small rows, no tags.
   */
  private mentions: Mention[] = [];
  private allMentions: Mention[] = [];
  private slashItems: Mention[] = [];
  private readonly mentionList: HTMLElement;
  private mentionMatches: Mention[] = [];
  private mentionActive = 0;
  /** Where the "@…" or "/…" being typed starts. */
  private mentionFrom = -1;
  private fileQueryKey = "";
  private fileResults: ProjectFile[] = [];
  private fileLimited = false;
  private fileError = false;
  private fileLoading = false;
  private previewKey = "";
  private preview: FilePreview | null = null;
  private fileTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "composer";
    this.models = new ComposerModels(this.root, () => this.refreshSend());
    this.submissionStatus.setAttribute("role", "status");
    this.submissionStatus.className = "composer-submission-status";
    this.root.append(this.submissionStatus);
    this.replyBar = document.createElement("div");
    this.replyBar.className = "reply-bar";
    this.filesRow = document.createElement("div");
    this.filesRow.className = "pending-files";
    this.chipRow = document.createElement("div");
    this.chipRow.className = "composer-chips";
    this.chipRow.hidden = true;
    this.chipPreview = document.createElement("div");
    this.chipPreview.className = "composer-chip-preview";
    this.chipPreview.hidden = true;

    // The text on top, the toolbar under it: + and "Answer with" on the left, send on the right.
    const row = document.createElement("div");
    row.className = "composer-row";
    const tools = document.createElement("div");
    tools.className = "composer-tools";
    const plus = document.createElement("button");
    this.plus = plus;
    plus.className = "plus";
    plus.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
    plus.addEventListener("click", () => post({ type: "pickFiles" }));

    const editorHost = document.createElement("div");
    editorHost.className = "editor";
    this.sendButton = document.createElement("button");
    this.sendButton.className = "send";
    this.sendButton.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`;
    this.sendButton.addEventListener("click", () => this.submit());
    this.answerRow = document.createElement("div");
    this.answerRow.className = "answer-with";
    this.answerRow.setAttribute("role", "group");
    this.answerRow.hidden = true;
    this.answerHint = document.createElement("span");
    this.answerHint.className = "answer-hint";
    this.answerHint.hidden = true;
    const gap = document.createElement("span");
    gap.className = "composer-gap";
    row.append(editorHost);
    tools.append(plus, this.answerRow, this.answerHint, gap, this.sendButton);
    this.mentionList = document.createElement("div");
    this.mentionList.className = "mention-list";
    this.mentionList.setAttribute("role", "listbox");
    this.mentionList.hidden = true;
    this.root.append(this.mentionList, this.chipPreview, this.replyBar, this.chipRow, this.filesRow, row, tools);
    parent.append(this.root);

    this.view = new EditorView({
      parent: editorHost,
      state: EditorState.create({
        extensions: [
          this.historySlot.of(history()),
          EditorView.lineWrapping,
          this.placeholder.of(placeholderExtension("")),
          keymap.of([
            { key: "Shift-Enter", run: insertNewlineAndIndent },
            // Not Mod-[ / Mod-] (indent): those are the app's back / forward between a project bot and its
            // sub bot, and indenting there changed the draft and kept the key from the app.
            ...defaultKeymap.filter((binding) => binding.key !== "Mod-[" && binding.key !== "Mod-]"),
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) this.refreshSend();
            if (update.docChanged && !update.transactions.some((tr) => tr.annotation(Transaction.remote))) this.draftChanged();
            if (update.docChanged || update.selectionSet) this.refreshMentions();
          }),
          // Ahead of every keymap: a key pressed while an input method is choosing (Zhuyin, Pinyin)
          // belongs to it, so Return commits the candidate instead of sending.
          Prec.highest(EditorView.domEventHandlers({
            keydown: (event, view) => (this.enterMode.saw(event), false) || isComposingKey(event) || isComposingEnter(event) || view.composing || this.mentionKey(event) || this.answerKey(event) || this.onKey(event) || this.enterKey(event),
          })),
          EditorView.domEventHandlers({
            // Suppress CodeMirror's file-to-text insertion, but let the drop bubble to
            // watchFileDrops, which attaches each file once for the whole chat.
            drop: (event) => (event.dataTransfer?.files.length ?? 0) > 0,
            paste: (event) => this.takeFiles(event.clipboardData) || this.onPaste(event),
            // Leaving the box (another bot clicked, the app closing) saves the draft now.
            blur: () => { if (this.draftTimer !== null) this.saveDraft(); return false; },
          }),
          this.label.of(EditorView.contentAttributes.of({ "aria-label": "" })),
          EditorView.contentAttributes.of({ enterkeyhint: this.enterMode.hint() }),
        ],
      }),
    });
    this.setWords();
    this.refreshSend();
  }

  /** Adds a CodeMirror extension (from a plugin); the returned function takes it out again. */
  addExtension(extension: Extension): () => void {
    const slot = new Compartment();
    this.view.dispatch({ effects: StateEffect.appendConfig.of(slot.of(extension)) });
    return () => this.view.dispatch({ effects: slot.reconfigure([]) });
  }

  /** A small floating box above the input box, at the caret (a formula preview, say). */
  showPopover(content: HTMLElement | string): () => void {
    this.popover?.remove();
    const box = document.createElement("div");
    box.className = "composer-popover";
    if (typeof content === "string") box.innerHTML = content;
    else box.append(content);
    document.body.append(box);
    const caret = this.view.coordsAtPos(this.view.state.selection.main.head);
    const top = this.root.getBoundingClientRect().top;
    box.style.left = `${Math.max(12, Math.min((caret?.left ?? 24) - 16, window.innerWidth - box.offsetWidth - 12))}px`;
    box.style.top = `${top - box.offsetHeight - 8}px`;
    this.popover = box;
    return () => {
      box.remove();
      if (this.popover === box) this.popover = null;
    };
  }

  insert(text: string): void {
    this.view.dispatch(this.view.state.replaceSelection(text));
    this.view.focus();
  }

  get text(): string {
    return this.view.state.doc.toString();
  }

  setText(text: string): void {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
  }

  focus(): void {
    this.view.focus();
  }

  /**
   * A block quoted into chat `key`'s input box (the Note's "ask about this block", `ccb.quote`): after what is there, a
   * blank line before and after it, the caret at the end. The chat on screen gets it as an edit of its own (undoable,
   * kept as its draft); another chat's kept draft gets it as the app's draft. False: nothing written (no text, or the
   * box does not know its chat yet).
   */
  quote(key: string, text: string, focus: boolean): boolean {
    if (this.draftKey === null || !key || !text.replace(/\n/g, "")) return false;
    if (key === this.draftKey) {
      const doc = this.view.state.doc.toString();
      const next = quoteAppend(doc, text);
      this.view.dispatch({ changes: { from: doc.length, insert: next.slice(doc.length) }, selection: { anchor: next.length }, userEvent: "input.paste", scrollIntoView: true });
      if (focus) this.view.focus();
      return true;
    }
    const next = quoteAppend(this.drafts.get(key)?.text ?? "", text);
    this.drafts.set(key, { text: next, cursor: next.length });
    post({ type: "draft", botID: key, text: next, cursor: next.length });
    return true;
  }

  /** The drafts the app kept (from before a restart); ones typed since the page loaded win. */
  setDrafts(saved: Record<string, Draft>): void {
    for (const [key, draft] of Object.entries(saved)) {
      if (this.drafts.has(key) || !draft?.text) continue;
      this.drafts.set(key, { text: draft.text, cursor: draft.cursor ?? draft.text.length });
      if (key === this.draftKey && this.text === "") this.restoreDraft(key);
    }
  }

  /** Another chat now: this one's draft is kept (and saved at once), the other's put back. */
  private switchDraft(key: string): void {
    if (key === this.draftKey) return;
    if (this.draftKey !== null) this.saveDraft();
    this.draftKey = key;
    this.drawSubmissionStatus();
    this.restoreDraft(key);
  }

  private restoreDraft(key: string): void {
    const draft = this.drafts.get(key) ?? { text: "", cursor: 0 };
    this.savedDraft = draft;
    // Not typing: marked remote so it is not saved back, and out of the undo history, which
    // starts again for this chat.
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: draft.text },
      selection: { anchor: Math.min(draft.cursor, draft.text.length) },
      annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
    });
    this.view.dispatch({ effects: this.historySlot.reconfigure([]) });
    this.view.dispatch({ effects: this.historySlot.reconfigure(history()) });
  }

  /** The text changed: kept in memory now, told to the app once typing pauses. */
  private draftChanged(): void {
    if (this.draftKey === null) return;
    if (!this.view.composing) this.drafts.set(this.draftKey, this.currentDraft());
    if (this.draftTimer !== null) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      // Still choosing a candidate: wait for the commit.
      if (this.view.composing) this.draftChanged();
      else this.saveDraft();
    }, draftDelay);
  }

  private currentDraft(): Draft {
    return { text: this.text, cursor: this.view.state.selection.main.head };
  }

  /** Tells the app this chat's draft (committed text only), when it changed. */
  private saveDraft(): void {
    if (this.draftTimer !== null) clearTimeout(this.draftTimer);
    this.draftTimer = null;
    const key = this.draftKey;
    if (key === null) return;
    const draft = this.view.composing ? this.drafts.get(key) ?? { text: "", cursor: 0 } : this.currentDraft();
    if (draft.text === "") this.drafts.delete(key);
    else this.drafts.set(key, draft);
    if (draft.text === this.savedDraft.text && draft.cursor === this.savedDraft.cursor) return;
    this.savedDraft = draft;
    post({ type: "draft", botID: key, text: draft.text, cursor: draft.cursor });
  }

  /**
   * Offers the names that start with what follows the "@" or "/" before the caret. A bare @
   * offers the short list; letters after @ search every bot (the short list's first); @@ lists
   * every bot, narrowed by what follows it.
   */
  private refreshMentions(): void {
    const head = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(head);
    const before = line.text.slice(0, head - line.from);
    const bots = this.allMentions.length > 0;
    // Like the app: an @ right after Chinese text counts; one inside a word (a@b) does not.
    const atAt = bots ? /(?:^|[^A-Za-z0-9_@])@@([^@\s]{0,40})$/.exec(before) : null;
    const at = (bots || composerHost?.searchFiles) && !atAt ? /(?:^|[^A-Za-z0-9_@])@([^@\s]{0,40})$/.exec(before) : null;
    // A / starts a word (after a space, a bracket or quote, or Chinese); a/b and ~/x are paths.
    const slash = !atAt && !at && this.slashItems.length ? slashQuery.exec(before) : null;
    const match = atAt ?? at ?? slash;
    const query = match ? match[1].toLowerCase() : null;
    // A bare / offers only the app's commands; the components wait for a letter.
    const items = atAt || (at && query) ? this.allMentions : at ? this.mentions
      : query ? this.slashItems : this.slashItems.filter((item) => item.kind === "command");
    // A name typed in full needs no list (Return then sends), unless it is a command that runs when picked.
    const complete = !atAt && query !== null && items.some((mention) => mention.name.toLowerCase() === query && !mention.command);
    const found = query === null || complete ? [] : items.filter((mention) => mention.name.toLowerCase().startsWith(query));
    if (at && query) {
      // The short list's names first.
      const short = new Set(this.mentions.map((mention) => mention.name.toLowerCase()));
      found.sort((a, b) => Number(short.has(b.name.toLowerCase())) - Number(short.has(a.name.toLowerCase())));
    }
    const fileKey = at && !complete && this.draftKey && composerHost?.searchFiles ? `${this.draftKey}:${head}:${query}` : "";
    if (fileKey !== this.fileQueryKey) {
      this.fileQueryKey = fileKey; this.previewKey = ""; this.preview = null; this.fileResults = []; this.fileError = false; this.fileLimited = false;
      this.fileLoading = !!fileKey; this.mentionActive = 0;
      if (this.fileTimer) clearTimeout(this.fileTimer);
      if (fileKey) {
        const botID = this.draftKey!;
        this.fileTimer = setTimeout(() => {
          if (this.fileQueryKey !== fileKey) return;
          void composerHost!.searchFiles!(botID, query ?? "").then(result => {
            if(this.fileQueryKey !== fileKey) return;
            this.fileResults = result.files; this.fileLimited = result.limited; this.fileLoading = false; this.refreshMentions();
          }, () => { if(this.fileQueryKey === fileKey) { this.fileLoading = false; this.fileError = true; this.refreshMentions(); } });
        }, 120);
      }
    }
    this.mentionMatches = atAt ? found : [...found.slice(0, slash ? SLASH_ROWS : 8),
      ...(fileKey ? this.fileResults.map(file => ({name: file.path, kind: "file" as const, file})) : [])];
    this.mentionFrom = match ? head - match[1].length - (atAt ? 2 : 1) : -1;
    this.mentionActive = Math.min(this.mentionActive, Math.max(0, this.mentionMatches.length - 1));
    this.mentionList.hidden = this.mentionMatches.length === 0 && !fileKey;
    this.mentionList.classList.toggle("slash", !!slash);
    this.mentionList.classList.toggle("with-files", !!fileKey);
    this.mentionList.setAttribute("role", fileKey ? "group" : "listbox");
    const previousPreview = this.mentionList.querySelector(".file-preview");
    const scrollTop = previousPreview?.scrollTop ?? 0;
    this.mentionList.innerHTML = "";
    const results = document.createElement("div"); results.className = "mention-results";
    if(fileKey) results.setAttribute("role", "listbox");
    this.mentionList.append(results);
    this.mentionMatches.forEach((mention, index) => {
      const option = document.createElement("button");
      option.setAttribute("role", "option");
      option.className = index === this.mentionActive ? "active" : "";
      const label = document.createElement("span");
      label.className = "mention-name";
      if(mention.kind === "file") {
        option.classList.add("mention-file"); option.title = mention.name;
        emphasizePath(label, mention.name, query ?? "");
        const tag = document.createElement("small"); tag.textContent = t("composer.kindFile"); option.append(tag);
      } else label.textContent = sigil(mention) + mention.name;
      option.setAttribute("aria-selected", String(index === this.mentionActive));
      option.append(label);
      if (mention.kind !== "bot" && mention.kind !== "file") {
        // No tag: a command keeps a faint hint of what it does, a component only its name.
        if (mention.about) {
          const hint = document.createElement("span");
          hint.className = "mention-hint";
          hint.textContent = mention.about;
          option.append(hint);
          option.title = mention.about;
        }
        const kind = mention.kind === "command" ? t("composer.kindCommand") : t("composer.kindComponent");
        option.setAttribute("aria-label", `/${mention.name}, ${mention.library ? t("composer.inLibrary", { kind }) : kind}`);
        if (mention.library) option.classList.add("library");
      }
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.pickMention(mention);
      });
      results.append(option);
      // @@ can list more than fit: keep the chosen one in view.
      if (index === this.mentionActive) option.scrollIntoView?.({ block: "nearest" });
    });
    if(fileKey) {
      if(this.fileLoading || this.fileError || this.fileLimited || !this.fileResults.length) {
        const status = document.createElement("div"); status.className = "file-picker-status"; status.setAttribute("role", "status");
        status.textContent = t(this.fileLoading ? "composer.filesLoading" : this.fileError ? "composer.filesUnavailable" : this.fileLimited ? "composer.filesLimited" : "composer.filesEmpty"); results.append(status);
      }
      const pane = document.createElement("pre"); pane.className = "file-preview"; pane.tabIndex = 0;
      pane.setAttribute("aria-label", t("composer.filePreview")); this.mentionList.append(pane);
      const file = this.mentionMatches[this.mentionActive]?.file;
      const previewKey = file ? `${this.draftKey}:${file.path}` : "";
      if(previewKey !== this.previewKey) {
        this.previewKey = previewKey; this.preview = null;
        if(file && composerHost?.previewFile) void composerHost.previewFile(this.draftKey!, file.path).then(preview => {
          if(this.previewKey !== previewKey || this.fileQueryKey !== fileKey) return;
          this.preview = preview; this.refreshMentions();
        }, () => { if(this.previewKey === previewKey && this.fileQueryKey === fileKey) { this.preview = {text:"",status:"unavailable"}; this.refreshMentions(); } });
      }
      if(!file) pane.textContent = t("composer.filePreview");
      else if(!this.preview) pane.textContent = t("composer.filesLoading");
      else {
        if(this.preview.status !== "text") { const note = document.createElement("div"); note.className = "file-picker-status"; note.textContent = t(this.preview.status === "binary" ? "composer.fileBinary" : this.preview.status === "truncated" ? "composer.fileTruncated" : "composer.filesUnavailable"); pane.append(note); }
        renderFilePreview(pane, this.preview.text);
      }
      if(previousPreview && previewKey === previousPreview.getAttribute("data-preview")) pane.scrollTop = scrollTop;
      pane.setAttribute("data-preview", previewKey);
    } else { this.previewKey = ""; this.preview = null; }
  }

  /** Return alone sends (Shift-Return is a new line); an input method's Return never does. On a phone's on-screen
   * keyboard Return is a new line and only the Send button sends (enter-mode.ts). */
  private enterKey(event: KeyboardEvent): boolean {
    if (!isSendEnter(event) || event.metaKey || event.ctrlKey || event.altKey) return false;
    if (!this.enterMode.sends()) return false;
    // Nothing to send: Return falls through to the keymap and is a new line, as before.
    if (!this.submit()) return false;
    event.preventDefault();
    return true;
  }

  /** Up/Down choose, Return or Tab put the name in, Escape closes the list. */
  private mentionKey(event: KeyboardEvent): boolean {
    if (this.mentionList.hidden) return false;
    if (this.mentionMatches.length === 0 && event.key !== "Escape") return false;
    if (isComposingKey(event) || isComposingEnter(event)) return false;
    // Shift-Return is a new line, Cmd-… a shortcut: not for the list.
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      this.mentionActive = (this.mentionActive + step + this.mentionMatches.length) % this.mentionMatches.length;
      this.refreshMentions();
    } else if (event.key === "Enter" || event.key === "Tab") {
      this.pickMention(this.mentionMatches[this.mentionActive]);
    } else if (event.key === "Escape") {
      this.fileQueryKey = ""; this.previewKey = "";
      this.mentionMatches = [];
      this.mentionList.hidden = true;
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  }

  private pickMention(mention: Mention): void {
    const head = this.view.state.selection.main.head;
    if (this.mentionFrom < 0) return;
    // Picked in the middle of a word: the rest of the word goes too.
    const line = this.view.state.doc.lineAt(head);
    const rest = /^[A-Za-z0-9_\-]*/.exec(line.text.slice(head - line.from))?.[0].length ?? 0;
    // A plugin's / command runs instead of going into the message: what was typed for it goes.
    const insert = mention.command ? "" : mention.file ? fileReference(mention.file.path, mention.file.url) : `${sigil(mention)}${mention.name} `;
    if (mention.command) post({ type: "runCommand", id: mention.command, via: "slash" });
    this.view.dispatch({ changes: { from: this.mentionFrom, to: head + rest, insert }, selection: { anchor: this.mentionFrom + insert.length } });
    this.mentionMatches = [];
    this.mentionList.hidden = true;
    this.view.focus();
  }

  /** The box's own words (buttons, the editor's label), again when the language changed. */
  private setWords(): void {
    if (this.wordsIn === language()) return;
    this.wordsIn = language();
    this.plus.setAttribute("aria-label", t("composer.addFiles"));
    this.sendButton.setAttribute("aria-label", t("composer.send"));
    this.view.dispatch({ effects: this.label.reconfigure(EditorView.contentAttributes.of({ "aria-label": t("composer.message") })) });
  }

  update(state: ChatState): void { this.submitPart.update(state); }
  submit(): boolean { return this.submitPart.submit(); }
  answerWithSaved(ack: { botID: string; requestID: number; chosen: string }): void { this.submitPart.answerWithSaved(ack); }
  private drawSubmissionStatus(): void { this.submitPart.drawSubmissionStatus(); }
  private answerKey(event: KeyboardEvent): boolean { return this.submitPart.answerKey(event); }
  private refreshSend(): void { this.submitPart.refreshSend(); }
  addChip(chip: ComposerChip): ChipHandle { return this.submitPart.addChip(chip); }
  chipsHere(): ChipHandle[] { return this.submitPart.chipsHere(); }

  /** Pasted or dropped files (screenshots too) go to Swift; plain text pastes as text. */
  takeFiles(data: DataTransfer | null): boolean {
    const files = data ? [...data.files] : [];
    if (files.length === 0) return false;
    for (const file of files) sendFile(file);
    return true;
  }
}

/** A plugin's chip above the input box (`composer.chips.add`). */
export interface ComposerChip {
  /** The chip and any buttons beside it, drawn in the row above the box (again on every redraw). */
  render(): Node;
  /** What it opens above the box, null while closed. */
  preview?(): Node | null;
  /** What goes after your words when you send (a blank line between). */
  serialize(): string;
  /** Sent, or removed. */
  onRemove?(): void;
}

export interface ChipHandle {
  /** Draws it again (after it changed). */
  update(): void;
  remove(): void;
}

/** "@codex rest" (or a head's label, or "@both") at the very start: that option, and the words after it. */
export function answerPrefix(text: string, answer: AnswerWithView): { id: string; rest: string } | null {
  const match = /^\s*@(\S+)\s+/.exec(text);
  if (!match) return null;
  const said = match[1].toLowerCase();
  const option = answer.options.find((option) => option.id.toLowerCase() === said || option.label.toLowerCase() === said);
  return option ? { id: option.id, rest: text.slice(match[0].length) } : null;
}

/** How many rows the / list shows at most. */
const SLASH_ROWS = 5;

/** Something the list offers: a bot (after @), or a command or component (after /). */
export interface Mention {
  name: string;
  kind: "bot" | "command" | "component" | "file";
  file?: ProjectFile;
  about?: string;
  /** A plugin's command, run when picked (plugin-platform.md §3.3 `slash`). */
  command?: string;
  /** A component on the shared library's shelf, not on this bot's own list. */
  library?: boolean;
}

function sigil(mention: Mention): string {
  return mention.kind === "bot" ? "@" : "/";
}

/** Each name once, in the order given (the first kind wins). */
function unique(entries: Mention[]): Mention[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = entry.name.toLowerCase();
    if (!entry.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Bots you can @ here, each once. */
function mentionsOf(names: string[] | undefined): Mention[] {
  return unique((names ?? []).map((name) => ({ name, kind: "bot" })));
}

/** The app's commands first, then the bot's own components, then the rest of the library. */
function slashItemsOf(state: ChatState): Mention[] {
  return unique([
    ...(state.slashCommands ?? []).map(({ name, about, command }): Mention => ({ name, kind: "command", about, ...(command ? { command } : {}) })),
    ...(state.slashComponents ?? []).map((name): Mention => ({ name, kind: "component" })),
    ...(state.slashLibrary ?? []).map((name): Mention => ({ name, kind: "component", about: t("composer.library"), library: true })),
  ]);
}

/** Reads a file in the page and hands it to Swift, which saves it and attaches it. */
export function sendFile(file: File): void {
  if (composerHost?.upload) { composerHost.upload(file); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const result = String(reader.result ?? "");
    const base64 = result.slice(result.indexOf(",") + 1);
    const name = file.name || `Pasted image.${file.type.split("/")[1] ?? "png"}`;
    post({ type: "addFileData", name, base64 });
  };
  reader.readAsDataURL(file);
}
