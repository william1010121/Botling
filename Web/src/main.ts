import { post } from "./bridge";
import { keepFrames } from "./components";
import { Composer, sendFile } from "./composer";
import { extensions, feedback, messageElement, typingElement } from "./messages";
import { statusWord } from "./steps";
import { PinArea } from "./pins";
import { PluginHost, type PluginSpec } from "./plugins";
import type { ChatState, MessageView } from "./types";
import { escapeHTML } from "./util";

/** How close to the bottom (px) still counts as being at the bottom. */
const bottomSlack = 80;

/**
 * The chat surface: messages and the input box, drawn from state the Swift side sends with
 * `ccb.setState(...)`. Only messages that changed are redrawn, and the view stays at the bottom
 * unless you have scrolled up to read: whatever grows or shrinks later (a component's frame
 * sizing itself, an image loading, the input box) keeps it there too.
 */
class Chat {
  private readonly scroller: HTMLElement;
  private readonly list: HTMLElement;
  private readonly composer: Composer;
  /** Pinned components: chips above the input box, and the Board. */
  private readonly pins: PinArea;
  private readonly drawn = new Map<string, { key: string; element: HTMLElement }>();
  private typing: HTMLElement | null = null;
  private botID: string | null = null;
  private last: ChatState | null = null;
  /** Following the bottom of the chat; false once you scroll up to read. */
  private stuck = true;
  /** Where the view last was, to tell your scrolling from content changing size under it. */
  private lastTop = 0;
  /** The last message of the state drawn before, to notice one you just sent. */
  private newestID: string | null = null;
  readonly plugins: PluginHost;

