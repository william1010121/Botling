// The two preloads (the shell's and the native chat editor's), on their own. A preload runs again
// whenever its page reloads, so a new build here takes effect on the next shell Cmd+R (preload.cjs)
// or Reload Chat Page (editor-host.cjs) without restarting the app. Never touches main, core,
// renderer or the plugin host; publishes each file by atomic rename (a failed build keeps the last).
import { build } from "esbuild";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const desktopRoot = dirname(fileURLToPath(import.meta.url));
export const PRELOADS = { "preload.cjs": "src/preload/preload.ts", "editor-host.cjs": "src/preload/editor-host.ts" };
export async function buildPreloads({ root = desktopRoot, outdir = join(root, "out/preload") } = {}) {
  root = resolve(root);
  outdir = resolve(outdir);
  const results = await Promise.all(Object.entries(PRELOADS).map(([name, entry]) => build({
    // Preserve the logical node_modules path instead of embedding the dependency cache root.
    absWorkingDir: root, preserveSymlinks: true,
    bundle: true, platform: "node", format: "cjs", target: "node22", sourcemap: "linked", legalComments: "eof",
    entryPoints: [join(root, entry)], outfile: join(outdir, name), external: ["electron"], write: false,
  })));
  for (const file of results.flatMap(result => result.outputFiles)) {
    mkdirSync(dirname(file.path), { recursive: true });
    const temporary = `${file.path}.${process.pid}.tmp`;
    try { writeFileSync(temporary, file.contents); renameSync(temporary, file.path); }
    finally { rmSync(temporary, { force: true }); }
  }
  return outdir;
}
