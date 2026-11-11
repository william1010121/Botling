// The one RPC a sandboxed plugin frame (panel, tile, card) speaks with the page around it. Every
// request has the same shape, and none names a plugin: who sent it is the frame it came from
// (`event.source`), which the page around it registered. The page answers a call with a reply.
//
//   frame → page   { ccb: "call", id, method, params }   a method its own program part exposes (ui.expose)
//                  { ccb: "command", id, args? }          one of its own plugin's commands ("<plugin>.…"), or
//                                                         Botling's own openChat / openResult (`builtinCommand`)
//                  { ccb: "notify", text }                a line for the user
//                  { ccb: "error", message }              its code failed
//                  { ccb: "tile", id, component, data, size, botId }
//                                                         a component of the library drawn as a tile: the reply is
//                                                         the URL of a card page (botling-card://page/<token>) it may
//                                                         frame, read only (plugin-extraction.md W4, `ccb.tile`)
//                  { ccb: "card", id, component, data, botId }
//                                                         a component of the library drawn as in a chat reply (its width
//                                                         follows its frame, its height its content): the reply is the URL of
//                                                         its card page, which posts { ccb: "size", height } to the frame
//                                                         holding it and takes { ccbData } (`ccb.card`, the Note tab's cards)
//                  { ccb: "snapshot", id, botId, rect }   a picture of a part of this frame (x, y, width, height in its own
//                                                         CSS px), kept in the bot's note-assets; the reply is { ref, url }
//                                                         (`ccb.snapshot`, the Note tab's "freeze to image"; needs "files")
//                  { ccb: "openLink", id, botId, href }   opens a link of the bot's note as the chat opens one: a web link in
//                                                         the default browser, a Markdown file in the app's report preview,
//                                                         another file with its app (or in Finder); a relative href against the
//                                                         note's folder. The reply is { opened } (`ccb.openLink`; a file needs "files")
//                  { ccb: "composerQuote", id, text, botId, focus }
//                                                         puts text into the bot's input box, after its draft (a blank line
//                                                         before and after, the caret at the end); focus: the input box gets
//                                                         the focus (the Note's floating chat opens first). Only the bot the
//                                                         frame was opened for; the reply is { inserted } (`ccb.composer.insertQuote`)
//                  { ccb: "approval", id, botId, command, folder, card?, detail? }
//                                                         asks the user to allow a bot's command: the page around it
//                                                         shows its own ApprovalSheet; the reply is { allowed }. A
//                                                         frame can ask, never allow (`ccb.requestApproval`)
//                  { ccb: "resize", height }              how tall its content is (px), for a frame the page sizes to its content
//                                                         (a block in Settings or a popover; `panelPage` with `fit`)
//                  { ccb: "ready" }                       its web part is up (not a request: the page then tells it what it is in)
//                  { ccb: "panel", visible }              a `bottomPanel` view asks to be shown or hidden (the page lays it out)
//                  { ccb: "key", key, code, …modifiers }  a key combination it did not use (a modifier held), for the page's shortcuts
//   page → frame   { ccb: "reply", id, ok, value }        the call's answer, or why it failed
//                  { ccb: "event", name, data }           something its program part pushed (`ui.emit`), or the page's own
//                                                         ("visible": a `bottomPanel` is shown or hidden; "toggle": its toggle command ran)

export type FrameRequest =
  | { ccb: "call"; id: number; method: string; params: unknown }
  | { ccb: "command"; id: string; args?: string[] }
  | { ccb: "notify"; text: string }
  | { ccb: "error"; message: string }
  | { ccb: "resize"; height: number }
  | { ccb: "panel"; visible: boolean }
  | { ccb: "key"; key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }
  | { ccb: "tile"; id: number; component: string; data: unknown; size: TileSize; botId: string }
  | { ccb: "card"; id: number; component: string; data: unknown; botId: string }
  | { ccb: "snapshot"; id: number; botId: string; rect: FrameRect }
  | { ccb: "openLink"; id: number; botId: string; href: string }
  | { ccb: "composerQuote"; id: number; text: string; botId: string; focus: boolean }
  | { ccb: "approval"; id: number; botId: string; command: string; folder: string; card?: string; detail?: string };

/** A part of a frame, in its own CSS px. */
export interface FrameRect { x: number; y: number; width: number; height: number }

/** The sizes a frame's tile may have (a whiteboard card's picture: 1×1 or 2×1; its report shows it 2×2). */
export const TILE_SIZES = ["1x1", "2x1", "2x2"] as const;
export type TileSize = (typeof TILE_SIZES)[number];

