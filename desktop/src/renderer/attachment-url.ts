/**
 * Where the chat origin serves a bot's file: an attachment of one of its lines (its file:// URL), a
 * picture or video its chat shows by its local path, or one waiting in the input box (`pending:<id>`).
 * Main asks the core, which serves only those.
 */
export function attachmentURL(botId: string, ref: string): string {
  const bytes = new TextEncoder().encode(ref);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `botling-chat://chat/attachment/${encodeURIComponent(botId)}/${encoded}`;
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
