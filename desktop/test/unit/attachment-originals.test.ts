// Files picked or dropped from disk are attached where they are (no copy); pasted ones and originals
// in a temporary place are copied as before; nothing removes an original.
import { describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "../helpers";
import { attachmentMissing, isTemporaryPath, keep, PendingFiles, temporaryRoots } from "../../src/core/attachments";
import { editorBridge } from "../../src/preload/editor-bridge";
import { EDITOR_CHANNEL } from "../../src/editor-host-wire";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC", "base64");
const at = new Date(2026, 10, 5, 9, 8, 7);

describe("originals attached by their own path", () => {
  it("an original on disk is kept by its path, not copied", () => {
    const dir = tempDir("orig-keep");
    const file = join(dir, "photo.png");
    writeFileSync(file, PNG);
    const kept = keep(file, join(dir, "kept"), at, { original: true, temporary: [] })!;
    expect(kept).toEqual({ path: file, url: pathToFileURL(file).href, kind: "image", copied: false });
    expect(existsSync(join(dir, "kept"))).toBe(false);
    // Not something the user picked (a component's picture, a plugin's file): copied as before.
    expect(keep(file, join(dir, "kept"), at, { temporary: [] })!.copied).toBe(true);
    // A folder or a missing file is not an attachment.
    expect(keep(dir, join(dir, "kept"), at, { original: true, temporary: [] })).toBeNull();
    expect(keep(join(dir, "gone.png"), join(dir, "kept"), at, { original: true, temporary: [] })).toBeNull();
  });

  it("an original in a temporary place is copied", () => {
    const dir = tempDir("orig-temp");
    const file = join(dir, "Screenshot.png");
    writeFileSync(file, PNG);
    const kept = keep(file, join(dir, "kept"), at, { original: true, temporary: [dir] })!;
    expect(kept.copied).toBe(true);
    expect(kept.path).toBe(join(dir, "kept", "20261105-090807-Screenshot.png"));
    expect(existsSync(file)).toBe(true);
  });

  it("what counts as temporary", () => {
    const home = homedir();
    for (const path of [join(tmpdir(), "a.png"), "/tmp/a.png", "/private/tmp/a.png", "/var/tmp/a", "/private/var/folders/xy/abc/T/TemporaryItems/NSIRD_screencaptureui_1/Shot.png",
      "/var/folders/xy/abc/T/electron-drag/a.txt", join(home, "Library/Caches/com.app/a.png"), join(home, ".Trash/a.png"),
      join(home, "Library/Containers/pl.maketheweb.cleanshotx/Data/tmp/CleanShot.png"), join(home, "Library/Containers/com.x/Data/Library/Caches/a.png"),
      join(home, "Library/Application Support/CleanShot/media/a.png")]) expect(isTemporaryPath(path), path).toBe(true);
    for (const path of [join(home, "Desktop/a.png"), join(home, "Documents/report.pdf"), "/Volumes/My-SSD/work/a.mov", join(home, "Library/Containers/com.x/Data/Documents/a.png"), "/tmpfile/a.png"])
      expect(isTemporaryPath(path), path).toBe(false);
    expect(temporaryRoots("/Users/u", "/T")).toContain("/Users/u/Library/Caches");
  });

  it("a pasted file is copied, and its incoming copy goes; a picked original is never deleted", async () => {
    const dir = tempDir("orig-pending");
    const original = join(dir, "doc.txt");
    writeFileSync(original, "mine");
    const pending = new PendingFiles(join(dir, "incoming"), () => {});
    const [picked] = pending.addPaths("A", [original, "relative.txt"]);
    expect(pending.list("A").map((file) => file.incoming)).toEqual([false]);
    // Removing a waiting original from the box leaves the file alone.
    pending.remove("A", picked!.id);
    expect(existsSync(original)).toBe(true);
    pending.addPaths("A", [original]);
    await pending.addData("A", "Pasted image.png", PNG.toString("base64"));
    const taken = pending.take("A");
    const kept = taken.map((file) => keep(file.path, join(dir, "kept"), at, { original: !file.incoming, temporary: [] })!);
    expect(kept.map((file) => [file.copied, file.path === original])).toEqual([[false, true], [true, false]]);
    pending.done(taken);
    expect(existsSync(original)).toBe(true);
    expect(readdirSync(join(dir, "incoming"))).toEqual([]);
    expect(readdirSync(join(dir, "kept"))).toHaveLength(1);
  });

  it("the 50-file limit drops extra originals from the box without touching them", () => {
    const dir = tempDir("orig-limit");
    const paths = Array.from({ length: 55 }, (_, index) => { const path = join(dir, `f${index}.txt`); writeFileSync(path, "x"); return path; });
    const pending = new PendingFiles(join(dir, "incoming"), () => {});
    pending.addPaths("A", paths);
    expect(pending.list("A")).toHaveLength(50);
    pending.done(pending.take("A"));
    expect(paths.every((path) => existsSync(path))).toBe(true);
  });

  it("an original moved or deleted later shows as missing", () => {
    const dir = tempDir("orig-missing");
    const file = join(dir, "clip.mov");
    writeFileSync(file, "x");
    const kept = keep(file, join(dir, "kept"), at, { original: true, temporary: [] })!;
    expect(attachmentMissing(kept.url)).toBe(false);
    rmSync(file);
    expect(attachmentMissing(kept.url)).toBe(true);
    expect(attachmentMissing("https://example.invalid/a.png")).toBe(false);
    expect(attachmentMissing("file:///")).toBe(true);
  });
});

describe("a dropped file's path comes from the editor preload, not the page", () => {
  const stamp = { surfaceId: "surface", documentGeneration: "document" };
  function bound(pathForFile?: (file: unknown) => string, invoke = vi.fn(async () => true)) {
    const callbacks = new Map<string, Function>();
    const bridge = editorBridge({ on: (channel, fn) => callbacks.set(channel, fn as Function), send: vi.fn(), invoke }, "editor", pathForFile);
    callbacks.get(EDITOR_CHANNEL.bound)!({}, stamp);
    return { bridge, invoke };
  }
  it("sends only the File's own absolute path, with the binding's stamp", async () => {
    const { bridge, invoke } = bound((file) => (file as { path: string }).path);
    await expect(bridge.attachFile({ path: "/Users/u/Desktop/a.png" }, "MAIN")).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(EDITOR_CHANNEL.drop, { stamp, botID: "MAIN", path: "/Users/u/Desktop/a.png" });
    // A pasted picture or a page-made File has no path: the page reads it instead.
    await expect(bridge.attachFile({ path: "" }, "MAIN")).resolves.toBe(false);
    await expect(bridge.attachFile({ path: "relative.png" }, "MAIN")).resolves.toBe(false);
    await expect(bridge.attachFile({ path: "/a" }, 7)).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("is inert without a path reader, before binding, or in the shell", async () => {
    await expect(bound(undefined).bridge.attachFile({}, "MAIN")).resolves.toBe(false);
    const shell = editorBridge({ on: () => {}, send: vi.fn(), invoke: vi.fn(async () => true) }, "shell", () => "/a");
    await expect(shell.attachFile({}, "MAIN")).resolves.toBe(false);
    const { bridge } = bound(() => "/a", vi.fn(async () => { throw new Error("gone"); }));
    await expect(bridge.attachFile({}, "MAIN")).resolves.toBe(false);
  });
});
