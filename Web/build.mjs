// Bundles the chat surface (chat.html, chat.js, chat.css; viewer.html and viewer.js, the file window
// for .md files, share chat.css), and each built-in plugin (desktop/builtin-plugins/) into dist/plugins/<name>/
// (desktop/build-builtin-plugins.mjs: package.json, its bundles, what its build.json says to copy), and the Node plugin host
// into dist/host/host.mjs. Output goes to Web/dist (git-ignored); the Electron app (desktop/) builds
// what it needs from Web/src itself, so this build is a check that the shared sources still bundle.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildKit, inlineTokens } from "./kit/build.mjs";
import { buildBuiltinPlugins } from "../desktop/build-builtin-plugins.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const resources = join(here, "dist");
const out = join(resources, "web");
const pluginsOut = join(resources, "plugins");

// The component kit first (kit/generated, committed): chat.js puts its text into component pages.
await buildKit({ write: true });
rmSync(out, { recursive: true, force: true });
rmSync(pluginsOut, { recursive: true, force: true });
rmSync(join(resources, "host"), { recursive: true, force: true });
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
await build({
  entryPoints: [join(here, "src/viewer.ts")],
  bundle: true,
  format: "iife",
  target: "safari17",
  minify: true,
  legalComments: "eof",
  outfile: join(out, "viewer.js"),
});
await build({
  entryPoints: [join(here, "host/src/host.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "eof",
  outfile: join(resources, "host/host.mjs"),
});
cpSync(join(here, "src/chat.html"), join(out, "chat.html"));
// chat.css with the design tokens (src/tokens.css) in place of its import.
writeFileSync(join(out, "chat.css"), inlineTokens(readFileSync(join(here, "src/chat.css"), "utf8"), join(here, "src/chat.css")));
// The viewer draws LaTeX with ccb-latex's code (bundled into viewer.js), so it links the
// stylesheets that plugin's manifest names, where the plugin is built below.
const latex = JSON.parse(readFileSync(join(here, "../desktop/builtin-plugins/ccb-latex/package.json"), "utf8"));
const latexStyles = (latex.ccb?.styles ?? []).map((style) => `<link rel="stylesheet" href="../plugins/${latex.name}/${style}">`).join("\n");
writeFileSync(join(out, "viewer.html"), readFileSync(join(here, "src/viewer.html"), "utf8").replace("<!-- ccb-latex styles: build.mjs links the stylesheets ccb-latex's package.json names -->", latexStyles));

await buildBuiltinPlugins({ root: join(here, "../desktop"), outdir: pluginsOut, browser: "safari17" });
console.log("built", out, pluginsOut);