  constructor() {
    this.scroller = document.getElementById("scroller")!;
    this.list = document.getElementById("messages")!;
    this.composer = new Composer(document.getElementById("composer-slot")!);
    this.pins = new PinArea(slot("pin-area", "div"), slot("board", "section"));
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
    this.followBottom();
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
    const switched = state.botID !== this.botID;
    const newestBefore = this.newestID;
    this.newestID = state.messages[state.messages.length - 1]?.id ?? null;
    if (switched) {
      this.botID = state.botID;
      this.list.innerHTML = "";
      this.drawn.clear();
      this.composer.setText("");
    }

    // Turning developer mode on or off redraws every reply with or without its flag.
    const flagged = !!state.feedback && !state.subagent;
    if (flagged !== feedback.enabled) {
      feedback.enabled = flagged;
      this.list.innerHTML = "";
      this.drawn.clear();
    }

    // Gone ones first, so they do not make the rest move (a moved frame reloads).
    const keep = new Set(state.messages.map((message) => message.id));
    for (const [id, entry] of this.drawn) {
      if (!keep.has(id)) {
        entry.element.remove();
        this.drawn.delete(id);
      }
    }
    let previous: Element | null = null;
    for (const message of state.messages) {
      // A stamp is part of the row it heads.
      const key = JSON.stringify([message, message.choices || message.displays || message.display || message.previews ? state.components : null]);
      let entry = this.drawn.get(message.id);
      if (!entry || entry.key !== key) {
        let element = this.render(message, state);
        if (entry) {
          // Components that did not change keep their frames, so they do not load again.
          const kept = keepFrames(entry.element, element);
          if (kept === element) entry.element.replaceWith(element);
          element = kept;
        }
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

    this.typing?.remove();
    this.typing = state.working ? typingElement(state.avatar, state.live ?? []) : null;
    if (this.typing) this.list.append(this.typing);

    this.showSubagentHeader(state);
    this.pins.update(state);
    this.composer.update(state);
    // Something you just sent always shows, even if you had scrolled up.
    const newest = state.messages[state.messages.length - 1];
    const sentNow = !switched && !redrawing && newest?.role === "user" && newest.id !== newestBefore;
    if (switched || sentNow) this.stuck = true;
    if (this.stuck) this.scrollToBottom();
  }

  focus(): void {
    this.composer.focus();
  }

  /**
   * Watching a subagent: a bar on top saying whose it is and how it is doing, with the way back.
   * There is nothing to type to a subagent, so the input box goes away meanwhile.
   */
  private showSubagentHeader(state: ChatState): void {
    let bar = document.getElementById("subagent-bar");
    document.body.classList.toggle("watching", !!state.subagent);
    if (!state.subagent) {
      bar?.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement("header");
      bar.id = "subagent-bar";
      document.body.prepend(bar);
    }
    const { title, owner, status, type } = state.subagent;
    bar.className = status;
    bar.innerHTML = `<button class="back" aria-label="Back to ${escapeHTML(owner)}'s chat">‹ ${escapeHTML(owner)}</button><div class="subagent-heading"><span class="title"></span><span class="meta"></span></div>`;
    bar.querySelector(".title")!.textContent = title;
    bar.querySelector(".meta")!.textContent = [`Subagent of ${owner}`, type, statusWord(status), "watch only"].filter(Boolean).join(" · ");
    bar.querySelector(".back")!.addEventListener("click", () => post({ type: "closeSubagent" }));
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
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.lastTop = this.scroller.scrollTop;
  }

  /**
   * Keeps the view on the bottom while it is stuck there. WebKit has no scroll anchoring, so
   * sizes are watched: when the messages or the scroller change size, a stuck view goes back to
   * the bottom; only scrolling up yourself unsticks it (even a little, so it does not pull you
   * back while you start to read).
   */
  private followBottom(): void {
    const readBack = () => { this.stuck = false; };
    this.scroller.addEventListener("wheel", (event) => { if (event.deltaY < 0) readBack(); }, { passive: true });
    this.scroller.addEventListener("keydown", (event) => {
      if (["PageUp", "Home", "ArrowUp"].includes(event.key)) readBack();
    });
    document.addEventListener("ccb-read-back", readBack);
    this.scroller.addEventListener("scroll", () => {
      const top = this.scroller.scrollTop;
      const distance = this.scroller.scrollHeight - top - this.scroller.clientHeight;
      // Back at the very bottom: follow it again. Dragging the scrollbar up far enough: stop.
      if (distance < 4) this.stuck = true;
      else if (top < this.lastTop && distance >= bottomSlack) this.stuck = false;
      this.lastTop = top;
    }, { passive: true });
    const observer = new ResizeObserver(() => {
      if (this.stuck) this.scrollToBottom();
    });
    observer.observe(this.list);
    observer.observe(this.scroller);
  }

  /** Chips, images and file chips open outside the page: web links in the browser, files in a window. */
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

/** An element of the page by id, made before the input box when the page has none. */
function slot(id: string, tag: string): HTMLElement {
  const found = document.getElementById(id);
  if (found) return found;
  const made = document.createElement(tag);
  made.id = id;
  const composer = document.getElementById("composer-slot");
  if (composer) composer.before(made);
  else document.body.append(made);
  return made;
}

declare global {
  interface Window {
    ccb: {
      setState(state: ChatState): void;
      setPlugins(specs: PluginSpec[]): Promise<void>;
      runCommand(id: string): void;
      showPanel(key: string): void;
      hostReply(callID: number, ok: boolean, value: unknown): void;
      focus(): void;
    };
  }
}

const chat = new Chat();

/**
 * Panel mode (`chat.html?panel=plugin/id`): the same page in the right column, showing one
 * plugin's panel instead of the chat. The panel is drawn as soon as its plugin registers it.
 */
let panelWanted: string | null = new URLSearchParams(location.search).get("panel");
let panelDispose: (() => void) | null = null;
if (panelWanted) document.body.classList.add("panel-mode");

function showPanel(key: string): void {
  panelWanted = key;
  drawPanel();
}

function drawPanel(): void {
  if (!panelWanted) return;
  const entry = extensions.panels.get(panelWanted);
  let root = document.getElementById("panel-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "panel-root";
    document.body.append(root);
  }
  if (!entry) {
    root.innerHTML = `<p class="panel-empty">This panel is not ready yet.</p>`;
    return;
  }
  panelDispose?.();
  root.innerHTML = "";
  const result = extensions.guard(entry.plugin, () => entry.render(root!));
  panelDispose = typeof result === "function" ? result : null;
}
chat.plugins.onPanels = () => drawPanel();
window.ccb = {
  setState: (state) => chat.setState(state),
  setPlugins: (specs) => chat.plugins.sync(specs),
  runCommand: (id) => chat.plugins.execute(id),
  hostReply: (callID, ok, value) => chat.plugins.hostReply(callID, ok, value),
  showPanel: (key) => showPanel(key),
  focus: () => chat.focus(),
};
post({ type: "ready" });
