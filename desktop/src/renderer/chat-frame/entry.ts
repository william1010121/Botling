// The chat frame (app://botling/chat.html): the Swift app's chat page from Web/src, unchanged,
// fed with state by the app page. On top of it the desktop adds what the page does not have yet:
// a Stop button in the input box. KaTeX is the built-in ccb-latex plugin and summaries the built-in
// botling.catchup, which arrive with the other plugins' web parts (Botling Web bundles them).
import { unpackChatAvatars } from "../chat-avatar-wire";
import { observeTraceEditor } from "./input-trace-chat";
import { inputTrace } from "../input-trace";
import "./shim";
import "./component-frames";
import { installInputRecovery } from "./input-focus";
import "../../../../Web/src/main";
import { installMessageWidth } from "./message-width";
import { EditorView } from "@codemirror/view";
import type { FrameExtras } from "../payload";
import { WEB } from "./protocol";
import { toShell, fromShell, nativeChat, installNativeShellCommands, setShortcutBindings } from "./transport";
import { setMediaSource } from "../../../../Web/src/markdown";
import { localMediaSource } from "../../contract/attachment-url";
import { applyPatch } from "../../../../Web/src/patch";
import type { ChatState } from "../../../../Web/src/types";
import { keepDraft, keptDrafts, pageDraftStore } from "./draft-keep";
import latex from "../../../builtin-plugins/ccb-latex/package.json";
import chatExtras from "../../../builtin-plugins/botling.chat-extras/package.json";
import catchup from "../../../builtin-plugins/botling.catchup/package.json";
import board from "../../../builtin-plugins/botling.board/package.json";

declare const __LATEX_SOURCE__: string;
declare const __CHAT_EXTRAS_SOURCE__: string;
declare const __CATCHUP_SOURCE__: string;
declare const __BOARD_SOURCE__: string;

observeTraceEditor();
// Local media comes from the currently shown chat's authenticated origin.
let shownChat: string | undefined;
setMediaSource((url) => localMediaSource(shownChat, url));
installNativeShellCommands((id) => window.ccb?.runLocalCommand?.(id) ?? false);
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

let lastExtras: FrameExtras | null = null;
let decorateQueued = false;
/**
 * The page redraws rows by itself too (a plugin loading, the language changing): whenever its
 * list of rows changes, the states go back on.
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

/** Puts each message's turn state on its row. */
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
}

// ---------------------------------------------------------------------------------------------

