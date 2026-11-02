// The one RPC a sandboxed plugin frame (panel, tile, card) speaks with the page around it. Every
// request has the same shape, and none names a plugin: who sent it is the frame it came from
// (`event.source`), which the page around it registered. The page answers a call with a reply.
//
//   frame → page   { ccb: "call", id, method, params }   a method its own program part exposes (ui.expose)
//                  { ccb: "command", id }                 one of its own plugin's commands ("<plugin>.…")
//                  { ccb: "notify", text }                a line for the user
//                  { ccb: "error", message }              its code failed
//   page → frame   { ccb: "reply", id, ok, value }        the call's answer, or why it failed

export type FrameRequest =
  | { ccb: "call"; id: number; method: string; params: unknown }
  | { ccb: "command"; id: string }
  | { ccb: "notify"; text: string }
  | { ccb: "error"; message: string };

export interface FrameReply { ccb: "reply"; id: number; ok: boolean; value: unknown }

export const METHOD_MAX = 200;
export const PARAMS_MAX = 1_000_000;
const COMMAND_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/** The keys each request may have: one more (a plugin, a bot) and it is not a request at all. */
const KEYS: Record<FrameRequest["ccb"], string[]> = {
  call: ["ccb", "id", "method", "params"],
  command: ["ccb", "id"],
  notify: ["ccb", "text"],
  error: ["ccb", "message"],
};

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
    case "command":
      return typeof message.id === "string" && COMMAND_ID.test(message.id) ? { ccb: "command", id: message.id } : null;
    case "notify":
      return typeof message.text === "string" ? { ccb: "notify", text: message.text } : null;
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

/** The frame whose window sent a message, found by the window itself (never by what the message says). */
export function frameOf<T extends { contentWindow: Window | null }>(frames: Iterable<T>, source: MessageEventSource | null): T | null {
  if (!source) return null;
  for (const frame of frames) if (frame.contentWindow && frame.contentWindow === source) return frame;
  return null;
}
