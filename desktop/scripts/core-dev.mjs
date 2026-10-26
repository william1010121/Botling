// Build only the core (and the plugin host and check it starts) for a core hot swap
// (docs/core-hot-swap.md). Never deletes out/ and never starts or restarts Electron.
// Output is written next to the target first and then moved in, so a swap never sees half a build.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.some((arg) => !arg.startsWith("--outdir="))) throw new Error("Usage: node scripts/core-dev.mjs [--outdir=/absolute/out-dir]");
const output = args.find((arg) => arg.startsWith("--outdir="));
if (output === "--outdir=") throw new Error("--outdir needs a directory");
const outdir = resolve(output ? output.slice("--outdir=".length) : join(here, "out"));
const stage = `${outdir}.core-${process.pid}`;
rmSync(stage, { recursive: true, force: true });
const web = join(here, "..", "Web");
const node = { bundle: true, platform: "node", format: "cjs", target: "node22", sourcemap: "linked", legalComments: "eof" };
await Promise.all([
  build({ ...node, entryPoints: [join(here, "src/core/main.ts")], outfile: join(stage, "core/main.cjs") }),
  build({ entryPoints: [join(web, "host/src/host.ts")], bundle: true, platform: "node", format: "esm", target: "node20", legalComments: "eof", outfile: join(stage, "host/host.mjs") }),
  build({ ...node, entryPoints: [join(here, "src/core/plugins/check-cli.ts")], outfile: join(stage, "host/check-plugin.cjs") }),
]);
const extractors = join(here, "..", "Sources", "ClaudeCodeBot", "Resources", "web-extractors");
mkdirSync(join(stage, "web-extractors"), { recursive: true });
for (const name of readdirSync(extractors).filter((name) => name.endsWith(".js") || name.endsWith(".md"))) cpSync(join(extractors, name), join(stage, "web-extractors", name));
// Move each part in (host/ keeps main's host-utility.mjs: only the files built here are replaced).
mkdirSync(outdir, { recursive: true });
for (const part of ["core", "web-extractors"]) {
  rmSync(join(outdir, `${part}.old`), { recursive: true, force: true });
  if (existsSync(join(outdir, part))) renameSync(join(outdir, part), join(outdir, `${part}.old`));
  renameSync(join(stage, part), join(outdir, part));
  rmSync(join(outdir, `${part}.old`), { recursive: true, force: true });
}
mkdirSync(join(outdir, "host"), { recursive: true });
for (const name of readdirSync(join(stage, "host"))) renameSync(join(stage, "host", name), join(outdir, "host", name));
rmSync(stage, { recursive: true, force: true });
console.log(`[core] ready: ${outdir} — Develop ▸ Swap Core (or kill -USR2 <main pid>) swaps it in`);
