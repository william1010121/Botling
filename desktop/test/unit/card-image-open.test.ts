// @vitest-environment jsdom
// A card's picture in the lightbox (`ccb.open`): "Open in Preview" and "Show in Finder" open the file
// the card shows. link.authorize knows only links in a line's words, so the buttons name the card's
// picture token (the one the lightbox loads, `botling-chat://chat/card-image/<token>`) and the core
// opens exactly the file that token stands for: a picture some component's data named, nothing else.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { cardImageOf } from "../../src/contract/attachment-url";
import { Command as CommandSchema } from "../../src/contract";
import { ImageRegistry } from "../../src/core/components/service";
import { sent } from "../../../Web/src/bridge";
import { closeLightbox, openLightbox } from "../../../Web/src/lightbox";
import { tempDir } from "../helpers";

const token = "0123456789abcdef0123456789abcdef01234567";

describe("a card picture's Open in Preview / Show in Finder", () => {
  afterEach(() => { closeLightbox(false); sent.length = 0; });

  it("name the card picture token the lightbox shows, and only that kind of picture", () => {
    openLightbox("file:///x/z1.png", "z1", `botling-chat://chat/card-image/${token}`);
    document.querySelector<HTMLElement>(".lightbox-open")!.click();
    document.querySelector<HTMLElement>(".lightbox-reveal")!.click();
    expect(sent).toEqual([{ type: "openExternal", url: "file:///x/z1.png", shown: `botling-chat://chat/card-image/${token}` }, { type: "revealFile", url: "file:///x/z1.png", shown: `botling-chat://chat/card-image/${token}` }]);
    expect(cardImageOf(`botling-chat://chat/card-image/${token}`)).toBe(token);
    // A line's own copy of a picture, or anything else: no token.
    expect(cardImageOf("botling-chat://chat/attachment/B/abc/x.png?line=1")).toBeNull();
    expect(cardImageOf(`https://example.org/card-image/${token}`)).toBeNull();
    expect(cardImageOf(undefined)).toBeNull();
  });

  it("the token covers exactly the file a component's data named", () => {
    const dir = tempDir("card-image-open");
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    const picture = join(dir, "artifacts", "z1 chart.png"), other = join(dir, "artifacts", "other.png");
    writeFileSync(picture, "png");
    writeFileSync(other, "png");
    const images = new ImageRegistry();
    const url = images.urls(JSON.stringify({ image: picture }))[picture]!;
    const named = url.split("/").pop()!;
    expect(images.covers(named, pathToFileURL(picture).toString())).toBe(true);
    expect(images.covers(named, picture)).toBe(true);
    expect(images.covers(named, pathToFileURL(other).toString())).toBe(false);
    expect(images.covers(token, pathToFileURL(picture).toString())).toBe(false);
    expect(images.covers(named, "https://example.org/z1.png")).toBe(false);
  });

  it("link.open and link.authorize carry the token", () => {
    for (const type of ["link.open", "link.authorize"] as const) {
      expect(CommandSchema.safeParse({ type, botId: "2714AD19-A3AB-41C7-AFFD-DA1E6BB33727", url: "file:///x.png", source: "component", cardImage: token }).success).toBe(true);
      expect(CommandSchema.safeParse({ type, botId: "2714AD19-A3AB-41C7-AFFD-DA1E6BB33727", url: "file:///x.png", source: "component", cardImage: "../x" }).success).toBe(false);
    }
  });
});
