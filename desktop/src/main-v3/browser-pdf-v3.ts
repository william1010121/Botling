// The browser pane's PDFs in Botling 3 (M1 step 13, protocol v1 §9A.8): the same rules as 2.x (browser-pdf.ts), but a
// PDF tab loads `botling-content://file/<token>/<name>` instead of a `file:` URL. The v3 build resolves the 2.x main's
// `../browser-pdf` imports to this module (build.mjs `browserPdfToContent`); 2.x itself is unchanged.
import { basename } from "node:path";
import * as base from "../browser-pdf";
import { fileGrants } from "./content-protocol";

export * from "../browser-pdf";

/** The URL a tab of a local PDF loads: a content URL main answers (content-install.ts), never `file:`. */
export function pdfFileUrl(path: string): string {
  return fileGrants.grant(path);
}

/** The local path of a PDF tab's URL (a granted content URL), or what 2.x reads from a `file:` URL. */
export function localPdfPath(url: string): string | null {
  return fileGrants.path(url) ?? base.localPdfPath(url);
}

/** A tab's label for a local file: its name. */
export function fileLabel(url: string): string | null {
  const path = fileGrants.path(url);
  return path ? basename(path) : base.fileLabel(url);
}

/** As 2.x, and a PDF tab (now a content URL) may not open another local file either. */
export function fileNavigation(url: string, from: string, extracting: boolean): "open" | "refuse" {
  if (from.startsWith("botling-content:")) return "refuse";
  return base.fileNavigation(url, from, extracting);
}
