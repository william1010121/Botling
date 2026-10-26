// The chat frame (app://botling/chat.html): the Swift app's chat page from Web/src, unchanged,
// fed with state by the app page. On top of it the desktop adds what the page does not have yet:
// Phase 0's sandboxed cards in their bubbles, a Stop button in the input box, and KaTeX (the
// ccb-latex plugin, bundled in).
import { observeTraceEditor } from "./input-trace-chat";
import { inputTrace } from "../input-trace";
import "./shim";
import "./component-frames";
import { installInputRecovery } from "./input-focus";
import { setSummaryCountable } from "../../../../Web/src/catchup";
import { isSummaryReply } from "../../contract/summary";
import "../../../../Web/src/main";
import { installMessageWidth } from "./message-width";
import { EditorView } from "@codemirror/view";
import { CardBroker, type CardTarget } from "../broker";
import type { FrameExtras } from "../payload";
import { type FrameMessage } from "./protocol";
import { toShell, fromShell, nativeChat, installNativeShellCommands } from "./transport";
import { setMediaSource } from "../../../../Web/src/markdown";
import { localMediaSource } from "../../contract/attachment-url";
import { keepDraft, keptDrafts, pageDraftStore } from "./draft-keep";

declare const __LATEX_SOURCE__: string;

setSummaryCountable(isSummaryReply);
observeTraceEditor();
// Local media comes from the currently shown chat's authenticated origin.
let shownChat: string | undefined;
setMediaSource((url) => localMediaSource(shownChat, url));
installNativeShellCommands();
// Reload Chat Page: the drafts this tab kept come back (the chat itself comes back from the core
// through the shell's next state). The one being typed is kept as the old document goes away, so the
// composer's half-second save delay cannot lose the last words.
if (nativeChat) {
  const store = pageDraftStore();
  const kept = keptDrafts(store);
  if (Object.keys(kept).length) window.ccb.setDrafts(kept);
  window.addEventListener("pagehide", () => {
    const chat = document.documentElement.dataset.chat, view = composerView();
    if (chat && view && !view.composing) keepDraft(store, chat, { text: view.state.doc.toString(), cursor: view.state.selection.main.head });
  });
}
const column = installMessageWidth((value) => toShell({ botling: "messageWidth", value }), (active) => toShell({ botling: "messageWidthDrag", active }));

// ---------------------------------------------------------------------------------------------
// Card requests go to the app page, which owns the contract client.

let nextRequest = 0;
const waiting = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
function request(cmd: Extract<FrameMessage, { botling: "request" }>["cmd"]): Promise<void> {
  const id = ++nextRequest;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    if (!toShell({ botling: "request", id, cmd })) { waiting.delete(id); reject(new Error("Editor disconnected")); }
  });
}

const broker = new CardBroker({
  save: (target, data) => request({ type: "card.save", botId: target.botId, messageId: target.messageId, cardId: target.cardId, data }),
  action: (target, name, value) => request({ type: "card.action", botId: target.botId, messageId: target.messageId, cardId: target.cardId, name, value }),
});
// For end-to-end tests and diagnostics: what the broker refused and accepted.
(window as unknown as { __botlingBroker: CardBroker }).__botlingBroker = broker;

interface DrawnCard { element: HTMLElement; target: CardTarget; unregister: () => void; data: string | null; loaded: boolean }
const cards = new Map<string, DrawnCard>();

function cardElement(botId: string, messageId: string, cardId: string): DrawnCard {
  const element = document.createElement("div");
  element.className = "card";
  element.dataset.card = cardId;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = "Card";
  frame.style.height = "80px";
  frame.src = `botling-card://card/${encodeURIComponent(botId)}/${encodeURIComponent(messageId)}/${encodeURIComponent(cardId)}`;
  element.append(frame);
  const target: CardTarget = { botId, messageId, cardId, frame, onSize: (height) => { frame.style.height = `${Math.max(40, Math.min(height, 900))}px`; } };
  const drawn: DrawnCard = { element, target, unregister: broker.register(target), data: null, loaded: false };
  // A frame loads again when its element moves (the page redrew the message): send its data again.
  frame.addEventListener("load", () => { drawn.loaded = true; broker.sendData(target, drawn.data); });
  return drawn;
}

