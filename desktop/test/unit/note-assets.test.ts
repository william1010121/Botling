// A note's pictures (note-assets.ts): copied beside the note under a hash of their bytes (kept once), links to them
// rewritten to the relative ref, missing pictures and code left alone, refs resolved only inside the note's folder.
import { describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "../helpers";
import { ASSET_BYTES_MAX, assetFile, importAssetBytes, importAssetFile, linkedPictures, localizeImages, noteAssetsDir } from "../../src/core/note-assets";

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex");

function project() {
  const dir = tempDir("note-assets");
  const note = join(dir, "repo", ".bot", "note.md");
  mkdirSync(join(dir, "repo", ".bot"), { recursive: true });
  const elsewhere = join(dir, "other", ".bot", "artifacts", "fig");
  mkdirSync(elsewhere, { recursive: true });
  const fig = join(elsewhere, "reward clean.png");
  writeFileSync(fig, PNG);
  return { dir, note, fig };
}

describe("importAssetFile / importAssetBytes", () => {
  it("copies into <note folder>/note-assets as <hash>.<ext>, the same bytes once", () => {
    const { dir, note, fig } = project();
    const ref = importAssetFile(note, fig);
    expect(ref).toMatch(/^note-assets\/[0-9a-f]{32}\.png$/);
    expect(noteAssetsDir(note)).toBe(join(dir, "repo", ".bot", "note-assets"));
    expect(readFileSync(join(dir, "repo", ".bot", ref))).toEqual(PNG);
    // Same bytes under another name, or as a paste: the same file.
    const copy = join(dir, "copy.PNG");
    writeFileSync(copy, PNG);
    expect(importAssetFile(note, copy)).toBe(ref);
    expect(importAssetBytes(note, PNG, "pasted.png")).toBe(ref);
    expect(readdirSync(noteAssetsDir(note))).toEqual([ref.slice("note-assets/".length)]);
  });

  it("only pictures, within the caps; a missing file is said", () => {
    const { dir, note } = project();
    writeFileSync(join(dir, "secret.txt"), "x");
    expect(() => importAssetFile(note, join(dir, "secret.txt"))).toThrow(/Only png/);
    expect(() => importAssetFile(note, join(dir, "gone.png"))).toThrow(/No such picture/);
    expect(() => importAssetBytes(note, PNG, "a.html")).toThrow(/Only png/);
    expect(() => importAssetBytes(note, Buffer.alloc(ASSET_BYTES_MAX + 1), "big.png")).toThrow(/at most/);
    expect(importAssetBytes(note, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "d.svg")).toMatch(/\.svg$/);
    expect(importAssetBytes(note, PNG, "p.jpeg")).toMatch(/\.jpg$/);
  });
});

describe("assetFile: a ref names only a picture in the note's own folder", () => {
  it("resolves note-assets/<name> and ./note-assets/<name>; refuses escapes, other types and symlinks out", () => {
    const { dir, note, fig } = project();
    const ref = importAssetFile(note, fig);
    const real = join(noteAssetsDir(note), ref.split("/")[1]);
    expect(assetFile(note, ref)?.type).toBe("image/png");
    expect(assetFile(note, `./${ref}`)?.path).toMatch(/note-assets\/[0-9a-f]{32}\.png$/);
    expect(assetFile(note, "note-assets/../../secret.png")).toBeNull();
    expect(assetFile(note, "note-assets/%2e%2e/x.png")).toBeNull();
    expect(assetFile(note, fig)).toBeNull();
    expect(assetFile(note, pathToFileURL(real).href)).toBeNull();
    expect(assetFile(note, "note-assets/missing.png")).toBeNull();
    writeFileSync(join(noteAssetsDir(note), "notes.txt"), "x");
    expect(assetFile(note, "note-assets/notes.txt")).toBeNull();
    symlinkSync(fig, join(noteAssetsDir(note), "link.png"));
    expect(assetFile(note, "note-assets/link.png")).toBeNull();
    // Another bot's note does not see this one's pictures.
    expect(assetFile(join(dir, "other", ".bot", "note.md"), ref)).toBeNull();
  });
});

describe("localizeImages", () => {
  it("copies every picture linked by path, ~/ or file: URL and links the copy; missing, web, relative and code links stay", () => {
    const { dir, note, fig } = project();
    const url = pathToFileURL(fig).href;
    const plain = join(dir, "plain.png");
    writeFileSync(plain, Buffer.from("other picture"));
    const text = [
      "# Results",
      `![reward](${url})`,
      `again ![same](${url} "title") and <img src="${plain}" width="200">`,
      `![angled](<${fig}>)`,
      `![gone](file://${join(dir, "gone.png")})`,
      "![web](https://example.com/a.png) ![rel](note-assets/x.png) [doc](file:///tmp/a.pdf)",
      "```",
      `![in code](${url})`,
      "```",
      `inline \`![x](${url})\``,
      `[fig]: ${plain}`,
    ].join("\n");
    const done = localizeImages(note, text);
    const refFig = done.copied.find((c) => c.from === url)!.ref;
    const refPlain = done.copied.find((c) => c.from === plain)!.ref;
    expect(done.copied).toHaveLength(2);
    expect(done.missing).toEqual([`file://${join(dir, "gone.png")}`]);
    expect(done.failed).toEqual([]);
    expect(done.text.split("\n")).toEqual([
      "# Results",
      `![reward](${refFig})`,
      `again ![same](${refFig} "title") and <img src="${refPlain}" width="200">`,
      `![angled](<${refFig}>)`,
      `![gone](file://${join(dir, "gone.png")})`,
      "![web](https://example.com/a.png) ![rel](note-assets/x.png) [doc](file:///tmp/a.pdf)",
      "```",
      `![in code](${url})`,
      "```",
      `inline \`![x](${url})\``,
      `[fig]: ${refPlain}`,
    ]);
    // Done again: nothing left to copy, the text unchanged.
    expect(localizeImages(note, done.text)).toEqual({ text: done.text, copied: [], missing: [`file://${join(dir, "gone.png")}`], failed: [] });
  });

  it("linkedPictures lists only pictures the note links by absolute path (what importAsset({path}) may read)", () => {
    const { note, fig } = project();
    expect(linkedPictures(`![a](${pathToFileURL(fig).href}) [b](/etc/passwd) ![c](/etc/hosts) \`![d](/x/y.png)\``)).toEqual([fig]);
    expect(linkedPictures("nothing")).toEqual([]);
    void note;
  });
});
