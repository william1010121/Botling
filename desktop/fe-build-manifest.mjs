// The FE build's manifest of the in-page built-in plugins it ships (M7-10a; plan-change D56, C14):
// `fe-build-manifest.json` = { version: 1, shell: { minFeVersion, hash }, plugins: [{ name, codeHash }] }, sorted by name. The shell's in-page loader
// (src/renderer/shell/inpage-loader.ts) runs a plugin's code in the page only when its name and hash are listed here.
//
// The list is built from the folder src/renderer/plugins/*: every sub-folder with an index.ts is one
// in-page plugin, named "botling.<folder>", with the hash of the whole folder (C14, the rule of the plugin catalog's
// `folderHash`, core/plugins/catalog.ts). A card that adds a plugin adds its folder and nothing else; no shared list.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fsTree, shellInputs, shellManifest } from "./fe-shell-manifest.mjs";

export const FE_MANIFEST_FILE = "fe-build-manifest.json";
export const INPAGE_PLUGINS_DIR = "src/renderer/plugins";

const sha = (data) => createHash("sha256").update(data).digest("hex");

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)]));
}

/** The folder hash of the plugin catalog (build-index.mjs): "<path>\0<sha256 of the file>\n" per file, sorted by path, hashed again. */
export function folderHash(dir) {
  const files = listFiles(dir).map((file) => relative(dir, file).split(sep).join("/")).sort();
  return sha(files.map((file) => `${file}\0${sha(readFileSync(join(dir, file)))}\n`).join(""));
}

/** The in-page plugin folders under `root`/src/renderer/plugins: [{ name, folder }], sorted by name. */
export function inpagePluginFolders(root) {
  const base = join(root, INPAGE_PLUGINS_DIR);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(entry.name))
    .filter((entry) => existsSync(join(base, entry.name, "index.ts")))
    .map((entry) => ({ name: `botling.${entry.name}`, folder: join(base, entry.name) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The manifest object for the build rooted at `root` (desktop/). `shell` (M7-10b) names the shell alone: `MIN_FE_VERSION` and the hash of
 * the shell's files (the web-v3 build's inputs, M7-10c), neither of which a plugin-only change moves (fe-shell-manifest.mjs,
 * scripts/check-shell-version.mjs). `requireMinFeVersion`: a real build passes it and fails when the constant is not found (M7-10c);
 * a scratch root of a test has none and gets `null`. */
export function feBuildManifest(root, repoRoot = resolve(root, ".."), { requireMinFeVersion = false } = {}) {
  const shell = shellManifest(fsTree(repoRoot), shellInputs(repoRoot));
  if (requireMinFeVersion && shell.minFeVersion === null) throw new Error("MIN_FE_VERSION is not defined exactly once under desktop/src: the build would write minFeVersion: null into fe-build-manifest.json");
  return { version: 1, shell, plugins: inpagePluginFolders(root).map(({ name, folder }) => ({ name, codeHash: folderHash(folder) })) };
}

/** The manifest as the file's bytes (a build puts these at FE_MANIFEST_FILE next to its page). */
export const feBuildManifestFile = (root, repoRoot, options) => Buffer.from(`${JSON.stringify(feBuildManifest(root, repoRoot, options), null, 2)}\n`);
