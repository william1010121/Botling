// A chat link, file chip or picture dragged out of the chat (Web/src/lightbox.ts dragFile → link.drag): which file on disk
// it may start an OS file drag of. Only a local file that is really there; never a folder, a web link or a relative path.
import { fileURLToPath } from "node:url";
import { isAbsolute, normalize } from "node:path";
import { attachmentFile } from "../contract/attachment-url";

/**
 * The path a dragged link names (a file:// URL, an absolute path, or this chat's attachment as the chat origin serves it),
 * when `isFile` says a file is there; else null. `link` is what the core checks is one of this chat's links.
 */
export function linkDragTarget(url: string, botId: string, isFile: (path: string) => boolean): { link: string; path: string } | null {
  const link = attachmentFile(url, botId) ?? url;
  let path = "";
  if (/^file:\/\//i.test(link)) { try { path = fileURLToPath(link); } catch { return null; } }
  else if (link.startsWith("/") && !link.startsWith("//")) path = link;
  else return null;
  if (!isAbsolute(path) || path.includes("\0")) return null;
  path = normalize(path);
  try { return isFile(path) ? { link, path } : null; } catch { return null; }
}
