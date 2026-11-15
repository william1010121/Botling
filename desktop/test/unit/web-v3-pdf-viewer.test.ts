// @vitest-environment jsdom
// M2 step 15 + M5-10c: the PDF viewer's pure parts (find.ts), viewer URL & overlay (pdf-overlay.ts),
// media.ts ref forwarding, initial page jump, and "Quote in Note" toolbar button (viewer.ts).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pdfQuotes } from "../../src/core/note-pdf-quote";
import { contentUrlPath } from "../../src/protocol";
import { findInPages, fold, locateInPieces, parseContentRange } from "../../web-v3/pdf-viewer/find";
import { MediaBroker } from "../../web-v3/shell/media";
import { closePdfViewer, openPdfViewer, pdfViewerUrl } from "../../web-v3/shell/pdf-overlay";
import { markForBridge } from "../../web-v3/sw-wire";

const OWNER = "srv-mac-1";
const CONTENT_ID = `sha256:${"a".repeat(64)}`;
const REF = { owner: OWNER, id: CONTENT_ID, entry: { stream: "bot:reader", seq: 42 } };

const renderSpy = vi.fn<(pageNo: number) => void>();
const pageTexts: Record<number, string[]> = {
  1: ["Page 1 intro."],
  2: ["Second page ", "quoted passage", " here."],
  3: ["Third page body."],
  4: ["Fourth page end."],
};

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => {
  class MockRangeTransport {
    onDataRange(_begin: number, _bytes: Uint8Array) {}
  }
  class MockTextLayer {
    private readonly container: HTMLElement;
    private readonly textContentSource: { pageNumber: number };
    constructor(opts: { textContentSource: { pageNumber: number }; container: HTMLElement }) {
      this.container = opts.container;
      this.textContentSource = opts.textContentSource;
    }
    async render() {
      const pieces = pageTexts[this.textContentSource.pageNumber] ?? [];
      for (const piece of pieces) {
        const span = document.createElement("span");
        span.textContent = piece;
        this.container.append(span);
      }
    }
  }
  return {
    GlobalWorkerOptions: { workerSrc: "" },
    PDFDataRangeTransport: MockRangeTransport,
    TextLayer: MockTextLayer,
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 4,
        getPage: async (n: number) => ({
          getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
          render: () => ({
            promise: Promise.resolve().then(() => {
              renderSpy(n);
            }),
          }),
          streamTextContent: () => ({ pageNumber: n }),
          getTextContent: async () => ({ items: [] }),
          cleanup: () => {},
        }),
        getOutline: async () => null,
      }),
    }),
  };
});

const PDF_HTML_BODY = (() => {
  const html = readFileSync(resolve(import.meta.dirname, "../../web-v3/pdf-viewer/pdf.html"), "utf8");
  const match = /<body>([\s\S]*)<\/body>/i.exec(html);
  return (match?.[1] ?? "").replace(/<script[\s\S]*?<\/script>/gi, "");
})();

const cleanups: Array<() => void> = [];
const originalParentDescriptor = Object.getOwnPropertyDescriptor(window, "parent");
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

beforeEach(() => {
  renderSpy.mockClear();
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("requestIdleCallback", () => 0);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-range": "bytes 0-2/3" },
  })));
});

afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  closePdfViewer();
  for (const el of [...document.querySelectorAll(".v3-toast")]) el.remove();
  document.body.innerHTML = "";
  location.hash = "";
  window.getSelection()?.removeAllRanges();
  if (originalParentDescriptor) Object.defineProperty(window, "parent", originalParentDescriptor);
  if (originalClipboardDescriptor) Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  else delete (navigator as { clipboard?: unknown }).clipboard;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Content-Range", () => {
  it("reads `bytes a-b/total` and refuses the rest", () => {
    expect(parseContentRange("bytes 0-65535/5219142")).toEqual({ start: 0, end: 65_535, total: 5_219_142 });
    expect(parseContentRange(" bytes 10-10/11 ")).toEqual({ start: 10, end: 10, total: 11 });
    for (const bad of [null, "", "bytes */100", "bytes 5-4/100", "bytes 0-100/100", "items 0-1/2"]) expect(parseContentRange(bad)).toBeNull();
  });
});

