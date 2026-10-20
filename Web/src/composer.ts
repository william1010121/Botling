import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent } from "@codemirror/commands";
import { EditorState, Prec, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { post } from "./bridge";
import { escapeHTML } from "./util";
import type { ChatState } from "./types";

/**
 * The input box: CodeMirror 6, so editor plugins (laas and the like) work in it as they do on the
 * web. Return sends, Shift-Return adds a line, and Return while an input method is choosing a
 * candidate only commits the candidate.
 */
export class Composer {
  readonly root: HTMLElement;
  readonly view: EditorView;
  private readonly placeholder = new Compartment();
  private readonly replyBar: HTMLElement;
  private readonly filesRow: HTMLElement;
  private readonly sendButton: HTMLButtonElement;
  private hasFiles = false;
  /** Plugins see key presses first; returning true means a plugin handled it. */
  onKey: (event: KeyboardEvent) => boolean = () => false;
  private popover: HTMLElement | null = null;
  /**
   * What can be @-mentioned here: the bots of a group chat, then the chat's components (the bot
   * is told you mean that component). The list offers them as you type.
   */
  private mentions: Mention[] = [];
  private readonly mentionList: HTMLElement;
  private mentionMatches: Mention[] = [];
  private mentionActive = 0;
  /** Where the "@…" being typed starts. */
  private mentionFrom = -1;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "composer";
    this.replyBar = document.createElement("div");
    this.replyBar.className = "reply-bar";
    this.filesRow = document.createElement("div");
    this.filesRow.className = "pending-files";

    const row = document.createElement("div");
    row.className = "composer-row";
    const plus = document.createElement("button");
    plus.className = "plus";
    plus.setAttribute("aria-label", "Add images or files");
    plus.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
    plus.addEventListener("click", () => post({ type: "pickFiles" }));

    const editorHost = document.createElement("div");
    editorHost.className = "editor";
    this.sendButton = document.createElement("button");
    this.sendButton.className = "send";
    this.sendButton.setAttribute("aria-label", "Send");
    this.sendButton.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`;
    this.sendButton.addEventListener("click", () => this.submit());
    row.append(plus, editorHost, this.sendButton);
    this.mentionList = document.createElement("div");
    this.mentionList.className = "mention-list";
    this.mentionList.setAttribute("role", "listbox");
    this.mentionList.hidden = true;
    this.root.append(this.mentionList, this.replyBar, this.filesRow, row);
    parent.append(this.root);

    this.view = new EditorView({
      parent: editorHost,
      state: EditorState.create({
        extensions: [
          history(),
          EditorView.lineWrapping,
          this.placeholder.of(placeholderExtension("")),
          keymap.of([
            { key: "Enter", run: (view) => (view.composing ? false : this.submit()) },
            { key: "Shift-Enter", run: insertNewlineAndIndent },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) this.refreshSend();
            if (update.docChanged || update.selectionSet) this.refreshMentions();
          }),
          // Ahead of every keymap: a key pressed while an input method is choosing (Zhuyin, Pinyin)
          // belongs to it, so Return commits the candidate instead of sending.
          Prec.highest(EditorView.domEventHandlers({
            keydown: (event, view) => event.isComposing || event.keyCode === 229 || view.composing || this.mentionKey(event) || this.onKey(event),
          })),
          EditorView.domEventHandlers({
            paste: (event) => this.takeFiles(event.clipboardData),
          }),
          EditorView.contentAttributes.of({ "aria-label": "Message" }),
        ],
      }),
    });
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

  /** Offers the names that start with what follows the "@" before the caret. */
  private refreshMentions(): void {
    const head = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(head);
    const before = line.text.slice(0, head - line.from);
    // Like the app: an @ right after Chinese text counts; one inside a word (a@b) does not.
    const match = this.mentions.length ? /(?:^|[^A-Za-z0-9_])@([^@\n]{0,40})$/.exec(before) : null;
    const query = match ? match[1].toLowerCase() : null;
    // A name typed in full needs no list (Return then sends).
    const complete = query !== null && this.mentions.some((mention) => mention.name.toLowerCase() === query);
    this.mentionMatches = query === null || complete ? [] : this.mentions.filter((mention) => mention.name.toLowerCase().startsWith(query)).slice(0, 8);
    this.mentionFrom = match ? head - match[1].length - 1 : -1;
    this.mentionActive = Math.min(this.mentionActive, Math.max(0, this.mentionMatches.length - 1));
    this.mentionList.hidden = this.mentionMatches.length === 0;
    this.mentionList.innerHTML = "";
    this.mentionMatches.forEach((mention, index) => {
      const option = document.createElement("button");
      option.setAttribute("role", "option");
      option.className = index === this.mentionActive ? "active" : "";
      const label = document.createElement("span");
      label.className = "mention-name";
      label.textContent = "@" + mention.name;
      option.append(label);
      if (mention.kind === "component") {
        const kind = document.createElement("span");
        kind.className = "mention-kind";
        kind.textContent = "組件";
        option.append(kind);
        option.setAttribute("aria-label", `@${mention.name}, component`);
      }
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.pickMention(mention.name);
      });
      this.mentionList.append(option);
    });
  }

  /** Up/Down choose, Return or Tab put the name in, Escape closes the list. */
  private mentionKey(event: KeyboardEvent): boolean {
    if (this.mentionMatches.length === 0) return false;
    // Shift-Return is a new line, Cmd-… a shortcut: not for the list.
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      this.mentionActive = (this.mentionActive + step + this.mentionMatches.length) % this.mentionMatches.length;
      this.refreshMentions();
    } else if (event.key === "Enter" || event.key === "Tab") {
      this.pickMention(this.mentionMatches[this.mentionActive].name);
    } else if (event.key === "Escape") {
      this.mentionMatches = [];
      this.mentionList.hidden = true;
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  }

  private pickMention(name: string): void {
    const head = this.view.state.selection.main.head;
    if (this.mentionFrom < 0) return;
    // Picked in the middle of a word: the rest of the word goes too.
    const line = this.view.state.doc.lineAt(head);
    const rest = /^[A-Za-z0-9_\-]*/.exec(line.text.slice(head - line.from))?.[0].length ?? 0;
    const insert = `@${name} `;
    this.view.dispatch({ changes: { from: this.mentionFrom, to: head + rest, insert }, selection: { anchor: this.mentionFrom + insert.length } });
    this.mentionMatches = [];
    this.mentionList.hidden = true;
    this.view.focus();
  }

  update(state: ChatState): void {
    const mentions = mentionsOf(state);
    if (JSON.stringify(mentions) !== JSON.stringify(this.mentions)) {
      this.mentions = mentions;
      this.refreshMentions();
    }
    this.view.dispatch({ effects: this.placeholder.reconfigure(placeholderExtension(state.placeholder)) });

    if (state.replyingTo) {
      this.replyBar.hidden = false;
      this.replyBar.innerHTML = `<span class="reply-line"></span><span class="reply-text"><span class="reply-who">${escapeHTML(state.replyingTo.who)}</span><span class="reply-preview">${escapeHTML(state.replyingTo.preview)}</span></span><button class="close" aria-label="Cancel reply">×</button>`;
      this.replyBar.querySelector(".close")!.addEventListener("click", () => post({ type: "cancelReply" }));
    } else {
      this.replyBar.hidden = true;
      this.replyBar.innerHTML = "";
    }

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
      remove.setAttribute("aria-label", `Remove ${file.name}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => post({ type: "removeFile", id: file.id }));
      item.append(remove);
      this.filesRow.append(item);
    }
    this.refreshSend();
  }

  /** Sends what is typed (and any files). Returns true so Return does not also add a line. */
  submit(): boolean {
    const text = this.text;
    if (text.trim() === "" && !this.hasFiles) return true;
    post({ type: "send", text });
    this.setText("");
    return true;
  }

  private refreshSend(): void {
    this.sendButton.disabled = this.text.trim() === "" && !this.hasFiles;
  }

  /** Pasted or dropped files (screenshots too) go to Swift; plain text pastes as text. */
  takeFiles(data: DataTransfer | null): boolean {
    const files = data ? [...data.files] : [];
    if (files.length === 0) return false;
    for (const file of files) sendFile(file);
    return true;
  }
}

/** Something that can follow @: a bot of the group chat, or a component. */
interface Mention {
  name: string;
  kind: "bot" | "component";
}

/** The group's bots first, then components; each name once (a bot's name wins). */
function mentionsOf(state: ChatState): Mention[] {
  const seen = new Set<string>();
  const list: Mention[] = [];
  const add = (name: string, kind: Mention["kind"]) => {
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    list.push({ name, kind });
  };
  for (const name of state.mentions ?? []) add(name, "bot");
  for (const name of state.componentMentions ?? []) add(name, "component");
  return list;
}

/** Reads a file in the page and hands it to Swift, which saves it and attaches it. */
export function sendFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    const result = String(reader.result ?? "");
    const base64 = result.slice(result.indexOf(",") + 1);
    const name = file.name || `Pasted image.${file.type.split("/")[1] ?? "png"}`;
    post({ type: "addFileData", name, base64 });
  };
  reader.readAsDataURL(file);
}
