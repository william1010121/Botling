// The component kit's build (see README.md): `node Web/kit/build.mjs` bundles src/ (Preact,
// hooks and htm from vendor/, the blocks, their CSS and the design tokens) into dist/kit.v1.js,
// and writes dist/kit-v1.ts, the same text as a string that Web/src/components.ts puts into a
// component's page. Both are committed. Also `inlineTokens`, which the app builds use to put
// Web/src/tokens.css in place of a stylesheet's `@import "…/tokens.css";`.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const tokensImport = /^@import "([^"]*tokens\.css)";[ \t]*\r?\n?/m;

/** `css` (read from `from`) with its `@import "…/tokens.css";` line replaced by that file's text. */
export function inlineTokens(css, from) {
  const match = css.match(tokensImport);
  if (!match) return css;
  const tokens = readFileSync(resolve(dirname(from), match[1]), "utf8");
  return css.replace(tokensImport, () => (tokens.endsWith("\n") ? tokens : tokens + "\n"));
}
