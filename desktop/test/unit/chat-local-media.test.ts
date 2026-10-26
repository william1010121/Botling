// Local pictures and videos in a reply: which paths a line names (the chat origin serves only those),
// and how the chat frame asks for them.
import { describe, expect, it } from "vitest";
import { namesPath } from "../../src/core/attachments";
import { attachmentURL, localMediaSource } from "../../src/contract/attachment-url";

describe("namesPath", () => {
  it("finds a path written as a file:// URL, encoded or not, or bare", () => {
    expect(namesPath("![白板](file:///Users/me/p/.bot/artifacts/main-whiteboard.png)", "/Users/me/p/.bot/artifacts/main-whiteboard.png")).toBe(true);
    expect(namesPath("![x](file:///Users/me/%E5%9C%96%20one.png)", "/Users/me/圖 one.png")).toBe(true);
    expect(namesPath("see ![x](/Users/me/a.png) here", "/Users/me/a.png")).toBe(true);
    expect(namesPath("100% sure: ![x](file:///Users/me/a%20b.png)", "/Users/me/a b.png")).toBe(true);
  });
  it("does not take a path for the start of a longer one, or an unnamed one", () => {
    expect(namesPath("![x](file:///Users/me/a.png.bak)", "/Users/me/a.png")).toBe(false);
    expect(namesPath("![x](file:///Users/me/a.pngx)", "/Users/me/a.png")).toBe(false);
    expect(namesPath("![x](file:///Users/me/a.png)", "/Users/me/b.png")).toBe(false);
    expect(namesPath("", "/Users/me/a.png")).toBe(false);
  });
});

describe("localMediaSource", () => {
  it("maps file:// URLs and absolute paths to the chat origin, for the chat shown", () => {
    expect(localMediaSource("B", "file:///Users/me/a.png")).toBe(attachmentURL("B", "file:///Users/me/a.png"));
    expect(localMediaSource("B", "/Users/me/a.png")).toBe(attachmentURL("B", "file:///Users/me/a.png"));
  });
  it("leaves everything else alone", () => {
    for (const url of ["https://example.org/a.png", "data:image/png;base64,AA", "//host/a.png", "botling-chat://chat/attachment/B/x"]) expect(localMediaSource("B", url)).toBe(url);
    expect(localMediaSource(undefined, "file:///Users/me/a.png")).toBe("file:///Users/me/a.png");
  });
});