let stateRevision = 0;
let receivedRevision = 0;
let receivedState: ChatState | null = null;
fromShell(message => {
  if (!message || typeof message !== "object") return;
  if (message.botling === "state" || message.botling === "stateDelta") {
    const unpacked = unpackChatAvatars(message);
    if (!unpacked) { toShell({ botling: "action", action: { type: "resync" } }); return; }
    const packet = unpacked;
    // Validate the base before touching the editor, local media source or card decorations.
    const state = packet.botling === "state" ? packet.state
      : receivedState?.botID === packet.botID && packet.baseRevision === receivedRevision
        ? applyPatch(receivedState, packet.patch) : null;
    if (!state) { toShell({ botling: "action", action: { type: "resync" } }); return; }
    receivedState = state;
    receivedRevision = packet.revision ?? 0;
    // Words typed before the first state (the first second after the window opens) would be replaced
    // by that chat's draft (empty) when the box switches to it: they are put back.
    inputTrace()?.mark("frame.state.receive", () => ({ traceId: packet.traceId, chat: state.botID,
      previousChat: document.documentElement.dataset.chat, ...inputTrace()!.snapshot() }));
    const early = !nativeChat && document.documentElement.dataset.chat === undefined ? typedSoFar() : null;
    inputTrace()?.mark("frame.early.snapshot", () => ({ early, ...inputTrace()!.snapshot() }));
    column.set(packet.messageColumnWidth ?? null, state.botID);
    // The chat the page draws, before it draws it (its local pictures are asked for as this bot's).
    shownChat = state.botID;
    window.ccb.setState(state);
    inputTrace()?.mark("frame.state.applied", () => inputTrace()!.snapshot());
    if (early) keepTyped(early);
    // Which chat the page shows (the input box keeps a draft per chat, so typing before the first
    // state would be replaced by that chat's draft); tests wait for it.
    document.documentElement.dataset.chat = state.botID;
    inputTrace()?.mark("frame.state.complete", () => inputTrace()!.snapshot());
    decorate(packet.extras);
    if (nativeChat) {
      // Initial focus is set in this root document before main reveals its native surface.
      if (stateRevision === 0) window.ccb.focus();
      toShell({ botling: "hostObservation", chatId: state.botID, intentEpoch: 0, revision: ++stateRevision });
    }
  } else if (message.botling === "widthRejected") {
    column.rejected(message.value, message.actual);
  } else if (message.botling === "shortcuts") {
    setShortcutBindings(message.bindings, message.commands);
  } else if (message.botling === "runCommand") {
    window.ccb.runCommand(message.id);
  } else if (message.botling === "widthPreview") {
    column.preview(message.value);
  } else if (message.botling === "messageWidthPointer") {
    column.pointer(message.kind, message.pointerId, message.x);
  } else if (message.botling === "answerWithSaved") {
    window.ccb.answerWithSaved({ botID: message.botID, requestID: message.requestID, chosen: message.chosen });
  } else if (message.botling === "plugins") {
    void setPlugins(message.specs);
  } else if (message.botling === "pluginEvent") {
    window.ccb.pluginEvent(message.plugin, message.name, message.data);
  } else if (message.botling === "hostReply") {
    window.ccb.hostReply(message.callID, message.ok, message.value);
  } else if (message.botling === "recoverFocus") {
    inputTrace()?.mark("frame.recover.receive", () => ({ traceId: message.traceId, ...inputTrace()!.snapshot() }));
    takeFocusBack();
  } else if (message.botling === "focus") {
    window.ccb.focus();
  } else if (message.botling === "jumpToTask") {
    window.ccb.jumpToTask(message.messageID, message.taskID);
  } else if (message.botling === "taskOutput") {
    if (document.documentElement.dataset.chat === message.botID) window.ccb.taskOutput(message.messageID, message.taskID, message.text);
  } else if (message.botling === "detailReply") {
    window.ccb.detailReply(message.requestID, message.ok, message.value);
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
  if ("bound" in packet) {
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

/**
 * Botling Web runs no plugins (the phone is told nothing of them), so its chat page keeps the built-in
 * web parts bundled in, as their manifests describe them, with their stylesheets (and ccb-latex's fonts)
 * beside chat.html, and their settings' defaults. ccb-latex's key (Mod+Shift+M) is the shell's to bind
 * (plugin-commands.ts). botling.catchup's draws the summaries the desktop wrote (its Retry needs the desktop). botling.board's draws the
 * pins and the Board the desktop keeps (a pin's command needs the desktop).
 */
const defaults = (settings: Record<string, { default: unknown }>) => Object.fromEntries(Object.entries(settings).map(([key, setting]) => [key, setting.default]));
const standalone = WEB ? [{
  name: latex.name,
  version: latex.version,
  source: __LATEX_SOURCE__,
  styles: [new URL("plugins/ccb-latex/katex.min.css", location.href).toString()],
  settings: defaults(latex.ccb.contributes.settings),
  commands: latex.ccb.contributes.commands.map(({ id, title }) => ({ id, title })),
}, {
  name: chatExtras.name,
  version: chatExtras.version,
  source: __CHAT_EXTRAS_SOURCE__,
  styles: [new URL("plugins/botling.chat-extras/chat-extras.css", location.href).toString()],
  settings: defaults(chatExtras.ccb.contributes.settings),
  commands: [],
}, {
  name: catchup.name,
  version: catchup.version,
  source: __CATCHUP_SOURCE__,
  styles: catchup.ccb.styles.map((style) => new URL(`plugins/${catchup.name}/${style}`, location.href).toString()),
  settings: defaults(catchup.ccb.contributes.settings),
  commands: [],
}, {
  name: board.name,
  version: board.version,
  source: __BOARD_SOURCE__,
  styles: [new URL("plugins/botling.board/board.css", location.href).toString()],
  settings: {},
  commands: [],
}].map((spec) => ({ ...spec, builtIn: true })) : [];
/**
 * Plugins' web parts run here as in 1.x (Phase 4a: this page has an origin of its own, so they reach
 * neither the app page's document nor its bridge); since step M11 the built-in ones (ccb-latex) come the same way.
 */
function setPlugins(specs: { name: string; version: string; source: string; styles: string[]; settings: Record<string, unknown>; commands: { id: string; title: string; key?: string }[]; builtIn?: boolean }[]) {
  return window.ccb.setPlugins([...standalone, ...specs.filter((spec) => !standalone.some((own) => own.name === spec.name))]);
}
void setPlugins([]);
