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
import { inlineTokens } from "../../Web/kit/build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const web = resolve(root, "../Web");
const outdir = resolve(process.argv[2] ?? join(here, "dist"));
const nodePaths = [join(root, "node_modules")];

const WEB_BASE = JSON.stringify("/v3/");

async function webPart(name) {
  const result = await build({ entryPoints: [join(root, `builtin-plugins/${name}/src/web.ts`)], bundle: true, format: "esm", target: "chrome130",
    minify: true, legalComments: "eof", write: false, nodePaths, tsconfigRaw: { compilerOptions: {} } });
  return result.outputFiles[0].text;
}

export async function buildPage({ out = outdir, development = false } = {}) {
  const [latex, chatExtras, catchup, boardPart] = await Promise.all(["ccb-latex", "botling.chat-extras", "botling.catchup", "botling.board"].map(webPart));
  const browser = { bundle: true, format: "iife", target: ["chrome130", "safari17"], minify: !development, sourcemap: "linked", legalComments: "eof", write: false, nodePaths, metafile: true };
  const [shell, chat, pdfViewer] = await Promise.all([
    build({ ...browser, entryPoints: [join(here, "shell/main.tsx")], outfile: join(out, "web.js"), jsx: "automatic",
      define: { __BOTLING_WEB_BASE__: WEB_BASE, "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production"), __CHARACTERS__: JSON.stringify(readCharacters(root)), __BOTLING_WEB__: "true" } }),
    build({ ...browser, entryPoints: [join(here, "chat-entry.ts")], outfile: join(out, "chat.js"),
      define: { __BOTLING_WEB_BASE__: WEB_BASE, __LATEX_SOURCE__: JSON.stringify(latex), __CHAT_EXTRAS_SOURCE__: JSON.stringify(chatExtras), __CATCHUP_SOURCE__: JSON.stringify(catchup), __BOARD_SOURCE__: JSON.stringify(boardPart), __BOTLING_WEB__: "true" } }),
    // An ES module (pdf.js is one); its Node-only branches never run in a browser.
    build({ ...browser, format: "esm", entryPoints: [join(here, "pdf-viewer/viewer.ts")], outfile: join(out, "pdf-viewer.js"), logOverride: { "empty-import-meta": "silent" } }),
  ]);
  const files = new Map([shell, chat, pdfViewer].flatMap((result) => result.outputFiles.map((file) => [file.path, file.contents])));
  const asset = (from, to, tokens = false) => files.set(join(out, to), tokens ? Buffer.from(inlineTokens(readFileSync(from, "utf8"), from)) : readFileSync(from));
  for (const name of ["index.html", "manifest.webmanifest"]) asset(join(here, name), name);
  asset(join(here, "shell/shell.css"), "shell.css");
  asset(join(here, "pdf-viewer/pdf.html"), "pdf.html");
  asset(join(here, "pdf-viewer/viewer.css"), "pdf-viewer.css");
  const pdfjs = join(root, "node_modules/pdfjs-dist");
  asset(join(pdfjs, "legacy/build/pdf.worker.min.mjs"), "pdf.worker.mjs");
  asset(join(pdfjs, "LICENSE"), "pdfjs/LICENSE.txt");
  for (const dir of ["cmaps", "standard_fonts"]) for (const name of readdirSync(join(pdfjs, dir))) asset(join(pdfjs, dir, name), `pdfjs/${dir}/${name}${name.startsWith("LICENSE") ? ".txt" : ""}`);
  // The 2.x page's look and icons (read, never edited).
  for (const name of ["web.css", "icon.svg", "icon-180.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "frame-host.html", "frame-host.js"]) asset(join(root, "mobile", name), name);
  asset(join(root, "src/renderer/styles.css"), "styles.css", true);
  files.set(join(out, "styles.css"), Buffer.concat([Buffer.from(files.get(join(out, "styles.css"))), Buffer.from("\n"), readFileSync(join(root, "src/renderer/ModelPicker.css"))]));
  asset(join(root, "src/renderer/chat-frame/chat.html"), "chat.html");
  asset(join(root, "src/renderer/chat-frame/frame.css"), "frame.css");
  asset(join(web, "src/chat.css"), "chat.css", true);
  const katex = join(root, "node_modules/katex/dist");
  asset(join(katex, "katex.min.css"), "plugins/ccb-latex/katex.min.css");
  for (const name of readdirSync(join(katex, "fonts")).filter((n) => n.endsWith(".woff2"))) asset(join(katex, "fonts", name), `plugins/ccb-latex/fonts/${name}`);
  asset(join(root, "builtin-plugins/botling.chat-extras/src/chat-extras.css"), "plugins/botling.chat-extras/chat-extras.css");
  asset(join(root, "builtin-plugins/botling.catchup/catchup.css"), "plugins/botling.catchup/catchup.css");
  asset(join(root, "builtin-plugins/botling.board/src/board.css"), "plugins/botling.board/board.css");
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
  rmSync(out, { recursive: true, force: true });
  for (const [file, contents] of files) {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    try { writeFileSync(temporary, contents); renameSync(temporary, file); } finally { rmSync(temporary, { force: true }); }
  }
  // Inputs of the two bundles, for the build checks (no node: import, no 2.x HTTPS bridge module); beside dist, not served.
  writeFileSync(`${out}.inputs.json`, `${JSON.stringify({ build: id, inputs: [...new Set([shell, chat, pdfViewer].flatMap((r) => Object.keys(r.metafile.inputs)))].sort() })}\n`);
  return { out, id };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { out, id } = await buildPage();
  console.log(`Botling 3 page built: ${relative(process.cwd(), out) || out} (${id})`);
}
