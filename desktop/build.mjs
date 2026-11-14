import { packageAgyHelper } from './scripts/package-agy-helper.mjs';
// Bundles Botling 2.0: main (CJS, Node), preload (CJS, sandboxed), core (CJS, utility process),
// renderer (IIFE, browser: the React app page) and the chat frame (IIFE: Web/src's chat page,
// unchanged, plus the desktop's additions). Output goes to out/, which is not committed.
//
// Web/src is bundled from its sources here; its packages (markdown-it, KaTeX, CodeMirror) come
// from desktop/node_modules at the versions Web/package.json pins, so Web/ needs no install.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRenderer, readCharacters } from "./build-renderer.mjs";
import { buildPreloads } from "./build-preloads.mjs";
import { buildBuiltinPlugins } from "./build-builtin-plugins.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// Keep dependency module identities under node_modules even when link-deps.sh points to a
// lockfile-specific cache. Fix the working directory too, so emitted paths do not depend on cwd.
export function buildMain({ root = here, outfile = join(root, "out/main/main.cjs") } = {}) {
  root = resolve(root);
  outfile = resolve(outfile);
  return build({
    absWorkingDir: root, preserveSymlinks: true,
    bundle: true, platform: "node", format: "cjs", target: "node22", sourcemap: "linked", legalComments: "eof",
    entryPoints: [join(root, "src/main/main.ts")], outfile, external: ["electron", "original-fs"],
  });
}

// Botling 3's main (src/main-v3/, M1 step 11): the same 2.x main with `./core-client` resolved to the server client.
// buildMain above is untouched, so 2.x built from main does not change.
const MAIN_2X = /[\\/]src[\\/]main[\\/]main\.ts$/;
export const coreClientToServerClient = (root) => ({
  name: "main-v3-server-client",
  setup(b) {
    b.onResolve({ filter: /^\.\/core-client$/ }, (args) => (MAIN_2X.test(args.importer) ? { path: join(root, "src/main-v3/server-client.ts") } : undefined));
  },
});
// Step 13: the 2.x main's `../browser-pdf` (src/main/*.ts) resolves to the v3 module whose PDF tabs load
// `botling-content:` instead of `file:`. The v3 module itself imports the 2.x one (its importer is not in src/main/).
const MAIN_2X_DIR = /[\\/]src[\\/]main[\\/][^\\/]+\.ts$/;
export const browserPdfToContent = (root) => ({
  name: "main-v3-browser-pdf",
  setup(b) {
    b.onResolve({ filter: /^\.\.\/browser-pdf$/ }, (args) => (MAIN_2X_DIR.test(args.importer) ? { path: join(root, "src/main-v3/browser-pdf-v3.ts") } : undefined));
  },
});
export function buildMainV3({ root = here, outfile = join(root, "out/main-v3/main.cjs"), write = true, metafile = false } = {}) {
  root = resolve(root);
  outfile = resolve(outfile);
  return build({
    absWorkingDir: root, preserveSymlinks: true,
    bundle: true, platform: "node", format: "cjs", target: "node22", sourcemap: "linked", legalComments: "eof",
    entryPoints: [join(root, "src/main-v3/main.ts")], outfile, external: ["electron", "original-fs"],
    plugins: [coreClientToServerClient(root), browserPdfToContent(root)], write, metafile,
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
  buildMainV3(),
  // The shell's preload and the native chat editor's (build-preloads.mjs; also `npm run preload:build`).
  buildPreloads({ root: here, outdir: join(out, "preload") }),
  build({ ...node, entryPoints: [join(here, "src/core/main.ts")], outfile: join(out, "core/main.cjs") }),
  // botlingd, Botling 3's server (src/server/main.ts): the 2.x core inside it, run under Node or Electron as Node.
  build({ ...node, entryPoints: [join(here, "src/server/main.ts")], outfile: join(out, "server/main.cjs") }),
  // `botling run`: one task with no GUI under plain Node, driving the core above (src/cli/run.ts, docs/headless-run.md).
  build({ ...node, entryPoints: [join(here, "src/cli/run.ts")], outfile: join(out, "cli/run.cjs") }),
  // `botling-agent`: runs Claude workers on another machine (src/remote/agent/, docs/remote-workers.md). Plain Node 18+
  // there; Botling uploads this one file over ssh, or the machine downloads it from the release (agent-release.mjs).
  build({ ...node, target: "node18", sourcemap: false, entryPoints: [join(here, "src/remote/agent/main.ts")], outfile: join(out, "agent/botling-agent.cjs") }),
  // The plugin host: Web/host/src/host.ts unchanged
  // (its own process, started by the core; see src/core/plugins/host-client.ts).
  build({ entryPoints: [join(web, "host/src/host.ts")], bundle: true, platform: "node", format: "esm", target: "node20", legalComments: "eof", outfile: join(out, "host/host.mjs") }),
  // The same host in an Electron utility process (main starts it; it talks over a MessagePort).
  build({ entryPoints: [join(here, "src/host/utility.ts")], bundle: true, platform: "node", format: "esm", target: "node20", legalComments: "eof", outfile: join(out, "host/host-utility.mjs") }),
  // `ccb plugin check` for Maintainer (the checks the registry runs), as a small command.
  build({ ...node, entryPoints: [join(here, "src/core/plugins/check-cli.ts")], outfile: join(out, "host/check-plugin.cjs") }),
  // `pair.cjs PAIRING_DIR ORIGIN BOT_ID...`: prints a one-time phone pairing link (src/mobile-bridge/pair-cli.ts).
  build({ ...node, entryPoints: [join(here, "src/mobile-bridge/pair-cli.ts")], outfile: join(out, "mobile-bridge/pair.cjs") }),
  buildRenderer({ root: here }),
  // The first-party plugins (builtin-plugins/: ccb-latex, botling.cards, botling.design), shipped beside app.asar.
  buildBuiltinPlugins({ root: here, outdir: join(out, "builtin-plugins") }),
]);
packageAgyHelper(here);
// The bots' Cute pictures beside the core, for plugins' `workspace.face` (src/core/faces.ts).
writeFileSync(join(out, "core", "characters.json"), JSON.stringify(readCharacters(here)));
// botlingd runs the same core from out/server/: the files the core reads beside itself go there too.
cpSync(join(out, "core", "characters.json"), join(out, "server", "characters.json"));
if (existsSync(join(out, "core", "agy-file-helper.base64"))) cpSync(join(out, "core", "agy-file-helper.base64"), join(out, "server", "agy-file-helper.base64"));
// The report command (reports/cli.ts), its guide and its licence notices are botling.report's (builtin-plugins/botling.report/build.json).
console.log("built out/");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildAll();
