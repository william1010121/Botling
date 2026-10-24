// What the app page (the React shell) and its chat frame (the reused Web/src chat page) say to
// each other with postMessage. Both are the app's own code on the same origin; each side still
// checks who sent a message (`event.source`) and its origin, so a card frame inside the chat frame
// cannot pass for either.
import type { ChatState } from "../../../../Web/src/types";
import type { Command } from "../../contract";
import type { FrameExtras } from "../payload";

/** Frame → shell. */
export type FrameMessage =
  /** Something the chat page posted for "the app" (`Action` in Web/src/types.ts). */
  | { botling: "action"; action: { type: string; [key: string]: unknown } }
  /** A card's save or action, for the core (only these two kinds are accepted). */
  | { botling: "request"; id: number; cmd: Extract<Command, { type: "card.save" | "card.action" }> }
  /** The Stop button the desktop adds to the input box. */
  | { botling: "stop" }
  /** A component frame's page, to be served from botling-card://page/ (component-frames.ts). */
  | { botling: "page"; id: number; html: string };

/** Shell → frame. */
export type ShellMessage =
  | { botling: "state"; state: ChatState; extras: FrameExtras }
  | { botling: "response"; id: number; ok: boolean; error?: string }
  /** The composer's Both/Claude/Codex pick was saved (`ccb.answerWithSaved`). */
  | { botling: "answerWithSaved"; botID: string; requestID: number; chosen: string }
  /** Where a component frame's page is served (null: refused). */
  | { botling: "page"; id: number; url: string | null }
  /** A component's `ccb.runDetail` answer (`ccb.detailReply`). */
  | { botling: "detailReply"; requestID: number; ok: boolean; value: string };
