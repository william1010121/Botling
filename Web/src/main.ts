import { setLanguage, t } from "./i18n";
import { post } from "./bridge";
import { buildNear, detailReply, keepFrames, releaseFrames } from "./components";
import { startTaskTicks, taskOutput } from "./tasks";
import { Composer, sendFile } from "./composer";
import { extensions, feedback, makeComponents, messageElement, typingElement } from "./messages";
import { SpecPanel } from "./spec";
import { statusWord } from "./steps";
import { PinArea } from "./pins";
import { FloatLayer } from "./float";
import { handleMediaClicks } from "./lightbox";
import { PluginHost, type PluginSpec } from "./plugins";
import type { ChatState, Draft, MessageView, SpecState, StatePatch } from "./types";
import { applyPatch } from "./patch";
import { escapeHTML } from "./util";
import { installImeGuard } from "./ime";

// Before anything listens for keys: an input method's Return never reaches a page handler.
installImeGuard(window);

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
  /** Pins floated in a corner of this chat (and other bots' shown in all bots), over the chat and the Board. */
  private readonly floats: FloatLayer;
  /**
   * Each message drawn: its element, and the key it was drawn from. `message` and `mark` are what
   * the key was made of, so an update that hands back the same message object (`patchState`)
   * skips making the key again.
   */
  private readonly drawn = new Map<string, { key: string; element: HTMLElement; message: MessageView; mark: number }>();
  /**
   * The components as text, and a number that changes whenever that text does: a message that
   * draws components is redrawn when they change, by the number in its key. (Putting the text
   * itself in every such message's key copied ~180 KB per message on every update.)
   */
  private componentsText = "";
  private componentsMark = 0;
  /** The components object `componentsText` was made from (a patch hands the same one back). */
  private componentsSeen: unknown = null;
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
    this.floats = new FloatLayer(document.body);
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
    this.clearList();
    if (this.last) this.setState(this.last, true);
  }

  /** Every message gone from the page (another bot's chat, or all drawn again). */
  private clearList(): void {
    releaseFrames(this.list);
    this.list.innerHTML = "";
    this.drawn.clear();
  }

  setState(state: ChatState, redrawing = false): void {
    this.last = state;
    const switched = state.botID !== this.botID;
    const newestBefore = this.newestID;
    this.newestID = state.messages[state.messages.length - 1]?.id ?? null;
    if (switched) {
      this.botID = state.botID;
      this.clearList();
      // The input box keeps each chat's draft itself (Composer.update).
    }

    // A new language (Settings) draws every message again in its words.
    if (setLanguage(state.lang)) this.clearList();

    // Turning developer mode on or off redraws every reply with or without its flag.
    const flagged = !!state.feedback && !state.subagent;
    const making = !!state.makeComponents && !state.subagent;
    if (flagged !== feedback.enabled || making !== makeComponents.enabled) {
      feedback.enabled = flagged;
      makeComponents.enabled = making;
      this.clearList();
    }

    // Gone ones first, so they do not make the rest move (a moved frame reloads).
    const keep = new Set(state.messages.map((message) => message.id));
    for (const [id, entry] of this.drawn) {
      if (!keep.has(id)) {
        releaseFrames(entry.element);
        entry.element.remove();
        this.drawn.delete(id);
      }
    }
    if (state.components !== this.componentsSeen) {
      this.componentsSeen = state.components;
      const componentsText = JSON.stringify(state.components);
      if (componentsText !== this.componentsText) {
        this.componentsText = componentsText;
        this.componentsMark += 1;
      }
    }
    let previous: Element | null = null;
    for (const message of state.messages) {
      let entry = this.drawn.get(message.id);
      const mark = message.choices || message.displays || message.display || message.previews ? this.componentsMark : -1;
      // The very message drawn last time, with the same components: nothing to do.
      const same = !!entry && entry.message === message && entry.mark === mark;
      // A stamp is part of the row it heads.
      const key = same ? entry!.key : JSON.stringify([message, mark < 0 ? null : mark]);
      if (entry && entry.key === key) {
        entry.message = message;
        entry.mark = mark;
      } else {
        let element = this.render(message, state);
        if (entry) {
          // Components that did not change keep their frames, so they do not load again.
          const kept = keepFrames(entry.element, element);
          if (kept === element) entry.element.replaceWith(element);
          element = kept;
        }
        entry = { key, element, message, mark };
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
    this.floats.update(state);
    this.composer.update(state);
    // Something you just sent always shows, even if you had scrolled up.
    const newest = state.messages[state.messages.length - 1];
    const sentNow = !switched && !redrawing && newest?.role === "user" && newest.id !== newestBefore;
    if (switched || sentNow) this.stuck = true;
    if (this.stuck) this.scrollToBottom();
    // The component frames now in view (or near it) are built; the rest once scrolled to.
    buildNear();
  }

  /** An update with only what changed (see `StatePatch`); asks for everything when it cannot. */
  patchState(patch: StatePatch): void {
    const state = applyPatch(this.last, patch);
    if (state) this.setState(state);
    else post({ type: "resync" });
  }

  focus(): void {
    this.composer.focus();
  }

  setDrafts(drafts: Record<string, Draft>): void {
    this.composer.setDrafts(drafts);
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
    bar.innerHTML = `<button class="back" aria-label="${escapeHTML(t("subagent.back", { bot: owner }))}">‹ ${escapeHTML(owner)}</button><div class="subagent-heading"><span class="title"></span><span class="meta"></span></div>`;
    bar.querySelector(".title")!.textContent = title;
    bar.querySelector(".meta")!.textContent = [t("subagent.of", { bot: owner }), type, statusWord(status), t("subagent.watchOnly")].filter(Boolean).join(" · ");
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

  /** Pictures open in a lightbox over the chat; other chips and files open outside the page. */
  private handleClicks(): void {
    handleMediaClicks(document);
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
      /** The drafts the app kept, by chat: sent once when the page loads. */
      setDrafts(drafts: Record<string, Draft>): void;
      patchState(patch: StatePatch): void;
      setPlugins(specs: PluginSpec[]): Promise<void>;
      runCommand(id: string): void;
      showPanel(key: string): void;
      setSpec(state: SpecState): void;
      hostReply(callID: number, ok: boolean, value: unknown): void;
      detailReply(requestID: number, ok: boolean, value: string): void;
      taskOutput(messageID: string, taskID: string, text: string): void;
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
    root.innerHTML = `<p class="panel-empty">${escapeHTML(t("panel.notReady"))}</p>`;
    return;
  }
  panelDispose?.();
  root.innerHTML = "";
  const result = extensions.guard(entry.plugin, () => entry.render(root!));
  panelDispose = typeof result === "function" ? result : null;
}
chat.plugins.onPanels = () => drawPanel();

/**
 * Spec mode (`chat.html?spec=1`): the same page in the right panel, showing the component spec
 * workspace (`spec.ts`) instead of the chat.
 */
let specPanel: SpecPanel | null = null;
if (new URLSearchParams(location.search).has("spec")) document.body.classList.add("spec-mode");
function setSpec(state: SpecState): void {
  setLanguage(state.lang);
  if (!specPanel) {
    let root = document.getElementById("spec-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "spec-root";
      document.body.append(root);
    }
    specPanel = new SpecPanel(root);
  }
  specPanel.update(state);
}
window.ccb = {
  setState: (state) => chat.setState(state),
  setDrafts: (drafts) => chat.setDrafts(drafts),
  patchState: (patch) => chat.patchState(patch),
  setPlugins: (specs) => chat.plugins.sync(specs),
  runCommand: (id) => chat.plugins.execute(id),
  hostReply: (callID, ok, value) => chat.plugins.hostReply(callID, ok, value),
  detailReply: (requestID, ok, value) => detailReply(requestID, ok, value),
  taskOutput: (messageID, taskID, text) => taskOutput(messageID, taskID, text),
  showPanel: (key) => showPanel(key),
  setSpec: (state) => setSpec(state),
  focus: () => chat.focus(),
};
startTaskTicks();
post({ type: "ready" });
