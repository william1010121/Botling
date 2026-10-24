// Bundles Botling 2.0: main (CJS, Node), preload (CJS, sandboxed), core (CJS, utility process),
// renderer (IIFE, browser). Output goes to out/, which is not committed.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
const watch = process.argv.includes("--watch");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "renderer"), { recursive: true });

const node = { bundle: true, platform: "node", format: "cjs", target: "node22", sourcemap: "linked", legalComments: "eof" };
await Promise.all([
  build({ ...node, entryPoints: [join(here, "src/main/main.ts")], outfile: join(out, "main/main.cjs"), external: ["electron"] }),
  build({ ...node, entryPoints: [join(here, "src/preload/preload.ts")], outfile: join(out, "preload/preload.cjs"), external: ["electron"] }),
  build({ ...node, entryPoints: [join(here, "src/core/main.ts")], outfile: join(out, "core/main.cjs") }),
  build({
    entryPoints: [join(here, "src/renderer/main.tsx")], bundle: true, format: "iife", target: "chrome130",
    outfile: join(out, "renderer/renderer.js"), jsx: "automatic", minify: !watch, sourcemap: "linked", legalComments: "eof",
    define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  }),
]);
cpSync(join(here, "src/renderer/index.html"), join(out, "renderer/index.html"));
cpSync(join(here, "src/renderer/styles.css"), join(out, "renderer/styles.css"));
console.log("built out/");