export interface FrameReply { ccb: "reply"; id: number; ok: boolean; value: unknown }
/** A push to a frame: from its plugin's program part (`ui.emit`) or the page around it. */
export interface FrameEvent { ccb: "event"; name: string; data: unknown }
export function frameEvent(name: string, data: unknown): FrameEvent {
  return { ccb: "event", name, data };
}

export const METHOD_MAX = 200;
/** The tallest a frame may ask to be (px). */
export const RESIZE_MAX = 20_000;
export const PARAMS_MAX = 1_000_000;
const COMMAND_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
/** A command's arguments: a few strings (a bot's id, a link). */
const ARGS_MAX = 4;
const ARG_MAX = 4_000;

/** The keys each request may have: one more (a plugin, a bot) and it is not a request at all. */
const KEYS: Record<FrameRequest["ccb"], string[]> = {
  call: ["ccb", "id", "method", "params"],
  command: ["ccb", "id", "args"],
  notify: ["ccb", "text"],
  error: ["ccb", "message"],
  resize: ["ccb", "height"],
  panel: ["ccb", "visible"],
  key: ["ccb", "key", "code", "metaKey", "ctrlKey", "altKey", "shiftKey"],
  tile: ["ccb", "id", "component", "data", "size", "botId"],
  approval: ["ccb", "id", "botId", "command", "folder", "card", "detail"],
  card: ["ccb", "id", "component", "data", "botId"],
  snapshot: ["ccb", "id", "botId", "rect"],
  openLink: ["ccb", "id", "botId", "href"],
  composerQuote: ["ccb", "id", "text", "botId", "focus"],
};
/** The longest text a frame may quote into an input box. */
export const QUOTE_MAX = 200_000;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/** A frame's message as a request, or null if it is not exactly one. */
export function parseFrameRequest(data: unknown): FrameRequest | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const message = data as Record<string, unknown>;
  const kind = message.ccb;
  if (typeof kind !== "string" || !Object.hasOwn(KEYS, kind)) return null;
  if (Object.keys(message).some((key) => !KEYS[kind as FrameRequest["ccb"]].includes(key))) return null;
  switch (kind) {
    case "call":
      if (!Number.isSafeInteger(message.id) || typeof message.method !== "string" || !message.method || message.method.length > METHOD_MAX) return null;
      return { ccb: "call", id: message.id as number, method: message.method, params: message.params ?? null };
    case "command": {
      if (typeof message.id !== "string" || !COMMAND_ID.test(message.id)) return null;
      const args = message.args ?? [];
      if (!Array.isArray(args) || args.length > ARGS_MAX || args.some((arg) => typeof arg !== "string" || arg.length > ARG_MAX)) return null;
      return args.length ? { ccb: "command", id: message.id, args } : { ccb: "command", id: message.id };
    }
    case "notify":
      return typeof message.text === "string" ? { ccb: "notify", text: message.text } : null;
    case "tile":
      if (!Number.isSafeInteger(message.id) || !text(message.component, 200) || !text(message.botId, 64) || !(TILE_SIZES as readonly unknown[]).includes(message.size)) return null;
      return { ccb: "tile", id: message.id as number, component: message.component, data: message.data ?? null, size: message.size as TileSize, botId: message.botId };
    case "card":
      if (!Number.isSafeInteger(message.id) || !text(message.component, 200) || !text(message.botId, 64)) return null;
      return { ccb: "card", id: message.id as number, component: message.component, data: message.data ?? null, botId: message.botId };
    case "snapshot": {
      const rect = message.rect as Record<string, unknown> | null;
      if (!Number.isSafeInteger(message.id) || !text(message.botId, 64) || !rect || typeof rect !== "object" || Array.isArray(rect)) return null;
      const keys = Object.keys(rect);
      if (keys.length !== 4 || !["x", "y", "width", "height"].every((key) => typeof rect[key] === "number" && Number.isFinite(rect[key]))) return null;
      const { x, y, width, height } = rect as unknown as FrameRect;
      if (width <= 0 || height <= 0 || width > 10_000 || height > 10_000) return null;
      return { ccb: "snapshot", id: message.id as number, botId: message.botId, rect: { x, y, width, height } };
    }
    case "openLink":
      if (!Number.isSafeInteger(message.id) || !text(message.botId, 64) || !text(message.href, 4_000)) return null;
      return { ccb: "openLink", id: message.id as number, botId: message.botId, href: message.href };
    case "composerQuote":
      if (!Number.isSafeInteger(message.id) || !text(message.text, QUOTE_MAX) || !text(message.botId, 64) || typeof message.focus !== "boolean") return null;
      return { ccb: "composerQuote", id: message.id as number, text: message.text, botId: message.botId, focus: message.focus };
    case "approval":
      if (!Number.isSafeInteger(message.id) || !text(message.botId, 64) || !text(message.command, 20_000) || !text(message.folder, 4_000)) return null;
      if (message.card !== undefined && !text(message.card, 200)) return null;
      if (message.detail !== undefined && !text(message.detail, 20_000)) return null;
      return { ccb: "approval", id: message.id as number, botId: message.botId, command: message.command, folder: message.folder, ...(message.card !== undefined ? { card: message.card as string } : {}), ...(message.detail !== undefined ? { detail: message.detail as string } : {}) };
    case "panel":
      return typeof message.visible === "boolean" ? { ccb: "panel", visible: message.visible } : null;
    case "key":
      if (!text(message.key, 32) || !text(message.code, 32)) return null;
      if (![message.metaKey, message.ctrlKey, message.altKey, message.shiftKey].every((flag) => typeof flag === "boolean")) return null;
      return { ccb: "key", key: message.key as string, code: message.code as string, metaKey: message.metaKey as boolean, ctrlKey: message.ctrlKey as boolean, altKey: message.altKey as boolean, shiftKey: message.shiftKey as boolean };
    case "resize":
      return typeof message.height === "number" && Number.isFinite(message.height) && message.height >= 0 ? { ccb: "resize", height: Math.min(RESIZE_MAX, Math.ceil(message.height)) } : null;
    default:
      return typeof message.message === "string" ? { ccb: "error", message: message.message } : null;
  }
}

