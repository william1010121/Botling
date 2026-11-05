// The first-party plugins shipped with the app (plugin-platform.md §3.4, step M11): each folder of
// builtin-plugins/ is a plugin as the library holds one. It is built into out/builtin-plugins/<name>/,
// which electron-builder copies beside app.asar (Resources/builtin-plugins: read-only, and readable by
// bots, so Maintainer can copy one into the library to change it). A plugin's src/web.ts and src/host.ts
// are bundled to where its package.json names them, what its build.json lists under `copy` goes beside
// them (`from` relative to desktop/), `nativeModules` (node modules with a native part, e.g. node-pty) stay outside the bundle and are
// staged beside it in the plugin's own node_modules, and the rest of the folder (package.json, components/, claude/…)
// is copied as it is; src/, test/ and build.json stay behind.
import { build } from "esbuild";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { thirdPartyNotices } from "./reports/licenses.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCES_ONLY = new Set(["src", "test", "build.json", "node_modules"]);

/**
 * `only` (plugin folder names): build just those, replacing only their folders in `outdir` and keeping the rest, e.g. botling.report
 * into <data dir>/plugin-overrides, which `Botling --render-report` uses from its next call on, and whose guide bots read from
 * their next report on (src/core/plugins/app-command.ts).
 */
export async function buildBuiltinPlugins({ root = here, outdir = join(root, "out/builtin-plugins"), browser = "chrome130", only = null } = {}) {
  root = resolve(root);
  outdir = resolve(outdir);
  const sources = join(root, "builtin-plugins");
  const nodePaths = [join(root, "node_modules")];
  const names = readdirSync(sources).filter((entry) => !entry.startsWith(".") && existsSync(join(sources, entry, "package.json"))).sort();
  const unknown = (only ?? []).filter((name) => !names.includes(name));
  if (unknown.length) throw new Error(`No built-in plugin named ${unknown.join(", ")}`);
  if (!only) rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  for (const name of only ? names.filter((entry) => only.includes(entry)) : names) {
    const source = join(sources, name);
    const folder = join(outdir, name);
    // Built beside the old folder and swapped in, so a command run meanwhile finds the old plugin or the new one, never half of one.
    const staging = only ? join(outdir, `.${name}.building`) : folder;
    rmSync(staging, { recursive: true, force: true });
    await buildPlugin(root, source, staging, nodePaths, browser);
    if (staging !== folder) {
      const old = join(outdir, `.${name}.old`);
      rmSync(old, { recursive: true, force: true });
      if (existsSync(folder)) renameSync(folder, old);
      renameSync(staging, folder);
      rmSync(old, { recursive: true, force: true });
    }
  }
  return outdir;
}

/** One plugin of builtin-plugins/ (`source`) built into `folder`. */
async function buildPlugin(root, source, folder, nodePaths, browser) {
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
  for (const bundle of config.bundles ?? []) await buildBundle(root, folder, bundle);
  copyDeclared(root, source, folder);
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

/**
 * A command of a plugin (build.json `bundles`: `{ entry, outfile, minify?, jsx?, cssAsText?, notices? }`, `entry` from desktop/): one
 * Node file, CJS, with its packages in it. `notices` names the file next to it that lists the licences of the packages bundled
 * (reports/licenses.mjs); a package with no licence text fails the build.
 */
async function buildBundle(root, folder, { entry, outfile, minify = false, jsx = false, cssAsText = false, notices }) {
  const result = await build({
    bundle: true, platform: "node", format: "cjs", target: "node22", legalComments: "eof",
    nodePaths: [join(root, "node_modules")], entryPoints: [join(root, entry)], outfile: join(folder, outfile), minify, metafile: true,
    ...(jsx ? { jsx: "automatic", tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } } } : {}),
    ...(cssAsText ? { loader: { ".css": "text" } } : {}),
    ...(minify ? { define: { "process.env.NODE_ENV": '"production"' } } : {}),
  });
  if (!notices) return;
  const found = thirdPartyNotices(result.metafile, root);
  if (found.missing.length) throw new Error(`No licence text for bundled packages: ${found.missing.join(", ")}`);
  writeFileSync(join(folder, notices), found.text);
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

// `node build-builtin-plugins.mjs [--only <name>[,<name>…] --out <folder>]` (npm run build:plugins -- …).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = (flag) => { const at = process.argv.indexOf(flag); return at > 0 ? process.argv[at + 1] : undefined; };
  const only = option("--only")?.split(",").filter(Boolean) ?? null, out = option("--out");
  console.log("built", await buildBuiltinPlugins({ ...(out ? { outdir: resolve(out) } : {}), only }));
}
