/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inlineTokens } from "../../../../Web/kit/build.mjs";

export const stylesCssPath = resolve(__dirname, "../../../src/renderer/styles.css");
const tokensLine = /^@import "[./]*Web\/src\/tokens\.css";\r?\n/;

/**
 * The text of desktop/src/renderer/styles.css with its section files (`@import "./styles/NN-….css";`) put in their place:
 * the app shell's own rules in one string, the way the stylesheet had them when it was one file. The tokens.css import
 * line stays (the build puts the tokens there; a test that wants them reads Web/src/tokens.css). A test that checks a rule
 * is absent must read this, not the file: the file alone holds only imports, and would pass with nothing checked.
 */
export function readStylesCss(): string {
  const text = readFileSync(stylesCssPath, "utf8");
  const first = text.match(tokensLine)?.[0] ?? "";
  return first + inlineTokens(text.slice(first.length), stylesCssPath);
}
