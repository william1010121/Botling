// Tests for PDF quote markup in Notes (core/note-pdf-quote.ts, re-exported by core/note-format.ts).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  noteBranches,
  noteCards,
  noteRoutes,
  noteView,
  pdfQuoteMarkup,
  pdfQuotes,
  type PdfQuote,
} from "../../src/core/note-format";
import {
  pdfQuoteMarkup as directMarkup,
  pdfQuotes as directQuotes,
  type PdfQuote as DirectPdfQuote,
} from "../../src/core/note-pdf-quote";

const OWNER = "srv-mac-1";
const CONTENT_ID = `sha256:${"a".repeat(64)}`;
const OTHER_CONTENT_ID = `sha256:${"b".repeat(64)}`;
const SOURCE = { owner: OWNER, id: CONTENT_ID, entry: { stream: "bot:reader", seq: 42 } };

describe("pdfQuoteMarkup and pdfQuotes", () => {
  it("writes then reads back name, page, text (with an empty line inside), and source", () => {
    const quote: PdfQuote = {
      name: "paper.pdf",
      page: 12,
      text: "first line of the quote\n\nthird line after blank",
      source: SOURCE,
    };
    const markup = pdfQuoteMarkup(quote);
    expect(markup).toBe([
      "> 〔PDF · paper.pdf · p. 12〕",
      "> first line of the quote",
      ">",
      "> third line after blank",
      `<!-- source: content=${OWNER}/${CONTENT_ID} entry=bot:reader#42 page=12 -->`,
    ].join("\n"));

    expect(pdfQuotes(markup)).toEqual([{ ...quote, line: 0 }]);

    const emptyQuote: PdfQuote = { name: "empty.pdf", page: 1, text: "", source: null };
    const emptyMarkup = pdfQuoteMarkup(emptyQuote);
    expect(emptyMarkup).toBe("> 〔PDF · empty.pdf · p. 1〕\n>");
    expect(pdfQuotes(emptyMarkup)).toEqual([{ ...emptyQuote, line: 0 }]);
  });

  it("writes no comment line when source is null and still reads the quote back", () => {
    const quote: PdfQuote = {
      name: "slides.pdf",
      page: 3,
      text: "line one\nline two",
      source: null,
    };
    const markup = pdfQuoteMarkup(quote);
    expect(markup).toBe([
      "> 〔PDF · slides.pdf · p. 3〕",
      "> line one",
      "> line two",
    ].join("\n"));
    expect(markup).not.toContain("<!-- source:");
    expect(pdfQuotes(markup)).toEqual([{ ...quote, line: 0 }]);
  });

  it("sanitizes file name to its last path part with `〕` and line breaks replaced by `_`, capped at 200 chars", () => {
    const longName = `${"x".repeat(220)}.pdf`;
    const fromPath = pdfQuoteMarkup({
      name: "/library/papers/my〕\npaper\r\nfinal.pdf",
      page: 1,
      text: "ok",
      source: null,
    });
    expect(fromPath.split("\n")[0]).toBe("> 〔PDF · my__paper_final.pdf · p. 1〕");
    expect(pdfQuotes(fromPath)[0]!.name).toBe("my__paper_final.pdf");

    const fromWinPath = pdfQuoteMarkup({
      name: "D:\\papers\\report · v2.pdf",
      page: 4,
      text: "ok",
      source: null,
    });
    expect(pdfQuotes(fromWinPath)[0]!.name).toBe("report · v2.pdf");

    const fromLong = pdfQuoteMarkup({
      name: longName,
      page: 2,
      text: "ok",
      source: null,
    });
    expect(pdfQuotes(fromLong)[0]!.name.length).toBe(200);
  });

  it("returns source: null when comment is missing, broken, separated by a blank line, or has a page mismatch", () => {
    const note = [
      "> 〔PDF · a.pdf · p. 12〕",
      "> missing comment",
      "",
      "> 〔PDF · b.pdf · p. 12〕",
      "> broken id",
      `<!-- source: content=${OWNER}/not-a-sha entry=bot:reader#42 page=12 -->`,
      "",
      "> 〔PDF · c.pdf · p. 12〕",
      "> broken stream and seq 0",
      `<!-- source: content=${OWNER}/${CONTENT_ID} entry=badstream#0 page=12 -->`,
      "",
      "> 〔PDF · d.pdf · p. 12〕",
      "> page mismatch",
      `<!-- source: content=${OWNER}/${CONTENT_ID} entry=bot:reader#42 page=11 -->`,
      "",
      "> 〔PDF · e.pdf · p. 12〕",
      "> blank line before comment",
      "",
      `<!-- source: content=${OWNER}/${CONTENT_ID} entry=bot:reader#42 page=12 -->`,
      "",
      "> 〔PDF · f.pdf · p. 0〕",
      "> invalid page zero is not a PDF quote",
    ].join("\n");

    expect(pdfQuotes(note)).toEqual([
      { line: 0, name: "a.pdf", page: 12, text: "missing comment", source: null },
      { line: 3, name: "b.pdf", page: 12, text: "broken id", source: null },
      { line: 7, name: "c.pdf", page: 12, text: "broken stream and seq 0", source: null },
      { line: 11, name: "d.pdf", page: 12, text: "page mismatch", source: null },
      { line: 15, name: "e.pdf", page: 12, text: "blank line before comment", source: null },
    ]);
  });

  it("finds two quotes in one Note inside a branch with the right 0-based lines, ignoring non-PDF quotes and code fences", () => {
    const first = pdfQuoteMarkup({ name: "first.pdf", page: 2, text: "alpha `code`", source: SOURCE });
    const second = pdfQuoteMarkup({
      name: "second.pdf",
      page: 9,
      text: "beta",
      source: { owner: "srv-linux", id: OTHER_CONTENT_ID, entry: { stream: "srv:srv-linux", seq: 7 } },
    });
    const note = [
      "# Reading", // 0
      "", // 1
      "> 〔Note #n1 · Fork › Route〕", // 2 (問 quote, not PDF)
      "> keep this untouched", // 3
      "", // 4
      "```markdown", // 5
      "> 〔PDF · fake.pdf · p. 1〕", // 6 (inside code fence)
      "> ignored", // 7
      "```", // 8
      "", // 9
      "<!-- branch: Study -->", // 10
      "<!-- route: Part A -->", // 11
      first, // 12..14
      "<!-- route: Part B -->", // 15
      second, // 16..18
      "<!-- end branch -->", // 19
    ].join("\n");

    expect(pdfQuotes(note)).toEqual([
      { line: 12, name: "first.pdf", page: 2, text: "alpha `code`", source: SOURCE },
      {
        line: 16,
        name: "second.pdf",
        page: 9,
        text: "beta",
        source: { owner: "srv-linux", id: OTHER_CONTENT_ID, entry: { stream: "srv:srv-linux", seq: 7 } },
      },
    ]);

    const backToBack = [
      "> 〔PDF · one.pdf · p. 1〕",
      "> first",
      "> 〔PDF · two.pdf · p. 2〕",
      "> second",
    ].join("\n");
    expect(pdfQuotes(backToBack)).toEqual([
      { line: 0, name: "one.pdf", page: 1, text: "first", source: null },
      { line: 2, name: "two.pdf", page: 2, text: "second", source: null },
    ]);
  });

  it("leaves noteBranches, noteRoutes, noteView, and noteCards unchanged for a Note with a PDF quote", () => {
    const baseLines = [
      "# Notes",
      "<!-- branch: Exp -->",
      "<!-- route: A -->",
      "baseline",
      '<show name="chart" id="c1">{"v":1}</show>',
      "<!-- route: B -->",
      "variant",
      "<!-- end branch -->",
    ];
    const baseNote = baseLines.join("\n");
    const quote = pdfQuoteMarkup({ name: "paper.pdf", page: 5, text: "important finding", source: SOURCE });
    const withQuote = `${baseNote}\n\n${quote}`;

    expect(noteBranches(withQuote)).toEqual(noteBranches(baseNote));
    expect(noteRoutes(withQuote)).toEqual(noteRoutes(baseNote));
    expect(noteCards(withQuote)).toEqual(noteCards(baseNote));
    expect(noteView(withQuote, { Exp: "A" }).text).toBe(`${noteView(baseNote, { Exp: "A" }).text}\n\n${quote}`);
  });

  it("cuts text of 5,000 characters to 4,000 with `…`", () => {
    const longText = "a".repeat(5_000);
    const markup = pdfQuoteMarkup({ name: "big.pdf", page: 1, text: longText, source: null });
    const [parsed] = pdfQuotes(markup);
    expect(parsed).toBeDefined();
    expect(parsed!.text.length).toBe(4_000);
    expect(parsed!.text.endsWith("…")).toBe(true);
    expect(parsed!.text).toBe(`${"a".repeat(3_999)}…`);
  });

  it("lives in browser-safe core/note-pdf-quote.ts with only protocol id schemas and is re-exported by note-format.ts", () => {
    const q: DirectPdfQuote = { name: "paper.pdf", page: 2, text: "quoted", source: SOURCE };
    expect(directMarkup).toBe(pdfQuoteMarkup);
    expect(directQuotes).toBe(pdfQuotes);
    expect(directQuotes(directMarkup(q))).toEqual([{ ...q, line: 0 }]);

    const src = readFileSync(resolve(import.meta.dirname, "../../src/core/note-pdf-quote.ts"), "utf8");
    const imports = [...src.matchAll(/^\s*import\s+[\s\S]*?\sfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
    expect(imports.every((mod) => mod.startsWith("../protocol/"))).toBe(true);
    expect(src).not.toMatch(/["']node:/);
  });
});
