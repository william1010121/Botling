// Where the chat origin serves a bot's file: an attachment of one of its lines (its file:// URL), a
// picture or video its chat shows by its local path, or one waiting in the input box (`pending:<id>`).
// Main asks the core, which serves only those.
// The page sees `botling-chat://chat/attachment/<bot>/<ref, base64url>/<file name>`: the name is for
// the page only (a picture is known by its extension, so it opens in the lightbox as in 1.x).

const ORIGIN = "botling-chat://chat";

function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(text: string): string | null {
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

export function attachmentURL(botId: string, ref: string): string {
  const url = `${ORIGIN}/attachment/${encodeURIComponent(botId)}/${encode(ref)}`;
  // A file URL's last part is its (already escaped) name.
  const name = ref.startsWith("file:") ? ref.split(/[?#]/)[0]!.split("/").pop() : "";
  return name && /^[^/\\]{1,400}$/.test(name) ? `${url}/${name}` : url;
}

/** The chat origin's path of an attachment: whose chat, and the file (or waiting file) it names. */
export function attachmentTarget(path: string): { botId: string; ref: string } | null {
  const match = /^\/attachment\/([A-Za-z0-9_.:-]{1,64})\/([A-Za-z0-9_-]{1,8000})(?:\/[^/]{1,400})?$/.exec(path);
  const ref = match ? decode(match[2]!) : null;
  return match && ref ? { botId: match[1]!, ref } : null;
}

/** The file:// URL a chat-page attachment link stands for, when it is one of `botId`'s chat; else null. */
export function attachmentFile(url: string, botId: string): string | null {
  if (!url.startsWith(`${ORIGIN}/attachment/`)) return null;
  let path: string;
  try { path = new URL(url).pathname; } catch { return null; }
  const target = attachmentTarget(path);
  return target && target.botId === botId && target.ref.startsWith("file:") ? target.ref : null;
}

/**
 * A picture or video as the chat page loads it: a local one (a file:// URL, or an absolute path, which
 * 1.x's file:// page loads as one) from the chat origin, for the chat shown; anything else unchanged.
 */
export function localMediaSource(botId: string | undefined, url: string): string {
  if (!botId) return url;
  if (/^file:\/\//i.test(url)) return attachmentURL(botId, url);
  if (url.startsWith("/") && !url.startsWith("//")) return attachmentURL(botId, `file://${url}`);
  return url;
}
