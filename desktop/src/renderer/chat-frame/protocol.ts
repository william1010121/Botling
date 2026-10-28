// What the app page (the React shell) and its chat frame (the reused Web/src chat page) say to
// each other with postMessage. Both are the app's own code on distinct origins; each side still
// checks who sent a message (`event.source`) and its origin, so a card frame inside the chat frame
// cannot pass for either.
import type { ChatState, SpecState, StatePatch } from "../../../../Web/src/types";
import type { Command, WebPluginSpecView } from "../../contract";
import type { FrameExtras } from "../payload";

/** Botling Web (desktop/mobile/build.mjs defines it): the same shell and chat page, served by the
 * mobile bridge. The chat page then runs in a sandboxed frame without allow-same-origin, so it has an
 * opaque origin ("null"), no cookies and no storage: like the desktop's own origin, it shares nothing
 * with the shell but postMessage, and every receiver still checks `event.source`. */
declare const __BOTLING_WEB__: boolean | undefined;
export const WEB = typeof __BOTLING_WEB__ !== "undefined" && __BOTLING_WEB__ === true;
const served = WEB ? new URL(location.href).origin : "";
/** The app page's origin (the React shell, which has the bridge). */
export const APP_ORIGIN = WEB ? served : "app://botling";
/** The chat page's own origin (Phase 4a): it shares nothing with the app page but postMessage. */
export const CHAT_ORIGIN = WEB ? "null" : "botling-chat://chat";
/** The target origin the shell posts to the chat page with (an opaque origin can only be named "*"). */
export const CHAT_TARGET = WEB ? "*" : CHAT_ORIGIN;
export const CHAT_PAGE = WEB ? `${served}/mobile/chat.html` : `${CHAT_ORIGIN}/chat.html`;
/** The chat frame's sandbox on the web (none on the desktop, whose scheme already isolates it). */
export const CHAT_SANDBOX: string | undefined = WEB ? "allow-scripts" : undefined;

/** Frame → shell. */
export type FrameMessage =
  /** Something the chat page posted for "the app" (`Action` in Web/src/types.ts). */
  | { botling: "action"; reportPreview?: boolean; linkSource?: "user" | "component"; linkMessageId?:string; linkPinId?:string; action: { type: string; [key: string]: unknown } }
  /** A card's save or action, for the core (only these two kinds are accepted). */
  | { botling: "request"; id: number; cmd: Extract<Command, { type: "card.save" | "card.action" }> }
  /** The Stop button the desktop adds to the input box. */
  | { botling: "stop" }
  /** Global message column setting, committed after a drag or reset. */
  | { botling: "messageWidth"; value: number | null }
  | { botling: "messageWidthDrag"; active: boolean }
  /** Launch focus recovery belongs only to the composer until the user chooses another control. */
  | { botling: "composerIntent"; value: boolean; recoveryUntil: number; startedAt: number; traceId?: string }
  /** The native editor has applied state without replacing its EditorView. */
  | { botling: "hostObservation"; chatId: string | null; intentEpoch: number; revision: number }
  /** A component frame's page, to be served from botling-card://page/ (component-frames.ts). */
  | { botling: "page"; id: number; html: string };

/** Shell → frame. */
export type ShellMessage =
  | { botling: "composerResult"; requestID: string; ok: boolean; error?: string }
  | { botling: "taskOutput"; botID: string; messageID: string; taskID: string; text: string }
  | { botling: "widthRejected"; value: number | null; actual: number | null }
  | { botling: "widthPreview"; value: number | null | undefined }
  | { botling: "state"; avatarSources?: string[]; state: ChatState; revision?: number; extras: FrameExtras; messageColumnWidth?: number | null; traceId?: string }
  /** Sequenced delta against the last full snapshot or delta in this page. */
  | { botling: "stateDelta"; avatarSources?: string[]; botID: string; baseRevision: number; revision: number; patch: StatePatch; extras: FrameExtras; messageColumnWidth?: number | null; traceId?: string }
  | { botling: "response"; id: number; ok: boolean; error?: string }
  /** The composer's Both/Claude/Codex pick was saved (`ccb.answerWithSaved`). */
  | { botling: "answerWithSaved"; botID: string; requestID: number; chosen: string }
  /** Where a component frame's page is served (null: refused). */
  | { botling: "page"; id: number; url: string | null }
  /** Plugins' web parts to run in the page (`ccb.setPlugins`, after the bundled ccb-latex). */
  | { botling: "plugins"; specs: WebPluginSpecView[] }
  /** A web part's `ccb.host.call` was answered (`ccb.hostReply`). */
  | { botling: "hostReply"; callID: number; ok: boolean; value: unknown }
  /** A component's `ccb.runDetail` answer (`ccb.detailReply`). */
  | { botling: "detailReply"; requestID: number; ok: boolean; value: string }
  /** The cursor back in the input box (after the left column's search; `ccb.focus`). */
  | { botling: "focus" }
  /** Ask the frame to recover only its own still-intended, recently lost composer. */
  | { botling: "recoverFocus"; traceId?: string }
  /** Pointer events over the shell after a width drag leaves the chat iframe. */
  | { botling: "messageWidthPointer"; kind: "move" | "up" | "cancel"; pointerId: number; x: number }
  /** "Jump to chat" on a task's card in the right panel (`ccb.jumpToTask`). */
  | { botling: "jumpToTask"; messageID: string; taskID: string }
  /** The spec panel's page (`chat.html?spec=1`): the open spec (`ccb.setSpec`). */
  | { botling: "spec"; spec: SpecState };
