// Botling 3's phone/browser page → web-v3/dist (served by botlingd at /v3/). Like desktop/mobile/build.mjs: the 2.x
// renderer and chat page, unchanged, in web mode (__BOTLING_WEB__), with this folder's shell as the entry. The 2.x
// files are imported and copied, never edited.
//
// The 2.x renderer names the web page's base path for its chat frame from `__BOTLING_WEB_BASE__`
// (src/renderer/chat-frame/protocol.ts, default "/mobile/"); this build defines it as "/v3/" (the step 8 patch, applied
// to 2.x in c346f7c4, replaced the literal rewrite this file used to do).
//
// chat.js starts at web-v3/chat-entry.ts: the 2.x chat page's entry, then this page's media mapping (step 9,
// chat-media.ts: a line's local file → its ticketed /v3/c/ URL, asked of the shell).
//
// sw.js is the page's service worker (step 14, sw.ts): the content bridge of the relay path, scope /v3/.
//
// pdf.html is the PDF viewer (step 15, pdf-viewer/): pdf.js (pdfjs-dist, Apache-2.0) bundled as pdf-viewer.js, its
// worker copied as pdf.worker.mjs, its packed CMaps and standard fonts under pdfjs/ — all files of /v3/, so the viewer
// runs under the page's CSP (`script-src 'self'`) with nothing fetched from elsewhere.
//
//   node web-v3/build.mjs
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCharacters } from "../build-renderer.mjs";
import { FE_MANIFEST_FILE, feBuildManifestFile } from "../fe-build-manifest.mjs";
import { feManifestDefine } from "../fe-manifest-define.mjs";
import { inlineTokens } from "../../Web/kit/build.mjs";
import { PAGE_ASSETS, PAGE_BUILD_FILES } from "./page-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const repo = resolve(root, "..");
const outdir = resolve(process.argv[2] ?? join(here, "dist"));
const nodePaths = [join(root, "node_modules")];

const WEB_BASE = JSON.stringify("/v3/");

async function webPart(name, sources) {
  const result = await build({ entryPoints: [join(root, `builtin-plugins/${name}/src/web.ts`)], bundle: true, format: "esm", target: "chrome130",
    minify: true, legalComments: "eof", write: false, nodePaths, metafile: true, tsconfigRaw: { compilerOptions: {} } });
  for (const input of Object.keys(result.metafile.inputs)) if (!input.startsWith("<")) sources.add(resolve(input));
  return result.outputFiles[0].text;
}

/**
 * The page's FE-build manifest as bytes. `noPlugins` (M7-08, the shell-alone acceptance page): the build ships no in-page plugin, so the manifest lists none
 * and the shell's in-page loader refuses every built-in; the rest (the shell's own version and hash) is what a normal build writes.
 */
function pageManifest(noPlugins) {
  const file = feBuildManifestFile(root, undefined, { requireMinFeVersion: true });
  if (!noPlugins) return file;
  return Buffer.from(`${JSON.stringify({ ...JSON.parse(file.toString("utf8")), plugins: [] }, null, 2)}\n`);
}

