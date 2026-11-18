/// <reference types="node" />
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inlineTokens } from "../kit/build.mjs";
import { chatCssPath, readChatCss } from "./helpers/chat-css";

// Web/src/chat.css is cut into Web/src/chat/NN-*.css (M7-S80). The page's stylesheet must not change by accident: the
// hashes are of the stylesheet's bytes (raw, and with tokens.css put in as the app builds do), last taken for 3.2.0 (the card styles
// since card-style-1b: a failed run keeps its picture with a notice, a card's new page waits behind the old one, and the Note's
// card hand-over). They are a snapshot: an
// edit to any chat CSS file changes them on purpose, and the same commit takes the new values from this test's failure
// message. The cut itself (only imports in chat.css, one section per import, none over 800 lines) is the third test.
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const RAW_BEFORE = "aa42ca064ed3dbe5a58e12452c6a12c5b9989605f225de7fc2e2cc34d077a524";
const BUILT_BEFORE = "b654fd8c6523a980736f5391e90f97bd1a66c7f0d6f3f7fccaedae77c6b79d29";

describe("chat.css cut into sections", () => {
  it("builds to the snapshot bytes (tokens.css put in, as the app builds do)", () => {
    expect(sha256(inlineTokens(readFileSync(chatCssPath, "utf8"), chatCssPath))).toBe(BUILT_BEFORE);
  });

  it("reads back, for the tests, as the snapshot bytes", () => {
    expect(sha256(readChatCss())).toBe(RAW_BEFORE);
  });

  it("keeps only imports in chat.css, one section file per import, none over 800 lines", () => {
    const lines = readFileSync(chatCssPath, "utf8").trimEnd().split("\n");
    expect(lines.every((line) => /^@import "\.\/[\w./-]+\.css";$/.test(line))).toBe(true);
    const sections = readdirSync(join(__dirname, "../src/chat")).filter((name) => name.endsWith(".css")).sort();
    expect(sections.length).toBeGreaterThanOrEqual(3);
    expect(lines.slice(1)).toEqual(sections.map((name) => `@import "./chat/${name}";`));
    for (const name of sections) expect(readFileSync(join(__dirname, "../src/chat", name), "utf8").split("\n").length, name).toBeLessThan(800);
  });
});
