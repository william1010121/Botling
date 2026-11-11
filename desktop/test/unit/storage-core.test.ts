// The Storage tab's core (core/storage.ts): a bot's own artifacts listed in place, dragged-in files kept as references
// (missing when the original is gone), and the app file that keeps them.
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REF_LIMIT, StorageBook, artifactItems, refItem, storageItems, storageKind } from "../../src/core/storage";
import { tempDir } from "../helpers";

function put(path: string, text = "x", when?: number) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  if (when) utimesSync(path, when / 1000, when / 1000);
}

describe("storageKind", () => {
  it("names a file's kind by its extension, any case", () => {
    expect(storageKind("a.PNG")).toBe("image");
    expect(storageKind("report.html")).toBe("page");
    expect(storageKind("notes.md")).toBe("doc");
    expect(storageKind("x.pdf")).toBe("pdf");
    expect(storageKind("data.csv")).toBe("sheet");
    expect(storageKind("Makefile")).toBe("other");
  });
});

describe("artifactItems", () => {
  it("lists the bot's files newest first, subfolders a few levels down, without hidden files, symlinks or node_modules", () => {
    const dir = tempDir("storage-art");
    put(join(dir, "old.html"), "<p>", 1_700_000_000_000);
    put(join(dir, "new.pdf"), "%PDF-1", 1_750_000_000_000);
    put(join(dir, "charts", "cpu.png"), "png", 1_720_000_000_000);
    put(join(dir, ".hidden.md"));
    put(join(dir, ".cache", "a.md"));
    put(join(dir, "node_modules", "x.js"));
    put(join(dir, "a", "b", "c", "d", "deep.md"));
    symlinkSync(join(dir, "old.html"), join(dir, "link.html"));
    const items = artifactItems(dir);
    expect(items.map((item) => item.id)).toEqual(["a:new.pdf", "a:charts/cpu.png", "a:old.html"]);
    expect(items[1]).toMatchObject({ source: "bot", name: "cpu.png", folder: "charts", kind: "image", size: 3, added: null, missing: false });
    expect(items[0]!.path).toBe(join(dir, "new.pdf"));
    expect(artifactItems(dir, 1)).toHaveLength(1);
    expect(artifactItems(join(dir, "nothing-here"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("refItem and storageItems", () => {
  it("shows a dragged-in file with its size now, or as missing when the original moved or was deleted", () => {
    const dir = tempDir("storage-ref");
    put(join(dir, "here.txt"), "hello");
    expect(refItem({ id: "1", path: join(dir, "here.txt"), added: 5 })).toMatchObject({ id: "r:1", source: "added", name: "here.txt", size: 5, added: 5, kind: "text", missing: false });
    expect(refItem({ id: "2", path: join(dir, "gone.pdf"), added: 6 })).toMatchObject({ id: "r:2", size: null, modified: null, missing: true, kind: "pdf" });
    // A folder at that path is not the file that was added.
    mkdirSync(join(dir, "folder.pdf"));
    expect(refItem({ id: "3", path: join(dir, "folder.pdf"), added: 7 }).missing).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists the bot's own files first, then the added ones newest first, a file in both once as the bot's", () => {
    const dir = tempDir("storage-items");
    const art = join(dir, "artifacts");
    put(join(art, "report.html"));
    put(join(dir, "a.md"));
    put(join(dir, "b.md"));
    const items = storageItems(art, [
      { id: "A", path: join(dir, "a.md"), added: 1 },
      { id: "B", path: join(dir, "b.md"), added: 2 },
      { id: "R", path: join(art, "report.html"), added: 3 },
    ]);
    expect(items.map((item) => item.id)).toEqual(["a:report.html", "r:B", "r:A"]);
    expect(storageItems(null, [{ id: "A", path: join(dir, "a.md"), added: 1 }]).map((item) => item.id)).toEqual(["r:A"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("StorageBook", () => {
  it("keeps each bot's references apart, only absolute paths, a path added again moved to the top", () => {
    const dir = tempDir("storage-book");
    let now = 100;
    const book = new StorageBook(join(dir, "storage.json"), () => now);
    expect(book.refs("b1")).toEqual([]);
    expect(book.add("b1", ["/x/a.pdf", "relative.pdf", "/x/b.png"])).toBe(2);
    expect(book.refs("B1").map((ref) => ref.path)).toEqual(["/x/b.png", "/x/a.pdf"]);
    expect(book.refs("b2")).toEqual([]);
    const id = book.refs("b1").find((ref) => ref.path === "/x/a.pdf")!.id;
    now = 200;
    expect(book.add("b1", ["/x/a.pdf"])).toBe(0);
    expect(book.refs("b1").map((ref) => [ref.path, ref.added])).toEqual([["/x/a.pdf", 200], ["/x/b.png", 100]]);
    expect(book.refs("b1")[0]!.id).toBe(id);
    expect(JSON.parse(readFileSync(join(dir, "storage.json"), "utf8"))).toMatchObject({ v: 1, bots: { B1: expect.any(Array) } });
    rmSync(dir, { recursive: true, force: true });
  });

  it("forgets a reference by r:id or bare id without touching the file", () => {
    const dir = tempDir("storage-remove");
    put(join(dir, "keep.txt"), "kept");
    const book = new StorageBook(join(dir, "storage.json"));
    book.add("b1", [join(dir, "keep.txt"), "/x/other"]);
    const [first, second] = book.refs("b1");
    expect(book.remove("b1", `r:${first!.id}`)).toBe(true);
    expect(book.remove("b1", second!.id)).toBe(true);
    expect(book.remove("b1", "nope")).toBe(false);
    expect(book.refs("b1")).toEqual([]);
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("kept");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a broken or odd file as none and drops entries that are not references; keeps at most REF_LIMIT", () => {
    const dir = tempDir("storage-bad");
    const file = join(dir, "storage.json");
    writeFileSync(file, "{not json");
    const book = new StorageBook(file);
    expect(book.refs("b1")).toEqual([]);
    writeFileSync(file, JSON.stringify({ v: 1, bots: [] }));
    expect(book.refs("b1")).toEqual([]);
    writeFileSync(file, JSON.stringify({ v: 1, bots: { B1: [{ id: "1", path: "/ok", added: 1 }, { id: 2 }, "x", { id: "3", path: "rel", added: 1 }], B2: "no" } }));
    expect(book.refs("b1").map((ref) => ref.id)).toEqual(["1"]);
    expect(book.refs("b2")).toEqual([]);
    book.add("b1", Array.from({ length: REF_LIMIT + 5 }, (_, i) => `/f/${i}`));
    expect(book.refs("b1")).toHaveLength(REF_LIMIT);
    expect(book.refs("b1")[0]!.path).toBe(`/f/${REF_LIMIT + 4}`);
    rmSync(dir, { recursive: true, force: true });
  });
});
