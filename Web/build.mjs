// Bundles the chat surface into the app's resources: chat.html, chat.js, chat.css, KaTeX's CSS
// and fonts (woff2 only). Output is committed so `swift build` needs no npm.
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../Sources/Deck/Resources/web");
const katex = join(here, "node_modules/katex/dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "fonts"), { recursive: true });

await build({
  entryPoints: [join(here, "src/main.ts")],
  bundle: true,
  format: "iife",
  target: "safari17",
  minify: true,
  legalComments: "eof",
  outfile: join(out, "chat.js"),
});

cpSync(join(here, "src/chat.html"), join(out, "chat.html"));
cpSync(join(here, "src/chat.css"), join(out, "chat.css"));
cpSync(join(katex, "katex.min.css"), join(out, "katex.min.css"));
for (const font of readdirSync(join(katex, "fonts")).filter((name) => name.endsWith(".woff2"))) {
  cpSync(join(katex, "fonts", font), join(out, "fonts", font));
}
console.log("built", out);
