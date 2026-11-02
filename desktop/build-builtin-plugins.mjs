// The first-party plugins shipped with the app (plugin-platform.md §3.4, step M11): each folder of
// builtin-plugins/ is a plugin as the library holds one. It is built into out/builtin-plugins/<name>/,
// which electron-builder copies beside app.asar (Resources/builtin-plugins: read-only, and readable by
// bots, so Maintainer can copy one into the library to change it). A plugin's src/web.ts and src/host.ts
// are bundled to where its package.json names them, what its build.json lists under `copy` goes beside
// them (`from` relative to desktop/), `nativeModules` (node modules with a native part, e.g. node-pty) stay outside the bundle and are
// staged beside it in the plugin's own node_modules, and the rest of the folder (package.json, components/, claude/…)
// is copied as it is; src/, test/ and build.json stay behind.
import { build } from "esbuild";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
    const config = readConfig(source);
    // build.json may also map imports onto other files (`alias`, from desktop/) and load other file types as text (`loaders`).
    const alias = Object.fromEntries(Object.entries(config.alias ?? {}).map(([name, target]) => [name, resolve(root, target)]));
    const shared = { bundle: true, legalComments: "eof", nodePaths, alias, loader: config.loaders ?? {} };
    if (parts.web) await build({ ...shared, entryPoints: [join(source, "src/web.ts")], format: "esm", target: browser, minify: true, outfile: join(folder, parts.web) });
    const native = config.nativeModules ?? [];
    if (parts.host) await build({ ...shared, entryPoints: [join(source, "src/host.ts")], platform: "node", format: "esm", target: "node20", external: native, outfile: join(folder, parts.host) });
    for (const module of native) stageNativeModule(root, module, folder);
    copyDeclared(root, source, folder);
  }
  return outdir;
}

/**
 * A node module with a native part, staged as `<plugin>/node_modules/<name>`: its package.json, licence, lib and compiled files only.
 * Native paths stay intact, and npm's missing executable bit on a prebuilt `spawn-helper` is restored in our own output, never in the
 * shared dependency cache.
 */
export function stageNativeModule(root, name, pluginFolder) {
  const source = join(root, "node_modules", name);
  const target = join(pluginFolder, "node_modules", name);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const entry of ["package.json", "LICENSE", "lib", "prebuilds", "build/Release"]) {
    if (existsSync(join(source, entry))) cpSync(join(source, entry), join(target, entry), { recursive: true });
  }
  const helpers = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) helpers(file);
      else if (entry.name === "spawn-helper") chmodSync(file, 0o755);
    }
  };
  helpers(target);
}

/** A plugin's build.json (none: empty). */
function readConfig(source) {
  const file = join(source, "build.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
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
