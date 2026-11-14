// Botling 3's PDF viewer (M2 step 15, protocol v1 §9A.8, D38): pdf.js on the page's own origin, under the page's CSP
// (`script-src 'self'`: the bundle and pdf.js's worker are files of `/v3/`, no eval, no WebAssembly, no CDN).
//
// Opened by the shell as `/v3/pdf.html#src=<ticketed /v3/c/ URL>&text=<the text variant's URL>&name=…&size=…&chunk=…`
// (the hash never reaches a server or a referrer). Only same-origin `/v3/c/` URLs are read.
//
// - Range loading only: the first range answer gives the size (Content-Range), then pdf.js asks for the ranges it
//   needs through a PDFDataRangeTransport (auto-fetch off, no full-file request ever): the trailer and cross-reference
//   table, then page 1's objects, so page 1 shows before the file has arrived. 64 KiB ranges (256 KiB when the shell
//   says the path is the relay).
// - Pages render as they come into view (placeholders sized from page 1), canvases far from the view are released (a
//   phone's canvas memory is small), and the next two pages are read ahead at low priority.
// - The text layer (pdf.js `TextLayer`) makes the text selectable. Find searches the owner's prepared page text (the
//   `text` variant, one small read) and, without it, each page's text from pdf.js; a hit scrolls to its page and is
//   marked in the text layer. The outline comes from the same prepared text (or pdf.js).
// - `globalThis.botling3Pdf` holds what the tests read: timings, every range read, the bytes read before page 1.
import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { findInPages, locateInPieces, markHit, parseContentRange, unmark, type FindHit } from "./find";

interface Read { start: number; end: number; bytes: number; ms: number; at: number }
interface PdfDiagnostics {
  state: "loading" | "ready" | "error";
  error?: string;
  size?: number;
  pages?: number;
  chunk: number;
  reads: Read[];
  bytes: number;
  /** ms from navigation start to page 1 drawn, and the bytes read until then. */
  firstPageMs?: number;
  bytesBeforeFirstPage?: number;
  readsBeforeFirstPage?: number;
  rendered: number[];
  textLayers: number[];
  zoom?: number;
  find?: { query: string; hits: number; source: "text" | "pdf"; at?: FindHit; marked: number };
  outline?: number;
  fullRequests: number;
}

const diag: PdfDiagnostics = { state: "loading", chunk: 0, reads: [], bytes: 0, rendered: [], textLayers: [], fullRequests: 0 };
(globalThis as { botling3Pdf?: PdfDiagnostics }).botling3Pdf = diag;

const params = new URLSearchParams(location.hash.slice(1));
const src = params.get("src") ?? "";
const textSrc = params.get("text");
const name = params.get("name") || "document.pdf";
const CHUNK = params.get("chunk") === "262144" ? 262_144 : 65_536;
diag.chunk = CHUNK;
/** Canvases more than this many pages from the view are released. */
const KEEP_AROUND = 3;
const MAX_DPR = 2;
/** A page canvas has at most this many pixels (iOS limits canvas memory). */
const MAX_CANVAS_PIXELS = 8 * 1024 * 1024;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pagesBox = $<HTMLDivElement>("pages");
const statusEl = $<HTMLSpanElement>("status");
const titleEl = $<HTMLSpanElement>("title");
const pageNo = $<HTMLSpanElement>("page-no");
const zoomOut = $<HTMLButtonElement>("zoom-out");
const zoomIn = $<HTMLButtonElement>("zoom-in");
const findBar = $<HTMLFormElement>("find-bar");
const findInput = $<HTMLInputElement>("find-input");
const findCount = $<HTMLSpanElement>("find-count");
const outlineBox = $<HTMLDivElement>("outline");
titleEl.textContent = name;
document.title = name;

function sameOriginContent(url: string): boolean {
  try {
    const parsed = new URL(url, location.href);
    return parsed.origin === location.origin && parsed.pathname.startsWith("/v3/c/");
  } catch { return false; }
}

