// The PDF viewer over the page (M2 step 15, M5-10c): the shell opens `/v3/pdf.html` in a full-screen frame of its
// own origin, with what to read in the hash (the ticketed URL, the text variant's URL, the name, the size, the range
// size, and optionally owner/id/entry/page), so the session stays up underneath. The viewer's ✕ (or Escape) posts
// `pdf.close`; Quote in Note posts `pdf.quote` with the Note quote markup.
export interface PdfRef {
  owner: string;
  id: string;
  entry: { stream: string; seq: number };
}

export interface PdfOpen {
  src: string;
  text?: string;
  name: string;
  size?: number;
  relay?: boolean;
  ref?: PdfRef;
  page?: number;
}

const QUOTE_COPIED = "Quote copied. Paste it into the Note.";
const QUOTE_COPY_FAILED = "Could not copy the quote.";

/** The viewer's URL for `open` (relative to the page, under its base path). */
export function pdfViewerUrl(open: PdfOpen, base = "./pdf.html"): string {
  const hash = new URLSearchParams({ src: open.src, name: open.name });
  if (open.text) hash.set("text", open.text);
  if (open.size !== undefined) hash.set("size", String(open.size));
  if (open.relay) hash.set("chunk", "262144");
  if (open.ref) {
    hash.set("owner", open.ref.owner);
    hash.set("id", open.ref.id);
    hash.set("entry", `${open.ref.entry.stream}#${open.ref.entry.seq}`);
  }
  if (open.page !== undefined && Number.isInteger(open.page) && open.page >= 1) {
    hash.set("page", String(open.page));
  }
  return `${base}#${hash.toString()}`;
}

let shown: { frame: HTMLIFrameElement; off: () => void } | null = null;
let toast: { el: HTMLDivElement; timer: ReturnType<typeof setTimeout> } | null = null;

function showToast(text: string): void {
  if (toast) {
    clearTimeout(toast.timer);
    toast.el.remove();
  }
  const el = document.createElement("div");
  el.className = "v3-toast";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.dataset.testid = "pdf-toast";
  el.textContent = text;
  document.body.append(el);
  const timer = setTimeout(() => {
    el.remove();
    if (toast?.el === el) toast = null;
  }, 3_000);
  toast = { el, timer };
}

async function copyQuote(markup: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(markup);
    showToast(QUOTE_COPIED);
  } catch {
    showToast(QUOTE_COPY_FAILED);
  }
}

export function closePdfViewer(): void {
  if (!shown) return;
  shown.off();
  shown.frame.remove();
  shown = null;
}

export function openPdfViewer(open: PdfOpen): HTMLIFrameElement {
  closePdfViewer();
  const frame = document.createElement("iframe");
  frame.className = "v3-pdf";
  frame.title = open.name;
  frame.dataset.testid = "pdf-viewer";
  frame.src = pdfViewerUrl(open);
  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
    const data = event.data as { botling3?: unknown; markup?: unknown } | null;
    if (!data || typeof data !== "object") return;
    if (data.botling3 === "pdf.close") closePdfViewer();
    else if (data.botling3 === "pdf.quote" && typeof data.markup === "string") void copyQuote(data.markup);
  };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closePdfViewer(); };
  window.addEventListener("message", onMessage);
  window.addEventListener("keydown", onKey);
  document.body.append(frame);
  shown = { frame, off: () => { window.removeEventListener("message", onMessage); window.removeEventListener("keydown", onKey); } };
  frame.focus();
  return frame;
}
