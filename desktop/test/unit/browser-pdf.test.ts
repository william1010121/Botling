// PDFs in the in-app browser pane (2026-11-13, browser-pdf.ts): which drops and links open a local PDF in a tab, and
// that nothing else local ever loads (a page's or a PDF's own link to a file, a non-PDF, a file named .pdf that is not one).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PDF_DROP_MAX, droppedPdfPaths, fileLabel, fileNavigation, isOpenablePdf, linkPdfPath, localPdfPath, pdfFileUrl } from "../../src/browser-pdf";
import { hostOf, parseBrowserUp } from "../../src/browser-wire";
import { linkOpenWay } from "../../src/main/report-preview";

const dir = mkdtempSync(join(tmpdir(), "botling-pdf-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const pdf = join(dir, "My paper.pdf");
writeFileSync(pdf, "%PDF-1.7\n%âãÏÓ\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

describe("which file: URLs name a local PDF", () => {
  it("takes a file: URL of a .pdf, any case, spaces and non-ASCII names included", () => {
    expect(localPdfPath(pathToFileURL(pdf).href)).toBe(pdf);
    expect(localPdfPath("file:///Users/me/Report.PDF")).toBe("/Users/me/Report.PDF");
    expect(localPdfPath("file://localhost/tmp/a.pdf")).toBe("/tmp/a.pdf");
    expect(localPdfPath(pdfFileUrl("/tmp/論文 v2.pdf"))).toBe("/tmp/論文 v2.pdf");
  });
  it("refuses web URLs, other files, remote hosts and queries", () => {
    for (const url of ["https://example.com/a.pdf", "file:///etc/passwd", "file:///tmp/a.pdf.html", "file://server/share/a.pdf", "file:///tmp/a.pdf?x=1", "javascript:alert(1)", "not a url"]) {
      expect(localPdfPath(url), url).toBeNull();
    }
  });
  it("a chat link: a file: URL or an absolute path to a .pdf", () => {
    expect(linkPdfPath("/Users/me/a.pdf")).toBe("/Users/me/a.pdf");
    expect(linkPdfPath(pathToFileURL(pdf).href)).toBe(pdf);
    expect(linkPdfPath("relative/a.pdf")).toBeNull();
    expect(linkPdfPath("https://example.com/a.pdf")).toBeNull();
    expect(linkPdfPath("/Users/me/a.txt")).toBeNull();
  });
});

describe("the drop rule", () => {
  it("a drop onto the tab strip, toolbar or empty pane: only absolute .pdf paths, each once, at most 8", () => {
    expect(droppedPdfPaths(["/a/x.pdf", "/a/y.PNG", "rel/z.pdf", "", 42, "/a/x.pdf", "/a/n\0.pdf"])).toEqual(["/a/x.pdf"]);
    const many = Array.from({ length: 20 }, (_, i) => `/a/${i}.pdf`);
    expect(droppedPdfPaths(many)).toHaveLength(PDF_DROP_MAX);
    expect(droppedPdfPaths("nope")).toEqual([]);
  });
  it("the wire takes an openFiles message with paths and refuses a malformed one", () => {
    expect(parseBrowserUp({ type: "openFiles", botId: "b1", paths: ["/a/x.pdf"] })).toEqual({ type: "openFiles", botId: "b1", paths: ["/a/x.pdf"] });
    expect(parseBrowserUp({ type: "openFiles", botId: "b1", paths: [] })).toBeNull();
    expect(parseBrowserUp({ type: "openFiles", botId: "b1", paths: [1] })).toBeNull();
    expect(parseBrowserUp({ type: "openFiles", botId: "b1" })).toBeNull();
    expect(parseBrowserUp({ type: "openFiles", botId: "b 1", paths: ["/a/x.pdf"] })).toBeNull();
  });
  it("a drop onto a web page the page did not take (its file: navigation): a PDF opens in a new tab", () => {
    expect(fileNavigation(pathToFileURL(pdf).href, "https://example.com/upload", false)).toBe("open");
    expect(fileNavigation(pathToFileURL(pdf).href, "", false)).toBe("open");
  });
  it("refuses anything else local: a non-PDF, a PDF's own link to a file, during a bot's extraction", () => {
    expect(fileNavigation("file:///etc/passwd", "https://example.com/", false)).toBe("refuse");
    expect(fileNavigation("file:///tmp/a.png", "https://example.com/", false)).toBe("refuse");
    expect(fileNavigation(pathToFileURL(pdf).href, "file:///Users/me/other.pdf", false)).toBe("refuse");
    expect(fileNavigation(pathToFileURL(pdf).href, "https://example.com/", true)).toBe("refuse");
  });
});

describe("what may open", () => {
  it("a regular file named .pdf that starts as a PDF", async () => {
    expect(await isOpenablePdf(pdf)).toBe(true);
    const junk = join(dir, "junk-first.pdf");
    writeFileSync(junk, "\n\n%PDF-1.4\n%%EOF\n");
    expect(await isOpenablePdf(junk)).toBe(true);
  });
  it("not a renamed file, a folder, a missing file, a relative path or another extension", async () => {
    const fake = join(dir, "fake.pdf");
    writeFileSync(fake, "<html>not a pdf</html>");
    const folder = join(dir, "folder.pdf");
    mkdirSync(folder);
    const other = join(dir, "real.txt");
    writeFileSync(other, "%PDF-1.7\n");
    expect(await isOpenablePdf(fake)).toBe(false);
    expect(await isOpenablePdf(folder)).toBe(false);
    expect(await isOpenablePdf(join(dir, "missing.pdf"))).toBe(false);
    expect(await isOpenablePdf("My paper.pdf")).toBe(false);
    expect(await isOpenablePdf(other)).toBe(false);
  });
});

describe("a PDF tab and a chat's .pdf link", () => {
  it("the tab shows the file's name", () => {
    expect(hostOf(pdfFileUrl("/tmp/論文 v2.pdf"))).toBe("論文 v2.pdf");
    expect(fileLabel(pdfFileUrl("/tmp/a b.pdf"))).toBe("a b.pdf");
    expect(hostOf("https://www.example.com/x")).toBe("example.com");
  });
  it("a plain click on a local .pdf opens in the pane; ⌘-click, no pane, or another file still opens outside", () => {
    const base = { source: "user" as const, preview: false, reveal: false };
    expect(linkOpenWay({ ...base, url: pathToFileURL(pdf).href, pane: true })).toBe("pane");
    expect(linkOpenWay({ ...base, url: "/Users/me/a.pdf", pane: true })).toBe("pane");
    expect(linkOpenWay({ ...base, url: "/Users/me/a.pdf", pane: true, external: true })).toBe("open");
    expect(linkOpenWay({ ...base, url: "/Users/me/a.pdf", pane: false })).toBe("open");
    expect(linkOpenWay({ ...base, url: "/Users/me/a.png", pane: true })).toBe("open");
    expect(linkOpenWay({ ...base, url: "/Users/me/a.pdf", pane: true, reveal: true })).toBe("open");
  });
});
