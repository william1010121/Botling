// M2 step 15: the PDF viewer's pure parts (web-v3/pdf-viewer/find.ts) — reading a range answer, find over the owner's
// page text, locating a hit in pdf.js's text-layer spans — and the viewer URL the shell opens (web-v3/shell/pdf-overlay.ts).
import { describe, expect, it } from "vitest";
import { findInPages, fold, locateInPieces, parseContentRange } from "../../web-v3/pdf-viewer/find";
import { pdfViewerUrl } from "../../web-v3/shell/pdf-overlay";

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
});
