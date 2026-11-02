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
//                  { ccb: "approval", id, botId, command, folder, card? }
//                                                         asks the user to allow a bot's command: the page around it
//                                                         shows its own ApprovalSheet; the reply is { allowed }. A
//                                                         frame can ask, never allow (`ccb.requestApproval`)
//   page → frame   { ccb: "reply", id, ok, value }        the call's answer, or why it failed

export type FrameRequest =
  | { ccb: "call"; id: number; method: string; params: unknown }
  | { ccb: "command"; id: string; args?: string[] }
  | { ccb: "notify"; text: string }
  | { ccb: "error"; message: string }
  | { ccb: "tile"; id: number; component: string; data: unknown; size: TileSize; botId: string }
  | { ccb: "approval"; id: number; botId: string; command: string; folder: string; card?: string };

/** The sizes a frame's tile may have (a whiteboard card's picture: 1×1 or 2×1; its report shows it 2×2). */
export const TILE_SIZES = ["1x1", "2x1", "2x2"] as const;
export type TileSize = (typeof TILE_SIZES)[number];

export interface FrameReply { ccb: "reply"; id: number; ok: boolean; value: unknown }

export const METHOD_MAX = 200;
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
  tile: ["ccb", "id", "component", "data", "size", "botId"],
  approval: ["ccb", "id", "botId", "command", "folder", "card"],
};
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
    case "approval":
      if (!Number.isSafeInteger(message.id) || !text(message.botId, 64) || !text(message.command, 20_000) || !text(message.folder, 4_000)) return null;
      if (message.card !== undefined && !text(message.card, 200)) return null;
      return { ccb: "approval", id: message.id as number, botId: message.botId, command: message.command, folder: message.folder, ...(message.card !== undefined ? { card: message.card as string } : {}) };
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
export const BUILTIN_COMMANDS = ["botling.openChat", "botling.openResult"] as const;
export type BuiltinCommand = { id: "botling.openChat"; botId: string } | { id: "botling.openResult"; botId: string; url: string };

/** One of Botling's own commands with the arguments it needs (openChat: a bot; openResult: a bot and one of its links), or null. */
export function builtinCommand(id: string, args: string[] = []): BuiltinCommand | null {
  const botId = args[0];
  if (!botId) return null;
  if (id === "botling.openChat" && args.length === 1) return { id, botId };
  if (id === "botling.openResult" && args.length === 2 && args[1]) return { id, botId, url: args[1] };
  return null;
}

/** The frame whose window sent a message, found by the window itself (never by what the message says). */
export function frameOf<T extends { contentWindow: Window | null }>(frames: Iterable<T>, source: MessageEventSource | null): T | null {
  if (!source) return null;
  for (const frame of frames) if (frame.contentWindow && frame.contentWindow === source) return frame;
  return null;
}
