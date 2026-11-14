// The PDF viewer over the page (M2 step 15): the shell opens `/v3/pdf.html` in a full-screen frame of its own origin,
// with what to read in the hash (the ticketed URL, the text variant's URL, the name, the size, the range size), so the
// session stays up underneath. The viewer's ✕ (or Escape) posts `pdf.close`; the shell removes the frame.
export interface PdfOpen { src: string; text?: string; name: string; size?: number; relay?: boolean }

/** The viewer's URL for `open` (relative to the page, under its base path). */
export function pdfViewerUrl(open: PdfOpen, base = "./pdf.html"): string {
  const hash = new URLSearchParams({ src: open.src, name: open.name });
  if (open.text) hash.set("text", open.text);
  if (open.size !== undefined) hash.set("size", String(open.size));
  if (open.relay) hash.set("chunk", "262144");
  return `${base}#${hash.toString()}`;
}

let shown: { frame: HTMLIFrameElement; off: () => void } | null = null;

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
    if (event.source === frame.contentWindow && event.origin === location.origin && (event.data as { botling3?: string } | null)?.botling3 === "pdf.close") closePdfViewer();
  };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closePdfViewer(); };
  window.addEventListener("message", onMessage);
  window.addEventListener("keydown", onKey);
  document.body.append(frame);
  shown = { frame, off: () => { window.removeEventListener("message", onMessage); window.removeEventListener("keydown", onKey); } };
  frame.focus();
  return frame;
}