describe("find over page text", () => {
  it("folds case and white space, mapping back to the source", () => {
    const folded = fold("  The\n QUOKKA\tsat ");
    expect(folded.text).toBe("the quokka sat ");
    expect(folded.map[4]).toBe(7); // "q" of QUOKKA
  });

  it("finds every hit, page by page, across line ends", () => {
    const pages = ["no match here", "a quokka and\nanother Quokka", "", "the quok\nka"];
    expect(findInPages(pages, "quokka")).toEqual([{ page: 2, nth: 0 }, { page: 2, nth: 1 }]);
    expect(findInPages(pages, "and another")).toEqual([{ page: 2, nth: 0 }]);
    expect(findInPages(pages, "   ")).toEqual([]);
    expect(findInPages(pages, "quokka", 1)).toHaveLength(1);
  });

  it("locates the nth hit in the spans (pieces), also where two spans meet without a space", () => {
    const pieces = ["Line 18 of page 77: the ", "quokka", " sat here."];
    expect(locateInPieces(pieces, "QUOKKA", 0)).toEqual({ from: [1, 0], to: [1, 6] });
    expect(locateInPieces(pieces, "the quokka sat", 0)).toEqual({ from: [0, 20], to: [2, 4] });
    expect(locateInPieces(["one quokka", "two quokka"], "quokka", 1)).toEqual({ from: [1, 4], to: [1, 10] });
    // The text variant had a line end between "search" and "the"; the spans join them with nothing.
    expect(locateInPieces(["steady search", "the end"], "search the", 0)).toEqual({ from: [0, 7], to: [1, 3] });
    expect(locateInPieces(pieces, "wombat", 0)).toBeNull();
    expect(locateInPieces(pieces, "quokka", 1)).toBeNull();
  });
});

describe("the viewer URL", () => {
  it("puts what to read in the hash, never in the query", () => {
    const url = pdfViewerUrl({ src: "/v3/c/o/sha256:ab/original?e=1&t=x", text: "/v3/c/o/sha256:ab/text?e=1&t=x", name: "r é.pdf", size: 12 });
    expect(url.startsWith("./pdf.html#")).toBe(true);
    const hash = new URLSearchParams(url.slice(url.indexOf("#") + 1));
    expect(Object.fromEntries(hash)).toEqual({ src: "/v3/c/o/sha256:ab/original?e=1&t=x", name: "r é.pdf", text: "/v3/c/o/sha256:ab/text?e=1&t=x", size: "12" });
    expect(new URLSearchParams(pdfViewerUrl({ src: "/v3/c/x", name: "a", relay: true }).split("#")[1]).get("chunk")).toBe("262144");
  });

  it("includes owner, id, entry, and page in the hash when ref and page are provided", () => {
    const url = pdfViewerUrl({
      src: "/v3/c/o/sha256:ab/original?e=1&t=x",
      name: "paper.pdf",
      ref: REF,
      page: 3,
    });
    const hash = new URLSearchParams(url.slice(url.indexOf("#") + 1));
    expect(Object.fromEntries(hash)).toEqual({
      src: "/v3/c/o/sha256:ab/original?e=1&t=x",
      name: "paper.pdf",
      owner: REF.owner,
      id: REF.id,
      entry: `${REF.entry.stream}#${REF.entry.seq}`,
      page: "3",
    });
  });
});

