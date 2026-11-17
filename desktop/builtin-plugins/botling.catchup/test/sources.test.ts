// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { MessageView } from "../../../../Web/src/types";
import type { CatchUpView } from "../src/types";
import { summaryMessages } from "../src/sources";
import { sourceAuthor } from "../src/viewer";
const message = (id: string, text: string): MessageView => ({ id, text, role: "bot", stamp: null, avatar: null, choices: null, chosen: null, answer: null, open: false, attachments: null, replyTo: null, replyPreview: null, openable: false });
const source = [message("A", "The exact sentence. Next sentence."), message("B", "The exact sentence.")];
describe("the folded messages the viewer shows", () => {
  it("are the actual messages of the exact range, in original order, each once", () => {
    expect(summaryMessages({ ids: ["b", "a", "missing", "a"] } as CatchUpView, [...source, source[0]!, message("outside", "outside")]).map((m) => m.id)).toEqual(["A", "B"]);
  });
  it("label source records without author metadata honestly, without inventing an author", () => {
    expect(sourceAuthor({ ...source[0]!, role: "notice" })).toBe("Original conversation");
    expect(sourceAuthor({ ...source[0]!, sourceAuthor: "Garden", sourceEngine: "codex" })).toBe("Garden · Codex");
  });
});
