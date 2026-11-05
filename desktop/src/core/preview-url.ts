// Where a preview card's frame loads a result page from, and which files main serves there (1.x's
// PagePreview.previewURL / file(forPreview:)): only files inside a folder called `artifacts`, symlinks
// resolved. Kept apart from page-preview.ts so main (which serves them) needs nothing else of the core.
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, sep } from "node:path";

/** The app's result-page component, shared with main without loading the core. */
export const PAGE_COMPONENT = "網頁預覽卡片";

/** Where a card's frame loads a result page from (main serves it). */
export const PREVIEW_ORIGIN = "botling-card://preview";

/** Where the card's frame loads `file` from; `version` (its change date, seconds) makes a page written again load fresh (`previewURL`). */
export function previewURL(file: string, version: number | null = null): string {
  // On Windows `C:\\a\\b` goes as `/C:/a/b` (encoded as `/C%3A/a/b`).
  const slashed = sep === "\\" ? `/${file.replace(/\\/g, "/")}` : file;
  const path = slashed.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `${PREVIEW_ORIGIN}${path}${version === null ? "" : `?v=${version}`}`;
}

/** The file a preview URL names, if it may be served: a file inside an `artifacts` folder, symlinks resolved (`file(forPreview:)`). */
export function previewFile(url: string): string | null {
  if (!url.startsWith(`${PREVIEW_ORIGIN}/`)) return null;
  let path: string;
  try { path = new URL(url).pathname.split("/").map((part) => decodeURIComponent(part)).join("/"); } catch { return null; }
  if (!path.startsWith("/") || path.split(/[\\/]/).includes("..")) return null;
  if (sep === "\\") path = path.slice(1);
  if (!isAbsolute(path)) return null;
  let real: string;
  try { real = realpathSync(path); if (!statSync(real).isFile()) return null; } catch { return null; }
  for (let folder = dirname(real); folder && folder !== dirname(folder); folder = dirname(folder)) if (basename(folder) === "artifacts") return real;
  return null;
}

/** A Markdown file's title: its first `# heading` (outside code fences), or null. Reads at most the first 64 KiB. */
export function markdownTitle(text: string): string | null {
  let fence: string | null = null;
  for (const line of text.slice(0, 65536).split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker[0]!; else if (marker[0] === fence) fence = null; continue; }
    if (fence) continue;
    const heading = /^\s{0,3}#\s+(.+?)\s*#*\s*$/.exec(line)?.[1]?.trim();
    if (heading) return heading.replace(/[*_`]/g, "") || null;
  }
  return null;
}
