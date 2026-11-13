import { describe, expect, it } from "vitest";
import { mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { linkDragTarget } from "../../src/main/link-drag";
import { attachmentURL } from "../../src/contract/attachment-url";
import { Command, MAIN_COMMANDS, RENDERER_COMMANDS } from "../../src/contract";
import { tempDir } from "../helpers";

const BOT = "11111111-1111-4111-8111-111111111111";
const isFile = (path: string) => statSync(path).isFile();

describe("link.drag: which file a chat link may drag", () => {
  const dir = tempDir("link-drag");
  const file = join(dir, "notes.md");
  writeFileSync(file, "# notes");
  mkdirSync(join(dir, "folder"));
  symlinkSync(file, join(dir, "alias.md"));

  it("takes a file:// URL or an absolute path of a file that is there", () => {
    expect(linkDragTarget(pathToFileURL(file).href, BOT, isFile)).toEqual({ link: pathToFileURL(file).href, path: file });
    expect(linkDragTarget(file, BOT, isFile)).toEqual({ link: file, path: file });
    expect(linkDragTarget(join(dir, "alias.md"), BOT, isFile)?.path).toBe(join(dir, "alias.md"));
  });

  it("refuses a missing file, a folder, web links, relative paths and other schemes", () => {
    for (const url of [join(dir, "gone.md"), join(dir, "folder"), pathToFileURL(join(dir, "folder")).href, "https://example.com/a.md",
      "mailto:a@b.c", "notes.md", "//host/share/a.md", "file://host/share/a.md", "data:text/plain,hi", `${file}\0x`, "javascript:alert(1)"]) {
      expect(linkDragTarget(url, BOT, isFile), url).toBeNull();
    }
  });

  it("normalizes a path that climbs out with ..", () => {
    expect(linkDragTarget(join(dir, "folder", "..", "notes.md"), BOT, isFile)?.path).toBe(file);
  });

  it("treats a failing check as no file", () => {
    expect(linkDragTarget(file, BOT, () => { throw new Error("EACCES"); })).toBeNull();
  });

  it("maps this chat's attachment, as the chat origin serves it, to its file", () => {
    const ref = pathToFileURL(file).href;
    expect(linkDragTarget(attachmentURL(BOT, ref), BOT, isFile)).toEqual({ link: ref, path: file });
  });

  it("refuses another bot's or a malformed chat-origin attachment URL", () => {
    expect(linkDragTarget(attachmentURL("22222222-2222-4222-8222-222222222222", pathToFileURL(file).href), BOT, isFile)).toBeNull();
    expect(linkDragTarget("botling-chat://chat/attachment/nope", BOT, isFile)).toBeNull();
  });

  it("is a renderer command main answers itself", () => {
    expect(RENDERER_COMMANDS.has("link.drag")).toBe(true);
    expect(MAIN_COMMANDS.has("link.drag")).toBe(true);
    expect(Command.safeParse({ type: "link.drag", botId: BOT, url: file }).success).toBe(true);
    expect(Command.safeParse({ type: "link.drag", botId: BOT, url: "" }).success).toBe(false);
    expect(Command.safeParse({ type: "link.drag", botId: BOT, url: file, path: "/etc/passwd" }).success).toBe(false);
  });
});
