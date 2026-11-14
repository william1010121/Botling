// The owner's PDF text job (M2 step 15, protocol v1 §9A.8, D37, D38): page count, outline and page text, read with
// pdf.js in Node (pure JavaScript, no extra install, no network). It runs in a child process (`pdf-text-main.ts`, built
// to out/server/pdf-text.cjs) under `nice` with a time limit, like the other media tools, so a hostile or huge PDF can
// cost botlingd neither its event loop nor its memory.
//
// This module holds the format (botlingd imports it); pdf-extract.ts holds the pdf.js part (only the child bundles it).
//
// - The worker part of pdf.js runs in the same (child) process: `globalThis.pdfjsWorker` is set from the bundled worker
//   module, so pdf.js never imports a file by URL.
// - `@napi-rs/canvas` (pdf.js's optional native polyfill for rendering in Node) is never loaded: the bundle has no
//   `import.meta.url`, so pdf.js's `createRequire` fails and it warns (silenced, verbosity errors only). Text needs no
//   canvas.
// - The packed CMaps (CJK text in non-embedded CID fonts) are read from `pdfjs/cmaps/` beside the script (copied there
//   by build.mjs), else from node_modules (dev and tests).
// - The page text is the text items in order, an item with `hasEOL` ending its line: what pdf.js's text layer shows,
//   so a find in the FE over this text lands on the spans it draws.

/** What the `text` variant holds (JSON, read by range like any content; never in the log). */
export interface PdfText {
  v: 1;
  pages: number;
  /** The document outline, at most OUTLINE_MAX items; `page` is 1-based (absent when the target is unknown). */
  outline: PdfOutlineItem[];
  /** One string per page (page 1 first). */
  text: string[];
  /** Set when the text was cut at TEXT_MAX_CHARS (the pages after it are empty strings). */
  truncated?: true;
  title?: string;
}

export interface PdfOutlineItem { title: string; page?: number; items?: PdfOutlineItem[] }

export const OUTLINE_MAX = 2_000;
export const OUTLINE_DEPTH = 8;
export const TEXT_MAX_CHARS = 32 * 1024 * 1024;
/** A PDF above this many bytes gets no text (the child would hold it all in memory). */
export const PDF_TEXT_MAX_BYTES = 512 * 1024 * 1024;

/** A page's text from its text items: each item's string, an item with `hasEOL` ending its line (the FE's text layer). */
export function pageText(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  let text = "";
  for (const item of items) {
    if (typeof item.str === "string") text += item.str;
    if (item.hasEOL) text += "\n";
  }
  return text;
}