export async function buildPage({ out = outdir, development = false, noPlugins = false } = {}) {
  // Every file the build reads (absolute paths), for the page tests' freshness check (test/acceptance/web-v3/page-fresh.ts).
  const sources = new Set([fileURLToPath(import.meta.url)]);
  // The in-page plugin list, written into the shell bundle (the same bytes as fe-build-manifest.json, checked before writing).
  const feManifest = pageManifest(noPlugins);
  const [latex, chatExtras, catchup, boardPart] = await Promise.all(["ccb-latex", "botling.chat-extras", "botling.catchup", "botling.board"].map((name) => webPart(name, sources)));
  const browser = { bundle: true, format: "iife", target: ["chrome130", "safari17"], minify: !development, sourcemap: "linked", legalComments: "eof", write: false, nodePaths, metafile: true,
    logOverride: { "empty-glob": "silent" } }; // the in-page plugin folder (shell/inpage-bundled.ts) has no plugin yet
  const [shell, chat, pdfViewer, worker] = await Promise.all([
    build({ ...browser, entryPoints: [join(here, "shell/main.tsx")], outfile: join(out, "web.js"), jsx: "automatic",
      define: { ...feManifestDefine(feManifest), __BOTLING_WEB_BASE__: WEB_BASE, "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production"), __CHARACTERS__: JSON.stringify(readCharacters(root)), __BOTLING_WEB__: "true" } }),
    build({ ...browser, entryPoints: [join(here, "chat-entry.ts")], outfile: join(out, "chat.js"),
      define: { __BOTLING_WEB_BASE__: WEB_BASE, __LATEX_SOURCE__: JSON.stringify(latex), __CHAT_EXTRAS_SOURCE__: JSON.stringify(chatExtras), __CATCHUP_SOURCE__: JSON.stringify(catchup), __BOARD_SOURCE__: JSON.stringify(boardPart), __BOTLING_WEB__: "true" } }),
    // An ES module (pdf.js is one); its Node-only branches never run in a browser.
    build({ ...browser, format: "esm", entryPoints: [join(here, "pdf-viewer/viewer.ts")], outfile: join(out, "pdf-viewer.js"), logOverride: { "empty-import-meta": "silent" } }),
    // A classic worker script (a module worker is not in every engine the page supports).
    build({ ...browser, entryPoints: [join(here, "sw.ts")], outfile: join(out, "sw.js") }),
  ]);
  const files = new Map([shell, chat, pdfViewer, worker].flatMap((result) => result.outputFiles.map((file) => [file.path, file.contents])));
  const asset = (from, to, tokens = false) => sources.add(resolve(from)) && files.set(join(out, to), tokens ? Buffer.from(inlineTokens(readFileSync(from, "utf8"), from, (file) => sources.add(file))) : readFileSync(from));
  // The page's own files and the 2.x page's look and icons (read, never edited): the list is page-assets.mjs, which shell.hash is made from too.
  for (const { from, to, tokens, append } of PAGE_ASSETS) {
    asset(join(repo, from), to, tokens);
    if (append) { sources.add(join(repo, append)); files.set(join(out, to), Buffer.concat([Buffer.from(files.get(join(out, to))), Buffer.from("\n"), readFileSync(join(repo, append))])); }
  }
  const pdfjs = join(root, "node_modules/pdfjs-dist");
  asset(join(pdfjs, "legacy/build/pdf.worker.min.mjs"), "pdf.worker.mjs");
  asset(join(pdfjs, "LICENSE"), "pdfjs/LICENSE.txt");
  for (const dir of ["cmaps", "standard_fonts"]) for (const name of readdirSync(join(pdfjs, dir))) asset(join(pdfjs, dir, name), `pdfjs/${dir}/${name}${name.startsWith("LICENSE") ? ".txt" : ""}`);
  const katex = join(root, "node_modules/katex/dist");
  asset(join(katex, "katex.min.css"), "plugins/ccb-latex/katex.min.css");
  for (const name of readdirSync(join(katex, "fonts")).filter((n) => n.endsWith(".woff2"))) asset(join(katex, "fonts", name), `plugins/ccb-latex/fonts/${name}`);
  asset(join(root, "builtin-plugins/botling.chat-extras/src/chat-extras.css"), "plugins/botling.chat-extras/chat-extras.css");
  asset(join(root, "builtin-plugins/botling.catchup/catchup.css"), "plugins/botling.catchup/catchup.css");
  asset(join(root, "builtin-plugins/botling.board/src/board.css"), "plugins/botling.board/board.css");
  // The in-page plugins this build ships (M7-10a): name and folder hash, built from src/renderer/plugins/* (the bundled ones are in the metafile's inputs).
  files.set(join(out, FE_MANIFEST_FILE), pageManifest(noPlugins));
  for (const file of PAGE_BUILD_FILES) sources.add(join(repo, file));
  // The build's id, stamped in index.html and version.json (as the 2.x page does).
  const hash = createHash("sha256");
  for (const [file, contents] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (file.endsWith(".map") || file === join(out, "index.html")) continue;
    hash.update(relative(out, file)); hash.update("\0"); hash.update(contents);
  }
  const id = hash.digest("hex").slice(0, 16);
  const index = join(out, "index.html");
  files.set(index, Buffer.from(Buffer.from(files.get(index)).toString("utf8").replaceAll("__BOTLING_BUILD__", id)));
  files.set(join(out, "version.json"), Buffer.from(`${JSON.stringify({ build: id })}\n`));
  // A plugin folder edited while the build ran would leave the bundle and the file with different lists: fail instead.
  if (!Buffer.from(files.get(join(out, FE_MANIFEST_FILE))).equals(feManifest)) throw new Error("A plugin folder changed during the build; build again.");
  rmSync(out, { recursive: true, force: true });
  for (const [file, contents] of files) {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    try { writeFileSync(temporary, contents); renameSync(temporary, file); } finally { rmSync(temporary, { force: true }); }
  }
  // Inputs of the two bundles, for the build checks (no node: import, no 2.x HTTPS bridge module); beside dist, not served.
  // `sources`: every file read, absolute; written last, so this file's mtime is the build's time.
  const inputs = [...new Set([shell, chat, pdfViewer, worker].flatMap((r) => Object.keys(r.metafile.inputs)))].sort();
  for (const input of inputs) if (!input.startsWith("<")) sources.add(resolve(input)); // not esbuild's <define:…> pseudo-inputs
  writeFileSync(`${out}.inputs.json`, `${JSON.stringify({ build: id, inputs, sources: [...sources].sort() })}\n`);
  return { out, id };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { out, id } = await buildPage();
  console.log(`Botling 3 page built: ${relative(process.cwd(), out) || out} (${id})`);
}
