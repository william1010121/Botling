import { stageTerminalRuntime } from './scripts/terminal-runtime.mjs';
import { packageAgyHelper } from './scripts/package-agy-helper.mjs';
// Bundles Botling 2.0: main (CJS, Node), preload (CJS, sandboxed), core (CJS, utility process),
// renderer (IIFE, browser: the React app page) and the chat frame (IIFE: Web/src's chat page,
// unchanged, plus the desktop's additions). Output goes to out/, which is not committed.
//
// Web/src is bundled from its sources here; its packages (markdown-it, KaTeX, CodeMirror) come
// from desktop/node_modules at the versions Web/package.json pins, so Web/ needs no install and its
// own build output (Web/dist) is never touched.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRenderer } from "./build-renderer.mjs";
import { buildPreloads } from "./build-preloads.mjs";
import { NOTICES_FILE, thirdPartyNotices } from "./reports/licenses.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// Keep dependency module identities under node_modules even when link-deps.sh points to a
// lockfile-specific cache. Fix the working directory too, so emitted paths do not depend on cwd.
export function buildMain({ root = here, outfile = join(root, "out/main/main.cjs") } = {}) {
  root = resolve(root);
  outfile = resolve(outfile);
  stageTerminalRuntime(root, dirname(outfile));
  return build({
    absWorkingDir: root, preserveSymlinks: true,
    bundle: true, platform: "node", format: "cjs", target: "node22", sourcemap: "linked", legalComments: "eof",
    entryPoints: [join(root, "src/main/main.ts")], outfile, external: ["electron", "original-fs", "node-pty"],
  });
}

async function buildAll() {
const out = join(here, "out");
if (process.argv.includes("--watch")) throw new Error("Use npm run renderer:watch; the full build is not a process watcher");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "renderer"), { recursive: true });

const web = join(here, "..", "Web");
const node = { bundle: true, platform: "node", format: "cjs", target: "node22", sourcemap: "linked", legalComments: "eof" };
await Promise.all([
  buildMain(),
  // The shell's preload and the native chat editor's (build-preloads.mjs; also `npm run preload:build`).
  buildPreloads({ root: here, outdir: join(out, "preload") }),
  build({ ...node, entryPoints: [join(here, "src/core/main.ts")], outfile: join(out, "core/main.cjs") }),
  // The plugin host: Web/host/src/host.ts unchanged, bundled as Web/build.mjs bundles it for 1.x
  // (its own process, started by the core; see src/core/plugins/host-client.ts).
  build({ entryPoints: [join(web, "host/src/host.ts")], bundle: true, platform: "node", format: "esm", target: "node20", legalComments: "eof", outfile: join(out, "host/host.mjs") }),
  // The same host in an Electron utility process (main starts it; it talks over a MessagePort).
  build({ entryPoints: [join(here, "src/host/utility.ts")], bundle: true, platform: "node", format: "esm", target: "node20", legalComments: "eof", outfile: join(out, "host/host-utility.mjs") }),
  // `ccb plugin check` for Maintainer (the checks the registry runs), as a small command.
  build({ ...node, entryPoints: [join(here, "src/core/plugins/check-cli.ts")], outfile: join(out, "host/check-plugin.cjs") }),
  buildRenderer({ root: here }),
]);
packageAgyHelper(here);
// The report command (reports/cli.ts): run by `Botling --render-report`, or `node out/report/report.cjs`.
// Its bundled packages' licences go next to it (THIRD_PARTY_LICENSES.txt, from the build's metafile).
const report = await build({ ...node, entryPoints: [join(here, "reports/cli-main.ts")], outfile: join(out, "report/report.cjs"), minify: true, metafile: true, jsx: "automatic", loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' }, tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } } });
const notices = thirdPartyNotices(report.metafile, here);
if (notices.missing.length) throw new Error(`No licence text for bundled packages: ${notices.missing.join(", ")}`);
writeFileSync(join(out, "report", NOTICES_FILE), notices.text);
// The bots' guide to report pages and the layout engine's licence notice, next to the command
// (electron-builder copies them outside app.asar, where bots can read them).
cpSync(join(here, "docs", "report-blocks.md"), join(out, "report", "report-blocks.md"));
cpSync(join(here, "reports", "v2", "NOTICE"), join(out, "report", "NOTICE"));
console.log("built out/");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildAll();
