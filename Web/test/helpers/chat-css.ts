/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inlineTokens } from "../../kit/build.mjs";

export const chatCssPath = resolve(__dirname, "../../src/chat.css");
const tokensLine = /^@import "\.\/tokens\.css";\r?\n/;

/**
 * The text of Web/src/chat.css with its section files (`@import "./chat/NN-….css";`) put in their place: the chat page's
 * own rules in one string, the way the page had them when chat.css was one file. The `@import "./tokens.css";` line stays
 * (the build puts the tokens there; a test that wants them reads src/tokens.css).
 */
export function readChatCss(): string {
  const text = readFileSync(chatCssPath, "utf8");
  const first = text.match(tokensLine)?.[0] ?? "";
  return first + inlineTokens(text.slice(first.length), chatCssPath);
}
