import { fileURLToPath } from "node:url";
import { previewFile, previewURL } from "../core/preview-url";

/** Called only after normal link authorization; reuse the preview resource boundary. */
export function reportPreviewURL(url: string): string {
  let file = "";
  try { file = url.startsWith("file:") ? fileURLToPath(url) : url; } catch {}
  const src = previewURL(file);
  if (!/\.(html?|md|markdown)$/i.test(file) || !previewFile(src)) throw new Error("That report page is not available in artifacts.");
  return src;
}

/** A shell-owned viewer can load a preview, but the sandboxed page cannot navigate itself. */
export function shellReportNavigation(parent: unknown, initiator: unknown, mainFrame: unknown): boolean {
  return parent === mainFrame && (!initiator || initiator === mainFrame);
}

const MARKDOWN = /\.(md|markdown)$/i;

/** The local Markdown file a link names (a file: URL or an absolute path), or null: such a link opens in the app's preview. */
export function markdownLinkPath(url: string): string | null {
  let path = "";
  if (/^file:/i.test(url)) { try { path = fileURLToPath(url.replace(/[?#].*$/, "")); } catch { return null; } }
  else if (url.startsWith("/") && !url.startsWith("//")) path = url;
  return path && MARKDOWN.test(path) ? path : null;
}

/**
 * How main opens an authorized chat link (`link.open`), 2026-11-10: any local Markdown file in the app's report preview
 * (never the system's app for .md, VS Code on the user's Mac), whoever clicked it and wherever it is; an HTML report the
 * preview card asks for in its embedded preview; anything else (and Show in Finder) as before.
 */
export function linkOpenWay(link: { url: string; source: "user" | "component"; preview: boolean; reveal: boolean }): "markdown" | "preview" | "open" {
  if (link.reveal) return "open";
  if (markdownLinkPath(link.url)) return "markdown";
  return link.preview && link.source === "component" ? "preview" : "open";
}
