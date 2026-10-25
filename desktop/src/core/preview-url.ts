// Where a preview card's frame loads a result page from, and which files main serves there (1.x's
// PagePreview.previewURL / file(forPreview:)): only files inside a folder called `artifacts`, symlinks
// resolved. Kept apart from page-preview.ts so main (which serves them) needs nothing else of the core.
import { realpathSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";

/** The app's result-page component, shared with main without loading the core. */
export const PAGE_COMPONENT = "網頁預覽卡片";

/** Where a card's frame loads a result page from (main serves it). */
export const PREVIEW_ORIGIN = "botling-card://preview";

/** Where the card's frame loads `file` from; `version` (its change date, seconds) makes a page written again load fresh (`previewURL`). */
export function previewURL(file: string, version: number | null = null): string {
  const path = file.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `${PREVIEW_ORIGIN}${path}${version === null ? "" : `?v=${version}`}`;
}

/** The file a preview URL names, if it may be served: a file inside an `artifacts` folder, symlinks resolved (`file(forPreview:)`). */
export function previewFile(url: string): string | null {
  if (!url.startsWith(`${PREVIEW_ORIGIN}/`)) return null;
  let path: string;
  try { path = new URL(url).pathname.split("/").map((part) => decodeURIComponent(part)).join("/"); } catch { return null; }
  if (!path.startsWith("/") || path.split("/").includes("..")) return null;
  let real: string;
  try { real = realpathSync(path); if (!statSync(real).isFile()) return null; } catch { return null; }
  for (let folder = dirname(real); folder !== "/" && folder; folder = dirname(folder)) if (basename(folder) === "artifacts") return real;
  return null;
}
