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
  | { botling: "stop" };

/** Shell → frame. */
export type ShellMessage =
  | { botling: "state"; state: ChatState; extras: FrameExtras }
  | { botling: "response"; id: number; ok: boolean; error?: string };
