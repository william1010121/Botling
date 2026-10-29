import { setLanguage, t } from "./i18n";
import { post } from "./bridge";
import { buildNear, detailReply, keepFrames, releaseFrames } from "./components";
import { startTaskTicks, taskOutput } from "./tasks";
import { jumpToTask } from "./task-cards";
import { Composer, sendFile } from "./composer";
import { extensions, feedback, makeComponents, messageElement, refreshRetryNote, refreshThinkNote, typingElement, updateTypingElement } from "./messages";
import { SpecPanel } from "./spec";
import { fillSubagentBar, subagentLiveElement, subagentMessageElement } from "./subagent";
import { PinArea } from "./pins";
import { IntervalSummaries, onCatchUpToggle } from "./catchup";
import { FloatLayer } from "./float";
import { handleMediaClicks } from "./lightbox";
import { PluginHost, type PluginSpec } from "./plugins";
import type { ChatState, Draft, MessageView, SpecState, StatePatch } from "./types";
import { applyPatch } from "./patch";
import { escapeHTML } from "./util";
import { installImeGuard } from "./ime";
import { watchFileDrops } from "./drops";
import { reportVisiblePinsSoon, setWindowVisible } from "./visible";
import { animateSeenArrivals, setSeenHeads } from "./heads";
import { configureAnimatedHeads, refreshAvatarVisibility, updateAnimatedAvatars } from "./animated-avatar";

// Before anything listens for keys: an input method's Return never reaches a page handler.
installImeGuard(window);

