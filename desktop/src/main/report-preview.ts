import { fileURLToPath } from "node:url";
import { previewFile, previewURL } from "../core/preview-url";

/** Called only after normal link authorization; reuse the preview resource boundary. */
export function reportPreviewURL(url: string): string {
  let file = "";
  try { file = url.startsWith("file:") ? fileURLToPath(url) : url; } catch {}
  const src = previewURL(file);
  if (!/\.html?$/i.test(file) || !previewFile(src)) throw new Error("That report page is not available in artifacts.");
  return src;
}

/** A shell-owned viewer can load a preview, but the sandboxed page cannot navigate itself. */
export function shellReportNavigation(parent: unknown, initiator: unknown, mainFrame: unknown): boolean {
  return parent === mainFrame && (!initiator || initiator === mainFrame);
}
