// Build/watch only the renderer. Starting or restarting Electron is always a separate action.
import { resolve } from "node:path";
import { buildRenderer, desktopRoot, watchRenderer } from "../build-renderer.mjs";
import { rendererAppData, readRendererConfiguration } from "../renderer-config.mjs";
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--watch" && !arg.startsWith("--outdir=")))
  throw new Error("Usage: node scripts/renderer-dev.mjs [--watch] [--outdir=/absolute/path]");
const output = args.find(arg => arg.startsWith("--outdir="));
if (output === "--outdir=") throw new Error("--outdir needs a directory");
const configured = output ? {} : readRendererConfiguration(rendererAppData());
if (configured.warning) console.warn(configured.warning);
const outdir = resolve(output ? output.slice("--outdir=".length) : configured.directory || `${desktopRoot}/out/renderer`);
if (args.includes("--watch")) {
  const stop = await watchRenderer({ outdir });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stop(); process.exit(0); });
} else {
  await buildRenderer({ outdir, development: true });
  console.log(`[renderer] ready: ${outdir} — Cmd+R reloads the shell; native chat stays alive`);
}
