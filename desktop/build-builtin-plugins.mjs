// The first-party plugins shipped with the app (plugin-platform.md §3.4, step M11): each folder of
// builtin-plugins/ is a plugin as the library holds one. It is built into out/builtin-plugins/<name>/,
// which electron-builder copies beside app.asar (Resources/builtin-plugins: read-only, and readable by
// bots, so Maintainer can copy one into the library to change it). A plugin's src/web.ts and src/host.ts
// are bundled to where its package.json names them, what its build.json lists under `copy` goes beside
// them (`from` relative to desktop/), and the rest of the folder (package.json, components/, claude/…)
// is copied as it is; src/, test/ and build.json stay behind.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCES_ONLY = new Set(["src", "test", "build.json", "node_modules"]);

export async function buildBuiltinPlugins({ root = here, outdir = join(root, "out/builtin-plugins"), browser = "chrome130" } = {}) {
  root = resolve(root);
  outdir = resolve(outdir);
  const sources = join(root, "builtin-plugins");
  const nodePaths = [join(root, "node_modules")];
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  for (const name of readdirSync(sources).filter((entry) => !entry.startsWith(".")).sort()) {
    const source = join(sources, name);
    if (!existsSync(join(source, "package.json"))) continue;
    const folder = join(outdir, name);
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    cpSync(source, folder, { recursive: true, filter: (path) => !SOURCES_ONLY.has(relative(source, path).split(sep)[0]) });
    const parts = manifest.ccb ?? {};
    if (parts.web) await build({ entryPoints: [join(source, "src/web.ts")], bundle: true, format: "esm", target: browser, minify: true, legalComments: "eof", outfile: join(folder, parts.web), nodePaths });
    if (parts.host) await build({ entryPoints: [join(source, "src/host.ts")], bundle: true, platform: "node", format: "esm", target: "node20", legalComments: "eof", outfile: join(folder, parts.host), nodePaths });
    copyDeclared(root, source, folder);
  }
  return outdir;
}

/** What a plugin's build.json lists under `copy` ([{from, to, only?}]; `only` keeps a folder's files with that ending). */
function copyDeclared(root, source, target) {
  const file = join(source, "build.json");
  if (!existsSync(file)) return;
  for (const { from, to, only } of JSON.parse(readFileSync(file, "utf8")).copy ?? []) {
    const origin = join(root, from), destination = join(target, to);
    if (statSync(origin).isDirectory() && only) {
      mkdirSync(destination, { recursive: true });
      for (const entry of readdirSync(origin).filter((entry) => entry.endsWith(only))) cpSync(join(origin, entry), join(destination, entry));
    } else {
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(origin, destination, { recursive: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log("built", await buildBuiltinPlugins());