let lastExtras: FrameExtras | null = null;
let decorateQueued = false;
/**
 * The page redraws rows by itself too (a plugin loading, the language changing): whenever its
 * list of rows changes, the cards and states go back on.
 */
function watchRows() {
  const list = document.getElementById("messages");
  if (!list) return;
  new MutationObserver(() => {
    if (decorateQueued || !lastExtras) return;
    decorateQueued = true;
    queueMicrotask(() => { decorateQueued = false; if (lastExtras) decorate(lastExtras); });
  }).observe(list, { childList: true });
}
watchRows();

/** Puts each message's cards in its bubble, and its turn state on its row. */
function decorate(extras: FrameExtras) {
  lastExtras = extras;
  const list = document.getElementById("messages");
  if (!list) return;
  document.body.classList.toggle("botling-running", extras.running);
  for (const row of list.querySelectorAll<HTMLElement>(".row[data-id]")) {
    const state = extras.states[row.dataset.id!];
    if (state) row.dataset.state = state;
    else delete row.dataset.state;
  }
  const keep = new Set<string>();
  for (const [messageId, list_] of Object.entries(extras.cards)) {
    const row = list.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(messageId)}"]`);
    const host = row?.querySelector<HTMLElement>(".bot-bubble, .notice-bubble");
    if (!host) continue;
    for (const card of list_) {
      const key = `${extras.botId}/${messageId}/${card.id}`;
      keep.add(key);
      let drawn = cards.get(key);
      if (!drawn) {
        drawn = cardElement(extras.botId, messageId, card.id);
        cards.set(key, drawn);
      }
      if (drawn.element.parentElement !== host) host.append(drawn.element);
      if (drawn.data !== card.data) {
        drawn.data = card.data;
        if (drawn.loaded) broker.sendData(drawn.target, card.data);
      }
    }
  }
  for (const [key, drawn] of cards) {
    if (keep.has(key)) continue;
    drawn.unregister();
    drawn.element.remove();
    cards.delete(key);
  }
}

// ---------------------------------------------------------------------------------------------

let stateRevision = 0;
fromShell(message => {
  if (!message || typeof message !== "object") return;
  if (message.botling === "state") {
    // Words typed before the first state (the first second after the window opens) would be replaced
    // by that chat's draft (empty) when the box switches to it: they are put back.
    inputTrace()?.mark("frame.state.receive", () => ({ traceId: message.traceId, chat: message.state.botID,
      previousChat: document.documentElement.dataset.chat, ...inputTrace()!.snapshot() }));
    const early = !nativeChat && document.documentElement.dataset.chat === undefined ? typedSoFar() : null;
    inputTrace()?.mark("frame.early.snapshot", () => ({ early, ...inputTrace()!.snapshot() }));
    column.set(message.messageColumnWidth ?? null, message.state.botID);
    // The chat the page draws, before it draws it (its local pictures are asked for as this bot's).
    shownChat = message.state.botID;
    window.ccb.setState(message.state);
    inputTrace()?.mark("frame.state.applied", () => inputTrace()!.snapshot());
    if (early) keepTyped(early);
    // Which chat the page shows (the input box keeps a draft per chat, so typing before the first
    // state would be replaced by that chat's draft); tests wait for it.
    document.documentElement.dataset.chat = message.state.botID;
    inputTrace()?.mark("frame.state.complete", () => inputTrace()!.snapshot());
    decorate(message.extras);
    if (nativeChat) {
      // Initial focus is set in this root document before main reveals its native surface.
      if (stateRevision === 0) window.ccb.focus();
      toShell({ botling: "hostObservation", chatId: message.state.botID, intentEpoch: 0, revision: ++stateRevision });
    }
  } else if (message.botling === "widthRejected") {
    column.rejected(message.value, message.actual);
  } else if (message.botling === "widthPreview") {
    column.preview(message.value);
  } else if (message.botling === "messageWidthPointer") {
    column.pointer(message.kind, message.pointerId, message.x);
  } else if (message.botling === "answerWithSaved") {
    window.ccb.answerWithSaved({ botID: message.botID, requestID: message.requestID, chosen: message.chosen });
  } else if (message.botling === "plugins") {
    void setPlugins(message.specs);
  } else if (message.botling === "hostReply") {
    window.ccb.hostReply(message.callID, message.ok, message.value);
  } else if (message.botling === "recoverFocus") {
    inputTrace()?.mark("frame.recover.receive", () => ({ traceId: message.traceId, ...inputTrace()!.snapshot() }));
    takeFocusBack();
  } else if (message.botling === "focus") {
    window.ccb.focus();
  } else if (message.botling === "spec") {
    window.ccb.setSpec(message.spec);
  } else if (message.botling === "jumpToTask") {
    window.ccb.jumpToTask(message.messageID, message.taskID);
  } else if (message.botling === "taskOutput") {
    if (document.documentElement.dataset.chat === message.botID) window.ccb.taskOutput(message.messageID, message.taskID, message.text);
  } else if (message.botling === "detailReply") {
    window.ccb.detailReply(message.requestID, message.ok, message.value);
  } else if (message.botling === "response") {
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    if (message.ok) entry.resolve();
    else entry.reject(new Error(message.error ?? "refused"));
  }
});

