import { post } from "./bridge";
import { Composer, sendFile } from "./composer";
import { messageElement, typingElement } from "./messages";
import { PluginHost, type PluginSpec } from "./plugins";
import type { ChatState, MessageView } from "./types";

/**
 * The chat surface: messages and the input box, drawn from state the Swift side sends with
 * `deck.setState(...)`. Only messages that changed are redrawn, and the view stays at the bottom
 * unless you have scrolled up to read.
 */
class Chat {
  private readonly scroller: HTMLElement;
  private readonly list: HTMLElement;
  private readonly composer: Composer;
  private readonly drawn = new Map<string, { key: string; element: HTMLElement }>();
  private typing: HTMLElement | null = null;
  private botID: string | null = null;
  private last: ChatState | null = null;
  readonly plugins: PluginHost;

  constructor() {
    this.scroller = document.getElementById("scroller")!;
    this.list = document.getElementById("messages")!;
    this.composer = new Composer(document.getElementById("composer-slot")!);
    const composer = this.composer;
    this.plugins = new PluginHost({
      composer: {
        element: composer.root,
        view: composer.view,
        getText: () => composer.text,
        insert: (text) => composer.insert(text),
        addExtension: (extension) => composer.addExtension(extension),
        showPopover: (content) => composer.showPopover(content),
      },
      redraw: () => this.redraw(),
    });
    composer.onKey = (event) => this.plugins.handleKey(event);
    this.handleClicks();
    this.handleDrops();
  }

  /** Draws every message again, after a plugin changed how messages are drawn. */
  redraw(): void {
    this.drawn.clear();
    this.list.innerHTML = "";
    if (this.last) this.setState(this.last, true);
  }

  setState(state: ChatState, redrawing = false): void {
    this.last = state;
    const atBottom = redrawing || this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 80;
    const switched = state.botID !== this.botID;
    if (switched) {
      this.botID = state.botID;
      this.list.innerHTML = "";
      this.drawn.clear();
      this.composer.setText("");
    }

    const keep = new Set<string>();
    let previous: Element | null = null;
    for (const message of state.messages) {
      keep.add(message.id);
      // A stamp is part of the row it heads.
      const key = JSON.stringify([message, message.choices || message.display ? state.components : null]);
      let entry = this.drawn.get(message.id);
      if (!entry || entry.key !== key) {
        const element = this.render(message, state);
        if (entry) entry.element.replaceWith(element);
        entry = { key, element };
        this.drawn.set(message.id, entry);
      }
      const expected: Element | null = previous ? previous.nextElementSibling : this.list.firstElementChild;
      if (expected !== entry.element) {
        if (previous) previous.after(entry.element);
        else this.list.prepend(entry.element);
      }
      previous = entry.element;
    }
    for (const [id, entry] of this.drawn) {
      if (!keep.has(id)) {
        entry.element.remove();
        this.drawn.delete(id);
      }
    }

    this.typing?.remove();
    this.typing = state.working ? typingElement(state.avatar) : null;
    if (this.typing) this.list.append(this.typing);

    this.composer.update(state);
    if (switched || atBottom) this.scrollToBottom();
  }

  focus(): void {
    this.composer.focus();
  }

  private render(message: MessageView, state: ChatState): HTMLElement {
    const element = messageElement(message, state.components);
    if (!message.stamp) return element;
    const group = document.createElement("div");
    group.className = "stamped";
    group.innerHTML = `<div class="stamp"></div>`;
    group.querySelector(".stamp")!.textContent = message.stamp;
    group.append(element);
    return group;
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.scroller.scrollTop = this.scroller.scrollHeight;
    });
  }

  /** Chips, images and file chips open in Deck (the right column), not in the page. */
  private handleClicks(): void {
    document.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-url]");
      if (!target) return;
      event.preventDefault();
      post({ type: "openURL", url: target.dataset.url!, label: target.dataset.label || target.textContent?.trim() || "" });
    });
  }

  /** Files dropped anywhere on the chat are attached. */
  private handleDrops(): void {
    const body = document.body;
    body.addEventListener("dragover", (event) => {
      if (event.dataTransfer?.types.includes("Files")) {
        event.preventDefault();
        body.classList.add("dropping");
      }
    });
    body.addEventListener("dragleave", (event) => {
      if (event.target === body || !body.contains(event.relatedTarget as Node)) body.classList.remove("dropping");
    });
    body.addEventListener("drop", (event) => {
      body.classList.remove("dropping");
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      for (const file of event.dataTransfer.files) sendFile(file);
    });
  }
}

declare global {
  interface Window {
    deck: {
      setState(state: ChatState): void;
      setPlugins(specs: PluginSpec[]): Promise<void>;
      runCommand(id: string): void;
      hostReply(callID: number, ok: boolean, value: unknown): void;
      focus(): void;
    };
  }
}

const chat = new Chat();
window.deck = {
  setState: (state) => chat.setState(state),
  setPlugins: (specs) => chat.plugins.sync(specs),
  runCommand: (id) => chat.plugins.execute(id),
  hostReply: (callID, ok, value) => chat.plugins.hostReply(callID, ok, value),
  focus: () => chat.focus(),
};
post({ type: "ready" });