export function frameReply(id: number, ok: boolean, value: unknown): FrameReply {
  return { ccb: "reply", id, ok, value };
}

/** A call's parameters as plain JSON (what crosses to the core), or why they cannot go. */
export function frameParams(params: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  let text: string | undefined;
  try { text = JSON.stringify(params ?? null); } catch { return { ok: false, reason: "Its parameters are not JSON." }; }
  if (text === undefined) return { ok: true, value: null };
  if (text.length > PARAMS_MAX) return { ok: false, reason: "Its parameters are too big." };
  return { ok: true, value: JSON.parse(text) };
}

/** Whether command `id` is one of `plugin`'s own (`<plugin>.<something>`). */
export function ownsCommand(plugin: string, id: string): boolean {
  return id.length > plugin.length + 1 && id.startsWith(`${plugin}.`);
}

/** Botling's own commands a plugin frame may run (plugin-extraction.md §4.3); the page around it runs them. */
export const BUILTIN_COMMANDS = ["botling.openChat", "botling.openResult", "botling.openLink", "botling.openTab"] as const;
export type BuiltinCommand =
  | { id: "botling.openChat"; botId: string }
  | { id: "botling.openResult"; botId: string; url: string }
  /** A link the user chose to open (a pull request), as a click on it in the chat would. */
  | { id: "botling.openLink"; botId: string; url: string }
  /** A bot's main-area tab (a plugin's `mainTab` view): the bot, the plugin and the view's id. */
  | { id: "botling.openTab"; botId: string; plugin: string; view: string };

/** One of Botling's own commands with the arguments it needs (openChat: a bot; openResult: a bot and one of its links), or null. */
export function builtinCommand(id: string, args: string[] = []): BuiltinCommand | null {
  const botId = args[0];
  if (!botId) return null;
  if (id === "botling.openChat" && args.length === 1) return { id, botId };
  if (id === "botling.openResult" && args.length === 2 && args[1]) return { id, botId, url: args[1] };
  if (id === "botling.openLink" && args.length === 2 && args[1]) return { id, botId, url: args[1] };
  if (id === "botling.openTab" && args.length === 3 && args[1] && args[2]) return { id, botId, plugin: args[1], view: args[2] };
  return null;
}

/** The frame whose window sent a message, found by the window itself (never by what the message says). */
export function frameOf<T extends { contentWindow: Window | null }>(frames: Iterable<T>, source: MessageEventSource | null): T | null {
  if (!source) return null;
  for (const frame of frames) if (frame.contentWindow && frame.contentWindow === source) return frame;
  return null;
}
