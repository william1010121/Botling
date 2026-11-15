// PDFs in the in-app browser pane (2026-11-13): a local PDF the user dropped (or a .pdf link of the chat they clicked)
// opens in a tab of its own, in Chromium's PDF viewer (`plugins: true` on the pane's pages, browser-host.ts).
//
// The drop rule:
// - onto the tab strip, the toolbar or an empty pane (the app page draws those): every PDF dropped opens as a tab;
// - onto a page: the page has it first. A file input or an upload area (a page that takes the drop) gets the file as
//   before; a page that does not take it lets Chromium "open the dropped file" (navigateOnDragDrop), which main turns
//   into a new tab when it is a PDF and refuses otherwise.
//
// Only a PDF the user handed over loads: main never lets a page, a bot or the address bar go to a file: URL. A file
// opens only when it is a regular local file named .pdf whose first bytes are a PDF's (`%PDF-`), and a page that is
// itself a local file (a PDF's own links) may not open another one.
import { open, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Larger files are not opened in the pane. */
export const PDF_MAX_BYTES = 1024 * 1024 * 1024;
/** At most this many PDFs open from one drop. */
export const PDF_DROP_MAX = 8;

const isPdfName = (path: string) => /\.pdf$/i.test(path);

/** The local path a file: URL of a PDF names (no host but localhost, no query); null for anything else. */
export function localPdfPath(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "file:" || (u.hostname && u.hostname !== "localhost") || u.search) return null;
  let path: string;
  try { path = fileURLToPath(u); } catch { return null; }
  return isAbsolute(path) && isPdfName(path) ? path : null;
}

/**
 * The file: URL of the local PDF a tab at `url` shows, when the tab's own address is another one (Botling 3 loads it from
 * `botling-content://file/…`, browser-pdf-v3.ts); null otherwise. 2.x: always null, a PDF tab's address is its file: URL.
 * Plugins' toolbar buttons (menu "browser/tab") match this address and their command gets it (BrowserTabInfo `fileUrl`).
 */
export function pdfTabFileUrl(_url: string): string | null {
  return null;
}

/** The local PDF a chat link names (a file: URL or an absolute path, as main's links are); null otherwise. */
export function linkPdfPath(url: string): string | null {
  if (url.startsWith("file:")) return localPdfPath(url);
  return isAbsolute(url) && isPdfName(url) && !url.includes("\0") ? url : null;
}

/** The file: URL a tab of a local PDF loads. */
export function pdfFileUrl(path: string): string {
  return pathToFileURL(path).href;
}

/** The paths of a drop the app page sent (pathForFile of each File): the absolute .pdf ones, at most PDF_DROP_MAX. */
export function droppedPdfPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  const out: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || path.length > 4_096 || path.includes("\0") || !isAbsolute(path) || !isPdfName(path)) continue;
    if (!out.includes(path)) out.push(path);
    if (out.length >= PDF_DROP_MAX) break;
  }
  return out;
}

/**
 * What main does with a page's navigation to a file: URL (`will-navigate`): "open" a dropped PDF in a new tab, or
 * "refuse". `from` is the page's own address now: a page that is itself a local file may not open another one, and
 * nothing opens while a bot's extraction runs in the page.
 */
export function fileNavigation(url: string, from: string, extracting: boolean): "open" | "refuse" {
  if (extracting || !localPdfPath(url)) return "refuse";
  try { if (new URL(from).protocol === "file:") return "refuse"; } catch { /* a fresh tab (no address yet) */ }
  return "open";
}

/** Whether `path` may open in the pane: a regular file of at most PDF_MAX_BYTES that starts as a PDF does. */
export async function isOpenablePdf(path: string): Promise<boolean> {
  if (!isAbsolute(path) || !isPdfName(path)) return false;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < 5 || info.size > PDF_MAX_BYTES) return false;
    const handle = await open(path, "r");
    try {
      const head = Buffer.alloc(1024);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      // A PDF's header may follow a little junk (the spec allows it within the first 1024 bytes).
      return head.subarray(0, bytesRead).includes("%PDF-");
    } finally { await handle.close(); }
  } catch { return false; }
}

/** A tab's label for a local file: its name. */
export function fileLabel(url: string): string | null {
  const path = localPdfPath(url);
  return path ? basename(path) : null;
}
