// The pdf.js part of the PDF text job (M2 step 15; see pdf-text.ts): bundled only into out/server/pdf-text.cjs, never
// into botlingd itself.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { OUTLINE_DEPTH, OUTLINE_MAX, pageText, TEXT_MAX_CHARS, type PdfOutlineItem, type PdfText } from "./pdf-text";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let loaded: Promise<PdfJs> | null = null;
async function pdfjs(): Promise<PdfJs> {
  loaded ??= (async () => {
    // pdf.js warns at load that it cannot reach `require` (on purpose, see above) and cannot polyfill canvas classes:
    // nothing text needs, so those lines are not printed.
    const { log, warn } = console;
    const quiet = (print: (...args: unknown[]) => void) => (...args: unknown[]) => { if (!/^Warning: Cannot (access the `require`|polyfill|load "@napi-rs)/.test(String(args[0]))) print(...args); };
    console.log = quiet(log);
    console.warn = quiet(warn);
    try {
      // @ts-expect-error pdfjs-dist ships no types for the worker module (it is only handed to pdf.js).
      const worker: unknown = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
      (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
      return await import("pdfjs-dist/legacy/build/pdf.mjs");
    } finally { console.log = log; console.warn = warn; }
  })();
  return loaded;
}

/** The packed CMaps folder (with a trailing slash), or undefined. */
export function cmapsDir(base: string = typeof __dirname === "string" ? __dirname : process.cwd()): string | undefined {
  const candidates = [join(base, "pdfjs", "cmaps"), join(base, "..", "pdfjs", "cmaps")];
  try { candidates.push(join(dirname(require.resolve("pdfjs-dist/package.json")), "cmaps")); } catch { /* not installed (packaged app), or no require */ }
  candidates.push(join(process.cwd(), "node_modules", "pdfjs-dist", "cmaps"));
  const found = candidates.find((dir) => existsSync(join(dir, "UniGB-UCS2-H.bcmap")));
  return found ? `${found}/` : undefined;
}

interface OutlineNode { title: string; dest: string | unknown[] | null; items: OutlineNode[] }

/** Reads `data` (the PDF's bytes) into page count, outline and page text. */
export async function extractPdfText(data: Uint8Array, options: { cMapUrl?: string } = {}): Promise<PdfText> {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data, verbosity: 0, isEvalSupported: false, useWasm: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false,
    ...(options.cMapUrl ? { cMapUrl: options.cMapUrl, cMapPacked: true } : {}),
  } as Parameters<PdfJs["getDocument"]>[0]);
  const doc = await task.promise;
  try {
    const out: PdfText = { v: 1, pages: doc.numPages, outline: [], text: [] };
    try {
      const meta = await doc.getMetadata();
      const title = (meta.info as { Title?: unknown } | undefined)?.Title;
      if (typeof title === "string" && title.trim()) out.title = title.trim().slice(0, 1_000);
    } catch { /* no metadata */ }
    let count = 0;
    const pageOf = async (dest: OutlineNode["dest"]): Promise<number | undefined> => {
      try {
        const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
        const target = Array.isArray(explicit) ? explicit[0] : null;
        if (target && typeof target === "object") return (await doc.getPageIndex(target as Parameters<typeof doc.getPageIndex>[0])) + 1;
        if (Number.isInteger(target)) return Number(target) + 1;
      } catch { /* unknown target */ }
      return undefined;
    };
    const walk = async (nodes: OutlineNode[], depth: number): Promise<PdfOutlineItem[]> => {
      const items: PdfOutlineItem[] = [];
      for (const node of nodes) {
        if (count >= OUTLINE_MAX) break;
        count++;
        const page = await pageOf(node.dest);
        const item: PdfOutlineItem = { title: String(node.title ?? "").slice(0, 500), ...(page ? { page } : {}) };
        if (node.items?.length && depth < OUTLINE_DEPTH) {
          const children = await walk(node.items, depth + 1);
          if (children.length) item.items = children;
        }
        items.push(item);
      }
      return items;
    };
    try { out.outline = await walk(((await doc.getOutline()) ?? []) as OutlineNode[], 1); } catch { out.outline = []; }
    let chars = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      if (chars >= TEXT_MAX_CHARS) { out.truncated = true; out.text.push(""); continue; }
      let text = "";
      try {
        const page = await doc.getPage(n);
        text = pageText((await page.getTextContent()).items as Array<{ str?: string; hasEOL?: boolean }>);
        page.cleanup();
      } catch { text = ""; }
      if (chars + text.length > TEXT_MAX_CHARS) { text = text.slice(0, TEXT_MAX_CHARS - chars); out.truncated = true; }
      chars += text.length;
      out.text.push(text);
    }
    return out;
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

