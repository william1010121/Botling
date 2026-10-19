// Bundles the chat surface into the app's resources (chat.html, chat.js, chat.css), and each
// built-in plugin in plugins/ into Resources/plugins/<name>/ (package.json, dist/web.js and the
// files its manifest names). Output is committed so `swift build` needs no npm.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const resources = join(here, "../Sources/Deck/Resources");
const out = join(resources, "web");
const pluginsOut = join(resources, "plugins");
const katex = join(here, "node_modules/katex/dist");

rmSync(out, { recursive: true, force: true });
rmSync(pluginsOut, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

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

/** Extra files a built-in plugin needs beside its bundle. */
const assets = {
  "deck-latex": (dist) => {
    cpSync(join(katex, "katex.min.css"), join(dist, "katex.min.css"));
    mkdirSync(join(dist, "fonts"), { recursive: true });
    for (const font of readdirSync(join(katex, "fonts")).filter((name) => name.endsWith(".woff2"))) {
      cpSync(join(katex, "fonts", font), join(dist, "fonts", font));
    }
  },
};

for (const name of readdirSync(join(here, "plugins"))) {
  const source = join(here, "plugins", name);
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const target = join(pluginsOut, name);
  mkdirSync(join(target, "dist"), { recursive: true });
  cpSync(join(source, "package.json"), join(target, "package.json"));
  if (manifest.deck?.web) {
    await build({
      entryPoints: [join(source, "src/web.ts")],
      bundle: true,
      format: "esm",
      target: "safari17",
      minify: true,
      legalComments: "eof",
      outfile: join(target, manifest.deck.web),
    });
  }
  assets[name]?.(join(target, "dist"));
  for (const extra of ["components", "README.md"]) {
    if (existsSync(join(source, extra))) cpSync(join(source, extra), join(target, extra), { recursive: true });
  }
}
console.log("built", out, pluginsOut);
