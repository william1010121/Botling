// A chat attachment as the chat page sees it (served by the chat origin) and back to the file the chat names.
import { describe, expect, it } from "vitest";
import { attachmentFile, attachmentTarget, attachmentURL } from "../../src/contract/attachment-url";
import { isImageURL } from "../../../Web/src/lightbox";

const file = "file:///synthetic/attachments/20261026-162932-20261026-162932-BF1F37-agent-activity.png";

describe("attachment URLs", () => {
  it("keep the file's name, so a picture opens in the lightbox as in 1.x", () => {
    const url = attachmentURL("B", file);
    expect(url.startsWith("botling-chat://chat/attachment/B/")).toBe(true);
    expect(url.endsWith("/20261026-162932-20261026-162932-BF1F37-agent-activity.png")).toBe(true);
    expect(isImageURL(url)).toBe(true);
    expect(isImageURL(attachmentURL("B", "file:///synthetic/notes.txt"))).toBe(false);
  });

  it("go back to the file of that bot's chat, and nothing else", () => {
    expect(attachmentFile(attachmentURL("B", file), "B")).toBe(file);
    expect(attachmentTarget(new URL(attachmentURL("B", file)).pathname)).toEqual({ botId: "B", ref: file });
    // Another bot's attachment, a waiting file, or a URL that is not one.
    expect(attachmentFile(attachmentURL("B", file), "C")).toBeNull();
    expect(attachmentFile(attachmentURL("B", "pending:1"), "B")).toBeNull();
    expect(attachmentFile("https://example.org/attachment/B/x", "B")).toBeNull();
    expect(attachmentTarget(new URL(attachmentURL("B", "pending:1")).pathname)).toEqual({ botId: "B", ref: "pending:1" });
    // The bare form (no name) still works.
    const bare = attachmentURL("B", file).replace(/\/[^/]+$/, "");
    expect(attachmentFile(bare, "B")).toBe(file);
  });
});