describe("M5-10c PDF viewer and overlay", () => {
  it("jumps to the requested page once after loading page 1", async () => {
    document.body.innerHTML = PDF_HTML_BODY;
    const pagesBox = document.getElementById("pages")!;
    Object.defineProperty(pagesBox, "clientWidth", { value: 640, configurable: true });
    let scrollWrites = 0;
    let scrollValue = 0;
    Object.defineProperty(pagesBox, "scrollTop", {
      get: () => scrollValue,
      set: (v: number) => {
        scrollWrites += 1;
        scrollValue = v;
      },
      configurable: true,
    });

    location.hash = `#${new URLSearchParams({
      src: "/v3/c/srv-mac-1/sha256:aa/original?e=bot:reader.1",
      name: "paper.pdf",
      page: "3",
    }).toString()}`;

    const viewer = await import("../../web-v3/pdf-viewer/viewer");
    const stop = await (viewer as unknown as { startPdfViewer(): Promise<() => void> }).startPdfViewer();
    cleanups.push(stop);

    expect(renderSpy.mock.calls.map(([p]) => p)).toEqual([1, 3]);
    expect(scrollWrites).toBe(1);
    expect(document.getElementById("page-no")?.textContent).toBe("3 / 4");
  });

  it("enables Quote in Note only for text-layer selections and posts pdf.quote with page, text, and source", async () => {
    document.body.innerHTML = PDF_HTML_BODY;
    const pagesBox = document.getElementById("pages")!;
    Object.defineProperty(pagesBox, "clientWidth", { value: 640, configurable: true });

    const postMessage = vi.fn();
    Object.defineProperty(window, "parent", { value: { postMessage }, configurable: true });

    location.hash = `#${new URLSearchParams({
      src: "/v3/c/srv-mac-1/sha256:aa/original?e=bot:reader.1",
      name: "paper.pdf",
      owner: REF.owner,
      id: REF.id,
      entry: `${REF.entry.stream}#${REF.entry.seq}`,
      page: "2",
    }).toString()}`;

    const viewer = await import("../../web-v3/pdf-viewer/viewer");
    const stop = await (viewer as unknown as { startPdfViewer(): Promise<() => void> }).startPdfViewer();
    cleanups.push(stop);

    const quoteBtn = document.getElementById("quote-note") as HTMLButtonElement | null;
    expect(quoteBtn).not.toBeNull();
    expect(quoteBtn!.textContent?.trim()).toBe("Quote in Note");
    expect(quoteBtn!.disabled).toBe(true);

    // Selecting text outside .textLayer (e.g. the title) keeps the button disabled.
    const titleEl = document.getElementById("title")!;
    const titleRange = document.createRange();
    titleRange.selectNodeContents(titleEl.firstChild!);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(titleRange);
    document.dispatchEvent(new Event("selectionchange"));
    expect(quoteBtn!.disabled).toBe(true);

    // Selecting text inside page 2's .textLayer enables the button and posts pdf.quote.
    const page2Text = document.querySelector('.page[data-page="2"] .textLayer')!;
    const span = page2Text.querySelectorAll("span")[1]!;
    const page2Range = document.createRange();
    page2Range.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(page2Range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(quoteBtn!.disabled).toBe(false);

    quoteBtn!.click();
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [payload, targetOrigin] = postMessage.mock.calls[0]!;
    expect(targetOrigin).toBe(location.origin);
    expect(payload).toMatchObject({ botling3: "pdf.quote" });
    expect(pdfQuotes(payload.markup)).toEqual([
      { line: 0, name: "paper.pdf", page: 2, text: "quoted passage", source: REF },
    ]);
  });

  it("posts pdf.quote with source: null when hash has no reference", async () => {
    document.body.innerHTML = PDF_HTML_BODY;
    Object.defineProperty(document.getElementById("pages")!, "clientWidth", { value: 640, configurable: true });

    const postMessage = vi.fn();
    Object.defineProperty(window, "parent", { value: { postMessage }, configurable: true });

    location.hash = `#${new URLSearchParams({
      src: "/v3/c/srv-mac-1/sha256:aa/original?e=bot:reader.1",
      name: "notes.pdf",
      page: "2",
    }).toString()}`;

    const viewer = await import("../../web-v3/pdf-viewer/viewer");
    const stop = await (viewer as unknown as { startPdfViewer(): Promise<() => void> }).startPdfViewer();
    cleanups.push(stop);

    const span = document.querySelectorAll('.page[data-page="2"] .textLayer span')[1]!;
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    (document.getElementById("quote-note") as HTMLButtonElement).click();
    const [payload] = postMessage.mock.calls[0]!;
    expect(pdfQuotes(payload.markup)).toEqual([
      { line: 0, name: "notes.pdf", page: 2, text: "quoted passage", source: null },
    ]);
  });

  it("overlay copies markup from its same-origin viewer frame and shows the exact toast (and error toast on refusal)", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const frame = openPdfViewer({ src: "/v3/c/srv-mac-1/sha256:aa/original?e=bot:reader.1", name: "paper.pdf" });
    const markup = "> 〔PDF · paper.pdf · p. 2〕\n> quoted";

    // Cross-origin or foreign source must be ignored.
    window.dispatchEvent(new MessageEvent("message", {
      data: { botling3: "pdf.quote", markup },
      origin: "https://evil.example",
      source: frame.contentWindow,
    }));
    window.dispatchEvent(new MessageEvent("message", {
      data: { botling3: "pdf.quote", markup },
      origin: location.origin,
      source: window,
    }));
    await Promise.resolve();
    expect(writeText).not.toHaveBeenCalled();

    // Valid frame + same origin copies and shows exact success toast.
    window.dispatchEvent(new MessageEvent("message", {
      data: { botling3: "pdf.quote", markup },
      origin: location.origin,
      source: frame.contentWindow,
    }));
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Quote copied. Paste it into the Note.");
    });
    expect(writeText).toHaveBeenCalledWith(markup);

    // Clipboard refusal shows exact error toast.
    writeText.mockRejectedValueOnce(new Error("denied"));
    window.dispatchEvent(new MessageEvent("message", {
      data: { botling3: "pdf.quote", markup },
      origin: location.origin,
      source: frame.contentWindow,
    }));
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Could not copy the quote.");
    });
  });

  it("MediaBroker passes ref parsed from the content URL to openPdfViewer (tailnet and relay bridge URLs)", async () => {
    const ticket = "A".repeat(43);
    const link = {
      state: "live",
      on: () => () => {},
      remoteContent: async () => ({
        t: "content.located",
        ref: { ...REF, type: "application/pdf", state: "ready", size: 2048 },
        ticket,
        variants: [{ name: "original", id: REF.id, size: 2048 }],
      }),
    };
    const fakeFrame = { postMessage: vi.fn() } as unknown as Window;
    const broker = new MediaBroker(link as never, () => fakeFrame, undefined, {
      bridge: {
        ready: Promise.resolve(true),
        url: (u: string) => markForBridge(u),
        start() {},
        stop() {},
      } as never,
    });
    broker.start();
    cleanups.push(() => broker.stop());

    window.dispatchEvent(new MessageEvent("message", {
      source: fakeFrame,
      data: { botling3: "media.want", items: [{ key: "k1", botId: "b1", line: "l1", url: "file:///docs/paper.pdf" }] },
    }));
    await new Promise((r) => setTimeout(r, 10));

    window.dispatchEvent(new MessageEvent("message", {
      source: fakeFrame,
      data: { botling3: "media.open", key: "k1" },
    }));

    const frame = document.querySelector<HTMLIFrameElement>("iframe.v3-pdf");
    expect(frame).not.toBeNull();
    const expectedSrc = markForBridge(contentUrlPath({ ...REF, variant: "original", ticket }));
    const hash = new URLSearchParams(frame!.src.slice(frame!.src.indexOf("#") + 1));
    expect(hash.get("src")).toBe(expectedSrc);
    expect(hash.get("owner")).toBe(REF.owner);
    expect(hash.get("id")).toBe(REF.id);
    expect(hash.get("entry")).toBe(`${REF.entry.stream}#${REF.entry.seq}`);
  });
});
