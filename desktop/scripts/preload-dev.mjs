// Build only the preloads (default out/preload; or --outdir=/absolute/dir for --botling-preload-dir).
import { resolve } from "node:path";
import { buildPreloads, desktopRoot } from "../build-preloads.mjs";
const args = process.argv.slice(2);
if (args.some(arg => !arg.startsWith("--outdir="))) throw new Error("Usage: node scripts/preload-dev.mjs [--outdir=/absolute/path]");
const output = args.find(arg => arg.startsWith("--outdir="));
if (output === "--outdir=") throw new Error("--outdir needs a directory");
const outdir = await buildPreloads({ outdir: resolve(output ? output.slice("--outdir=".length) : `${desktopRoot}/out/preload`) });
console.log(`[preload] ready: ${outdir} — Cmd+R reloads the shell's preload, Alt+Cmd+R (View → Reload Chat Page) the chat page's`);
