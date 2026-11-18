/// <reference types="node" />
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inlineTokens } from "../kit/build.mjs";
import { chatCssPath, readChatCss } from "./helpers/chat-css";

// Web/src/chat.css is cut into Web/src/chat/NN-*.css (M7-S80). The page's stylesheet must not change by accident: the
// hashes are of the stylesheet's bytes (raw, and with tokens.css put in as the app builds do), last taken at the card-style-1b
// change (card without a box or title, toolbar in the corner, data lined up with the reply text). They are a snapshot: an
// edit to any chat CSS file changes them on purpose, and the same commit takes the new values from this test's failure
// message. The cut itself (only imports in chat.css, one section per import, none over 800 lines) is the third test.
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const RAW_BEFORE = "0a7f7e4d7ca92b15f833ccbde33a0fa6d4d9408213e82074c23bf3b125b7ed30";
const BUILT_BEFORE = "027ba33f3f880b008d29c26beda524ee93deb0ac8508360f8938094919ade7cd";

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
