// Bundles Botling 2.0: main (CJS, Node), preload (CJS, sandboxed), core (CJS, utility process),
// renderer (IIFE, browser: the React app page) and the chat frame (IIFE: Web/src's chat page,
// unchanged, plus the desktop's additions). Output goes to out/, which is not committed.
//
// Web/src is bundled from its sources here; its packages (markdown-it, KaTeX, CodeMirror) come
// from desktop/node_modules at the versions Web/package.json pins, so Web/ needs no install and its
// own build output (Sources/ClaudeCodeBot/Resources) is never touched.
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
const watch = process.argv.includes("--watch");
// Trust is embedded at build time; runtime environment variables cannot replace it.
const releaseConfig = JSON.parse(readFileSync(join(here, "release-config.json"), "utf8"));
const updatePublicKey = releaseConfig.publicKey ?? null;
if (updatePublicKey && createPublicKey(updatePublicKey).asymmetricKeyType !== "ed25519") throw new Error("Release public key must be Ed25519");
if (process.env.BOTLING_RELEASE_BUILD === "1" && !updatePublicKey) throw new Error("Release build requires an explicit Ed25519 public key in release-config.json");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "renderer"), { recursive: true });

const web = join(here, "..", "Web");
const nodePaths = [join(here, "node_modules")];
// The ccb-latex plugin's web part, as module text: the chat page loads plugins from their source.
const latex = await build({
  entryPoints: [join(web, "plugins/ccb-latex/src/web.ts")], bundle: true, format: "esm", target: "chrome130",
  minify: true, legalComments: "eof", write: false, nodePaths,
});
const latexSource = latex.outputFiles[0].text;
// Bot look "Cute": 1.x's character pictures (Sources/ClaudeCodeBotCore/Resources/CharacterArt), read
// only, bundled into the app page as base64 (about 200 KB).
const art = join(here, "..", "Sources", "ClaudeCodeBotCore", "Resources", "CharacterArt", "avatars-static");
const characters = {};
for (const character of ["claude", "gpt"]) {
  characters[character] = {};
  for (const expression of ["idle", "working", "thinking", "sleepy"]) {
    try { characters[character][expression] = readFileSync(join(art, character, `${expression}.png`)).toString("base64"); } catch { /* the original look then */ }
  }
}

const node = { bundle: true, platform: "node", format: "cjs", target: "node22", sourcemap: "linked", legalComments: "eof" };
await Promise.all([
  build({ ...node, entryPoints: [join(here, "src/main/main.ts")], outfile: join(out, "main/main.cjs"), external: ["electron"], define: { __UPDATE_PUBLIC_KEY__: JSON.stringify(updatePublicKey) } }),
  build({ ...node, entryPoints: [join(here, "src/preload/preload.ts")], outfile: join(out, "preload/preload.cjs"), external: ["electron"] }),
  build({ ...node, entryPoints: [join(here, "src/core/main.ts")], outfile: join(out, "core/main.cjs") }),
  // The plugin host: Web/host/src/host.ts unchanged, bundled as Web/build.mjs bundles it for 1.x
  // (its own process, started by the core; see src/core/plugins/host-client.ts).
  build({ entryPoints: [join(web, "host/src/host.ts")], bundle: true, platform: "node", format: "esm", target: "node20", legalComments: "eof", outfile: join(out, "host/host.mjs") }),
  // The same host in an Electron utility process (main starts it; it talks over a MessagePort).
  build({ entryPoints: [join(here, "src/host/utility.ts")], bundle: true, platform: "node", format: "esm", target: "node20", legalComments: "eof", outfile: join(out, "host/host-utility.mjs") }),
  // `ccb plugin check` for Maintainer (the checks the registry runs), as a small command.
  build({ ...node, entryPoints: [join(here, "src/core/plugins/check-cli.ts")], outfile: join(out, "host/check-plugin.cjs") }),
  build({
    entryPoints: [join(here, "src/renderer/main.tsx")], bundle: true, format: "iife", target: "chrome130",
    outfile: join(out, "renderer/renderer.js"), jsx: "automatic", minify: !watch, sourcemap: "linked", legalComments: "eof",
    define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production"), __CHARACTERS__: JSON.stringify(characters) },
  }),
  build({
    entryPoints: [join(here, "src/renderer/chat-frame/entry.ts")], bundle: true, format: "iife", target: "chrome130",
    outfile: join(out, "renderer/chat.js"), minify: !watch, sourcemap: "linked", legalComments: "eof", nodePaths,
    define: { __LATEX_SOURCE__: JSON.stringify(latexSource) },
  }),
]);
cpSync(join(here, "src/renderer/index.html"), join(out, "renderer/index.html"));
cpSync(join(here, "src/renderer/styles.css"), join(out, "renderer/styles.css"));
cpSync(join(here, "src/renderer/chat-frame/chat.html"), join(out, "renderer/chat.html"));
cpSync(join(here, "src/renderer/chat-frame/frame.css"), join(out, "renderer/frame.css"));
cpSync(join(web, "src/chat.css"), join(out, "renderer/chat.css"));
// KaTeX's stylesheet and fonts, as the plugin's build.json copies them for the Swift app.
const katex = join(here, "node_modules/katex/dist");
mkdirSync(join(out, "renderer/plugins/ccb-latex/fonts"), { recursive: true });
cpSync(join(katex, "katex.min.css"), join(out, "renderer/plugins/ccb-latex/katex.min.css"));
for (const name of readdirSync(join(katex, "fonts")).filter((name) => name.endsWith(".woff2"))) {
  cpSync(join(katex, "fonts", name), join(out, "renderer/plugins/ccb-latex/fonts", name));
}
// The web AIs' page readers as 1.x ships them (Sources/ClaudeCodeBot/Resources/web-extractors, read
// only): the core puts them in the plugin library's ccb-web-extractors and falls back to them.
const extractors = join(here, "..", "Sources", "ClaudeCodeBot", "Resources", "web-extractors");
mkdirSync(join(out, "web-extractors"), { recursive: true });
for (const name of readdirSync(extractors).filter((name) => name.endsWith(".js") || name.endsWith(".md"))) {
  cpSync(join(extractors, name), join(out, "web-extractors", name));
}
console.log("built out/");
