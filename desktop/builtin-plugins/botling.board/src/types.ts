// What the Board's pins are, as its program part keeps them and its web part draws them (what the chat page's types had before this plugin).
import type { ChatState, DisplayView, PinRefresh, PinSize } from "../../../../Web/src/types";

/** A pin chip's short value and tone (a dot on its icon unless neutral). */
export interface ChipStatus {
  text: string;
  tone: "neutral" | "good" | "warning" | "bad";
}

/** A component pinned to the bot: a chip above the input box and a card on its Board. */
export interface PinView {
  id: string;
  name: string;
  /** One line from its data: its chip's tooltip. */
  headline: string;
  /** What its chip shows beside its icon (what the component set, else `headline` cut short). */
  chip?: ChipStatus;
  size: PinSize;
  /** Its Board card's top-left cell (columns and rows from 0); absent: not laid out yet, the Board places it and sends that back. */
  place?: { col: number; row: number } | null;
  /** How tall it opens above the input box, as the user dragged its panel; absent: its content's height. */
  panelHeight?: number | null;
  refresh: PinRefresh;
  minutes: number;
  /** Refreshed every this many seconds instead of `minutes`. */
  seconds?: number | null;
  /** The component, with its command's run as for a card in the chat. */
  display: DisplayView;
  /** Filled by a bot; Maintainer is giving its component a command so it refreshes here. */
  makingLive?: boolean | null;
  /** Where it floats in a corner of the window; absent: it does not float. */
  float?: FloatView | null;
  /** Its menu's float entry: Float in corner, Stop floating, or Float shown off (two float already). */
  floatMenu?: FloatMenu | null;
}

export type FloatCorner = "topRight" | "topLeft" | "bottomRight" | "bottomLeft";
export type FloatMenu = "float" | "stop" | "full";

/**
 * Where a floating pin sits: the corner it snaps to, folded to one line, and its card's size in px
 * once the user dragged it: its width, and the most it grows to (absent: a width that fits a
 * card's full layout, and its content's height up to `floatLimits.maxHeight`).
 */
export interface FloatView {
  corner: FloatCorner;
  width?: number | null;
  height?: number | null;
  collapsed: boolean;
}

/** A pin floating in a corner of this chat: this bot's own, or another bot's shown in all bots. */
export interface FloatingPinView {
  botID: string;
  botName: string;
  pin: PinView;
  /** Shown in every bot's chat ("Show in all bots"); absent: only in its own bot's. */
  global?: boolean | null;
  /** Not global, and that chat already shows the most floating cards: its name ("Show in all bots" is off). */
  blocked?: string | null;
}

/** A component the pin picker offers: one this bot drew, or one with a Command. */
export interface PinChoiceView {
  name: string;
  command?: string | null;
  uses: number;
  pinned: boolean;
}


/** What the chat page's state has for the Board: the pins, those floating (as this chat's own) and the picker's list. */
export type BoardState = ChatState & { pins?: PinView[] | null; floating?: FloatingPinView[] | null; pinChoices?: PinChoiceView[] | null };

/** What the program part keeps for a chat's page (`state.pluginData["botling.board"]`). */
export interface BoardData { pins: PinView[]; floating: PinView[]; pinChoices: PinChoiceView[] }

/** What the web part sends its program part: what the user did to pins, as the chat page's actions were (the program part answers them). */
export type PinAction =
  | { type: "pin"; id: string; messageID?: string; index?: number; name?: string; spec?: string; refresh: PinRefresh; minutes: number; seconds?: number }
  | { type: "unpin"; id: string }
  | { type: "pinCommand"; id: string; command: string; folder: string; detail?: string; force?: boolean; live?: boolean }
  | { type: "pinShown"; ids: string[] | null }
  | { type: "pinsVisible"; ids: string[] }
  | { type: "movePin"; id: string; to: number }
  | { type: "resizePin"; id: string; size: PinSize }
  | { type: "arrangePins"; places: { id: string; col: number; row: number; size?: PinSize }[] }
  | { type: "setPinHeight"; id: string; height: number | null }
  | { type: "floatPin"; id: string; floating: boolean }
  | { type: "setPinGlobal"; id: string; global: boolean }
  | { type: "setPinFloat"; id: string; corner?: FloatCorner; width?: number; height?: number; collapsed?: boolean }
  | { type: "setPinRefresh"; id: string; refresh: PinRefresh; minutes?: number; seconds?: number }
  | { type: "pinStatus"; id: string; text: string | null; tone: string | null }
  | { type: "pinSave"; id: string; data: string };