/** How close to the bottom (px) still counts as being at the bottom. */
const bottomSlack = 80;
const historyPageSize = 50;
const historyWindowSize = historyPageSize * 3;
const historyTopSlack = 160;

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
  /** Unread messages folded on your return, with their summary. */
  private readonly catchUp = new IntervalSummaries();
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
  private typing = new Map<string, HTMLElement>();
  private thinkTimer: ReturnType<typeof setInterval> | null = null;
  private workerWaiting: HTMLElement | null = null;
  private botID: string | null = null;
  private subagentID: string | null = null;
  /** The loaded prefix grows only when reading back; incoming state keeps the same boundary. */
  private firstID: string | null = null;
  /** Navigation uses a moving window; ordinary recent-history pagination stays unchanged. */
  private navigatingHistory = false;
  private readonly historyLatest = document.createElement("button");
  private readonly historyMore = document.createElement("button");
  private historyRequest: number | null = null;
  private readingAnchor: { element: Element; top: number } | null = null;
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
    this.historyMore.type = "button";
    this.historyMore.className = "catchup-button history-more";
    this.historyMore.hidden = true;
    this.list.before(this.historyMore);
    this.historyMore.addEventListener("click", () => this.loadEarlier());
    this.historyLatest.type = "button";
    this.historyLatest.className = "catchup-button history-latest";
    this.historyLatest.hidden = true;
    this.list.after(this.historyLatest);
    this.historyLatest.addEventListener("click", () => {
      if (!this.last) return;
      this.firstID = null;
      this.stuck = true;
      this.readingAnchor = null;
      this.setState(this.last, true);
    });
    document.addEventListener("ccb-reveal-message", (event) => {
      const id: unknown = (event as CustomEvent).detail;
      if (typeof id === "string") this.revealMessage(id);
    });
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
    onCatchUpToggle(() => {
      if (this.last) this.catchUp.update(this.last, (id) => this.drawn.get(id)?.element ?? null);
    });
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
    this.typing.clear();
    if (this.thinkTimer) { clearInterval(this.thinkTimer); this.thinkTimer = null; }
    this.workerWaiting = null;
  }

  setState(state: ChatState, redrawing = false): void {
    const previousState = this.last;
    this.last = state;
    // Root style updates existing rows and the typing face without replacing their DOM.
    if (typeof state.chatAvatarSize === "number" && Number.isFinite(state.chatAvatarSize)) {
      document.documentElement.style.setProperty("--chat-avatar-size", `${Math.min(96, Math.max(32, Math.round(state.chatAvatarSize)))}px`);
    } else {
      document.documentElement.style.removeProperty("--chat-avatar-size");
    }
    const subagentID = state.subagent?.id ?? null;
    const switched = state.botID !== this.botID || subagentID !== this.subagentID;
    let animateArrivals = !switched && !redrawing;
    const newestBefore = this.newestID;
    this.newestID = state.messages[state.messages.length - 1]?.id ?? null;
    if (switched) {
      this.botID = state.botID;
      this.subagentID = subagentID;
      this.firstID = null;
      this.navigatingHistory = false;
      this.readingAnchor = null;
      if (this.historyRequest !== null) cancelAnimationFrame(this.historyRequest);
      this.historyRequest = null;
      this.clearList();
      // The input box keeps each chat's draft itself (Composer.update).
    }

    // Bot look Cute: the seen marks show the heads' tiny characters (a style rule, so lines drawn already follow).
    setSeenHeads(state.seenHeads);
    configureAnimatedHeads(state.animatedHeads);

    // An initially empty concurrent reply can become visible before the first shown row.
    // If the whole chat was visible, keep that newly visible reply in the window too.
    if (!this.navigatingHistory && this.firstID === previousState?.messages[0]?.id) {
      this.firstID = state.messages[0]?.id ?? null;
    }

    // Resolve a deleted boundary while retained rows still exist, before a settings redraw.
    if (this.firstID !== null) this.firstID = state.messages[this.historyStart(state.messages)]?.id ?? null;

    // A new language (Settings) draws every message again in its words.
    if (setLanguage(state.lang)) {
      this.clearList();
      animateArrivals = false;
    }

    // Turning developer mode on or off redraws every reply with or without its flag.
    const flagged = !!state.feedback && !state.subagent;
    const making = !!state.makeComponents && !state.subagent;
    if (flagged !== feedback.enabled || making !== makeComponents.enabled) {
      feedback.enabled = flagged;
      makeComponents.enabled = making;
      this.clearList();
      animateArrivals = false;
    }

    // Gone ones first, so they do not make the rest move (a moved frame reloads).
    const newest = state.messages[state.messages.length - 1];
    const sentNow = !switched && !redrawing && newest?.role === "user" && newest.id !== newestBefore;
    if (this.navigatingHistory && (sentNow || this.stuck)) this.firstID = null;
    const start = this.historyStart(state.messages);
    const end = this.navigatingHistory ? Math.min(state.messages.length, start + historyWindowSize) : state.messages.length;
    const messages = state.messages.slice(start, end);
    this.historyLatest.hidden = end === state.messages.length;
    this.historyLatest.textContent = t("catchup.latest", { line: newest?.text.replace(/\s+/g, " ").slice(0, 80) ?? "" });
    this.firstID = messages[0]?.id ?? null;
    this.historyMore.hidden = start === 0;
    this.historyMore.textContent = t("messages.loadEarlier", { n: Math.min(start, historyPageSize) });
    const keep = new Set(messages.map((message) => message.id));
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
    for (const message of messages) {
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
        if (animateArrivals) animateSeenArrivals(element, entry?.element);
        if (entry) {
          // A live verdict update keeps the disclosure choice and keyboard position.
          const oldVerification = entry.element.querySelector<HTMLElement>(".completion-verification > .verification-toggle");
          const newVerification = element.querySelector<HTMLElement>(".completion-verification > .verification-toggle");
          const verificationFocused = !!oldVerification && document.activeElement === oldVerification;
          if (oldVerification?.getAttribute("aria-expanded") === "true") newVerification?.click();
          // Components that did not change keep their frames, so they do not load again.
          const kept = keepFrames(entry.element, element);
          if (kept === element) entry.element.replaceWith(element);
          element = kept;
          if (verificationFocused) element.querySelector<HTMLElement>(".completion-verification > .verification-toggle")?.focus({ preventScroll: true });
        }
        entry = { key, element, message, mark };
        this.drawn.set(message.id, entry);
      }
      let expected: Element | null = previous ? previous.nextElementSibling : this.list.firstElementChild;
      // The catch-up card and end row sit between messages: step over them.
      while (expected && expected !== entry.element && expected.classList.contains("catchup-extra")) expected = expected.nextElementSibling;
      if (expected !== entry.element) {
        if (previous) previous.after(entry.element);
        else this.list.prepend(entry.element);
      }
      previous = entry.element;
    }

    this.catchUp.update(state, (id) => this.drawn.get(id)?.element ?? null);

    const runs = !state.working ? [] : !state.subagent && state.liveRuns ? state.liveRuns : [{
      id: "legacy", avatar: state.avatar, label: "", live: state.live ?? [],
      retrying: state.subagent ? null : state.retrying,
    }];
    const keepRuns = new Set(runs.map((run) => run.id));
    for (const [id, row] of this.typing) {
      if (!keepRuns.has(id)) { row.remove(); this.typing.delete(id); }
    }
    for (const run of runs) {
      let row = this.typing.get(run.id);
      if (row && !state.subagent && row.dataset.avatar === run.avatar) {
        updateTypingElement(row, run.live, run.retrying);
      } else {
        row?.remove();
        row = state.subagent ? subagentLiveElement(run.live) : typingElement(run.avatar, run.live, run.retrying);
        this.typing.set(run.id, row);
      }
      row.dataset.runId = run.id;
      if (run.label) row.setAttribute("aria-label", run.label);
      let label = row.querySelector<HTMLElement>(".live-run-label");
      if (run.label && !label) {
        label = document.createElement("div");
        label.className = "live-run-label speaker";
        let bubble = row.querySelector<HTMLElement>(".bubble");
        if (bubble?.classList.contains("dots")) {
          const dots = bubble;
          dots.classList.remove("bubble", "bot-bubble");
          bubble = document.createElement("div");
          bubble.className = "bubble bot-bubble working";
          dots.replaceWith(bubble);
          bubble.append(dots);
        }
        bubble?.prepend(label);
      }
      if (label) label.textContent = run.label;
    }
    // Preserve the nodes and their order when an unrelated run updates.
    let nextRow: HTMLElement | null = null;
    for (const run of [...runs].reverse()) {
      const row = this.typing.get(run.id)!;
      if (row.parentElement !== this.list || row.nextElementSibling !== nextRow) this.list.insertBefore(row, nextRow);
      nextRow = row;
    }
    // Each row keeps its own thinking clock. Retry text belongs only to its run.
    if (this.thinkTimer) { clearInterval(this.thinkTimer); this.thinkTimer = null; }
    if (runs.length && !state.subagent) {
      const refresh = () => {
        for (const run of runs) {
          const row = this.typing.get(run.id) ?? null;
          refreshThinkNote(row);
          refreshRetryNote(row, run.retrying);
        }
      };
      refresh();
      this.thinkTimer = setInterval(refresh, 1000);
    }
    // Workers have their own live cards. An idle coordinator has no thinking animation.
    if (state.waitingForWorkers && !state.working && !state.subagent) {
      if (!this.workerWaiting) {
        this.workerWaiting = document.createElement("div");
        this.workerWaiting.className = "worker-waiting";
        this.workerWaiting.setAttribute("role", "status");
      }
      this.workerWaiting.textContent = t("messages.waitingForWorkers");
      if (this.list.lastElementChild !== this.workerWaiting) this.list.append(this.workerWaiting);
    } else {
      this.workerWaiting?.remove();
      this.workerWaiting = null;
    }

    this.showSubagentHeader(state);
    this.pins.update(state);
    this.floats.update(state);
    this.composer.update(state);
    // Live activity belongs at the latest end, not after an older window.
    for (const row of this.typing.values()) row.style.display = this.historyLatest.hidden ? "" : "none";
    if (this.workerWaiting) this.workerWaiting.style.display = this.historyLatest.hidden ? "" : "none";
    // Something you just sent always shows, even if you had scrolled up.
    if (switched || sentNow) {
      this.stuck = true;
      this.readingAnchor = null;
    }
    if (this.stuck) this.scrollToBottom();
    updateAnimatedAvatars(state, animateArrivals);
    // The component frames now in view (or near it) are built; the rest once scrolled to.
    buildNear();
    if (!this.stuck) this.restoreReadingAnchor();
  }

  private historyStart(messages: MessageView[]): number {
    if (this.firstID !== null) {
      const index = messages.findIndex((message) => message.id === this.firstID);
      if (index >= 0) return index;
      // Deletion of the boundary keeps the next already mounted row as the boundary.
      const retained = messages.findIndex((message) => this.drawn.has(message.id));
      if (retained >= 0) return retained;
    }
    return Math.max(0, messages.length - historyPageSize);
  }

  /** Remember a visible row, rather than total height: content below it can resize too. */
  private rememberReadingAnchor(): void {
    const box = this.scroller.getBoundingClientRect();
    const element = [...this.list.children].find((row) => {
      const rect = row.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom;
    });
    this.readingAnchor = element ? { element, top: element.getBoundingClientRect().top - box.top } : null;
  }

  private restoreReadingAnchor(): void {
    const anchor = this.readingAnchor;
    if (!anchor?.element.isConnected) { this.readingAnchor = null; return; }
    const top = anchor.element.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top;
    this.scroller.scrollTop += top - anchor.top;
    this.lastTop = this.scroller.scrollTop;
  }

  private loadEarlier(): void {
    if (!this.last) return;
    const start = this.historyStart(this.last.messages);
    if (start === 0) return;
    this.stuck = false;
    this.rememberReadingAnchor();
    this.firstID = this.last.messages[Math.max(0, start - historyPageSize)].id;
    this.setState(this.last, true);
  }

  /** Coalesce wheel/key/scroll events; opening a chat never drains its history by itself. */
  private requestHistory(later = false): void {
    if (this.historyRequest !== null) return;
    this.historyRequest = requestAnimationFrame(() => {
      this.historyRequest = null;
      if (later) {
        if (!this.last || this.historyLatest.hidden || this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight > historyTopSlack) return;
        this.stuck = false;
        this.rememberReadingAnchor();
        const start = this.historyStart(this.last.messages);
        this.firstID = this.last.messages[Math.min(start + historyPageSize, this.last.messages.length - 1)].id;
        this.setState(this.last, true);
      } else if (!this.stuck && this.scroller.scrollTop <= historyTopSlack) this.loadEarlier();
    });
  }

  /** Quotes, task links and summary sources can name rows outside the mounted window. */
  private revealMessage(id: string): void {
    if (!this.last || this.drawn.has(id)) return;
    const index = this.last.messages.findIndex((message) => message.id === id);
    if (index < 0) return;
    this.stuck = false;
    this.readingAnchor = null;
    this.navigatingHistory = true;
    this.firstID = this.last.messages[Math.max(0, index - historyPageSize)].id;
    this.setState(this.last, true);
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

  answerWithSaved(ack: { botID: string; requestID: number; chosen: string }): void {
    this.composer.answerWithSaved(ack);
  }

  /**
   * Watching a subagent: a bar on top saying whose it is, what runs it and how it is doing, with
   * the way back. There is nothing to type to a subagent, so the input box goes away meanwhile.
   */
  private showSubagentHeader(state: ChatState): void {
    let bar = document.getElementById("subagent-bar");
    document.body.classList.toggle("watching", !!state.subagent);
    const slot = document.getElementById("composer-slot");
    if (slot) slot.hidden = !!state.subagent;
    if (!state.subagent) {
      bar?.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement("header");
      bar.id = "subagent-bar";
      document.body.prepend(bar);
    }
    fillSubagentBar(bar, state.subagent);
  }

  private render(message: MessageView, state: ChatState): HTMLElement {
    const element = state.subagent ? subagentMessageElement(message) : messageElement(message, state.components);
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
    const readBack = () => { this.stuck = false; this.readingAnchor = null; };
    this.scroller.addEventListener("wheel", (event) => {
      this.readingAnchor = null;
      if (event.deltaY < 0) { readBack(); this.requestHistory(); }
      else if (event.deltaY > 0) this.requestHistory(true);
    }, { passive: true });
    this.scroller.addEventListener("pointerdown", () => { this.readingAnchor = null; }, { passive: true });
    this.scroller.addEventListener("keydown", (event) => {
      this.readingAnchor = null;
      if (["PageUp", "Home", "ArrowUp"].includes(event.key)) { readBack(); this.requestHistory(); }
      else if (["PageDown", "End", "ArrowDown"].includes(event.key)) this.requestHistory(true);
    });
    document.addEventListener("ccb-read-back", readBack);
    this.scroller.addEventListener("scroll", () => {
      const top = this.scroller.scrollTop;
      const distance = this.scroller.scrollHeight - top - this.scroller.clientHeight;
      // Back at the very bottom: follow it again. Dragging the scrollbar up far enough: stop.
      if (distance < 4 && this.historyLatest.hidden) this.stuck = true;
      else if (top < this.lastTop && distance >= bottomSlack) this.stuck = false;
      if (top !== this.lastTop) this.readingAnchor = null;
      if (!this.stuck && top < this.lastTop && top <= historyTopSlack) this.requestHistory();
      if (top > this.lastTop && distance <= historyTopSlack) this.requestHistory(true);
      this.lastTop = top;
    }, { passive: true });
    const observer = new ResizeObserver(() => {
      if (this.stuck) this.scrollToBottom();
      else this.restoreReadingAnchor();
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
    watchFileDrops(document.body, sendFile);
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
      answerWithSaved(ack: { botID: string; requestID: number; chosen: string }): void;
      patchState(patch: StatePatch): void;
      setPlugins(specs: PluginSpec[]): Promise<void>;
      runCommand(id: string): void;
      showPanel(key: string): void;
      setSpec(state: SpecState): void;
      hostReply(callID: number, ok: boolean, value: unknown): void;
      detailReply(requestID: number, ok: boolean, value: string): void;
      taskOutput(messageID: string, taskID: string, text: string): void;
      /** "Jump to chat" on a task's card in the right panel: its latest reply, or the summary that folds it. */
      jumpToTask(messageID: string, taskID: string): void;
      focus(): void;
      /** Whether the app's window is shown (not minimized, hidden or fully covered). */
      setWindowVisible(visible: boolean): void;
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
  setState: (state) => {
    chat.setState(state);
    reportVisiblePinsSoon();
  },
  setDrafts: (drafts) => chat.setDrafts(drafts),
  answerWithSaved: (ack) => chat.answerWithSaved(ack),
  patchState: (patch) => {
    chat.patchState(patch);
    reportVisiblePinsSoon();
  },
  setPlugins: (specs) => chat.plugins.sync(specs),
  runCommand: (id) => chat.plugins.execute(id),
  hostReply: (callID, ok, value) => chat.plugins.hostReply(callID, ok, value),
  detailReply: (requestID, ok, value) => detailReply(requestID, ok, value),
  taskOutput: (messageID, taskID, text) => taskOutput(messageID, taskID, text),
  jumpToTask: (messageID, taskID) => jumpToTask(messageID, taskID),
  showPanel: (key) => showPanel(key),
  setSpec: (state) => setSpec(state),
  focus: () => chat.focus(),
  setWindowVisible: (visible) => { setWindowVisible(visible); refreshAvatarVisibility(); },
};
// Which pins the user can see changes as the chat or Board scrolls, the window resizes, or a pin
// is opened or closed: Swift's timer reruns only those (visible.ts).
for (const type of ["scroll", "resize", "click", "visibilitychange"]) {
  (type === "resize" ? window : document).addEventListener(type, reportVisiblePinsSoon, { capture: true, passive: true });
}
startTaskTicks();
post({ type: "ready" });