// ---------------------------------------------------------------------------------------------
// The input box before the first state (Web/src's Composer keeps drafts per chat only once it knows
// the chat; what was typed before is not anyone's draft yet).

function composerView(): EditorView | null {
  const dom = document.querySelector<HTMLElement>(".composer .cm-editor");
  return dom ? EditorView.findFromDOM(dom) : null;
}

function typedSoFar(): { text: string; cursor: number } | null {
  const view = composerView();
  const text = view?.state.doc.toString() ?? "";
  return view && text ? { text, cursor: view.state.selection.main.head } : null;
}

function keepTyped(early: { text: string; cursor: number }) {
  const view = composerView();
  inputTrace()?.mark("frame.keepTyped.before", () => ({ early, willRestore: !!view && view.state.doc.toString() === "", ...inputTrace()!.snapshot() }));
  if (!view || view.state.doc.toString() !== "") return;
  // As typing (not marked remote), so the box keeps it as this chat's draft.
  view.dispatch({ changes: { from: 0, insert: early.text }, selection: { anchor: Math.min(early.cursor, early.text.length) }, userEvent: "input.type" });
  inputTrace()?.mark("frame.keepTyped.after", () => inputTrace()!.snapshot());
}

const takeFocusBack = nativeChat ? () => false : installInputRecovery(composerView, toShell);

nativeChat?.subscribe(packet => {
  if ("unbound" in packet) {
    for (const entry of waiting.values()) entry.reject(new Error("Editor disconnected"));
    waiting.clear();
  } else if ("bound" in packet) {
    // Web/src may have announced ready before main could authenticate the two loaded roots.
    // Rebind only refreshes business state; the live editor, history and composition stay intact.
    toShell({ botling: "action", action: { type: "ready" } });
  }
});

// Escape stops a reply being written, as in a terminal. (There is no Stop button: a message sent while
// it writes never stops it, the bot hears it and carries on.)
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("botling-running") && !event.isComposing) toShell({ botling: "stop" });
});

// LaTeX in messages: the ccb-latex plugin, bundled in (its stylesheet and fonts sit beside chat.html).
const latex = {
  name: "ccb-latex",
  version: "1.0.0",
  source: __LATEX_SOURCE__,
  styles: [new URL("plugins/ccb-latex/katex.min.css", location.href).toString()],
  settings: { "ccb-latex.preview": true, "ccb-latex.copyTeX": true },
  commands: [{ id: "ccb-latex.insert", title: "Insert inline formula", key: "cmd+shift+m" }],
};
/**
 * Plugins' web parts run here as in 1.x (Phase 4a: this page has an origin of its own, so they reach
 * neither the app page's document nor its bridge). A plugin of the library named like the bundled one
 * does not replace it.
 */
function setPlugins(specs: { name: string; version: string; source: string; styles: string[]; settings: Record<string, unknown>; commands: { id: string; title: string; key?: string }[] }[]) {
  return window.ccb.setPlugins([latex, ...specs.filter((spec) => spec.name !== latex.name)]);
}
void setPlugins([]);