async function readRange(start: number, end: number): Promise<{ bytes: Uint8Array; total: number | null; whole: boolean }> {
  const t0 = performance.now();
  const response = await fetch(src, { headers: { Range: `bytes=${start}-${end - 1}` }, credentials: "omit", cache: "no-store" });
  if (response.status !== 206 && response.status !== 200) throw new Error(response.headers.get("x-botling-status") ? `the file could not be read (${response.headers.get("x-botling-status")})` : `the file could not be read (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const range = parseContentRange(response.headers.get("content-range"));
  const whole = response.status === 200;
  if (whole) diag.fullRequests += 1;
  diag.reads.push({ start, end: start + bytes.length, bytes: bytes.length, ms: Math.round(performance.now() - t0), at: Math.round(performance.now()) });
  diag.bytes += bytes.length;
  return { bytes, total: range?.total ?? (whole ? bytes.length : null), whole };
}

class RangeTransport extends PDFDataRangeTransport {
  override requestDataRange(begin: number, end: number): void {
    readRange(begin, end).then(({ bytes }) => this.onDataRange(begin, bytes), (error: unknown) => fail(error));
  }
}

function fail(error: unknown): void {
  if (diag.state === "error") return;
  diag.state = "error";
  diag.error = String((error as Error)?.message ?? error);
  statusEl.textContent = `This PDF could not be opened: ${diag.error}`;
  statusEl.dataset.testid = "pdf-error";
}

let doc: PDFDocumentProxy;
interface Slot { n: number; div: HTMLDivElement; width: number; height: number; scale: number; rendered: boolean; rendering: Promise<void> | null; canvas: HTMLCanvasElement | null; text: HTMLDivElement | null; spans: HTMLElement[]; page: PDFPageProxy | null }
const slots: Slot[] = [];
let fitWidth = 0;
let current = 1;
/** The zoom over the page width (a phone shows a Letter page's body text at ≈ 6 px at width; the person zooms in). */
const ZOOMS = [1, 1.5, 2, 3];
let zoom = 1;

function viewWidth(): number { return Math.max(200, Math.min(pagesBox.clientWidth - 16, 1_400)); }

async function open(): Promise<void> {
  if (!sameOriginContent(src)) throw new Error("no file to open");
  GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.mjs", location.href).href;
  statusEl.textContent = "Loading…";
  const first = await readRange(0, CHUNK);
  if (first.total === null) throw new Error("the server sent no size");
  diag.size = first.total;
  const common = {
    isEvalSupported: false, useWasm: false, enableXfa: false, disableAutoFetch: true, disableStream: true, rangeChunkSize: CHUNK,
    cMapUrl: new URL("./pdfjs/cmaps/", location.href).href, cMapPacked: true,
    standardFontDataUrl: new URL("./pdfjs/standard_fonts/", location.href).href, verbosity: 0,
  };
  const task = first.whole || first.bytes.length >= first.total
    ? getDocument({ ...common, data: first.bytes } as Parameters<typeof getDocument>[0])
    : getDocument({ ...common, range: new RangeTransport(first.total, first.bytes), length: first.total } as Parameters<typeof getDocument>[0]);
  doc = await task.promise;
  diag.pages = doc.numPages;
  const page1 = await doc.getPage(1);
  const base = page1.getViewport({ scale: 1 });
  fitWidth = viewWidth();
  for (let n = 1; n <= doc.numPages; n++) {
    const div = document.createElement("div");
    div.className = "page";
    div.dataset.page = String(n);
    pagesBox.append(div);
    const slot: Slot = { n, div, width: base.width, height: base.height, scale: fitWidth / base.width, rendered: false, rendering: null, canvas: null, text: null, spans: [], page: n === 1 ? page1 : null };
    size(slot);
    slots.push(slot);
  }
  statusEl.textContent = "";
  pageNo.textContent = `1 / ${doc.numPages}`;
  await render(slots[0]!);
  diag.state = "ready";
  observe();
}

function size(slot: Slot): void {
  slot.scale = (fitWidth * zoom) / slot.width;
  slot.div.style.width = `${Math.floor(slot.width * slot.scale)}px`;
  slot.div.style.height = `${Math.floor(slot.height * slot.scale)}px`;
}

async function pageOf(slot: Slot): Promise<PDFPageProxy> {
  if (!slot.page) {
    slot.page = await doc.getPage(slot.n);
    const viewport = slot.page.getViewport({ scale: 1 });
    if (viewport.width !== slot.width || viewport.height !== slot.height) { slot.width = viewport.width; slot.height = viewport.height; size(slot); }
  }
  return slot.page;
}

function render(slot: Slot): Promise<void> {
  if (slot.rendered) return Promise.resolve();
  slot.rendering ??= (async () => {
    const page = await pageOf(slot);
    const viewport = page.getViewport({ scale: slot.scale });
    let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    if (viewport.width * viewport.height * dpr * dpr > MAX_CANVAS_PIXELS) dpr = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined } as Parameters<PDFPageProxy["render"]>[0]).promise;
    slot.div.replaceChildren(canvas);
    slot.canvas = canvas;
    slot.rendered = true;
    diag.rendered.push(slot.n);
    if (slot.n === 1 && diag.firstPageMs === undefined) {
      diag.firstPageMs = Math.round(performance.now());
      diag.bytesBeforeFirstPage = diag.bytes;
      diag.readsBeforeFirstPage = diag.reads.length;
      document.body.dataset.firstPage = "shown";
    }
    // The text layer over the canvas: selectable text, and where find marks its hit.
    const text = document.createElement("div");
    text.className = "textLayer";
    slot.div.style.setProperty("--scale-factor", String(slot.scale));
    slot.div.style.setProperty("--total-scale-factor", String(slot.scale));
    slot.div.append(text);
    const layer = new TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
    await layer.render();
    slot.text = text;
    slot.spans = [...text.querySelectorAll<HTMLElement>("span:not(.markedContent)")].filter((span) => !span.classList.contains("endOfContent"));
    diag.textLayers.push(slot.n);
    readAhead(slot.n);
  })().catch((error: unknown) => { slot.rendering = null; if (slot.n === 1) throw error; }).finally(() => { if (!slot.rendered) slot.rendering = null; });
  return slot.rendering;
}

/** Releases a far page's canvas and text layer (it renders again when it comes back). */
function release(slot: Slot): void {
  if (!slot.rendered) return;
  if (slot.canvas) { slot.canvas.width = 0; slot.canvas.height = 0; }
  slot.div.replaceChildren();
  slot.canvas = null;
  slot.text = null;
  slot.spans = [];
  slot.rendered = false;
  slot.rendering = null;
  slot.page?.cleanup();
}

/** A low-priority read of the next two pages' data (their objects and content streams), after the view's pages. */
function readAhead(n: number): void {
  const idle = (fn: () => void) => ((globalThis as { requestIdleCallback?: (fn: () => void, o?: unknown) => void }).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 200)))(fn, { timeout: 1_000 });
  for (const next of [n + 1, n + 2]) {
    const slot = slots[next - 1];
    if (!slot || slot.rendered || slot.rendering || slot.page) continue;
    idle(() => { void pageOf(slot).then((page) => page.getOperatorList()).catch(() => undefined); });
  }
}

function observe(): void {
  const visible = new Set<number>();
  const io = new IntersectionObserver((records) => {
    for (const record of records) {
      const n = Number((record.target as HTMLElement).dataset.page);
      if (record.isIntersecting) visible.add(n); else visible.delete(n);
    }
    if (!visible.size) return;
    const shown = [...visible].sort((a, b) => a - b);
    for (const n of shown) void render(slots[n - 1]!);
    for (const slot of slots) if (slot.rendered && (slot.n < shown[0]! - KEEP_AROUND || slot.n > shown.at(-1)! + KEEP_AROUND)) release(slot);
  }, { root: pagesBox, rootMargin: "50% 0px" });
  for (const slot of slots) io.observe(slot.div);
  pagesBox.addEventListener("scroll", () => {
    const mid = pagesBox.scrollTop + pagesBox.clientHeight / 3;
    const slot = slots.find((s) => s.div.offsetTop + s.div.offsetHeight > mid);
    if (slot && slot.n !== current) { current = slot.n; pageNo.textContent = `${current} / ${doc.numPages}`; }
  }, { passive: true });
  let width = fitWidth;
  new ResizeObserver(() => {
    const now = viewWidth();
    if (Math.abs(now - width) < 8) return;
    width = now;
    fitWidth = now;
    const at = current;
    for (const slot of slots) { release(slot); size(slot); }
    goTo(at);
  }).observe(pagesBox);
}

/** Zooms by `step` levels, keeping the place in the page being read. */
function setZoom(step: number): void {
  const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + step))]!;
  if (next === zoom || !slots.length) return;
  const slot = slots[current - 1]!;
  const within = (pagesBox.scrollTop - slot.div.offsetTop) / slot.div.offsetHeight;
  const across = pagesBox.scrollWidth > pagesBox.clientWidth ? (pagesBox.scrollLeft + pagesBox.clientWidth / 2) / pagesBox.scrollWidth : 0.5;
  zoom = next;
  diag.zoom = zoom;
  for (const s of slots) { release(s); size(s); }
  pagesBox.scrollTop = slot.div.offsetTop + within * slot.div.offsetHeight;
  pagesBox.scrollLeft = across * pagesBox.scrollWidth - pagesBox.clientWidth / 2;
  zoomOut.disabled = zoom === ZOOMS[0];
  zoomIn.disabled = zoom === ZOOMS.at(-1);
  void render(slot);
}

function goTo(n: number): Promise<void> {
  const slot = slots[Math.max(1, Math.min(n, slots.length)) - 1];
  if (!slot) return Promise.resolve();
  pagesBox.scrollTop = slot.div.offsetTop - 4;
  return render(slot);
}

// --- Find ----------------------------------------------------------------------------------------------------------

let prepared: Promise<{ text: string[]; outline: Array<{ title: string; page?: number; items?: unknown[] }> } | null> | null = null;
/** The owner's prepared text (one read of the `text` variant), or null without it. */
function preparedText(): Promise<{ text: string[]; outline: Array<{ title: string; page?: number; items?: unknown[] }> } | null> {
  prepared ??= (async () => {
    if (!textSrc || !sameOriginContent(textSrc)) return null;
    try {
      const response = await fetch(textSrc, { credentials: "omit", cache: "no-store" });
      if (response.status !== 200) return null;
      const body = await response.json() as { v?: number; text?: unknown; outline?: unknown };
      return body.v === 1 && Array.isArray(body.text) ? { text: body.text.map(String), outline: Array.isArray(body.outline) ? body.outline as never : [] } : null;
    } catch { return null; }
  })();
  return prepared;
}

let pdfPagesText: string[] | null = null;
async function pagesText(): Promise<{ text: string[]; source: "text" | "pdf" }> {
  const ready = await preparedText();
  if (ready) return { text: ready.text, source: "text" };
  if (!pdfPagesText) {
    const out: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await pageOf(slots[n - 1]!)).getTextContent();
      out.push(content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join(""));
    }
    pdfPagesText = out;
  }
  return { text: pdfPagesText, source: "pdf" };
}

let hits: FindHit[] = [];
let hitIndex = -1;
let lastQuery = "";
const marked = new Set<HTMLElement>();

async function find(query: string, step: 1 | -1): Promise<void> {
  if (query !== lastQuery) {
    lastQuery = query;
    const { text, source } = await pagesText();
    hits = findInPages(text, query);
    hitIndex = -1;
    diag.find = { query, hits: hits.length, source, marked: 0 };
  }
  if (!hits.length) { findCount.textContent = query ? "No match" : ""; return; }
  hitIndex = (hitIndex + step + hits.length) % hits.length;
  const hit = hits[hitIndex]!;
  findCount.textContent = `${hitIndex + 1} / ${hits.length}`;
  await goTo(hit.page);
  const slot = slots[hit.page - 1]!;
  await render(slot);
  unmark(marked);
  marked.clear();
  const place = locateInPieces(slot.spans.map((span) => span.textContent ?? ""), query, hit.nth);
  const marks = place ? markHit(slot.spans, place) : [];
  for (let p = place?.from[0] ?? 0; place && p <= place.to[0]; p++) marked.add(slot.spans[p]!);
  marks[0]?.scrollIntoView({ block: "center" });
  diag.find = { ...diag.find!, at: hit, marked: marks.length };
}

findBar.addEventListener("submit", (event) => { event.preventDefault(); void find(findInput.value, 1); });
$("find-prev").addEventListener("click", () => void find(findInput.value, -1));
$("find-toggle").addEventListener("click", () => {
  findBar.hidden = !findBar.hidden;
  if (!findBar.hidden) findInput.focus();
});

// --- Outline -------------------------------------------------------------------------------------------------------

interface OutlineItem { title: string; page?: number; items?: OutlineItem[] }
async function outline(): Promise<OutlineItem[]> {
  const ready = await preparedText();
  if (ready) return ready.outline as OutlineItem[];
  const raw = (await doc.getOutline()) ?? [];
  const walk = async (nodes: typeof raw): Promise<OutlineItem[]> => Promise.all(nodes.map(async (node) => {
    let page: number | undefined;
    try {
      const dest = typeof node.dest === "string" ? await doc.getDestination(node.dest) : node.dest;
      if (Array.isArray(dest) && dest[0] && typeof dest[0] === "object") page = (await doc.getPageIndex(dest[0] as never)) + 1;
    } catch { /* unknown */ }
    return { title: node.title, ...(page ? { page } : {}), ...(node.items?.length ? { items: await walk(node.items) } : {}) };
  }));
  return walk(raw);
}

zoomOut.addEventListener("click", () => setZoom(-1));
zoomIn.addEventListener("click", () => setZoom(1));

$("outline-toggle").addEventListener("click", async () => {
  if (!outlineBox.hidden) { outlineBox.hidden = true; return; }
  const items = await outline();
  diag.outline = items.length;
  const list = document.createElement("ul");
  const add = (parent: HTMLUListElement, entries: OutlineItem[]) => {
    for (const entry of entries) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = entry.title || "(untitled)";
      if (entry.page) button.addEventListener("click", () => { outlineBox.hidden = true; void goTo(entry.page!); });
      li.append(button);
      if (entry.items?.length) { const sub = document.createElement("ul"); add(sub, entry.items); li.append(sub); }
      parent.append(li);
    }
  };
  add(list, items);
  outlineBox.replaceChildren(items.length ? list : Object.assign(document.createElement("p"), { textContent: "This PDF has no contents list." }));
  outlineBox.hidden = false;
});

$("close").addEventListener("click", () => {
  if (window.parent !== window) window.parent.postMessage({ botling3: "pdf.close" }, location.origin);
  else history.back();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && window.parent !== window) window.parent.postMessage({ botling3: "pdf.close" }, location.origin);
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") { event.preventDefault(); findBar.hidden = false; findInput.focus(); }
});

open().catch(fail);
