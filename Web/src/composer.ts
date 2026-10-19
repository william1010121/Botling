import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent } from "@codemirror/commands";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { post } from "./bridge";
import { escapeHTML } from "./math";
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
    plus.setAttribute("aria-label", "加入圖片或檔案");
    plus.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
    plus.addEventListener("click", () => post({ type: "pickFiles" }));

    const editorHost = document.createElement("div");
    editorHost.className = "editor";
    this.sendButton = document.createElement("button");
    this.sendButton.className = "send";
    this.sendButton.setAttribute("aria-label", "送出");
    this.sendButton.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`;
    this.sendButton.addEventListener("click", () => this.submit());
    row.append(plus, editorHost, this.sendButton);
    this.root.append(this.replyBar, this.filesRow, row);
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
          }),
          // Ahead of every keymap: a key pressed while an input method is choosing (注音、拼音)
          // belongs to it, so Return commits the candidate instead of sending.
          Prec.highest(EditorView.domEventHandlers({
            keydown: (event, view) => event.isComposing || event.keyCode === 229 || view.composing,
          })),
          EditorView.domEventHandlers({
            paste: (event) => this.takeFiles(event.clipboardData),
          }),
          EditorView.contentAttributes.of({ "aria-label": "訊息" }),
        ],
      }),
    });
    this.refreshSend();
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

  update(state: ChatState): void {
    this.view.dispatch({ effects: this.placeholder.reconfigure(placeholderExtension(state.placeholder)) });

    if (state.replyingTo) {
      this.replyBar.hidden = false;
      this.replyBar.innerHTML = `<span class="reply-line"></span><span class="reply-text"><span class="reply-who">${escapeHTML(state.replyingTo.who)}</span><span class="reply-preview">${escapeHTML(state.replyingTo.preview)}</span></span><button class="close" aria-label="取消回覆">×</button>`;
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
      remove.setAttribute("aria-label", `移除 ${file.name}`);
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

/** Reads a file in the page and hands it to Swift, which saves it and attaches it. */
export function sendFile(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    const result = String(reader.result ?? "");
    const base64 = result.slice(result.indexOf(",") + 1);
    const name = file.name || `貼上的圖片.${file.type.split("/")[1] ?? "png"}`;
    post({ type: "addFileData", name, base64 });
  };
  reader.readAsDataURL(file);
}
