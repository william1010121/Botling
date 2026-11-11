// The Storage tab's list as pure functions (renderer/storage-list.ts): chips, search, sort and how a row writes itself.
import { describe, expect, it } from "vitest";
import type { StorageItemView } from "../../src/contract";
import { droppedLinks, filterCounts, filterItems, formatSize, formatWhen, searchItems, sortItems, totalSize, typeBadge, visibleItems } from "../../src/renderer/storage-list";

const item = (over: Partial<StorageItemView>): StorageItemView => ({
  id: over.name ?? "x", source: "bot", name: "x", folder: null, path: `/p/${over.name ?? "x"}`, size: 1, modified: 1, added: null, kind: "other", missing: false, ...over,
});
const rows = [
  item({ name: "report 10.html", kind: "page", size: 3000, modified: 300 }),
  item({ name: "report 2.html", kind: "page", size: 2000, modified: 100 }),
  item({ name: "圖表.png", kind: "image", size: 500, modified: 200, folder: "charts" }),
  item({ name: "Spec.PDF", kind: "pdf", source: "added", size: 9000, modified: 50, added: 400 }),
  item({ name: "gone.md", kind: "doc", source: "added", size: null, modified: null, added: 150, missing: true }),
];
const names = (list: StorageItemView[]) => list.map((row) => row.name);

describe("sortItems", () => {
  it("date: newest first, a dragged-in file by when it was added", () => {
    expect(names(sortItems(rows, "date"))).toEqual(["Spec.PDF", "report 10.html", "圖表.png", "gone.md", "report 2.html"]);
  });
  it("name: numbers in order, case aside", () => {
    expect(names(sortItems(rows, "name")).filter((name) => /^[a-z]/i.test(name))).toEqual(["gone.md", "report 2.html", "report 10.html", "Spec.PDF"]);
  });
  it("size: largest first, a missing file last", () => {
    expect(names(sortItems(rows, "size"))).toEqual(["Spec.PDF", "report 10.html", "report 2.html", "圖表.png", "gone.md"]);
  });
  it("type: pages, documents, PDFs, pictures, then by name", () => {
    expect(names(sortItems(rows, "type"))).toEqual(["report 2.html", "report 10.html", "gone.md", "Spec.PDF", "圖表.png"]);
  });
  it("does not change the list it was given", () => {
    const before = names(rows);
    sortItems(rows, "name");
    expect(names(rows)).toEqual(before);
  });
});

describe("searchItems and filterItems", () => {
  it("finds every word in the name or subfolder, case and width aside", () => {
    expect(names(searchItems(rows, "REPORT 10"))).toEqual(["report 10.html"]);
    expect(names(searchItems(rows, "ｓｐｅｃ"))).toEqual(["Spec.PDF"]);
    expect(names(searchItems(rows, "charts"))).toEqual(["圖表.png"]);
    expect(names(searchItems(rows, "  "))).toHaveLength(5);
    expect(searchItems(rows, "nothing")).toEqual([]);
  });
  it("keeps the rows a chip asks for; documents include pages", () => {
    expect(names(filterItems(rows, "bot"))).toHaveLength(3);
    expect(names(filterItems(rows, "added"))).toEqual(["Spec.PDF", "gone.md"]);
    expect(names(filterItems(rows, "image"))).toEqual(["圖表.png"]);
    expect(names(filterItems(rows, "pdf"))).toEqual(["Spec.PDF"]);
    expect(names(filterItems(rows, "doc"))).toEqual(["report 10.html", "report 2.html", "gone.md"]);
    expect(filterCounts(rows)).toEqual({ all: 5, bot: 3, added: 2, image: 1, pdf: 1, doc: 3 });
  });
  it("filters, searches, then sorts", () => {
    expect(names(visibleItems(rows, { filter: "doc", query: "report", sort: "name" }))).toEqual(["report 2.html", "report 10.html"]);
  });
});

describe("how a row writes itself", () => {
  it("type badge: the extension in capitals, else the kind's word", () => {
    expect(typeBadge({ name: "a.html", kind: "page" })).toBe("HTML");
    expect(typeBadge({ name: "b.markdown", kind: "doc" })).toBe("MD");
    expect(typeBadge({ name: "c.numbers", kind: "sheet" })).toBe("XLS");
    expect(typeBadge({ name: "README", kind: "other" })).toBe("FILE");
  });
  it("size as Finder writes it", () => {
    expect(formatSize(null)).toBe("—");
    expect(formatSize(820)).toBe("820 bytes");
    expect(formatSize(14_200)).toBe("14 KB");
    expect(formatSize(2_400_000)).toBe("2.4 MB");
    expect(formatSize(31_000_000)).toBe("31 MB");
    expect(totalSize(rows)).toBe(14_500);
  });
  it("date: the time today, month/day this year, the full date before", () => {
    const now = new Date(2026, 10, 11, 15, 0).getTime();
    expect(formatWhen(new Date(2026, 10, 11, 9, 5).getTime(), now)).toBe("09:05");
    expect(formatWhen(new Date(2026, 2, 4).getTime(), now)).toBe("3/4");
    expect(formatWhen(new Date(2025, 2, 4).getTime(), now)).toBe("2025/3/4");
    expect(formatWhen(0, now)).toBe("—");
  });
  it("reads the links a drop from the chat carries", () => {
    expect(droppedLinks("# comment\r\nfile:///a/b.pdf\n\n  https://x.test/c.png \n")).toEqual(["file:///a/b.pdf", "https://x.test/c.png"]);
  });
});
