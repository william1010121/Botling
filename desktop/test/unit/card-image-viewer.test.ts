// @vitest-environment jsdom
// A component card's picture opened full size (`ccb.open(fileURL)`, chart-note-card): the lightbox
// shows the picture the card already shows. The chat origin's attachment route serves only files
// the chat's lines name, never a picture named only by a card's data (a command's output), so the
// lightbox loads the card's own picture (the token the core gave its frame) from the chat origin.
import { afterEach, describe, expect, it } from "vitest";
import { attachmentURL, cardImageToken, localMediaSource } from "../../src/contract/attachment-url";
import { cardPicture } from "../../../Web/src/components";
import { closeLightbox } from "../../../Web/src/lightbox";
import { setMediaSource } from "../../../Web/src/markdown";

const token = "0123456789abcdef0123456789abcdef01234567";
const path = "/Users/me/Project/DaFaJi/.bot/sub-bots/2714AD19-A3AB-41C7-AFFD-DA1E6BB33727/artifacts/z1 chart_1794065532.png";
// What the card's script hands ccb.open: each part escaped.
const fileURL = "file://" + path.split("/").map(encodeURIComponent).join("/");
const images = { [path]: `botling-card://image/${token}` };

describe("a card's picture in the lightbox", () => {
  afterEach(() => { closeLightbox(false); document.body.textContent = ""; setMediaSource((url) => url); });

  it("is the card's own picture, found by the file URL or path the card opens", () => {
    expect(cardPicture(images, fileURL)).toBe(`botling-card://image/${token}`);
    expect(cardPicture(images, path)).toBe(`botling-card://image/${token}`);
    expect(cardPicture({ [fileURL]: `botling-card://image/${token}` }, path)).toBe(`botling-card://image/${token}`);
    // A file the card's data does not name, or a web link: none.
    expect(cardPicture(images, "file:///Users/me/other.png")).toBeNull();
    expect(cardPicture(images, "https://example.org/x.png")).toBeNull();
    expect(cardPicture(undefined, fileURL)).toBeNull();
  });

  it("loads from the chat origin, by the token only", () => {
    const shown = localMediaSource("B", `botling-card://image/${token}`);
    expect(shown).toBe(`botling-chat://chat/card-image/${token}`);
    expect(cardImageToken(new URL(shown).pathname)).toBe(token);
    expect(cardImageToken("/card-image/not-a-token")).toBeNull();
    expect(cardImageToken(`/card-image/${token}/x`)).toBeNull();
    // Not shown in a chat (1.x's file:// page): unchanged.
    expect(localMediaSource(undefined, `botling-card://image/${token}`)).toBe(`botling-card://image/${token}`);
  });

  it("ccb.open from a card shows that picture, not the chat line attachment the origin refuses", () => {
    setMediaSource((url, line) => localMediaSource("B", url, line));
    const frame = document.createElement("iframe") as HTMLIFrameElement & { ccbImages?: Record<string, string> };
    frame.className = "component-frame";
    frame.ccbImages = images;
    document.body.append(frame);
    window.dispatchEvent(new MessageEvent("message", { data: { ccb: "open", url: fileURL, label: "z1" }, source: frame.contentWindow }));
    const image = document.querySelector<HTMLImageElement>(".lightbox-image");
    expect(image).not.toBeNull();
    expect(image!.getAttribute("src")).toBe(`botling-chat://chat/card-image/${token}`);
    expect(image!.getAttribute("src")).not.toBe(attachmentURL("B", fileURL));
    // Its buttons still name the file itself.
    expect(document.querySelector<HTMLElement>(".lightbox-open")!.dataset.url).toBe(fileURL);
  });
});
