/// <reference types="node" />
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inlineTokens } from "../kit/build.mjs";
import { chatCssPath, readChatCss } from "./helpers/chat-css";

// Web/src/chat.css is cut into Web/src/chat/NN-*.css (M7-S80). The page's stylesheet must stay the same bytes: the
// hashes are of the one-file chat.css at 7e3875b6 (raw, and with tokens.css put in as the app builds do).
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const RAW_BEFORE = "367ba98e033ebc064c253472cd5076268928d487ec4b9dc39d69c48e9fa02451";
const BUILT_BEFORE = "4d360f2a87507aee0d36d4bf555fceeddcdad563105793ea0f669c4603f2af33";

describe("chat.css cut into sections", () => {
  it("builds to the same bytes as the one-file chat.css (tokens.css put in, as the app builds do)", () => {
    expect(sha256(inlineTokens(readFileSync(chatCssPath, "utf8"), chatCssPath))).toBe(BUILT_BEFORE);
  });

  it("reads back, for the tests, as the one-file chat.css was", () => {
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
